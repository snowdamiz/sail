//! One remote machine at runtime: its power state on Boat, its watchdog, waking it on demand and
//! capturing its final state when it goes to sleep.

mod capture;
mod connect;
mod disk;
mod link;
pub mod projects;
pub mod provision;
pub mod signin;
mod work;

use crate::boat::{Boat, Resume, Sandbox};
use crate::proxy::auth::Auth;
use crate::proxy::cache::{self, Cache};
use crate::proxy::classify;
use crate::proxy::threads;
use crate::proxy::upstream;
use crate::store::{Machine, Settings};
use crate::t3desktop::T3Desktop;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{mpsc, watch};

const WATCHDOG_POLL: Duration = Duration::from_secs(5);
const BOAT_POLL: Duration = Duration::from_secs(60);
const OVERDUE_STOP_RETRY: Duration = Duration::from_secs(120);
/// A running machine on older scripts takes this app's in place, retried this often.
const UPGRADE_RETRY: Duration = Duration::from_secs(10 * 60);
const HEARTBEAT_EVERY: Duration = Duration::from_secs(20);
const READY_TIMEOUT: Duration = Duration::from_secs(180);
const SETTLE_TIMEOUT: Duration = Duration::from_secs(120);
/// A requested sleep: the 45 s grace for the ack, a save called off earlier still running (up
/// to 10 min), the watchdog's own save when nobody acked (up to 10 min), and the stop settling
/// (90 s).
const SLEEP_TIMEOUT: Duration = Duration::from_secs(23 * 60);
/// After a failed wake, requests fail fast instead of each retrying `boat resume`.
const WAKE_COOLDOWN: Duration = Duration::from_secs(30);
/// The watchdog's limit too.
pub const MAX_KEEP_AWAKE_MINUTES: u32 = 24 * 60;
const KEEP_ALIVE_RETRY: Duration = Duration::from_secs(3600);
/// A machine woken for work due is up this much ahead of it: a wake from a snapshot is slow.
const DUE_LEAD: chrono::TimeDelta = chrono::TimeDelta::minutes(2);
const DUE_WAKE_RETRY: Duration = Duration::from_secs(5 * 60);
/// A running machine's link is checked this often: links can be turned on, fail or near expiry
/// while it stays up.
const LINK_CHECK: Duration = Duration::from_secs(10 * 60);
/// A running trial machine's lifetime is pushed back once this close to its end.
const TRIAL_RENEW_LEAD: chrono::TimeDelta = chrono::TimeDelta::minutes(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Power {
    Unknown,
    Starting,
    Running,
    Stopping,
    Stopped,
    /// The sandbox is gone on Boat, or the machine was deleted here. Final.
    Missing,
}

impl Power {
    fn from_sandbox(sb: &Sandbox) -> Self {
        match sb.state.as_str() {
            "ready" | "idle" | "running" => Power::Running,
            "stopped" => Power::Stopped,
            "stopping" => Power::Stopping,
            "provisioned" | "cloning" | "resuming" | "starting" => Power::Starting,
            _ => Power::Unknown,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub sequence: u64,
    pub threads: HashMap<String, u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchdogPhase {
    Active,
    /// The watchdog saves the snapshot itself, awake, after a drain nobody acked; always with a
    /// manifest. Any use calls it off.
    Saving,
    Draining,
    Stopping,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogStatus {
    pub phase: WatchdogPhase,
    pub busy: bool,
    /// Agent runs in flight.
    pub working_threads: u32,
    pub working_subagents: u32,
    /// Agent runs waiting on the user (an approval, a question): not busy, but a T3 restart
    /// would expire what they wait on. Older watchdogs don't say.
    #[serde(default)]
    pub waiting_threads: u32,
    /// Busy only because of CPU use (a build or job outside an agent turn).
    pub cpu_busy: bool,
    /// T3 is not answering, so the watchdog keeps it up (at most 30 min) in case an agent works.
    pub agents_unknown: bool,
    /// Seconds left of a "keep awake"; 0 when off or until stopped.
    pub keep_awake_secs: u64,
    /// Kept awake until someone stops it: no auto sleep at all.
    pub keep_awake_forever: bool,
    pub idle_secs: u64,
    /// Its own stop failed and nothing holds it up. Older watchdogs don't say.
    #[serde(default)]
    pub sleep_broken: bool,
    /// A snapshot save still runs: a watchdog restart would kill it. Older watchdogs don't say.
    #[serde(default)]
    pub saving: bool,
    pub sleep_after_secs: u64,
    /// When T3 next starts work on its own, ms since epoch. Older watchdogs don't say.
    #[serde(default)]
    pub next_due_at: Option<i64>,
    /// That is soon: the machine waits for it instead of sleeping.
    #[serde(default)]
    pub work_due: bool,
    pub manifest: Option<Manifest>,
    /// When this app got the status: what its second counts are relative to.
    #[serde(skip, default = "SystemTime::now")]
    pub received: SystemTime,
}

#[derive(Clone, Debug)]
pub enum Event {
    /// Something visible changed.
    Changed,
    /// A machine record changed and must be saved.
    Persist,
    Notify { title: String, body: String },
}

/// What every machine shares: the user's CLIs, settings and the app's event channel.
pub struct Shared {
    pub boat: Boat,
    pub t3: T3Desktop,
    pub settings: RwLock<Settings>,
    pub events: mpsc::UnboundedSender<Event>,
    pub http: reqwest::Client,
    /// Sandboxes whose snapshot is being saved: a delete leaves each to its save.
    pub saving: Mutex<HashSet<String>>,
}

impl Shared {
    pub fn changed(&self) {
        let _ = self.events.send(Event::Changed);
    }
    /// Saved by the event loop, the state file's one writer.
    pub fn persist(&self) {
        let _ = self.events.send(Event::Persist);
    }
    pub fn notify(&self, title: impl Into<String>, body: impl Into<String>) {
        let _ = self.events.send(Event::Notify { title: title.into(), body: body.into() });
    }
}

pub struct MachineRuntime {
    pub shared: Arc<Shared>,
    record: RwLock<Machine>,
    dir: PathBuf,
    pub cache: Mutex<Cache>,
    pub auth: Auth,
    power: watch::Sender<Power>,
    stopped_at: Mutex<Option<chrono::DateTime<chrono::Utc>>>,
    /// When Boat stops a trial machine on its own (`Sandbox::trial_deadline`).
    lifetime_ends: Mutex<Option<chrono::DateTime<chrono::Utc>>>,
    watchdog: Mutex<Option<WatchdogStatus>>,
    /// One wake at a time; a delete takes it too, so no restore swaps the sandbox under it.
    pub(crate) waking: tokio::sync::Mutex<()>,
    /// One capture at a time: "sleep now" and the background poll can see the same drain.
    capturing: tokio::sync::Mutex<()>,
    last_heartbeat: Mutex<Option<Instant>>,
    /// When the watchdog was seen stopping the machine; cleared once Boat reports it stopped or
    /// the watchdog is active again.
    stop_seen: Mutex<Option<Instant>>,
    /// The last failed wake: its message and when.
    wake_failure: Mutex<Option<(String, Instant)>>,
    /// Saving the snapshot failing, until a save succeeds.
    save_failure: Mutex<Option<disk::SaveFailure>>,
    /// Its T3 projects as last read, and those Sail Boat is adding.
    projects: Mutex<Vec<projects::MachineProject>>,
    adding: Mutex<Vec<projects::MachineProject>>,
}

impl MachineRuntime {
    pub fn new(shared: Arc<Shared>, record: Machine, dir: PathBuf) -> Self {
        let cache = Cache::load(&cache::cache_path(&dir));
        let shell = cache.capture.as_ref().map(|c| c.shell.clone());
        let this = Self {
            shared,
            record: RwLock::new(record),
            dir,
            cache: Mutex::new(cache),
            auth: Auth::default(),
            power: watch::channel(Power::Unknown).0,
            stopped_at: Mutex::new(None),
            lifetime_ends: Mutex::new(None),
            watchdog: Mutex::new(None),
            waking: tokio::sync::Mutex::new(()),
            capturing: tokio::sync::Mutex::new(()),
            last_heartbeat: Mutex::new(None),
            stop_seen: Mutex::new(None),
            wake_failure: Mutex::new(None),
            save_failure: Mutex::new(None),
            projects: Mutex::new(Vec::new()),
            adding: Mutex::new(Vec::new()),
        };
        if let Some(shell) = shell {
            this.set_projects_from(&shell);
        }
        this
    }

    pub fn record(&self) -> Machine {
        self.record.read().unwrap().clone()
    }

    pub fn update_record(&self, f: impl FnOnce(&mut Machine)) {
        f(&mut self.record.write().unwrap());
        self.shared.persist();
        self.shared.changed();
    }

    pub fn id(&self) -> String {
        self.record.read().unwrap().id.clone()
    }

    /// The Boat sandbox the machine runs on now.
    pub fn sandbox_id(&self) -> String {
        self.record.read().unwrap().sandbox_id.clone()
    }

    /// Where this machine's cache, chats and assets are kept on this computer.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn power(&self) -> Power {
        *self.power.borrow()
    }

    pub fn subscribe_power(&self) -> watch::Receiver<Power> {
        self.power.subscribe()
    }

    /// Deleted by this app: nothing may wake it or write to its dir again. Taken under the cache
    /// lock, so no `save_cache` that missed it is still writing.
    pub fn retire(&self) {
        let _cache = self.cache.lock().unwrap();
        self.set_power(Power::Missing);
    }

    /// Missing is final: a Boat answer or a wake still in flight from before must not revive a
    /// deleted machine.
    fn set_power(&self, p: Power) {
        let changed = self.power.send_if_modified(|cur| {
            if *cur == Power::Missing || *cur == p {
                return false;
            }
            *cur = p;
            true
        });
        if changed {
            if p != Power::Running {
                *self.watchdog.lock().unwrap() = None;
            }
            self.shared.changed();
        }
    }

    pub fn watchdog_status(&self) -> Option<WatchdogStatus> {
        self.watchdog.lock().unwrap().clone()
    }

    /// Long enough for any stop to finish; a stop still pending after this failed.
    const STOP_SETTLE: Duration = Duration::from_secs(120);

    pub fn last_error(&self) -> Option<String> {
        self.wake_failure.lock().unwrap().as_ref().map(|(e, _)| e.clone())
    }

    /// The machine is about to freeze or frozen: user actions must wait for it and wake it again.
    pub fn is_stopping(&self) -> bool {
        matches!(self.power(), Power::Stopping | Power::Stopped) || self.stop_pending()
    }

    fn stop_pending(&self) -> bool {
        self.stop_seen.lock().unwrap().is_some_and(|t| t.elapsed() < Self::STOP_SETTLE)
    }

    pub fn save_cache(&self) {
        // Serialized and written under the lock: one writer at a time for the file.
        let result = {
            let cache = self.cache.lock().unwrap();
            if self.power() == Power::Missing {
                return;
            }
            cache.to_bytes().and_then(|b| crate::store::write_private(&cache::cache_path(&self.dir), &b))
        };
        if let Err(e) = result {
            tracing::warn!("saving cache for {}: {e:#}", self.id());
        }
    }

    pub async fn refresh_power(&self) -> Result<Power> {
        let id = self.sandbox_id();
        match self.shared.boat.info(&id).await {
            Ok(sb) => {
                // A restore swapped the sandbox meanwhile: this answer is about the old one.
                if self.sandbox_id() != id {
                    return Ok(self.power());
                }
                *self.stopped_at.lock().unwrap() = sb.stopped_at;
                *self.lifetime_ends.lock().unwrap() = sb.trial_deadline();
                let mut p = Power::from_sandbox(&sb);
                if p == Power::Stopped {
                    *self.stop_seen.lock().unwrap() = None;
                } else if p == Power::Running && self.stop_pending() {
                    // Boat lags behind the watchdog by a few seconds.
                    p = Power::Stopping;
                } else if p == Power::Running && self.waking.try_lock().is_err() {
                    // A wake is waiting for T3 to answer; it publishes Running once it does.
                    return Ok(p);
                }
                self.set_power(p);
                Ok(p)
            }
            Err(e) => {
                let gone = self.shared.boat.confirmed_gone(&id).await;
                if self.sandbox_id() != id {
                    // Restored meanwhile, and the old sandbox deleted.
                    return Ok(self.power());
                }
                if gone {
                    self.set_power(Power::Missing);
                    return Ok(Power::Missing);
                }
                Err(e)
            }
        }
    }

    /// Waits out transitional states, so callers see Running or Stopped (or Missing). A wake
    /// publishes its own outcome; the run loop resolves the rest.
    pub async fn settled_power(&self) -> Power {
        let mut rx = self.subscribe_power();
        let settled = |p: &Power| matches!(p, Power::Running | Power::Stopped | Power::Missing);
        let _ = tokio::time::timeout(SETTLE_TIMEOUT, rx.wait_for(settled)).await;
        self.power()
    }

    pub fn upstream_url(&self) -> String {
        self.record.read().unwrap().upstream_url.trim_end_matches('/').to_owned()
    }

    pub fn upstream_token(&self) -> String {
        self.record.read().unwrap().upstream_token.clone()
    }

    /// The machine's own descriptor, never Boat's fallback page for an unrouted port or an
    /// error body. Cached for while the machine sleeps.
    pub async fn fetch_descriptor(&self) -> Option<Value> {
        let url = format!("{}/.well-known/t3/environment", self.upstream_url());
        let res = self.shared.http.get(url).timeout(Duration::from_secs(3)).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let v: Value = res.json().await.ok()?;
        if v["environmentId"].as_str() != Some(&self.record().environment_id) {
            return None;
        }
        self.cache.lock().unwrap().descriptor = Some(v.clone());
        Some(v)
    }

    /// Boat does not always restore hosted ports on resume.
    async fn rehost(&self) -> Result<()> {
        let (t3, watchdog) = provision::host(&self.shared.boat, &self.sandbox_id()).await?;
        self.update_record(|m| {
            m.upstream_url = t3;
            m.watchdog_url = watchdog;
        });
        Ok(())
    }

    /// Brings the machine up if needed and returns once its T3 server answers and will stay up.
    /// Concurrent callers share one wake.
    pub async fn ensure_awake(&self) -> Result<()> {
        let _guard = self.waking.lock().await;
        // Checked under the lock: a delete holding it retires the machine.
        if self.power() == Power::Missing {
            bail!("the sandbox no longer exists on Boat");
        }
        if let Some((e, at)) = self.wake_failure.lock().unwrap().clone() {
            if at.elapsed() < WAKE_COOLDOWN {
                return Err(anyhow!(e));
            }
        }
        if self.power() == Power::Running && !self.is_stopping() && self.fetch_descriptor().await.is_some() {
            if self.watchdog_status().is_some_and(|w| matches!(w.phase, WatchdogPhase::Saving | WatchdogPhase::Draining)) {
                // Someone needs it after all: call the sleep off before it stops.
                self.send_activity(false).await;
            }
            // Too late if the watchdog is already stopping: wake_locked waits for it and resumes.
            if !self.is_stopping() {
                if self.wake_failure.lock().unwrap().take().is_some() {
                    self.shared.changed();
                }
                // A message accepted while another caller's wake was finishing.
                self.flush_deferred_commands().await;
                return Ok(());
            }
        }
        let result = self.wake_locked().await;
        let was_failing = self.wake_failure.lock().unwrap().is_some();
        match &result {
            Ok(()) => *self.wake_failure.lock().unwrap() = None,
            Err(e) => {
                let msg = format!("{e:#}");
                if !was_failing {
                    self.shared.notify(format!("{} could not wake", self.record().name), msg.clone());
                }
                *self.wake_failure.lock().unwrap() = Some((msg, Instant::now()));
                let _ = self.refresh_power().await;
            }
        }
        self.shared.changed();
        result
    }

    async fn wake_locked(&self) -> Result<()> {
        let id = self.id();
        let started = Instant::now();
        let fresh = self.fresh_capture().is_some();
        self.set_power(Power::Starting);
        let mut resumed = false;
        let mut restored = false;
        loop {
            match self.refresh_power().await? {
                Power::Running => break,
                Power::Stopped => {
                    tracing::info!("resuming {id}");
                    self.set_power(Power::Starting);
                    let record = self.record();
                    if self.shared.boat.resume(&record.sandbox_id, &record.size).await? == Resume::DataExpired {
                        self.restore().await?;
                        restored = true;
                    }
                    resumed = true;
                    break;
                }
                Power::Missing => bail!("the sandbox no longer exists on Boat"),
                _ => {}
            }
            if started.elapsed() > READY_TIMEOUT {
                bail!("the sandbox is stuck between states on Boat");
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        // From here on the machine runs: whatever it slept with is history. A sleep the proxy
        // did not see may have outdated the recorded reads too.
        if !fresh {
            self.cache.lock().unwrap().bump_epoch();
        }
        self.drop_capture();
        self.set_power(Power::Starting);
        if self.fetch_descriptor().await.is_none() {
            self.rehost().await?;
        }
        self.wait_ready(started).await?;
        if resumed {
            // T3 serves now and may have started work on its own, or an agent waits on the user;
            // restarting it would kill that. A restored machine booted fresh from its snapshot:
            // nothing to kill, and the upgrade drops the snapshot's stale chats.
            if !restored && self.watchdog_get("/status?fresh").await.is_ok_and(|s| s.busy || s.waiting_threads > 0) {
                tracing::info!("{id} is busy: T3 upgrade deferred to the next wake");
            } else if let Err(e) = self.upgrade_if_needed().await {
                tracing::warn!("upgrading {id}: {e:#}");
            }
        }
        // Before Running is published: Sail reconnects then, and must find the messages
        // accepted while asleep ahead of anything it sends next.
        self.on_ready().await;
        self.set_power(Power::Running);
        tracing::info!("{id} awake after {:?}", started.elapsed());
        self.send_activity(resumed).await;
        Ok(())
    }

    /// T3 answers after a wake: sends what waited for it and refreshes the session.
    async fn on_ready(&self) {
        self.flush_deferred_commands().await;
        if let Err(e) = self.prime().await {
            tracing::warn!("refreshing {}'s session: {e:#}", self.id());
        }
    }

    /// Fills what the proxy must answer before the machine can sleep: descriptor and session.
    pub async fn prime(&self) -> Result<()> {
        self.fetch_descriptor().await.ok_or_else(|| anyhow!("T3 on the machine did not answer"))?;
        let session = self
            .shared
            .http
            .get(format!("{}/api/auth/session", self.upstream_url()))
            .bearer_auth(self.upstream_token())
            .timeout(Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?
            .json::<Map<String, Value>>()
            .await
            .context("T3 on the machine sent a malformed auth session")?;
        self.cache.lock().unwrap().auth_session = Some(session);
        self.save_cache();
        Ok(())
    }

    async fn wait_ready(&self, started: Instant) -> Result<()> {
        while self.fetch_descriptor().await.is_none() {
            if started.elapsed() > READY_TIMEOUT {
                bail!("T3 on the machine did not answer");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Ok(())
    }

    /// Keeps the machine on the desktop app's T3 version and on this app's scripts.
    pub async fn upgrade_if_needed(&self) -> Result<()> {
        let desktop = self.shared.t3.version().await?;
        self.upgrade(Some(desktop)).await
    }

    /// No T3 version: this app's scripts only, T3 neither installed nor restarted, so nobody using
    /// it loses anything; a new T3 version waits for the next wake.
    async fn upgrade(&self, t3_version: Option<String>) -> Result<()> {
        let revision = provision::revision();
        let record = self.record();
        let new_server = t3_version.as_ref().is_some_and(|v| *v != record.t3_version);
        if !new_server && revision == record.provision_revision {
            return Ok(());
        }
        tracing::info!(
            "upgrading {} (T3 {}, scripts {revision})",
            self.id(),
            t3_version.as_deref().unwrap_or("left as it runs")
        );
        provision::run(
            &self.shared.boat,
            &record.sandbox_id,
            &record.name,
            t3_version.as_deref(),
            &record.watchdog_secret,
            &provision::snapshot_name(&record.name, &record.id),
            false,
        )
        .await?;
        let live = t3_version.is_none();
        self.update_record(|m| {
            if let Some(v) = t3_version {
                m.t3_version = v;
            }
            m.provision_revision = revision;
        });
        // T3 ran on untouched: nothing it served changed.
        if live {
            return Ok(());
        }
        {
            let mut cache = self.cache.lock().unwrap();
            cache.bump_epoch();
            if new_server {
                // Recorded streams and stored chats are in the old server's encoding.
                cache.streams.clear();
            }
        }
        if new_server {
            threads::sweep(&self.dir, &HashSet::new());
            self.save_cache();
        }
        self.wait_ready(Instant::now()).await
    }

    async fn flush_deferred_commands(&self) {
        // Left queued until delivered: the run loop retries a failed send.
        let commands = self.cache.lock().unwrap().deferred_commands.clone();
        if commands.is_empty() {
            return;
        }
        let requests = commands
            .iter()
            .map(|c| ("orchestration.dispatchCommand".to_owned(), c.clone()))
            .collect();
        match upstream::call_many(&self.upstream_url(), &self.upstream_token(), requests).await {
            Ok(results) => {
                self.cache.lock().unwrap().deferred_commands.retain(|c| !commands.contains(c));
                // Sail was told they were accepted: a refused message is said here or nowhere.
                for (command, result) in commands.iter().zip(results) {
                    if let Err(e) = result
                        && command["type"] == "message.dispatch"
                    {
                        tracing::warn!("message to {} refused: {e}", self.id());
                        self.shared.notify(format!("{}: a message was not sent", self.record().name), e);
                    }
                }
            }
            // Resent on the next try; the server dedupes them by commandId.
            Err(e) => {
                tracing::warn!("sending deferred commands: {e:#}");
                return;
            }
        }
        self.save_cache();
    }

    /// Someone used the machine: it stays awake, and recorded answers may be outdated.
    pub fn user_action(self: &Arc<Self>) {
        self.cache.lock().unwrap().bump_epoch();
        if self.power() != Power::Running {
            return;
        }
        {
            let mut last = self.last_heartbeat.lock().unwrap();
            if last.is_some_and(|t| t.elapsed() < HEARTBEAT_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        let this = self.clone();
        tokio::spawn(async move { this.send_activity(false).await });
    }

    /// `resumed`: this app just resumed the sandbox. The watchdog was frozen mid-stop and, after
    /// a short sleep, cannot tell: it would refuse activity and report a stop for another 90 s.
    async fn send_activity(&self, resumed: bool) {
        *self.last_heartbeat.lock().unwrap() = Some(Instant::now());
        // Refused when the watchdog already stops the machine: watchdog_request records that.
        if let Ok(s) = self.watchdog_post("/activity", json!({ "resumed": resumed })).await {
            *self.watchdog.lock().unwrap() = Some(s);
            self.shared.changed();
        }
    }

    async fn watchdog_get(&self, path: &str) -> Result<WatchdogStatus> {
        self.watchdog_request(reqwest::Method::GET, path, None).await
    }

    async fn watchdog_post(&self, path: &str, body: Value) -> Result<WatchdogStatus> {
        self.watchdog_request(reqwest::Method::POST, path, Some(body)).await
    }

    async fn watchdog_request(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<WatchdogStatus> {
        let (url, secret) = {
            let m = self.record.read().unwrap();
            (format!("{}{path}", m.watchdog_url.trim_end_matches('/')), m.watchdog_secret.clone())
        };
        // These routes reply after the watchdog's own T3 check, which allows itself 10 s. Older
        // watchdogs check T3 inside the ack too.
        let refreshes = matches!(path, "/status?fresh" | "/drain" | "/sleep-ack" | "/overdue-stop");
        let timeout = Duration::from_secs(if refreshes { 15 } else { 4 });
        let mut req = self.shared.http.request(method, url).bearer_auth(secret).timeout(timeout);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await?;
        let status = res.status();
        if status.as_u16() == 409 {
            let value: Value = res.json().await.unwrap_or_default();
            // Refused mid-stop: recorded now, as Boat may freeze the machine before a next ask.
            if value["phase"] == "stopping" {
                if let Some(sequence) = value["manifest"]["sequence"].as_u64() {
                    self.confirm_capture(sequence);
                }
                self.mark_stopping();
            }
            bail!("{}", value["error"].as_str().unwrap_or("not now"));
        }
        if !status.is_success() {
            bail!("watchdog {path}: HTTP {status}");
        }
        Ok(res.json().await?)
    }

    /// "Sleep now": asks the watchdog to drain. Refused while an agent works.
    pub async fn sleep_now(&self) -> Result<()> {
        if !self.awake_now().await? {
            return Ok(());
        }
        let s = self.watchdog_post("/drain", json!({})).await?;
        // Any use now calls the sleep off: the next user action must reach the watchdog.
        *self.last_heartbeat.lock().unwrap() = None;
        self.on_watchdog_status(s).await;
        Ok(())
    }

    /// Keeps the machine up for `minutes` whether or not anyone uses it (`None`: until stopped);
    /// `Some(0)` ends it. The watchdog enforces it, so it holds with the laptop closed too. Wakes a
    /// sleeping machine to start.
    pub async fn keep_awake(&self, minutes: Option<u32>) -> Result<()> {
        if minutes.is_some_and(|m| m > MAX_KEEP_AWAKE_MINUTES) {
            bail!("keep awake takes at most {MAX_KEEP_AWAKE_MINUTES} minutes, or until stopped");
        }
        // A stop ends any hold, so a machine that isn't running has none to end.
        if minutes == Some(0) && !self.awake_now().await? {
            return Ok(());
        }
        self.ensure_awake().await?;
        let body = json!({ "minutes": minutes });
        let s = match self.watchdog_post("/keep-awake", body.clone()).await {
            Ok(s) => s,
            // Refused mid-stop (watchdog_request recorded it): ending it is then already done;
            // anything else waits for the stop, wakes the machine and asks again.
            Err(_) if self.is_stopping() => {
                if minutes == Some(0) {
                    return Ok(());
                }
                self.ensure_awake().await?;
                self.watchdog_post("/keep-awake", body).await?
            }
            Err(e) => return Err(e),
        };
        self.on_watchdog_status(s).await;
        Ok(())
    }

    /// New size: applied on the next resume. An idle machine is restarted onto it right away,
    /// keeping any "keep awake"; a working one (an agent or a build), or one where an agent waits
    /// on the user (the restart would expire it), moves when it next sleeps.
    pub async fn resize(&self, size: &str) -> Result<()> {
        provision::size(size)?;
        if self.record().size == size {
            return Ok(());
        }
        self.update_record(|m| m.size = size.to_owned());
        if self.settled_power().await != Power::Running {
            return Ok(());
        }
        let status = match self.watchdog_get("/status").await {
            Ok(s) if !s.busy && s.waiting_threads == 0 => s,
            _ => return Ok(()),
        };
        // The sleep ends any hold: it is taken again after the restart.
        let hold = match (status.keep_awake_forever, status.keep_awake_secs) {
            (true, _) => Some(None),
            (false, 0) => None,
            (false, secs) => Some(Some(secs.div_ceil(60) as u32)),
        };
        if self.sleep_now().await.is_err() {
            return Ok(());
        }
        // The drain dropped the hold even if the sleep was called off.
        let slept = self.slept().await;
        match hold {
            Some(minutes) => self.keep_awake(minutes).await?,
            None if slept => self.ensure_awake().await?,
            None => {}
        }
        Ok(())
    }

    /// For actions on a running machine: true when it runs, false when it sleeps (or is gone).
    async fn awake_now(&self) -> Result<bool> {
        match self.settled_power().await {
            Power::Running => Ok(true),
            Power::Stopped | Power::Missing => Ok(false),
            _ => bail!("still waking; try again in a moment"),
        }
    }

    /// Waits for a sleep just asked for, snapshot save included: true once the machine is
    /// stopped, false if it was used meanwhile and stays up.
    async fn slept(&self) -> bool {
        let deadline = Instant::now() + SLEEP_TIMEOUT;
        while Instant::now() < deadline {
            match self.power() {
                Power::Stopped => return true,
                Power::Missing => return false,
                Power::Running
                    if !self.is_stopping()
                        && self.watchdog_status().is_none_or(|w| w.phase == WatchdogPhase::Active) =>
                {
                    return false
                }
                _ => {}
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        false
    }

    async fn on_watchdog_status(&self, s: WatchdogStatus) {
        if s.busy {
            self.cache.lock().unwrap().bump_epoch();
        }
        if s.phase == WatchdogPhase::Active {
            // Back in use after a drain: an earlier capture no longer describes the machine.
            self.drop_capture();
            *self.stop_seen.lock().unwrap() = None;
        }
        if self.record.read().unwrap().next_due_at != s.next_due_at {
            self.update_record(|r| r.next_due_at = s.next_due_at);
        }
        let manifest = s.manifest.clone();
        let phase = s.phase;
        *self.watchdog.lock().unwrap() = Some(s);
        self.shared.changed();
        match (phase, manifest) {
            // Captured during the watchdog's own save too: the chats then need no billable wake
            // once it stops.
            (WatchdogPhase::Saving | WatchdogPhase::Draining, Some(m)) => {
                {
                    // Whoever waited here finds the capture done, and must not redo it: it may
                    // be confirmed by now.
                    let _capturing = self.capturing.lock().await;
                    if self.captured_sequence() != Some(m.sequence) {
                        self.drop_capture();
                        if let Err(e) = self.capture(&m).await {
                            tracing::warn!("capture failed for {}: {e:#}", self.id());
                            return;
                        }
                    }
                }
                // Acked only while draining: a reply still saving would re-ack in a loop.
                if phase == WatchdogPhase::Draining {
                    match self.watchdog_post("/sleep-ack", json!({ "sequence": m.sequence })).await {
                        // Accepted: no stop inside the ack; a later tick stops it at this sequence,
                        // which a poll can miss before Boat freezes the machine. Any later use
                        // ends in a new drain, recaptured, or a stop too late for fresh_capture.
                        Ok(s) if s.phase == WatchdogPhase::Draining => {
                            if s.manifest.as_ref().is_some_and(|r| r.sequence == m.sequence) {
                                self.confirm_capture(m.sequence);
                            }
                        }
                        // Refused as its own save began ("saving": never confirmed, as that save
                        // delays the stop), or an older watchdog that stopped inside the ack.
                        Ok(s) => Box::pin(self.on_watchdog_status(s)).await,
                        Err(_) => {}
                    }
                }
            }
            // Stopping without a manifest (the watchdog could not read it) still stops: only
            // the capture goes unconfirmed.
            (WatchdogPhase::Stopping, m) => {
                if let Some(m) = m {
                    self.confirm_capture(m.sequence);
                }
                self.mark_stopping();
            }
            _ => {}
        }
    }

    /// The watchdog failed to stop an unused machine: stopped from here, only once it agrees on a
    /// fresh check, so use since its last tick wins. False: not stopped, it no longer agrees.
    async fn stop_overdue(&self) -> Result<bool> {
        // 200 says go. A 409 mid-stop of its own is marked as such by the request.
        let s = match self.watchdog_post("/overdue-stop", json!({})).await {
            Ok(s) => s,
            Err(e) => {
                tracing::debug!("overdue stop of {} refused: {e:#}", self.id());
                // A 200 lost in transit leaves it stopping: hand it back. Harmless after a 409,
                // as the watchdog only undoes a stop it granted to this app.
                let _ = self.watchdog_post("/overdue-stop", json!({ "failed": true })).await;
                return Ok(false);
            }
        };
        let record = self.record();
        tracing::warn!("{}'s own stop failed: stopping it from here", record.id);
        // Confirms the capture and marks the stop, as for the watchdog's own.
        self.on_watchdog_status(s).await;
        // Settles from now, not from the watchdog's own failed stop.
        *self.stop_seen.lock().unwrap() = Some(Instant::now());
        let stopped = self.shared.boat.stop(&record.sandbox_id).await;
        if stopped.is_err() {
            // Maybe still running: requests must not wait on a stop that isn't coming.
            *self.stop_seen.lock().unwrap() = None;
        }
        let power = self.refresh_power().await;
        if let Err(e) = &power {
            tracing::warn!("boat info {}: {e:#}", record.id);
        }
        match stopped {
            // An error or a timeout can still leave the stop taken.
            Err(e) if !matches!(power, Ok(Power::Stopping | Power::Stopped)) => {
                // Handed back: it drains on instead of waiting out the settle, and retries itself.
                let _ = self.watchdog_post("/overdue-stop", json!({ "failed": true })).await;
                Err(e)
            }
            _ => Ok(true),
        }
    }

    /// Known before Boat says so: new sockets and wakes wait for the stop instead of reaching a
    /// machine that is about to freeze.
    fn mark_stopping(&self) {
        {
            // An expired one is an earlier, failed stop: this one settles from now.
            let mut seen = self.stop_seen.lock().unwrap();
            if !seen.is_some_and(|t| t.elapsed() < Self::STOP_SETTLE) {
                *seen = Some(Instant::now());
            }
        }
        self.set_power(Power::Stopping);
    }

    /// Background loop: follows the machine's power state and its watchdog.
    pub async fn run(self: Arc<Self>) {
        let unprimed = {
            let c = self.cache.lock().unwrap();
            c.descriptor.is_none() || c.auth_session.is_none()
        };
        if unprimed {
            // Without these Sail cannot even connect while the machine sleeps.
            let primed = async {
                self.ensure_awake().await?;
                self.prime().await
            };
            if let Err(e) = primed.await {
                tracing::warn!("priming {}: {e:#}", self.id());
            }
        }
        let mut last_boat_poll: Option<Instant> = None;
        let mut last_keep_alive: Option<Instant> = None;
        let mut last_due_wake: Option<Instant> = None;
        let mut last_link_check: Option<Instant> = None;
        let mut last_overdue_stop: Option<Instant> = None;
        // Told the user it won't sleep: once until it is stopped.
        let mut overdue_stop_failed = false;
        // Told the user its own sleep is broken: once per run of this app.
        let mut overdue_stop_told = false;
        let mut last_upgrade: Option<Instant> = None;
        let mut watchdog_failures = 0u32;
        let mut was_busy = false;
        let mut was_running = false;
        loop {
            let transitioning = matches!(self.power(), Power::Stopping | Power::Starting | Power::Unknown);
            if transitioning || last_boat_poll.is_none_or(|t| t.elapsed() >= BOAT_POLL) || watchdog_failures >= 2 {
                last_boat_poll = Some(Instant::now());
                let watchdog_known = watchdog_failures == 0;
                watchdog_failures = 0;
                match self.refresh_power().await {
                    // Boat would stop it at its end, mid-turn or not; the sandbox's own key can't
                    // extend it, so this app does. Not once it is going to sleep; an unreachable
                    // watchdog counts as unknown. Retried each poll until it moves.
                    Ok(Power::Running)
                        if self.lifetime_ends.lock().unwrap().is_some_and(|t| t - chrono::Utc::now() <= TRIAL_RENEW_LEAD)
                            && (!watchdog_known || self.watchdog_status().is_none_or(|w| w.phase == WatchdogPhase::Active)) =>
                    {
                        if let Err(e) = self.shared.boat.extend_trial(&self.sandbox_id()).await {
                            tracing::warn!("boat extend {}: {e:#}", self.id());
                        }
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("boat info {}: {e:#}", self.id()),
                }
            }
            match self.power() {
                Power::Missing => return,
                // Asleep: a later stop failing is news again.
                Power::Stopped => overdue_stop_failed = false,
                _ => {}
            }
            if self.needs_keep_alive() && last_keep_alive.is_none_or(|t| t.elapsed() >= KEEP_ALIVE_RETRY) {
                // Boat keeps a stopped disk 14 days; a short wake renews it. The watchdog
                // puts the machine back to sleep after the usual delay. With this app not
                // running that long, the machine is restored from its snapshot instead.
                last_keep_alive = Some(Instant::now());
                tracing::info!("keep-alive wake for {}", self.id());
                if let Err(e) = self.ensure_awake().await {
                    tracing::warn!("keep-alive wake for {}: {e:#}", self.id());
                }
            }
            let due = self.scheduled_wake().is_some_and(|due| chrono::Utc::now() >= due - DUE_LEAD);
            if (due || self.has_queued_wake())
                && last_due_wake.is_none_or(|t| t.elapsed() >= DUE_WAKE_RETRY)
            {
                last_due_wake = Some(Instant::now());
                tracing::info!("waking {} for work due", self.id());
                if let Err(e) = self.ensure_awake().await {
                    tracing::warn!("waking {} for work due: {e:#}", self.id());
                }
            }
            if let Some((sandbox, stop)) = self.begin_save() {
                let this = self.clone();
                tokio::spawn(async move { this.save_snapshot(sandbox, stop).await });
            }
            let running = self.power() == Power::Running;
            let came_up = running && !was_running;
            was_running = running;
            if running {
                if came_up || last_link_check.is_none_or(|t| t.elapsed() >= LINK_CHECK) {
                    last_link_check = Some(Instant::now());
                    let this = self.clone();
                    tokio::spawn(async move {
                        if let Err(e) = this.ensure_linked().await {
                            tracing::warn!("linking {} into Sail: {e:#}", this.id());
                        }
                        if came_up {
                            this.refresh_projects().await;
                            this.refresh_connect().await;
                        }
                    });
                }
                // Retries a send that failed during the wake.
                self.flush_deferred_commands().await;
                match self.watchdog_get("/status").await {
                    Ok(s) => {
                        watchdog_failures = 0;
                        if was_busy && !s.busy {
                            // The turn's last edits may have landed after the last busy poll.
                            self.cache.lock().unwrap().bump_epoch();
                            let this = self.clone();
                            tokio::spawn(async move { this.refresh_projects().await });
                        }
                        was_busy = s.busy;
                        if !s.agents_unknown && self.wake_failure.lock().unwrap().take().is_some() {
                            // A failed wake came up after all: T3 answers.
                            self.shared.changed();
                            let this = self.clone();
                            tokio::spawn(async move { this.on_ready().await });
                        }
                        let sleep_broken = s.sleep_broken;
                        // Otherwise only a resume upgrades it, and an older watchdog whose own stop
                        // always fails never sleeps. Scripts only: T3 runs on under whatever works
                        // there. Not during a save, which restarting the watchdog would kill, nor
                        // while T3 can't be checked: a restarted one takes that for T3 starting,
                        // not maybe mid-turn.
                        let upgrade = s.phase == WatchdogPhase::Active
                            && !s.saving
                            && !s.agents_unknown
                            && self.record().provision_revision != provision::revision();
                        self.on_watchdog_status(s).await;
                        if sleep_broken && last_overdue_stop.is_none_or(|t| t.elapsed() >= OVERDUE_STOP_RETRY) {
                            last_overdue_stop = Some(Instant::now());
                            match self.stop_overdue().await {
                                Ok(false) => {}
                                Ok(true) => {
                                    if !std::mem::replace(&mut overdue_stop_told, true) {
                                        self.shared.notify(
                                            format!("{} didn't go to sleep on its own", self.record().name),
                                            "Sail put it to sleep from this computer. Its own stop failed; with this computer off it may keep running.",
                                        );
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("stopping {}: {e:#}", self.id());
                                    if !std::mem::replace(&mut overdue_stop_failed, true) {
                                        self.shared.notify(format!("{} won't go to sleep", self.record().name), format!("{e:#}"));
                                    }
                                }
                            }
                        } else if upgrade && last_upgrade.is_none_or(|t| t.elapsed() >= UPGRADE_RETRY) {
                            last_upgrade = Some(Instant::now());
                            // Not kept awake: that counts as use, so an upgrade failing every
                            // retry would never let it sleep.
                            if let Err(e) = self.upgrade(None).await {
                                tracing::warn!("upgrading {}: {e:#}", self.id());
                            }
                        }
                    }
                    Err(_) => watchdog_failures += 1,
                }
            }
            tokio::time::sleep(WATCHDOG_POLL).await;
        }
    }

    /// When work T3 starts on its own (an automation, ...) comes due on a sleeping machine, which
    /// wakes for it as an always-on server would run it. Only work due after it went to sleep:
    /// what came due while it ran had its chance.
    pub fn scheduled_wake(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        let due = chrono::DateTime::from_timestamp_millis(self.record.read().unwrap().next_due_at?)?;
        let stopped_at = (*self.stopped_at.lock().unwrap())?;
        (self.power() == Power::Stopped && due > stopped_at).then_some(due)
    }

    /// A message Sail was told is sent, still queued on a sleeping machine: its wake failed
    /// or never ran.
    fn has_queued_wake(&self) -> bool {
        self.power() == Power::Stopped
            && self.cache.lock().unwrap().deferred_commands.iter().any(|c| {
                c["type"].as_str().is_some_and(|k| classify::WAKING_COMMANDS.contains(&k))
            })
    }
}

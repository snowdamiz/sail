//! The app's model: machines, settings, setup checks. UI-agnostic; the daemon and MCP server
//! both drive it.

use crate::boat::{Boat, Starts};
use crate::machine::{provision, Event, MachineRuntime, Power, Shared, WatchdogPhase};
use crate::proxy;
use crate::store::{Doomed, Settings, Spend, State, Store};
use crate::t3desktop::T3Desktop;
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;

/// Starts past the default `SAIL_MCP_PORT` (`47731`).
const FIRST_PORT: u16 = 47732;
/// Machines ever created here: deleted ones keep their port.
const PORTS: u16 = 1000;
/// How often a delete Boat hasn't confirmed is tried again.
const REAP_RETRY: Duration = Duration::from_secs(60);
/// Pending this long since this launch first tried it: the user is told, and it is tried on.
const REAP_WARN: Duration = Duration::from_secs(15 * 60);

/// Why the app cannot run yet, in the order the user has to fix it.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Setup {
    /// The first check is still running.
    #[default]
    Starting,
    Ready,
    InstallBoat,
    SignInBoat,
    InstallT3,
}

pub async fn check_setup() -> (Setup, Option<Boat>, Option<T3Desktop>) {
    let Some(boat) = Boat::locate() else { return (Setup::InstallBoat, None, None) };
    if !boat.account().await.is_ok_and(|a| a.signed_in) {
        return (Setup::SignInBoat, Some(boat), None);
    }
    let Some(t3) = T3Desktop::locate() else { return (Setup::InstallT3, Some(boat), None) };
    (Setup::Ready, Some(boat), Some(t3))
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MachineState {
    Working,
    Idle,
    Sleeping,
    Asleep,
    Waking,
    Creating,
    Error,
    Missing,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineView {
    pub id: String,
    pub environment_id: Option<String>,
    pub name: String,
    pub size: String,
    pub state: MachineState,
    pub detail: String,
    /// Set while `detail` counts down, so the UI can tick it between updates.
    pub countdown: Option<Countdown>,
    pub paired: bool,
    /// Agents that need a sign-in on this machine (done in Sail, per machine).
    pub signed_out: Vec<String>,
    /// Its T3 projects as last seen, and those being added (with their progress).
    pub projects: Vec<crate::machine::projects::MachineProject>,
    /// When a "keep awake" runs out (unix ms); none when off or until stopped.
    pub keep_awake_until: Option<u64>,
    pub keep_awake_forever: bool,
    /// An agent there waits on the user: a resize waits for the next sleep.
    pub waiting: bool,
}

/// `detail` as `template` with `{left}` filled in: the time left until `ends_at` (unix ms).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Countdown {
    pub template: String,
    pub ends_at: u64,
}

impl Countdown {
    fn new(template: &'static str, secs: u64, from: SystemTime) -> Self {
        Self { template: template.to_owned(), ends_at: unix_ms_after(from, secs) }
    }

    fn text(&self, secs: u64) -> String {
        self.template.replace("{left}", &human_secs(secs))
    }
}

/// Saturates: `secs` comes from the machine and may be anything.
fn unix_ms_after(from: SystemTime, secs: u64) -> u64 {
    let from_ms = from.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    from_ms.saturating_add(secs.saturating_mul(1000))
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineUsage {
    pub today: f64,
    pub month: f64,
    pub awake_secs_today: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Costs {
    pub today: f64,
    pub month: f64,
    pub starts_today: u64,
    pub starts_limit: u64,
}

/// A machine being created: it holds its name and local port until it exists.
struct Creating {
    name: String,
    step: String,
    port: u16,
    /// Its Boat sandbox, once there is one.
    sandbox: Option<String>,
}

impl Creating {
    /// Its sandbox and the snapshot its watchdog saves, as `provision::create` names it: the
    /// machine's id is its first sandbox's.
    fn doomed(&self) -> Option<Doomed> {
        let id = self.sandbox.as_ref()?;
        Some(Doomed { sandbox: Some(id.clone()), snapshot: Some(provision::snapshot_name(&self.name, id)) })
    }
}

/// What the reaper knows this launch of one it deletes.
struct Reaping {
    since: Instant,
    /// The user was told it stays pending.
    told: bool,
    /// Its delete ran: only then does Boat's list leaving it out confirm it gone.
    deleted: bool,
}

struct Running {
    machine: Arc<MachineRuntime>,
    tasks: Vec<JoinHandle<()>>,
}

pub struct App {
    pub shared: Arc<Shared>,
    store: Store,
    data_dir: PathBuf,
    machines: RwLock<Vec<Running>>,
    creating: Mutex<Vec<Creating>>,
    starts: Mutex<Starts>,
    /// By sandbox id, gone sandboxes included: `Spend`.
    spend: Mutex<HashMap<String, Spend>>,
    retired_ports: Mutex<Vec<u16>>,
    /// What the reaper deletes until Boat confirms it gone. Saved, so a quit picks up next launch.
    doomed: Mutex<Vec<Doomed>>,
    /// Wakes the reaper for something just given up.
    reaper: Notify,
}

impl App {
    pub fn new(
        boat: Boat,
        t3: T3Desktop,
        data_dir: PathBuf,
        events: mpsc::UnboundedSender<Event>,
    ) -> Result<Arc<Self>> {
        let store = Store::new(&data_dir);
        let state = store.load().context("reading Sail Boat state")?;
        let sandboxes = state.pending_sandboxes.into_iter().map(|s| Doomed { sandbox: Some(s), snapshot: None });
        // A machine saved meanwhile owns its sandbox and snapshot.
        let doomed: Vec<Doomed> = state
            .doomed
            .into_iter()
            .chain(sandboxes)
            .filter(|d| !state.machines.iter().any(|m| d.sandbox.as_ref() == Some(&m.sandbox_id)))
            .collect();
        let shared = Arc::new(Shared {
            boat,
            t3: t3.with_token_file(data_dir.join("t3-token")),
            settings: RwLock::new(state.settings.clone()),
            events,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                // Boat answers an unrouted port with a redirect to its fallback page.
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            saving: Mutex::new(HashSet::new()),
        });
        let app = Arc::new(Self {
            shared,
            store,
            data_dir,
            machines: RwLock::new(Vec::new()),
            creating: Mutex::new(Vec::new()),
            starts: Mutex::new(Starts::default()),
            spend: Mutex::new(state.spend),
            retired_ports: Mutex::new(state.retired_ports),
            doomed: Mutex::new(doomed),
            reaper: Notify::new(),
        });
        for record in state.machines {
            app.spawn(app.runtime(record));
        }
        tokio::spawn(app.clone().reap());
        Ok(app)
    }

    /// Aborts background machine proxy/polling tasks cleanly during shutdown.
    pub fn shutdown(&self) {
        self.save();
        for running in self.machines.write().unwrap().drain(..) {
            for task in running.tasks {
                task.abort();
            }
        }
    }

    /// Deletes what was given up until Boat confirms each gone: a sandbox left behind bills
    /// without limit, and Boat can be down for a while. Done only on Boat's own list, never on
    /// a delete's answer alone.
    async fn reap(self: Arc<Self>) {
        let mut reaping: HashMap<String, Reaping> = HashMap::new();
        loop {
            if self.reap_pass(&mut reaping).await {
                tokio::select! {
                    _ = self.reaper.notified() => {}
                    _ = tokio::time::sleep(REAP_RETRY) => {}
                }
            } else {
                self.reaper.notified().await;
            }
        }
    }

    /// Works each doomed pair, its sandbox first, its snapshot once the sandbox is confirmed
    /// gone. Returns whether any is left.
    async fn reap_pass(&self, reaping: &mut HashMap<String, Reaping>) -> bool {
        let doomed = self.doomed.lock().unwrap().clone();
        let boat = &self.shared.boat;
        let sandboxes = if doomed.iter().any(|d| d.sandbox.is_some()) {
            let listed = boat.list().await.map(|l| l.into_iter().map(|s| s.id).collect::<Vec<_>>());
            listed.inspect_err(|e| tracing::warn!("listing sandboxes to confirm deletes: {e:#}")).ok()
        } else {
            None
        };
        let snapshots = if doomed.iter().any(|d| d.sandbox.is_none()) {
            let listed = boat.named_snapshots().await;
            listed.inspect_err(|e| tracing::warn!("listing snapshots to confirm deletes: {e:#}")).ok()
        } else {
            None
        };
        let mut confirmed = false;
        for pair in doomed {
            let mut left = pair.clone();
            if let Some(id) = &pair.sandbox {
                // Its snapshot is being saved: deleted after, or the save could outlive the
                // snapshot's delete.
                if self.shared.saving.lock().unwrap().contains(id) {
                    continue;
                }
                let delete = boat.delete(id);
                if !self.reap_one(reaping, id, sandboxes.as_deref(), "sandbox", "boat delete", delete).await {
                    continue;
                }
                left.sandbox = None;
            }
            if let Some(name) = &pair.snapshot {
                let delete = boat.delete_snapshot(name);
                if self.reap_one(reaping, name, snapshots.as_deref(), "saved snapshot", "boat snapshot rm", delete).await {
                    left.snapshot = None;
                }
            }
            if left != pair {
                confirmed = true;
                let mut doomed = self.doomed.lock().unwrap();
                if let Some(i) = doomed.iter().position(|d| *d == pair) {
                    if left == Doomed::default() {
                        doomed.remove(i);
                    } else {
                        doomed[i] = left;
                    }
                }
            }
        }
        if confirmed {
            self.shared.persist();
        }
        !self.doomed.lock().unwrap().is_empty()
    }

    /// Deletes `key` unless Boat's `listed` confirms it gone, which counts only after a delete
    /// ran: a list can leave out one it still bills. With no list (`None`, as when it failed),
    /// it is deleted again. Tells the user once of one pending past `REAP_WARN`. Returns whether
    /// it is confirmed gone.
    async fn reap_one(
        &self,
        reaping: &mut HashMap<String, Reaping>,
        key: &str,
        listed: Option<&[String]>,
        what: &str,
        cmd: &str,
        delete: impl Future<Output = Result<()>>,
    ) -> bool {
        let p = reaping.entry(key.to_owned()).or_insert(Reaping { since: Instant::now(), told: false, deleted: false });
        if p.deleted && listed.is_some_and(|l| !l.iter().any(|k| k == key)) {
            reaping.remove(key);
            return true;
        }
        if let Err(e) = delete.await {
            tracing::warn!("deleting {what} {key}: {e:#}");
        }
        p.deleted = true;
        if !p.told && p.since.elapsed() >= REAP_WARN {
            p.told = true;
            self.shared.notify(
                "Boat hasn't confirmed a delete",
                format!("The {what} {key} may still be on Boat. Sail keeps trying; `{cmd} {key}` deletes it by hand."),
            );
        }
        false
    }

    fn machine_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join("machines").join(id)
    }

    fn runtime(&self, record: crate::store::Machine) -> Arc<MachineRuntime> {
        let dir = self.machine_dir(&record.id);
        Arc::new(MachineRuntime::new(self.shared.clone(), record, dir))
    }

    /// Starts the machine's proxy and background loop.
    fn spawn(&self, machine: Arc<MachineRuntime>) {
        let proxy_machine = machine.clone();
        let proxy = tokio::spawn(async move {
            let port = proxy_machine.record().local_port;
            if let Err(e) = proxy::serve(proxy_machine.clone()).await {
                tracing::error!("proxy on port {port} failed: {e:#}");
                proxy_machine.shared.notify(
                    "Sail Boat",
                    format!("{} cannot listen on port {port}: {e}", proxy_machine.record().name),
                );
            }
        });
        let runner = tokio::spawn(machine.clone().run());
        self.machines.write().unwrap().push(Running { machine, tasks: vec![proxy, runner] });
    }

    pub fn machines(&self) -> Vec<Arc<MachineRuntime>> {
        self.machines.read().unwrap().iter().map(|r| r.machine.clone()).collect()
    }

    /// By id, or by name ignoring case.
    pub fn machine(&self, machine: &str) -> Result<Arc<MachineRuntime>> {
        self.machines()
            .into_iter()
            .find(|m| m.id() == machine || m.record().name.eq_ignore_ascii_case(machine))
            .ok_or_else(|| anyhow!("no machine {machine}"))
    }

    pub fn settings(&self) -> Settings {
        self.shared.settings.read().unwrap().clone()
    }

    /// Only the event loop calls this on `Event::Persist`: one writer for the state file.
    pub fn save(&self) {
        // One lock at a time: a guard in a field initializer would live until the end of the `let`.
        let spend = self.spend.lock().unwrap().clone();
        let retired_ports = self.retired_ports.lock().unwrap().clone();
        // In this order: a sandbox moves from `creating` to a machine or `doomed`, and from a
        // machine to `doomed`, each added before it leaves, so a racing save sees it in one or
        // both, never neither. `App::new` gives "both" to the machine. A create still running is
        // saved as doomed: deleted at the next launch if the app quit before it finished.
        let creating: Vec<Doomed> = self.creating.lock().unwrap().iter().filter_map(Creating::doomed).collect();
        let machines = self.machines().iter().map(|m| m.record()).collect();
        let doomed = self.doomed.lock().unwrap().iter().cloned().chain(creating).collect();
        let state = State {
            machines,
            settings: self.settings(),
            spend,
            retired_ports,
            doomed,
            pending_sandboxes: Vec::new(),
        };
        if let Err(e) = self.store.save(&state) {
            tracing::error!("saving state: {e:#}");
        }
    }

    pub fn update_settings(&self, settings: Settings) {
        *self.shared.settings.write().unwrap() = settings;
        self.shared.persist();
    }

    /// Claims the name and a local port for a new machine, so concurrent creates never share
    /// either.
    fn reserve(&self, name: &str) -> Result<u16> {
        let mut creating = self.creating.lock().unwrap();
        let records: Vec<_> = self.machines().iter().map(|m| m.record()).collect();
        let names = records.iter().map(|m| &m.name).chain(creating.iter().map(|c| &c.name));
        if names.into_iter().any(|n| n.eq_ignore_ascii_case(name)) {
            bail!("a machine called {name} already exists");
        }
        let retired = self.retired_ports.lock().unwrap();
        let mcp_port = crate::mcp::configured_port();
        let used: Vec<u16> = records
            .iter()
            .map(|m| m.local_port)
            .chain(creating.iter().map(|c| c.port))
            .chain(retired.iter().copied())
            .collect();
        let port = (FIRST_PORT..FIRST_PORT + PORTS)
            .find(|p| *p != mcp_port && !used.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
            .ok_or_else(|| anyhow!("no free local port"))?;
        creating.push(Creating { name: name.to_owned(), step: "Preparing".into(), port, sandbox: None });
        Ok(port)
    }

    /// Saved before provisioning starts: a quit or crash from here on leaves the sandbox billed.
    fn set_creating_sandbox(&self, name: &str, sandbox: &str) {
        if let Some(c) = self.creating.lock().unwrap().iter_mut().find(|c| c.name == name) {
            c.sandbox = Some(sandbox.to_owned());
        }
        self.shared.persist();
    }

    fn set_creating_step(&self, name: &str, step: &str) {
        if let Some(c) = self.creating.lock().unwrap().iter_mut().find(|c| c.name == name) {
            c.step = step.to_owned();
        }
        self.shared.changed();
    }

    pub async fn create_machine(self: &Arc<Self>, name: &str, size: &str, projects: Vec<String>) -> Result<Arc<MachineRuntime>> {
        if !valid_name(name) {
            bail!("machine names are 1-32 lowercase letters, digits or dashes, starting with a letter or digit");
        }
        let port = self.reserve(name)?;
        self.shared.changed();
        let result = async {
            let version = self.shared.t3.version().await?;
            let record = provision::create(
                &self.shared.boat,
                name,
                size,
                &version,
                port,
                |sandbox| self.set_creating_sandbox(name, sandbox),
                |step| self.set_creating_step(name, step),
            )
            .await?;
            let machine = self.runtime(record);
            // Before pairing: Sail's onboarding needs the descriptor and session right away.
            // On failure the machine's loop primes it again.
            if let Err(e) = machine.prime().await {
                tracing::warn!("priming {}: {e:#}", machine.id());
            }
            self.spawn(machine.clone());
            Ok::<_, anyhow::Error>(machine)
        }
        .await;
        // A failed create's sandbox goes to the reaper, with `creating` still locked: see `save`.
        let failed = {
            let mut creating = self.creating.lock().unwrap();
            let c = creating.iter().position(|c| c.name == name).map(|i| creating.remove(i));
            let doomed = c.filter(|_| result.is_err()).as_ref().and_then(Creating::doomed);
            let failed = doomed.is_some();
            if let Some(d) = doomed {
                self.doomed.lock().unwrap().push(d);
            }
            failed
        };
        self.shared.persist();
        self.shared.changed();
        if failed {
            self.reaper.notify_one();
        }
        let machine = result?;
        let (app, m) = (self.clone(), machine.clone());
        tokio::spawn(async move {
            for id in projects {
                let added = match app.resolve_project(&id).await {
                    Ok(project) => app.add_resolved_project(&m, &project).await.map_err(|e| (Some(project.title), e)),
                    Err(e) => Err((None, e)),
                };
                if let Err((title, e)) = added {
                    tracing::warn!("adding {id} to {}: {e:#}", m.id());
                    app.shared.notify(
                        format!("{} didn't reach {}", title.as_deref().unwrap_or("A project"), m.record().name),
                        "Adding it again from Boats shows why.",
                    );
                }
            }
        });
        Ok(machine)
    }

    /// This computer's Sail projects that can go to a machine: those with a git remote.
    pub async fn local_projects(&self) -> Result<Vec<crate::projects::Project>> {
        self.shared.t3.projects().await
    }

    /// Adds this computer's Sail project `project` (its id, path or title) to the machine as
    /// Sail's "Add to another machine" does: cloned from its remote, with its env files. Resolves
    /// once cloned.
    pub async fn add_project(&self, machine: &MachineRuntime, project: &str) -> Result<crate::projects::Project> {
        let project = self.resolve_project(project).await?;
        self.add_resolved_project(machine, &project).await?;
        Ok(project)
    }

    async fn resolve_project(&self, project: &str) -> Result<crate::projects::Project> {
        self.local_projects()
            .await?
            .into_iter()
            .find(|p| p.id == project || p.path == project || p.title.eq_ignore_ascii_case(project))
            .ok_or_else(|| anyhow!("no project {project} with a git remote"))
    }

    async fn add_resolved_project(&self, machine: &MachineRuntime, project: &crate::projects::Project) -> Result<()> {
        let (files, mut failed) = self.shared.t3.files_to_copy(project).await?;
        failed.extend(machine.add_project(project, files).await?);
        if !failed.is_empty() {
            self.shared.notify(
                format!("Some of {}'s files didn't reach {}", project.title, machine.record().name),
                failed.join("\n"),
            );
        }
        Ok(())
    }

    pub fn pair_link(&self, machine: &MachineRuntime) -> String {
        let code = machine.auth.new_pairing_code();
        let pairing_url = format!("http://localhost:{}/pair#token={code}", machine.record().local_port);
        crate::t3desktop::pair_link(&pairing_url)
    }

    /// Refuses while work runs on the machine, unless `discard`. Sail offers no way to remove
    /// a backend from outside, so a paired machine ends with a note on what to remove there.
    pub async fn delete_machine(&self, machine: &MachineRuntime, discard: bool) -> Result<()> {
        // Boat can't report a deleted sandbox's usage: the last chance to count its tail.
        let (day, month) = periods();
        self.refresh_spend(machine, day, month).await;
        if !discard {
            machine.check_idle_before_delete().await?;
        }
        let record = {
            // Held until retired: a later wake then sees Missing, and none restores meanwhile.
            let _waking = machine.waking.lock().await;
            machine.retire();
            // Read under the lock: a wake may have restored it onto a new sandbox.
            machine.record()
        };
        let id = record.id.as_str();
        // The reaper deletes them on Boat, saved with the state below, until Boat confirms each
        // gone. The snapshot exists only if the machine ever slept with this app's watchdog.
        let snapshot = provision::snapshot_name(&record.name, &record.id);
        self.doomed.lock().unwrap().push(Doomed { sandbox: Some(record.sandbox_id.clone()), snapshot: Some(snapshot) });
        let running = {
            let mut machines = self.machines.write().unwrap();
            let idx = machines.iter().position(|r| r.machine.id() == id);
            idx.map(|i| machines.remove(i))
        };
        if let Some(r) = running {
            r.tasks.iter().for_each(JoinHandle::abort);
        }
        self.retired_ports.lock().unwrap().push(record.local_port);
        // Saved before the slow part: a quit meanwhile must not bring back a machine with no dir.
        self.shared.persist();
        self.shared.changed();
        self.reaper.notify_one();
        let _ = std::fs::remove_dir_all(machine.dir());
        if let Err(e) = self.shared.t3.unlink(&record.environment_id).await {
            tracing::warn!("unlinking {id} from Sail: {e:#}");
        }
        if !record.client_tokens.is_empty() {
            self.shared.notify(
                format!("Remove {} from Sail", record.name),
                "Sail still lists it. Remove it there under Settings → Environments.",
            );
        }
        Ok(())
    }

    pub fn views(&self) -> Vec<MachineView> {
        let mut views: Vec<MachineView> = self.machines().iter().map(|m| view(m)).collect();
        for c in self.creating.lock().unwrap().iter() {
            views.push(MachineView {
                id: String::new(),
                environment_id: None,
                name: c.name.clone(),
                size: String::new(),
                state: MachineState::Creating,
                detail: c.step.clone(),
                countdown: None,
                paired: false,
                signed_out: Vec::new(),
                projects: Vec::new(),
                keep_awake_until: None,
                keep_awake_forever: false,
                waiting: false,
            });
        }
        views
    }

    /// Totals count every sandbox spent on this month, those of deleted machines and those a
    /// restore replaced included.
    pub fn costs(&self) -> Costs {
        let (day, month) = periods();
        let starts = self.starts.lock().unwrap().clone();
        let mut costs =
            Costs { starts_today: starts.used_today, starts_limit: starts.limit_today, ..Costs::default() };
        for spend in self.spend.lock().unwrap().values() {
            let u = usage(spend, day, month);
            costs.today += u.today;
            costs.month += u.month;
        }
        costs
    }

    fn usage(&self, machine: &MachineRuntime) -> MachineUsage {
        let (day, month) = periods();
        let id = machine.id();
        let mut total = MachineUsage::default();
        for spend in self.spend.lock().unwrap().values().filter(|s| s.machine == id) {
            let u = usage(spend, day, month);
            total.today += u.today;
            total.month += u.month;
            total.awake_secs_today += u.awake_secs_today;
        }
        total
    }

    /// Looks up the spend of the machine's current sandbox. A failed lookup keeps the last known
    /// figures, never a fake zero.
    async fn refresh_spend(&self, machine: &MachineRuntime, day: i64, month: i64) {
        if machine.power() == Power::Missing {
            return;
        }
        let boat = &self.shared.boat;
        let sandbox = machine.sandbox_id();
        let Ok((today, this_month)) = tokio::try_join!(boat.usage_since(&sandbox, day), boat.usage_since(&sandbox, month))
        else {
            return;
        };
        let spend = Spend {
            machine: machine.id(),
            day,
            today: today.dollars,
            awake_secs_today: today.seconds,
            month: this_month.dollars,
        };
        self.spend.lock().unwrap().insert(sandbox, spend);
    }

    pub async fn refresh_costs(&self) {
        let (day, month) = periods();
        let boat = &self.shared.boat;
        for m in self.machines() {
            self.refresh_spend(&m, day, month).await;
        }
        self.spend.lock().unwrap().retain(|_, s| s.day >= month);
        if let Ok(starts) = boat.starts().await {
            *self.starts.lock().unwrap() = starts;
        }
        self.shared.persist();
        self.shared.changed();
    }
}

/// "at 14:30" today, "Tue 14:30" on another day.
fn local_time(t: chrono::DateTime<chrono::Utc>) -> String {
    let t = t.with_timezone(&chrono::Local);
    if t.date_naive() == chrono::Local::now().date_naive() {
        t.format("at %H:%M").to_string()
    } else {
        t.format("%a %H:%M").to_string()
    }
}

/// Starts of the current local day and month, unix seconds.
fn periods() -> (i64, i64) {
    use chrono::{Datelike, Local, TimeZone};
    let now = Local::now();
    let start = |day| {
        Local
            .with_ymd_and_hms(now.year(), now.month(), day, 0, 0, 0)
            .single()
            .map(|t| t.timestamp())
            .unwrap_or_default()
    };
    (start(now.day()), start(1))
}

/// What `spend` counts toward the periods starting at `day` and `month`: nothing for a period
/// that began after its lookup.
fn usage(spend: &Spend, day: i64, month: i64) -> MachineUsage {
    let today = spend.day >= day;
    MachineUsage {
        today: if today { spend.today } else { 0.0 },
        month: if spend.day >= month { spend.month } else { 0.0 },
        awake_secs_today: if today { spend.awake_secs_today } else { 0 },
    }
}

/// What the details view (and agents) show about one machine, beyond its MachineView.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineDetails {
    pub id: String,
    pub cost_today: f64,
    pub cost_month: f64,
    pub awake_secs_today: u64,
    pub agents: Vec<AgentLogin>,
    pub t3_version: String,
    pub created_at: i64,
    /// T3 Connect is on: other devices reach it with the user's account.
    pub connect: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogin {
    pub name: String,
    pub signed_in: bool,
}

impl App {
    /// Never wakes the machine.
    pub fn details(&self, machine: &str) -> Result<MachineDetails> {
        let machine = self.machine(machine)?;
        let id = machine.id();
        let record = machine.record();
        let usage = self.usage(&machine);
        let agents = machine.cache.lock().unwrap().agents();
        Ok(MachineDetails {
            id,
            cost_today: usage.today,
            cost_month: usage.month,
            awake_secs_today: usage.awake_secs_today,
            // Only agents whose status is known, so this agrees with `signed_out` in the list.
            agents: agents
                .into_iter()
                .filter(|(_, status)| matches!(status.as_str(), "authenticated" | "unauthenticated"))
                .map(|(name, status)| AgentLogin { name, signed_in: status == "authenticated" })
                .collect(),
            t3_version: record.t3_version,
            created_at: record.created_at,
            connect: record.connect,
        })
    }

    pub fn open_in_t3(&self, machine: &MachineRuntime, thread: Option<&str>) -> Option<String> {
        let record = machine.record();
        if record.client_tokens.is_empty() {
            return Some(self.pair_link(machine));
        }
        thread.map(|thread| crate::t3desktop::thread_link(&record.environment_id, thread))
    }
}

fn view(m: &MachineRuntime) -> MachineView {
    let r = m.record();
    let watchdog = m.watchdog_status();
    let mut countdown = None;
    let mut count_down = |template, secs, from| {
        let c = Countdown::new(template, secs, from);
        let text = c.text(secs);
        countdown = Some(c);
        text
    };
    use MachineState::*;
    let (state, mut detail) = match (m.power(), &watchdog) {
        (Power::Missing, _) => (Missing, "Deleted on Boat".to_owned()),
        (_, _) if m.last_error().is_some() => (Error, m.last_error().unwrap_or_default()),
        (Power::Running, Some(w)) if w.agents_unknown => (Working, "Server not answering · stays up 30m max".to_owned()),
        (Power::Running, Some(w)) if w.cpu_busy => (Working, "Working · busy CPU".to_owned()),
        (Power::Running, Some(w)) if w.busy => (Working, working_line(w.working_threads, w.working_subagents)),
        (Power::Running, Some(w)) if w.phase == WatchdogPhase::Active && w.keep_awake_forever => {
            (Idle, "Awake until you stop it".to_owned())
        }
        (Power::Running, Some(w)) if w.phase == WatchdogPhase::Active && w.keep_awake_secs > 0 => {
            (Idle, count_down("Kept awake · {left} left", w.keep_awake_secs, w.received))
        }
        (Power::Running, Some(w)) if w.phase == WatchdogPhase::Active && w.work_due => {
            let due = w.next_due_at.and_then(chrono::DateTime::from_timestamp_millis);
            (Idle, due.map_or("Idle · scheduled work due".to_owned(), |t| format!("Idle · scheduled work {}", local_time(t))))
        }
        (Power::Running, Some(w)) if w.phase == WatchdogPhase::Active => {
            let left = w.sleep_after_secs.saturating_sub(w.idle_secs);
            let template = if w.waiting_threads > 0 { "Waiting on you · sleeps in {left}" } else { "Idle · sleeps in {left}" };
            (Idle, count_down(template, left, w.received))
        }
        (Power::Running, Some(_)) | (Power::Stopping, _) => (Sleeping, "Going to sleep".to_owned()),
        (Power::Running, None) => (Idle, "Running".to_owned()),
        (Power::Starting, _) => (Waking, "Waking up".to_owned()),
        (Power::Stopped, _) => match m.scheduled_wake() {
            Some(due) => (Asleep, format!("Asleep · wakes {} for scheduled work", local_time(due))),
            None => (Asleep, "Asleep".to_owned()),
        },
        (Power::Unknown, _) => (Unknown, "Checking".to_owned()),
    };
    if !matches!(state, Missing | Error) && m.server_upgrade_pending(&r) {
        const PENDING: &str = "Sail upgrade pending · ";
        detail.insert_str(0, PENDING);
        if let Some(countdown) = &mut countdown {
            countdown.template.insert_str(0, PENDING);
        }
    }
    let running_watchdog = watchdog.as_ref().filter(|_| m.power() == Power::Running);
    MachineView {
        id: r.id.clone(),
        environment_id: Some(r.environment_id),
        name: r.name.clone(),
        size: r.size.clone(),
        state,
        detail,
        countdown,
        paired: !r.client_tokens.is_empty(),
        signed_out: m.cache.lock().unwrap().signed_out_providers(),
        projects: m.projects(),
        keep_awake_until: running_watchdog
            .filter(|w| w.keep_awake_secs > 0)
            .map(|w| unix_ms_after(w.received, w.keep_awake_secs)),
        keep_awake_forever: running_watchdog.is_some_and(|w| w.keep_awake_forever),
        waiting: running_watchdog.is_some_and(|w| w.waiting_threads > 0),
    }
}

/// The UI's rule: `^[a-z0-9][a-z0-9-]{0,31}$`.
fn valid_name(name: &str) -> bool {
    let ok = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    name.len() <= 32 && name.starts_with(ok) && name.chars().all(|c| ok(c) || c == '-')
}

/// "Working · 2 threads · 3 subagents".
fn working_line(threads: u32, subagents: u32) -> String {
    let count = |n: u32, one: &str| match n {
        0 => None,
        1 => Some(format!("1 {one}")),
        n => Some(format!("{n} {one}s")),
    };
    std::iter::once("Working".to_owned())
        .chain(count(threads, "thread"))
        .chain(count(subagents, "subagent"))
        .collect::<Vec<_>>()
        .join(" · ")
}

/// "42s", "4m", "1h 5m"; minutes round up. The UI's `timeLeft` matches it.
fn human_secs(s: u64) -> String {
    let m = s.div_ceil(60);
    match (s, m) {
        (0..60, _) => format!("{s}s"),
        (_, 0..60) => format!("{m}m"),
        _ => format!("{}h {}m", m / 60, m % 60),
    }
}

pub fn open_url(url: &str) -> Result<()> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).stdin(std::process::Stdio::null()).status()?
    } else if cfg!(target_os = "linux") {
        match std::process::Command::new("gio").args(["open", url]).stdin(std::process::Stdio::null()).status() {
            Ok(s) if s.success() => s,
            _ => std::process::Command::new("xdg-open").arg(url).stdin(std::process::Stdio::null()).status()?,
        }
    } else {
        // No shell: `cmd /C start` would run anything after a `&` in the URL.
        std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).stdin(std::process::Stdio::null()).status()?
    };
    if !status.success() {
        bail!("could not open the link on this computer");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn valid_name() {
        for ok in ["dev", "0", "a-b-", &"a".repeat(32)] {
            assert!(super::valid_name(ok), "{ok}");
        }
        for bad in ["", "-dev", "Dev", "my dev", "dév", &"a".repeat(33)] {
            assert!(!super::valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn spend_counts_only_in_its_periods() {
        let spend =
            crate::store::Spend { machine: "m".into(), day: 100, today: 1.0, awake_secs_today: 60, month: 5.0 };
        let same_day = super::usage(&spend, 100, 0);
        assert_eq!((same_day.today, same_day.awake_secs_today, same_day.month), (1.0, 60, 5.0));
        let later_day = super::usage(&spend, 200, 0);
        assert_eq!((later_day.today, later_day.awake_secs_today, later_day.month), (0.0, 0, 5.0));
        let later_month = super::usage(&spend, 300, 300);
        assert_eq!((later_month.today, later_month.month), (0.0, 0.0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wake_delivers_deferred_commands_to_the_incumbent_with_upgrade_pending() {
        use super::*;
        use axum::{
            Json, Router,
            extract::ws::{Message, WebSocketUpgrade},
            routing::{get, post},
        };
        use futures_util::{SinkExt, StreamExt};
        use crate::store::Machine;
        use serde_json::{Value, json};
        use std::{fs, os::unix::fs::PermissionsExt};

        let (dispatched, mut commands) = mpsc::unbounded_channel();
        let attempts = Arc::new(Mutex::new(HashSet::new()));
        let (notices, mut notifications) = mpsc::unbounded_channel();
        let watchdog_status = || async {
            Json(json!({
                "phase":"active","busy":false,"workingThreads":0,"workingSubagents":0,"cpuBusy":false,
                "agentsUnknown":false,"keepAwakeSecs":0,"keepAwakeForever":false,
                "idleSecs":0,"sleepAfterSecs":180
            }))
        };
        let upstream = Router::new()
            .route("/.well-known/t3/environment", get(|| async { Json(json!({"environmentId":"env-dev"})) }))
            .route("/api/auth/session", get(|| async { Json(json!({})) }))
            .route("/activity", post(watchdog_status))
            .route("/status", get(watchdog_status))
            .route("/ws", get(move |ws: WebSocketUpgrade| {
                let dispatched = dispatched.clone();
                let attempts = attempts.clone();
                async move {
                    ws.on_upgrade(move |mut socket| async move {
                        while let Some(Ok(Message::Text(text))) = socket.recv().await {
                            let request: Value = serde_json::from_str(&text).unwrap();
                            dispatched.send(request.clone()).unwrap();
                            let payload = &request["payload"];
                            let id = payload["commandId"].as_str().unwrap_or_default();
                            let first = attempts.lock().unwrap().insert(id.to_owned());
                            if id == "lost-ack" && first {
                                return;
                            }
                            let exit = if id == "retry-maintenance" && first {
                                json!({"_tag":"Failure","cause":[{"_tag":"Fail","error":{
                                    "_tag":"OrchestrationV2DispatchCommandError",
                                    "commandId":id,"commandType":payload["type"],"retryable":true,"message":"maintenance"
                                }}]})
                            } else {
                                json!({"_tag":"Success","value":null})
                            };
                            socket.send(Message::Text(json!({
                                "_tag":"Exit","requestId":request["id"],"exit":exit
                            }).to_string().into())).await.unwrap();
                        }
                    })
                }
            }));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        for restored in [false, true] {
            let dir = std::env::temp_dir().join(format!("sail-boat-wake-{:016x}", rand::random::<u64>()));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("url"), &url).unwrap();
            if restored {
                fs::write(dir.join("expired"), "").unwrap();
            }
            let boat = dir.join("boat");
            fs::write(&boat, r#"#!/bin/sh
d=$(dirname "$0"); shift
echo "$1" >> "$d/calls"
case "$1" in
  info) echo '{"sandbox":{"id":"bx_dev","state":"stopped"}}' ;;
  resume) if [ -f "$d/expired" ]; then echo snapshot_data_expired >&2; exit 1; fi ;;
  new) echo '{"id":"bx_restored"}' ;;
  delete) echo '{}' ;;
  host) printf '{"url":"%s"}\n' "$(cat "$d/url")" ;;
  *) exit 1 ;;
esac
"#).unwrap();
            fs::set_permissions(&boat, fs::Permissions::from_mode(0o700)).unwrap();
            let t3 = dir.join("t3");
            fs::write(&t3, "#!/bin/sh\necho 't3 v2.0.0'\n").unwrap();
            fs::set_permissions(&t3, fs::Permissions::from_mode(0o700)).unwrap();
            let events = notices.clone();
            let shared = Arc::new(Shared {
                boat: Boat::at(boat),
                t3: T3Desktop::at(t3),
                settings: RwLock::new(Settings::default()),
                events,
                http: reqwest::Client::new(),
                saving: Mutex::new(HashSet::new()),
            });
            let watchdog_receipt = format!("watchdog:{}", provision::revision());
            let record = Machine {
                id: "bx_dev".into(),
                sandbox_id: "bx_dev".into(),
                name: "dev".into(),
                size: "small".into(),
                upstream_url: url.clone(),
                upstream_token: "upstream".into(),
                watchdog_url: url.clone(),
                watchdog_secret: "watchdog".into(),
                local_port: 0,
                t3_version: "1.0.0".into(),
                provision_revision: watchdog_receipt.clone(),
                environment_id: "env-dev".into(),
                client_tokens: Vec::new(),
                link_tokens: Vec::new(),
                created_at: 0,
                next_due_at: None,
                connect: false,
                saved_stop: None,
            };
            let machine = Arc::new(MachineRuntime::new(shared, record, dir.clone()));
            let command = |id: &str| json!({"type":"message.dispatch","commandId":id,"threadId":"fixture-thread"});
            let initial = if restored { "restore-first" } else { "warm-first" };
            let retry = if restored { "lost-ack" } else { "retry-maintenance" };
            let tail = if restored { "restore-tail" } else { "warm-tail" };
            let originals = vec![command(initial), command(retry), command(tail)];
            machine.cache.lock().unwrap().deferred_commands = originals.clone();

            machine.ensure_awake().await.unwrap();
            let request = commands.try_recv().unwrap();
            assert_eq!(request["tag"], "orchestration.dispatchCommand");
            assert_eq!(request["payload"], originals[0]);
            assert_eq!(commands.try_recv().unwrap()["payload"], originals[1]);
            assert!(commands.try_recv().is_err());
            assert_eq!(&machine.cache.lock().unwrap().deferred_commands, &originals[1..]);
            assert_eq!(crate::proxy::cache::Cache::load(&crate::proxy::cache::cache_path(&dir)).deferred_commands, &originals[1..]);

            if !restored {
                let proxy_machine = machine.clone();
                let proxy = Router::new().route("/ws", get(move |ws: WebSocketUpgrade| {
                    let machine = proxy_machine.clone();
                    async move { ws.on_upgrade(move |socket| crate::proxy::session::run(machine, socket, String::new())) }
                }));
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
                let addr = format!("ws://{}/ws", listener.local_addr().unwrap());
                let proxy_task = tokio::spawn(async move { axum::serve(listener, proxy).await.unwrap() });
                let (mut downstream, _) = tokio_tungstenite::connect_async(addr).await.unwrap();
                downstream.send(tokio_tungstenite::tungstenite::Message::text(json!({
                    "_tag":"Request", "id":"new-send", "tag":"orchestration.dispatchCommand",
                    "payload":command("newer"), "headers":[]
                }).to_string())).await.unwrap();
                let response = tokio::time::timeout(Duration::from_secs(2), downstream.next())
                    .await.unwrap().unwrap().unwrap();
                let response: Value = serde_json::from_str(response.to_text().unwrap()).unwrap();
                assert_eq!(response["requestId"], "new-send");
                let error = &response["exit"]["cause"][0]["error"];
                assert_eq!(error["_tag"], "OrchestrationV2DispatchCommandError");
                assert_eq!(error["retryable"], true);
                assert_eq!(error["commandId"], "newer");
                assert!(commands.try_recv().is_err());
                downstream.close(None).await.unwrap();
                proxy_task.abort();
            }

            machine.ensure_awake().await.unwrap();
            assert_eq!(commands.try_recv().unwrap()["payload"], originals[1]);
            assert_eq!(commands.try_recv().unwrap()["payload"], originals[2]);
            assert!(commands.try_recv().is_err());
            assert!(!std::iter::from_fn(|| notifications.try_recv().ok()).any(|event| matches!(event, Event::Notify { .. })));
            let state = view(&machine);
            assert_eq!(state.state, MachineState::Idle);
            assert!(state.detail.contains("Sail upgrade pending"), "{}", state.detail);
            assert!(state.countdown.unwrap().template.contains("Sail upgrade pending"));
            assert!(machine.last_error().is_none());
            assert!(machine.cache.lock().unwrap().deferred_commands.is_empty());

            let mut expected = vec!["info", "resume"];
            let record = machine.record();
            if restored {
                expected.extend(["new", "delete", "host", "host"]);
                assert_eq!(record.sandbox_id, "bx_restored");
                assert!(record.provision_revision.is_empty());
            } else {
                assert_eq!(record.t3_version, "1.0.0");
                assert_eq!(record.provision_revision, watchdog_receipt);
            }
            let calls = fs::read_to_string(dir.join("calls")).unwrap();
            assert_eq!(calls.lines().collect::<Vec<_>>(), expected);
            fs::remove_dir_all(dir).unwrap();
        }
        server.abort();
    }

    /// A Boat CLI that logs each call. `list` fails while `list-down` exists; `bx_a` deletes once
    /// `up` exists, `bx_ghost` (never listed) always, `bx_stuck` (always listed) never.
    #[cfg(unix)]
    const FLAKY_BOAT: &str = r#"#!/bin/sh
d=$(dirname "$0"); shift
echo "$*" >> "$d/log"
case "$1" in
  list) [ -f "$d/list-down" ] && exit 1
    a='{"id":"bx_a","state":"running"},'; [ -f "$d/bx_a-gone" ] && a=
    echo "{\"sandboxes\":[$a{\"id\":\"bx_stuck\",\"state\":\"error\"}]}" ;;
  delete) case "$2" in
    bx_a) [ -f "$d/up" ] || { echo 'Boat is down' >&2; exit 1; }; touch "$d/bx_a-gone" ;;
    bx_ghost|bx_new) ;;
    *) echo 'Boat is down' >&2; exit 1 ;;
  esac; echo '{}' ;;
  snapshots) a='{"name":"snap-a"},'; [ -f "$d/snap-a-rm" ] && a=
    echo "{\"named\":[$a{\"name\":\"snap-b\"}]}" ;;
  snapshot) touch "$d/$3-rm"; echo '{"status":"deleted"}' ;;
  *) exit 1 ;;
esac
"#;

    #[cfg(unix)]
    async fn until(what: &str, done: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !done() {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// What a quit left to delete is deleted at the next launch, kept through refused deletes and
    /// failed lists, and dropped only once Boat's list confirms it gone after a delete, even one
    /// the list never showed. A pair's snapshot waits for its own sandbox only, a sandbox for a
    /// save of it. A create the quit interrupted goes with the snapshot its watchdog may have saved.
    #[cfg(unix)]
    #[tokio::test]
    async fn reaper_deletes_until_boat_confirms() {
        use crate::store::Doomed;
        use std::os::unix::fs::PermissionsExt;
        let pair = |sandbox: Option<&str>, snapshot: Option<&str>| Doomed {
            sandbox: sandbox.map(Into::into),
            snapshot: snapshot.map(Into::into),
        };
        let dir = std::env::temp_dir().join(format!("sail-boat-reaper-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("boat");
        std::fs::write(&bin, FLAKY_BOAT).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("list-down"), "").unwrap();
        let store = crate::store::Store::new(&dir);
        let (events, _rx) = tokio::sync::mpsc::unbounded_channel();
        let launch = || {
            let t3 = crate::t3desktop::T3Desktop::at(dir.join("t3"));
            super::App::new(crate::boat::Boat::at(bin.clone()), t3, dir.clone(), events.clone()).unwrap()
        };

        // The launch that quits: two deleted machines and a create past its sandbox. Its reaper
        // starts with nothing to do and is never woken.
        let quit = launch();
        quit.doomed.lock().unwrap().extend([pair(Some("bx_a"), Some("snap-a")), pair(Some("bx_stuck"), Some("snap-b"))]);
        let port = super::FIRST_PORT;
        quit.creating.lock().unwrap().push(super::Creating { name: "new".into(), step: String::new(), port, sandbox: Some("bx_new".into()) });
        quit.save();
        // `pendingSandboxes` as an older state file has it.
        let mut state: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("state.json")).unwrap()).unwrap();
        state["pendingSandboxes"] = serde_json::json!(["bx_ghost"]);
        std::fs::write(dir.join("state.json"), state.to_string()).unwrap();

        let app = launch();
        let doomed = || app.doomed.lock().unwrap().clone();
        let log = || std::fs::read_to_string(dir.join("log")).unwrap_or_default();
        let ran = |call: &str| log().lines().any(|l| l == call);

        // Launch pass: the sandbox list fails, every delete still runs, nothing is dropped.
        until("the first pass", || ran("delete bx_ghost --yes")).await;
        for call in ["delete bx_a --yes", "delete bx_stuck --yes", "delete bx_new --yes"] {
            assert!(ran(call), "{call} despite the failed list");
        }
        assert!(!log().contains("snapshot rm"), "snapshots wait for their sandboxes");
        let all = vec![
            pair(Some("bx_a"), Some("snap-a")),
            pair(Some("bx_stuck"), Some("snap-b")),
            pair(Some("bx_new"), Some("sail-new-bx-new")),
            pair(Some("bx_ghost"), None),
        ];
        assert_eq!(doomed(), all, "all kept after refused deletes and a failed list");
        app.save();
        assert_eq!(store.load().unwrap().doomed, all, "saved for the next launch");

        // Boat is back: the list confirms the two sandboxes it never showed, so the interrupted
        // create's snapshot goes now; `bx_a` is deleted now.
        std::fs::remove_file(dir.join("list-down")).unwrap();
        std::fs::write(dir.join("up"), "").unwrap();
        app.reaper.notify_one();
        until("ghost and new confirmed", || doomed().len() == 3).await;
        assert_eq!(doomed()[2], pair(None, Some("sail-new-bx-new")));
        assert!(ran("snapshot rm sail-new-bx-new"));
        assert!(dir.join("bx_a-gone").exists());
        assert!(!ran("snapshot rm snap-a"), "kept until Boat's list confirms its sandbox gone");

        // `bx_a` confirmed: its snapshot goes, though `bx_stuck` still holds its own. The list
        // confirms the snapshot it never showed.
        app.reaper.notify_one();
        let stuck = pair(Some("bx_stuck"), Some("snap-b"));
        until("bx_a and the new snapshot confirmed", || doomed() == [pair(None, Some("snap-a")), stuck.clone()]).await;
        assert!(ran("snapshot rm snap-a"));
        app.reaper.notify_one();
        until("snap-a confirmed", || doomed().len() == 1).await;
        assert_eq!(doomed(), [stuck]);
        assert!(!ran("snapshot rm snap-b"), "a stuck sandbox holds back its own snapshot");

        // A sandbox whose snapshot is being saved waits for the save.
        app.shared.saving.lock().unwrap().insert("bx_saving".into());
        app.doomed.lock().unwrap().push(pair(Some("bx_saving"), Some("snap-s")));
        app.reap_pass(&mut super::HashMap::new()).await;
        assert!(!ran("delete bx_saving --yes"), "deleted only once its save ends");
        app.shared.saving.lock().unwrap().clear();
        app.reap_pass(&mut super::HashMap::new()).await;
        assert!(ran("delete bx_saving --yes"));
        app.doomed.lock().unwrap().retain(|d| d.sandbox.as_deref() != Some("bx_saving"));
        app.save();
        assert_eq!(store.load().unwrap().doomed, doomed());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

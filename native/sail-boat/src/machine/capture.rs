//! What a machine sleeps with: the capture of its final state taken as it drains, the chats and
//! recordings brought up to that state, and reading them back while it is asleep.

use super::{MachineRuntime, Manifest, Power};
use crate::proxy::assets;
use crate::proxy::cache::{self, Capture};
use crate::proxy::threads::{self, ThreadFlags};
use crate::proxy::upstream;
use anyhow::{bail, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

/// Second check on a confirmed capture: Boat's stop time must follow the latest confirmation
/// closely (allowing for clock skew between this computer and Boat).
/// The watchdog stops on its next tick after an accepted ack (5 s), after its usual checks, and
/// gives up on a stop after 90 s. A stop retried later at that sequence counts only if this app
/// sees it and confirms again.
const CAPTURE_TO_STOP_MAX: chrono::TimeDelta = chrono::TimeDelta::minutes(2);
/// Time for a capture, shell and chats. The watchdog waits 45 s into a drain for the ack before
/// saving the snapshot itself, awake, and this app may learn of the drain 5 s late.
const CAPTURE_BUDGET: Duration = Duration::from_secs(12);
const THREAD_FETCHES: usize = 4;
const CLOCK_SKEW: chrono::TimeDelta = chrono::TimeDelta::minutes(1);

impl MachineRuntime {
    /// The capture stands in for the server only if it was confirmed, by an accepted ack or by
    /// seeing the watchdog stopping at its sequence, and the stop followed closely.
    pub fn fresh_capture(&self) -> Option<Capture> {
        if self.power() != Power::Stopped {
            return None;
        }
        let stopped_at = (*self.stopped_at.lock().unwrap())?;
        let capture = self.cache.lock().unwrap().capture.clone().filter(|c| c.confirmed)?;
        let gap = stopped_at - chrono::DateTime::from_timestamp_millis(capture.at)?;
        (gap >= -CLOCK_SKEW && gap <= CAPTURE_TO_STOP_MAX).then_some(capture)
    }

    pub(super) fn drop_capture(&self) {
        if self.cache.lock().unwrap().capture.take().is_some() {
            self.save_cache();
        }
    }

    pub(super) fn captured_sequence(&self) -> Option<u64> {
        self.cache.lock().unwrap().capture.as_ref().map(|c| c.sequence)
    }

    /// Confirmed by an accepted ack or by seeing the watchdog stopping at its sequence. Dated
    /// again by each: the stop follows the last of them, and a drain can stall between them.
    pub(super) fn confirm_capture(&self, sequence: u64) {
        let changed = match self.cache.lock().unwrap().capture.as_mut() {
            Some(c) if c.sequence == sequence => {
                c.confirmed = true;
                c.at = chrono::Utc::now().timestamp_millis();
                true
            }
            _ => false,
        };
        if changed {
            self.save_cache();
        }
    }

    /// Records the final state the machine sleeps with: everything Sail needs to resume its
    /// shell and open its chats without the machine.
    pub(super) async fn capture(&self, manifest: &Manifest) -> Result<()> {
        let deadline = tokio::time::Instant::now() + CAPTURE_BUDGET;
        let mut shell = tokio::time::timeout_at(deadline, self.shell_snapshot()).await??;
        if shell["snapshotSequence"].as_u64() != Some(manifest.sequence) {
            bail!("state moved during capture");
        }
        if let Some(o) = shell.as_object_mut() {
            o.remove("projectIdentities");
        }
        self.set_projects_from(&shell);
        let (configs, (), ()) = tokio::join!(
            self.refresh_project_configs(deadline),
            self.refresh_scheduled_tasks(deadline),
            self.store_threads(manifest, &shell, deadline),
        );
        if let Err(e) = configs {
            tracing::warn!("reading t3.json again on {}: {e:#}", self.id());
        }
        {
            let mut cache = self.cache.lock().unwrap();
            cache.prune();
            assets::sweep(&self.dir, &cache);
            cache.capture = Some(Capture {
                at: chrono::Utc::now().timestamp_millis(),
                sequence: manifest.sequence,
                threads: manifest.threads.clone(),
                shell,
                confirmed: false,
            });
        }
        self.save_cache();
        tracing::info!("captured {} at sequence {}", self.id(), manifest.sequence);
        Ok(())
    }

    /// Reads every recorded `t3.json` again, so that it is true while the machine sleeps: Sail
    /// reads it on every chat open, and its editor saves over the file whatever it was
    /// shown. One not read again keeps its epoch, so opening that chat wakes the machine.
    async fn refresh_project_configs(&self, deadline: tokio::time::Instant) -> Result<()> {
        let (epoch, reads) = {
            let cache = self.cache.lock().unwrap();
            (cache.epoch, cache.project_config_reads())
        };
        if reads.is_empty() {
            return Ok(());
        }
        let (keys, requests): (Vec<_>, Vec<_>) =
            reads.into_iter().map(|(key, payload)| (key, ("projects.readFile".to_owned(), payload))).unzip();
        let answers = tokio::time::timeout_at(
            deadline,
            upstream::call_many(&self.upstream_url(), &self.upstream_token(), requests),
        )
        .await??;
        let mut cache = self.cache.lock().unwrap();
        for (key, value) in keys.iter().zip(answers) {
            if let Ok(value) = value
                && !value.is_null()
            {
                cache.refresh_unary(key, epoch, value);
            }
        }
        Ok(())
    }

    /// Reads the automations again if Sail was shown them, so that the list is true while
    /// the machine sleeps: agents and runs change tasks with no client watching, and the
    /// editor saves every field of a task as it was shown. A list not read again is dropped, so
    /// asking for it wakes the machine.
    async fn refresh_scheduled_tasks(&self, deadline: tokio::time::Instant) {
        const TAG: &str = "scheduledTasks.subscribe";
        let key = cache::request_key(TAG, &json!({}));
        if !self.cache.lock().unwrap().streams.contains_key(&key) {
            return;
        }
        let (url, token) = (self.upstream_url(), self.upstream_token());
        let first = upstream::subscribe_until(&url, &token, TAG, json!({}), CAPTURE_BUDGET, |list| Some(list.clone()));
        let list = tokio::time::timeout_at(deadline, first).await;
        let mut cache = self.cache.lock().unwrap();
        match (list, cache.streams.get_mut(&key)) {
            (Ok(Ok((Some(list), _))), Some(replay)) => replay.value = vec![list],
            _ => {
                cache.streams.remove(&key);
            }
        }
    }

    /// A read of the machine's orchestration state over HTTP.
    async fn orchestration_get(&self, path: &str) -> Result<reqwest::Response> {
        let res = self
            .shared
            .http
            .get(format!("{}/api/orchestration/{path}", self.upstream_url()))
            .bearer_auth(self.upstream_token())
            .header("x-t3-orchestration-protocol", "2")
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("{path}: HTTP {}", res.status());
        }
        Ok(res)
    }

    /// The whole shell: no thread left out, so it holds every chat to store and serves every
    /// client.
    pub(super) async fn shell_snapshot(&self) -> Result<Value> {
        Ok(self.orchestration_get("shell").await?.json().await?)
    }

    /// Brings the thread store up to the state the machine sleeps with: fetches the chats it
    /// does not hold in that state, then drops every other file. Best effort until `deadline`,
    /// most recently used first; a chat that is not stored wakes the machine when opened, and
    /// is fetched on a later sleep.
    async fn store_threads(&self, manifest: &Manifest, shell: &Value, deadline: tokio::time::Instant) {
        // Sail opened no chat through this proxy yet: nothing says how to encode them.
        let Some(flags) = self.cache.lock().unwrap().thread_encoding else { return };
        let wanted = threads::plan(&self.dir, shell, &manifest.threads, flags, chrono::Utc::now());
        let missing = wanted.iter().filter(|w| !w.path.exists());
        let fetches = futures_util::stream::iter(missing).for_each_concurrent(THREAD_FETCHES, |w| async move {
            let stored = async {
                crate::store::write_private(&w.path, &self.fetch_thread(w.thread, w.sequence, flags).await?)
            };
            if let Err(e) = stored.await {
                tracing::warn!("storing chat {} of {}: {e:#}", w.thread, self.id());
            }
        });
        if tokio::time::timeout_at(deadline, fetches).await.is_err() {
            tracing::info!("{}: not every chat stored before sleep", self.id());
        }
        threads::sweep(&self.dir, &wanted.into_iter().map(|w| w.path).collect());
    }

    /// The chat's bounded snapshot, as of thread sequence `sequence`.
    async fn fetch_thread(&self, thread: &str, sequence: u64, flags: ThreadFlags) -> Result<bytes::Bytes> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Head {
            snapshot_sequence: u64,
        }
        let path = format!("threads/{}/bounded?{}", urlencoding::encode(thread), flags.query());
        let body = self.orchestration_get(&path).await?.bytes().await?;
        if serde_json::from_slice::<Head>(&body)?.snapshot_sequence != sequence {
            bail!("state moved during capture");
        }
        Ok(body)
    }

    /// The chat as the machine sleeps with it, in the encoding `flags`. `None`: not stored, or
    /// stored in an earlier state or another encoding.
    pub fn stored_thread(&self, capture: &Capture, thread: &str, flags: ThreadFlags) -> Option<Vec<u8>> {
        std::fs::read(threads::path(&self.dir, thread, *capture.threads.get(thread)?, flags)).ok()
    }

    /// Id of the most recently updated non-subagent thread: from the server while it runs, else
    /// from the confirmed capture. Never wakes the machine.
    pub async fn latest_thread(&self) -> Option<String> {
        let shell = if self.power() == Power::Running {
            self.shell_snapshot().await.ok()?
        } else {
            self.cache.lock().unwrap().capture.as_ref().filter(|c| c.confirmed)?.shell.clone()
        };
        shell["threads"]
            .as_array()?
            .iter()
            .filter(|t| t["lineage"]["relationshipToParent"] != "subagent")
            .filter_map(|t| Some((t["updatedAt"].as_str()?, t["id"].as_str()?)))
            .max()
            .map(|(_, id)| id.to_owned())
    }
}

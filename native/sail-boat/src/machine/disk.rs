//! Keeping a sleeping machine's disk: the snapshot it can be restored from, saved once it
//! stopped, and the keep-alive wakes before Boat deletes a stopped disk.

use super::{provision, MachineRuntime, Power};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use std::time::{Duration, Instant};

/// Boat deletes a stopped sandbox's disk this long after the stop; saving from it then could
/// replace the only good snapshot with nothing.
const DISK_KEPT: chrono::TimeDelta = chrono::TimeDelta::days(14);
/// A stopped machine is woken this long after the stop, before `DISK_KEPT` runs out.
const KEEP_ALIVE_AFTER: chrono::TimeDelta = chrono::TimeDelta::days(12);
const SAVE_RETRY: Duration = Duration::from_secs(10 * 60);
/// Saves failing this long since the first: the user is told, and it is tried on.
const SAVE_WARN: Duration = Duration::from_secs(60 * 60);

/// Saves failing since `since` with no success between, the last at `last`.
pub(super) struct SaveFailure {
    since: Instant,
    last: Instant,
    told: bool,
}

impl MachineRuntime {
    /// Stopped since its snapshot was saved, its disk still kept, and no save running or failed
    /// just now: claims the save, returning the sandbox to save from and the stop it saves.
    pub(super) fn begin_save(&self) -> Option<(String, DateTime<Utc>)> {
        if self.save_failure.lock().unwrap().as_ref().is_some_and(|f| f.last.elapsed() < SAVE_RETRY) {
            return None;
        }
        let stop = (*self.stopped_at.lock().unwrap())?;
        if Utc::now() - stop >= DISK_KEPT || self.record.read().unwrap().saved_stop.is_some_and(|s| s >= stop) {
            return None;
        }
        let sandbox = self.sandbox_id();
        // Power checked under the lock: a delete retires the machine before the reaper reads
        // `saving`, so either this sees it Missing or the reaper sees this save.
        let mut saving = self.shared.saving.lock().unwrap();
        (self.power() == Power::Stopped && saving.insert(sandbox.clone())).then_some((sandbox, stop))
    }

    /// Saves the snapshot from the stopped sandbox claimed by `begin_save`: the watchdog leaves
    /// that to this app, since a save while awake bills for its minutes. A wake meanwhile doesn't
    /// wait for it.
    pub(super) async fn save_snapshot(&self, sandbox: String, stop: DateTime<Utc>) {
        let record = self.record();
        let name = provision::snapshot_name(&record.name, &record.id);
        match self.shared.boat.save_snapshot(&sandbox, &name).await {
            Ok(()) => {
                *self.save_failure.lock().unwrap() = None;
                if self.sandbox_id() == sandbox {
                    self.update_record(|m| m.saved_stop = Some(stop));
                }
            }
            Err(e) => {
                tracing::warn!("saving {}'s snapshot: {e:#}", record.id);
                let now = Instant::now();
                let mut failure = self.save_failure.lock().unwrap();
                let f = failure.get_or_insert(SaveFailure { since: now, last: now, told: false });
                f.last = now;
                if !f.told && f.since.elapsed() >= SAVE_WARN {
                    f.told = true;
                    self.shared.notify(
                        format!("{}'s backup snapshot isn't saving", record.name),
                        "Sail keeps trying. If Boat deletes the sleeping machine's disk before a save succeeds, \
                         it is restored from its last saved snapshot, losing later work, or cannot be restored if it never had one.",
                    );
                }
            }
        }
        self.shared.saving.lock().unwrap().remove(&sandbox);
    }

    pub(super) fn needs_keep_alive(&self) -> bool {
        self.power() == Power::Stopped
            && self.stopped_at.lock().unwrap().is_some_and(|t| Utc::now() - t > KEEP_ALIVE_AFTER)
    }

    /// Boat deleted the stopped sandbox's disk: a new sandbox takes its place, its disk the
    /// snapshot saved at the last sleep. Its addresses differ; the wake hosts them.
    pub(super) async fn restore(&self) -> Result<()> {
        let record = self.record();
        let boat = &self.shared.boat;
        tracing::info!("restoring {} from its snapshot", record.id);
        let sandbox = boat
            .create(
                &provision::sandbox_name(&record.name),
                &record.size,
                Some(&provision::snapshot_name(&record.name, &record.id)),
            )
            .await
            .context("Boat deleted this machine's disk after 14 days asleep, and restoring its snapshot failed")?;
        // The snapshot may contain an older runtime and its watchdog still names the old sandbox.
        // Clear both receipts so Boats shows the pending server upgrade and refreshes the watchdog.
        self.update_record(|m| {
            m.sandbox_id = sandbox;
            m.t3_version.clear();
            m.provision_revision.clear();
        });
        if let Err(e) = boat.delete(&record.sandbox_id).await {
            tracing::warn!("deleting {}'s expired sandbox {}: {e:#}", record.id, record.sandbox_id);
        }
        Ok(())
    }
}

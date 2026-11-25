//! Work running on a machine: keeping it up for Sail Boat's own jobs, and guarding deletes.

use super::{MachineRuntime, Power, HEARTBEAT_EVERY};
use anyhow::{bail, Result};

impl MachineRuntime {
    /// Runs `f` while telling the watchdog the machine is in use, so it does not fall asleep meanwhile.
    pub(super) async fn kept_awake<T>(&self, f: impl Future<Output = T>) -> T {
        let mut beat = tokio::time::interval(HEARTBEAT_EVERY);
        tokio::pin!(f);
        loop {
            tokio::select! {
                out = &mut f => return out,
                _ = beat.tick() => self.send_activity(false).await,
            }
        }
    }

    /// Fails while an agent or a build works on the machine, or while that can't be told yet. An
    /// agent waiting on the user is not work: nothing runs until they answer. An asleep machine has
    /// nothing running, so it isn't woken just to ask.
    pub async fn check_idle_before_delete(&self) -> Result<()> {
        match self.settled_power().await {
            Power::Stopped | Power::Missing => Ok(()),
            Power::Running if self.watchdog_get("/status?fresh").await?.busy => {
                bail!("work is still running on it (an agent or a build); wait for it to finish, or delete and discard")
            }
            Power::Running => Ok(()),
            _ => bail!("can't tell yet whether work runs on it; try again, or delete and discard"),
        }
    }
}

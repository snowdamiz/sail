//! Keeps the machine linked into the desktop app's own server, so agents on this computer
//! can work on it (`delegate_task`, the thread tools) with nothing to set up. The link goes
//! through the proxy, like Sail itself: a linked machine always answers and wakes when used.

use super::{MachineRuntime, Power};
use anyhow::Result;
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

/// The ceiling for what agents here may do there. A call is still held to the mode of the
/// thread it comes from, and the machine is there to run agents unattended.
const ACCESS: &str = "full-access";
/// What a pairing code must carry for that access.
const SCOPES: &[&str] = &["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"];
/// T3 links last 30 days and cannot be refreshed: a new one replaces it this long before.
const RENEW_BEFORE: chrono::TimeDelta = chrono::TimeDelta::days(7);

impl MachineRuntime {
    /// Links the running machine, unless it is linked for a while yet or the user keeps linked
    /// environments off in Sail.
    pub async fn ensure_linked(&self) -> Result<()> {
        let _guard = self.waking.lock().await;
        if self.power() != Power::Running {
            return Ok(());
        }
        let t3 = &self.shared.t3;
        if !t3.links_enabled() {
            return Ok(());
        }
        let record = self.record();
        let renew_at = chrono::Utc::now() + RENEW_BEFORE;
        if t3.links().await?.iter().any(|l| l.environment_id == record.environment_id && l.expires_at > renew_at) {
            return Ok(());
        }
        let code = self.pairing_code().await?;
        t3.link(&format!("http://localhost:{}", record.local_port), &code, ACCESS).await?;
        tracing::info!("linked {} into Sail", self.id());
        Ok(())
    }

    /// A one-time code from the machine's server that lets a T3 server link to it.
    async fn pairing_code(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Pairing {
            credential: String,
        }
        let pairing: Pairing = self
            .shared
            .http
            .post(format!("{}/api/auth/pairing-token", self.upstream_url()))
            .bearer_auth(self.upstream_token())
            .json(&json!({"label": "sail-boat link", "scopes": SCOPES}))
            .timeout(Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(pairing.credential)
    }
}

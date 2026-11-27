use super::MachineRuntime;
use anyhow::{Result, bail};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

impl MachineRuntime {
    pub(super) async fn check_connect_idle(&self) -> Result<()> {
        // `t3 up` restarts the server to start the tunnel, which stops running agent turns and
        // expires the approvals they wait on.
        let s = self.watchdog_get("/status?fresh").await?;
        if s.busy {
            bail!("an agent is working; turn T3 Connect on once it finishes");
        }
        if s.waiting_threads > 0 {
            bail!("an agent is waiting on you there; answer it, then turn T3 Connect on");
        }
        Ok(())
    }

    pub(super) async fn finish_connect(&self) -> Result<()> {
        // A webhook sent while the machine sleeps is then held by T3 Connect's relay and run as
        // it wakes, instead of failing.
        let state = self.connect_api(Method::GET, "link-state", None).await?;
        let preferences = json!({
            "publishAgentActivity": state["publishAgentActivity"].as_bool().unwrap_or(false),
            "holdWebhooksWhileOffline": true,
        });
        self.connect_api(Method::POST, "preferences", Some(preferences))
            .await?;
        self.update_record(|r| r.connect = true);
        Ok(())
    }

    /// Reads whether T3 Connect is on, for a machine that just woke: it can be turned on or off
    /// on the machine too.
    pub(super) async fn refresh_connect(&self) {
        match self.connect_api(Method::GET, "link-state", None).await {
            Ok(state) => {
                let on = state["linked"] == true && state["managedTunnelActive"] == true;
                if self.record().connect != on {
                    self.update_record(|r| r.connect = on);
                }
            }
            Err(e) => tracing::warn!("reading T3 Connect state of {}: {e:#}", self.id()),
        }
    }

    /// T3's `/api/connect/*` routes on the machine.
    async fn connect_api(&self, method: Method, route: &str, body: Option<Value>) -> Result<Value> {
        let url = format!("{}/api/connect/{route}", self.upstream_url());
        let mut req = self
            .shared
            .http
            .request(method, url)
            .bearer_auth(self.upstream_token())
            .timeout(Duration::from_secs(15));
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await?;
        if !res.status().is_success() {
            bail!("T3 Connect {route}: HTTP {}", res.status());
        }
        Ok(res.json().await?)
    }
}

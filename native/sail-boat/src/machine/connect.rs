//! T3 Connect: the tunnel for other devices (a phone, a browser) to reach a machine with the
//! user's account. It is set up on the machine itself with `t3 up --connect`, which Sail Boat
//! runs there: its sign-in page opens here, and once it is on, Sail Boat turns on the one
//! setting a sleeping machine needs.

use super::MachineRuntime;
use anyhow::{bail, Result};
use reqwest::Method;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// Device sign-in lasts 10 minutes; then the restart and the first tunnel connection.
const SETUP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const URL_TIMEOUT: Duration = Duration::from_secs(120);

impl MachineRuntime {
    /// Resolves once other devices can reach the machine through T3 Connect, after the user
    /// signed in in the browser.
    pub async fn turn_on_connect(&self) -> Result<()> {
        self.ensure_awake().await?;
        // `t3 up` restarts the server to start the tunnel, which stops running agent turns and
        // expires the approvals they wait on.
        let s = self.watchdog_get("/status?fresh").await?;
        if s.busy {
            bail!("an agent is working; turn T3 Connect on once it finishes");
        }
        if s.waiting_threads > 0 {
            bail!("an agent is waiting on you there; answer it, then turn T3 Connect on");
        }
        self.kept_awake(self.run_connect_setup()).await?;
        // A webhook sent while the machine sleeps is then held by T3 Connect's relay and run as
        // it wakes, instead of failing.
        let state = self.connect_api(Method::GET, "link-state", None).await?;
        let preferences = json!({
            "publishAgentActivity": state["publishAgentActivity"].as_bool().unwrap_or(false),
            "holdWebhooksWhileOffline": true,
        });
        self.connect_api(Method::POST, "preferences", Some(preferences)).await?;
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

    async fn run_connect_setup(&self) -> Result<()> {
        let id = self.sandbox_id();
        let boat = &self.shared.boat;
        // In the background, so the sign-in page can be read while it waits; `exit` says how it ended.
        let dir = boat
            .exec_ok(
                &id,
                "d=$(mktemp -d); \
                 (\"$HOME/.local/bin/t3\" up --base-dir \"$HOME/.t3\" --connect --headless --yes > \"$d/log\" 2>&1; echo $? > \"$d/exit\") \
                 </dev/null >/dev/null 2>&1 & echo \"$d\"",
                30,
            )
            .await?;
        let dir = dir.lines().last().unwrap_or_default().trim().to_owned();
        let result = self.finish_connect_setup(&dir).await;
        let _ = boat.exec(&id, &format!("rm -rf '{dir}'"), 30).await;
        result
    }

    async fn finish_connect_setup(&self, dir: &str) -> Result<()> {
        let id = self.sandbox_id();
        let boat = &self.shared.boat;
        let started = Instant::now();
        let mut opened = false;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let out = boat
                .exec(&id, &format!("cat '{dir}/exit' 2>/dev/null; echo ---; cat '{dir}/log'"), 30)
                .await?;
            let (exit, log) = out.stdout.split_once("---").unwrap_or_default();
            if !opened && let Some(url) = log.split_whitespace().find(|w| w.starts_with("https://")) {
                self.shared.t3.open_url(url)?;
                opened = true;
            }
            match exit.trim() {
                "" => {}
                "0" => return Ok(()),
                _ => bail!("T3 Connect setup failed: {}", last_line(log)),
            }
            if !opened && started.elapsed() > URL_TIMEOUT {
                bail!("T3 Connect setup did not reach its sign-in: {}", last_line(log));
            }
            if started.elapsed() > SETUP_TIMEOUT {
                bail!("the T3 Connect sign-in was not finished in the browser");
            }
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

fn last_line(log: &str) -> &str {
    log.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no output")
}

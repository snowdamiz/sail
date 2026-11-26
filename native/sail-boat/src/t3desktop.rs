//! The user's Sail desktop install: its version (machines are pinned to it), the deep links
//! that open it, the environments linked into its server, and that server's own API, read the
//! way a Sail client reads it.

use crate::process::command;
use crate::projects::{self, Project};
use crate::proxy::upstream;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_BUNDLE_ID: &str = "com.sail.desktop";
const DEFAULT_DEEP_LINK_SCHEME: &str = "sail";

/// An environment linked into the desktop app's server.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub environment_id: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// Sail's home directory (`SAIL_HOME`, else `T3CODE_HOME`, else `~/.sail`).
pub fn sail_home() -> Result<PathBuf> {
    non_empty_env("SAIL_HOME")
        .or_else(|| non_empty_env("T3CODE_HOME"))
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".sail")))
        .ok_or_else(|| anyhow!("no home directory"))
}

/// Persistent data directory for Sail Boat (`SAIL_BOAT_DATA_DIR`, else `<sail_home>/boat`).
pub fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = non_empty_env("SAIL_BOAT_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(sail_home()?.join("boat"))
}

/// Deep-link URL scheme handled by Sail (`SAIL_DEEP_LINK_SCHEME`, default `"sail"`).
pub fn deep_link_scheme() -> String {
    non_empty_env("SAIL_DEEP_LINK_SCHEME").unwrap_or_else(|| DEFAULT_DEEP_LINK_SCHEME.to_owned())
}

/// macOS bundle identifier for Sail (`SAIL_APP_BUNDLE_ID`, default `"com.sail.desktop"`).
pub fn app_bundle_id() -> String {
    non_empty_env("SAIL_APP_BUNDLE_ID").unwrap_or_else(|| DEFAULT_BUNDLE_ID.to_owned())
}

pub fn pair_link(pairing_url: &str) -> String {
    format!("{}://pair?pairingUrl={}", deep_link_scheme(), urlencoding::encode(pairing_url))
}

pub fn thread_link(environment_id: &str, thread_id: &str) -> String {
    format!("{}://threads/{environment_id}/{thread_id}", deep_link_scheme())
}

pub fn activate() -> Result<()> {
    if cfg!(target_os = "macos") {
        let status = std::process::Command::new("open").args(["-b", &app_bundle_id()]).stdin(std::process::Stdio::null()).status()?;
        if !status.success() {
            bail!("could not open Sail");
        }
        Ok(())
    } else {
        crate::app::open_url(&format!("{}://", deep_link_scheme()))
    }
}

/// Candidate home directories for settings/runtime lookup: explicit home first, plus `~/.t3`
/// only when neither `SAIL_HOME` nor `T3CODE_HOME` was explicitly configured.
fn candidate_homes() -> Result<Vec<PathBuf>> {
    let primary = sail_home()?;
    let mut homes = vec![primary.clone()];
    if non_empty_env("SAIL_HOME").is_none() && non_empty_env("T3CODE_HOME").is_none() {
        if let Some(legacy) = dirs::home_dir().map(|h| h.join(".t3")) {
            if legacy != primary {
                homes.push(legacy);
            }
        }
    }
    Ok(homes)
}

/// What Sail Boat may do on the desktop app's server: read its projects and their files.
const LOCAL_SCOPES: &[&str] = &["orchestration:read", "filesystem:read"];

#[derive(Clone, Debug)]
pub struct T3Desktop {
    /// The `t3` launcher bundled with Sail (`SAIL_DESKTOP_CLI`, `<sail_home>/bin/t3`, or `~/.t3/bin/t3`).
    cli: PathBuf,
    /// Where Sail Boat keeps its session on the desktop app's server (listed under
    /// Settings -> Connections as "sail-boat"). Set by the app before any API call.
    token_file: Option<PathBuf>,
    /// Held across read-or-issue so overlapping calls share one session.
    token: Arc<tokio::sync::Mutex<Option<String>>>,
}

impl T3Desktop {
    fn from_cli(cli: PathBuf) -> Self {
        Self { cli, token_file: None, token: Arc::default() }
    }

    pub fn locate() -> Option<Self> {
        if let Some(explicit) = non_empty_env("SAIL_DESKTOP_CLI") {
            let path = PathBuf::from(explicit);
            return path.is_file().then(|| Self::from_cli(path));
        }
        let candidates: &[&str] = if cfg!(windows) {
            &["sail.cmd", "t3.cmd", "sail.exe", "t3.exe"]
        } else {
            &["sail", "t3"]
        };
        if let Ok(home) = sail_home() {
            let bin = home.join("bin");
            if let Some(found) = candidates.iter().map(|name| bin.join(name)).find(|p| p.is_file()) {
                return Some(Self::from_cli(found));
            }
        }
        None
    }

    #[cfg(test)]
    pub fn at(cli: PathBuf) -> Self {
        Self::from_cli(cli)
    }

    pub fn with_token_file(mut self, path: PathBuf) -> Self {
        self.token = Arc::new(std::fs::read_to_string(&path).ok().map(|t| t.trim().to_owned()).into());
        self.token_file = Some(path);
        self
    }

    pub fn open_url(&self, url: &str) -> Result<()> {
        crate::app::open_url(url)
    }

    /// e.g. `0.1.10-nightly.20261114.4669`.
    pub async fn version(&self) -> Result<String> {
        let out = command(&self.cli)
            .arg("--version")
            .output()
            .await
            .context("running t3 --version")?;
        if !out.status.success() {
            bail!("t3 --version failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        let text = String::from_utf8_lossy(&out.stdout);
        text.split_whitespace()
            .find_map(|w| w.strip_prefix('v'))
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("unexpected t3 --version output: {text}"))
    }

    /// Runs the CLI's `environment` command: links live in the desktop app's database, which the
    /// CLI opens itself, so this works whether or not the app runs.
    async fn environment(&self, args: &[&str]) -> Result<Vec<u8>> {
        let out = command(&self.cli)
            .arg("environment")
            .args(args)
            .output()
            .await
            .context("running t3 environment")?;
        if !out.status.success() {
            bail!("t3 environment {}: {}", args[0], String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(out.stdout)
    }

    /// Whether linked environments are on in Sail (Settings -> Labs): its own switch for
    /// letting agents here work on other machines.
    pub fn links_enabled(&self) -> bool {
        let Ok(homes) = candidate_homes() else { return false };
        for home in homes {
            for sub in ["userdata", "dev"] {
                let path = home.join(sub).join("settings.json");
                let enabled = std::fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                    .is_some_and(|s| s["linkedEnvironmentsEnabled"] == true);
                if enabled {
                    return true;
                }
            }
        }
        false
    }

    pub async fn links(&self) -> Result<Vec<Link>> {
        Ok(serde_json::from_slice(&self.environment(&["list", "--json"]).await?)?)
    }

    /// Links the environment answering at `url`, with a one-time pairing code from it. `access`
    /// caps what agents here may do there.
    pub async fn link(&self, url: &str, pairing_code: &str, access: &str) -> Result<()> {
        self.environment(&["link", url, "--pairing-code", pairing_code, "--access", access]).await?;
        Ok(())
    }

    pub async fn unlink(&self, environment_id: &str) -> Result<()> {
        self.environment(&["unlink", environment_id]).await?;
        Ok(())
    }

    /// The desktop app's projects that can go to another machine: those with a git remote,
    /// pinned first, then most recently used. Asks for the trimmed snapshot T3's own client
    /// loads: every project, without the thousands of old threads (MBs, seconds) this ignores.
    pub async fn projects(&self) -> Result<Vec<Project>> {
        let shell = self
            .authorized(|origin, token| async move {
                let res = reqwest::Client::new()
                    .get(format!("{origin}/api/orchestration/shell"))
                    .query(&[("omitIdleSubagents", "1"), ("omitOlderSettled", "1")])
                    .bearer_auth(token)
                    .header("x-t3-orchestration-protocol", "2")
                    .timeout(Duration::from_secs(10))
                    .send()
                    .await?;
                if res.status() == reqwest::StatusCode::UNAUTHORIZED {
                    return Err(Unauthorized.into());
                }
                Ok(res.error_for_status()?.json::<Value>().await?)
            })
            .await?;
        Ok(projects::cloneable(&shell))
    }

    /// The ignored files Sail's "Add to another machine" dialog selects by default for
    /// `project`, with their contents. A file that can't be read is left out with its reason.
    pub async fn files_to_copy(&self, project: &Project) -> Result<(Vec<(String, String)>, Vec<String>)> {
        let listed = self.call("projects.listIgnoredFiles", json!({ "cwd": project.path })).await?;
        let mut files = Vec::new();
        let mut failed = Vec::new();
        for file in listed["files"].as_array().into_iter().flatten() {
            let (Some(path), Some(len)) = (file["path"].as_str(), file["byteLength"].as_u64()) else { continue };
            if !projects::copied_by_default(path, len) {
                continue;
            }
            match self.call("projects.readFile", json!({ "cwd": project.path, "relativePath": path })).await {
                Ok(read) if read["truncated"] == true => failed.push(format!("{path}: too large to copy")),
                Ok(read) => files.push((path.to_owned(), read["contents"].as_str().unwrap_or_default().to_owned())),
                Err(e) => failed.push(format!("{path}: {e:#}")),
            }
        }
        Ok((files, failed))
    }

    async fn call(&self, tag: &str, payload: Value) -> Result<Value> {
        self.authorized(|origin, token| {
            let payload = payload.clone();
            async move {
                upstream::call(&origin, &token, tag, payload).await.map_err(|e| {
                    let rejected = e.chain().any(|c| {
                        matches!(c.downcast_ref(), Some(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 401)
                    });
                    if rejected { Unauthorized.into() } else { e }
                })
            }
        })
        .await
    }

    /// Runs `f` against the running desktop server with Sail Boat's session, issuing a new one
    /// when there is none or the server no longer knows it (the user revoked it).
    async fn authorized<T, F: Future<Output = Result<T>>>(&self, f: impl Fn(String, String) -> F) -> Result<T> {
        let origin = local_origin()?;
        let token = self.session(None).await?;
        match f(origin.clone(), token.clone()).await {
            Err(e) if e.is::<Unauthorized>() => f(origin, self.session(Some(&token)).await?).await,
            result => result,
        }
    }

    /// The saved session, or a newly issued one when there is none or it is `rejected`.
    async fn session(&self, rejected: Option<&str>) -> Result<String> {
        let mut saved = self.token.lock().await;
        if let Some(token) = saved.as_deref().filter(|t| Some(*t) != rejected) {
            return Ok(token.to_owned());
        }
        let mut cmd = command(&self.cli);
        cmd.args(["auth", "session", "issue", "--token-only", "--ttl", "3650d", "--label", "sail-boat"]);
        for scope in LOCAL_SCOPES {
            cmd.args(["--scope", scope]);
        }
        let out = cmd.output().await.context("running t3 auth session issue")?;
        if !out.status.success() {
            bail!("Sail refused Sail Boat a session: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        let token = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if let Some(path) = &self.token_file {
            crate::store::write_private(path, token.as_bytes())?;
        }
        *saved = Some(token.clone());
        Ok(token)
    }

}

/// The desktop server turned the session down.
#[derive(Debug)]
struct Unauthorized;

impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sail did not accept Sail Boat's session")
    }
}

impl std::error::Error for Unauthorized {}

/// Where the desktop app's server answers: `SAIL_DESKTOP_ORIGIN` if set, else from the runtime
/// file it writes on start (`userdata/server-runtime.json` or `dev/server-runtime.json`).
fn local_origin() -> Result<String> {
    if let Some(origin) = non_empty_env("SAIL_DESKTOP_ORIGIN") {
        return Ok(origin.trim_end_matches('/').to_owned());
    }
    for home in candidate_homes()? {
        for sub in ["userdata", "dev"] {
            let runtime = home.join(sub).join("server-runtime.json");
            let Ok(bytes) = std::fs::read(&runtime) else { continue };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if let Some(origin) = value["origin"].as_str().map(str::trim).filter(|o| !o.is_empty()) {
                return Ok(origin.trim_end_matches('/').to_owned());
            }
        }
    }
    Err(anyhow!("Sail is not running"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the running desktop app, with Sail Boat's own session file:
    /// `cargo test reads_the_desktop_projects -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn reads_the_desktop_projects() {
        let dir = data_dir().unwrap();
        let t3 = T3Desktop::locate().unwrap().with_token_file(dir.join("t3-token"));
        let projects = t3.projects().await.unwrap();
        assert!(!projects.is_empty());
        for p in projects.iter().take(5) {
            println!("{} {} {} {:?}", p.title, p.repo_key, p.path, p.subdirectory);
        }
        let (files, failed) = t3.files_to_copy(&projects[0]).await.unwrap();
        println!("{}: copies {:?}, failed {failed:?}", projects[0].title, files.iter().map(|f| &f.0).collect::<Vec<_>>());
    }
}

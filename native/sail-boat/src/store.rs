//! Persistent app state: machines, settings and this month's spend, one JSON file in the app
//! data dir.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// Never changes: the id of the sandbox the machine was created on.
    pub id: String,
    /// Boat sandbox it runs on now, e.g. `bx_sad32u26`: another one after a restore.
    pub sandbox_id: String,
    pub name: String,
    pub size: String,
    /// Public HTTPS URL of the T3 server on the sandbox.
    pub upstream_url: String,
    /// Bearer token the proxy uses upstream. Never leaves this computer except to that server.
    pub upstream_token: String,
    /// Public HTTPS URL of the watchdog on the sandbox.
    pub watchdog_url: String,
    pub watchdog_secret: String,
    /// Loopback port the proxy serves this machine on. Stable, Sail stores it.
    pub local_port: u16,
    /// T3 server version installed on the machine.
    pub t3_version: String,
    /// Provisioning revision, prefixed with `watchdog:` if the running server was left alone.
    pub provision_revision: String,
    #[serde(default)]
    pub lifecycle_enrolled: bool,
    /// Boat confirmed resume for this sandbox. The watchdog still owns its stop journal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_resume: Option<String>,
    pub environment_id: String,
    /// Bearer tokens the proxy issued to Sail when it paired.
    pub client_tokens: Vec<String>,
    /// Bearer tokens the machine's server issued to T3 servers that linked to it through the
    /// proxy. The proxy only recognizes them: a call bearing one may wake the machine.
    pub link_tokens: Vec<LinkToken>,
    pub created_at: i64,
    /// When T3 on the machine next starts work on its own (an automation, a held webhook run, an
    /// agent resuming after a usage limit), as its watchdog last said: ms since epoch.
    #[serde(default)]
    pub next_due_at: Option<i64>,
    /// T3 Connect is on there: other devices reach it with the user's account.
    #[serde(default)]
    pub connect: bool,
    /// The stop its saved snapshot holds, as this app saved it from the stopped sandbox.
    #[serde(default)]
    pub saved_stop: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkToken {
    pub token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub start_at_login: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { start_at_login: true }
    }
}

/// One sandbox's spend as last looked up. Kept after the sandbox is gone (its machine deleted, or
/// a restore replaced it) so the totals still count it until its month is over.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    /// Id of the machine that ran on the sandbox.
    pub machine: String,
    /// Start of the local day of the lookup, unix seconds.
    pub day: i64,
    /// Dollars since `day`.
    pub today: f64,
    pub awake_secs_today: u64,
    /// Dollars since the start of `day`'s month.
    pub month: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub machines: Vec<Machine>,
    pub settings: Settings,
    /// By sandbox id.
    pub spend: HashMap<String, Spend>,
    /// Local ports of deleted machines, never given out again: Sail may still list one (it
    /// cannot be told to forget a backend), and would reach a new machine there as the old.
    pub retired_ports: Vec<u16>,
    /// What to delete on Boat until Boat confirms each gone.
    pub doomed: Vec<Doomed>,
    /// Older state files' sandboxes of creates still running, loaded into `doomed`. Never written:
    /// those go to `doomed` now, with their snapshot.
    #[serde(skip_serializing)]
    pub pending_sandboxes: Vec<String>,
}

/// A deleted machine's sandbox and saved snapshot, or those of a create that failed or never
/// finished: its watchdog runs, and can save the snapshot, before the create is done. The
/// snapshot waits for its sandbox: a live one's watchdog can save it again.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Doomed {
    pub sandbox: Option<String>,
    pub snapshot: Option<String>,
}

pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("state.json"),
        }
    }

    pub fn load(&self) -> Result<State> {
        match std::fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// The file holds bearer tokens.
    pub fn save(&self, state: &State) -> Result<()> {
        write_private(&self.path, &serde_json::to_vec_pretty(state)?)
    }
}

/// Atomic write of a file only its owner can read, never readable by others even briefly.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(path.parent().expect("path has a parent"))?;
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(&tmp)?.write_all(bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Removes everything in `dir` but `keep`, whatever an interrupted write left behind included.
pub fn sweep(dir: &Path, keep: &HashSet<PathBuf>) {
    let entries = std::fs::read_dir(dir).into_iter().flatten().flatten();
    for path in entries.map(|e| e.path()).filter(|p| !keep.contains(p)) {
        let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
    }
}

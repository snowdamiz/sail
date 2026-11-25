//! Creating and upgrading machines: everything that runs on the sandbox goes through
//! `provision.sh`, which is idempotent.

use crate::boat::Boat;
use crate::proxy::auth::random_token;
use crate::store::Machine;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::Deserialize;

const PROVISION_SH: &str = include_str!("provision.sh");
const WATCHDOG_MJS: &str = include_str!("watchdog.mjs");
const DEFAULT_CLI_INSTALL_URL: &str = "https://t3.codes/install.sh";
const T3_PORT: u16 = 3773;
const WATCHDOG_PORT: u16 = 3774;

/// Identifies the provisioning scripts; a machine provisioned with others gets them on wake, or
/// in place while it runs.
pub fn revision() -> String {
    let hash = fnv1a(PROVISION_SH.bytes().chain(WATCHDOG_MJS.bytes()).chain(SLEEP_AFTER_SECS.to_string().bytes()));
    format!("{hash:016x}")
}

/// FNV-1a: stable across builds, unlike std's hasher.
pub fn fnv1a(bytes: impl IntoIterator<Item = u8>) -> u64 {
    bytes.into_iter().fold(0xcbf29ce484222325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provisioned {
    pub environment_id: String,
    pub upstream_token: Option<String>,
}

/// Machine sizes, as Boat sells them.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeInfo {
    pub id: &'static str,
    pub spec: &'static str,
    pub hourly: f64,
}

pub const SIZES: &[SizeInfo] = &[
    SizeInfo { id: "small", spec: "2 vCPU · 4 GB", hourly: 0.018 },
    SizeInfo { id: "default", spec: "4 vCPU · 8 GB", hourly: 0.036 },
    SizeInfo { id: "large", spec: "8 vCPU · 16 GB", hourly: 0.072 },
];

pub fn size(id: &str) -> Result<&'static SizeInfo> {
    SIZES.iter().find(|s| s.id == id).ok_or_else(|| anyhow!("unknown size {id}"))
}

/// How long a machine stays up after the last agent turn and the last action through Sail Boat.
/// Long enough to read a result and type a follow-up without waiting for a wake; a wake soon
/// after is quick, as Boat usually keeps the stopped VM about 10 minutes.
pub const SLEEP_AFTER_SECS: u64 = 180;

/// The machine's sandbox, as Boat lists it.
pub fn sandbox_name(name: &str) -> String {
    format!("sail · {name}")
}

/// The saved snapshot replaced at every sleep. Boat deletes a stopped sandbox's
/// disk after 14 days; this stays, so the machine can be restored from it. Unique per machine,
/// whoever else uses the Boat account. Boat takes lowercase letters, digits and dashes.
pub fn snapshot_name(name: &str, machine_id: &str) -> String {
    let id: String = machine_id.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    format!("sail-{name}-{id}")
}

fn cli_install_url() -> Result<String> {
    let raw = std::env::var("SAIL_CLI_INSTALL_URL")
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_CLI_INSTALL_URL.to_owned());
    let parsed = url::Url::parse(&raw).context("parsing SAIL_CLI_INSTALL_URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("SAIL_CLI_INSTALL_URL must use http or https");
    }
    Ok(parsed.to_string())
}

/// Copies the scripts over as a file (the watchdog secret must not appear in any command line)
/// and runs `provision.sh`. No T3 version: T3 is left as it runs, neither installed nor restarted.
pub async fn run(
    boat: &Boat,
    sandbox_id: &str,
    name: &str,
    t3_version: Option<&str>,
    watchdog_secret: &str,
    snapshot: &str,
    mint_upstream_token: bool,
) -> Result<Provisioned> {
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
    let install_url = cli_install_url()?;
    let script = format!(
        "set -e; d=$(mktemp -d); trap 'rm -rf \"$d\" \"$0\"' EXIT\n\
         echo {p} | base64 -d > \"$d/provision.sh\"; echo {w} | base64 -d > \"$d/watchdog.mjs\"\n\
         install_url=$(echo {u} | base64 -d)\n\
         SAIL_BOAT_SECRET={s} SAIL_CLI_INSTALL_URL=\"$install_url\" bash \"$d/provision.sh\" {v} {sleep} {snapshot} {mint} {name} {sandbox}\n",
        p = b64(PROVISION_SH),
        w = b64(WATCHDOG_MJS),
        u = b64(&install_url),
        v = shell_word(t3_version.unwrap_or("-"))?,
        s = shell_word(watchdog_secret)?,
        sleep = SLEEP_AFTER_SECS,
        snapshot = shell_word(snapshot)?,
        mint = u8::from(mint_upstream_token),
        name = shell_word(name)?,
        sandbox = shell_word(sandbox_id)?,
    );
    let file_name = format!("sail-boat-provision-{}.sh", random_token());
    let local = std::env::temp_dir().join(&file_name);
    crate::store::write_private(&local, script.as_bytes())?;
    let remote = format!("/tmp/{file_name}");
    let uploaded = boat.upload(sandbox_id, &local, &remote).await;
    let _ = std::fs::remove_file(&local);
    uploaded?;
    let out = boat.exec_ok(sandbox_id, &format!("bash {remote}"), 600).await?;
    let line = out
        .lines()
        .rev()
        .find(|l| l.starts_with('{'))
        .ok_or_else(|| anyhow!("provisioning printed no result"))?;
    Ok(serde_json::from_str(line)?)
}

/// Only `[A-Za-z0-9._-]` reaches the remote shell.
fn shell_word(s: &str) -> Result<&str> {
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        bail!("unsafe value for the remote shell: {s}");
    }
    Ok(s)
}

/// Hosts the T3 server's and the watchdog's ports publicly: their URLs, in that order.
/// Idempotent: hosting again keeps the URLs.
pub async fn host(boat: &Boat, sandbox_id: &str) -> Result<(String, String)> {
    tokio::try_join!(boat.host_public(sandbox_id, T3_PORT), boat.host_public(sandbox_id, WATCHDOG_PORT))
}

/// Creates a new machine end to end. Takes about a minute, most of it Boat and the T3 install.
/// On failure after `created`, the caller deletes the sandbox.
pub async fn create(
    boat: &Boat,
    name: &str,
    size: &str,
    t3_version: &str,
    local_port: u16,
    created: impl FnOnce(&str),
    progress: impl Fn(&str),
) -> Result<Machine> {
    self::size(size)?;
    progress("Creating sandbox on Boat");
    let id = boat
        .create(&sandbox_name(name), size, None)
        .await
        .context("creating the Boat sandbox")?;
    created(&id);
    progress("Installing Sail server");
    let secret = random_token();
    let provisioned = run(boat, &id, name, Some(t3_version), &secret, &snapshot_name(name, &id), true).await?;
    progress("Opening the machine's address");
    let (upstream_url, watchdog_url) = host(boat, &id).await?;
    Ok(Machine {
        id: id.clone(),
        sandbox_id: id,
        name: name.to_owned(),
        size: size.to_owned(),
        upstream_url,
        upstream_token: provisioned
            .upstream_token
            .ok_or_else(|| anyhow!("provisioning issued no token"))?,
        watchdog_url,
        watchdog_secret: secret,
        local_port,
        t3_version: t3_version.to_owned(),
        provision_revision: revision(),
        environment_id: provisioned.environment_id,
        client_tokens: Vec::new(),
        link_tokens: Vec::new(),
        created_at: chrono::Utc::now().timestamp(),
        next_due_at: None,
        connect: false,
        saved_stop: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_and_snapshot_names_use_sail_branding() {
        assert_eq!(sandbox_name("devbox"), "sail · devbox");
        assert_eq!(snapshot_name("devbox", "BX_123"), "sail-devbox-bx-123");
    }
}

//! Provisioning fresh sandboxes and refreshing existing watchdogs.

use crate::boat::Boat;
use crate::proxy::auth::random_token;
use crate::store::Machine;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::Deserialize;
use std::sync::OnceLock;

const PROVISION_SH: &str = include_str!("provision.sh");
const WATCHDOG_MJS: &str = include_str!("watchdog.mjs");
const CLI_RELEASE_DOWNLOAD_URL: &str = "https://github.com/snowdamiz/sail/releases/download";
const T3_PORT: u16 = 3773;
const WATCHDOG_PORT: u16 = 3774;

/// Identifies the provisioning scripts used for creation or an in-place watchdog refresh.
pub fn revision() -> &'static str {
    static REVISION: OnceLock<String> = OnceLock::new();
    REVISION.get_or_init(|| {
        let hash = fnv1a(PROVISION_SH.bytes().chain(WATCHDOG_MJS.bytes()).chain(SLEEP_AFTER_SECS.to_string().bytes()));
        format!("{hash:016x}")
    })
}

/// FNV-1a: stable across builds, unlike std's hasher.
pub fn fnv1a(bytes: impl IntoIterator<Item = u8>) -> u64 {
    bytes.into_iter().fold(0xcbf29ce484222325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provisioned {
    environment_id: String,
    upstream_token: String,
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

fn cli_install_url(version: &str, override_url: Option<&str>) -> Result<String> {
    let Some(raw) = override_url.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(format!("{CLI_RELEASE_DOWNLOAD_URL}/v{version}/install.sh"));
    };
    let parsed = url::Url::parse(raw).context("parsing SAIL_CLI_INSTALL_URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("SAIL_CLI_INSTALL_URL must use http or https");
    }
    Ok(parsed.to_string())
}

pub(super) async fn refresh_watchdog(boat: &Boat, record: &Machine) -> Result<()> {
    run(
        boat,
        &record.sandbox_id,
        &record.name,
        None,
        &record.watchdog_secret,
        &snapshot_name(&record.name, &record.id),
    )
    .await?;
    Ok(())
}

/// Copies the scripts over as a file so the watchdog secret stays out of command lines.
/// Only creation passes a version.
async fn run(
    boat: &Boat,
    sandbox_id: &str,
    name: &str,
    t3_version: Option<&str>,
    watchdog_secret: &str,
    snapshot: &str,
) -> Result<String> {
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
    let version = shell_word(t3_version.unwrap_or("-"))?;
    let install_url = if t3_version.is_some() {
        cli_install_url(version, std::env::var("SAIL_CLI_INSTALL_URL").ok().as_deref())?
    } else {
        String::new()
    };
    let script = format!(
        "set -e; d=$(mktemp -d); trap 'rm -rf \"$d\" \"$0\"' EXIT\n\
         echo {p} | base64 -d > \"$d/provision.sh\"; echo {w} | base64 -d > \"$d/watchdog.mjs\"\n\
         install_url=$(echo {u} | base64 -d)\n\
         SAIL_BOAT_SECRET={s} SAIL_CLI_INSTALL_URL=\"$install_url\" bash \"$d/provision.sh\" {v} {sleep} {snapshot} {name} {sandbox}\n",
        p = b64(PROVISION_SH),
        w = b64(WATCHDOG_MJS),
        u = b64(&install_url),
        v = version,
        s = shell_word(watchdog_secret)?,
        sleep = SLEEP_AFTER_SECS,
        snapshot = shell_word(snapshot)?,
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
    boat.exec_ok(sandbox_id, &format!("bash {remote}"), 600).await
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
    let out = run(boat, &id, name, Some(t3_version), &secret, &snapshot_name(name, &id)).await?;
    let line = out.lines().rev().find(|l| l.starts_with('{')).ok_or_else(|| anyhow!("provisioning printed no result"))?;
    let provisioned: Provisioned = serde_json::from_str(line)?;
    if provisioned.upstream_token.is_empty() {
        bail!("provisioning issued no token");
    }
    progress("Opening the machine's address");
    let (upstream_url, watchdog_url) = host(boat, &id).await?;
    Ok(Machine {
        id: id.clone(),
        sandbox_id: id,
        name: name.to_owned(),
        size: size.to_owned(),
        upstream_url,
        upstream_token: provisioned.upstream_token,
        watchdog_url,
        watchdog_secret: secret,
        local_port,
        t3_version: t3_version.to_owned(),
        provision_revision: revision().to_owned(),
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
    fn provision_defaults_to_the_sail_release_installer() {
        assert_eq!(
            cli_install_url("1.2.3-preview.1.2", None).unwrap(),
            "https://github.com/snowdamiz/sail/releases/download/v1.2.3-preview.1.2/install.sh",
        );
        assert_eq!(
            cli_install_url("1.2.3", Some(" http://127.0.0.1:8080/install.sh ")).unwrap(),
            "http://127.0.0.1:8080/install.sh",
        );
    }

    #[cfg(unix)]
    #[test]
    fn provision_reinstalls_a_matching_cli_without_the_sail_marker() {
        use std::{fs, os::unix::fs::PermissionsExt, process::Command};

        let home = std::env::temp_dir().join(format!("sail-provision-{}", random_token()));
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let write_executable = |name, contents| {
            let path = bin.join(name);
            fs::write(&path, contents).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        };
        write_executable("t3", "#!/bin/sh\nprintf 't3 v1.2.3\\n'\n");
        write_executable("curl", "#!/bin/sh\necho \"fixture installer unavailable: $6\" >&2\nexit 22\n");

        write_executable("sudo", "#!/bin/sh\nexit 99\n");
        write_executable("systemctl", "#!/bin/sh\nexit 99\n");

        let inherited_path = std::env::var_os("PATH").unwrap_or_default();
        let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(&inherited_path))).unwrap();
        let output = Command::new("bash")
            .current_dir(&home)
            .args(["-c", PROVISION_SH, "provision.sh", "1.2.3", "180", "snapshot", "dev", "sandbox"])
            .env("HOME", &home)
            .env("PATH", path)
            .env("SAIL_BOAT_SECRET", "fixture")
            .env("SAIL_CLI_INSTALL_URL", "http://127.0.0.1:8080/install.sh")
            .output();
        fs::remove_dir_all(home).unwrap();

        let output = output.unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success());
        assert!(stderr.contains("Sail server install failed"), "{stderr}");
        assert!(stderr.contains("fixture installer unavailable: http://127.0.0.1:8080/install.sh"), "{stderr}");
    }

    #[cfg(unix)]
    #[test]
    fn provision_activates_fresh_service_once_and_refreshes_only_watchdog_state() {
        use std::{fs, os::unix::fs::PermissionsExt, process::Command};

        let home = std::env::temp_dir().join(format!("sail-provision-{}", random_token()));
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(home.join("watchdog.mjs"), WATCHDOG_MJS).unwrap();
        fs::write(home.join("provision.sh"), PROVISION_SH).unwrap();
        let write_executable = |name, contents| {
            let file = bin.join(name);
            fs::write(&file, contents).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
        };
        write_executable("curl", r#"#!/bin/sh
case "$1" in
  -fsSL)
    cat > "$5" <<'INSTALL'
set -eu
test "$SAIL_HOME" = "$HOME/.t3"
test "$T3CODE_HOME" = "$SAIL_HOME"
runtime="$T3CODE_HOME/runtime/versions/$T3CODE_VERSION"
mkdir -p "$runtime"
echo sail > "$runtime/.sail-product"
echo installed >> "$HOME/calls"
INSTALL
    ;;
  -sf)
    grep -qx activated "$HOME/calls" || exit 1
    echo '{"environmentId":"fixture"}'
    ;;
  *) exit 1 ;;
esac
"#);
        write_executable("timeout", "#!/bin/sh\nshift 3\nexec \"$@\"\n");
        write_executable("t3", r#"#!/bin/sh
set -eu
test "$SAIL_HOME" = "$HOME/.t3"
test "$T3CODE_HOME" = "$SAIL_HOME"
case "$*" in
  --version) echo 't3 v1.2.3' ;;
  "service install --base-dir $HOME/.t3 --allow-downgrade") echo activated >> "$HOME/calls" ;;
  *sail-watchdog*) echo watchdog-fixture ;;
  *sail-boat*) echo proxy-fixture ;;
  *) exit 1 ;;
esac
"#);
        write_executable("sudo", "#!/bin/sh\ncat >/dev/null\n");
        write_executable("systemctl", "#!/bin/sh\necho \"$*\" >> \"$HOME/calls\"\n");
        let inherited_path = std::env::var_os("PATH").unwrap_or_default();
        let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(&inherited_path))).unwrap();
        let run = |version, sandbox| {
            let output = Command::new("bash")
                .current_dir(&home)
                .args(["provision.sh", version, "180", "snapshot", "dev", sandbox])
                .env("HOME", &home)
                .env("PATH", &path)
                .env("SAIL_BOAT_SECRET", "fixture")
                .env("SAIL_CLI_INSTALL_URL", "http://127.0.0.1:8080/install.sh")
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            output
        };

        let output = run("1.2.3", "fresh");
        let receipt: Provisioned = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt.environment_id, "fixture");
        assert_eq!(receipt.upstream_token, "proxy-fixture");
        let calls = fs::read_to_string(home.join("calls")).unwrap();
        assert_eq!(calls.lines().filter(|line| *line == "activated").count(), 1);
        assert!(calls.contains("installed"));
        assert!(!calls.contains("t3code.service"), "{calls}");

        let settings = home.join(".t3/userdata/settings.json");
        let initial: serde_json::Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        assert_eq!(initial["linkedEnvironmentsEnabled"], true);
        let live_settings = b"{\"linkedEnvironmentsEnabled\":false, \"example\":1}\n";
        fs::write(&settings, live_settings).unwrap();
        fs::write(home.join("calls"), "").unwrap();
        run("-", "restored");
        assert_eq!(fs::read(&settings).unwrap(), live_settings);
        let calls = fs::read_to_string(home.join("calls")).unwrap();
        assert!(calls.contains("restart sail-watchdog.service"));
        assert!(calls.lines().all(|line| line.contains("watchdog.service") || line == "--user daemon-reload"), "{calls}");
        let config: serde_json::Value = serde_json::from_slice(&fs::read(home.join(".sail-boat/config.json")).unwrap()).unwrap();
        assert_eq!(config["t3Token"], "watchdog-fixture");
        assert_eq!(config["sandbox"], "restored");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn provision_recognizes_a_current_watchdog() {
        use super::super::watchdog_is_current;

        assert!(watchdog_is_current("watchdog:current", "current"));
        assert!(watchdog_is_current("current", "current"));
        assert!(!watchdog_is_current("old", "current"));
    }

    #[test]
    fn sandbox_and_snapshot_names_use_sail_branding() {
        assert_eq!(sandbox_name("devbox"), "sail · devbox");
        assert_eq!(snapshot_name("devbox", "BX_123"), "sail-devbox-bx-123");
    }
}

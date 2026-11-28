use std::{collections::BTreeMap, fs, io::Write, path::Path};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    Evidence, Fingerprint, HomeMode, Seed, is_hex, one_artifact, process_terminal, read_json,
};
use crate::catalog::{Inventory, Observation, OciServer, Run};

const ENTRYPOINT: [&str; 3] = ["/usr/bin/tini", "--", "/usr/local/bin/sail-entrypoint"];
const SEED: &str = include_str!("../../../incumbent/runtime/cli-lifecycle-seed.json");
const WIRE: &[u8] = include_bytes!("../../../wire/incumbent-v2.json");
const WITNESSES: &str = include_str!("../../../incumbent/runtime/oci-lifecycle-witnesses.json");

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Image {
    arch: String,
    os: String,
    os_version: String,
    execution: String,
    entrypoint: Vec<String>,
    tag: String,
    source_sha: String,
    repository: String,
    index_digest: String,
    manifest_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Process {
    schema_version: u64,
    boot_id: String,
    home_mode: HomeMode,
    image: Image,
    version: String,
    start: Start,
    pair: Value,
    stop: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    runtime_owner_sha256: String,
    started_at: String,
    command: Vec<String>,
    uid: u64,
    parent_pid: u64,
    working_directory: String,
    server_home: String,
    host_port_binding: String,
    startup_pairing_url_printed: bool,
    descriptor: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    schema_version: u64,
    boot_id: String,
    runtime_owner_sha256: String,
    database: String,
    #[serde(flatten)]
    home: SavedHome,
}

#[derive(Deserialize)]
#[serde(
    tag = "homeMode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum SavedHome {
    Fresh {
        database_absent_before_start: bool,
        wire: Value,
    },
    Copied {
        seed_database_sha256: String,
        before_start: Fingerprint,
        thread_read: Value,
        after_stop: Fingerprint,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Witness {
    process_sha256: String,
    state_sha256: String,
}

pub(crate) fn oci_manifest<'a>(server: &'a OciServer, arch: &str) -> Result<&'a str> {
    let mut manifests = server.manifests.iter().filter(|manifest| {
        manifest.platform.os == "linux" && manifest.platform.architecture == arch
    });
    let manifest = manifests
        .next()
        .context("missing published OCI platform manifest")?;
    ensure!(
        manifests.next().is_none(),
        "duplicate published OCI platform manifest"
    );
    ensure!(
        manifest
            .digest
            .strip_prefix("sha256:")
            .is_some_and(|sha| is_hex(sha, 64)),
        "invalid OCI manifest digest"
    );
    Ok(&manifest.digest)
}

fn verify_image(process: &Process, inventory: &Inventory, arch: &str, run: &Run) -> Result<()> {
    let image = &process.image;
    let server = &inventory.oci_server;
    ensure!(
        image.os == "linux"
            && image.arch == arch
            && run.environment.arch.as_deref() == Some(arch)
            && run.environment.os_version.as_deref() == Some(&image.os_version)
            && run.environment.origin.as_deref() == Some("OCI loopback")
            && run.environment.connection_mode.as_deref() == Some("loopback")
            && run.environment.client_version.as_deref() == image.tag.strip_prefix('v')
            && matches!(image.execution.as_str(), "native" | "emulated")
            && image.entrypoint == ENTRYPOINT
            && image.tag == inventory.github_release.tag_name
            && image.source_sha == inventory.incumbent_source_sha
            && image.repository == server.repository
            && image.index_digest == server.index_digest
            && image.manifest_digest == oci_manifest(server, arch)?
            && run.environment.installer_asset_digest.as_deref()
                == image.manifest_digest.strip_prefix("sha256:"),
        "OCI process does not identify the published platform image"
    );
    Ok(())
}

fn verify_runtime(process: &Process) -> Result<()> {
    let version = process.image.tag.trim_start_matches('v');
    let start = &process.start;
    let normalized_args = [
        "/usr/local/bin/node",
        "/opt/sail/server/bin.mjs",
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        "8080",
    ];
    let mut command = start.command.clone();
    if process.image.execution == "emulated"
        && command
            .get(1..4)
            .is_some_and(|args| args == ["--no-opt", "-r", "/proc/.reset"])
    {
        command.drain(1..4);
    }
    let server_arch = if process.image.arch == "amd64" {
        "x64"
    } else {
        "arm64"
    };
    ensure!(
        process.version == format!("t3 {}", process.image.tag)
            && command == normalized_args
            && start.uid == 1000
            && start.parent_pid == 1
            && start.working_directory == "/data/home"
            && start.server_home == "/data/sail"
            && start.host_port_binding == "127.0.0.1"
            && !start.startup_pairing_url_printed
            && is_hex(&start.runtime_owner_sha256, 64)
            && !start.started_at.is_empty()
            && start.descriptor["serverVersion"] == version
            && start.descriptor["platform"] == json!({"os": "linux", "arch": server_arch})
            && start.descriptor["orchestrationProtocolVersion"] == 2
            && start.descriptor["databaseMigration"] == 118
            && start.descriptor["capabilities"]["serverBrowser"] == true,
        "OCI default entrypoint or runtime contract disagrees with the released image"
    );
    ensure!(
        process.pair
            == json!({
                "path": "/api/auth/browser-session", "status": 200,
                "sessionMethod": "browser-session-cookie", "cookieCheck": {
                    "path": "/api/auth/session", "anonymousAuthenticated": false, "authenticated": true,
                    "status": 200, "scopes": ["orchestration:read"], "permissions": ["orchestration:read"]
                }, "reuseStatus": 401
            }),
        "OCI pairing did not prove one-time read-only cookie access"
    );
    ensure!(
        process.stop
            == json!({
                "command": ["docker", "stop"], "exitCode": 130, "listenerClosed": true,
                "runtimeRecordRemoved": true
            }),
        "OCI shutdown did not prove listener and runtime record cleanup"
    );
    Ok(())
}

fn verify_state(process: &Process, state: &State, observation: &Observation) -> Result<()> {
    ensure!(
        state.schema_version == 1
            && state.boot_id == process.boot_id
            && state.runtime_owner_sha256 == process.start.runtime_owner_sha256
            && state.database == "sail/userdata/statev2.sqlite",
        "OCI database does not belong to the observed container boot"
    );
    match (&state.home, process.home_mode) {
        (
            SavedHome::Fresh {
                database_absent_before_start,
                wire,
            },
            HomeMode::Fresh,
        ) => {
            ensure!(
                *database_absent_before_start
                    && observation.cell.case_id == "cli-open"
                    && *wire
                        == json!({
                            "result": "pass", "fixtureSha256": format!("{:x}", Sha256::digest(WIRE))
                        }),
                "OCI fresh home lacks the frozen v2 wire check"
            );
        }
        (
            SavedHome::Copied {
                seed_database_sha256,
                before_start,
                thread_read,
                after_stop,
            },
            HomeMode::Copied,
        ) => {
            let seed: Seed = serde_json::from_str(SEED)?;
            ensure!(
                seed_database_sha256 == &seed.seed_database_sha256
                    && before_start == &seed.fingerprint
                    && after_stop == &seed.fingerprint
                    && *thread_read
                        == json!({
                            "title": seed.thread_title, "roles": seed.roles,
                            "runCount": 1, "messagesMatchSeed": true
                        }),
                "OCI copied home did not preserve and reopen the pinned Replay seed"
            );
        }
        _ => anyhow::bail!("OCI state belongs to a different home mode"),
    }
    Ok(())
}

fn encode(process: &Process, state: &State, process_sha: &str, state_sha: &str) -> Result<Vec<u8>> {
    let image = &process.image;
    let mut rows = vec![
        "Sail published OCI lifecycle".to_owned(),
        format!(
            "{} / {} ({}) / {} home",
            image.os_version,
            image.arch,
            image.execution,
            process.home_mode.label()
        ),
        format!(
            "Container witness {}",
            process.boot_id.get(..16).context("missing boot ID")?
        ),
        format!("$ t3 --version  {}", process.version),
        format!(
            "Ready on loopback. Protocol {}, migration {}.",
            process.start.descriptor["orchestrationProtocolVersion"],
            process.start.descriptor["databaseMigration"]
        ),
        format!(
            "Read-only cookie: issue {}, reuse {}.",
            process.pair["status"], process.pair["reuseStatus"]
        ),
    ];
    rows.push(match &state.home {
        SavedHome::Fresh { wire, .. } => format!(
            "Frozen v2 wire check: {}.",
            wire["result"].as_str().context("missing wire result")?
        ),
        SavedHome::Copied { thread_read, .. } => format!(
            "Reopened {}. Payloads preserved.",
            thread_read["title"]
                .as_str()
                .context("missing thread read")?
        ),
    });
    rows.push(format!(
        "$ docker stop  exit {}. Listener and record gone.",
        process.stop["exitCode"]
    ));
    process_terminal::encode(
        &rows,
        &[
            ("SailBoot", &process.boot_id),
            ("SailTranscriptSha256", process_sha),
            ("SailStateSha256", state_sha),
        ],
    )
}

pub(crate) fn render_oci_terminal(directory: &Path) -> Result<()> {
    let transcript = fs::read(directory.join("process.json"))?;
    let state_bytes = fs::read(directory.join("state.json"))?;
    let process: Process = serde_json::from_slice(&transcript)?;
    let state: State = serde_json::from_slice(&state_bytes)?;
    ensure!(
        state.boot_id == process.boot_id,
        "OCI process and state belong to different boots"
    );
    let bytes = encode(
        &process,
        &state,
        &format!("{:x}", Sha256::digest(transcript)),
        &format!("{:x}", Sha256::digest(state_bytes)),
    )?;
    fs::File::create_new(directory.join("terminal.png"))?.write_all(&bytes)?;
    Ok(())
}

pub(crate) fn verify_oci_lifecycle(
    evidence: &Evidence,
    inventory: &Inventory,
    arch: &str,
    observation: &Observation,
) -> Result<()> {
    let [first, repeat] = observation.runs.as_slice() else {
        anyhow::bail!("expected two independently captured OCI boots");
    };
    ensure!(
        first.role == "incumbent-first"
            && repeat.role == "incumbent-repeat"
            && first.environment == repeat.environment,
        "expected matching first and repeat OCI environments"
    );
    let witnesses: BTreeMap<String, Witness> = serde_json::from_str(WITNESSES)?;
    let verify = |run: &Run| -> Result<Process> {
        let transcript = one_artifact(&run.artifacts, "process-transcript")?;
        let state = one_artifact(&run.artifacts, "state-receipt")?;
        let screenshot = one_artifact(&run.artifacts, "terminal-screenshot")?;
        let process: Process = read_json(&evidence.resolve(&transcript.path)?)?;
        let saved: State = read_json(&evidence.resolve(&state.path)?)?;
        let config = format!(
            "oci-{}-{}-{}-{}",
            process.image.os_version.to_lowercase().replace(' ', "-"),
            arch,
            process.image.execution,
            process.home_mode.label()
        );
        ensure!(
            process.schema_version == 1
                && run.fixture_id == "oci-lifecycle"
                && run.server_implementation == "Node"
                && observation.configuration_id == config,
            "OCI process belongs to a different fixture or configuration"
        );
        verify_image(&process, inventory, arch, run)?;
        verify_runtime(&process)?;
        verify_state(&process, &saved, observation)?;
        let witness = witnesses
            .get(&process.boot_id)
            .context("missing observed OCI boot witness")?;
        ensure!(
            witness.process_sha256 == transcript.sha256 && witness.state_sha256 == state.sha256,
            "OCI receipt bytes disagree with the observed container witness"
        );
        ensure!(
            fs::read(evidence.resolve(&screenshot.path)?)?
                == encode(&process, &saved, &transcript.sha256, &state.sha256)?,
            "terminal PNG does not match the encoded OCI receipts"
        );
        Ok(process)
    };
    let a = verify(first)?;
    let b = verify(repeat)?;
    ensure!(
        a.boot_id != b.boot_id
            && a.start.runtime_owner_sha256 != b.start.runtime_owner_sha256
            && a.start.started_at != b.start.started_at
            && a.image == b.image
            && a.home_mode == b.home_mode
            && a.start.descriptor == b.start.descriptor,
        "expected two distinct OCI boots with the same runtime contract"
    );
    Ok(())
}

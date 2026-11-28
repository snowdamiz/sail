use std::{fs, io::Cursor, path::Path};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Evidence, is_hex, one_artifact, read_json};
use crate::catalog::{Inventory, Observation, Platform, Run};

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum HomeMode {
    Fresh,
    Copied,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Boot {
    schema_version: u64,
    boot_id: String,
    fixture_id: String,
    home_mode: HomeMode,
    package: Package,
    platform: Host,
    version: Value,
    start: Start,
    pair: Value,
    stop: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    target: String,
    tag: String,
    source_sha: String,
    archive: String,
    archive_sha256: String,
    archive_bytes: u64,
    installed_entries: usize,
    runtime_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Host {
    os: String,
    arch: String,
    os_version: String,
    execution: String,
    origin: String,
    connection_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    command: Vec<String>,
    readiness: String,
    startup_pairing_url_printed: bool,
    runtime_record: String,
    runtime_record_version: u64,
    runtime_matches_owned_child: bool,
    runtime_executable: Value,
    environment_matches_selected_home: bool,
    competing_runtime_record_present: bool,
    descriptor_status: u16,
    descriptor: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedState {
    boot_id: String,
    fixture_id: String,
    database: String,
    #[serde(flatten)]
    home: StateHome,
}

#[derive(Deserialize)]
#[serde(
    tag = "homeMode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum StateHome {
    Fresh {
        database_absent_before_start: bool,
    },
    Copied {
        seed_database_sha256: String,
        before_start: Fingerprint,
        thread_read: Value,
        after_stop: Fingerprint,
    },
}

#[derive(Deserialize, Eq, PartialEq)]
struct Fingerprint {
    messages: String,
    runs: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Seed {
    seed_database_sha256: String,
    fingerprint: Fingerprint,
    thread_title: String,
    roles: Vec<String>,
}

fn verify_package(boot: &Boot, inventory: &Inventory, run: &Run) -> Result<()> {
    let package = &boot.package;
    let target = format!("linux-{}", boot.platform.arch);
    let archive = inventory
        .installer_targets
        .iter()
        .find(|entry| entry.id == target)
        .and_then(|entry| entry.cli_archive.as_deref())
        .context("missing Linux CLI archive in inventory")?;
    let published = inventory
        .github_release
        .assets
        .iter()
        .find(|asset| asset.name == archive)
        .context("missing published Linux CLI asset")?;
    let installed = published
        .unpacked_cli
        .as_ref()
        .context("missing installed Linux CLI pin")?;
    ensure!(
        package.target == target
            && package.archive == archive
            && published.digest.strip_prefix("sha256:") == Some(&package.archive_sha256)
            && package.archive_bytes == published.size
            && run.environment.installer_asset_digest.as_deref() == Some(&package.archive_sha256)
            && package.tag == inventory.github_release.tag_name
            && package.source_sha == inventory.incumbent_source_sha
            && package.source_sha == run.source_sha
            && package.installed_entries == installed.installed_entries
            && package.runtime_sha256 == installed.runtime_sha256
            && is_hex(&package.runtime_sha256, 64),
        "CLI receipt does not match the installed release asset"
    );
    Ok(())
}

fn verify_probes(boot: &Boot) -> Result<()> {
    let version = format!("t3 {}", boot.package.tag);
    ensure!(
        boot.version == json!({"command": ["t3", "--version"], "exitCode": 0, "stdout": version}),
        "incorrect observed CLI version"
    );
    let start = &boot.start;
    let executable = if boot.platform.execution == "native" {
        json!({"kind": "proc-exe"})
    } else {
        json!({"kind": "proc-mapped-exe", "interpreter": "rosetta"})
    };
    ensure!(
        start.command
            == [
                "t3",
                "serve",
                "--base-dir",
                "$BASE",
                "--host",
                "127.0.0.1",
                "--port",
                "$PORT",
                "--startup-pairing",
                "off"
            ]
            && start.readiness == "T3 Code server is ready."
            && start.runtime_record == "userdata/server-runtime.json"
            && start.runtime_record_version == 1
            && start.runtime_matches_owned_child
            && start.runtime_executable == executable
            && start.environment_matches_selected_home
            && !start.startup_pairing_url_printed
            && !start.competing_runtime_record_present
            && start.descriptor_status == 200,
        "missing owned CLI readiness in the selected home"
    );
    let descriptor = &start.descriptor;
    let capabilities = &descriptor["capabilities"];
    ensure!(
        descriptor["platform"] == json!({"os": "linux", "arch": boot.platform.arch})
            && descriptor["label"] == "P01 launcher fixture"
            && descriptor["serverVersion"] == boot.package.tag.trim_start_matches('v')
            && descriptor["orchestrationProtocolVersion"] == 2
            && descriptor["databaseMigration"] == 118
            && capabilities["serverBrowser"] == true
            && capabilities["localServerStop"] == true
            && capabilities["fileAttachments"] == json!({"maxUploadBytes": 52428800}),
        "incorrect released CLI descriptor"
    );
    ensure!(
        boot.pair
            == json!({
                "command": ["t3", "pair", "--base-dir", "$BASE", "--scope", "orchestration:read"],
                "exitCode": 0,
                "browserSession": {
                    "path": "/api/auth/browser-session", "status": 200,
                    "sessionMethod": "browser-session-cookie", "reuseStatus": 401,
                    "cookieCheck": {
                        "path": "/api/auth/session", "anonymousAuthenticated": false,
                        "authenticated": true, "status": 200, "scopes": ["orchestration:read"],
                        "permissions": ["orchestration:read"],
                    }
                }
            }),
        "incorrect one-time CLI pairing or cookie grants"
    );
    ensure!(
        boot.stop
            == json!({"signal": "SIGINT", "exitCode": 130, "listenerRefused": true, "runtimeRecordRemoved": true}),
        "foreground CLI shutdown did not release its runtime and listener"
    );
    Ok(())
}

fn verify_state(evidence: &Evidence, state: SavedState, boot: &Boot) -> Result<()> {
    ensure!(
        state.boot_id == boot.boot_id
            && state.fixture_id == boot.fixture_id
            && state.database == "userdata/statev2.sqlite",
        "state receipt disagrees with the CLI boot"
    );
    match (state.home, boot.home_mode) {
        (
            StateHome::Fresh {
                database_absent_before_start: true,
            },
            HomeMode::Fresh,
        ) => Ok(()),
        (
            StateHome::Copied {
                seed_database_sha256,
                before_start,
                thread_read,
                after_stop,
            },
            HomeMode::Copied,
        ) => {
            let seed: Seed =
                read_json(&evidence.resolve(Path::new("runtime/cli-lifecycle-seed.json"))?)?;
            ensure!(
                seed_database_sha256 == seed.seed_database_sha256
                    && before_start == seed.fingerprint
                    && after_stop == seed.fingerprint,
                "copied CLI home did not preserve the pinned fixture payloads"
            );
            ensure!(
                thread_read
                    == json!({
                        "command": ["t3", "thread", "show", "--base-dir", "$BASE", "--json", "$THREAD"],
                        "exitCode": 0, "threadTitle": seed.thread_title, "roles": seed.roles,
                        "messageCount": 3, "runCount": 1, "messagesMatchSeed": true,
                    }),
                "copied CLI boot did not open the saved Replay thread"
            );
            Ok(())
        }
        _ => anyhow::bail!("state receipt has the wrong CLI home mode"),
    }
}

fn verify_image(evidence: &Evidence, run: &Run, boot_id: &str) -> Result<()> {
    let transcript = one_artifact(&run.artifacts, "process-transcript")?;
    let state = one_artifact(&run.artifacts, "state-receipt")?;
    let image = one_artifact(&run.artifacts, "terminal-screenshot")?;
    let mut decoder =
        png::Decoder::new(Cursor::new(fs::read(evidence.resolve(&image.path)?)?)).read_info()?;
    let info = decoder.info();
    ensure!(
        info.width == 1024 && info.height == 318 && info.animation_control.is_none(),
        "unexpected CLI terminal image geometry"
    );
    for (key, expected) in [
        ("SailBoot", boot_id),
        ("SailTranscriptSha256", transcript.sha256.as_str()),
        ("SailStateSha256", state.sha256.as_str()),
    ] {
        let mut values = info
            .uncompressed_latin1_text
            .iter()
            .filter(|value| value.keyword == key);
        ensure!(
            values.next().is_some_and(|value| value.text == expected) && values.next().is_none(),
            "terminal image is not bound to the CLI receipts"
        );
    }
    let mut pixels = vec![
        0;
        decoder
            .output_buffer_size()
            .context("terminal image too large")?
    ];
    decoder.next_frame(&mut pixels)?;
    decoder.finish()?;
    Ok(())
}

fn verify_run(
    evidence: &Evidence,
    inventory: &Inventory,
    platform: &Platform,
    observation: &Observation,
    run: &Run,
) -> Result<(String, Value, Value)> {
    let transcript = one_artifact(&run.artifacts, "process-transcript")?;
    let state = one_artifact(&run.artifacts, "state-receipt")?;
    let mut process: Value = read_json(&evidence.resolve(&transcript.path)?)?;
    let mut state: Value = read_json(&evidence.resolve(&state.path)?)?;
    let boot: Boot = serde_json::from_value(process.clone())?;
    let id = &boot.boot_id;
    let host = &boot.platform;
    ensure!(
        boot.schema_version == 1
            && boot.fixture_id == "linux-cli-lifecycle"
            && boot.fixture_id == run.fixture_id
            && id.len() == 36
            && is_hex(&id.replace('-', ""), 32)
            && host.os == "linux"
            && host.origin == "http://127.0.0.1"
            && host.connection_mode == "loopback"
            && platform.arch.as_deref() == Some(&host.arch)
            && run.environment.arch.as_deref() == Some(&host.arch)
            && run.environment.os_version.as_deref() == Some(&host.os_version)
            && run.environment.origin.as_deref() == Some(&host.origin)
            && run.environment.connection_mode.as_deref() == Some(&host.connection_mode)
            && run.environment.client_version.as_deref()
                == Some(boot.package.tag.trim_start_matches('v'))
            && run.server_implementation == "Node"
            && matches!(host.execution.as_str(), "native" | "emulated"),
        "CLI receipt provenance contradicts the observation"
    );
    let mode = match boot.home_mode {
        HomeMode::Fresh => "fresh",
        HomeMode::Copied => "copied",
    };
    let configuration = format!(
        "{}-{}-{}-{mode}",
        host.os_version.to_lowercase().replace(' ', "-"),
        host.arch,
        host.execution
    );
    ensure!(
        configuration == observation.configuration_id,
        "CLI confirmation is for a different configuration"
    );
    let cell = &observation.cell;
    ensure!(
        (cell.case_id == "cli-open"
            && cell.entrypoint == "cli"
            && matches!(cell.state.as_str(), "version" | "start" | "pair" | "stop"))
            || (cell.case_id == "installer-home"
                && cell.entrypoint == "installer"
                && cell.state == "copied-home-boots"
                && boot.home_mode == HomeMode::Copied),
        "CLI boot does not cover the declared state"
    );
    verify_package(&boot, inventory, run)?;
    verify_probes(&boot)?;
    verify_state(evidence, serde_json::from_value(state.clone())?, &boot)?;
    verify_image(evidence, run, id)?;
    process
        .as_object_mut()
        .context("expected a process object")?
        .remove("bootId");
    state
        .as_object_mut()
        .context("expected a state object")?
        .remove("bootId");
    Ok((boot.boot_id, process, state))
}

pub(crate) fn verify_linux_cli_lifecycle(
    evidence: &Evidence,
    inventory: &Inventory,
    platform: &Platform,
    observation: &Observation,
) -> Result<()> {
    let [first, repeat] = observation.runs.as_slice() else {
        anyhow::bail!("CLI release reference requires two independent boots");
    };
    ensure!(
        first.role == "incumbent-first" && repeat.role == "incumbent-repeat",
        "CLI release reference must use the first and repeat incumbent roles"
    );
    let (first_id, first_process, first_state) =
        verify_run(evidence, inventory, platform, observation, first)?;
    let (repeat_id, repeat_process, repeat_state) =
        verify_run(evidence, inventory, platform, observation, repeat)?;
    ensure!(
        first_id != repeat_id && first_process == repeat_process && first_state == repeat_state,
        "CLI release reference lacks two matching independent boots"
    );
    Ok(())
}

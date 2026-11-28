use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::Path,
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{Evidence, ReceiptWitness, is_hex, one_artifact, process_terminal, read_json};
use crate::catalog::{Inventory, Observation, Platform, Run};

const EXERCISED_ROLLBACK: &str =
    include_str!("../../../incumbent/runtime/v0.1.17-to-v0.1.18-rollback.json");
const WITNESSES: &str = include_str!("../../../incumbent/runtime/service-upgrade-witnesses.json");
const CONFIGURATION: &str = "debian-12.15-arm64-service-launcher-trial";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    schema_version: u64,
    container_sha256: String,
    environment_sha256: String,
    trial_update_sha256: String,
    committed_update_sha256: String,
    trial_gate_sha256: String,
    final_payload_sha256: Value,
}

fn verify_transcript(observed: &Value, expected: &Value) -> Result<()> {
    ensure!(
        observed == expected,
        "service transcript does not match the published trial contract"
    );
    Ok(())
}

fn encode(state: &State, transcript_sha: &str, state_sha: &str) -> Result<Vec<u8>> {
    let rows = [
        "Sail published service launcher upgrade".to_owned(),
        "Debian 12.15 / arm64 / v0.1.17 to v0.1.18".to_owned(),
        format!(
            "Container witness {}",
            state
                .container_sha256
                .get(..16)
                .context("missing container witness")?
        ),
        "Stage kept v0.1.17 running. Bad checksum rejected.".to_owned(),
        "Failed trial rolled back and restored the snapshot.".to_owned(),
        "Clean retry activated v0.1.18. Restart retained it.".to_owned(),
        "Both bearer sessions and saved payloads preserved.".to_owned(),
    ];
    process_terminal::encode(
        &rows,
        &[
            ("SailBoot", &state.container_sha256),
            ("SailTranscriptSha256", transcript_sha),
            ("SailStateSha256", state_sha),
        ],
    )
}

pub(crate) fn render_service_terminal(directory: &Path) -> Result<()> {
    let transcript = fs::read(directory.join("process.json"))?;
    let state_bytes = fs::read(directory.join("state.json"))?;
    verify_transcript(
        &serde_json::from_slice(&transcript)?,
        &serde_json::from_str(EXERCISED_ROLLBACK)?,
    )?;
    let state: State = serde_json::from_slice(&state_bytes)?;
    let bytes = encode(
        &state,
        &format!("{:x}", Sha256::digest(transcript)),
        &format!("{:x}", Sha256::digest(state_bytes)),
    )?;
    fs::File::create_new(directory.join("terminal.png"))?.write_all(&bytes)?;
    Ok(())
}

pub(crate) fn verify_service_upgrade(
    evidence: &Evidence,
    inventory: &Inventory,
    platform: &Platform,
    observation: &Observation,
) -> Result<()> {
    let [first, repeat] = observation.runs.as_slice() else {
        anyhow::bail!("expected two independent service upgrade trials");
    };
    ensure!(
        platform.surface == "cli"
            && platform.os.as_deref() == Some("linux")
            && platform.arch.as_deref() == Some("arm64")
            && platform.inventory_target.as_deref() == Some("linux-arm64")
            && observation.cell.entrypoint == "cli"
            && matches!(
                observation.cell.state.as_str(),
                "available" | "installed" | "failed-recovery"
            )
            && observation.configuration_id == CONFIGURATION
            && first.role == "incumbent-first"
            && repeat.role == "incumbent-repeat"
            && first.environment == repeat.environment,
        "service upgrade reference configuration or platform differs"
    );
    let expected: Value = serde_json::from_str(EXERCISED_ROLLBACK)?;
    let archive_name = inventory
        .installer_targets
        .iter()
        .find(|target| target.id == "linux-arm64")
        .and_then(|target| target.cli_archive.as_deref())
        .context("missing published service archive")?;
    let source_asset = inventory
        .github_release
        .assets
        .iter()
        .find(|asset| asset.name == archive_name)
        .context("missing service archive digest")?;
    let source_digest = source_asset
        .digest
        .strip_prefix("sha256:")
        .context("invalid service archive digest")?;
    let version = inventory.github_release.tag_name.trim_start_matches('v');
    ensure!(
        expected["from"]["release"] == inventory.github_release.tag_name
            && expected["from"]["sourceSha"] == inventory.incumbent_source_sha
            && expected["archives"][version] == source_digest,
        "service trial source differs from the published installer"
    );
    let witnesses: BTreeMap<String, ReceiptWitness> = serde_json::from_str(WITNESSES)?;
    let verify = |run: &Run| -> Result<State> {
        ensure!(
            run.fixture_id == "service-upgrade-trial"
                && run.server_implementation == "Node"
                && run.environment.os_version.as_deref() == expected["distribution"].as_str()
                && run.environment.arch.as_deref() == Some("arm64")
                && run.environment.client_version.as_deref() == Some(version)
                && run.environment.origin.as_deref() == Some("service launcher loopback")
                && run.environment.connection_mode.as_deref() == Some("loopback")
                && run.environment.installer_asset_digest.as_deref() == Some(source_digest),
            "service trial provenance differs from the claimed release or configuration"
        );
        let transcript = one_artifact(&run.artifacts, "process-transcript")?;
        let receipt = one_artifact(&run.artifacts, "state-receipt")?;
        let image = one_artifact(&run.artifacts, "terminal-screenshot")?;
        let process: Value = read_json(&evidence.resolve(&transcript.path)?)?;
        let state: State = read_json(&evidence.resolve(&receipt.path)?)?;
        verify_transcript(&process, &expected)?;
        ensure!(
            state.schema_version == 1
                && [
                    &state.container_sha256,
                    &state.environment_sha256,
                    &state.trial_update_sha256,
                    &state.committed_update_sha256,
                    &state.trial_gate_sha256
                ]
                .into_iter()
                .all(|sha| is_hex(sha, 64))
                && state.trial_update_sha256 != state.committed_update_sha256
                && state.final_payload_sha256 == process["savedThread"]["payloadSha256"],
            "service trial did not preserve the saved payloads or prove a distinct retry"
        );
        let witness = witnesses
            .get(&state.container_sha256)
            .context("missing observed service trial witness")?;
        ensure!(
            witness.process_sha256 == transcript.sha256 && witness.state_sha256 == receipt.sha256,
            "service receipt bytes disagree with the observed trial witness"
        );
        ensure!(
            fs::read(evidence.resolve(&image.path)?)?
                == encode(&state, &transcript.sha256, &receipt.sha256)?,
            "terminal PNG does not match the service trial receipts"
        );
        Ok(state)
    };
    let a = verify(first)?;
    let b = verify(repeat)?;
    let updates = BTreeSet::from([
        a.trial_update_sha256,
        a.committed_update_sha256,
        b.trial_update_sha256,
        b.committed_update_sha256,
    ]);
    ensure!(
        a.container_sha256 != b.container_sha256
            && a.environment_sha256 != b.environment_sha256
            && a.trial_gate_sha256 == b.trial_gate_sha256
            && updates.len() == 4,
        "expected two distinct service trials and retries under the same fault gate"
    );
    Ok(())
}

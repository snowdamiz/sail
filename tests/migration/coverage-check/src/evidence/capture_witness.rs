use std::{collections::BTreeMap, fs::File, io::BufReader, path::Path};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::Value;

use super::{Capture, Evidence, one_artifact, read_json};
use crate::catalog::{Cell, Observation, Run};

const WITNESSES: &str = include_str!("../../../incumbent/runtime/linux-capture-witnesses.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Witness {
    platform_id: String,
    state_sha256: String,
}

pub(super) fn verify_known_platform(capture: &Capture, cell: &Cell) -> Result<()> {
    let witnesses: BTreeMap<String, Witness> = serde_json::from_str(WITNESSES)?;
    if let Some(witness) = witnesses.get(&capture.capture_run_id) {
        ensure!(
            witness.platform_id == cell.platform_id,
            "observed capture witness belongs to a different platform"
        );
    }
    Ok(())
}

pub(super) fn observed_state(
    evidence: &Evidence,
    observation: &Observation,
    run: &Run,
    capture: &Capture,
) -> Result<Value> {
    let platform = observation.cell.platform_id.as_str();
    let artifact = one_artifact(&run.artifacts, "state-receipt")?;
    ensure!(
        capture.state_receipt_sha256.as_deref() == Some(&artifact.sha256),
        "capture does not bind its runtime state receipt"
    );
    let witnesses: BTreeMap<String, Witness> = serde_json::from_str(WITNESSES)?;
    let witness = witnesses
        .get(&capture.capture_run_id)
        .context("missing observed capture witness")?;
    ensure!(
        witness.platform_id == platform && witness.state_sha256 == artifact.sha256,
        "state bytes disagree with the observed capture witness"
    );
    let state: Value = read_json(&evidence.resolve(&artifact.path)?)?;
    ensure!(
        state["schemaVersion"] == 1
            && state["captureRunId"] == capture.capture_run_id
            && state["sourceSha"] == capture.source_sha
            && state["packageSha256"].as_str() == capture.package_sha256.as_deref()
            && state["arch"].as_str() == run.environment.arch.as_deref()
            && state["osVersion"].as_str() == run.environment.os_version.as_deref(),
        "runtime evidence belongs to a different capture or package"
    );
    Ok(state)
}

pub(super) fn verify_png(image: &Path, width: u32, height: u32) -> Result<()> {
    let mut png = png::Decoder::new(BufReader::new(File::open(image)?)).read_info()?;
    ensure!(
        png.info().width == width && png.info().height == height,
        "screenshot does not match the physical capture dimensions"
    );
    let mut pixels = vec![
        0;
        png.output_buffer_size()
            .context("invalid screenshot buffer size")?
    ];
    png.next_frame(&mut pixels)?;
    Ok(())
}

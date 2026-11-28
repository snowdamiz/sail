use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Read},
    path::{Component, Path, PathBuf},
};

use crate::catalog::{Artifact, Cell, Observation, Run};

mod capture_witness;
mod chromium_chat;
mod display;
mod linux_cli;
mod navigation;
mod oci;
mod process_terminal;
mod service_upgrade;
pub(crate) use linux_cli::{render_cli_terminal, verify_linux_cli_lifecycle};
pub(crate) use oci::{oci_manifest, render_oci_terminal, verify_oci_lifecycle};
pub(crate) use service_upgrade::{render_service_terminal, verify_service_upgrade};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptWitness {
    process_sha256: String,
    state_sha256: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum HomeMode {
    Fresh,
    Copied,
}

impl HomeMode {
    fn label(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Copied => "copied",
        }
    }
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

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    serde_json::from_reader(BufReader::new(file))
        .with_context(|| format!("read JSON from {}", path.display()))
}

pub fn is_hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub struct Evidence {
    root: PathBuf,
    digests: BTreeMap<PathBuf, String>,
}

impl Evidence {
    pub fn new(root: &Path) -> Result<Self> {
        Ok(Self {
            root: root.canonicalize()?,
            digests: BTreeMap::new(),
        })
    }

    pub fn resolve(&self, relative: &Path) -> Result<PathBuf> {
        ensure!(
            !relative.as_os_str().is_empty()
                && relative
                    .components()
                    .all(|part| matches!(part, Component::Normal(_))),
            "expected a relative evidence path inside the catalog: {}",
            relative.display()
        );
        let path = self
            .root
            .join(relative)
            .canonicalize()
            .with_context(|| format!("resolve {}", relative.display()))?;
        ensure!(
            path.starts_with(&self.root) && path.is_file(),
            "expected a regular file inside the catalog: {}",
            relative.display()
        );
        Ok(path)
    }

    pub fn verify(&mut self, artifact: &Artifact) -> Result<()> {
        ensure!(
            is_hex(&artifact.sha256, 64),
            "invalid SHA-256 for {}",
            artifact.path.display()
        );
        let path = self.resolve(&artifact.path)?;
        if !self.digests.contains_key(&path) {
            let mut file = File::open(&path).with_context(|| format!("open {}", path.display()))?;
            let mut hash = Sha256::new();
            let mut buffer = [0; 64 * 1024];
            loop {
                let size = file.read(&mut buffer)?;
                if size == 0 {
                    break;
                }
                hash.update(&buffer[..size]);
            }
            self.digests
                .insert(path.clone(), format!("{:x}", hash.finalize()));
        }
        ensure!(
            self.digests[&path] == artifact.sha256,
            "SHA-256 mismatch for {}",
            artifact.path.display()
        );
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    schema_version: u64,
    fixture_id: String,
    source_sha: String,
    screenshot_sha256: String,
    capture_run_id: String,
    package_sha256: Option<String>,
    state_receipt_sha256: Option<String>,
    coverage: CaptureCoverage,
    profile: serde_json::Value,
    trace: Vec<TraceStep>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureCoverage {
    #[serde(flatten)]
    cell: Cell,
    configuration_id: String,
}

#[derive(Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct TraceStep {
    action: String,
    observed: BTreeMap<String, serde_json::Value>,
}

fn one_artifact<'a>(artifacts: &'a [Artifact], kind: &str) -> Result<&'a Artifact> {
    let mut artifacts = artifacts.iter().filter(|artifact| artifact.kind == kind);
    let first = artifacts
        .next()
        .with_context(|| format!("missing {kind} artifact"))?;
    ensure!(artifacts.next().is_none(), "expected one {kind} artifact");
    Ok(first)
}

fn load_capture(
    evidence: &Evidence,
    observation: &Observation,
    run: &Run,
) -> Result<(Capture, PathBuf, PathBuf)> {
    let image = one_artifact(&run.artifacts, "screenshot")?;
    let receipt = one_artifact(&run.artifacts, "capture-receipt")?;
    let receipt_path = evidence.resolve(&receipt.path)?;
    let capture: Capture = read_json(&receipt_path)?;
    ensure!(
        capture.schema_version == 1
            && capture.fixture_id == run.fixture_id
            && capture.source_sha == run.source_sha,
        "capture provenance disagrees with {}: {}",
        run.role,
        receipt.path.display()
    );
    ensure!(
        capture.screenshot_sha256 == image.sha256,
        "capture receipt names a different screenshot: {}",
        receipt.path.display()
    );
    ensure!(
        capture.coverage.cell == observation.cell
            && capture.coverage.configuration_id == observation.configuration_id,
        "capture receipt belongs to a different coverage cell or configuration: {}",
        receipt.path.display()
    );
    ensure!(
        capture.package_sha256 == run.environment.installer_asset_digest,
        "installer digest disagrees with capture receipt: {}",
        receipt.path.display()
    );
    let origin = run
        .environment
        .origin
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .context("missing run origin")?;
    ensure!(
        capture.profile["origin"].as_str() == Some(origin),
        "run origin disagrees with capture receipt: {}",
        receipt.path.display()
    );
    ensure!(
        !capture.trace.is_empty()
            && capture
                .trace
                .iter()
                .all(|step| !step.action.trim().is_empty() && !step.observed.is_empty()),
        "missing action trace or outcome: {}",
        receipt.path.display()
    );
    let display = run
        .environment
        .display_profile
        .as_ref()
        .context("missing run display profile")?;
    ensure!(
        ["theme", "locale", "motion"].iter().all(|key| display[key]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty()))
            && ["viewportWidth", "viewportHeight"]
                .iter()
                .all(|key| display[key].as_u64().is_some_and(|value| value > 0))
            && ["deviceScale", "zoom"]
                .iter()
                .all(|key| display[key].as_f64().is_some_and(|value| value > 0.0))
            && display["fonts"]
                .as_array()
                .is_some_and(|fonts| !fonts.is_empty()
                    && fonts
                        .iter()
                        .all(|font| font.as_str().is_some_and(|name| !name.trim().is_empty()))),
        "invalid display profile: {}",
        receipt.path.display()
    );
    for (field, pointer) in [
        ("viewportWidth", "/viewport/width"),
        ("viewportHeight", "/viewport/height"),
        ("deviceScale", "/viewport/scale"),
        ("zoom", "/viewport/zoom"),
        ("theme", "/theme"),
        ("locale", "/locale"),
        ("fonts", "/fonts"),
        ("motion", "/motion"),
    ] {
        let expected = display
            .get(field)
            .with_context(|| format!("missing display profile {field}"))?;
        ensure!(
            capture.profile.pointer(pointer) == Some(expected),
            "capture display profile disagrees on {field}: {}",
            receipt.path.display()
        );
    }
    let image_path = evidence.resolve(&image.path)?;
    capture_witness::verify_known_platform(&capture, &observation.cell)?;
    if matches!(
        observation.cell.platform_id.as_str(),
        "electron-linux-arm64" | "electron-linux-x64"
    ) {
        match observation.cell.case_id.as_str() {
            "chat-display" => display::verify(evidence, observation, run, &capture, &image_path)?,
            "chat-link" | "palette-link" => {
                navigation::verify(evidence, observation, run, &capture, &image_path)?;
            }
            _ => {}
        }
    }
    if observation.cell.platform_id == "served-chromium-linux"
        && matches!(
            observation.cell.case_id.as_str(),
            "chat-view-states" | "disconnect-recover" | "browser-preview"
        )
    {
        chromium_chat::verify(evidence, observation, run, &capture, &image_path)?;
    }
    Ok((capture, image_path, receipt_path))
}

pub fn verify_reference_pair(evidence: &Evidence, observation: &Observation) -> Result<()> {
    let [first, repeat] = observation.runs.as_slice() else {
        anyhow::bail!("expected two incumbent runs");
    };
    ensure!(
        first.role == "incumbent-first" && repeat.role == "incumbent-repeat",
        "expected incumbent-first followed by incumbent-repeat"
    );
    ensure!(
        first.environment == repeat.environment
            && first.fixture_id == repeat.fixture_id
            && first.server_implementation == repeat.server_implementation,
        "incumbent runs disagree on their environment, fixture or server implementation"
    );
    let (first_capture, first_image, first_receipt) = load_capture(evidence, observation, first)?;
    let (repeat_capture, repeat_image, repeat_receipt) =
        load_capture(evidence, observation, repeat)?;
    ensure!(
        first_image != repeat_image && first_receipt != repeat_receipt,
        "incumbent repeat reuses the first run's capture paths"
    );
    ensure!(
        !first_capture.capture_run_id.trim().is_empty()
            && !repeat_capture.capture_run_id.trim().is_empty()
            && first_capture.capture_run_id != repeat_capture.capture_run_id,
        "expected distinct capture run IDs for first and repeat"
    );
    ensure!(
        first_capture.profile == repeat_capture.profile,
        "incumbent runs have different capture profiles"
    );
    ensure!(
        first_capture.screenshot_sha256 == repeat_capture.screenshot_sha256,
        "incumbent runs have different screenshots"
    );
    ensure!(
        first_capture.trace == repeat_capture.trace,
        "incumbent runs have different action traces"
    );
    let comparison = one_artifact(&observation.comparison_artifacts, "action-and-state")?;
    let diff = one_artifact(&observation.comparison_artifacts, "pixel-diff")?;
    let comparison_path = evidence.resolve(&comparison.path)?;
    let result: Comparison = read_json(&comparison_path)?;
    ensure!(
        result.fixture_id == first_capture.fixture_id
            && result.baseline_sha == first_capture.source_sha
            && result.candidate_sha == repeat_capture.source_sha,
        "comparison provenance disagrees with the capture receipts: {}",
        comparison.path.display()
    );
    ensure!(
        result.artifact_sha256.baseline_receipt
            == one_artifact(&first.artifacts, "capture-receipt")?.sha256
            && result.artifact_sha256.candidate_receipt
                == one_artifact(&repeat.artifacts, "capture-receipt")?.sha256
            && result.artifact_sha256.diff == diff.sha256,
        "comparison receipt belongs to a different capture pair or diff: {}",
        comparison.path.display()
    );
    ensure!(
        result.pixels.different_pixels == 0 && result.changed_steps.is_empty(),
        "passing reference has a recorded difference: {}",
        comparison.path.display()
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    fixture_id: String,
    baseline_sha: String,
    candidate_sha: String,
    artifact_sha256: ComparisonDigests,
    changed_steps: Vec<usize>,
    pixels: PixelResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComparisonDigests {
    baseline_receipt: String,
    candidate_receipt: String,
    diff: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PixelResult {
    different_pixels: u64,
}

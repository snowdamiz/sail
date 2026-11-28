use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Read},
    path::{Component, Path, PathBuf},
};

use crate::catalog::{Artifact, Run};

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
    profile: serde_json::Value,
    trace: Vec<TraceStep>,
}

#[derive(Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct TraceStep {
    action: String,
    observed: BTreeMap<String, serde_json::Value>,
}

fn one_artifact<'a>(run: &'a Run, kind: &str) -> Result<&'a Artifact> {
    let mut artifacts = run
        .artifacts
        .iter()
        .filter(|artifact| artifact.kind == kind);
    let first = artifacts
        .next()
        .with_context(|| format!("missing {kind} artifact"))?;
    ensure!(
        artifacts.next().is_none(),
        "expected one {kind} artifact for {}",
        run.role
    );
    Ok(first)
}

fn load_capture(evidence: &Evidence, run: &Run) -> Result<(Capture, PathBuf, PathBuf)> {
    let image = one_artifact(run, "screenshot")?;
    let receipt = one_artifact(run, "capture-receipt")?;
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
    Ok((capture, evidence.resolve(&image.path)?, receipt_path))
}

pub fn verify_reference_pair(evidence: &Evidence, runs: &[Run]) -> Result<()> {
    let [first, repeat] = runs else {
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
    let (first_capture, first_image, first_receipt) = load_capture(evidence, first)?;
    let (repeat_capture, repeat_image, repeat_receipt) = load_capture(evidence, repeat)?;
    ensure!(
        first_image != repeat_image && first_receipt != repeat_receipt,
        "incumbent repeat reuses the first run's capture paths"
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
    Ok(())
}

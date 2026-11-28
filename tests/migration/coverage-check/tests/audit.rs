use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

struct Fixture {
    directory: tempfile::TempDir,
    repo: PathBuf,
    catalog: Value,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .unwrap()
            .to_owned();
        let source = repo.join("tests/migration/incumbent");
        let mut catalog: Value =
            serde_json::from_slice(&fs::read(source.join("coverage-catalog.json")).unwrap())
                .unwrap();
        let observation = catalog["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| {
                record["caseId"] == "chat-turn"
                    && record["platformId"] == "served-chromium-macos"
                    && record["stage"] == "p01-release-reference"
            })
            .unwrap()
            .clone();
        let mut chat = catalog["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["id"] == "chat-turn")
            .unwrap()
            .clone();
        chat["supplementalReceipts"] = json!(["supplemental.json"]);
        catalog["cases"] = json!([chat]);
        catalog["observations"] = json!([observation]);
        catalog["platformSets"]["app"] = json!(["served-chromium-macos"]);
        fs::write(directory.path().join("supplemental.json"), "{}").unwrap();
        let fixture = Self {
            directory,
            repo,
            catalog,
        };
        fixture.copy(&source, &fixture.catalog["releaseInventory"]);
        let observation = &fixture.catalog["observations"][0];
        for artifact in observation["runs"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|run| run["artifacts"].as_array().unwrap())
            .chain(observation["comparisonArtifacts"].as_array().unwrap())
        {
            fixture.copy(&source, &artifact["path"]);
        }
        fixture
    }

    fn copy(&self, source: &Path, relative: &Value) {
        let path = relative.as_str().unwrap();
        let target = self.directory.path().join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(source.join(path), target).unwrap();
    }

    fn run(&self) -> Output {
        let path = self.directory.path().join("coverage-catalog.json");
        fs::write(&path, serde_json::to_vec(&self.catalog).unwrap()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_sail-migration-coverage"))
            .current_dir(&self.repo)
            .arg("--list-missing")
            .arg(path)
            .output()
            .unwrap()
    }

    fn rejects(&self, reason: &str) {
        let result = self.run();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(!result.status.success(), "accepted invalid catalog");
        assert!(stderr.contains(reason), "{stderr}");
    }
}

#[test]
fn reports_each_unobserved_state_and_keeps_supplemental_receipts_separate() {
    let fixture = Fixture::new();
    let result = fixture.run();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["declaredCells"], 3);
    assert_eq!(report["observedCells"], 1);
    assert_eq!(report["unobservedCells"], 2);
    assert_eq!(report["supplementalReceipts"], 1);
    assert_eq!(report["verifiedVisualReferenceObservations"], 1);
    assert_eq!(report["missing"][0]["state"], "draft");
    assert_eq!(report["missing"][1]["state"], "streaming");
}

#[test]
fn rejects_an_observation_outside_the_declared_matrix() {
    let mut fixture = Fixture::new();
    fixture.catalog["observations"][0]["state"] = json!("invented");
    fixture.rejects("does not match a declared cell");
}

#[test]
fn rejects_relabeling_a_capture_as_a_different_platform_or_state() {
    let mut fixture = Fixture::new();
    fixture.catalog["platformSets"]["app"] =
        json!(["served-chromium-macos", "served-safari-macos"]);
    fixture.catalog["observations"][0]["platformId"] = json!("served-safari-macos");
    fixture.rejects("different coverage cell or configuration");

    fixture.catalog["observations"][0]["platformId"] = json!("served-chromium-macos");
    fixture.catalog["observations"][0]["state"] = json!("draft");
    fixture.rejects("different coverage cell or configuration");
}

#[test]
fn rejects_an_unrelated_published_installer() {
    let mut fixture = Fixture::new();
    let inventory: Value = serde_json::from_slice(
        &fs::read(fixture.directory.path().join("release-inventory.json")).unwrap(),
    )
    .unwrap();
    let dmg = inventory["githubRelease"]["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["name"] == "Sail-0.1.17-arm64.dmg")
        .expect("published macOS arm64 DMG");
    let digest = dmg["digest"]
        .as_str()
        .unwrap()
        .strip_prefix("sha256:")
        .unwrap();
    for run in fixture.catalog["observations"][0]["runs"]
        .as_array_mut()
        .unwrap()
    {
        run["environment"]["installerAssetDigest"] = json!(digest);
    }
    fixture.rejects("installer digest disagrees with capture receipt");
}

#[test]
fn rejects_a_rehashed_reference_with_an_installer_for_another_target() {
    let mut fixture = Fixture::new();
    let directory = fixture.directory.path();
    let inventory: Value =
        serde_json::from_slice(&fs::read(directory.join("release-inventory.json")).unwrap())
            .unwrap();
    let asset = inventory["githubRelease"]["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["name"] == "t3-0.1.17-linux-arm64.tar.gz")
        .unwrap();
    let digest = asset["digest"]
        .as_str()
        .unwrap()
        .strip_prefix("sha256:")
        .unwrap();
    let observation = &mut fixture.catalog["observations"][0];
    let mut receipt_digests = Vec::new();
    for run in observation["runs"].as_array_mut().unwrap() {
        run["environment"]["installerAssetDigest"] = json!(digest);
        let artifact = run["artifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|artifact| artifact["kind"] == "capture-receipt")
            .unwrap();
        let path = directory.join(artifact["path"].as_str().unwrap());
        let mut capture: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        capture["packageSha256"] = json!(digest);
        let bytes = serde_json::to_vec(&capture).unwrap();
        fs::write(path, &bytes).unwrap();
        let receipt_digest = json!(format!("{:x}", Sha256::digest(bytes)));
        receipt_digests.push(receipt_digest.clone());
        artifact["sha256"] = receipt_digest;
    }
    let artifact = observation["comparisonArtifacts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|artifact| artifact["kind"] == "action-and-state")
        .unwrap();
    let path = directory.join(artifact["path"].as_str().unwrap());
    let mut comparison: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    comparison["artifactSha256"]["baselineReceipt"] = receipt_digests[0].clone();
    comparison["artifactSha256"]["candidateReceipt"] = receipt_digests[1].clone();
    let bytes = serde_json::to_vec(&comparison).unwrap();
    fs::write(path, &bytes).unwrap();
    artifact["sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
    fixture.rejects("outside target macos-arm64");
}

#[test]
fn allows_a_blocked_browser_reference_without_an_installed_package() {
    let mut fixture = Fixture::new();
    let observation = &mut fixture.catalog["observations"][0];
    observation["result"] = json!("blocked");
    for run in observation["runs"].as_array_mut().unwrap() {
        run["environment"]["installerAssetDigest"] = Value::Null;
        run["environment"]["arch"] = Value::Null;
    }
    let report = fixture.run();
    assert!(
        report.status.success(),
        "{}",
        String::from_utf8_lossy(&report.stderr)
    );
    let body: Value = serde_json::from_slice(&report.stdout).unwrap();
    assert_eq!(body["verifiedVisualReferenceObservations"], 0);
}

#[test]
fn rejects_comparison_evidence_from_a_different_capture_pair() {
    let mut fixture = Fixture::new();
    let foreign = fixture.repo.join("tests/migration/incumbent/observations/served-firefox-macos/settled/reference-pair-comparison.json");
    let bytes = fs::read(foreign).unwrap();
    fs::write(fixture.directory.path().join("other-pair.json"), &bytes).unwrap();
    let comparison = fixture.catalog["observations"][0]["comparisonArtifacts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|artifact| artifact["kind"] == "action-and-state")
        .unwrap();
    comparison["path"] = json!("other-pair.json");
    comparison["sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
    fixture.rejects("comparison receipt belongs to a different capture pair or diff");
}

#[test]
fn rejects_a_rehashed_comparison_with_contradictory_provenance() {
    for (field, value) in [
        ("fixtureId", "wrong-fixture"),
        ("baselineSha", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ("candidateSha", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ] {
        let mut fixture = Fixture::new();
        let comparison = fixture.catalog["observations"][0]["comparisonArtifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|artifact| artifact["kind"] == "action-and-state")
            .unwrap();
        let file = fixture
            .directory
            .path()
            .join(comparison["path"].as_str().unwrap());
        let mut receipt: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        receipt[field] = json!(value);
        let bytes = serde_json::to_vec(&receipt).unwrap();
        fs::write(file, &bytes).unwrap();
        comparison["sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
        fixture.rejects("comparison provenance disagrees with the capture receipts");
    }
}

#[test]
fn rejects_a_changed_artifact() {
    let fixture = Fixture::new();
    let image = fixture.catalog["observations"][0]["runs"][0]["artifacts"][0]["path"]
        .as_str()
        .unwrap();
    fs::write(fixture.directory.path().join(image), b"changed").unwrap();
    fixture.rejects("SHA-256 mismatch");
}

#[test]
fn rejects_a_rehashed_receipt_with_a_different_trace() {
    let mut fixture = Fixture::new();
    let artifact = &mut fixture.catalog["observations"][0]["runs"][1]["artifacts"][1];
    let file = fixture
        .directory
        .path()
        .join(artifact["path"].as_str().unwrap());
    let mut receipt: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    receipt["trace"][0]["observed"]["changed"] = json!(true);
    let bytes = serde_json::to_vec(&receipt).unwrap();
    fs::write(file, &bytes).unwrap();
    artifact["sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
    fixture.rejects("different action traces");
}

#[test]
fn rejects_a_passing_repeat_that_reuses_the_first_capture() {
    let mut fixture = Fixture::new();
    let runs = &mut fixture.catalog["observations"][0]["runs"];
    runs[1]["artifacts"] = runs[0]["artifacts"].clone();
    fixture.rejects("reuses the first run's capture paths");
}

#[test]
fn rejects_a_copied_capture_even_at_new_paths() {
    let mut fixture = Fixture::new();
    let runs = &mut fixture.catalog["observations"][0]["runs"];
    for (kind, alias) in [
        ("screenshot", "copied.png"),
        ("capture-receipt", "copied.json"),
    ] {
        let mut artifact = runs[0]["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|artifact| artifact["kind"] == kind)
            .unwrap()
            .clone();
        let original = artifact["path"].as_str().unwrap();
        fs::copy(
            fixture.directory.path().join(original),
            fixture.directory.path().join(alias),
        )
        .unwrap();
        artifact["path"] = json!(alias);
        let repeat = runs[1]["artifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|artifact| artifact["kind"] == kind)
            .unwrap();
        *repeat = artifact;
    }
    fixture.rejects("expected distinct capture run IDs");
}

#[test]
fn rejects_a_catalog_that_removes_required_visual_evidence() {
    let mut fixture = Fixture::new();
    fixture.catalog["observationContract"]["evidenceProfiles"]["interaction"] =
        json!(["capture-receipt", "state-receipt"]);
    fixture.catalog["observations"][0]["state"] = json!("draft");
    fixture.rejects("schema-v1 evidence profile interaction requires screenshot");
}

#[test]
fn rejects_a_manifest_profile_that_disagrees_with_both_captures() {
    let mut fixture = Fixture::new();
    for run in fixture.catalog["observations"][0]["runs"]
        .as_array_mut()
        .unwrap()
    {
        run["environment"]["displayProfile"]["deviceScale"] = json!(1);
    }
    fixture.rejects("capture display profile disagrees on deviceScale");
}

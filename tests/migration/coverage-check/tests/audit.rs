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
    assert_eq!(report["passingReleaseReferenceObservations"], 1);
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

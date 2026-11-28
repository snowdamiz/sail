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
        Self::visual("chat-turn", "settled", "served-chromium-macos")
    }

    fn visual(case_id: &str, state: &str, platform: &str) -> Self {
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
                record["caseId"] == case_id
                    && record["state"] == state
                    && record["platformId"] == platform
                    && record["stage"] == "p01-release-reference"
            })
            .unwrap()
            .clone();
        let mut case = catalog["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["id"] == case_id)
            .unwrap()
            .clone();
        case["supplementalReceipts"] = json!(["supplemental.json"]);
        catalog["cases"] = json!([case]);
        catalog["observations"] = json!([observation]);
        catalog["platformSets"]["app"] = json!([platform]);
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

    fn cli(case_id: &str, state: &str, arch: &str) -> Self {
        Self::process(case_id, state, &format!("cli-linux-{arch}"))
    }

    fn process(case_id: &str, state: &str, platform: &str) -> Self {
        let mut fixture = Self::new();
        let source = fixture.repo.join("tests/migration/incumbent");
        let original: Value =
            serde_json::from_slice(&fs::read(source.join("coverage-catalog.json")).unwrap())
                .unwrap();
        let case = original["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["id"] == case_id)
            .unwrap();
        let observation = original["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| {
                record["caseId"] == case_id
                    && record["platformId"] == platform
                    && record["state"] == state
            })
            .unwrap();
        fixture.catalog["cases"] = json!([case]);
        fixture.catalog["cases"][0]
            .as_object_mut()
            .unwrap()
            .remove("supplementalReceipts");
        fixture.catalog["platformSets"]["packaged"] = json!([platform]);
        fixture.catalog["observations"] = json!([observation]);
        fixture.copy(&source, &json!("runtime/cli-lifecycle-seed.json"));
        for artifact in observation["runs"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|run| run["artifacts"].as_array().unwrap())
        {
            fixture.copy(&source, &artifact["path"]);
        }
        fixture
    }

    fn edit_process_json(&mut self, run: usize, kind: &str, edit: impl FnOnce(&mut Value)) {
        let artifact = self.catalog["observations"][0]["runs"][run]["artifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|artifact| artifact["kind"] == kind)
            .unwrap();
        let path = self
            .directory
            .path()
            .join(artifact["path"].as_str().unwrap());
        let mut data = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        edit(&mut data);
        let bytes = serde_json::to_vec(&data).unwrap();
        fs::write(path, &bytes).unwrap();
        artifact["sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
    }

    fn refresh_cli_terminal(&mut self, run: usize) {
        let image = self.catalog["observations"][0]["runs"][run]["artifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|artifact| artifact["kind"] == "terminal-screenshot")
            .unwrap();
        let path = self.directory.path().join(image["path"].as_str().unwrap());
        fs::remove_file(&path).unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_sail-migration-coverage"))
            .arg("--render-cli")
            .arg(path.parent().unwrap())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        image["sha256"] = json!(format!("{:x}", Sha256::digest(fs::read(path).unwrap())));
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
fn verifies_native_and_translated_cli_lifecycle_receipts() {
    for (case, state, arch) in [
        ("cli-open", "start", "arm64"),
        ("installer-home", "copied-home-boots", "x64"),
    ] {
        let result = Fixture::cli(case, state, arch).run();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let report: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(report["observedCells"], 1);
        assert_eq!(report["verifiedVisualReferenceObservations"], 0);
        assert_eq!(report["verifiedCliReferenceObservations"], 1);
    }
}

#[test]
fn verifies_both_published_oci_lifecycle_manifests() {
    for platform in ["oci-linux-arm64", "oci-linux-amd64"] {
        for (case, state) in [
            ("cli-open", "pair"),
            ("installer-home", "copied-home-boots"),
        ] {
            let fixture = Fixture::process(case, state, platform);
            let output = fixture.run();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["verifiedOciReferenceObservations"], 1);
        }
    }
}

#[test]
fn rejects_an_oci_release_reference_with_the_other_architecture_digest() {
    let mut fixture = Fixture::process("cli-open", "start", "oci-linux-arm64");
    let amd64 = Fixture::process("cli-open", "start", "oci-linux-amd64");
    fixture.catalog["observations"][0]["runs"][0]["environment"]["installerAssetDigest"] =
        amd64.catalog["observations"][0]["runs"][0]["environment"]["installerAssetDigest"].clone();
    fixture.rejects("installer digest does not match published OCI arm64 manifest");
}

#[test]
fn rejects_a_reused_oci_boot() {
    let mut fixture = Fixture::process("cli-open", "stop", "oci-linux-arm64");
    let runs = fixture.catalog["observations"][0]["runs"]
        .as_array_mut()
        .unwrap();
    runs[1]["artifacts"] = runs[0]["artifacts"].clone();
    fixture.rejects("expected two distinct OCI boots");
}

#[test]
fn rejects_an_edited_oci_receipt_even_with_updated_catalog_digest() {
    let mut fixture = Fixture::process("cli-open", "start", "oci-linux-arm64");
    fixture.edit_process_json(0, "process-transcript", |receipt| {
        receipt["start"]["startedAt"] = json!("2026-11-28T00:00:00.000Z");
    });
    fixture.rejects("OCI receipt bytes disagree with the observed container witness");
}

#[test]
fn verifies_published_service_upgrade_and_recovery_states() {
    for state in ["available", "installed", "failed-recovery"] {
        let fixture = Fixture::cli("host-upgrade", state, "arm64");
        let output = fixture.run();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["verifiedServiceUpgradeObservations"], 1);
    }
}

#[test]
fn rejects_service_trial_evidence_without_snapshot_restoration() {
    let mut fixture = Fixture::cli("host-upgrade", "failed-recovery", "arm64");
    fixture.edit_process_json(0, "process-transcript", |receipt| {
        receipt["rollback"]["snapshotRestored"] = json!(false);
    });
    fixture.rejects("service transcript does not match the published trial contract");
}

#[test]
fn rejects_an_edited_service_witness_even_with_updated_catalog_digest() {
    let mut fixture = Fixture::cli("host-upgrade", "installed", "arm64");
    fixture.edit_process_json(0, "state-receipt", |receipt| {
        receipt["committedUpdateSha256"] = json!("f".repeat(64));
    });
    fixture.rejects("service receipt bytes disagree with the observed trial witness");
}

#[test]
fn rejects_reusing_the_first_service_trial_as_the_repeat() {
    let mut fixture = Fixture::cli("host-upgrade", "installed", "arm64");
    let runs = fixture.catalog["observations"][0]["runs"]
        .as_array_mut()
        .unwrap();
    runs[1]["artifacts"] = runs[0]["artifacts"].clone();
    fixture.rejects("expected two distinct service trials and retries");
}

#[test]
fn rejects_relabeling_a_service_trial_to_a_platform_without_a_verifier() {
    let mut fixture = Fixture::cli("host-upgrade", "installed", "arm64");
    let x64 = Fixture::cli("cli-open", "start", "x64");
    let observation = &mut fixture.catalog["observations"][0];
    observation["platformId"] = json!("cli-linux-x64");
    for run in observation["runs"].as_array_mut().unwrap() {
        run["environment"]["arch"] = json!("x64");
        run["environment"]["installerAssetDigest"] =
            x64.catalog["observations"][0]["runs"][0]["environment"]["installerAssetDigest"]
                .clone();
    }
    fixture
        .rejects("no process verifier for passing release reference: host-upgrade/cli-linux-x64");
    fixture.catalog["cases"][0]["evidenceProfile"] = json!("negative");
    fixture.rejects("schema-v1 case host-upgrade requires the process evidence profile");
}

#[test]
fn verifies_the_linux_display_receipt_against_the_live_state() {
    let fixture = Fixture::visual("chat-display", "translated", "electron-linux-arm64");
    let output = fixture.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["verifiedVisualReferenceObservations"], 1);
}

#[test]
fn rejects_a_display_receipt_with_a_rehashed_fabricated_locale_observation() {
    let mut fixture = Fixture::visual("chat-display", "translated", "electron-linux-arm64");
    fixture.edit_process_json(0, "state-receipt", |state| {
        state["displayCaptures"]["translated"]["attachmentControl"] = json!("Attach files");
    });
    let digest = fixture.catalog["observations"][0]["runs"][0]["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|artifact| artifact["kind"] == "state-receipt")
        .unwrap()["sha256"]
        .clone();
    fixture.edit_process_json(0, "capture-receipt", |capture| {
        capture["stateReceiptSha256"] = digest;
    });
    fixture.rejects("state bytes disagree with the observed capture witness");
}

#[test]
fn rejects_relabeling_display_evidence_as_negative_controls() {
    let mut fixture = Fixture::visual("chat-display", "light", "electron-linux-arm64");
    fixture.catalog["cases"][0]["evidenceProfile"] = json!("negative");
    fixture.rejects("schema-v1 case chat-display requires the interaction evidence profile");
}

#[test]
fn rejects_a_desktop_repeat_with_an_invented_capture_id() {
    let mut fixture = Fixture::visual("chat-display", "light", "electron-linux-arm64");
    fixture.edit_process_json(1, "state-receipt", |state| {
        state["captureRunId"] = json!("invented-repeat");
    });
    let digest = fixture.catalog["observations"][0]["runs"][1]["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|artifact| artifact["kind"] == "state-receipt")
        .unwrap()["sha256"]
        .clone();
    fixture.edit_process_json(1, "capture-receipt", |capture| {
        capture["captureRunId"] = json!("invented-repeat");
        capture["stateReceiptSha256"] = digest;
    });
    fixture.rejects("missing observed capture witness");
}

#[test]
fn rejects_rehashing_dark_pixels_into_a_light_display_reference() {
    let mut light = Fixture::visual("chat-display", "light", "electron-linux-arm64");
    let dark = Fixture::visual("chat-display", "dark", "electron-linux-arm64");
    for run in 0..2 {
        let target = light.catalog["observations"][0]["runs"][run]["artifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|a| a["kind"] == "screenshot")
            .unwrap();
        let replacement = dark.catalog["observations"][0]["runs"][run]["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["kind"] == "screenshot")
            .unwrap();
        fs::copy(
            dark.directory
                .path()
                .join(replacement["path"].as_str().unwrap()),
            light
                .directory
                .path()
                .join(target["path"].as_str().unwrap()),
        )
        .unwrap();
        let screenshot = replacement["sha256"].clone();
        target["sha256"] = screenshot.clone();
        light.edit_process_json(run, "state-receipt", |state| {
            state["displayCaptures"]["light"]["screenshotSha256"] = screenshot.clone();
        });
        let digest = light.catalog["observations"][0]["runs"][run]["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["kind"] == "state-receipt")
            .unwrap()["sha256"]
            .clone();
        light.edit_process_json(run, "capture-receipt", |capture| {
            capture["stateReceiptSha256"] = digest;
            capture["screenshotSha256"] = screenshot;
        });
    }
    light.rejects("state bytes disagree with the observed capture witness");
}

#[test]
fn verifies_both_witnessed_linux_navigation_entrypoints() {
    for (case, state) in [
        ("chat-link", "linked-thread-opened"),
        ("palette-link", "selected-thread-opened"),
    ] {
        let fixture = Fixture::visual(case, state, "electron-linux-arm64");
        let output = fixture.run();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["verifiedVisualReferenceObservations"], 1);
    }
}

#[test]
fn verifies_the_published_linux_chromium_chat_states() {
    for state in ["empty", "initial-loading", "error"] {
        let fixture = Fixture::visual("chat-view-states", state, "served-chromium-linux");
        let output = fixture.run();
        assert!(
            output.status.success(),
            "{state}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["verifiedVisualReferenceObservations"], 1);
    }
}

#[test]
fn rejects_a_rehashed_loading_trace_with_a_different_restored_table() {
    let mut fixture = Fixture::visual(
        "chat-view-states",
        "initial-loading",
        "served-chromium-linux",
    );
    fixture.edit_process_json(0, "capture-receipt", |capture| {
        capture["trace"][1]["observed"]["table"][3][2] = json!("0 passed");
    });
    fixture.rejects("loading trace disagrees with the observed release of the held RPC");
}

#[test]
fn verifies_the_published_linux_chromium_reconnect_sequence() {
    for state in ["online", "offline", "reconnecting", "recovered"] {
        let fixture = Fixture::visual("disconnect-recover", state, "served-chromium-linux");
        let output = fixture.run();
        assert!(
            output.status.success(),
            "{state}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["verifiedVisualReferenceObservations"], 1);
    }
}

#[test]
fn rejects_a_rehashed_reconnect_trace_that_loses_the_draft() {
    let mut fixture = Fixture::visual("disconnect-recover", "recovered", "served-chromium-linux");
    fixture.edit_process_json(0, "capture-receipt", |capture| {
        capture["trace"][3]["observed"]["draft"] = json!("");
    });
    fixture.rejects("reconnect trace disagrees with the observed recovered state");
}

#[test]
fn verifies_the_published_linux_chromium_browser_panel() {
    for state in ["preview-rendered", "tool-result"] {
        let fixture = Fixture::visual("browser-preview", state, "served-chromium-linux");
        let output = fixture.run();
        assert!(
            output.status.success(),
            "{state}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["verifiedVisualReferenceObservations"], 1);
    }
}

#[test]
fn rejects_a_rehashed_browser_trace_with_a_different_tool_result() {
    let mut fixture = Fixture::visual("browser-preview", "tool-result", "served-chromium-linux");
    fixture.edit_process_json(0, "capture-receipt", |capture| {
        capture["trace"][3]["observed"]["tool"]["value"]["body"] = json!("Changed page");
    });
    fixture.rejects("Browser panel trace disagrees with the observed evaluateInnerTab result");
}

#[test]
fn verifies_the_published_linux_chromium_approval_views() {
    for state in ["requested", "approved", "denied"] {
        let fixture = Fixture::visual("approval", state, "served-chromium-linux");
        let output = fixture.run();
        assert!(
            output.status.success(),
            "{state}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["verifiedVisualReferenceObservations"], 1);
    }
}

#[test]
fn rejects_a_rehashed_approval_trace_that_changes_the_pending_request() {
    let mut fixture = Fixture::visual("approval", "requested", "served-chromium-linux");
    fixture.edit_process_json(0, "capture-receipt", |capture| {
        capture["trace"][1]["observed"]["requestUnchanged"] = json!(false);
    });
    fixture.rejects("approval trace disagrees with the observed denyReadOnlyResponse result");
}

#[test]
fn uses_generic_visual_checks_for_non_linux_display_references() {
    let mut fixture = Fixture::visual("chat-turn", "settled", "electron-macos-arm64");
    fixture.catalog["cases"][0]["id"] = json!("chat-display");
    fixture.catalog["cases"][0]["states"] = json!(["dark"]);
    fixture.catalog["observations"][0]["caseId"] = json!("chat-display");
    fixture.catalog["observations"][0]["state"] = json!("dark");
    let mut receipts = Vec::new();
    for run in 0..2 {
        fixture.catalog["observations"][0]["runs"][run]["fixtureId"] = json!("chat-display");
        fixture.edit_process_json(run, "capture-receipt", |capture| {
            capture["fixtureId"] = json!("chat-display");
            capture["coverage"]["caseId"] = json!("chat-display");
            capture["coverage"]["state"] = json!("dark");
        });
        receipts.push(
            fixture.catalog["observations"][0]["runs"][run]["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|artifact| artifact["kind"] == "capture-receipt")
                .unwrap()["sha256"]
                .clone(),
        );
    }
    let artifact = fixture.catalog["observations"][0]["comparisonArtifacts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|artifact| artifact["kind"] == "action-and-state")
        .unwrap();
    let path = fixture
        .directory
        .path()
        .join(artifact["path"].as_str().unwrap());
    let mut comparison: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    comparison["fixtureId"] = json!("chat-display");
    comparison["artifactSha256"]["baselineReceipt"] = receipts[0].clone();
    comparison["artifactSha256"]["candidateReceipt"] = receipts[1].clone();
    let bytes = serde_json::to_vec(&comparison).unwrap();
    fs::write(path, &bytes).unwrap();
    artifact["sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
    let output = fixture.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let state = fixture
        .repo
        .join("tests/migration/incumbent/observations/electron-linux-arm64/display/a/state.json");
    let state: Value = serde_json::from_slice(&fs::read(state).unwrap()).unwrap();
    fixture.edit_process_json(0, "capture-receipt", |capture| {
        capture["captureRunId"] = state["captureRunId"].clone();
    });
    fixture.rejects("observed capture witness belongs to a different platform");
}

#[test]
fn rejects_a_rehashed_cli_transcript_named_for_a_different_package() {
    let mut fixture = Fixture::cli("cli-open", "version", "arm64");
    fixture.edit_process_json(0, "process-transcript", |data| {
        data["package"]["archive"] = json!("Sail-0.1.17-arm64.deb");
    });
    fixture.rejects("CLI receipt does not match the installed release asset");

    let mut fixture = Fixture::cli("cli-open", "version", "arm64");
    fixture.edit_process_json(0, "process-transcript", |data| {
        data["package"]["runtimeSha256"] = json!("f".repeat(64));
    });
    fixture.rejects("CLI receipt does not match the installed release asset");
}

#[test]
fn rejects_a_rehashed_cli_pairing_receipt_with_successful_reuse() {
    let mut fixture = Fixture::cli("cli-open", "pair", "arm64");
    fixture.edit_process_json(0, "process-transcript", |data| {
        data["pair"]["browserSession"]["reuseStatus"] = json!(200);
    });
    fixture.rejects("incorrect one-time CLI pairing or cookie grants");
}

#[test]
fn rejects_a_rehashed_copied_home_with_a_changed_saved_message_fingerprint() {
    let mut fixture = Fixture::cli("installer-home", "copied-home-boots", "x64");
    fixture.edit_process_json(0, "state-receipt", |data| {
        data["afterStop"]["messages"] = json!("f".repeat(64));
    });
    fixture.rejects("copied CLI home did not preserve the pinned fixture payloads");
}

#[test]
fn rejects_relabeling_both_witnessed_cli_boots_to_another_os_version() {
    let mut fixture = Fixture::cli("cli-open", "start", "arm64");
    fixture.catalog["observations"][0]["configurationId"] = json!("debian-13.0-arm64-native-fresh");
    for run in 0..2 {
        fixture.catalog["observations"][0]["runs"][run]["environment"]["osVersion"] =
            json!("Debian 13.0");
        fixture.edit_process_json(run, "process-transcript", |data| {
            data["platform"]["osVersion"] = json!("Debian 13.0");
        });
        fixture.refresh_cli_terminal(run);
    }
    fixture.rejects("CLI receipt bytes disagree with the recorded process witness");
}

#[test]
fn rejects_a_fabricated_seed_and_both_copied_home_receipts() {
    let mut fixture = Fixture::cli("installer-home", "copied-home-boots", "arm64");
    let path = fixture
        .directory
        .path()
        .join("runtime/cli-lifecycle-seed.json");
    let mut seed: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    seed["fingerprint"]["messages"] = json!("f".repeat(64));
    fs::write(path, serde_json::to_vec(&seed).unwrap()).unwrap();
    for run in 0..2 {
        fixture.edit_process_json(run, "state-receipt", |data| {
            data["beforeStart"]["messages"] = seed["fingerprint"]["messages"].clone();
            data["afterStop"]["messages"] = seed["fingerprint"]["messages"].clone();
        });
        fixture.refresh_cli_terminal(run);
    }
    fixture.rejects("CLI receipt bytes disagree with the recorded process witness");
}

#[test]
fn rejects_a_terminal_screenshot_from_another_boot() {
    let mut fixture = Fixture::cli("cli-open", "stop", "arm64");
    let first_and_repeat = fixture.catalog["observations"][0]["runs"]
        .as_array_mut()
        .unwrap();
    let repeat = first_and_repeat[1]["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|artifact| artifact["kind"] == "terminal-screenshot")
        .unwrap()
        .clone();
    let first = first_and_repeat[0]["artifacts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|artifact| artifact["kind"] == "terminal-screenshot")
        .unwrap();
    *first = repeat;
    fixture.rejects("terminal PNG does not match the encoded CLI receipts");
}

#[test]
fn rejects_blank_or_transparent_terminal_images_with_matching_metadata() {
    for transparent in [false, true] {
        let mut fixture = Fixture::cli("cli-open", "start", "arm64");
        let image = fixture.catalog["observations"][0]["runs"][0]["artifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|artifact| artifact["kind"] == "terminal-screenshot")
            .unwrap();
        let path = fixture
            .directory
            .path()
            .join(image["path"].as_str().unwrap());
        let mut png = png::Decoder::new(std::io::Cursor::new(fs::read(&path).unwrap()))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; png.output_buffer_size().unwrap()];
        png.next_frame(&mut pixels).unwrap();
        let info = png.info();
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, info.width, info.height);
        encoder.set_color(png::ColorType::Rgb);
        for entry in &info.uncompressed_latin1_text {
            encoder
                .add_text_chunk(entry.keyword.clone(), entry.text.clone())
                .unwrap();
        }
        if transparent {
            encoder.set_trns(vec![0, 220, 0, 229, 0, 237]);
        } else {
            pixels.fill(0);
        }
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&pixels).unwrap();
        writer.finish().unwrap();
        fs::write(path, &bytes).unwrap();
        image["sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
        fixture.rejects("terminal PNG does not match the encoded CLI receipts");
    }
}

#[test]
fn rejects_a_relabeled_cli_boot_with_regenerated_terminal_pixels() {
    let mut fixture = Fixture::cli("cli-open", "stop", "arm64");
    let runs = fixture.catalog["observations"][0]["runs"]
        .as_array_mut()
        .unwrap();
    let first = runs[0]["artifacts"].as_array().unwrap().clone();
    let repeat = runs[1]["artifacts"].as_array_mut().unwrap();
    let observed = repeat
        .iter()
        .find(|record| record["kind"] == "process-transcript")
        .unwrap();
    let original_repeat: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .directory
                .path()
                .join(observed["path"].as_str().unwrap()),
        )
        .unwrap(),
    )
    .unwrap();
    let directory = fixture.directory.path().join("relabeled");
    fs::create_dir(&directory).unwrap();
    for (kind, filename) in [
        ("process-transcript", "process.json"),
        ("state-receipt", "state.json"),
    ] {
        let receipt = first
            .iter()
            .find(|artifact| artifact["kind"] == kind)
            .unwrap();
        let original = fixture
            .directory
            .path()
            .join(receipt["path"].as_str().unwrap());
        let mut editable: Value = serde_json::from_slice(&fs::read(original).unwrap()).unwrap();
        editable["bootId"] = original_repeat["bootId"].clone();
        if kind == "process-transcript" {
            editable["start"]["runtimeIdentity"] = json!({
                "ownerSha256": "0".repeat(64),
                "startedAt": original_repeat["start"]["runtimeIdentity"]["startedAt"],
            });
        } else {
            editable["runtimeOwnerSha256"] = json!("0".repeat(64));
        }
        let bytes = serde_json::to_vec(&editable).unwrap();
        fs::write(directory.join(filename), &bytes).unwrap();
        let target = repeat
            .iter_mut()
            .find(|artifact| artifact["kind"] == kind)
            .unwrap();
        target["path"] = json!(format!("relabeled/{filename}"));
        target["sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
    }
    let result = Command::new(env!("CARGO_BIN_EXE_sail-migration-coverage"))
        .arg("--render-cli")
        .arg(&directory)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let image = repeat
        .iter_mut()
        .find(|artifact| artifact["kind"] == "terminal-screenshot")
        .unwrap();
    image["path"] = json!("relabeled/terminal.png");
    image["sha256"] = json!(format!(
        "{:x}",
        Sha256::digest(fs::read(directory.join("terminal.png")).unwrap())
    ));
    fixture.rejects("CLI receipt disagrees with the recorded process witness");
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

fn reference_with_linux_archive(platform: &str, origin: &str, connection_mode: &str) -> Fixture {
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
    fixture.catalog["platformSets"]["app"] = json!([platform]);
    let surface = fixture.catalog["platforms"][platform]["surface"].clone();
    let observation = &mut fixture.catalog["observations"][0];
    observation["platformId"] = json!(platform);
    let mut receipt_digests = Vec::new();
    for run in observation["runs"].as_array_mut().unwrap() {
        run["environment"]["installerAssetDigest"] = json!(digest);
        run["environment"]["origin"] = json!(origin);
        run["environment"]["connectionMode"] = json!(connection_mode);
        let artifact = run["artifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|artifact| artifact["kind"] == "capture-receipt")
            .unwrap();
        let path = directory.join(artifact["path"].as_str().unwrap());
        let mut capture: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        capture["packageSha256"] = json!(digest);
        capture["coverage"]["platformId"] = json!(platform);
        capture["profile"]["origin"] = json!(origin);
        capture["profile"]["surface"] = surface.clone();
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
    fixture
}

#[test]
fn rejects_a_rehashed_electron_reference_with_a_same_target_cli_archive() {
    let mut fixture =
        reference_with_linux_archive("electron-linux-arm64", "desktop local", "loopback");
    fixture.rejects("Electron reference requires a published desktop installer");
    fixture.catalog["platforms"]["electron-linux-arm64"]["surface"] = json!("cli");
    fixture.rejects("Electron platform ID conflicts with surface metadata");
    fixture.catalog["platforms"]["electron-linux-arm64"]["surface"] = json!("electron");
    fixture.catalog["platforms"]["electron-linux-arm64"]
        .as_object_mut()
        .unwrap()
        .remove("inventoryTarget");
    fixture.rejects("Electron reference requires matching installer target linux-arm64");
}

#[test]
fn rejects_a_rehashed_reference_with_an_installer_for_another_target() {
    let fixture = reference_with_linux_archive(
        "served-chromium-macos",
        "server-served loopback",
        "loopback",
    );
    fixture.rejects("outside target macos-arm64");
}

#[test]
fn rejects_connection_edits_that_disagree_with_the_capture_origin() {
    for mode in [Value::Null, json!("remote")] {
        let mut fixture = reference_with_linux_archive(
            "served-chromium-macos",
            "server-served loopback",
            "loopback",
        );
        for run in fixture.catalog["observations"][0]["runs"]
            .as_array_mut()
            .unwrap()
        {
            run["environment"]["connectionMode"] = mode.clone();
        }
        fixture.rejects("loopback origin requires loopback connection mode");
    }
    let mut fixture = reference_with_linux_archive(
        "served-chromium-macos",
        "server-served loopback",
        "loopback",
    );
    for run in fixture.catalog["observations"][0]["runs"]
        .as_array_mut()
        .unwrap()
    {
        run["environment"]["connectionMode"] = json!("remote");
        run["environment"]["origin"] = json!("remote Linux server");
    }
    fixture.rejects("run origin disagrees with capture receipt");
}

#[test]
fn allows_a_hosted_mac_browser_to_use_a_linux_backend_package() {
    let fixture =
        reference_with_linux_archive("hosted-chromium-macos", "hosted HTTPS fixture", "remote");
    let report = fixture.run();
    assert!(
        report.status.success(),
        "{}",
        String::from_utf8_lossy(&report.stderr)
    );
    let body: Value = serde_json::from_slice(&report.stdout).unwrap();
    assert_eq!(body["verifiedVisualReferenceObservations"], 1);
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

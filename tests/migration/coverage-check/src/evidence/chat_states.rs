use std::path::Path;

use anyhow::{Context, Result, ensure};
use serde_json::json;

use super::{Capture, Evidence, capture_witness};
use crate::catalog::{Observation, Run};

pub(super) fn verify(
    evidence: &Evidence,
    observation: &Observation,
    run: &Run,
    capture: &Capture,
    image: &Path,
) -> Result<()> {
    let state = capture_witness::observed_state(evidence, observation, run, capture)?;
    let name = observation.cell.state.as_str();
    let record = &state["chatStates"][name];
    let profile = &record["profile"];
    let observed = &record["observed"];
    ensure!(
        state["browser"] == "Google Chrome for Testing 158.0.8127.88"
            && state["browser"].as_str() == run.environment.browser_version.as_deref()
            && state["pairing"] == "browser-session-cookie"
            && state["osVersion"] == "Debian 12.15"
            && state["arch"] == "arm64"
            && observation.configuration_id
                == "chrome-158.0.8127.88-debian-arm64-en-light-640x600-2x"
            && observation.cell.entrypoint == "chat"
            && capture.profile["surface"] == "server-served-web"
            && capture.profile["origin"] == "server-served loopback"
            && profile["browser"] == "Chrome/158.0.0.0"
            && profile["theme"] == "light"
            && profile["locale"] == "en"
            && profile["viewport"] == json!({"width": 640, "height": 600, "scale": 2, "zoom": 1})
            && record["screenshotSha256"] == capture.screenshot_sha256,
        "chat state screenshot disagrees with the observed browser profile or pixels"
    );
    for field in ["browser", "locale", "theme", "motion", "fonts", "viewport"] {
        ensure!(
            profile[field] == capture.profile[field],
            "chat state profile disagrees on {field}"
        );
    }
    ensure!(
        observed["replayReply"] == false && observed["focusedElement"] == "BODY",
        "chat state already shows the saved reply or capture focus was not cleared"
    );
    let (action, matches) = match name {
        "empty" => (
            "openEmptyDraft",
            observed["heading"] == "New thread"
                && observed["composer"] == "Message New thread"
                && observed["emptyHint"] == true
                && observed["submitDisabled"] == true
                && observed["mainBranch"] == true
                && observed["loadingLabel"].is_null()
                && observed["unavailable"] == false,
        ),
        "initial-loading" => (
            "holdThreadDetail",
            observed["heading"] == "Compatibility replay"
                && observed["composer"] == "Message Compatibility replay"
                && observed["loadingLabel"] == "Loading messages..."
                && observed["loadingRole"] == "status"
                && observed["loadingSubmitDisabled"] == true
                && observed["heldThreadRpc"] == true
                && observed["unavailable"] == false,
        ),
        "error" => (
            "openUnpairedThread",
            observed["unavailable"] == true
                && observed["unpairedMessage"] == true
                && observed["composer"].is_null()
                && observed["recoveryHref"] == "/settings/connections",
        ),
        _ => anyhow::bail!("unknown Linux Chromium chat state {name}"),
    };
    ensure!(
        matches,
        "browser did not observe the claimed chat state {name}"
    );
    let steps = &capture.trace;
    let first = steps
        .first()
        .context("missing browser chat state observation")?;
    ensure!(
        first.action == action && serde_json::to_value(&first.observed)? == *observed,
        "browser state trace disagrees with the observed screenshot state"
    );
    if name == "initial-loading" {
        let restored = &state["afterRelease"];
        ensure!(
            *restored
                == json!({
                    "title": "Compatibility replay", "reply": true, "openedExpectedThread": true,
                    "table": [["Step", "Tool", "Result"], ["Read", "read", "1 file"],
                        ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"]],
                }),
            "releasing the held thread RPC did not restore the seeded reply and table"
        );
        ensure!(
            steps.len() == 2
                && steps[1].action == "releaseThreadDetail"
                && serde_json::to_value(&steps[1].observed)? == *restored,
            "loading trace disagrees with the observed release of the held RPC"
        );
    } else if name == "error" {
        let recovery = &state["afterRecovery"];
        ensure!(
            *recovery == json!({"path": "/settings/connections"})
                && steps.len() == 2
                && steps[1].action == "openEnvironments"
                && serde_json::to_value(&steps[1].observed)? == *recovery,
            "error trace disagrees with the observed recovery action"
        );
    } else {
        ensure!(
            steps.len() == 1,
            "unexpected extra browser chat state trace step"
        );
    }
    capture_witness::verify_png(image, 1280, 1200)
}

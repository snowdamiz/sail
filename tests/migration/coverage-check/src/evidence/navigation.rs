use std::path::Path;

use anyhow::{Result, ensure};
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
    let cell = &observation.cell;
    let (action_name, action) = match (
        cell.case_id.as_str(),
        cell.state.as_str(),
        cell.entrypoint.as_str(),
    ) {
        ("chat-link", "linked-thread-opened", "chat") => (
            "clickThreadLink",
            json!({
                "sourceTitle": "Navigation source",
                "linkLabel": "Thread, Compatibility replay",
                "clickedDestinationLink": true
            }),
        ),
        ("palette-link", "selected-thread-opened", "command-palette") => (
            "selectPaletteThread",
            json!({
                "sourceTitle": "Navigation source",
                "accelerator": "Ctrl+K",
                "query": "Compatibility replay",
                "highlightedResult": "Compatibility replay",
                "selection": "Enter"
            }),
        ),
        _ => anyhow::bail!("navigation capture does not cover the claimed state and entrypoint"),
    };
    let record = &state["entrypointCaptures"][&cell.case_id];
    let profile = &record["profile"];
    ensure!(
        state["electronVersion"] == "44.10.1"
            && state["osVersion"] == "Debian 13.8"
            && observation.configuration_id
                == "electron-44.10.1-debian-13.8-deb-en-light-1100x780-1x"
            && capture.profile["surface"] == "desktop"
            && capture.profile["browser"].is_null()
            && profile["theme"] == "light"
            && profile["locale"] == "en"
            && profile["viewport"] == json!({"width": 1100, "height": 780, "scale": 1, "zoom": 1})
            && record["screenshotSha256"] == capture.screenshot_sha256,
        "navigation screenshot disagrees with the observed desktop profile or pixels"
    );
    for field in ["locale", "theme", "motion", "fonts", "viewport"] {
        ensure!(
            profile[field] == capture.profile[field],
            "navigation receipt profile disagrees on {field}"
        );
    }
    let destination = &record["destination"];
    ensure!(
        destination
            == &json!({
                "sameSavedRoute": true, "title": "Compatibility replay",
                "focus": "Message Compatibility replay",
                "windowFocusedOnArrival": true, "paletteClosed": true, "reply": true,
                "code": "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0",
                "table": [["Step", "Tool", "Result"], ["Read", "read", "1 file"], ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"]]
            })
            && record["action"] == action,
        "navigation did not prove the saved Replay route and composer focus"
    );
    let [performed, arrived] = capture.trace.as_slice() else {
        anyhow::bail!("expected navigation action followed by the opened destination");
    };
    ensure!(
        performed.action == action_name
            && serde_json::to_value(&performed.observed)? == action
            && arrived.action == "observeSavedDestination"
            && serde_json::to_value(&arrived.observed)? == *destination,
        "navigation trace disagrees with the observed action or destination"
    );
    capture_witness::verify_png(image, 1100, 780)
}

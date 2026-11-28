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
    let chromium = cell.platform_id == "served-chromium-linux";
    let (width, height, scale) = if chromium {
        ensure!(
            state["browser"] == "Google Chrome for Testing 158.0.8127.88"
                && state["browser"].as_str() == run.environment.browser_version.as_deref()
                && state["pairing"] == "browser-session-cookie"
                && state["osVersion"] == "Debian 12.15"
                && state["arch"] == "arm64"
                && observation.configuration_id
                    == "chrome-158.0.8127.88-debian-arm64-en-light-640x600-2x"
                && capture.profile["surface"] == "server-served-web"
                && capture.profile["origin"] == "server-served loopback"
                && profile["browser"] == "Chrome/158.0.0.0",
            "navigation does not match the observed Chromium capture profile"
        );
        ensure!(
            state["seedSha256"]
                == "64fd80ad657dbcaaa159795b1581ede5a7a9e3875d98cac4a8825c12f16cae95"
                && state["stateFingerprint"]
                    == json!({
                        "messages": "f43a5141ecb019bc1e7cb6a32925600c5414a3d2d0310fb68aa228c1420433f5",
                        "runs": "47828771de717dca1fd8a0d75397dc09f74f73f5cf57a5e6ba7e8e410129e5f4"
                    }),
            "Chromium navigation does not preserve the pinned Replay fixture"
        );
        (640, 600, 2)
    } else {
        ensure!(
            state["electronVersion"] == "44.10.1"
                && state["osVersion"] == "Debian 13.8"
                && observation.configuration_id
                    == "electron-44.10.1-debian-13.8-deb-en-light-1100x780-1x"
                && capture.profile["surface"] == "desktop"
                && capture.profile["browser"].is_null(),
            "navigation does not match the observed desktop capture profile"
        );
        (1100, 780, 1)
    };
    ensure!(
        profile["theme"] == "light"
            && profile["locale"] == "en"
            && profile["viewport"]
                == json!({"width": width, "height": height, "scale": scale, "zoom": 1})
            && record["screenshotSha256"] == capture.screenshot_sha256,
        "navigation screenshot disagrees with the observed display profile or pixels"
    );
    for field in ["browser", "locale", "theme", "motion", "fonts", "viewport"] {
        ensure!(
            profile[field] == capture.profile[field],
            "navigation receipt profile disagrees on {field}"
        );
    }
    let destination = &record["destination"];
    let mut expected = json!({
        "sameSavedRoute": true, "title": "Compatibility replay",
        "focus": "Message Compatibility replay",
        "windowFocusedOnArrival": true, "paletteClosed": true, "reply": true,
        "code": "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0",
        "table": [["Step", "Tool", "Result"], ["Read", "read", "1 file"], ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"]]
    });
    if chromium {
        expected["sameActiveEnvironment"] = json!(true);
    }
    ensure!(
        *destination == expected && record["action"] == action,
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
    capture_witness::verify_png(image, width * scale, height * scale)
}

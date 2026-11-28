use std::path::Path;

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

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
    let variant = observation.cell.state.as_str();
    let display = &state["displayCaptures"][variant];
    ensure!(
        display["screenshotSha256"] == capture.screenshot_sha256,
        "display screenshot disagrees with the observed pixels"
    );
    let (width, zoom, locale, theme, action) = match variant {
        "light" => (
            1100,
            1.0,
            "en",
            "light",
            json!({"control": "Use light mode", "selected": true}),
        ),
        "dark" => (
            1100,
            1.0,
            "en",
            "dark",
            json!({"control": "Use dark mode", "selected": true}),
        ),
        "zoomed" => (
            1100,
            1.2,
            "en",
            "light",
            json!({"accelerators": ["Ctrl+0", "Ctrl+=", "Ctrl+="]}),
        ),
        "translated" => (
            1100,
            1.0,
            "de",
            "light",
            json!({"control": "Language", "selected": "Deutsch"}),
        ),
        "compact" => (
            640,
            1.0,
            "en",
            "light",
            json!({"sidebar": "mobile sheet", "closedAfterCheck": true}),
        ),
        "wide" => (
            1280,
            1.0,
            "en",
            "light",
            json!({"sidebar": "docked", "closedAfterCheck": true}),
        ),
        _ => anyhow::bail!("unsupported Linux Electron display state {variant}"),
    };
    let profile = &display["profile"];
    let viewport = &profile["viewport"];
    let renderer = &display["rendererViewport"];
    let attachment = if locale == "de" {
        "Dateien anhängen"
    } else {
        "Attach files"
    };
    let config = format!("electron-44.10.1-debian-13.8-deb-{variant}");
    ensure!(
        observation.configuration_id == config
            && observation.cell.entrypoint == "chat"
            && state["electronVersion"] == "44.10.1"
            && state["osVersion"] == "Debian 13.8"
            && capture.profile["surface"] == "desktop"
            && capture.profile["browser"].is_null()
            && profile["theme"] == theme
            && profile["locale"] == locale
            && viewport["width"] == width
            && viewport["height"] == 780
            && viewport["scale"] == 1
            && viewport["zoom"].as_f64() == Some(zoom)
            && near_zoom(&display["zoom"], zoom)
            && near_zoom(&renderer["scale"], zoom)
            && renderer_size_matches(renderer, width, 780, zoom)
            && display["compact"] == (variant == "compact")
            && display["attachmentControl"] == attachment
            && display["action"] == action,
        "observed Linux Electron behavior does not match display state {variant}"
    );
    for field in ["locale", "theme", "motion", "fonts", "viewport"] {
        ensure!(
            profile[field] == capture.profile[field],
            "display receipt profile disagrees on {field}"
        );
    }
    let chat = &display["chat"];
    ensure!(
        chat["title"] == "Compatibility replay"
            && chat["reply"] == true
            && chat["highlightedCode"] == true
            && chat["menuOpen"] == false
            && chat["composerFocused"] == false
            && chat["sidebarOpen"] == false,
        "display capture lacks the settled Replay view"
    );
    verify_trace(capture, display, &action)?;
    capture_witness::verify_png(image, width, 780)
}

pub(super) fn verify_chromium(
    evidence: &Evidence,
    observation: &Observation,
    run: &Run,
    capture: &Capture,
    image: &Path,
) -> Result<()> {
    let state = capture_witness::observed_state(evidence, observation, run, capture)?;
    let variant = observation.cell.state.as_str();
    let display = &state["displayCaptures"][variant];
    let (width, height, zoom, locale, theme, action) = match variant {
        "light" => (
            960,
            720,
            1.0,
            "en",
            "light",
            json!({"control": "Use light mode", "selected": true}),
        ),
        "dark" => (
            960,
            720,
            1.0,
            "en",
            "dark",
            json!({"control": "Use dark mode", "selected": true}),
        ),
        "zoomed" => (
            960,
            720,
            1.25,
            "en",
            "light",
            json!({
                "control": "Browser panel zoom", "rpc": "preview.adjust", "acceptedFactor": 1.25
            }),
        ),
        "translated" => (
            960,
            720,
            1.0,
            "de",
            "light",
            json!({"control": "Language", "selected": "Deutsch"}),
        ),
        "compact" => (
            640,
            600,
            1.0,
            "en",
            "light",
            json!({"sidebar": "mobile sheet", "closedAfterCheck": true}),
        ),
        "wide" => (
            1280,
            780,
            1.0,
            "en",
            "light",
            json!({"sidebar": "docked", "closedAfterCheck": true}),
        ),
        _ => anyhow::bail!("unsupported Linux Chromium display state {variant}"),
    };
    let profile = &display["profile"];
    let viewport = &profile["viewport"];
    let renderer = &display["rendererViewport"];
    let configuration = format!("chrome-158.0.8127.88-debian-arm64-{variant}");
    ensure!(
        observation.configuration_id == configuration
            && observation.cell.entrypoint == "chat"
            && state["browser"] == "Google Chrome for Testing 158.0.8127.88"
            && state["browser"].as_str() == run.environment.browser_version.as_deref()
            && state["pairing"] == "browser-session-cookie"
            && state["environmentLabel"] == "Compatibility fixture"
            && state["osVersion"] == "Debian 12.15"
            && state["arch"] == "arm64"
            && capture.profile["surface"] == "server-served-web"
            && capture.profile["origin"] == "server-served loopback"
            && profile["browser"] == "Chrome/158.0.0.0"
            && profile["locale"] == locale
            && profile["theme"] == theme
            && profile["motion"] == "standard"
            && viewport["width"] == width
            && viewport["height"] == height
            && viewport["scale"] == 2
            && viewport["zoom"].as_f64() == Some(zoom)
            && renderer_size_matches(renderer, width, height, zoom)
            && near_zoom(&renderer["scale"], 2.0 * zoom)
            && renderer["zoom"] == 1
            && display["compact"] == (variant == "compact")
            && display["attachmentControl"]
                == if locale == "de" {
                    "Dateien anhängen"
                } else {
                    "Attach files"
                }
            && display["action"] == action
            && display["screenshotSha256"] == capture.screenshot_sha256,
        "observed Linux Chromium behavior does not match display state {variant}"
    );
    for field in ["browser", "locale", "theme", "motion", "fonts", "viewport"] {
        ensure!(
            profile[field] == capture.profile[field],
            "display receipt profile disagrees on {field}"
        );
    }
    ensure!(
        state["seedSha256"] == "b76ac23ca172ea7223867b52aef8eb2af96ba46db04d2a829f7531bdce8b4dc6"
            && state["stateFingerprint"]
                == json!({
                    "messages": "575ae62e5027b648775dcb0ab7eada7005d996a4c71223daff6948d104b6d4d6",
                    "runs": "a543ae94a7af7d28ce23d8149c516a62fd9fb4e1da3ce6ebfe152550aac6ef47"
                })
            && display["chat"]
                == json!({
                    "title": "Compatibility replay", "reply": true, "highlightedCode": true,
                    "code": "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0",
                    "table": [["Step", "Tool", "Result"], ["Read", "read", "1 file"], ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"]],
                    "composerFocused": false, "sidebarOpen": false, "menuOpen": false,
                }),
        "display capture lacks the settled Replay view or preserved fixture"
    );
    verify_trace(capture, display, &action)?;
    capture_witness::verify_png(image, width * 2, height * 2)
}

fn verify_trace(capture: &Capture, display: &Value, action: &Value) -> Result<()> {
    let mut observed = display
        .as_object()
        .context("missing display observation")?
        .clone();
    observed.remove("action");
    observed.remove("screenshotSha256");
    let [performed, recorded] = capture.trace.as_slice() else {
        anyhow::bail!("expected appearance action followed by observed display state");
    };
    ensure!(
        performed.action == "setChatDisplay"
            && serde_json::to_value(&performed.observed)? == *action
            && recorded.action == "observeChatDisplay"
            && serde_json::to_value(&recorded.observed)? == Value::Object(observed),
        "display trace disagrees with the observed action or runtime state"
    );
    Ok(())
}

fn renderer_size_matches(viewport: &Value, width: u32, height: u32, scale: f64) -> bool {
    [("width", width), ("height", height)]
        .into_iter()
        .all(|(key, pixels)| {
            viewport[key]
                .as_f64()
                .is_some_and(|css| (css * scale - f64::from(pixels)).abs() < scale)
        })
}

fn near_zoom(value: &Value, factor: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|actual| (actual - factor).abs() < 0.001)
}

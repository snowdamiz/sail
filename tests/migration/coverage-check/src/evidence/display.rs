use std::path::Path;

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

use super::{Capture, Evidence, desktop_capture};
use crate::catalog::{Observation, Run};

pub(super) fn verify(
    evidence: &Evidence,
    observation: &Observation,
    run: &Run,
    capture: &Capture,
    image: &Path,
) -> Result<()> {
    let state = desktop_capture::observed_state(evidence, observation, run, capture)?;
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
            && serde_json::to_value(&performed.observed)? == action
            && recorded.action == "observeChatDisplay"
            && serde_json::to_value(&recorded.observed)? == Value::Object(observed),
        "display trace disagrees with the observed action or runtime state"
    );
    desktop_capture::verify_png(image, width, 780)
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

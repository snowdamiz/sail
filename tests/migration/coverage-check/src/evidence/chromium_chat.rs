use std::path::Path;

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

use super::{Capture, Evidence, capture_witness, is_hex};
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
    let case = observation.cell.case_id.as_str();
    let records = &state[match case {
        "browser-preview" => "previewStates",
        "disconnect-recover" => "reconnectStates",
        "chat-view-states" => "chatStates",
        _ => anyhow::bail!("unknown Linux Chromium capture case {case}"),
    }];
    let record = &records[name];
    let profile = &record["profile"];
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
    match case {
        "browser-preview" => verify_browser_preview(&state, &record["observed"], name, capture)?,
        "disconnect-recover" => {
            ensure!(
                profile["fonts"]
                    .as_array()
                    .is_some_and(|fonts| fonts.len() == 2),
                "reconnect capture must record both body and code fonts"
            );
            verify_reconnect(&state, records, name, capture)?;
        }
        _ => verify_chat_view(&state, &record["observed"], name, capture)?,
    }
    capture_witness::verify_png(image, 1280, 1200)
}

fn verify_chat_view(state: &Value, observed: &Value, name: &str, capture: &Capture) -> Result<()> {
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
    Ok(())
}

fn verify_reconnect(state: &Value, records: &Value, name: &str, capture: &Capture) -> Result<()> {
    let host = &state["host"];
    let owners = [&host["initialOwnerSha256"], &host["restartedOwnerSha256"]];
    ensure!(
        owners
            .iter()
            .all(|owner| owner.as_str().is_some_and(|digest| is_hex(digest, 64)))
            && owners[0] != owners[1]
            && host["sameEnvironment"] == true
            && host["protocol"] == 2
            && host["version"] == "0.1.17"
            && host["databaseMigration"] == 118,
        "reconnect does not bind two packaged host launches from the same home"
    );
    let shutdown = &host["shutdown"];
    ensure!(
        shutdown["signal"] == "SIGINT"
            && shutdown["exitStatus"] == 130
            && shutdown["listener"] == "connection refused"
            && shutdown["runtimeRecordRemoved"] == true
            && shutdown["listenerStillRefusedAfterRetry"] == true,
        "reconnect does not prove the packaged listener stopped"
    );
    ensure!(
        state["session"]
            == json!({"sameBrowserDocument": true, "sameBrowserCookieSession": true,
                                    "webSocketReconnected": true}),
        "reconnect did not reopen the socket on the same browser document and cookie session"
    );
    let seed: Value = serde_json::from_str(include_str!(
        "../../../incumbent/runtime/cli-lifecycle-seed.json"
    ))?;
    ensure!(
        state["database"]
            == json!({"seedSha256": seed["seedDatabaseSha256"],
            "before": seed["fingerprint"], "after": seed["fingerprint"]}),
        "reconnect did not preserve the pinned Replay message and run payloads"
    );
    let steps = [
        ("online", "typeDraft"),
        ("offline", "stopHost"),
        ("reconnecting", "retryWhileStopped"),
        ("recovered", "restartHostAndRestore"),
    ];
    let index = steps
        .iter()
        .position(|(state_name, _)| *state_name == name)
        .context("unknown Linux Chromium reconnect state")?;
    ensure!(
        capture.trace.len() == index + 1,
        "unexpected reconnect action trace length"
    );
    ensure!(
        records["offline"]["screenshotSha256"] != records["recovered"]["screenshotSha256"],
        "offline and recovered screenshot pixels must differ"
    );
    for ((state_name, action), step) in steps.iter().zip(&capture.trace) {
        let connected = matches!(*state_name, "online" | "recovered");
        let banners = if !connected {
            json!(["Compatibility fixture is reconnecting", "Retry now"])
        } else {
            json!([])
        };
        let expected = json!({
            "title": "Compatibility replay",
            "reply": true,
            "code": "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0",
            "table": [["Step", "Tool", "Result"], ["Read", "read", "1 file"],
                ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"]],
            "draft": "P01 draft survives reconnect",
            "sendAvailable": connected,
            "focusedElement": "BODY",
            "banner": banners,
        });
        ensure!(
            records[state_name]["observed"] == expected
                && step.action == *action
                && serde_json::to_value(&step.observed)? == expected,
            "reconnect trace disagrees with the observed {state_name} state"
        );
    }
    Ok(())
}

fn verify_browser_preview(
    state: &Value,
    observed: &Value,
    name: &str,
    capture: &Capture,
) -> Result<()> {
    const URL: &str = "http://127.0.0.1:47720/";
    let panel = json!({
        "address": URL, "canvasVisible": true, "panelMaximized": true,
        "originalTitle": false, "updatedTitle": true, "focusedElement": "BODY",
    });
    ensure!(
        state["pageSha256"] == "0bce63921bffbda9218078ad2f454ad850061bd492f01e9f26a80984503b3e7c"
            && state["titleChange"]
                == json!({
                    "before": "Original title", "after": "Updated title", "url": URL,
                    "sameInnerTab": true, "releasedByClient": true,
                })
            && *observed == panel,
        "Browser panel capture disagrees with the pinned page or title change"
    );
    let value = json!({"title": "Updated title", "body": "Click to rename"});
    let tool = json!({
        "name": "preview_evaluate",
        "expression": "({title: document.title, body: document.body.textContent.trim()})",
        "value": value,
    });
    let provider_run = json!({"status": "completed", "reply": value});
    ensure!(
        state["tool"] == tool && state["providerRun"] == provider_run,
        "Browser tool result disagrees with the completed provider turn"
    );
    let steps = [
        (
            "openFixturePage",
            json!({"title": "Original title", "url": URL}),
        ),
        (
            "renamePageThroughCanvas",
            json!({"title": "Updated title", "url": URL, "sameInnerTab": true}),
        ),
        (
            "releaseBrowserControl",
            json!({"owner": "unclaimed", "panel": panel}),
        ),
        (
            "evaluateInnerTab",
            json!({"tool": tool, "providerRun": provider_run}),
        ),
    ];
    let count = match name {
        "preview-rendered" => 3,
        "tool-result" => 4,
        _ => anyhow::bail!("unknown Linux Chromium Browser panel state {name}"),
    };
    ensure!(
        capture.trace.len() == count,
        "wrong Browser panel action trace length"
    );
    for ((action, expected), step) in steps.into_iter().zip(&capture.trace) {
        ensure!(
            step.action == action && serde_json::to_value(&step.observed)? == expected,
            "Browser panel trace disagrees with the observed {action} result"
        );
    }
    Ok(())
}

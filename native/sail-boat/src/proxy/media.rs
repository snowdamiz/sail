//! WebSockets and streams relayed to the machine, with a media ticket the proxy issues itself in
//! the URL (an image or a WebSocket cannot send a header) or its bearer token.
//!
//! Device and browser-preview streams are live pictures of what runs on the machine, so they
//! exist only while it runs. Sail keeps retrying one while it is on screen, so they never wake
//! the machine: a sleeping one answers 503. Any other socket (dictation, and whatever T3 adds) is
//! opened by a person and wakes it.

use super::auth::TicketUse;
use super::{client_authorized, query_param, query_without, relay, unauthorized, upstream, upstream_bearer, wake, Relay, M};
use crate::machine::{MachineRuntime, Power};
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame as DownClose, Message as DownMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpClose;
use tokio_tungstenite::tungstenite::{Error as UpError, Message as UpMsg};

/// Sail acknowledges every preview frame with this: the one message a stream sends with
/// nobody touching it.
const FRAME_ACK: &str = r#"{"type":"ack"}"#;

/// `/api/device-hub/*` and `/api/preview-stream/*`: plain requests (snapshots, MJPEG and
/// event streams, uploads) and WebSockets alike.
pub async fn stream(
    State(m): M,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    if let Ok(upgrade) = upgrade {
        return socket(m, upgrade, &parts, false).await;
    }
    let Some(target) = authorized_target(&m, &parts) else {
        return unauthorized();
    };
    // Anything but a read is someone working the device or the browser.
    if parts.method != Method::GET && parts.method != Method::HEAD {
        m.user_action();
    }
    let route = Relay { target, authorization: upstream_bearer(&m), wake: false };
    relay(&m, parts, body, route).await
}

/// Relays a WebSocket to the same path on the machine. `wakes`: a sleeping machine is woken for
/// it; otherwise it answers 503.
pub(super) async fn socket(m: Arc<MachineRuntime>, upgrade: WebSocketUpgrade, parts: &Parts, wakes: bool) -> Response {
    let Some(target) = authorized_target(&m, parts) else {
        return unauthorized();
    };
    if m.power() != Power::Running
        && let Err(res) = wake(&m, wakes, &target).await
    {
        return res;
    }
    match upstream::connect(&m.upstream_url(), &m.upstream_token(), &target).await {
        Ok(up) => upgrade.on_upgrade(move |down| pump(m, down, up)),
        // The machine's own refusal (no device hub, say) reaches Sail as it was.
        Err(e) => match e.downcast_ref() {
            Some(UpError::Http(res)) => res.status().into_response(),
            _ => (StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response(),
        },
    }
}

/// Path and query on the machine, minus the proxy's ticket; `None` if the caller holds neither a
/// media ticket nor a token of this proxy.
fn authorized_target(m: &MachineRuntime, parts: &Parts) -> Option<String> {
    let query = parts.uri.query().unwrap_or_default();
    let ticketed = query_param(query, "wsTicket").is_some_and(|t| m.auth.check_ticket(&t, TicketUse::Media));
    (ticketed || client_authorized(m, &parts.headers))
        .then(|| format!("{}?{}", parts.uri.path(), query_without(query, &["wsTicket"])))
}

/// Passes frames both ways until either side ends, close code and reason included: Sail
/// reads them to tell a closed tab from a stream to reopen.
async fn pump(m: Arc<MachineRuntime>, down: WebSocket, up: upstream::Upstream) {
    let (mut to_client, mut from_client) = down.split();
    let (mut to_machine, mut from_machine) = up.split();
    let upward = async {
        let mut ping = tokio::time::interval(upstream::PING);
        loop {
            let msg = tokio::select! {
                msg = from_client.next() => {
                    let Some(Ok(msg)) = msg else { break };
                    // A click or a key in the stream is someone using the machine. Watching is
                    // not: an open preview must not keep it from sleeping.
                    if is_input(&msg) {
                        m.user_action();
                    }
                    machine_message(msg)
                }
                _ = ping.tick() => Some(UpMsg::Ping(Default::default())),
            };
            if let Some(msg) = msg {
                if to_machine.send(msg).await.is_err() {
                    break;
                }
            }
        }
    };
    let downward = async {
        // Pongs count: only a machine that stopped answering falls silent.
        while let Ok(Some(Ok(msg))) = tokio::time::timeout(upstream::SILENCE, from_machine.next()).await {
            if let Some(msg) = client_message(msg) {
                if to_client.send(msg).await.is_err() {
                    break;
                }
            }
        }
    };
    tokio::select! {
        _ = upward => {}
        _ = downward => {}
    }
}

fn is_input(msg: &DownMsg) -> bool {
    match msg {
        DownMsg::Text(text) => text.as_str() != FRAME_ACK,
        DownMsg::Binary(_) => true,
        _ => false,
    }
}

/// Each side answers its own pings; the rest crosses over as it is.
fn machine_message(msg: DownMsg) -> Option<UpMsg> {
    Some(match msg {
        DownMsg::Text(text) => UpMsg::text(text.as_str()),
        DownMsg::Binary(bytes) => UpMsg::Binary(bytes),
        DownMsg::Close(frame) => {
            UpMsg::Close(frame.map(|f| UpClose { code: f.code.into(), reason: f.reason.as_str().into() }))
        }
        DownMsg::Ping(_) | DownMsg::Pong(_) => return None,
    })
}

fn client_message(msg: UpMsg) -> Option<DownMsg> {
    Some(match msg {
        UpMsg::Text(text) => DownMsg::text(text.as_str()),
        UpMsg::Binary(bytes) => DownMsg::Binary(bytes),
        UpMsg::Close(frame) => {
            DownMsg::Close(frame.map(|f| DownClose { code: f.code.into(), reason: f.reason.as_str().into() }))
        }
        UpMsg::Ping(_) | UpMsg::Pong(_) | UpMsg::Frame(_) => return None,
    })
}

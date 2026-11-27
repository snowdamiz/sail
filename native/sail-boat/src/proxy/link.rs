//! Linked environments through the proxy. Another T3 server on this computer (the desktop
//! app's own) links to the machine at the proxy's address, so agents here can work there
//! (`delegate_task`, the thread tools). The link is made with the machine's server itself: the
//! proxy relays its OAuth endpoints and `/mcp`, and remembers the token only to know which
//! calls may wake the machine.

use super::{auth, relay, target, Relay, M};
use crate::machine::{MachineRuntime, Power};
use crate::store::LinkToken;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderName, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Linking exchanges a few small JSON and form bodies.
const MAX_STEP_BODY: usize = 64 * 1024;

/// A step of linking. Anyone can call these, so they never wake the machine; whoever links got
/// a pairing code from it moments ago.
fn step(parts: &Parts) -> Relay {
    Relay { target: target(&parts.uri), authorization: None, wake: false }
}

/// What the machine's server calls itself. The linker asks for a token for the address it
/// knows, the proxy's, and the server only issues tokens for its own.
fn resource(m: &MachineRuntime) -> String {
    format!("{}/mcp", m.upstream_url())
}

pub async fn register(State(m): M, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let route = step(&parts);
    relay(&m, parts, body, route).await
}

pub async fn decision(State(m): M, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let Ok(body) = axum::body::to_bytes(body, MAX_STEP_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let body = decision_for(&body, &resource(&m)).unwrap_or_else(|| body.to_vec());
    let route = step(&parts);
    relay(&m, parts, Body::from(body), route).await
}

/// The decision with `resource` as what it asks a token for. `None`: not a decision the server
/// would take anyway.
fn decision_for(body: &[u8], resource: &str) -> Option<Vec<u8>> {
    let mut decision: Value = serde_json::from_slice(body).ok()?;
    *decision.get_mut("authorization")?.get_mut("resource")? = resource.into();
    serde_json::to_vec(&decision).ok()
}

/// The token request with `resource` as what it asks a token for.
fn token_request_for(body: &[u8], resource: &str) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(
            url::form_urlencoded::parse(body).map(|(k, v)| if k == "resource" { (k, resource.into()) } else { (k, v) }),
        )
        .finish()
}

pub async fn token(State(m): M, req: Request) -> Response {
    #[derive(Deserialize)]
    struct Issued {
        access_token: String,
        expires_in: i64,
    }
    let (mut parts, body) = req.into_parts();
    let Ok(body) = axum::body::to_bytes(body, MAX_STEP_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let form = token_request_for(&body, &resource(&m));
    // The answer is read here, so it must come uncompressed.
    parts.headers.remove(header::ACCEPT_ENCODING);
    let route = step(&parts);
    let res = relay(&m, parts, Body::from(form), route).await;
    if !res.status().is_success() {
        return res;
    }
    let (head, body) = res.into_parts();
    let Ok(body) = axum::body::to_bytes(body, MAX_STEP_BODY).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if let Ok(issued) = serde_json::from_slice::<Issued>(&body) {
        let now = chrono::Utc::now().timestamp();
        m.update_record(|r| {
            r.link_tokens.retain(|t| t.expires_at > now);
            r.link_tokens.push(LinkToken { token: issued.access_token, expires_at: now + issued.expires_in });
        });
        tracing::info!("a T3 server linked to {}", m.id());
    }
    Response::from_parts(head, Body::from(body))
}

/// The machine's tools, as a linked T3 server calls them. A call bearing a token issued
/// through the proxy wakes a sleeping machine and counts as using it; anything else reaches a
/// running machine only, which judges it itself. The proxy never answers 401 on its own: a
/// linker takes that as the link being revoked and fails its tasks there for good.
pub async fn mcp(State(m): M, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let now = chrono::Utc::now().timestamp();
    let linked = auth::bearer(&parts.headers)
        .is_some_and(|t| m.record().link_tokens.iter().any(|l| l.token == t && l.expires_at > now));
    let call = linked && parts.method == Method::POST;
    let Ok(body) = axum::body::to_bytes(body, super::MAX_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    if call {
        if m.power() != Power::Running {
            if let Some(res) = handshake(&m, &body) {
                return res;
            }
        }
        m.user_action();
    }
    let route = Relay {
        target: target(&parts.uri),
        authorization: parts.headers.get(header::AUTHORIZATION).cloned(),
        wake: call,
    };
    relay(&m, parts, Body::from(body), route).await
}

pub async fn client_pairing(State(m): M, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    if parts.headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let now = chrono::Utc::now().timestamp();
    let linked = auth::bearer(&parts.headers)
        .is_some_and(|t| m.record().link_tokens.iter().any(|l| l.token == t && l.expires_at > now));
    if !linked {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(body) = axum::body::to_bytes(body, MAX_STEP_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let route = Relay {
        target: target(&parts.uri),
        authorization: parts.headers.get(header::AUTHORIZATION).cloned(),
        wake: false,
    };
    relay(&m, parts, Body::from(body), route).await
}

/// A linker gives the handshake that opens its MCP session 3 s, less than a wake takes; its
/// tool calls may wait for minutes. So for a sleeping machine the proxy answers the handshake
/// itself and starts the wake. The call that follows waits for the machine, which answers 404
/// to a session it never opened, and the linker opens a real one, as it does after any
/// restart there.
fn handshake(m: &Arc<MachineRuntime>, body: &[u8]) -> Option<Response> {
    let msg: Value = serde_json::from_slice(body).ok()?;
    match msg["method"].as_str()? {
        "initialize" => {
            let m = m.clone();
            tracing::info!("waking {} for a linked T3 server", m.id());
            tokio::spawn(async move {
                let _ = m.ensure_awake().await;
            });
            let session = [(HeaderName::from_static("mcp-session-id"), auth::random_token())];
            let result = json!({
                "protocolVersion": msg["params"]["protocolVersion"],
                "capabilities": {},
                "serverInfo": {"name": "sail", "version": env!("CARGO_PKG_VERSION")},
            });
            Some((session, Json(json!({"jsonrpc": "2.0", "id": msg["id"], "result": result}))).into_response())
        }
        "notifications/initialized" => Some(StatusCode::ACCEPTED.into_response()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MACHINE: &str = "https://box.example/mcp";

    #[test]
    fn linking_asks_for_a_token_for_the_machine() {
        let decision = json!({
            "authorization": {"client_id": "c", "resource": "http://localhost:47732/mcp", "state": "s"},
            "decision": {"_tag": "pairing-code", "access": "full-access", "code": "K"},
        });
        let sent: Value = serde_json::from_slice(&decision_for(decision.to_string().as_bytes(), MACHINE).unwrap()).unwrap();
        assert_eq!(sent["authorization"]["resource"], MACHINE);
        assert_eq!(sent["authorization"]["state"], "s");
        assert_eq!(sent["decision"], decision["decision"]);
        assert!(decision_for(b"{}", MACHINE).is_none());

        let form = "grant_type=authorization_code&code=a%2Bb&resource=http%3A%2F%2Flocalhost%3A47732%2Fmcp";
        assert_eq!(
            token_request_for(form.as_bytes(), MACHINE),
            "grant_type=authorization_code&code=a%2Bb&resource=https%3A%2F%2Fbox.example%2Fmcp"
        );
    }
}

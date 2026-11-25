//! One Sail WebSocket. While the machine runs, frames pass through to its server. While it
//! sleeps, the proxy answers what it truthfully can (nothing changes on a stopped machine) and
//! wakes the machine for everything else, bar the side information a chat shows: that waits
//! for the next wake. After a wake it closes the socket once the calls in flight are answered,
//! so Sail reconnects and resyncs on its own.

use super::cache::{refresh_server_time, request_key, sanitize_server_config, Shell};
use super::classify::{self, recorded_stream, recorded_unary};
use super::threads::ThreadFlags;
use super::{assets, upstream};
use crate::machine::{MachineRuntime, Power};
use anyhow::Result;
use axum::extract::ws::{CloseFrame, Message as DownMsg, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as UpMsg;

/// A safety net only: calls in flight, including long operations, finish first.
const CLOSE_AFTER_WAKE_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_CONNECT_ATTEMPTS: u32 = 3;
/// "Service restart": Sail reconnects at once.
const CLOSE_RECONNECT: u16 = 1012;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Settling,
    Asleep,
    Waking,
    Connecting,
    Live,
}

struct Forwarded {
    id: Value,
    tag: String,
    key: String,
    /// The cache epoch it was asked in: the state its answer describes.
    epoch: u64,
    /// A unary read whose answer is recorded.
    record: bool,
    chunks: usize,
}

enum Internal {
    Settled(Power),
    Woke(Result<()>),
    Connected(Result<upstream::Upstream>),
    Up(Option<String>),
    /// The upstream socket is gone; the machine's power when checked after.
    UpstreamLost(Power),
    CloseNow,
}

pub async fn run(machine: Arc<MachineRuntime>, socket: WebSocket, client_query: String) {
    tracing::info!("Sail connected to {}", machine.id());
    let (down, mut down_rx) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut s = Session {
        m: machine,
        down,
        query: client_query,
        phase: Phase::Settling,
        up: None,
        up_task: None,
        forwarded: HashMap::new(),
        cached: HashSet::new(),
        held: Vec::new(),
        close_after_calls: false,
        connect_attempts: 0,
        tx,
    };
    s.settle();

    let mut power = s.m.subscribe_power();
    let close = loop {
        let step = tokio::select! {
            Ok(()) = power.changed() => {
                let now = *power.borrow_and_update();
                s.on_power(now)
            }
            msg = down_rx.next() => match msg {
                Some(Ok(DownMsg::Text(text))) => s.on_down(text.as_str()).await,
                Some(Ok(DownMsg::Close(_))) | None | Some(Err(_)) => break None,
                Some(Ok(_)) => Ok(None),
            },
            Some(ev) = rx.recv() => s.on_internal(ev).await,
        };
        match step {
            Ok(None) => {}
            Ok(Some(reason)) => break Some(reason),
            Err(e) => {
                tracing::warn!("session error: {e:#}");
                break Some("proxy error".to_owned());
            }
        }
    };
    tracing::info!("Sail socket closing ({close:?})");
    if let Some(reason) = close {
        let _ = s.down.send(DownMsg::Close(Some(CloseFrame { code: CLOSE_RECONNECT, reason: reason.into() }))).await;
    }
    s.drop_upstream();
}

struct Session {
    m: Arc<MachineRuntime>,
    down: SplitSink<WebSocket, DownMsg>,
    query: String,
    phase: Phase,
    up: Option<mpsc::UnboundedSender<UpMsg>>,
    up_task: Option<JoinHandle<()>>,
    /// Requests sent upstream on this socket, by request id.
    forwarded: HashMap<String, Forwarded>,
    /// Streams answered locally, left open.
    cached: HashSet<String>,
    /// Requests waiting for the machine.
    held: Vec<Value>,
    /// After a wake: close for a resync once no call is in flight.
    close_after_calls: bool,
    connect_attempts: u32,
    tx: mpsc::UnboundedSender<Internal>,
}

/// `Some(reason)` closes the client socket so Sail reconnects.
type Step = Result<Option<String>>;

pub(super) fn id_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn exit_success(id: &Value, value: Value) -> Value {
    json!({"_tag": "Exit", "requestId": id, "exit": {"_tag": "Success", "value": value}})
}

fn exit_die(id: &Value, message: &str) -> Value {
    json!({"_tag": "Exit", "requestId": id, "exit": {"_tag": "Failure", "cause": [{"_tag": "Die", "defect": message}]}})
}

fn exit_interrupt(id: &Value) -> Value {
    json!({"_tag": "Exit", "requestId": id, "exit": {"_tag": "Failure", "cause": [{"_tag": "Interrupt", "fiberId": null}]}})
}

fn chunk(id: &Value, values: Vec<Value>) -> Value {
    json!({"_tag": "Chunk", "requestId": id, "values": values})
}

/// Effect RPC accepts one message or an array of them per frame.
pub(super) fn messages(text: &str) -> Result<Vec<Value>> {
    Ok(match serde_json::from_str::<Value>(text)? {
        Value::Array(items) => items,
        one => vec![one],
    })
}

impl Session {
    async fn send(&mut self, msg: &Value) -> Result<()> {
        self.down.send(DownMsg::text(msg.to_string())).await?;
        Ok(())
    }

    fn send_up(&self, msg: &Value) {
        if let Some(up) = &self.up {
            let _ = up.send(UpMsg::text(msg.to_string()));
        }
    }

    /// Learns whether the machine runs without blocking this socket's loop.
    fn settle(&self) {
        let m = self.m.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(Internal::Settled(m.settled_power().await));
        });
    }

    async fn on_down(&mut self, text: &str) -> Step {
        for msg in messages(text)? {
            let id = msg.get("requestId").map(id_key);
            match msg["_tag"].as_str().unwrap_or_default() {
                // Liveness of the client socket is the proxy's job, awake or not.
                "Ping" => self.send(&json!({"_tag": "Pong"})).await?,
                "Pong" => {}
                "Request" => self.on_request(msg).await?,
                "Interrupt" => {
                    let id = id.unwrap_or_default();
                    if self.forwarded.contains_key(&id) {
                        self.send_up(&msg);
                    } else if self.cached.remove(&id) || self.take_held(&id) {
                        self.send(&exit_interrupt(&msg["requestId"])).await?;
                    }
                }
                _ if self.phase == Phase::Live => self.send_up(&msg),
                _ => {}
            }
        }
        Ok(None)
    }

    fn take_held(&mut self, id: &str) -> bool {
        let before = self.held.len();
        self.held.retain(|r| id_key(&r["id"]) != id);
        before != self.held.len()
    }

    async fn on_request(&mut self, req: Value) -> Result<()> {
        let tag = req["tag"].as_str().unwrap_or_default().to_owned();
        tracing::debug!(phase = ?self.phase, "rpc {tag}");
        let action = classify::is_user_action(&tag, &req["payload"]);
        match self.phase {
            // A machine about to freeze must not take new work: wait for it, then resume it on
            // a fresh upstream.
            Phase::Live if action && self.m.is_stopping() => {
                self.fail_upstream().await?;
                self.held.push(req);
                self.wake();
            }
            Phase::Live => self.forward(req),
            Phase::Asleep => self.on_asleep(req).await?,
            Phase::Settling | Phase::Waking | Phase::Connecting => self.held.push(req),
        }
        Ok(())
    }

    /// A request to a sleeping machine: answered locally where possible, else held. Side
    /// information waits unanswered for the next wake; anything else wakes the machine.
    async fn on_asleep(&mut self, req: Value) -> Result<()> {
        if let Some(replies) = self.answer_locally(&req) {
            for r in replies {
                self.send(&r).await?;
            }
            return Ok(());
        }
        let tag = req["tag"].as_str().unwrap_or_default();
        if !classify::is_side_info(tag, &req["payload"]) {
            tracing::info!("waking {} for {tag}", self.m.id());
            self.wake();
        }
        self.held.push(req);
        Ok(())
    }

    fn forward(&mut self, req: Value) {
        let tag = req["tag"].as_str().unwrap_or_default().to_owned();
        let payload = &req["payload"];
        let key = request_key(&tag, payload);
        let record = recorded_unary(&tag, payload);
        // Counted only when it reaches the machine: a call answered locally changes nothing.
        if classify::is_user_action(&tag, payload) {
            self.m.user_action();
        }
        if tag == "orchestration.subscribeThread"
            && let Some(flags) = ThreadFlags::from_payload(payload)
        {
            self.m.cache.lock().unwrap().thread_encoding = Some(flags);
        }
        let epoch = self.m.cache.lock().unwrap().epoch;
        self.forwarded
            .insert(id_key(&req["id"]), Forwarded { id: req["id"].clone(), tag, key, epoch, record, chunks: 0 });
        self.send_up(&req);
    }

    /// A call or finite stream awaits its answer from the machine.
    fn calls_in_flight(&self) -> bool {
        self.forwarded.values().any(|f| !classify::is_subscription(&f.tag))
    }

    /// What the proxy can answer for a sleeping machine without lying. `None`: needs the machine.
    fn answer_locally(&mut self, req: &Value) -> Option<Vec<Value>> {
        let id = &req["id"];
        let tag = req["tag"].as_str()?;
        let payload = &req["payload"];
        let open = |s: &mut Self| {
            s.cached.insert(id_key(id));
        };
        if tag == "server.probe" {
            return Some(vec![exit_success(id, json!({}))]);
        }
        if classify::is_void_signal(tag) {
            return Some(vec![exit_success(id, Value::Null)]);
        }
        if classify::SILENT_STREAMS.contains(&tag) {
            open(self);
            return Some(vec![]);
        }
        let key = request_key(tag, payload);
        if classify::is_background_probe(tag, payload) {
            let value = self.m.cache.lock().unwrap().unary(&key, true);
            // A URL whose bytes are not on this computer would only fail to load.
            let value = value.filter(|v| {
                tag != "assets.createUrl" || assets::answer_path(self.m.dir(), v).is_some_and(|f| f.exists())
            });
            return Some(vec![value.map_or_else(|| exit_die(id, "machine is asleep"), |v| exit_success(id, v))]);
        }
        if classify::is_connection_stream(tag) {
            let mut items = self.m.cache.lock().unwrap().stream(&key)?;
            if tag == "subscribeServerConfig" {
                items.iter_mut().for_each(refresh_server_time);
            }
            open(self);
            return Some(vec![chunk(id, items)]);
        }
        // Everything else describes state, so it is only true if the machine slept the way the
        // proxy saw it: confirmed capture, nothing run since.
        let capture = self.m.fresh_capture()?;
        match tag {
            "orchestration.subscribeShell" => {
                let synchronized = json!({"kind": "synchronized"});
                let items = match capture.shell(payload["afterSequence"].as_u64())? {
                    Shell::UpToDate => vec![synchronized],
                    Shell::Snapshot(snapshot) => vec![json!({"kind": "snapshot", "snapshot": snapshot}), synchronized],
                };
                open(self);
                Some(vec![chunk(id, items)])
            }
            "orchestration.subscribeThread" => {
                let thread = payload["threadId"].as_str()?;
                let high_water = capture.threads.get(thread).copied().unwrap_or(0);
                // The server's own rule: a cursor at the thread's high-water missed nothing.
                // Any other client gets the chat as the machine sleeps with it.
                let mut items = Vec::new();
                if payload["afterSequence"].as_u64() != Some(high_water) {
                    let body = self.m.stored_thread(&capture, thread, ThreadFlags::from_payload(payload)?)?;
                    let mut snapshot: Value = serde_json::from_slice(&body).ok()?;
                    snapshot.as_object_mut()?.insert("kind".into(), "snapshot".into());
                    items.push(snapshot);
                }
                if payload["requestCompletionMarker"].as_bool() == Some(true) {
                    items.push(json!({"kind": "synchronized"}));
                }
                open(self);
                Some(if items.is_empty() { vec![] } else { vec![chunk(id, items)] })
            }
            "orchestration.dispatchCommand" => {
                let kind = payload["type"].as_str()?;
                let wakes = classify::WAKING_COMMANDS.contains(&kind);
                if !wakes && !classify::DEFERRABLE_COMMANDS.contains(&kind) {
                    return None;
                }
                self.m.cache.lock().unwrap().deferred_commands.push(payload.clone());
                self.m.save_cache();
                if wakes {
                    tracing::info!("waking {} for {kind}", self.m.id());
                    self.wake();
                }
                Some(vec![exit_success(id, json!({"sequence": capture.sequence}))])
            }
            _ if recorded_stream(tag).is_some() => {
                let items = self.m.cache.lock().unwrap().stream(&key)?;
                open(self);
                Some(vec![chunk(id, items)])
            }
            _ if recorded_unary(tag, payload) => {
                let value = self.m.cache.lock().unwrap().unary(&key, classify::serves_last_seen(tag, payload))?;
                Some(vec![exit_success(id, value)])
            }
            _ => None,
        }
    }

    fn wake(&mut self) {
        if matches!(self.phase, Phase::Waking | Phase::Connecting) {
            return;
        }
        self.phase = Phase::Waking;
        let m = self.m.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(Internal::Woke(m.ensure_awake().await));
        });
    }

    fn connect(&mut self) {
        self.phase = Phase::Connecting;
        self.connect_attempts += 1;
        let (url, token, query) = (self.m.upstream_url(), self.m.upstream_token(), self.query.clone());
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(Internal::Connected(upstream::connect(&url, &token, &upstream::rpc_target(&query)).await));
        });
    }

    /// The machine was deleted: the socket closes. It woke for someone else: a socket parked on
    /// cached answers goes live, once what it holds went upstream.
    fn on_power(&mut self, power: Power) -> Step {
        if power == Power::Missing {
            return Ok(Some("machine deleted".into()));
        }
        if power != Power::Running || self.phase != Phase::Asleep {
            return Ok(None);
        }
        if self.held.is_empty() && !self.cached.is_empty() {
            return Ok(Some("machine woke".into()));
        }
        self.connect();
        Ok(None)
    }

    async fn on_internal(&mut self, ev: Internal) -> Step {
        match ev {
            Internal::Settled(Power::Running) => self.connect(),
            Internal::Settled(_) => self.go_asleep().await?,
            Internal::Woke(Ok(())) => self.connect(),
            Internal::Woke(Err(e)) => {
                let msg = format!("The machine could not wake: {e:#}");
                for req in std::mem::take(&mut self.held) {
                    self.send(&exit_die(&req["id"], &msg)).await?;
                }
                self.phase = Phase::Asleep;
            }
            Internal::Connected(Ok(ws)) => {
                self.connect_attempts = 0;
                self.attach_upstream(ws);
                self.phase = Phase::Live;
                return self.release_held();
            }
            Internal::Connected(Err(e)) => {
                tracing::warn!("upstream connect for {}: {e:#}", self.m.id());
                if self.connect_attempts >= MAX_CONNECT_ATTEMPTS {
                    return Ok(Some("machine unreachable".into()));
                }
                // Asleep after all, or not ready yet: a wake sorts out both.
                self.phase = Phase::Asleep;
                self.wake();
            }
            Internal::Up(Some(text)) => return self.on_up(&text).await,
            Internal::Up(None) => return self.on_upstream_lost().await,
            Internal::UpstreamLost(power) => return self.after_upstream_lost(power).await,
            Internal::CloseNow => return Ok(Some("machine woke".into())),
        }
        Ok(None)
    }

    /// The machine sleeps: what was held meanwhile is handled like any request to it.
    async fn go_asleep(&mut self) -> Result<()> {
        self.phase = Phase::Asleep;
        for req in std::mem::take(&mut self.held) {
            self.on_asleep(req).await?;
        }
        Ok(())
    }

    fn release_held(&mut self) -> Step {
        let held = std::mem::take(&mut self.held);
        if self.cached.is_empty() {
            held.into_iter().for_each(|r| self.forward(r));
            return Ok(None);
        }
        // Streams answered from cache cannot turn live in place: finish the calls and finite
        // streams, then close so Sail resubscribes against the live server.
        held.into_iter()
            .filter(|r| !classify::is_subscription(r["tag"].as_str().unwrap_or_default()))
            .for_each(|r| self.forward(r));
        if !self.calls_in_flight() {
            return Ok(Some("machine woke".into()));
        }
        self.close_after_calls = true;
        let tx = self.tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(CLOSE_AFTER_WAKE_TIMEOUT).await;
            let _ = tx.send(Internal::CloseNow);
        });
        Ok(None)
    }

    fn attach_upstream(&mut self, ws: upstream::Upstream) {
        let (mut sink, mut stream) = ws.split();
        let (up_tx, mut up_rx) = mpsc::unbounded_channel::<UpMsg>();
        let tx = self.tx.clone();
        let task = tokio::spawn(async move {
            let mut ping = tokio::time::interval(upstream::PING);
            let mut deadline = tokio::time::Instant::now() + upstream::SILENCE;
            loop {
                tokio::select! {
                    out = up_rx.recv() => match out {
                        Some(m) => if sink.send(m).await.is_err() { break },
                        None => break,
                    },
                    _ = ping.tick() => if sink.send(UpMsg::Ping(Default::default())).await.is_err() { break },
                    _ = tokio::time::sleep_until(deadline) => break,
                    inbound = stream.next() => {
                        deadline = tokio::time::Instant::now() + upstream::SILENCE;
                        match inbound {
                            Some(Ok(UpMsg::Text(t))) => { let _ = tx.send(Internal::Up(Some(t.to_string()))); }
                            Some(Ok(UpMsg::Close(_))) | Some(Err(_)) | None => break,
                            Some(Ok(_)) => {}
                        }
                    }
                }
            }
            let _ = tx.send(Internal::Up(None));
        });
        self.up = Some(up_tx);
        self.up_task = Some(task);
    }

    fn drop_upstream(&mut self) {
        self.up = None;
        if let Some(t) = self.up_task.take() {
            t.abort();
        }
        for (id, f) in self.forwarded.drain() {
            if classify::is_subscription(&f.tag) {
                self.cached.insert(id);
            }
        }
    }

    async fn on_up(&mut self, text: &str) -> Step {
        for mut msg in messages(text)? {
            let id = msg.get("requestId").map(id_key).unwrap_or_default();
            match msg["_tag"].as_str().unwrap_or_default() {
                "Pong" => continue,
                "Chunk" => {
                    if let Some(f) = self.forwarded.get_mut(&id) {
                        if let Some(values) = msg.get_mut("values").and_then(Value::as_array_mut) {
                            if f.tag == "subscribeServerConfig" {
                                values.iter_mut().filter_map(|v| v.get_mut("config")).for_each(sanitize_server_config);
                            }
                            let first = f.chunks == 0;
                            f.chunks += 1;
                            self.m.cache.lock().unwrap().record_stream_items(&f.tag, &f.key, values, first);
                        }
                    }
                }
                "Exit" => {
                    let success = msg["exit"]["_tag"] == "Success";
                    if !success {
                        tracing::debug!("rpc failed: {}", msg["exit"]["cause"][0]["_tag"]);
                    }
                    let value = msg["exit"].get_mut("value");
                    if let (Some(f), true, Some(value)) = (self.forwarded.remove(&id), success, value) {
                        if f.tag == "server.getConfig" {
                            sanitize_server_config(value);
                        }
                        if f.record {
                            let mut cache = self.m.cache.lock().unwrap();
                            if f.tag == "server.refreshProviders" {
                                cache.fold_providers(&value["providers"]);
                            }
                            if f.tag == "assets.createUrl"
                                && let Some(earlier) = cache.unary.get(&f.key)
                            {
                                assets::carry(self.m.dir(), &earlier.value, value);
                            }
                            cache.record_unary(&f.key, f.epoch, value);
                        }
                    }
                }
                _ => {}
            }
            self.send(&msg).await?;
            if self.close_after_calls && msg["_tag"] == "Exit" && !self.calls_in_flight() {
                return Ok(Some("machine woke".into()));
            }
        }
        Ok(None)
    }

    /// Calls and finite streams in flight upstream fail; subscriptions stay open on the client,
    /// now answered by nobody (their state is final if the machine went to sleep).
    async fn fail_upstream(&mut self) -> Result<()> {
        let failed: Vec<Value> =
            self.forwarded.values().filter(|f| !classify::is_subscription(&f.tag)).map(|f| f.id.clone()).collect();
        self.drop_upstream();
        for id in failed {
            self.send(&exit_die(&id, "The machine went to sleep")).await?;
        }
        Ok(())
    }

    /// Fails the old upstream, then checks why it went, off the loop.
    async fn on_upstream_lost(&mut self) -> Step {
        self.fail_upstream().await?;
        if self.phase != Phase::Live {
            // A wake of ours is under way and will reconnect.
            return Ok(None);
        }
        self.phase = Phase::Settling;
        let m = self.m.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let power = m.refresh_power().await.unwrap_or(Power::Unknown);
            let power = if matches!(power, Power::Stopping | Power::Stopped) { m.settled_power().await } else { power };
            let _ = tx.send(Internal::UpstreamLost(power));
        });
        Ok(None)
    }

    async fn after_upstream_lost(&mut self, power: Power) -> Step {
        // A network blip, or a sleep the client may have missed the end of (the laptop slept
        // too): let Sail reconnect and resync.
        if power != Power::Stopped || self.m.fresh_capture().is_none() {
            return Ok(Some("upstream lost".into()));
        }
        // The machine went to sleep under an open socket, the way the proxy saw it: the
        // client's view stays true; keep the socket and answer locally from here.
        tracing::info!("{} went to sleep with a client attached", self.m.id());
        self.go_asleep().await?;
        Ok(None)
    }
}

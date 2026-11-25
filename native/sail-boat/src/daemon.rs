//! Headless HTTP + SSE control daemon (`sail-boatd`) that bridges the Sail Electron main process
//! with the Sail Boat Rust engine and MCP server.

use crate::app::{self, App, Costs, MachineView, Setup};
use crate::boat::Boat;
use crate::machine::provision::{SizeInfo, SIZES};
use crate::machine::Event;
use crate::mcp;
use crate::store::Settings;
use crate::t3desktop;
use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::header::{AUTHORIZATION, HOST};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, Stream};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;

const COSTS_EVERY: Duration = Duration::from_secs(300);
const EVENT_CHANNEL_CAPACITY: usize = 64;

#[derive(Clone, Debug)]
pub struct DaemonConfig {
    pub control_port: u16,
    pub mcp_port: u16,
    pub token: String,
    pub data_dir: PathBuf,
}

impl DaemonConfig {
    pub fn from_env() -> Result<Self> {
        let control_port = std::env::var("SAIL_BOAT_CONTROL_PORT")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .map(|v| v.parse::<u16>().context("parsing SAIL_BOAT_CONTROL_PORT"))
            .transpose()?
            .unwrap_or(0);
        let mcp_port = mcp::configured_port();
        let token = std::env::var("SAIL_BOAT_TOKEN")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(generate_hex_token);
        let data_dir = t3desktop::data_dir()?;
        Ok(Self { control_port, mcp_port, token, data_dir })
    }
}

/// Generates a 256-bit lowercase hex token for control API authentication.
pub fn generate_hex_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Handshake emitted once on stdout as a single JSON line after listeners are bound.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub ready: bool,
    pub port: u16,
    pub token: String,
    pub mcp_port: u16,
}

/// Whether each coding agent CLI has Sail's MCP server; `None` means the CLI is not installed.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub claude_code: Option<bool>,
    pub codex: Option<bool>,
}

#[derive(Clone, Debug, Default)]
struct SetupState {
    setup: Setup,
    busy: bool,
    /// The code Boat's sign-in page may ask for while a sign-in is pending.
    sign_in_code: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub identifier: Option<String>,
    pub plan: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub setup: Setup,
    pub setup_busy: bool,
    pub sign_in_code: Option<String>,
    pub account: Option<Account>,
    pub machines: Vec<MachineView>,
    pub costs: Costs,
    pub settings: Settings,
    pub sizes: &'static [SizeInfo],
    pub mcp: McpStatus,
    pub mcp_url: String,
    pub version: &'static str,
}

#[derive(Clone, Debug)]
enum StreamEvent {
    State(String),
    Notify(String),
    DesktopAction(String),
}

impl StreamEvent {
    fn into_sse(self) -> SseEvent {
        match self {
            Self::State(data) => SseEvent::default().event("state").data(data),
            Self::Notify(data) => SseEvent::default().event("notify").data(data),
            Self::DesktopAction(data) => SseEvent::default().event("desktop_action").data(data),
        }
    }
}

/// Tracks live SSE desktop consumers so desktop actions route through SSE while Electron is
/// attached and fall back to OS open otherwise.
struct DesktopConsumerGuard(Arc<AtomicUsize>);

impl DesktopConsumerGuard {
    fn acquire(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        Self(counter)
    }
}

impl Drop for DesktopConsumerGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

enum CmdErr {
    BadRequest(String),
    Internal(String),
}

impl CmdErr {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            Self::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };
        (status, Json(json!({ "ok": false, "error": error }))).into_response()
    }
}

fn err(e: anyhow::Error) -> CmdErr {
    CmdErr::Internal(format!("{e:#}"))
}

fn parse_args<T: for<'de> Deserialize<'de>>(name: &str, body: &Bytes) -> std::result::Result<T, CmdErr> {
    let value: Value = if body.iter().all(|b| b.is_ascii_whitespace()) {
        json!({})
    } else {
        serde_json::from_slice(body)
            .map_err(|e| CmdErr::BadRequest(format!("invalid JSON body for {name}: {e}")))?
    };
    serde_json::from_value(value)
        .map_err(|e| CmdErr::BadRequest(format!("invalid arguments for {name}: {e}")))
}

pub struct Daemon {
    app: Arc<Mutex<Option<Arc<App>>>>,
    setup: Mutex<SetupState>,
    account: Mutex<Option<Account>>,
    mcp: Mutex<McpStatus>,
    mcp_port: u16,
    token: String,
    data_dir: PathBuf,
    events_tx: broadcast::Sender<StreamEvent>,
    desktop_consumers: Arc<AtomicUsize>,
    /// One `init` at a time: startup and `recheck` must not both construct an `App`.
    init_lock: tokio::sync::Mutex<()>,
    shutdown_tx: watch::Sender<bool>,
    background_tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Daemon {
    pub fn new(token: String, data_dir: PathBuf, mcp_port: u16) -> Arc<Self> {
        let (events_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (shutdown_tx, _) = watch::channel(false);
        Arc::new(Self {
            app: Arc::new(Mutex::new(None)),
            setup: Mutex::new(SetupState::default()),
            account: Mutex::new(None),
            mcp: Mutex::new(McpStatus::default()),
            mcp_port,
            token,
            data_dir,
            events_tx,
            desktop_consumers: Arc::new(AtomicUsize::new(0)),
            init_lock: tokio::sync::Mutex::new(()),
            shutdown_tx,
            background_tasks: Mutex::new(Vec::new()),
        })
    }

    pub fn app_slot(&self) -> Arc<Mutex<Option<Arc<App>>>> {
        self.app.clone()
    }

    fn app(&self) -> std::result::Result<Arc<App>, CmdErr> {
        self.app
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| CmdErr::Internal("Sail Boat is not set up yet".to_owned()))
    }

    pub fn state(&self) -> UiState {
        let setup = self.setup.lock().unwrap().clone();
        let app = self.app.lock().unwrap().clone();
        UiState {
            setup: setup.setup,
            setup_busy: setup.busy,
            sign_in_code: setup.sign_in_code,
            account: self.account.lock().unwrap().clone(),
            machines: app.as_ref().map(|a| a.views()).unwrap_or_default(),
            costs: app.as_ref().map(|a| a.costs()).unwrap_or_default(),
            settings: app.as_ref().map(|a| a.settings()).unwrap_or_default(),
            sizes: SIZES,
            mcp: self.mcp.lock().unwrap().clone(),
            mcp_url: mcp::url_for_port(self.mcp_port),
            version: env!("CARGO_PKG_VERSION"),
        }
    }

    fn state_json(&self) -> String {
        serde_json::to_string(&self.state()).unwrap_or_else(|_| "{}".to_owned())
    }

    fn emit_state(&self) {
        let _ = self.events_tx.send(StreamEvent::State(self.state_json()));
    }

    fn emit_notify(&self, title: &str, body: &str) {
        let payload = json!({ "title": title, "body": body }).to_string();
        let _ = self.events_tx.send(StreamEvent::Notify(payload));
    }

    fn emit_desktop_action(&self, action: Value) {
        let _ = self.events_tx.send(StreamEvent::DesktopAction(action.to_string()));
    }

    fn open_url(&self, url: &str) -> anyhow::Result<()> {
        if self.desktop_consumers.load(Ordering::Relaxed) > 0 {
            self.emit_desktop_action(json!({ "type": "openUrl", "url": url }));
            return Ok(());
        }
        app::open_url(url)
    }

    pub fn request_shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    pub fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown_tx.subscribe()
    }

    pub fn shutdown_app(&self) {
        for task in self.background_tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        if let Some(app) = self.app.lock().unwrap().clone() {
            app.shutdown();
        }
    }

    /// Checks Boat and Sail desktop CLI installs and starts the engine once ready.
    pub async fn init(self: &Arc<Self>) {
        let _guard = self.init_lock.lock().await;
        if self.app.lock().unwrap().is_some() {
            return;
        }
        let (setup, boat, t3) = app::check_setup().await;
        self.setup.lock().unwrap().setup = setup;
        if let Some(boat) = &boat {
            self.refresh_account(boat).await;
        }
        if let (Setup::Ready, Some(boat), Some(t3)) = (setup, boat, t3) {
            let (tx, rx) = mpsc::unbounded_channel();
            let t3 = t3.with_desktop_events(tx.clone(), self.desktop_consumers.clone());
            match App::new(boat, t3, self.data_dir.clone(), tx) {
                Ok(app) => {
                    *self.app.lock().unwrap() = Some(app.clone());
                    let mut tasks = self.background_tasks.lock().unwrap();
                    tasks.push(tokio::spawn(event_loop(self.clone(), app.clone(), rx)));
                    tasks.push(tokio::spawn(background_loop(self.clone(), app)));
                    let daemon = self.clone();
                    tasks.push(tokio::spawn(async move { daemon.refresh_mcp().await }));
                }
                Err(e) => self.emit_notify("Sail Boat could not start", &format!("{e:#}")),
            }
        }
        self.emit_state();
    }

    async fn refresh_account(&self, boat: &Boat) {
        if let Ok(a) = boat.account().await {
            *self.account.lock().unwrap() = Some(Account { identifier: a.identifier, plan: a.plan });
        }
    }

    async fn refresh_mcp(&self) {
        let status = mcp_status().await;
        *self.mcp.lock().unwrap() = status;
        self.emit_state();
    }

    async fn handle_command(self: Arc<Self>, name: &str, body: Bytes) -> std::result::Result<Value, CmdErr> {
        match name {
            "get_state" => Ok(serde_json::to_value(self.state()).map_err(|e| CmdErr::Internal(e.to_string()))?),
            "create_machine" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Args {
                    name: String,
                    size: String,
                    #[serde(default)]
                    projects: Vec<String>,
                }
                let args: Args = parse_args(name, &body)?;
                self.app()?
                    .create_machine(&args.name, &args.size, args.projects)
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "local_projects" => {
                let projects = self.app()?.local_projects().await.map_err(err)?;
                serde_json::to_value(projects).map_err(|e| CmdErr::Internal(e.to_string()))
            }
            "add_project" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Args {
                    id: String,
                    #[serde(alias = "project_id")]
                    project_id: String,
                }
                let args: Args = parse_args(name, &body)?;
                let app = self.app()?;
                let machine = app.machine(&args.id).map_err(err)?;
                app.add_project(&machine, &args.project_id)
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "wake_machine" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                self.app()?
                    .machine(&args.id)
                    .map_err(err)?
                    .ensure_awake()
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "sleep_machine" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                self.app()?
                    .machine(&args.id)
                    .map_err(err)?
                    .sleep_now()
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "open_machine" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                    #[serde(default)]
                    thread: Option<String>,
                }
                let args: Args = parse_args(name, &body)?;
                let app = self.app()?;
                let machine = app.machine(&args.id).map_err(err)?;
                app.open_in_t3(&machine, args.thread.as_deref())
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "pair_machine" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                let app = self.app()?;
                let machine = app.machine(&args.id).map_err(err)?;
                app.pair(&machine).map(|_| Value::Null).map_err(err)
            }
            "latest_thread" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                let thread = self.app()?.machine(&args.id).map_err(err)?.latest_thread().await;
                serde_json::to_value(thread).map_err(|e| CmdErr::Internal(e.to_string()))
            }
            "get_machine_details" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                let details = self.app()?.details(&args.id).map_err(err)?;
                serde_json::to_value(details).map_err(|e| CmdErr::Internal(e.to_string()))
            }
            "sign_in_agent" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                    agent: String,
                }
                let args: Args = parse_args(name, &body)?;
                let agent = crate::machine::signin::Agent::from_name(&args.agent).ok_or_else(|| {
                    CmdErr::BadRequest(format!("{} has to be signed in from Sail's settings", args.agent))
                })?;
                self.app()?
                    .machine(&args.id)
                    .map_err(err)?
                    .sign_in(agent)
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "turn_on_connect" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                self.app()?
                    .machine(&args.id)
                    .map_err(err)?
                    .turn_on_connect()
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "keep_awake" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                    #[serde(default)]
                    minutes: Option<u32>,
                }
                let args: Args = parse_args(name, &body)?;
                self.app()?
                    .machine(&args.id)
                    .map_err(err)?
                    .keep_awake(args.minutes)
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "resize_machine" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                    size: String,
                }
                let args: Args = parse_args(name, &body)?;
                self.app()?
                    .machine(&args.id)
                    .map_err(err)?
                    .resize(&args.size)
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "delete_machine" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                    #[serde(default)]
                    discard: bool,
                }
                let args: Args = parse_args(name, &body)?;
                let app = self.app()?;
                let machine = app.machine(&args.id).map_err(err)?;
                app.delete_machine(&machine, args.discard)
                    .await
                    .map(|_| Value::Null)
                    .map_err(err)
            }
            "update_settings" => {
                #[derive(Deserialize)]
                struct Args {
                    settings: Settings,
                }
                let args: Args = parse_args(name, &body)?;
                let app = self.app()?;
                app.update_settings(args.settings);
                self.emit_state();
                Ok(Value::Null)
            }
            "setup_action" => {
                #[derive(Deserialize)]
                struct Args {
                    action: String,
                }
                let args: Args = parse_args(name, &body)?;
                self.setup_action(&args.action).await?;
                Ok(Value::Null)
            }
            "add_mcp" => {
                #[derive(Deserialize)]
                struct Args {
                    client: mcp::Client,
                }
                let args: Args = parse_args(name, &body)?;
                let result = mcp::register(args.client, self.mcp_port).await.map_err(err);
                self.refresh_mcp().await;
                result.map(|_| Value::Null)
            }
            "shutdown" | "quit_app" => {
                self.request_shutdown();
                Ok(Value::Null)
            }
            other => Err(CmdErr::BadRequest(format!("unknown command {other}"))),
        }
    }

    async fn setup_action(self: &Arc<Self>, action: &str) -> std::result::Result<(), CmdErr> {
        let set_busy = |busy: bool| {
            self.setup.lock().unwrap().busy = busy;
            self.emit_state();
        };
        match action {
            "installBoat" => {
                set_busy(true);
                let result = install_boat().await;
                set_busy(false);
                result.map_err(err)?;
            }
            "signInBoat" => {
                let boat = Boat::locate().ok_or_else(|| CmdErr::Internal("Boat CLI not found".to_owned()))?;
                set_busy(true);
                let result = self.sign_in_boat(&boat).await;
                self.setup.lock().unwrap().sign_in_code = None;
                set_busy(false);
                result.map_err(err)?;
            }
            "installT3" => {}
            "recheck" => {}
            other => return Err(CmdErr::BadRequest(format!("unknown setup action {other}"))),
        }
        if self.app.lock().unwrap().is_none() {
            self.init().await;
        } else if let Ok(app) = self.app() {
            self.refresh_account(&app.shared.boat).await;
            self.emit_state();
        }
        Ok(())
    }

    /// Boat's browser sign-in: opens its page, publishes the code the page may ask for, and waits.
    async fn sign_in_boat(&self, boat: &Boat) -> Result<()> {
        let sign_in = boat.start_sign_in().await?;
        self.setup.lock().unwrap().sign_in_code = sign_in.code;
        self.emit_state();
        self.open_url(&sign_in.url)?;
        boat.finish_sign_in().await
    }
}

async fn mcp_status() -> McpStatus {
    let status = |client| async move {
        if mcp::installed(client).await { Some(mcp::registered(client).await) } else { None }
    };
    let (claude_code, codex) = tokio::join!(status(mcp::Client::ClaudeCode), status(mcp::Client::Codex));
    McpStatus { claude_code, codex }
}

async fn install_boat() -> Result<()> {
    let status = if cfg!(windows) {
        crate::process::command("powershell")
            .args(["-NoProfile", "-Command", "irm https://boat.dev/install.ps1 | iex"])
            .status()
            .await?
    } else {
        crate::process::command("sh")
            .args(["-c", "curl -fsSL https://boat.dev/install | sh"])
            .status()
            .await?
    };
    anyhow::ensure!(status.success(), "the Boat installer failed");
    Ok(())
}

async fn event_loop(daemon: Arc<Daemon>, app: Arc<App>, mut rx: mpsc::UnboundedReceiver<Event>) {
    while let Some(ev) = rx.recv().await {
        match ev {
            Event::Persist => app.save(),
            Event::Changed => daemon.emit_state(),
            Event::Notify { title, body } => daemon.emit_notify(&title, &body),
            Event::OpenUrl { url } => daemon.emit_desktop_action(json!({ "type": "openUrl", "url": url })),
            Event::Activate => daemon.emit_desktop_action(json!({ "type": "activate" })),
        }
    }
}

/// Costs and the account change slowly; refreshed on a timer.
async fn background_loop(daemon: Arc<Daemon>, app: Arc<App>) {
    let mut shutdown = daemon.subscribe_shutdown();
    loop {
        app.refresh_costs().await;
        daemon.refresh_account(&app.shared.boat).await;
        daemon.emit_state();
        tokio::select! {
            _ = tokio::time::sleep(COSTS_EVERY) => {}
            _ = shutdown.changed() => if *shutdown.borrow() { break; },
        }
    }
}

pub fn router(daemon: Arc<Daemon>) -> Router {
    let protected = Router::new()
        .route("/api/state", get(get_state))
        .route("/api/events", get(events_stream))
        .route("/api/command/{name}", post(run_command))
        .layer(middleware::from_fn_with_state(daemon.clone(), auth_and_host_guard));
    Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .with_state(daemon)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn get_state(State(daemon): State<Arc<Daemon>>) -> impl IntoResponse {
    Json(daemon.state())
}

async fn events_stream(
    State(daemon): State<Arc<Daemon>>,
) -> Sse<impl Stream<Item = std::result::Result<SseEvent, Infallible>>> {
    let guard = DesktopConsumerGuard::acquire(daemon.desktop_consumers.clone());
    let rx = daemon.events_tx.subscribe();
    let shutdown = daemon.subscribe_shutdown();
    let initial = StreamEvent::State(daemon.state_json());
    let stream = stream::unfold(
        (daemon, rx, shutdown, Some(initial), guard),
        |(daemon, mut rx, mut shutdown, mut pending, guard)| async move {
            if *shutdown.borrow() {
                return None;
            }
            if let Some(first) = pending.take() {
                return Some((Ok(first.into_sse()), (daemon, rx, shutdown, None, guard)));
            }
            loop {
                tokio::select! {
                    _ = shutdown.changed() => {
                        if *shutdown.borrow() {
                            return None;
                        }
                    }
                    msg = rx.recv() => match msg {
                        Ok(ev) => return Some((Ok(ev.into_sse()), (daemon, rx, shutdown, None, guard))),
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let resync = StreamEvent::State(daemon.state_json());
                            return Some((Ok(resync.into_sse()), (daemon, rx, shutdown, None, guard)));
                        }
                        Err(broadcast::error::RecvError::Closed) => return None,
                    }
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn run_command(State(daemon): State<Arc<Daemon>>, Path(name): Path<String>, body: Bytes) -> Response {
    match daemon.handle_command(&name, body).await {
        Ok(data) => Json(json!({ "ok": true, "data": data })).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn auth_and_host_guard(State(daemon): State<Arc<Daemon>>, req: Request, next: Next) -> Response {
    if !is_loopback_host(req.headers().get(HOST).and_then(|h| h.to_str().ok())) {
        return (StatusCode::FORBIDDEN, Json(json!({ "ok": false, "error": "forbidden host" }))).into_response();
    }
    let bearer = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let query_token = if bearer.is_none() && req.method() == Method::GET && req.uri().path() == "/api/events" {
        req.uri().query().and_then(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .find(|(k, _)| k == "token")
                .map(|(_, v)| v.into_owned())
        })
    } else {
        None
    };
    let provided = bearer.or(query_token.as_deref());
    if !provided.is_some_and(|t| constant_time_eq(t.as_bytes(), daemon.token.as_bytes())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "ok": false, "error": "unauthorized" }))).into_response();
    }
    next.run(req).await
}

fn is_loopback_host(host: Option<&str>) -> bool {
    host.is_some_and(|h| {
        url::Url::parse(&format!("http://{h}"))
            .is_ok_and(|u| matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

async fn wait_shutdown(mut rx: watch::Receiver<bool>) {
    while !*rx.borrow_and_update() {
        if rx.changed().await.is_err() {
            break;
        }
    }
}

/// Running daemon servers and handles for clean shutdown.
pub struct RunningDaemon {
    pub handshake: Handshake,
    pub daemon: Arc<Daemon>,
    tasks: Vec<JoinHandle<()>>,
}

impl RunningDaemon {
    pub async fn wait_for_shutdown(&self) {
        wait_shutdown(self.daemon.subscribe_shutdown()).await;
    }

    pub async fn shutdown(self) {
        self.daemon.request_shutdown();
        self.daemon.shutdown_app();
        for task in self.tasks {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
    }
}

/// Binds the control API and MCP listeners, spawns their servers and startup setup check, and
/// returns the handshake ready to print to stdout.
pub async fn start(config: DaemonConfig) -> Result<RunningDaemon> {
    let control_listener = tokio::net::TcpListener::bind(("127.0.0.1", config.control_port))
        .await
        .with_context(|| format!("binding control port {}", config.control_port))?;
    let control_port = control_listener.local_addr()?.port();

    let (mcp_listener, mcp_port) = match mcp::bind(config.mcp_port).await {
        Ok(bound) => bound,
        Err(e) if config.mcp_port != 0 => {
            tracing::warn!("MCP port {} unavailable ({e:#}); falling back to ephemeral port", config.mcp_port);
            mcp::bind(0).await?
        }
        Err(e) => return Err(e),
    };

    let daemon = Daemon::new(config.token.clone(), config.data_dir, mcp_port);
    let handshake = Handshake { ready: true, port: control_port, token: config.token, mcp_port };

    let control_shutdown = wait_shutdown(daemon.subscribe_shutdown());
    let control_router = router(daemon.clone());
    let control_task = tokio::spawn(async move {
        if let Err(e) = axum::serve(control_listener, control_router)
            .with_graceful_shutdown(control_shutdown)
            .await
        {
            tracing::error!("control server exited with error: {e:#}");
        }
    });

    let mcp_shutdown = wait_shutdown(daemon.subscribe_shutdown());
    let app_slot = daemon.app_slot();
    let mcp_task = tokio::spawn(async move {
        if let Err(e) = mcp::serve_slot(mcp_listener, app_slot, mcp_shutdown).await {
            tracing::error!("MCP server exited with error: {e:#}");
        }
    });

    let init_daemon = daemon.clone();
    let init_task = tokio::spawn(async move {
        init_daemon.init().await;
    });

    Ok(RunningDaemon { handshake, daemon, tasks: vec![control_task, mcp_task, init_task] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    async fn spawn_test_daemon() -> (RunningDaemon, PathBuf) {
        let dir = std::env::temp_dir().join(format!("sail-boat-daemon-test-{:016x}", rand::random::<u64>()));
        let config = DaemonConfig {
            control_port: 0,
            mcp_port: 0,
            token: "test-secret-token-123".to_owned(),
            data_dir: dir.clone(),
        };
        (start(config).await.unwrap(), dir)
    }

    async fn stop_test_daemon(running: RunningDaemon, dir: PathBuf) {
        running.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn health_is_unauthenticated_and_returns_ok() {
        let (running, dir) = spawn_test_daemon().await;
        let url = format!("http://127.0.0.1:{}/api/health", running.handshake.port);
        let res = reqwest::Client::new().get(&url).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body, json!({ "ok": true }));
        stop_test_daemon(running, dir).await;
    }

    #[tokio::test]
    async fn state_and_commands_reject_missing_or_wrong_auth_and_non_loopback_host() {
        let (running, dir) = spawn_test_daemon().await;
        let port = running.handshake.port;
        let client = reqwest::Client::new();

        let no_auth = client.get(format!("http://127.0.0.1:{port}/api/state")).send().await.unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);

        let wrong_auth = client
            .get(format!("http://127.0.0.1:{port}/api/state"))
            .header(AUTHORIZATION, "Bearer wrong-token")
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_auth.status(), StatusCode::UNAUTHORIZED);

        let bad_host = client
            .get(format!("http://127.0.0.1:{port}/api/state"))
            .header(HOST, "evil.example.com")
            .header(AUTHORIZATION, format!("Bearer {}", running.handshake.token))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_host.status(), StatusCode::FORBIDDEN);

        let cmd_no_auth = client
            .post(format!("http://127.0.0.1:{port}/api/command/get_state"))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(cmd_no_auth.status(), StatusCode::UNAUTHORIZED);

        let events_no_auth = client.get(format!("http://127.0.0.1:{port}/api/events")).send().await.unwrap();
        assert_eq!(events_no_auth.status(), StatusCode::UNAUTHORIZED);

        stop_test_daemon(running, dir).await;
    }

    #[tokio::test]
    async fn state_returns_full_ui_contract_payload() {
        let (running, dir) = spawn_test_daemon().await;
        let port = running.handshake.port;
        let res = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/state"))
            .header(AUTHORIZATION, format!("Bearer {}", running.handshake.token))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body: Value = res.json().await.unwrap();
        assert!(body["setup"].is_string());
        assert!(body["setupBusy"].is_boolean());
        assert!(body["machines"].is_array());
        assert!(body["costs"].is_object());
        assert!(body["settings"].is_object());
        assert_eq!(body["sizes"].as_array().map(Vec::len), Some(3));
        assert!(body["mcp"].is_object());
        assert_eq!(body["mcpUrl"], mcp::url_for_port(running.handshake.mcp_port));
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        stop_test_daemon(running, dir).await;
    }

    #[tokio::test]
    async fn sse_events_accepts_query_token_and_emits_initial_state_snapshot() {
        let (running, dir) = spawn_test_daemon().await;
        let port = running.handshake.port;
        let url = format!("http://127.0.0.1:{port}/api/events?token={}", running.handshake.token);
        let res = reqwest::Client::new().get(&url).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let found = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(chunk) = stream.next().await {
                let bytes = chunk.unwrap();
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if buf.contains("\n\n") {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap();
        assert!(found, "expected SSE event frame, got: {buf}");
        assert!(buf.contains("event: state"), "expected state event, got: {buf}");
        let data_line = buf.lines().find(|l| l.starts_with("data: ")).unwrap();
        let parsed: Value = serde_json::from_str(data_line.strip_prefix("data: ").unwrap()).unwrap();
        assert!(parsed["setup"].is_string());
        assert_eq!(parsed["mcpUrl"], mcp::url_for_port(running.handshake.mcp_port));

        drop(stream);
        stop_test_daemon(running, dir).await;
    }

    #[tokio::test]
    async fn sse_events_routes_desktop_actions_and_notifications_while_connected() {
        let (running, dir) = spawn_test_daemon().await;
        let port = running.handshake.port;
        let res = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/events"))
            .header(AUTHORIZATION, format!("Bearer {}", running.handshake.token))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(chunk) = stream.next().await {
                buf.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
                if buf.contains("event: state") && buf.contains("\n\n") {
                    break;
                }
            }
        })
        .await
        .unwrap();

        running.daemon.open_url("sail://pair?pairingUrl=http%3A%2F%2F127.0.0.1%3A47732").unwrap();
        running.daemon.emit_notify("Sail Boat", "Machine ready");

        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(chunk) = stream.next().await {
                buf.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
                if buf.contains("event: desktop_action") && buf.contains("event: notify") {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(buf.contains("sail://pair?pairingUrl="), "missing openUrl action in SSE stream: {buf}");
        assert!(buf.contains("Machine ready"), "missing notify payload in SSE stream: {buf}");

        stop_test_daemon(running, dir).await;
    }

    #[tokio::test]
    async fn unknown_command_returns_bad_request_and_recheck_succeeds() {
        let (running, dir) = spawn_test_daemon().await;
        let port = running.handshake.port;
        let auth = format!("Bearer {}", running.handshake.token);
        let client = reqwest::Client::new();

        let unknown = client
            .post(format!("http://127.0.0.1:{port}/api/command/does_not_exist"))
            .header(AUTHORIZATION, &auth)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        let body: Value = unknown.json().await.unwrap();
        assert_eq!(body["ok"], false);
        assert!(body["error"].as_str().unwrap_or_default().contains("unknown command"));

        let bad_setup = client
            .post(format!("http://127.0.0.1:{port}/api/command/setup_action"))
            .header(AUTHORIZATION, &auth)
            .json(&json!({ "action": "bogus" }))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_setup.status(), StatusCode::BAD_REQUEST);

        let recheck = client
            .post(format!("http://127.0.0.1:{port}/api/command/setup_action"))
            .header(AUTHORIZATION, &auth)
            .json(&json!({ "action": "recheck" }))
            .send()
            .await
            .unwrap();
        assert_eq!(recheck.status(), StatusCode::OK);
        let recheck_body: Value = recheck.json().await.unwrap();
        assert_eq!(recheck_body, json!({ "ok": true, "data": null }));

        let get_state_cmd = client
            .post(format!("http://127.0.0.1:{port}/api/command/get_state"))
            .header(AUTHORIZATION, &auth)
            .send()
            .await
            .unwrap();
        assert_eq!(get_state_cmd.status(), StatusCode::OK);
        let state_body: Value = get_state_cmd.json().await.unwrap();
        assert_eq!(state_body["ok"], true);
        assert!(state_body["data"]["setup"].is_string());

        stop_test_daemon(running, dir).await;
    }

    #[tokio::test]
    async fn shutdown_command_signals_clean_exit() {
        let (running, dir) = spawn_test_daemon().await;
        let port = running.handshake.port;
        let res = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/api/command/shutdown"))
            .header(AUTHORIZATION, format!("Bearer {}", running.handshake.token))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        tokio::time::timeout(Duration::from_secs(2), running.wait_for_shutdown())
            .await
            .expect("shutdown signal should fire");
        stop_test_daemon(running, dir).await;
    }

    #[test]
    fn host_validation_accepts_loopback_and_rejects_external_hosts() {
        assert!(is_loopback_host(Some("127.0.0.1:47731")));
        assert!(is_loopback_host(Some("localhost:47731")));
        assert!(is_loopback_host(Some("[::1]:47731")));
        assert!(is_loopback_host(Some("127.0.0.1")));
        assert!(!is_loopback_host(Some("example.com:47731")));
        assert!(!is_loopback_host(Some("127.0.0.1.evil.com:47731")));
        assert!(!is_loopback_host(None));
    }
}

use crate::app::{self, App, Costs, MachineView, Setup};
use crate::boat::Boat;
use crate::machine::signin::{Agent, Login, Phase, Prompt};
use crate::machine::provision::{SizeInfo, SIZES};
use crate::machine::Event;
use crate::mcp;
use crate::store::Settings;
use crate::t3desktop;
use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::header::{AUTHORIZATION, HOST};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, Stream};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;

const COSTS_EVERY: Duration = Duration::from_secs(300);
const EVENT_CHANNEL_CAPACITY: usize = 64;
const BOAT_DAEMON_PROTOCOL_VERSION: u32 = 3;

#[derive(Clone, Debug)]
pub struct DaemonConfig {
    pub control_port: u16,
    pub mcp_port: u16,
    pub token: String,
    pub data_dir: PathBuf,
    /// How long to wait for a daemon a dead server left behind to let go of the data dir.
    pub lock_wait: Duration,
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
        Ok(Self { control_port, mcp_port, token, data_dir, lock_wait: Duration::from_secs(10) })
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
    pub protocol_version: u32,
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
    pub account: Option<Account>,
    pub machines: Vec<MachineView>,
    pub costs: Costs,
    pub settings: Settings,
    pub sizes: &'static [SizeInfo],
    pub mcp: McpStatus,
    pub mcp_url: String,
    pub version: &'static str,
}

/// Sent to every client, so a link or code a command produces goes only in its `Reply`.
#[derive(Clone, Debug)]
enum StreamEvent {
    State(String),
    Notify(String),
}

impl StreamEvent {
    fn into_sse(self) -> SseEvent {
        match self {
            Self::State(data) => SseEvent::default().event("state").data(data),
            Self::Notify(data) => SseEvent::default().event("notify").data(data),
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    open_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sign_in: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pairing_target: Option<app::RemotePairingTarget>,
}

impl Reply {
    fn data(data: impl Serialize) -> std::result::Result<Self, CmdErr> {
        let data = serde_json::to_value(data).map_err(|e| CmdErr::Internal(e.to_string()))?;
        Ok(Self { data, ..Self::default() })
    }

    fn open(url: Option<String>) -> Self {
        Self { open_url: url, ..Self::default() }
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum SignInTarget {
    Boat,
    Machine(String),
}

struct SignInClient {
    owner: String,
    on_host: bool,
}

struct Attempt {
    id: String,
    owner: String,
    phase: watch::Sender<Phase>,
    cancel: Option<oneshot::Sender<()>>,
    code: Option<mpsc::Sender<String>>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum AttemptAction {
    Status { attempt_id: String },
    Cancel { attempt_id: String },
    Submit { attempt_id: String, code: String },
}

#[derive(Debug)]
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
            .map_err(|_| CmdErr::BadRequest(format!("invalid JSON body for {name}")))?
    };
    serde_json::from_value(value)
        .map_err(|_| CmdErr::BadRequest(format!("invalid arguments for {name}")))
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
    sign_ins: tokio::sync::Mutex<HashMap<SignInTarget, Attempt>>,
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
            sign_ins: tokio::sync::Mutex::default(),
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

    fn set_busy(&self, busy: bool) {
        self.setup.lock().unwrap().busy = busy;
        self.emit_state();
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
            match App::new(boat, t3, self.data_dir.clone(), tx) {
                Ok(app) => {
                    *self.app.lock().unwrap() = Some(app.clone());
                    let mut tasks = self.background_tasks.lock().unwrap();
                    tasks.push(tokio::spawn(event_loop(self.clone(), app.clone(), rx)));
                    tasks.push(tokio::spawn(background_loop(self.clone(), app)));
                    let daemon = self.clone();
                    tasks.push(tokio::spawn(async move { daemon.refresh_mcp().await }));
                }
                Err(e) => {
                    tracing::error!("starting Sail Boat: {e:#}");
                    self.emit_notify("Sail Boat could not start", "Its saved state could not be read.");
                }
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

    async fn handle_command(self: Arc<Self>, name: &str, body: Bytes, client: Option<SignInClient>) -> std::result::Result<Reply, CmdErr> {
        let on_host = client.as_ref().is_none_or(|client| client.on_host);
        match name {
            "get_state" => Reply::data(self.state()),
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
                let app = self.app()?;
                let machine = app.create_machine(&args.name, &args.size, args.projects).await.map_err(err)?;
                Ok(Reply::open(on_host.then(|| app.pair_link(&machine))))
            }
            "local_projects" => {
                Reply::data(self.app()?.local_projects().await.map_err(err)?)
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
                    .map(|_| Reply::default())
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
                    .map(|_| Reply::default())
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
                    .map(|_| Reply::default())
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
                if !on_host {
                    let Some(thread) = args.thread else { return Ok(Reply::default()) };
                    machine.ensure_awake().await.map_err(err)?;
                    machine.user_action();
                    return Ok(Reply::open(Some(t3desktop::thread_link(&machine.record().environment_id, &thread))));
                }
                let url = match args.thread {
                    Some(thread) => Some(t3desktop::thread_link(&machine.record().environment_id, &thread)),
                    None => app.open_in_t3(&machine, None),
                };
                Ok(Reply::open(url))
            }
            "pair_machine" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                let app = self.app()?;
                let machine = app.machine(&args.id).map_err(err)?;
                if on_host {
                    return Ok(Reply::open(Some(app.pair_link(&machine))));
                }
                let pairing_target = app.remote_pairing_target(&machine).await.map_err(err)?;
                Ok(Reply {
                    pairing_target: Some(pairing_target),
                    ..Reply::default()
                })
            }
            "latest_thread" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                Reply::data(self.app()?.machine(&args.id).map_err(err)?.latest_thread().await)
            }
            "get_machine_details" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                }
                let args: Args = parse_args(name, &body)?;
                Reply::data(self.app()?.details(&args.id).map_err(err)?)
            }
            "sign_in_agent" | "turn_on_connect" => {
                #[derive(Deserialize)]
                struct Args {
                    id: String,
                    agent: Option<String>,
                }
                let args: Args = parse_args(name, &body)?;
                let client = client.ok_or_else(sign_in_unavailable)?;
                let login = if name == "sign_in_agent" {
                    let agent = args.agent.as_deref().and_then(Agent::from_name).ok_or_else(|| {
                        CmdErr::BadRequest("This agent uses its own sign-in settings".to_owned())
                    })?;
                    Login::Agent(agent)
                } else {
                    Login::Connect
                };
                let machine = self.app()?.machine(&args.id).map_err(err)?;
                let target = SignInTarget::Machine(machine.id().to_owned());
                let on_host = client.on_host;
                self.start_attempt(target, client, login.accepts_code(on_host), move |prompt, code, cancel| async move {
                    machine.run_login(login, on_host, prompt, code, cancel).await
                }).await
            }
            "manage_boat_sign_in" | "manage_agent_sign_in" => {
                let action = parse_args(name, &body)?;
                self.manage_attempt(name == "manage_boat_sign_in", client.ok_or_else(sign_in_unavailable)?, action).await
            }
            "sign_out_boat" => {
                let attempts = self.sign_ins.lock().await;
                if attempts.values().any(|attempt| *attempt.phase.borrow() == Phase::Pending) {
                    return Err(CmdErr::BadRequest("Finish or cancel the current sign-in first".to_owned()));
                }
                let boat = Boat::locate().ok_or_else(sign_in_unavailable)?;
                let _setup = self.init_lock.lock().await;
                self.set_busy(true);
                let result = boat.sign_out().await;
                if result.is_ok() {
                    self.set_signed_out();
                }
                self.set_busy(false);
                result.map_err(err)?;
                Ok(Reply::default())
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
                    .map(|_| Reply::default())
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
                    .map(|_| Reply::default())
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
                    .map(|_| Reply::default())
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
                Ok(Reply::default())
            }
            "setup_action" => {
                #[derive(Deserialize)]
                struct Args {
                    action: String,
                }
                let args: Args = parse_args(name, &body)?;
                self.setup_action(&args.action, client).await
            }
            "add_mcp" => {
                #[derive(Deserialize)]
                struct Args {
                    client: mcp::Client,
                }
                let args: Args = parse_args(name, &body)?;
                let result = mcp::register(args.client, self.mcp_port).await.map_err(err);
                self.refresh_mcp().await;
                result.map(|_| Reply::default())
            }
            "sync_project_credentials" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Args {
                    machine_id: String,
                    project_id: String,
                    credentials: Vec<Value>,
                }
                let args: Args = parse_args(name, &body)?;
                let machine = self.app()?.machine(&args.machine_id).map_err(err)?;
                let synced = machine
                    .sync_project_credentials(&args.project_id, args.credentials)
                    .await
                    .map_err(err)?;
                Reply::data(json!({ "synced": synced }))
            }
            "shutdown" | "quit_app" => {
                self.request_shutdown();
                Ok(Reply::default())
            }
            other => Err(CmdErr::BadRequest(format!("unknown command {other}"))),
        }
    }

    async fn setup_action(self: &Arc<Self>, action: &str, client: Option<SignInClient>) -> std::result::Result<Reply, CmdErr> {
        match action {
            "installBoat" => {
                self.set_busy(true);
                let result = install_boat().await;
                if result.is_ok() {
                    self.recheck_setup().await;
                }
                self.set_busy(false);
                result.map_err(err)?;
                return Ok(Reply::default());
            }
            "signInBoat" => {
                let boat = Boat::locate().ok_or_else(|| CmdErr::Internal("Boat CLI not found".to_owned()))?;
                let client = client.ok_or_else(sign_in_unavailable)?;
                let daemon = self.clone();
                return self.start_attempt(SignInTarget::Boat, client, false, move |prompt, _, mut cancel| async move {
                    daemon.set_busy(true);
                    let phase = async {
                        // Boat can reuse a pending code across daemon restarts. Start from a
                        // signed-out account with any earlier pending code cleared.
                        if !boat.account().await.is_ok_and(|account| !account.signed_in)
                            || boat.sign_out().await.is_err()
                        {
                            return Phase::Failed;
                        }
                        let Ok(sign_in) = boat.start_sign_in().await else { return Phase::Failed };
                        let next = match sign_in.code {
                            Some(code) => Prompt::Device { url: sign_in.url, code },
                            None => Prompt::Browser { url: sign_in.url },
                        };
                        let _ = prompt.send(next);
                        let phase = tokio::select! {
                            phase = boat.finish_sign_in() => phase,
                            _ = &mut cancel => Phase::Cancelled,
                            _ = tokio::time::sleep(Duration::from_secs(900)) => Phase::Expired,
                        };
                        if matches!(phase, Phase::Cancelled | Phase::Expired) && boat.sign_out().await.is_err() {
                            return Phase::Failed;
                        }
                        phase
                    }.await;
                    daemon.recheck_setup().await;
                    daemon.set_busy(false);
                    phase
                }).await;
            }
            "installT3" => {}
            "recheck" => {}
            other => return Err(CmdErr::BadRequest(format!("unknown setup action {other}"))),
        }
        self.recheck_setup().await;
        Ok(Reply::default())
    }

    async fn recheck_setup(self: &Arc<Self>) {
        if self.app.lock().unwrap().is_none() {
            self.init().await;
        } else if let Ok(app) = self.app() {
            self.refresh_account(&app.shared.boat).await;
            self.emit_state();
        }
    }

    fn set_signed_out(&self) {
        self.setup.lock().unwrap().setup = Setup::SignInBoat;
        if let Some(app) = self.app.lock().unwrap().take() {
            app.shutdown();
        }
        for task in self.background_tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        *self.account.lock().unwrap() = None;
    }

    async fn start_attempt<F, Run>(
        self: &Arc<Self>,
        target: SignInTarget,
        client: SignInClient,
        accepts_code: bool,
        run: Run,
    ) -> std::result::Result<Reply, CmdErr>
    where
        F: Future<Output = Phase> + Send + 'static,
        Run: FnOnce(oneshot::Sender<Prompt>, mpsc::Receiver<String>, oneshot::Receiver<()>) -> F,
    {
        let id = generate_hex_token();
        let (tx, prompt) = oneshot::channel();
        let (code, input) = mpsc::channel(1);
        let (cancel, cancelled) = oneshot::channel();
        {
            let mut attempts = self.sign_ins.lock().await;
            if matches!(target, SignInTarget::Machine(_)) {
                self.app()?;
            }
            if attempts.get(&target).is_some_and(|a| *a.phase.borrow() == Phase::Pending) {
                return Err(CmdErr::BadRequest("A sign-in is already in progress".to_owned()));
            }
            // Keep the last result for each existing target until its next attempt, with
            // a bound on the number of completed attempts from deleted machines.
            if attempts.len() >= 256 {
                attempts.retain(|_, a| *a.phase.borrow() == Phase::Pending);
            }
            attempts.insert(target.clone(), Attempt {
                id: id.clone(),
                owner: client.owner,
                phase: watch::channel(Phase::Pending).0,
                cancel: Some(cancel),
                code: accepts_code.then_some(code),
            });
        }
        let daemon = self.clone();
        let job = run(tx, input, cancelled);
        tokio::spawn(async move {
            let phase = job.await;
            let mut attempts = daemon.sign_ins.lock().await;
            if let Some(attempt) = attempts.get_mut(&target) {
                attempt.phase.send_replace(phase);
                attempt.cancel = None;
                attempt.code = None;
            }
        });
        let prompt = prompt.await.ok();
        Ok(Reply { sign_in: Some(json!({ "attemptId": id, "prompt": prompt, "onHost": client.on_host })), ..Reply::default() })
    }

    async fn manage_attempt(
        &self, boat: bool, client: SignInClient, action: AttemptAction,
    ) -> std::result::Result<Reply, CmdErr> {
        let id = match &action {
            AttemptAction::Status { attempt_id } | AttemptAction::Cancel { attempt_id }
                | AttemptAction::Submit { attempt_id, .. } => attempt_id,
        };
        let mut attempts = self.sign_ins.lock().await;
        let Some((_, attempt)) = attempts.iter_mut().find(|(target, a)| {
            matches!(target, SignInTarget::Boat) == boat && a.id == *id && a.owner == client.owner
        }) else {
            return Reply::data(Phase::Expired);
        };
        match action {
            AttemptAction::Cancel { .. } => {
                if let Some(cancel) = attempt.cancel.take() {
                    attempt.code = None;
                    let _ = cancel.send(());
                }
            }
            AttemptAction::Submit { code, .. } if *attempt.phase.borrow() == Phase::Pending => {
                let code = code.trim();
                if code.is_empty() || code.len() > 2048 || code.chars().any(char::is_control) {
                    return Err(CmdErr::BadRequest("Enter a valid sign-in code".to_owned()));
                }
                let Some(sender) = &attempt.code else {
                    return Err(CmdErr::BadRequest("This attempt is not accepting a code".to_owned()));
                };
                sender.try_send(code.to_owned()).map_err(|_| sign_in_unavailable())?;
            }
            _ => {}
        }
        Reply::data(*attempt.phase.borrow())
    }
}

fn sign_in_unavailable() -> CmdErr {
    CmdErr::BadRequest("Sign-in is unavailable for this connection".to_owned())
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
    let rx = daemon.events_tx.subscribe();
    let shutdown = daemon.subscribe_shutdown();
    let initial = StreamEvent::State(daemon.state_json());
    let stream = stream::unfold(
        (daemon, rx, shutdown, Some(initial)),
        |(daemon, mut rx, mut shutdown, mut pending)| async move {
            if *shutdown.borrow() {
                return None;
            }
            if let Some(first) = pending.take() {
                return Some((Ok(first.into_sse()), (daemon, rx, shutdown, None)));
            }
            loop {
                tokio::select! {
                    _ = shutdown.changed() => {
                        if *shutdown.borrow() {
                            return None;
                        }
                    }
                    msg = rx.recv() => match msg {
                        Ok(ev) => return Some((Ok(ev.into_sse()), (daemon, rx, shutdown, None))),
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let resync = StreamEvent::State(daemon.state_json());
                            return Some((Ok(resync.into_sse()), (daemon, rx, shutdown, None)));
                        }
                        Err(broadcast::error::RecvError::Closed) => return None,
                    }
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn run_command(State(daemon): State<Arc<Daemon>>, Path(name): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    #[derive(Serialize)]
    struct Done {
        ok: bool,
        #[serde(flatten)]
        reply: Reply,
    }
    let client = headers.get("x-sail-client").and_then(|value| value.to_str().ok()).map(|owner| {
        SignInClient { owner: owner.to_owned(), on_host: headers.get("x-sail-client-on-host").is_some_and(|v| v == "1") }
    });
    match daemon.handle_command(&name, body, client).await {
        Ok(reply) => Json(Done { ok: true, reply }).into_response(),
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
    _data_dir_lock: DataDirLock,
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
    let data_dir_lock = lock_data_dir(&config.data_dir, config.lock_wait).await?;
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
    let handshake = Handshake {
        ready: true,
        protocol_version: BOAT_DAEMON_PROTOCOL_VERSION,
        port: control_port,
        token: config.token,
        mcp_port,
    };

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

    Ok(RunningDaemon {
        handshake,
        daemon,
        tasks: vec![control_task, mcp_task, init_task],
        _data_dir_lock: data_dir_lock,
    })
}

/// Closing the lock's file alone keeps the lock while a process forked at that moment still
/// shares the file, so dropping this lets go explicitly.
struct DataDirLock(std::fs::File);

impl Drop for DataDirLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// Two daemons on one data dir would each reap, sleep and save the same machines. One a dead
/// server left behind lets go once it has shut down, so a new one waits up to `wait` for it.
async fn lock_data_dir(dir: &std::path::Path, wait: Duration) -> Result<DataDirLock> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let path = dir.join("daemon.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(DataDirLock(file)),
            Err(std::fs::TryLockError::WouldBlock) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                anyhow::bail!("another sail-boatd is using {}", dir.display())
            }
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(e).with_context(|| format!("locking {}", path.display()));
            }
        }
    }
}

/// Resolves once `input` reaches end of file. Read on a plain thread: a blocked read there never
/// holds up the process exiting.
pub fn closed(mut input: impl std::io::Read + Send + 'static) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 256];
        loop {
            match input.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = tx.send(());
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    const TOKEN: &str = "test-secret-token-123";

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("sail-boat-daemon-test-{:016x}", rand::random::<u64>()))
    }

    async fn spawn_test_daemon() -> (RunningDaemon, PathBuf) {
        let dir = test_dir();
        let config = DaemonConfig {
            control_port: 0,
            mcp_port: 0,
            token: TOKEN.to_owned(),
            data_dir: dir.clone(),
            lock_wait: Duration::ZERO,
        };
        (start(config).await.unwrap(), dir)
    }

    /// Saves one machine, `dev` on sandbox `bx_dev`, in `dir`'s state file.
    fn save_dev_machine(dir: &std::path::Path) {
        let local_port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let machine = crate::store::Machine {
            id: "bx_dev".into(),
            sandbox_id: "bx_dev".into(),
            name: "dev".into(),
            size: "small".into(),
            upstream_url: "http://127.0.0.1:9".into(),
            upstream_token: "upstream".into(),
            watchdog_url: "http://127.0.0.1:9".into(),
            watchdog_secret: "watchdog".into(),
            local_port,
            t3_version: "0.0.0".into(),
            provision_revision: String::new(),
            lifecycle_enrolled: false,
            pending_resume: None,
            environment_id: "env-dev".into(),
            client_tokens: Vec::new(),
            link_tokens: Vec::new(),
            created_at: 0,
            next_due_at: None,
            connect: false,
            saved_stop: None,
            project_origins: Default::default(),
        };
        let state = crate::store::State { machines: vec![machine], ..Default::default() };
        crate::store::Store::new(dir).save(&state).unwrap();
    }

    async fn daemon_with_machine() -> (Arc<App>, u16, PathBuf) {
        let dir = test_dir();
        save_dev_machine(&dir);
        let (tx, rx) = mpsc::unbounded_channel();
        let t3 = t3desktop::T3Desktop::at(dir.join("no-sail"));
        let app = App::new(Boat::at(dir.join("no-boat")), t3, dir.clone(), tx).unwrap();
        let daemon = Daemon::new(TOKEN.to_owned(), dir.clone(), 0);
        *daemon.app.lock().unwrap() = Some(app.clone());
        tokio::spawn(event_loop(daemon.clone(), app.clone(), rx));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, router(daemon)).await });
        (app, port, dir)
    }

    async fn command(port: u16, name: &str, args: Value) -> Value {
        let res = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/api/command/{name}"))
            .bearer_auth(TOKEN)
            .json(&args)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{name}");
        res.json().await.unwrap()
    }

    fn pairing_code(link: &Value, local_port: u16) -> String {
        let link = url::Url::parse(link.as_str().unwrap()).unwrap();
        assert_eq!(link.scheme(), t3desktop::deep_link_scheme(), "{link}");
        assert_eq!(link.host_str(), Some("pair"), "{link}");
        let pairing = link.query_pairs().find(|(k, _)| k == "pairingUrl").unwrap().1;
        let code = pairing.strip_prefix(&format!("http://localhost:{local_port}/pair#token="));
        code.unwrap_or_else(|| panic!("not a pairing URL: {pairing}")).to_owned()
    }

    async fn read_events_until(stream: &mut (impl Stream<Item = reqwest::Result<Bytes>> + Unpin), buf: &mut String, seen: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !buf.contains(seen) {
                let chunk = stream.next().await.expect("stream ended").unwrap();
                buf.push_str(&String::from_utf8_lossy(&chunk));
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no {seen} in: {buf}"));
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
        assert_eq!(serde_json::to_value(&running.handshake).unwrap()["protocolVersion"], BOAT_DAEMON_PROTOCOL_VERSION);
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
        assert!(body.get("signInCode").is_none(), "the sign-in code goes only to the client that started it");
        assert!(body["signInAttempt"].is_null());
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
    async fn link_commands_return_the_link_to_their_caller() {
        let (app, port, dir) = daemon_with_machine().await;
        let machine = app.machine("dev").unwrap();
        let local_port = machine.record().local_port;

        let paired = command(port, "pair_machine", json!({ "id": "dev" })).await;
        assert_eq!((&paired["ok"], &paired["data"], paired.get("userCode")), (&json!(true), &Value::Null, None));
        let code = pairing_code(&paired["openUrl"], local_port);
        assert!(machine.auth.redeem_pairing_code(&code), "the link carries the machine's live pairing code");

        let unpaired = command(port, "open_machine", json!({ "id": "dev" })).await;
        let code = pairing_code(&unpaired["openUrl"], local_port);
        assert!(machine.auth.redeem_pairing_code(&code), "an unpaired machine opens its pair link");

        let thread = command(port, "open_machine", json!({ "id": "dev", "thread": "thread-1" })).await;
        assert_eq!(thread["openUrl"], format!("{}://threads/env-dev/thread-1", t3desktop::deep_link_scheme()));
        machine.update_record(|r| r.client_tokens.push("sail-client".into()));

        let state = command(port, "get_state", json!({})).await;
        assert_eq!(state["data"]["machines"][0]["environmentId"], "env-dev");
        assert_eq!(state["data"]["machines"][0]["paired"], true);
        let second_client = command(port, "pair_machine", json!({ "id": "dev" })).await;
        let code = pairing_code(&second_client["openUrl"], local_port);
        assert!(machine.auth.redeem_pairing_code(&code), "a second client gets its own pairing link");

        let front = command(port, "open_machine", json!({ "id": "dev" })).await;
        assert_eq!(front, json!({ "ok": true, "data": null }), "no thread: the caller is already in front");

        app.shutdown();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn remote_pair_requires_a_successful_wake_and_local_pair_does_not() {
        let (app, port, dir) = daemon_with_machine().await;
        let machine = app.machine("dev").unwrap();
        machine.retire();
        let response = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/api/command/pair_machine"))
            .bearer_auth(TOKEN)
            .header("x-sail-client", "remote")
            .header("x-sail-client-on-host", "0")
            .json(&json!({ "id": "dev" }))
            .send().await.unwrap();
        let reply: Value = response.json().await.unwrap();
        assert_eq!(reply["ok"], false);
        assert!(reply["error"].as_str().unwrap().contains("the sandbox no longer exists"));
        assert!(reply.get("pairingTarget").is_none() && reply.get("openUrl").is_none());

        let local = command(port, "pair_machine", json!({ "id": "dev" })).await;
        assert!(machine.auth.redeem_pairing_code(&pairing_code(&local["openUrl"], machine.record().local_port)));
        app.shutdown();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sse_events_stream_notifications_but_never_a_link() {
        let (app, port, dir) = daemon_with_machine().await;
        let res = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/events"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        read_events_until(&mut stream, &mut buf, "event: state").await;

        let paired = command(port, "pair_machine", json!({ "id": "dev" })).await;
        app.machine("dev").unwrap().update_record(|r| r.client_tokens.push("sail-client".into()));
        let thread = command(port, "open_machine", json!({ "id": "dev", "thread": "thread-1" })).await;
        app.shared.notify("Sail Boat", "Machine ready");
        read_events_until(&mut stream, &mut buf, "Machine ready").await;

        let events: Vec<&str> = buf.lines().filter_map(|l| l.strip_prefix("event: ")).collect();
        assert!(events.iter().all(|e| matches!(*e, "state" | "notify")), "{events:?}");
        for link in [&paired["openUrl"], &thread["openUrl"]] {
            let link = link.as_str().unwrap();
            assert!(!buf.contains(link), "{link} went to every client: {buf}");
        }
        assert!(!buf.contains("pairingUrl") && !buf.contains("://threads/"), "a link went to every client: {buf}");

        drop(stream);
        app.shutdown();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Every client of the server shows a notice, so a failed wake leaves Boat's output to the
    /// machine's row on the Boats page.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_wake_notice_leaves_out_what_boat_said() {
        use std::os::unix::fs::PermissionsExt;
        const BOAT: &str = r#"#!/bin/sh
shift
case "$1" in
  info) echo '{"sandbox":{"id":"bx_dev","state":"stopped"}}' ;;
  resume) echo 'quota exceeded, see https://boat.example/billing?token=boat-output' >&2; exit 1 ;;
  *) exit 1 ;;
esac
"#;
        let dir = test_dir();
        save_dev_machine(&dir);
        let bin = dir.join("boat");
        std::fs::write(&bin, BOAT).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let app = App::new(Boat::at(bin), t3desktop::T3Desktop::at(dir.join("no-sail")), dir.clone(), tx).unwrap();
        let machine = app.machine("dev").unwrap();

        let woke = machine.ensure_awake().await;
        assert!(woke.is_err_and(|e| format!("{e:#}").contains("boat-output")), "the caller that asked sees why");
        let body = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match rx.recv().await.expect("the app's events") {
                    Event::Notify { title, body } if title == "dev could not wake" => break body,
                    _ => {}
                }
            }
        })
        .await
        .expect("a notice for the failed wake");
        assert_eq!(body, "Boats shows why.");
        assert!(machine.last_error().unwrap_or_default().contains("boat-output"), "the Boats page keeps the reason");

        app.shutdown();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_second_daemon_on_the_same_data_dir_refuses_to_start() {
        let (first, dir) = spawn_test_daemon().await;
        let config = DaemonConfig {
            control_port: 0,
            mcp_port: 0,
            token: TOKEN.to_owned(),
            data_dir: dir.clone(),
            lock_wait: Duration::ZERO,
        };
        let refused = start(config).await.err().expect("a second daemon must not start on a locked data dir");
        assert!(format!("{refused:#}").contains("another sail-boatd is using"), "{refused:#}");

        let forked_meanwhile = first._data_dir_lock.0.try_clone().unwrap();
        first.shutdown().await;
        let config = DaemonConfig {
            control_port: 0,
            mcp_port: 0,
            token: TOKEN.to_owned(),
            data_dir: dir.clone(),
            lock_wait: Duration::ZERO,
        };
        let next = start(config).await.expect("the data dir is free once its daemon is gone");
        drop(forked_meanwhile);
        stop_test_daemon(next, dir).await;
    }

    #[tokio::test]
    async fn a_second_daemon_waits_for_the_first_to_let_go() {
        let (first, dir) = spawn_test_daemon().await;
        let config = DaemonConfig {
            control_port: 0,
            mcp_port: 0,
            token: TOKEN.to_owned(),
            data_dir: dir.clone(),
            lock_wait: Duration::from_secs(10),
        };
        let mut second = tokio::spawn(start(config));
        assert!(
            tokio::time::timeout(Duration::from_millis(300), &mut second).await.is_err(),
            "the second daemon waits while the first holds the data dir"
        );
        first.shutdown().await;
        let next = second.await.unwrap().expect("the second daemon starts once the first lets go");
        stop_test_daemon(next, dir).await;
    }

    fn signin_client(owner: &str) -> SignInClient {
        SignInClient { owner: owner.to_owned(), on_host: false }
    }

    #[tokio::test]
    async fn signin_is_connection_owned_and_cancel_finishes_before_retry() {
        let daemon = Daemon::new(TOKEN.to_owned(), test_dir(), 0);
        let target = SignInTarget::Boat;
        let (release, released) = oneshot::channel();
        let reply = daemon.start_attempt(target.clone(), signin_client("first"), false, |prompt, _, cancel| async move {
            let _ = prompt.send(Prompt::Device { url: "https://auth.example/device".to_owned(), code: "FIXTURE-CODE".to_owned() });
            cancel.await.unwrap();
            released.await.unwrap();
            Phase::Cancelled
        }).await.unwrap();
        let own = reply.sign_in.unwrap();
        let id = own["attemptId"].as_str().unwrap().to_owned();
        assert_eq!(own["prompt"]["code"], "FIXTURE-CODE");
        assert!(!daemon.state_json().contains(&id));
        assert!(!daemon.state_json().contains("FIXTURE-CODE"));

        let cancel = || AttemptAction::Cancel { attempt_id: id.clone() };
        let mut phase = daemon.sign_ins.lock().await[&target].phase.subscribe();
        assert_eq!(daemon.manage_attempt(true, signin_client("second"), cancel()).await.unwrap().data, "expired");
        assert_eq!(*phase.borrow(), Phase::Pending);
        assert_eq!(daemon.manage_attempt(true, signin_client("first"), cancel()).await.unwrap().data, "pending");
        assert!(daemon.start_attempt(target.clone(), signin_client("second"), false, |_, _, _| async { Phase::Complete }).await.is_err());

        release.send(()).unwrap();
        phase.wait_for(|phase| *phase == Phase::Cancelled).await.unwrap();
        let next = daemon.start_attempt(target.clone(), signin_client("second"), false, |_, _, _| async { Phase::Expired }).await.unwrap();
        assert_ne!(next.sign_in.unwrap()["attemptId"], id);
        let mut next_phase = daemon.sign_ins.lock().await[&target].phase.subscribe();
        next_phase.wait_for(|phase| *phase == Phase::Expired).await.unwrap();
        assert_eq!(daemon.manage_attempt(true, signin_client("first"), cancel()).await.unwrap().data, "expired");
    }

    #[tokio::test]
    async fn closed_resolves_when_the_parent_closes_its_end() {
        let (reader, mut writer) = std::io::pipe().unwrap();
        let mut closed = closed(reader);
        std::io::Write::write_all(&mut writer, b"still here").unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(200), &mut closed).await.is_err(),
            "input that is still open keeps the daemon running"
        );
        drop(writer);
        tokio::time::timeout(Duration::from_secs(5), closed).await.unwrap().unwrap();
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

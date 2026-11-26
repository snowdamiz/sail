//! MCP server so coding agents on this computer (Claude Code, Codex) can drive Sail Boat:
//! streamable HTTP on loopback, one JSON response per request. Local processes are trusted
//! (they could run the Boat CLI anyway); Host and Origin checks keep web pages out.

use crate::app::App;
use crate::machine::signin::Agent;
use crate::process::command;
use anyhow::{anyhow, bail, Context, Result};
use axum::extract::State;
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::OnceCell;

pub const DEFAULT_MCP_PORT: u16 = 47731;
const NAME: &str = "sail";
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
/// Longer calls answer early and finish in the background, staying under clients' tool
/// timeouts (Codex: 60 s).
const WAIT: Duration = Duration::from_secs(40);

const INSTRUCTIONS: &str = "Sail runs remote machines (Boat sandboxes) for the user. \
Machines sleep on their own when no agent works and wake when used; the user pays per minute awake. \
Address a machine by its name or id from list_machines. \
add_project puts one of the user's projects on a machine, as Sail's own \"Add to another machine\" \
does. Each machine is also a linked environment of the user's Sail desktop app (t3_environment_links lists it): \
work there with Sail's own tools and that environmentId, e.g. delegate_task or t3_thread_launch.";

pub fn configured_port() -> u16 {
    std::env::var("SAIL_MCP_PORT")
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_MCP_PORT)
}

pub fn url_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

pub fn url() -> String {
    url_for_port(configured_port())
}

pub async fn bind(port: u16) -> Result<(tokio::net::TcpListener, u16)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("listening on MCP port {port}"))?;
    let bound = listener.local_addr()?.port();
    Ok((listener, bound))
}

pub async fn serve(app: Arc<App>) -> Result<()> {
    let (listener, _) = bind(configured_port()).await?;
    axum::serve(listener, router(app)).await?;
    Ok(())
}

/// Serves MCP on a pre-bound listener backed by a mutable `App` slot that populates once setup
/// reaches `Ready`.
pub async fn serve_slot(
    listener: tokio::net::TcpListener,
    app: Arc<Mutex<Option<Arc<App>>>>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    axum::serve(listener, router(Arc::new(AppSlot(app))))
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

struct AppSlot(Arc<Mutex<Option<Arc<App>>>>);

impl Tools for AppSlot {
    async fn call(self: Arc<Self>, call: Call) -> Result<String> {
        let app = self
            .0
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow!("Sail Boat is not set up yet"))?;
        app.call(call).await
    }
}

/// What `tools/call` runs; a trait so the protocol is testable without a real app.
trait Tools: Send + Sync + 'static {
    fn call(self: Arc<Self>, call: Call) -> impl Future<Output = Result<String>> + Send;
}

/// `tools/call` params: the tool's name and its arguments.
#[derive(Debug, Deserialize)]
#[serde(tag = "name", content = "arguments", rename_all = "snake_case")]
enum Call {
    ListMachines {},
    CreateMachine {
        name: String,
        size: Option<String>,
        #[serde(default)]
        projects: Vec<String>,
    },
    ListProjects {},
    AddProject { machine: String, project: String },
    WakeMachine { machine: String },
    SleepMachine { machine: String },
    ResizeMachine { machine: String, size: String },
    KeepAwake { machine: String, minutes: u32 },
    SignInAgent { machine: String, agent: String },
    TurnOnConnect { machine: String },
    MachineDetails { machine: String },
    SetAutoSleep { machine: String, on: bool },
    OpenInT3 { machine: String },
    AddToT3 { machine: String },
    DeleteMachine {
        machine: String,
        #[serde(default)]
        discard: bool,
    },
}

fn router<T: Tools>(tools: Arc<T>) -> Router {
    // Only POST is routed, so GET gets 405.
    Router::new().route("/mcp", post(handle::<T>)).with_state(tools)
}

async fn handle<T: Tools>(State(tools): State<Arc<T>>, headers: HeaderMap, body: String) -> Response {
    if !from_local_process(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(request) = serde_json::from_str::<Value>(&body) else {
        return Json(reply(Value::Null, Err((-32700, "parse error".into())))).into_response();
    };
    match dispatch(tools, request).await {
        Some(response) => Json(response).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Keeps web pages out: browsers send `Origin` on every POST (even from a localhost page)
/// and agents' MCP clients never do; a local `Host` also blocks DNS rebinding.
fn from_local_process(headers: &HeaderMap) -> bool {
    !headers.contains_key(ORIGIN)
        && headers.get(HOST).and_then(|h| h.to_str().ok()).is_some_and(|host| {
            url::Url::parse(&format!("http://{host}"))
                .is_ok_and(|u| matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
        })
}

/// The response to a JSON-RPC message; none for notifications.
async fn dispatch<T: Tools>(tools: Arc<T>, request: Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let result = match request["method"].as_str().unwrap_or_default() {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_list() })),
        "tools/call" => match parse_call(params) {
            Ok(call) => Ok(match tools.call(call).await {
                Ok(text) => content(text, false),
                Err(e) => content(format!("{e:#}"), true),
            }),
            Err(e) => Err((-32602, format!("invalid tool call: {e}"))),
        },
        method => Err((-32601, format!("unknown method {method}"))),
    };
    Some(reply(id, result))
}

fn reply(id: Value, result: Result<Value, (i64, String)>) -> Value {
    match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    }
}

fn initialize(params: &Value) -> Value {
    let asked = params["protocolVersion"].as_str().unwrap_or_default();
    let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&DEFAULT_PROTOCOL_VERSION);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": NAME, "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

fn parse_call(mut params: Value) -> serde_json::Result<Call> {
    if let Some(p) = params.as_object_mut() {
        p.entry("arguments").or_insert_with(|| json!({}));
    }
    serde_json::from_value(params)
}

fn content(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn tool_list() -> Value {
    let machine = json!({ "type": "string", "description": "Machine name or id" });
    let sizes = crate::machine::provision::SIZES;
    let size = |description: &str| {
        let ids: Vec<&str> = sizes.iter().map(|s| s.id).collect();
        let specs: Vec<String> = sizes.iter().map(|s| format!("{}: {}, ${}/h", s.id, s.spec, s.hourly)).collect();
        json!({ "type": "string", "enum": ids, "description": format!("{description} ({})", specs.join("; ")) })
    };
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": { "type": "object", "properties": properties, "required": required },
        })
    };
    json!([
        tool(
            "list_machines",
            "Lists the user's Sail Boat machines with id, size, state (working | idle | asleep | waking | \
             sleeping | creating | error | missing | unknown (still checking)) and a detail line, agents that still need a sign-in \
             there (signedOut), its projects (with progress while one is being added), plus Boat \
             costs today and this month and machine starts used today against the daily limit.",
            json!({}),
            &[],
        ),
        tool(
            "create_machine",
            "Creates a new remote machine with Sail on it. Takes about a minute. When it is ready, \
             Sail shows the user a dialog to add it as a backend; tell the user to confirm it there. \
             `projects` (ids from list_projects) are then added to it as add_project does.",
            json!({
                "name": { "type": "string", "description": "Unique machine name" },
                "size": size("Defaults to default"),
                "projects": { "type": "array", "items": { "type": "string" }, "description": "Project ids from list_projects" },
            }),
            &["name"],
        ),
        tool(
            "list_projects",
            "The user's Sail projects on this computer that can be added to a machine (those with a \
             git remote): id, title, path and repoKey. A machine already has the ones whose repoKey \
             list_machines shows under its projects.",
            json!({}),
            &[],
        ),
        tool(
            "add_project",
            "Adds one of the user's Sail projects to a machine as Sail's own \"Add to another \
             machine\" does: clones it from its git remote there, registers it as a project and \
             copies its env files. Returns once cloned. A clone the git host refuses needs the user \
             to sign in to it on that machine in Sail (Settings → Source control).",
            json!({
                "machine": machine,
                "project": { "type": "string", "description": "Project id, title or path from list_projects" },
            }),
            &["machine", "project"],
        ),
        tool(
            "wake_machine",
            "Wakes a sleeping machine and waits until it is up. Machines also wake on their own when \
             used from Sail, so this is only needed to prepare one ahead of time.",
            json!({ "machine": machine }),
            &["machine"],
        ),
        tool(
            "sleep_machine",
            "Puts a machine to sleep now instead of after 3 idle minutes. Refused while an agent works on it.",
            json!({ "machine": machine }),
            &["machine"],
        ),
        tool(
            "keep_awake",
            "Keeps a machine up even when nobody uses it (e.g. a dev server or long job the agent \
             watches) for `minutes`, waking it if asleep; it ends by itself. minutes 0 ends it now. \
             To keep it up until stopped, use set_auto_sleep with on false. The user pays per minute awake.",
            json!({
                "machine": machine,
                "minutes": { "type": "integer", "minimum": 0, "maximum": 1440, "description": "0 turns it off" },
            }),
            &["machine", "minutes"],
        ),
        tool(
            "resize_machine",
            "Changes a machine's size. An asleep machine applies it on its next wake; an idle one \
             sleeps and wakes onto it now (unavailable meanwhile); a working one (agent or build), or one where \
             an agent waits on the user, applies it after it next sleeps.",
            json!({ "machine": machine, "size": size("New size") }),
            &["machine", "size"],
        ),
        tool(
            "sign_in_agent",
            "Signs a coding agent in on a machine with the vendor's own login. Opens the sign-in page in \
             the user's browser on this computer; the user must click Authorize there, so tell them to. \
             The credential is created on the machine; this computer's logins are not touched.",
            json!({
                "machine": machine,
                "agent": { "type": "string", "enum": ["Claude", "Codex"] },
            }),
            &["machine", "agent"],
        ),
        tool(
            "turn_on_connect",
            "Turns on T3 Connect on a machine, so the user's other devices (mobile app, \
             browser) reach it with their account. Opens the sign-in page in the user's browser on \
             this computer; the user must approve it there, so tell them to. Restarts the server on the \
             machine, so it refuses while an agent works there or waits on the user. A sleeping machine still wakes only \
             through Sail on this computer.",
            json!({ "machine": machine }),
            &["machine"],
        ),
        tool(
            "machine_details",
            "One machine's cost today and this month, time awake today, which agents are signed in \
             there, its server version and creation time, and whether T3 Connect is on. Never wakes it.",
            json!({ "machine": machine }),
            &["machine"],
        ),
        tool(
            "set_auto_sleep",
            "Auto sleep on (default: the machine sleeps 3 minutes after its agents finish) or off (it \
             stays up, and bills, until turned back on). Turning it off wakes a sleeping machine.",
            json!({ "machine": machine, "on": { "type": "boolean" } }),
            &["machine", "on"],
        ),
        tool(
            "open_in_t3",
            "Shows the machine to the user in the Sail desktop app, on its most recent thread. If Sail \
             doesn't have the machine yet, shows its dialog to add it instead.",
            json!({ "machine": machine }),
            &["machine"],
        ),
        tool(
            "add_to_t3",
            "Shows Sail's dialog to add this machine again (e.g. after the user removed it there); \
             the user confirms in Sail.",
            json!({ "machine": machine }),
            &["machine"],
        ),
        tool(
            "delete_machine",
            "Permanently deletes a machine and everything on it, including work not pushed anywhere. Ask \
             the user first. Refuses while an agent or build is working there; `discard: true` deletes \
             anyway and loses that work.",
            json!({ "machine": machine, "discard": { "type": "boolean", "description": "Delete even while work runs" } }),
            &["machine"],
        ),
    ])
}

impl Call {
    /// The answer when the call outlasts `WAIT`.
    fn pending(&self) -> String {
        match self {
            Self::CreateMachine { name, .. } => format!(
                "Creating {name}, about a minute. list_machines shows its progress. When it is ready, \
                 Sail asks the user to add it as a backend."
            ),
            Self::SignInAgent { machine, agent } => format!(
                "The {agent} sign-in for {machine} is open in the browser; the user must click Authorize. \
                 list_machines stops listing {agent} under signedOut once done."
            ),
            Self::AddProject { machine, project } => format!(
                "Still cloning {project} onto {machine}; list_machines shows its progress under the machine's projects."
            ),
            Self::TurnOnConnect { machine } => format!(
                "The sign-in page for {machine} is open in the browser; the user must approve it. \
                 machine_details shows connect: true once other devices can reach it."
            ),
            _ => "Still running in the background; list_machines shows the machine's state.".into(),
        }
    }
}

impl Tools for App {
    async fn call(self: Arc<Self>, call: Call) -> Result<String> {
        let pending = call.pending();
        let (tx, rx) = tokio::sync::oneshot::channel();
        // Detached, so a client that gives up does not cancel the work halfway.
        tokio::spawn(async move {
            if let Err(Err(e)) = tx.send(run(&self, call).await) {
                self.shared.notify("Sail Boat", format!("{e:#}"));
            }
        });
        match tokio::time::timeout(WAIT, rx).await {
            Ok(result) => result?,
            Err(_) => Ok(pending),
        }
    }
}

async fn run(app: &Arc<App>, call: Call) -> Result<String> {
    Ok(match call {
        Call::ListMachines {} => json!({ "machines": app.views(), "costs": app.costs() }).to_string(),
        Call::CreateMachine { name, size, projects } => {
            let m = app.create_machine(&name, size.as_deref().unwrap_or("default"), projects).await?;
            // The machine exists either way; its row still offers "Add to Sail".
            if let Err(e) = crate::app::open_url(&app.pair_link(&m)) {
                app.shared.notify(format!("Couldn't open Sail for {name}"), format!("{e:#}; use Add to Sail"));
            }
            format!(
                "Created {} ({}). Sail now asks the user to add it as a backend; tell them to confirm.",
                m.record().name,
                m.id()
            )
        }
        Call::ListProjects {} => serde_json::to_string(&app.local_projects().await?)?,
        Call::AddProject { machine, project } => {
            let m = app.machine(&machine)?;
            let p = app.add_project(&m, &project).await?;
            format!("{} is on {} now, in Sail.", p.title, m.record().name)
        }
        Call::WakeMachine { machine } => {
            let m = app.machine(&machine)?;
            m.ensure_awake().await?;
            format!("{} is awake.", m.record().name)
        }
        Call::SleepMachine { machine } => {
            let m = app.machine(&machine)?;
            m.sleep_now().await?;
            format!("{} is going to sleep.", m.record().name)
        }
        Call::KeepAwake { machine, minutes } => {
            let m = app.machine(&machine)?;
            let name = m.record().name;
            m.keep_awake(Some(minutes)).await?;
            match minutes {
                0 => format!("{name} sleeps as usual again."),
                n => format!("{name} stays awake for {n} minutes."),
            }
        }
        Call::ResizeMachine { machine, size } => {
            let m = app.machine(&machine)?;
            m.resize(&size).await?;
            format!("{name} is set to {size}; it applies when it next wakes (right away if it was idle and no agent waited on the user).", name = m.record().name)
        }
        Call::SignInAgent { machine, agent } => {
            let a = Agent::from_name(&agent).ok_or_else(|| anyhow!("agent must be Claude or Codex"))?;
            let m = app.machine(&machine)?;
            m.sign_in(a).await?;
            format!("{agent} is signed in on {}.", m.record().name)
        }
        Call::TurnOnConnect { machine } => {
            let m = app.machine(&machine)?;
            m.turn_on_connect().await?;
            format!("T3 Connect is on for {}: the user's other devices reach it with their account.", m.record().name)
        }
        Call::MachineDetails { machine } => serde_json::to_string(&app.details(&machine)?)?,
        Call::SetAutoSleep { machine, on } => {
            let m = app.machine(&machine)?;
            m.keep_awake(if on { Some(0) } else { None }).await?;
            match on {
                true => format!("{} sleeps 3 minutes after its agents finish again.", m.record().name),
                false => format!("{} stays up until auto sleep is turned back on.", m.record().name),
            }
        }
        Call::OpenInT3 { machine } => {
            let m = app.machine(&machine)?;
            match app.open_in_t3(&m, m.latest_thread().await.as_deref()) {
                Some(link) => crate::app::open_url(&link)?,
                None => crate::t3desktop::activate()?,
            }
            format!("Showed {} in Sail.", m.record().name)
        }
        Call::AddToT3 { machine } => {
            let m = app.machine(&machine)?;
            crate::app::open_url(&app.pair_link(&m))?;
            format!("Sail now asks the user to add {}; tell them to confirm.", m.record().name)
        }
        Call::DeleteMachine { machine, discard } => {
            let m = app.machine(&machine)?;
            let record = m.record();
            app.delete_machine(&m, discard).await?;
            let name = record.name;
            if record.client_tokens.is_empty() {
                format!("Deleted {name}.")
            } else {
                format!("Deleted {name}. Sail still lists it until the user removes it there, under Settings → Environments.")
            }
        }
    })
}

/// A coding agent CLI that can use this server.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Client {
    ClaudeCode,
    Codex,
}

impl Client {
    fn cli(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
        }
    }

    fn add_args(self, port: u16) -> Vec<String> {
        let args: &[&str] = match self {
            Self::ClaudeCode => &["mcp", "add", "--transport", "http", "--scope", "user", NAME],
            Self::Codex => &["mcp", "add", NAME, "--url"],
        };
        args.iter().map(|a| a.to_string()).chain([url_for_port(port)]).collect()
    }
}

/// Whether the client's CLI is on this computer at all.
pub async fn installed(client: Client) -> bool {
    locate(client.cli()).await.is_some()
}

pub async fn registered(client: Client) -> bool {
    run_cli(client, &["mcp".into(), "get".into(), NAME.into()]).await.is_ok()
}

/// Adds this server to the client's user config; nothing to do when it is there already.
pub async fn register(client: Client, port: u16) -> Result<()> {
    if registered(client).await {
        return Ok(());
    }
    run_cli(client, &client.add_args(port)).await
}

async fn run_cli(client: Client, args: &[String]) -> Result<()> {
    let cli = client.cli();
    let bin = locate(cli).await.ok_or_else(|| anyhow!("the {cli} CLI is not installed"))?;
    // Its directory first, so a Node CLI finds the `node` installed next to it.
    let dirs = bin.parent().map(PathBuf::from).into_iter();
    let search = login_path().await.cloned().or_else(|| std::env::var_os("PATH")).unwrap_or_default();
    let path = std::env::join_paths(dirs.chain(std::env::split_paths(&search)))?;
    let out = command(&bin).args(args).env("PATH", path).stdin(Stdio::null()).output().await?;
    if !out.status.success() {
        bail!("{cli} {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// On PATH, else on the login shell's PATH.
async fn locate(cli: &str) -> Option<PathBuf> {
    if let Ok(bin) = which::which(cli) {
        return Some(bin);
    }
    which::which_in(cli, login_path().await, std::env::current_dir().ok()?).ok()
}

/// The login shell's PATH, read once: apps started from the Finder do not inherit it.
async fn login_path() -> Option<&'static OsString> {
    static PATH: OnceCell<Option<OsString>> = OnceCell::const_new();
    PATH.get_or_init(|| async {
        let shell = std::env::var("SHELL").ok()?;
        let out = command(shell)
            .args(["-lic", "echo \"$PATH\""])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        let out = tokio::time::timeout(Duration::from_secs(5), out).await.ok()?.ok()?;
        // Last line: an interactive shell may print its own output first.
        let path = String::from_utf8_lossy(&out.stdout).lines().last()?.trim().to_owned();
        (!path.is_empty()).then(|| path.into())
    })
    .await
    .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Echoes the parsed call; fails `sleep_machine`, and checks sizes as the app does.
    struct Echo;

    impl Tools for Echo {
        async fn call(self: Arc<Self>, call: Call) -> Result<String> {
            match call {
                Call::SleepMachine { .. } => bail!("an agent is working"),
                Call::ResizeMachine { size, .. } => Ok(crate::machine::provision::size(&size)?.id.into()),
                call => Ok(format!("{call:?}")),
            }
        }
    }

    async fn rpc(method: &str, params: Value) -> Value {
        let request = json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params });
        dispatch(Arc::new(Echo), request).await.unwrap()
    }

    #[tokio::test]
    async fn initialize_negotiates_the_version() {
        let r = rpc("initialize", json!({ "protocolVersion": "2025-03-26" })).await;
        assert_eq!(r["id"], 7);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "sail");
        assert_eq!(r["result"]["capabilities"], json!({ "tools": {} }));
        let r = rpc("initialize", json!({ "protocolVersion": "1999-01-01" })).await;
        assert_eq!(r["result"]["protocolVersion"], DEFAULT_PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn lists_tools_and_rejects_unknown_methods() {
        let tools = rpc("tools/list", json!({})).await["result"]["tools"].clone();
        let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 15);
        assert!(names.contains(&"sign_in_agent") && names.contains(&"delete_machine"));
        assert_eq!(rpc("ping", json!({})).await["result"], json!({}));
        assert_eq!(rpc("resources/list", json!({})).await["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn calls_tools() {
        let r = rpc("tools/call", json!({ "name": "list_machines" })).await;
        assert_eq!(r["result"], content("ListMachines".into(), false));
        let r = rpc("tools/call", json!({ "name": "create_machine", "arguments": { "name": "dev" } })).await;
        assert_eq!(r["result"]["content"][0]["text"], r#"CreateMachine { name: "dev", size: None, projects: [] }"#);
        let r = rpc("tools/call", json!({ "name": "sleep_machine", "arguments": { "machine": "dev" } })).await;
        assert_eq!(r["result"], content("an agent is working".into(), true));
        let r = rpc("tools/call", json!({ "name": "resize_machine", "arguments": { "machine": "dev", "size": "huge" } })).await;
        assert_eq!(r["result"], content("unknown size huge".into(), true));
        for bad in [
            json!({ "name": "format_disk", "arguments": { "machine": "dev" } }),
            json!({ "name": "wake_machine", "arguments": {} }),
        ] {
            assert_eq!(rpc("tools/call", bad).await["error"]["code"], -32602);
        }
    }

    async fn serve_echo() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(Arc::new(Echo))).await });
        format!("http://{addr}/mcp")
    }

    async fn post(headers: &[(&str, &str)], body: Value) -> (StatusCode, String) {
        let mut req = reqwest::Client::new().post(serve_echo().await).json(&body);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = req.send().await.unwrap();
        (res.status(), res.text().await.unwrap())
    }

    #[tokio::test]
    async fn http_answers_requests_and_notifications() {
        let (status, body) = post(&[], json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"], json!({}));
        let (status, body) = post(&[], json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!((status, body.as_str()), (StatusCode::ACCEPTED, ""));
        let ok = &[("host", "localhost:47731")];
        assert_eq!(post(ok, json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn http_rejects_web_pages_and_get() {
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        for headers in [
            &[("host", "evil.example:47731")][..],
            &[("host", "localhost.evil.example")],
            &[("origin", "https://evil.example")],
            &[("origin", "http://localhost:3000"), ("host", "localhost:47731")],
            &[("origin", "null")],
        ] {
            assert_eq!(post(headers, ping.clone()).await.0, StatusCode::FORBIDDEN, "{headers:?}");
        }
        let res = reqwest::get(serve_echo().await).await.unwrap();
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}

use super::MachineRuntime;
use crate::proxy::upstream;
use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use url::Url;

const URL_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "Claude" => Some(Self::Claude),
            "Codex" => Some(Self::Codex),
            _ => None,
        }
    }

    fn status(self) -> &'static str {
        match self {
            Self::Claude => "claude auth status >/dev/null 2>&1",
            Self::Codex => "codex login status >/dev/null 2>&1",
        }
    }
}

#[derive(Clone, Copy)]
pub enum Login {
    Agent(Agent),
    Connect,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Prompt {
    Browser { url: String },
    Device { url: String, code: String },
    Paste { url: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Pending,
    Complete,
    Cancelled,
    Expired,
    Failed,
}

impl Login {
    fn command(self, on_host: bool) -> &'static str {
        match self {
            Self::Agent(Agent::Claude) => "claude auth login",
            Self::Agent(Agent::Codex) if on_host => "codex login",
            Self::Agent(Agent::Codex) => "codex login --device-auth",
            Self::Connect => {
                r#""$HOME/.local/bin/t3" up --base-dir "$HOME/.t3" --connect --headless --yes"#
            }
        }
    }

    pub fn lifetime(self) -> Duration {
        match self {
            Self::Agent(_) => Duration::from_secs(600),
            Self::Connect => Duration::from_secs(900),
        }
    }

    pub fn accepts_code(self, on_host: bool) -> bool {
        matches!(self, Self::Agent(Agent::Claude)) && !on_host
    }

    fn prompt(self, on_host: bool, browser_url: &str, log: &str) -> Option<Prompt> {
        let urls = || log.split_whitespace().filter_map(https_url);
        match self {
            Self::Connect => {
                let (_, instructions) =
                    log.split_once("Sign in to T3 Connect. Open on any device:")?;
                let mut lines = instructions
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty());
                let url = https_url(lines.next()?)?;
                let code = lines.next()?.strip_prefix("Code: ")?.trim();
                if code.is_empty() {
                    return None;
                }
                Some(Prompt::Device {
                    url,
                    code: code.to_owned(),
                })
            }
            Self::Agent(_) if on_host => {
                let url = https_url(browser_url.trim())
                    .filter(|url| callback_port(url).is_some())
                    .or_else(|| urls().find(|url| callback_port(url).is_some()))?;
                Some(Prompt::Browser { url })
            }
            Self::Agent(Agent::Claude) => {
                let url = urls().find(|url| {
                    Url::parse(url)
                        .ok()
                        .and_then(|url| {
                            let redirect =
                                url.query_pairs().find(|(key, _)| key == "redirect_uri")?.1;
                            https_url(&redirect)
                        })
                        .is_some()
                })?;
                Some(Prompt::Paste { url })
            }
            Self::Agent(Agent::Codex) => {
                let url = urls().next()?;
                let code = log.lines().map(str::trim).find(|line| {
                    let (left, right) = line.split_once('-').unwrap_or_default();
                    (4..=5).contains(&left.len())
                        && (4..=5).contains(&right.len())
                        && left
                            .bytes()
                            .chain(right.bytes())
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                })?;
                Some(Prompt::Device {
                    url,
                    code: code.to_owned(),
                })
            }
        }
    }
}

pub fn https_url(value: &str) -> Option<String> {
    let parsed = Url::parse(value).ok()?;
    (parsed.scheme() == "https"
        && parsed.host().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none())
    .then(|| parsed.to_string())
}

fn callback_port(url: &str) -> Option<u16> {
    let url = Url::parse(url).ok()?;
    let redirect = url.query_pairs().find(|(key, _)| key == "redirect_uri")?.1;
    let redirect = Url::parse(&redirect).ok()?;
    (redirect.scheme() == "http" && matches!(redirect.host_str()?, "localhost" | "127.0.0.1"))
        .then_some(())?;
    redirect.port()
}

const LOGIN_WORKER: &str = r#"
d="$1"; seconds="$2"; login="$3"
echo "$$" > "$d/pid" || exit 1
trap 'if [ -n "$worker" ]; then wait "$worker"; fi; rm -f "$d/log" "$d/url" "$d/input" "$d/code"; echo 143 > "$d/exit"; exit 143' TERM
mkfifo -m 600 "$d/input"
exec 3<>"$d/input"
BROWSER="$d/browser" TERM=dumb NO_COLOR=1 FORCE_COLOR=0 timeout --foreground -k 5 "$seconds" script -qfec "stty -echo; exec $login" /dev/null <&3 >"$d/log" 2>&1 &
worker=$!
wait "$worker"
status=$?
rm -f "$d/code" "$d/input"
echo "$status" > "$d/exit"
# Keep the result briefly for the daemon, including if its connection drops.
sleep 60
rm -rf -- "$d"
"#;

fn launch_script(dir: &str, seconds: u64, login: &str) -> String {
    format!(
        r#"umask 077; d='{dir}'; mkdir -- "$d" || exit 1
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$1" > "$(dirname "$0")/url"' > "$d/browser"
chmod 700 "$d/browser"
nohup setsid bash -c '{}' sail-login "$d" {seconds} '{}' </dev/null >/dev/null 2>&1 &
for i in {{1..50}}; do [ -s "$d/pid" ] && exit 0; sleep 0.1; done
exit 1"#,
        shell_quote(LOGIN_WORKER),
        shell_quote(login),
    )
}

fn cleanup_script(dir: &str) -> String {
    format!(
        r#"d='{dir}'
if read -r pid < "$d/pid" && [[ $pid =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for i in {{1..60}}; do [ -f "$d/exit" ] && break; sleep 0.1; done
    [ -f "$d/exit" ] || exit 1
fi
rm -rf -- "$d""#
    )
}

fn shell_quote(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}

impl MachineRuntime {
    // The local MCP entry point still opens its user's browser and waits for the CLI.
    pub async fn sign_in(&self, agent: Agent) -> Result<()> {
        self.login_locally(Login::Agent(agent)).await
    }

    pub async fn turn_on_connect_locally(&self) -> Result<()> {
        self.login_locally(Login::Connect).await
    }

    async fn login_locally(&self, login: Login) -> Result<()> {
        let (prompt, opened) = oneshot::channel();
        let (_tx, input) = mpsc::channel(1);
        let (cancel, cancelled) = oneshot::channel();
        let (open, phase) = tokio::join!(
            async {
                if let Ok(prompt) = opened.await {
                    let url = match &prompt {
                        Prompt::Browser { url }
                        | Prompt::Device { url, .. }
                        | Prompt::Paste { url } => url,
                    };
                    if let Err(error) = self.shared.t3.open_url(url) {
                        let _ = cancel.send(());
                        return Err(error);
                    }
                }
                Ok(())
            },
            self.run_login(login, true, prompt, input, cancelled)
        );
        open?;
        anyhow::ensure!(phase == Phase::Complete, "Agent sign-in did not finish");
        Ok(())
    }

    pub async fn run_login(
        &self,
        login: Login,
        on_host: bool,
        prompt: oneshot::Sender<Prompt>,
        mut input: mpsc::Receiver<String>,
        mut cancelled: oneshot::Receiver<()>,
    ) -> Phase {
        let Ok(_signing_in) = self.signing_in.try_lock() else {
            return Phase::Failed;
        };
        if self.ensure_awake().await.is_err() {
            return Phase::Failed;
        }
        let target = self.sandbox_id();
        let boat = &self.shared.boat;
        let dir = format!("/tmp/sail-login-{}", crate::daemon::generate_hex_token());
        let mut launched = false;
        let job = async {
            if matches!(login, Login::Connect) {
                self.check_connect_idle().await?;
            }
            let launch = launch_script(&dir, login.lifetime().as_secs(), login.command(on_host));
            launched = true;
            anyhow::ensure!(boat.exec(&target, &launch, 15).await?.exit_code == Some(0));
            let read = || async {
                let out = boat.exec(&target, &format!(
                    "cat '{dir}/exit' 2>/dev/null; echo ---; cat '{dir}/url' 2>/dev/null; echo ---; tail -c 16384 '{dir}/log' 2>/dev/null; true"
                ), 10).await?;
                Ok::<_, anyhow::Error>(out.stdout)
            };
            let url_timeout = if matches!(login, Login::Connect) {
                Duration::from_secs(120)
            } else {
                URL_TIMEOUT
            };
            let mut prompt = Some(prompt);
            let mut forward = None;
            let started = tokio::time::Instant::now();
            let mut tick = tokio::time::interval(POLL_INTERVAL);
            loop {
                tokio::select! {
                    Some(code) = input.recv() => {
                        let mut file = tempfile::NamedTempFile::new()?;
                        use std::io::Write;
                        writeln!(file, "{code}")?;
                        boat.upload_login_code(&target, file.path(), &format!("{dir}/code")).await?;
                        let write = format!(
                            "timeout 5 bash -c 'cat \"$1/code\" > \"$1/input\"' send-code '{dir}'; status=$?; rm -f '{dir}/code'; exit \"$status\""
                        );
                        anyhow::ensure!(boat.exec(&target, &write, 8).await?.exit_code == Some(0));
                    }
                    _ = tick.tick() => {
                        let output = read().await?;
                        let (exit, rest) = output.split_once("---").unwrap_or_default();
                        let (browser_url, log) = rest.split_once("---").unwrap_or_default();
                        match exit.trim() {
                            "0" => break,
                            "124" | "137" => return Ok(Phase::Expired),
                            "" => {}
                            _ => return Ok(if log.contains("device code expired") || log.contains("Login timed out") {
                                Phase::Expired
                            } else {
                                Phase::Failed
                            }),
                        }
                        if let Some(next) = login.prompt(on_host, browser_url, log) && let Some(sender) = prompt.take() {
                            if on_host && matches!(login, Login::Agent(_)) && let Prompt::Browser { url } = &next {
                                let port = callback_port(url).ok_or_else(|| anyhow!("Missing callback port"))?;
                                forward = Some(boat.forward(&target, port).await?);
                            }
                            let _ = sender.send(next);
                        } else if prompt.is_some() && started.elapsed() >= url_timeout {
                            bail!("Agent sign-in did not produce a prompt");
                        }
                    }
                }
            }
            drop(forward);
            match login {
                Login::Connect => self.finish_connect().await?,
                Login::Agent(agent) => {
                    anyhow::ensure!(
                        boat.exec(&target, agent.status(), 15).await?.exit_code == Some(0)
                    );
                    if let Ok(result) = upstream::call(
                        &self.upstream_url(),
                        &self.upstream_token(),
                        "server.refreshProviders",
                        serde_json::json!({}),
                    )
                    .await
                    {
                        self.cache
                            .lock()
                            .unwrap()
                            .fold_providers(&result["providers"]);
                        self.save_cache();
                        self.shared.changed();
                    }
                }
            }
            Ok(Phase::Complete)
        };
        let phase = tokio::select! {
            Ok(()) = &mut cancelled => Phase::Cancelled,
            result = tokio::time::timeout(login.lifetime(), self.kept_awake(job)) => match result {
                Ok(Ok(phase)) => phase,
                Ok(Err(_)) => Phase::Failed,
                Err(_) => Phase::Expired,
            }
        };
        if !launched {
            return phase;
        }
        let cleanup = cleanup_script(&dir);
        match boat.exec(&target, &cleanup, 10).await {
            Ok(result) if result.exit_code == Some(0) => phase,
            _ => Phase::Failed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signin_chooses_the_manual_claude_link_and_local_callback_separately() {
        let local =
            "https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A43327%2Fcallback";
        let manual =
            "https://auth.example/authorize?redirect_uri=https%3A%2F%2Fauth.example%2Fcode";
        let login = Login::Agent(Agent::Claude);
        assert!(
            matches!(login.prompt(true, local, manual), Some(Prompt::Browser { url }) if url == local)
        );
        assert!(
            matches!(login.prompt(false, local, &format!("{local}\n{manual}")), Some(Prompt::Paste { url }) if url == manual)
        );
        assert!(login.prompt(false, local, local).is_none());
    }

    #[test]
    fn signin_requires_both_parts_of_the_codex_device_prompt() {
        let login = Login::Agent(Agent::Codex);
        let url = "https://auth.example/device";
        assert!(login.prompt(false, "", url).is_none());
        assert!(
            matches!(login.prompt(false, "", &format!("{url}\n   WXYZ-1234\n")), Some(Prompt::Device { url: target, code }) if target == url && code == "WXYZ-1234")
        );
    }

    #[test]
    fn signin_uses_the_connect_device_prompt_instead_of_an_earlier_link() {
        let log = "Help: https://docs.example/connect\nSign in to T3 Connect. Open on any device:\n  https://auth.example/device\nCode: FIXTURE\nWaiting for approval.";
        assert!(matches!(
            Login::Connect.prompt(false, "", log),
            Some(Prompt::Device { url, code }) if url == "https://auth.example/device" && code == "FIXTURE"
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn signin_cancellation_and_expiry_stop_the_cli_child() {
        for (expiry, seconds) in [(false, 30), (true, 3)] {
            let temp = tempfile::tempdir().unwrap();
            let dir = temp.path().join("attempt");
            let worker_pid = temp.path().join("worker.pid");
            let fixture = temp.path().join("fixture");
            std::fs::write(
                &fixture,
                format!(
                    "echo $$ > '{}'; exec sleep infinity\n",
                    worker_pid.display()
                ),
            )
            .unwrap();
            let launch = launch_script(
                dir.to_str().unwrap(),
                seconds,
                &format!("bash '{}'", fixture.display()),
            );
            let cleanup = cleanup_script(dir.to_str().unwrap());
            let harness = format!(
                r#"set -eu
bash -c '{}'
for i in {{1..100}}; do [ -s '{pid}' ] && break; sleep 0.02; done
pid=$(cat '{pid}')
kill -0 "$pid"
if {expiry}; then
    for i in {{1..200}}; do [ -s '{dir}/exit' ] && break; sleep 0.05; done
    [ "$(cat '{dir}/exit')" = 124 ]
fi
bash -c '{}'
[ ! -e '{dir}' ]
if kill -0 "$pid" 2>/dev/null; then exit 1; fi"#,
                shell_quote(&launch),
                shell_quote(&cleanup),
                dir = dir.display(),
                pid = worker_pid.display(),
            );
            let output = std::process::Command::new("bash")
                .args(["-c", &harness])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

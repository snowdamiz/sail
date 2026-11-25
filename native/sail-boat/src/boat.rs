//! Thin wrapper over the user's own Boat CLI. Uses its existing login; never stores Boat credentials.

use crate::process::command;
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Boat's longest lifetime on a free trial, which refuses `--no-auto-stop`.
const TRIAL_TTL_SECS: u64 = 7200;

#[derive(Clone, Debug)]
pub struct Boat {
    bin: PathBuf,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    pub id: String,
    pub state: String,
    pub stopped_at: Option<chrono::DateTime<chrono::Utc>>,
    /// When Boat stops it on its own; none without a lifetime or while stopped.
    pub archive_after: Option<chrono::DateTime<chrono::Utc>>,
    pub ttl_seconds: Option<u64>,
}

impl Sandbox {
    /// When Boat stops it on its own, for a trial lifetime this app set. One the user set
    /// themselves is theirs to keep.
    pub fn trial_deadline(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        self.archive_after.filter(|_| self.ttl_seconds == Some(TRIAL_TTL_SECS))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub identifier: Option<String>,
    pub signed_in: bool,
    pub plan: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub dollars: f64,
    pub seconds: u64,
}

/// A pending browser sign-in: the page that completes it, and the code that page may ask for.
#[derive(Clone, Debug)]
pub struct SignIn {
    pub url: String,
    pub code: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resume {
    Resumed,
    /// Boat deleted the stopped sandbox's disk: it keeps one 14 days.
    DataExpired,
}

#[derive(Clone, Debug, Default)]
pub struct Starts {
    pub used_today: u64,
    pub limit_today: u64,
}

impl Boat {
    /// Finds the CLI the Boat installer puts in `~/.ascii/bin`, else on PATH.
    pub fn locate() -> Option<Self> {
        let exe = if cfg!(windows) { "boat.exe" } else { "boat" };
        let installed = dirs::home_dir().map(|h| h.join(".ascii").join("bin").join(exe));
        installed
            .filter(|p| p.is_file())
            .or_else(|| which::which("boat").ok())
            .map(|bin| Self { bin })
    }

    #[cfg(test)]
    pub fn at(bin: PathBuf) -> Self {
        Self { bin }
    }

    /// Runs the CLI; returns whether it succeeded, stdout and stderr.
    async fn output(&self, args: &[&str], timeout: Duration) -> Result<(bool, String, String)> {
        let mut cmd = command(&self.bin);
        // `--json` first: anything after `--` belongs to the remote command, and a nested
        // subcommand (`snapshot rm`) is only read as one with no option before it.
        cmd.arg("--json")
            .args(args)
            .env("BOAT_NO_UPDATE", "1")
            .kill_on_drop(true);
        // Only the subcommand goes into errors: arguments can hold scripts.
        let sub = args.first().copied().unwrap_or_default();
        let out = tokio::time::timeout(timeout, cmd.output())
            .await
            .map_err(|_| anyhow!("boat {sub} timed out"))?
            .with_context(|| format!("running boat {sub}"))?;
        Ok((
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }

    /// Free-trial accounts refuse `--no-auto-stop`; they get Boat's longest trial lifetime instead.
    async fn output_without_auto_stop(&self, args: &[&str], timeout: Duration) -> Result<(bool, String, String)> {
        let (ok, stdout, stderr) = self.output(&[args, &["--no-auto-stop"]].concat(), timeout).await?;
        if ok || !said(&stdout, &stderr).contains("trial_auto_stop_required") {
            return Ok((ok, stdout, stderr));
        }
        let ttl = TRIAL_TTL_SECS.to_string();
        self.output(&[args, &["--ttl", &ttl]].concat(), timeout).await
    }

    async fn run(&self, args: &[&str], timeout: Duration) -> Result<String> {
        let (ok, stdout, stderr) = self.output(args, timeout).await?;
        if !ok {
            let sub = args.first().copied().unwrap_or_default();
            bail!("boat {sub} failed: {}", said(&stdout, &stderr));
        }
        Ok(stdout)
    }

    /// The CLI prints JSON lines for long operations; the last line is the result.
    fn last_json(out: &str) -> Result<Value> {
        let line = out
            .lines()
            .rev()
            .find(|l| l.trim_start().starts_with('{'))
            .ok_or_else(|| anyhow!("boat printed no JSON: {out}"))?;
        Ok(serde_json::from_str(line)?)
    }

    pub async fn account(&self) -> Result<Account> {
        let v = Self::last_json(&self.run(&["status"], Duration::from_secs(20)).await?)?;
        Ok(serde_json::from_value(v["account"].clone())?)
    }

    /// Returns the new sandbox's id. `snapshot`: the saved snapshot its disk starts from.
    pub async fn create(&self, name: &str, size: &str, snapshot: Option<&str>) -> Result<String> {
        let mut args = vec!["new", "--name", name, "--type", size];
        args.extend(snapshot.into_iter().flat_map(|s| ["--from", s]));
        let (ok, stdout, stderr) = self.output_without_auto_stop(&args, Duration::from_secs(300)).await?;
        if !ok {
            bail!("boat new failed: {}", said(&stdout, &stderr));
        }
        let v = Self::last_json(&stdout)?;
        let id = v["id"].as_str().ok_or_else(|| anyhow!("boat new returned no id"))?;
        Ok(id.to_owned())
    }

    pub async fn info(&self, id: &str) -> Result<Sandbox> {
        let v = Self::last_json(&self.run(&["info", id], Duration::from_secs(20)).await?)?;
        Ok(serde_json::from_value(v["sandbox"].clone())?)
    }

    pub async fn list(&self) -> Result<Vec<Sandbox>> {
        let v = Self::last_json(&self.run(&["list", "--all"], Duration::from_secs(20)).await?)?;
        Ok(serde_json::from_value(v["sandboxes"].clone())?)
    }

    /// Gone only when Boat's own list confirms it: one bad answer must not retire a machine.
    pub async fn confirmed_gone(&self, id: &str) -> bool {
        matches!(self.list().await, Ok(l) if l.iter().all(|s| s.id != id))
    }

    /// Resumes onto `size`, which is how a machine changes size.
    pub async fn resume(&self, id: &str, size: &str) -> Result<Resume> {
        let (ok, stdout, stderr) =
            self.output_without_auto_stop(&["resume", id, "--type", size], Duration::from_secs(300)).await?;
        let said = said(&stdout, &stderr);
        match ok {
            true => Ok(Resume::Resumed),
            false if said.contains("snapshot_data_expired") => Ok(Resume::DataExpired),
            false => bail!("boat resume failed: {said}"),
        }
    }

    /// Saves the sandbox's disk as `name`, replacing one of that name. A stopped sandbox stays
    /// stopped and bills nothing for it.
    pub async fn save_snapshot(&self, id: &str, name: &str) -> Result<()> {
        self.run(&["snapshot", id, name], Duration::from_secs(10 * 60)).await.map(drop)
    }

    pub async fn delete_snapshot(&self, name: &str) -> Result<()> {
        self.run(&["snapshot", "rm", name], Duration::from_secs(60)).await.map(drop)
    }

    /// The saved snapshots' names. A row without one fails: it must never pass as proof of absence.
    pub async fn named_snapshots(&self) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Named {
            name: String,
        }
        let v = Self::last_json(&self.run(&["snapshots"], Duration::from_secs(20)).await?)?;
        let named: Vec<Named> = serde_json::from_value(v["named"].clone())?;
        Ok(named.into_iter().map(|n| n.name).collect())
    }

    /// Stops and snapshots it for resume; returns once Boat took the stop.
    pub async fn stop(&self, id: &str) -> Result<()> {
        self.run(&["stop", id], Duration::from_secs(60)).await.map(drop)
    }

    /// Resets a trial sandbox's lifetime to the longest. Only from here: the sandbox's own key
    /// can't extend it.
    pub async fn extend_trial(&self, id: &str) -> Result<()> {
        let ttl = TRIAL_TTL_SECS.to_string();
        self.run(&["extend", id, "--ttl", &ttl], Duration::from_secs(20)).await.map(drop)
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        self.run(&["delete", id, "--yes"], Duration::from_secs(120))
            .await
            .map(drop)
    }

    /// Exposes `port` (bound to loopback on the sandbox) on a stable public HTTPS URL.
    pub async fn host_public(&self, id: &str, port: u16) -> Result<String> {
        let port = port.to_string();
        let v = Self::last_json(
            &self
                .run(&["host", id, &port, "--public", "--localhost"], Duration::from_secs(60))
                .await?,
        )?;
        v["url"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("boat host returned no url"))
    }

    pub async fn exec(&self, id: &str, script: &str, timeout_secs: u64) -> Result<ExecResult> {
        let t = timeout_secs.to_string();
        // The CLI exits with the command's code; its JSON result is what matters.
        let (_, stdout, stderr) = self
            .output(
                &["exec", id, "--timeout", &t, "--", "bash", "-lc", script],
                Duration::from_secs(timeout_secs + 60),
            )
            .await?;
        match Self::last_json(&stdout) {
            Ok(v) => Ok(serde_json::from_value(v)?),
            Err(_) => bail!("boat exec failed: {}", stderr.trim()),
        }
    }

    /// Runs `script` and fails unless it exits 0. Returns stdout.
    pub async fn exec_ok(&self, id: &str, script: &str, timeout_secs: u64) -> Result<String> {
        let r = self.exec(id, script, timeout_secs).await?;
        if r.exit_code != Some(0) {
            let detail = if r.stderr.trim().is_empty() { r.stdout.trim() } else { r.stderr.trim() };
            bail!("command on the machine failed ({:?}): {detail}", r.exit_code);
        }
        Ok(r.stdout)
    }

    pub async fn usage_since(&self, id: &str, since_unix: i64) -> Result<Usage> {
        let since = since_unix.to_string();
        let v = Self::last_json(
            &self.run(&["usage", id, "--since", &since], Duration::from_secs(20)).await?,
        )?;
        Ok(serde_json::from_value(v)?)
    }

    pub async fn starts(&self) -> Result<Starts> {
        let v = Self::last_json(&self.run(&["limits", "--all"], Duration::from_secs(20)).await?)?;
        let day = &v["starts"]["day"];
        Ok(Starts {
            used_today: day["used"].as_u64().unwrap_or(0),
            limit_today: day["limit"].as_u64().unwrap_or(0),
        })
    }

    /// Starts a browser sign-in, or picks up the one already pending. Without a terminal the
    /// CLI opens no browser, so the caller opens the page.
    pub async fn start_sign_in(&self) -> Result<SignIn> {
        let v = Self::last_json(&self.run(&["onboard"], Duration::from_secs(60)).await?)?;
        let url = v["url"].as_str().ok_or_else(|| anyhow!("boat onboard gave no sign-in page: {v}"))?;
        Ok(SignIn { url: url.to_owned(), code: v["userCode"].as_str().map(str::to_owned) })
    }

    /// Waits until the started sign-in completes or expires.
    pub async fn finish_sign_in(&self) -> Result<()> {
        self.run(&["onboard", "--wait"], Duration::from_secs(900)).await.map(drop)
    }

    /// Copies a local file to `remote_path` on the sandbox.
    pub async fn upload(&self, id: &str, local: &Path, remote_path: &str) -> Result<()> {
        let to = format!("{id}:{remote_path}");
        self.run(&["scp", path_str(local)?, &to], Duration::from_secs(1800)).await.map(drop)
    }

    /// Forwards `port` on this computer to the same port in the sandbox, for as long as the
    /// returned process lives.
    pub async fn forward(&self, id: &str, port: u16) -> Result<tokio::process::Child> {
        // Else another listener on the port would pass the readiness check below.
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
            bail!("port {port} is in use on this computer; finish or close the other sign-in first");
        }
        let p = port.to_string();
        let mut child = command(&self.bin)
            .args(["forward", id, "--remote", &p, "--local", &p])
            .env("BOAT_NO_UPDATE", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("running boat forward")?;
        for _ in 0..100 {
            if let Some(status) = child.try_wait()? {
                bail!("boat forward exited ({status}); is port {port} free on this computer?");
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                return Ok(child);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        bail!("boat forward did not open port {port}")
    }
}

/// What a failed command said: its stderr, else its stdout.
fn said<'a>(stdout: &'a str, stderr: &'a str) -> &'a str {
    if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }
}

/// Command-line form of a path; the Boat CLI and git only take UTF-8 here.
pub(crate) fn path_str(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| anyhow!("path is not UTF-8: {}", path.display()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::{Boat, Resume, Sandbox};
    use std::os::unix::fs::PermissionsExt;

    const TRIAL_BOAT: &str = r#"#!/bin/sh
d=$(dirname "$0"); shift
echo "$*" >> "$d/log"
case " $* " in
  *" --no-auto-stop "*) [ -f "$d/trial" ] || [ -f "$d/down" ] || { echo '{"id":"bx_new"}'; exit 0; }
    [ -f "$d/down" ] && { echo 'Boat is down' >&2; exit 1; }
    echo '{"code":"trial_auto_stop_required","error":"Set a TTL of 2 hours or less"}' >&2; exit 1 ;;
  *" --ttl 7200 "*) echo '{"id":"bx_new"}' ;;
  *) exit 1 ;;
esac
"#;

    fn fake_boat(name: &str, flag: Option<&str>) -> (Boat, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("sail-boat-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("boat");
        std::fs::write(&bin, TRIAL_BOAT).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        if let Some(flag) = flag {
            std::fs::write(dir.join(flag), "").unwrap();
        }
        (Boat::at(bin), dir)
    }

    fn calls(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("log")).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    #[tokio::test]
    async fn trial_accounts_get_the_longest_ttl_instead_of_no_auto_stop() {
        let (boat, dir) = fake_boat("trial", Some("trial"));
        assert_eq!(boat.create("m", "default", None).await.unwrap(), "bx_new");
        assert_eq!(boat.resume("bx_new", "small").await.unwrap(), Resume::Resumed);
        assert_eq!(
            calls(&dir),
            [
                "new --name m --type default --no-auto-stop",
                "new --name m --type default --ttl 7200",
                "resume bx_new --type small --no-auto-stop",
                "resume bx_new --type small --ttl 7200",
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn paid_accounts_and_other_failures_never_fall_back_to_a_ttl() {
        let (paid, dir) = fake_boat("paid", None);
        assert_eq!(paid.create("m", "large", None).await.unwrap(), "bx_new");
        assert_eq!(calls(&dir), ["new --name m --type large --no-auto-stop"]);
        let _ = std::fs::remove_dir_all(&dir);

        let (down, dir) = fake_boat("down", Some("down"));
        let err = down.create("m", "default", None).await.unwrap_err().to_string();
        assert!(err.contains("Boat is down"), "{err}");
        assert_eq!(calls(&dir), ["new --name m --type default --no-auto-stop"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What the fake `boat` printed when `scripts/fixtures/fake-boat.test.ts` last ran with
    /// `FAKE_BOAT_RECORD=1`. Later PRs verify on that fake, so these parsers must read it.
    const RECORDED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/fixtures/fake-boat/recorded/");

    fn recorded_boat() -> (Boat, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("sail-boat-recorded-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = format!(
            r#"#!/bin/sh
r='{RECORDED}'
[ "$1" = --json ] && shift
case "$1" in
  new) case " $* " in *" --no-auto-stop "*) cat "$r/new-trial-refused.stderr" >&2; exit 1 ;; esac
    cat "$r/new.jsonl" ;;
  info) if [ "$2" = stopped ]; then cat "$r/info-stopped.jsonl"; else cat "$r/info.jsonl"; fi ;;
  status|onboard|list|snapshots|host|exec|usage|limits) cat "$r/$1.jsonl" ;;
  *) exit 1 ;;
esac
"#
        );
        let bin = dir.join("boat");
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (Boat::at(bin), dir)
    }

    #[tokio::test]
    async fn parses_what_the_fake_boat_prints() {
        let (boat, dir) = recorded_boat();
        let account = boat.account().await.unwrap();
        assert!(account.signed_in);
        assert_eq!(account.identifier.as_deref(), Some("fake-user@localtest.me"));
        assert_eq!(account.plan.as_deref(), Some("trial"));

        let id = boat.create("sail · m", "small", None).await.unwrap();
        assert!(id.starts_with("bx-"), "{id}");
        let sandbox = boat.info(&id).await.unwrap();
        assert_eq!((sandbox.id.as_str(), sandbox.state.as_str()), (id.as_str(), "running"));
        assert_eq!((sandbox.stopped_at, sandbox.ttl_seconds), (None, Some(7200)));
        assert!(sandbox.trial_deadline().is_some());
        assert_eq!(boat.list().await.unwrap(), vec![sandbox]);
        let stopped = boat.info("stopped").await.unwrap();
        assert_eq!((stopped.id.as_str(), stopped.state.as_str()), (id.as_str(), "stopped"));
        assert!(stopped.stopped_at.is_some());
        assert_eq!(stopped.archive_after, None);

        let names = boat.named_snapshots().await.unwrap();
        assert!(matches!(names.as_slice(), [n] if n.starts_with("fake-boat-test-")), "{names:?}");
        let url = boat.host_public(&id, 8123).await.unwrap();
        assert!(url.starts_with(&format!("https://{id}-8123.localtest.me")), "{url}");
        let ran = boat.exec(&id, "id -un", 30).await.unwrap();
        assert_eq!(ran.exit_code, Some(0));
        assert!(ran.stdout.starts_with("user\n"), "{}", ran.stdout);
        assert_eq!(boat.usage_since(&id, 0).await.unwrap().dollars, 0.0);
        let starts = boat.starts().await.unwrap();
        assert_eq!((starts.used_today, starts.limit_today), (4, 100));
        let sign_in = boat.start_sign_in().await.unwrap();
        let code = sign_in.code.unwrap();
        assert_eq!(sign_in.url, format!("https://auth.localtest.me/boat/device?code={code}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_trial_lifetime_this_app_sets_is_renewed() {
        let ends = "2026-11-24T12:00:00Z".parse().unwrap();
        let sandbox = |ttl_seconds| Sandbox {
            id: "bx_1".into(),
            state: "running".into(),
            stopped_at: None,
            archive_after: Some(ends),
            ttl_seconds,
        };
        assert_eq!(sandbox(Some(7200)).trial_deadline(), Some(ends));
        assert_eq!(sandbox(None).trial_deadline(), None);
        assert_eq!(sandbox(Some(3600)).trial_deadline(), None);
    }
}

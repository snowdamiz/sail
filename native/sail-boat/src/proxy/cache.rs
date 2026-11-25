//! What the proxy knows about a machine's T3 server, kept so it can answer while the machine
//! sleeps. Persisted per machine, so a restart of the daemon does not force a wake.

use super::classify::{is_connection_stream, recorded_stream, Recording};
use super::threads::{ThreadFlags, STALE_AFTER};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const MAX_STREAM_ITEMS: usize = 500;
const MAX_UNARY: usize = 300;

/// The final orchestration state, captured while the watchdog drains the machine for sleep.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    /// Unix ms when captured, then when the watchdog accepted its ack or was seen stopping at it.
    pub at: i64,
    /// `latestApplicationSequence`: the shell cursor of a client that missed nothing.
    pub sequence: u64,
    /// Per-thread high-water marks: the thread cursor of a client that missed nothing.
    pub threads: HashMap<String, u64>,
    /// The HTTP shell snapshot, unfiltered, so it serves every client whatever it asked to
    /// leave out.
    pub shell: Value,
    /// The watchdog stopped the machine at exactly this sequence. Only then is it trusted.
    pub confirmed: bool,
}

/// How to answer a shell request from the capture.
pub enum Shell<'a> {
    /// The client's cursor is the machine's final sequence: it missed nothing.
    UpToDate,
    Snapshot(&'a Value),
}

impl Capture {
    /// `after`: the client's shell cursor. `None`: only the machine can answer.
    pub fn shell(&self, after: Option<u64>) -> Option<Shell<'_>> {
        match after {
            Some(a) if a == self.sequence => Some(Shell::UpToDate),
            // Ahead of the machine's final state: something is off.
            Some(a) if a > self.sequence => None,
            _ => Some(Shell::Snapshot(&self.shell)),
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A recorded stream: its items, and when a client last asked for it (unix ms).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Replay {
    pub value: Vec<Value>,
    pub asked: i64,
}

/// A recorded answer: the epoch it describes, and when a client last asked for it (unix ms).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Answer {
    pub epoch: u64,
    pub value: Value,
    pub asked: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Cache {
    pub descriptor: Option<Value>,
    pub auth_session: Option<serde_json::Map<String, Value>>,
    pub capture: Option<Capture>,
    /// Moves on whenever the machine's state may have changed (an agent working, a user
    /// action). Answers recorded in an earlier epoch no longer describe the machine.
    pub epoch: u64,
    /// Streams by `request_key`. Side information around a chat (git status, terminals, ...):
    /// replayed as last seen rather than waking the machine.
    pub streams: HashMap<String, Replay>,
    /// Unary success values by `request_key`.
    pub unary: HashMap<String, Answer>,
    /// The thread snapshot encoding Sail last asked for: the one the capture stores chats in.
    pub thread_encoding: Option<ThreadFlags>,
    /// Deferred thread UI commands, sent on the next wake.
    pub deferred_commands: Vec<Value>,
    /// The last answer to `GET /api/voice/status`, which Sail reads on its own as it starts.
    pub voice_status: Option<Value>,
}

pub fn request_key(tag: &str, payload: &Value) -> String {
    format!("{tag} {payload}")
}

fn key_tag(key: &str) -> &str {
    key.split(' ').next().unwrap_or_default()
}

impl Cache {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(self)?)
    }

    pub fn bump_epoch(&mut self) {
        self.epoch += 1;
    }

    /// `first`: the stream's first chunk, which starts a new recording.
    pub fn record_stream_items(&mut self, tag: &str, key: &str, values: &[Value], first: bool) {
        let Some(mode) = recorded_stream(tag) else {
            return;
        };
        let now = now_ms();
        if first {
            self.streams.insert(key.to_owned(), Replay { value: Vec::new(), asked: now });
        }
        // Dropped as too chatty: no snapshot to add deltas to.
        let Some(entry) = self.streams.get_mut(key) else {
            return;
        };
        // A stream that still delivers is one a client asks for.
        entry.asked = now;
        let items = &mut entry.value;
        match mode {
            Recording::Latest => {
                if let Some(last) = values.last() {
                    *items = vec![last.clone()];
                }
            }
            // A row collapsed mid-run leaves nothing: part of an output must not replay as all of it.
            Recording::Final => {
                if let Some(last) = values.last().filter(|v| v["running"] == false) {
                    *items = vec![last.clone()];
                }
            }
            Recording::Config => values.iter().for_each(|v| record_config_event(items, v)),
            Recording::All => {
                items.extend(values.iter().cloned());
                if items.len() > MAX_STREAM_ITEMS {
                    // Too chatty to replay: forget it rather than replay part of it.
                    self.streams.remove(key);
                }
            }
        }
    }

    /// An answer to a `recorded_unary` call. `epoch`: the one it was asked in. A change since
    /// then made it stale.
    pub fn record_unary(&mut self, key: &str, epoch: u64, value: &Value) {
        if self.unary.len() >= MAX_UNARY && !self.unary.contains_key(key) {
            if let Some(oldest) = self.unary.iter().min_by_key(|(_, r)| r.asked).map(|(k, _)| k.clone()) {
                self.unary.remove(&oldest);
            }
        }
        self.unary.insert(key.to_owned(), Answer { epoch, value: value.clone(), asked: now_ms() });
    }

    /// A recorded stream, for a client asking for it again.
    pub fn stream(&mut self, key: &str) -> Option<Vec<Value>> {
        let replay = self.streams.get_mut(key).filter(|r| !r.value.is_empty())?;
        replay.asked = now_ms();
        Some(replay.value.clone())
    }

    /// A recorded answer that still describes the machine; `any_epoch` where a slightly stale
    /// one beats waking the machine.
    pub fn unary(&mut self, key: &str, any_epoch: bool) -> Option<Value> {
        let epoch = self.epoch;
        let answer = self.unary.get_mut(key).filter(|r| any_epoch || r.epoch == epoch)?;
        answer.asked = now_ms();
        Some(answer.value.clone())
    }

    /// Every recorded answer to `tag`, whatever its payload.
    pub fn answers<'a>(&'a self, tag: &'a str) -> impl Iterator<Item = &'a Value> {
        self.unary.iter().filter(move |(key, _)| key_tag(key) == tag).map(|(_, answer)| &answer.value)
    }

    /// T3's scratch folder, the "No project" project, from the server config Sail last read.
    pub fn scratch_root(&self) -> Option<String> {
        let root = |v: &Value| {
            v["scratchWorkspaceRoot"].as_str().or(v["config"]["scratchWorkspaceRoot"].as_str()).map(str::to_owned)
        };
        self.answers("server.getConfig").find_map(root).or_else(|| {
            self.streams
                .iter()
                .filter(|(key, _)| key_tag(key) == "subscribeServerConfig")
                .flat_map(|(_, replay)| &replay.value)
                .find_map(root)
        })
    }

    /// The recorded reads of a project's `t3.json`: their key, and the payload it ends in.
    pub fn project_config_reads(&self) -> Vec<(String, Value)> {
        self.unary
            .keys()
            .filter_map(|key| {
                let payload: Value = serde_json::from_str(key.strip_prefix("projects.readFile ")?).ok()?;
                (payload["relativePath"] == "t3.json").then(|| (key.clone(), payload))
            })
            .collect()
    }

    /// A recorded answer read from the machine again, asked in `epoch`. When a client last
    /// asked for it stays, so one no client asks for still expires.
    pub fn refresh_unary(&mut self, key: &str, epoch: u64, value: Value) {
        if let Some(answer) = self.unary.get_mut(key) {
            (answer.epoch, answer.value) = (epoch, value);
        }
    }

    /// Drops what no client asked for in `STALE_AFTER`. Connection streams stay: connecting
    /// must never wake.
    pub fn prune(&mut self) {
        let cutoff = now_ms() - STALE_AFTER.num_milliseconds();
        self.streams.retain(|key, r| r.asked >= cutoff || is_connection_stream(key_tag(key)));
        self.unary.retain(|_, r| r.asked >= cutoff);
    }

    /// Folds fresh provider statuses (e.g. a `server.refreshProviders` result) into the
    /// recorded configs, as a live `providerStatuses` event would.
    pub fn fold_providers(&mut self, providers: &Value) {
        if !providers.is_array() {
            return;
        }
        let event = json!({"type": "providerStatuses", "payload": {"providers": providers}});
        self.streams
            .iter_mut()
            .filter(|(k, _)| k.starts_with("subscribeServerConfig "))
            .for_each(|(_, r)| record_config_event(&mut r.value, &event));
    }

    /// The machine's enabled agent providers, per its last config: name and auth status.
    pub fn agents(&self) -> Vec<(String, String)> {
        self.streams
            .iter()
            .filter(|(k, _)| k.starts_with("subscribeServerConfig "))
            .flat_map(|(_, r)| &r.value)
            .find(|i| i["type"] == "snapshot")
            .and_then(|s| s["config"]["providers"].as_array())
            .into_iter()
            .flatten()
            .filter(|p| p["enabled"] == true)
            .filter_map(|p| {
                Some((
                    p["displayName"].as_str()?.to_owned(),
                    p["auth"]["status"].as_str().unwrap_or("unknown").to_owned(),
                ))
            })
            .collect()
    }

    /// Enabled agents that are not signed in.
    pub fn signed_out_providers(&self) -> Vec<String> {
        self.agents().into_iter().filter(|(_, s)| s == "unauthenticated").map(|(n, _)| n).collect()
    }
}

pub fn cache_path(machine_dir: &Path) -> PathBuf {
    machine_dir.join("cache.json")
}

/// Folds a config event into the recording: provider statuses into the snapshot, every other
/// event type replaces its previous one (each replaces one part of the config).
fn record_config_event(items: &mut Vec<Value>, event: &Value) {
    let providers = items
        .iter_mut()
        .find(|i| i["type"] == "snapshot")
        .and_then(|s| s.get_mut("config"))
        .and_then(|c| c.get_mut("providers"));
    match (event["type"].as_str(), providers) {
        (Some("snapshot"), _) => *items = vec![event.clone()],
        (Some("providerStatuses"), Some(providers)) => *providers = event["payload"]["providers"].clone(),
        (Some("providerStatusDeltas"), Some(providers)) => {
            *providers = Value::Array(apply_provider_deltas(providers, &event["payload"]["providers"]))
        }
        // Without a snapshot to fold into, a provider event has nothing to say.
        (Some("providerStatuses" | "providerStatusDeltas"), None) => {}
        _ => match items.iter().position(|i| i["type"] == event["type"]) {
            Some(i) => items[i] = event.clone(),
            None => items.push(event.clone()),
        },
    }
}

/// T3's `applyServerProviderDeltas`: each delta is a whole provider, minus the lists equal to
/// the held provider's.
fn apply_provider_deltas(held: &Value, deltas: &Value) -> Vec<Value> {
    let held = held.as_array().map(Vec::as_slice).unwrap_or_default();
    deltas
        .as_array()
        .into_iter()
        .flatten()
        .map(|delta| {
            let mut provider =
                held.iter().find(|p| p["instanceId"] == delta["instanceId"]).cloned().unwrap_or_else(|| json!({}));
            if let (Some(p), Some(d)) = (provider.as_object_mut(), delta.as_object()) {
                p.extend(d.iter().map(|(k, v)| (k.clone(), v.clone())));
            }
            provider
        })
        .collect()
}

/// Sail learns LAN and tailnet routes from `directEndpoints` and would bypass the proxy.
pub fn sanitize_server_config(config: &mut Value) {
    if let Some(config) = config.as_object_mut() {
        config.remove("directEndpoints");
    }
}

/// A replayed config snapshot must carry the current time: the client uses it as clock reference.
pub fn refresh_server_time(item: &mut Value) {
    if let Some(config) = item.get_mut("config").and_then(Value::as_object_mut) {
        if config.contains_key("serverTime") {
            config.insert(
                "serverTime".into(),
                Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "subscribeServerConfig {}";

    fn provider(id: &str, status: &str, models: Value) -> Value {
        json!({"instanceId": id, "displayName": id, "enabled": true, "auth": {"status": status}, "models": models})
    }

    #[test]
    fn overflowed_stream_is_not_recreated_from_deltas() {
        let mut c = Cache::default();
        let tag = "subscribeVcsStatus";
        c.record_stream_items(tag, "k", &vec![json!(0); MAX_STREAM_ITEMS + 1], true);
        c.record_stream_items(tag, "k", &[json!(1)], false);
        assert!(c.stream("k").is_none());
        c.record_stream_items(tag, "k", &[json!(2)], true);
        assert_eq!(c.stream("k"), Some(vec![json!(2)]));
    }

    #[test]
    fn a_command_output_is_recorded_once_it_is_finished() {
        let mut c = Cache::default();
        let tag = "orchestration.subscribeCommandOutput";
        let frame =
            |kind: &str, running: bool| json!({"kind": kind, "text": "a", "truncated": false, "running": running});
        c.record_stream_items(tag, "k", &[frame("replace", true), frame("append", true)], true);
        assert!(c.stream("k").is_none());
        c.record_stream_items(tag, "k", &[frame("append", true), frame("replace", false)], false);
        assert_eq!(c.stream("k"), Some(vec![frame("replace", false)]));
    }

    #[test]
    fn unasked_recordings_are_pruned() {
        let mut c = Cache::default();
        c.record_stream_items("subscribeVcsStatus", "subscribeVcsStatus {}", &[json!(1)], true);
        c.record_stream_items("subscribeServerConfig", CONFIG, &[json!({"type": "snapshot"})], true);
        c.record_unary("old", c.epoch, &json!(1));
        c.record_unary("new", c.epoch, &json!(2));
        let long_ago = now_ms() - STALE_AFTER.num_milliseconds() - 1;
        c.streams.values_mut().for_each(|r| r.asked = long_ago);
        c.unary.get_mut("old").unwrap().asked = long_ago;
        c.prune();
        assert_eq!(c.streams.keys().collect::<Vec<_>>(), vec![CONFIG]);
        assert_eq!(c.unary.keys().collect::<Vec<_>>(), vec!["new"]);
    }

    #[test]
    fn a_live_stream_counts_as_asked_for() {
        let mut c = Cache::default();
        c.record_stream_items("subscribeVcsStatus", "s", &[json!(1)], true);
        c.streams.get_mut("s").unwrap().asked = now_ms() - STALE_AFTER.num_milliseconds() - 1;
        c.record_stream_items("subscribeVcsStatus", "s", &[json!(2)], false);
        c.prune();
        assert_eq!(c.stream("s"), Some(vec![json!(1), json!(2)]));
    }

    #[test]
    fn answers_go_stale_with_the_epoch_but_streams_do_not() {
        let mut c = Cache::default();
        c.record_stream_items("subscribeVcsStatus", "s", &[json!(1)], true);
        c.record_unary("u", c.epoch, &json!(1));
        c.bump_epoch();
        assert_eq!(c.stream("s"), Some(vec![json!(1)]));
        assert!(c.unary("u", false).is_none());
        assert_eq!(c.unary("u", true), Some(json!(1)));
    }

    #[test]
    fn an_answer_asked_before_a_change_is_stale_on_arrival() {
        let mut c = Cache::default();
        let asked = c.epoch;
        c.bump_epoch();
        c.record_unary("u", asked, &json!(1));
        assert!(c.unary("u", false).is_none());
        assert_eq!(c.unary("u", true), Some(json!(1)));
    }

    #[test]
    fn a_project_config_read_again_is_true_in_its_epoch_and_expires_as_before() {
        let mut c = Cache::default();
        let read = "projects.readFile";
        let config = json!({"cwd": "/w", "relativePath": "t3.json", "allowMissing": true});
        let key = request_key(read, &config);
        c.record_unary(&key, c.epoch, &json!("old"));
        c.record_unary(&request_key(read, &json!({"cwd": "/w", "relativePath": "src/t3.json"})), c.epoch, &json!(1));
        c.record_unary(&request_key("vcs.listRefs", &config), c.epoch, &json!(2));
        assert_eq!(c.project_config_reads(), vec![(key.clone(), config)]);

        c.bump_epoch();
        c.unary.get_mut(&key).unwrap().asked = 1;
        c.refresh_unary(&key, c.epoch, json!("new"));
        // Dropped since it was asked: not recorded anew.
        c.refresh_unary("dropped", c.epoch, json!("new"));
        assert_eq!(c.unary[&key].asked, 1);
        assert_eq!(c.unary(&key, false), Some(json!("new")));
        assert!(!c.unary.contains_key("dropped"));
    }

    #[test]
    fn config_folds_provider_events_into_snapshot() {
        let mut c = Cache::default();
        let snapshot =
            json!({"type": "snapshot", "config": {"providers": [provider("a", "authenticated", json!([1]))]}});
        c.record_stream_items("subscribeServerConfig", CONFIG, &[snapshot], true);
        let full = json!({"type": "providerStatuses", "payload": {"providers": [
            provider("a", "authenticated", json!([1])), provider("b", "authenticated", json!([2]))]}});
        // `a` signs out; its models are left out as unchanged.
        let delta = json!({"type": "providerStatusDeltas", "payload": {"providers": [
            {"instanceId": "a", "displayName": "a", "enabled": true, "auth": {"status": "unauthenticated"}},
            provider("b", "authenticated", json!([2]))]}});
        let other = |n: u32| json!({"type": "settingsUpdated", "payload": {"n": n}});
        c.record_stream_items("subscribeServerConfig", CONFIG, &[full, other(1), delta, other(2)], false);

        let items = c.stream(CONFIG).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1], other(2));
        let providers = &items[0]["config"]["providers"];
        assert_eq!(providers[0]["models"], json!([1]));
        assert_eq!(providers[1]["instanceId"], "b");
        assert_eq!(c.signed_out_providers(), vec!["a".to_owned()]);
    }

    #[test]
    fn refreshed_providers_fold_into_config() {
        let mut c = Cache::default();
        let snapshot =
            json!({"type": "snapshot", "config": {"providers": [provider("a", "unauthenticated", json!([]))]}});
        c.record_stream_items("subscribeServerConfig", CONFIG, &[snapshot], true);
        c.fold_providers(&Value::Null);
        assert_eq!(c.signed_out_providers(), vec!["a".to_owned()]);
        c.fold_providers(&json!([provider("a", "authenticated", json!([]))]));
        assert!(c.signed_out_providers().is_empty());
    }

    #[test]
    fn shell_cursor_rule() {
        let capture = Capture { sequence: 5, shell: json!("s"), ..Default::default() };
        assert!(matches!(capture.shell(Some(5)), Some(Shell::UpToDate)));
        assert!(capture.shell(Some(6)).is_none());
        assert!(matches!(capture.shell(Some(4)), Some(Shell::Snapshot(_))));
        assert!(matches!(capture.shell(None), Some(Shell::Snapshot(_))));
    }
}

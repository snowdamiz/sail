//! Chats kept on this computer, so they open while the machine sleeps. Each is the bounded
//! snapshot T3's server sends when a chat opens, in the encoding Sail asks for: one file per
//! chat, named by thread id, thread sequence and encoding. They are fetched as the machine
//! drains for sleep and stay good for as long as the chat does not change, so a sleep only
//! fetches the chats that changed since the last one. The files are all there is: no index.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Settled chats, and recordings nobody asked for, leave the cache after this long.
pub const STALE_AFTER: chrono::TimeDelta = chrono::TimeDelta::days(3);

/// How a client wants a bounded snapshot encoded: the query of the HTTP route, and the same
/// options as `accept*` flags on `orchestration.subscribeThread`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThreadFlags {
    pub defer_work: bool,
    pub compact_turn_items: bool,
    pub dedupe_bodies: bool,
    pub compact_ids: bool,
}

impl ThreadFlags {
    /// `None`: the client did not ask for a bounded snapshot; only the machine builds the other.
    pub fn from_payload(p: &Value) -> Option<Self> {
        let on = |k: &str| p[k].as_bool() == Some(true);
        on("acceptBoundedSnapshot").then(|| Self {
            defer_work: on("acceptDeferredWork"),
            compact_turn_items: on("acceptCompactTurnItems"),
            dedupe_bodies: on("acceptDedupedBodies"),
            compact_ids: on("acceptCompactIds"),
        })
    }
    pub fn from_query(q: &HashMap<String, String>) -> Self {
        let on = |k: &str| q.get(k).is_some_and(|v| v == "1");
        Self {
            defer_work: on("deferWork"),
            compact_turn_items: on("compactTurnItems"),
            dedupe_bodies: on("dedupeBodies"),
            compact_ids: on("compactIds"),
        }
    }
    fn bits(self) -> [u8; 4] {
        [self.defer_work, self.compact_turn_items, self.dedupe_bodies, self.compact_ids].map(u8::from)
    }
    pub fn key(self) -> String {
        self.bits().map(|b| b.to_string()).concat()
    }
    pub fn query(self) -> String {
        let [defer, turn_items, bodies, ids] = self.bits();
        format!("deferWork={defer}&compactTurnItems={turn_items}&dedupeBodies={bodies}&compactIds={ids}")
    }
}

fn dir(machine_dir: &Path) -> PathBuf {
    machine_dir.join("threads")
}

/// The file of `thread` as of thread sequence `sequence`, in the encoding `flags`. The id goes
/// in as hex, so none can name a path outside the store.
pub fn path(machine_dir: &Path, thread: &str, sequence: u64, flags: ThreadFlags) -> PathBuf {
    let id: String = thread.bytes().map(|b| format!("{b:02x}")).collect();
    dir(machine_dir).join(format!("{id}.{sequence}.{}.json", flags.key()))
}

/// A chat the store should hold, and the file that holds it.
pub struct Wanted<'a> {
    pub thread: &'a str,
    pub sequence: u64,
    pub path: PathBuf,
}

/// What the store should hold for the state the machine sleeps with, most recently used first:
/// every chat of `shell` that is not expired, as of its thread sequence in `sequences` (the
/// manifest's), in the encoding `flags`.
pub fn plan<'a>(
    machine_dir: &Path,
    shell: &'a Value,
    sequences: &HashMap<String, u64>,
    flags: ThreadFlags,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<Wanted<'a>> {
    let mut rows: Vec<&Value> =
        shell["threads"].as_array().into_iter().flatten().filter(|row| !expired(row, now)).collect();
    rows.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    rows.into_iter()
        .filter_map(|row| row["id"].as_str())
        .filter_map(|thread| {
            let sequence = *sequences.get(thread)?;
            Some(Wanted { thread, sequence, path: path(machine_dir, thread, sequence, flags) })
        })
        .collect()
}

/// Removes everything in the store but `keep`: chats that are gone or expired, earlier states
/// and encodings of the kept ones, and whatever an interrupted write left behind.
pub fn sweep(machine_dir: &Path, keep: &HashSet<PathBuf>) {
    crate::store::sweep(&dir(machine_dir), keep);
}

/// A shell row of a chat settled longer ago than `STALE_AFTER`. Subagents settle with their
/// parent, so they leave with it.
fn expired(row: &Value, now: chrono::DateTime<chrono::Utc>) -> bool {
    row["settledOverride"] == "settled"
        && row["settledAt"]
            .as_str()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| now.signed_duration_since(at) > STALE_AFTER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flags_agree_between_socket_and_http() {
        let payload = json!({"acceptBoundedSnapshot": true, "acceptDeferredWork": true, "acceptCompactIds": true});
        let flags = ThreadFlags::from_payload(&payload).unwrap();
        let query = url::form_urlencoded::parse(flags.query().as_bytes()).into_owned().collect();
        assert_eq!(ThreadFlags::from_query(&query), flags);
        assert_eq!(flags.key(), "1001");
        assert!(ThreadFlags::from_payload(&json!({"acceptDedupedBodies": true})).is_none());
    }

    #[test]
    fn only_long_settled_chats_expire() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-16T12:00:00Z").unwrap().to_utc();
        let row = |settled: Value, at: Value| json!({"settledOverride": settled, "settledAt": at});
        assert!(expired(&row(json!("settled"), json!("2026-11-13T11:59:00.000Z")), now));
        assert!(!expired(&row(json!("settled"), json!("2026-11-14T12:00:00.000Z")), now));
        assert!(!expired(&row(Value::Null, Value::Null), now));
        assert!(!expired(&row(json!("active"), json!("2026-11-01T00:00:00.000Z")), now));
    }

    #[test]
    fn thread_ids_stay_inside_the_store() {
        let root = Path::new("/m");
        let flags = ThreadFlags { dedupe_bodies: true, ..Default::default() };
        assert_eq!(path(root, "..", 7, flags), Path::new("/m/threads/2e2e.7.0010.json"));
        assert_eq!(path(root, "a/b", 12, ThreadFlags::default()), Path::new("/m/threads/612f62.12.0000.json"));
    }

    #[test]
    fn plan_holds_the_chats_of_the_shell_newest_first() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-16T12:00:00Z").unwrap().to_utc();
        let row = |id: &str, updated: &str, settled: Option<&str>| {
            json!({"id": id, "updatedAt": updated, "settledOverride": settled.map(|_| "settled"), "settledAt": settled})
        };
        let shell = json!({"threads": [
            row("old", "2026-11-10T00:00:00.000Z", None),
            row("new", "2026-11-16T00:00:00.000Z", None),
            row("expired", "2026-11-16T01:00:00.000Z", Some("2026-11-01T00:00:00.000Z")),
            row("settled", "2026-11-15T12:00:00.000Z", Some("2026-11-15T12:00:00.000Z")),
            row("not in the manifest", "2026-11-16T02:00:00.000Z", None),
        ]});
        let sequences = [("old", 3), ("new", 9), ("expired", 4), ("settled", 5)];
        let sequences = sequences.into_iter().map(|(id, sequence)| (id.to_owned(), sequence)).collect();
        let plan = plan(Path::new("/m"), &shell, &sequences, ThreadFlags::default(), now);
        let chats: Vec<(&str, u64)> = plan.iter().map(|w| (w.thread, w.sequence)).collect();
        assert_eq!(chats, vec![("new", 9), ("settled", 5), ("old", 3)]);
        assert_eq!(plan[0].path, Path::new("/m/threads/6e6577.9.0000.json"));
    }

    #[test]
    fn sweep_leaves_only_what_is_kept() {
        let root = std::env::temp_dir().join(format!("sail-boat-{:016x}", rand::random::<u64>()));
        let flags = ThreadFlags::default();
        let kept = path(&root, "a", 2, flags);
        let stale = [
            path(&root, "a", 1, flags),
            path(&root, "a", 2, ThreadFlags { compact_ids: true, ..flags }),
            path(&root, "gone", 2, flags),
            kept.with_extension("tmp"),
        ];
        std::fs::create_dir_all(dir(&root).join("stray")).unwrap();
        for file in stale.iter().chain([&kept, &dir(&root).join("stray/file")]) {
            std::fs::write(file, "{}").unwrap();
        }
        sweep(&root, &HashSet::from([kept.clone()]));
        let left: Vec<PathBuf> = std::fs::read_dir(dir(&root)).unwrap().map(|e| e.unwrap().path()).collect();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(left, vec![kept]);
    }
}

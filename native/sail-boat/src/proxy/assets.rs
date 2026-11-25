//! Chat images kept on this computer, so they show while the machine sleeps. Sail asks the
//! server for a signed URL per image (`assets.createUrl`) and loads that URL over HTTP. The
//! answer is recorded like any other; the bytes are kept as they pass through the proxy, one
//! file per URL: the headers that describe the body on the first line, then the body. A file
//! stays for as long as the recorded answer that points to it. The files are all there is: no
//! index.

use super::cache::Cache;
use axum::body::Body;
use axum::http::HeaderMap;
use axum::response::Response;
use bytes::Bytes;
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::sync::mpsc;

/// T3's asset route: `/api/assets/<signed token>/<name>`.
pub const ROUTE: &str = "/api/assets/";

/// Sail takes images up to 10 MB. What is larger is a video, and stays with the machine.
const MAX_BYTES: usize = 16 * 1024 * 1024;

/// What says how to read the body, and what keeps a stored page or SVG as confined as the
/// machine served it.
const KEPT_HEADERS: [&str; 5] =
    ["content-type", "content-encoding", "content-disposition", "content-security-policy", "x-content-type-options"];

/// One write or sweep at a time: `write_private` names its temporary file after the file, so
/// two answers to one URL would write into each other's, and a sweep would take it from under
/// a write. Not for `carry`: a link has no temporary file, and its caller holds the cache
/// lock, as the sweep's does.
static WRITING: Mutex<()> = Mutex::new(());

fn dir(machine_dir: &Path) -> PathBuf {
    machine_dir.join("assets")
}

/// The file of the asset at `url_path`, named by the path's hash: the signed token in it is
/// longer than a file name may be.
pub fn path(machine_dir: &Path, url_path: &str) -> PathBuf {
    dir(machine_dir).join(format!("{:x}", Sha256::digest(url_path)))
}

/// The file of the asset an `assets.createUrl` answer points to: its `relativeUrl` is the path
/// Sail loads.
pub fn answer_path(machine_dir: &Path, answer: &Value) -> Option<PathBuf> {
    Some(path(machine_dir, answer["relativeUrl"].as_str()?))
}

/// The files the recorded answers point to: all the store holds. What else a page loads under
/// its token is deliberately not kept: nothing bounds how many paths one token answers.
pub fn recorded(machine_dir: &Path, cache: &Cache) -> HashSet<PathBuf> {
    cache.answers("assets.createUrl").filter_map(|answer| answer_path(machine_dir, answer)).collect()
}

/// Removes every asset no recorded answer points to any more.
pub fn sweep(machine_dir: &Path, cache: &Cache) {
    let _writing = WRITING.lock().unwrap();
    crate::store::sweep(&dir(machine_dir), &recorded(machine_dir, cache));
}

/// A new answer for an image Sail already shows. It keeps loading the earlier URL while
/// the file is unchanged, so the new URL gets the earlier file too; a changed file is loaded
/// from the new URL and replaces it.
pub fn carry(machine_dir: &Path, earlier: &Value, answer: &Value) {
    if let (Some(from), Some(to)) = (answer_path(machine_dir, earlier), answer_path(machine_dir, answer)) {
        let _ = std::fs::hard_link(from, to);
    }
}

fn head(headers: &HeaderMap) -> Vec<u8> {
    let kept: Vec<(&str, &str)> =
        KEPT_HEADERS.iter().filter_map(|&name| Some((name, headers.get(name)?.to_str().ok()?))).collect();
    let mut head = json!(kept).to_string().into_bytes();
    head.push(b'\n');
    head
}

/// Passes the machine's answer on as it arrives and stores it at `file` once it arrived whole,
/// unless it is larger than `MAX_BYTES`. A task of its own reads it: the HTTP server drops a
/// body as soon as its `content-length` is met, before the body is seen to end.
pub fn keep(file: PathBuf, answer: Response) -> Response {
    let (parts, body) = answer.into_parts();
    let mut kept = Some(head(&parts.headers));
    let (tx, mut rx) = mpsc::channel(1);
    tokio::spawn(async move {
        let mut body = body.into_data_stream();
        while let Some(chunk) = body.next().await {
            kept = match &chunk {
                Ok(bytes) => kept.filter(|k| k.len() + bytes.len() <= MAX_BYTES).map(|mut k| {
                    k.extend_from_slice(bytes);
                    k
                }),
                Err(_) => None,
            };
            if tx.send(chunk).await.is_err() {
                // Sail stopped loading it.
                return;
            }
        }
        let Some(stored) = kept else { return };
        let _writing = WRITING.lock().unwrap();
        if let Err(e) = crate::store::write_private(&file, &stored) {
            tracing::warn!("storing an asset: {e:#}");
        }
    });
    Response::from_parts(parts, Body::from_stream(stream::poll_fn(move |cx| rx.poll_recv(cx))))
}

/// The stored asset, as the machine answered it. `None`: not stored.
pub fn read(file: &Path) -> Option<Response> {
    let stored = Bytes::from(std::fs::read(file).ok()?);
    let head = stored.iter().position(|&b| b == b'\n')?;
    let headers: Vec<(String, String)> = serde_json::from_slice(&stored[..head]).ok()?;
    let mut answer = Response::builder();
    for (name, value) in headers {
        answer = answer.header(name, value);
    }
    answer.body(Body::from(stored.slice(head + 1..))).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::cache::request_key;
    use axum::body::to_bytes;
    use axum::http::header::{CONTENT_ENCODING, CONTENT_TYPE};
    use std::time::Duration;

    fn machine_dir() -> PathBuf {
        std::env::temp_dir().join(format!("sail-boat-{:016x}", rand::random::<u64>()))
    }

    fn answer(chunks: Vec<std::io::Result<Bytes>>) -> Response {
        Response::builder()
            .header(CONTENT_TYPE, "image/svg+xml")
            .header(CONTENT_ENCODING, "gzip")
            .header("content-security-policy", "sandbox")
            .header("etag", "\"1\"")
            .body(Body::from_stream(stream::iter(chunks)))
            .unwrap()
    }

    #[test]
    fn a_file_is_named_by_the_hash_of_its_url_path() {
        // SHA-256 of "abc": the name must not change between releases.
        let name = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(path(Path::new("/m"), "abc"), Path::new("/m/assets").join(name));
        let url = "/api/assets/eyJ2IjoxfQ.c2ln/a%2Fb.png";
        assert_eq!(path(Path::new("/m"), url).parent(), Some(Path::new("/m/assets")));
        assert_eq!(answer_path(Path::new("/m"), &json!({"relativeUrl": url})), Some(path(Path::new("/m"), url)));
        assert_eq!(answer_path(Path::new("/m"), &json!({"expiresAt": 1})), None);
    }

    #[tokio::test]
    async fn a_kept_answer_reads_back_with_the_headers_that_describe_it() {
        let root = machine_dir();
        let file = path(&root, "/api/assets/t/a.svg");
        let passed = keep(file.clone(), answer(vec![Ok("ab".into()), Ok("cd".into())]));
        assert_eq!(passed.headers()["etag"], "\"1\"");
        assert_eq!(to_bytes(passed.into_body(), usize::MAX).await.unwrap(), "abcd");
        let stored = read(&file);
        std::fs::remove_dir_all(&root).unwrap();
        let stored = stored.unwrap();
        let headers: Vec<_> = stored.headers().iter().map(|(k, v)| (k.as_str(), v.to_str().unwrap())).collect();
        assert_eq!(
            headers,
            vec![
                ("content-type", "image/svg+xml"),
                ("content-encoding", "gzip"),
                ("content-security-policy", "sandbox")
            ]
        );
        assert_eq!(to_bytes(stored.into_body(), usize::MAX).await.unwrap(), "abcd");
    }

    #[tokio::test]
    async fn only_whole_answers_within_the_limit_are_kept() {
        let root = machine_dir();
        let cut = path(&root, "cut");
        let passed = keep(cut.clone(), answer(vec![Ok("ab".into()), Err(std::io::Error::other("cut"))]));
        assert!(to_bytes(passed.into_body(), usize::MAX).await.is_err());
        let large = path(&root, "large");
        let passed = keep(large.clone(), answer(vec![Ok(vec![0; MAX_BYTES].into()), Ok("a".into())]));
        assert_eq!(to_bytes(passed.into_body(), usize::MAX).await.unwrap().len(), MAX_BYTES + 1);
        let stored = [read(&cut), read(&large)];
        let _ = std::fs::remove_dir_all(&root);
        assert!(stored.iter().all(Option::is_none));
    }

    #[tokio::test]
    async fn a_new_url_for_a_stored_image_gets_its_file() {
        let root = machine_dir();
        let answer_at = |token: &str| json!({"relativeUrl": format!("/api/assets/{token}/a.svg")});
        let (earlier, new) = (answer_at("t1"), answer_at("t2"));
        let file = answer_path(&root, &earlier).unwrap();
        let mut passed = keep(file.clone(), answer(vec![Ok("abcd".into())])).into_body().into_data_stream();
        // As the HTTP server does once `content-length` is met: dropped before it is seen to end.
        assert_eq!(passed.next().await.unwrap().unwrap(), "abcd");
        drop(passed);
        let stored = async {
            while read(&file).is_none() {
                tokio::task::yield_now().await;
            }
        };
        tokio::time::timeout(Duration::from_secs(1), stored).await.unwrap();
        carry(&root, &earlier, &new);
        carry(&root, &answer_at("never-loaded"), &answer_at("t3"));
        let stored = [read(&answer_path(&root, &new).unwrap()), read(&answer_path(&root, &answer_at("t3")).unwrap())];
        std::fs::remove_dir_all(&root).unwrap();
        let [carried, missing] = stored;
        assert_eq!(to_bytes(carried.unwrap().into_body(), usize::MAX).await.unwrap(), "abcd");
        assert!(missing.is_none());
    }

    #[test]
    fn the_store_holds_what_recorded_answers_point_to() {
        let root = Path::new("/m");
        let url = |n: u8| format!("/api/assets/token{n}/a.png");
        let answer = |n: u8| json!({"relativeUrl": url(n), "expiresAt": 1});
        let key = |tag: &str, n: u8| request_key(tag, &json!({"resource": n}));
        let mut c = Cache::default();
        c.record_unary(&key("assets.createUrl", 1), 0, &answer(1));
        c.record_unary(&key("assets.createUrl", 2), 0, &answer(2));
        c.record_unary(&key("projects.readFile", 3), 0, &answer(3));
        assert_eq!(recorded(root, &c), HashSet::from([path(root, &url(1)), path(root, &url(2))]));
        // A new URL for the same image leaves the earlier one's file without a recording.
        c.record_unary(&key("assets.createUrl", 1), 0, &answer(4));
        assert_eq!(recorded(root, &c), HashSet::from([path(root, &url(4)), path(root, &url(2))]));
    }
}

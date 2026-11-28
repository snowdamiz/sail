#!/bin/bash
set -euo pipefail

if (( $# < 5 || $# > 6 )); then
  printf 'Usage: %s INPUTS OUT IMAGE WARMUPS MEASURED [--candidate]\n' "$0" >&2
  exit 2
fi
inputs=$1
out=$2
image=$3
warmups=$4
measured=$5
candidate=${6:-}
fixture=$(cd "$(dirname "$0")/.." && pwd)
[[ $inputs = /* && $out = /* ]]
test -z "$candidate" || test "$candidate" = --candidate
umask 077
mkdir "$out"
mkdir "$out/runs" "$out/sources"
python3 - "$fixture/release-inventory.json" "$inputs" "$out/sources" "$warmups" "$measured" "$candidate" <<'PY'
import json
from pathlib import Path
import sys

inventory = json.loads(Path(sys.argv[1]).read_text())
inputs = Path(sys.argv[2])
out = Path(sys.argv[3])
warmups, measured = (int(arg) for arg in sys.argv[4:6])
assert 0 <= warmups <= 10 and 1 <= measured <= 100
asset = next(
    item for item in inventory["githubRelease"]["assets"]
    if item["name"] == "t3-0.1.17-linux-arm64.tar.gz"
)
published = {
    "version": "0.1.17",
    "sourceSha": inventory["incumbentSourceSha"],
    "archiveSha256": asset["digest"].removeprefix("sha256:"),
    "databaseMigration": 118,
    "captureRounds": warmups + measured,
}
(out / "published.json").write_text(json.dumps(published))
if sys.argv[6]:
    head = json.loads((inputs / "head-source.json").read_text())
    assert head["sourceSha"] != published["sourceSha"]
    head["captureRounds"] = warmups + measured
    (out / "head.json").write_text(json.dumps(head))
PY

containers=()
cleanup() {
  for container in "${containers[@]}"; do
    docker logs "$container" > "$out/$container.private.log" 2>&1 || true
    docker stop --timeout 15 "$container" >/dev/null 2>&1 || true
    docker rm "$container" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

start() {
  local label=$1 edition=$2 container
  container=$(docker run -d --init --network none --platform linux/arm64 \
    --user "$(id -u):$(id -g)" -v "$fixture:/fixture:ro" -v "$out/runs:/runs" \
    -v "$inputs/seed.sqlite:/seed.sqlite:ro" -v "$inputs/thread-id:/thread-id:ro" \
    -v "$inputs/replay.tar:/replay-source.tar:ro" -v "$inputs/chrome.zip:/chrome.zip:ro" \
    -v "$inputs/$edition.tar.gz:/release.tar.gz:ro" \
    -v "$out/sources/$edition.json:/capture-source.json:ro" \
    "$image" bash /fixture/linux-chromium/capture.sh "/runs/$label")
  containers+=("$container")
}

start a published
start b published
if test -n "$candidate"; then
  start head head
fi
cargo run --locked --manifest-path "$fixture/../coverage-check/Cargo.toml" --bin capture-timings -- \
  "$out/runs" "$warmups" "$measured" ${candidate:+"$candidate"} > "$out/timings.json"
for container in "${containers[@]}"; do
  test "$(docker wait "$container")" = 0
done

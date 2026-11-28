#!/bin/bash
set -euo pipefail

if [[ $# != 5 && ( $# != 7 || $6 != --candidate ) ]]; then
  printf 'Usage: %s INPUTS OUT IMAGE WARMUPS MEASURED [--candidate EARLIER_TIMINGS]\n' "$0" >&2
  exit 2
fi
inputs=$1
out=$2
image=$3
warmups=$4
measured=$5
candidate=${6:-}
earlier=${7:-}
fixture=$(cd "$(dirname "$0")/.." && pwd)
[[ $inputs = /* && $out = /* ]]
[[ -z $candidate || ( -f $earlier && $earlier = /* ) ]]
umask 077
mkdir "$out"
mkdir "$out/runs" "$out/sources"
python3 -I - "$fixture/release-inventory.json" "$inputs" "$out/sources" "$warmups" "$measured" "$candidate" <<'PY'
import json
from hashlib import file_digest
from pathlib import Path
import subprocess
import sys
import tarfile

inventory = json.loads(Path(sys.argv[1]).read_text())
inputs = Path(sys.argv[2])
out = Path(sys.argv[3])
warmups, measured = (int(arg) for arg in sys.argv[4:6])
assert 0 <= warmups <= 10 and 1 <= measured <= 100
asset = next(
    item for item in inventory["githubRelease"]["assets"]
    if item["name"] == "t3-0.1.17-linux-arm64.tar.gz"
)

def runtime_sha(archive, version):
    with tarfile.open(archive, "r:gz") as package:
        member = package.getmember(f"t3-{version}-linux-arm64/t3")
        assert member.isfile(), "package t3 must be a regular file"
        with package.extractfile(member) as runtime:
            return file_digest(runtime, "sha256").hexdigest()


published = {
    "version": "0.1.17",
    "sourceSha": inventory["incumbentSourceSha"],
    "archiveSha256": asset["digest"].removeprefix("sha256:"),
    "databaseMigration": 118,
    "captureRounds": warmups + measured,
}
with (inputs / "published.tar.gz").open("rb") as archive:
    assert file_digest(archive, "sha256").hexdigest() == published["archiveSha256"], "published archive digest mismatch"
published["runtimeSha256"] = runtime_sha(inputs / "published.tar.gz", published["version"])
(out / "published.json").write_text(json.dumps(published))
if sys.argv[6]:
    head = json.loads((inputs / "head-source.json").read_text())
    assert head["sourceSha"] != published["sourceSha"], "candidate source matches published source"
    assert head["archiveSha256"] != published["archiveSha256"], "candidate archive matches published archive"
    with (inputs / "head.tar.gz").open("rb") as archive:
        assert file_digest(archive, "sha256").hexdigest() == head["archiveSha256"], "candidate archive digest mismatch"
    candidate_runtime = runtime_sha(inputs / "head.tar.gz", head["version"])
    assert candidate_runtime != published["runtimeSha256"], "candidate runtime matches published runtime"
    assert candidate_runtime == head["runtimeSha256"], "candidate runtime digest mismatch"
    with (inputs / "head-source.tar").open("rb") as source:
        assert file_digest(source, "sha256").hexdigest() == head["sourceTarSha256"], "candidate source archive digest mismatch"
        source.seek(0)
        commit = subprocess.check_output(["git", "get-tar-commit-id"], stdin=source, text=True).strip()
        assert commit == head["sourceSha"], "candidate source archive commit mismatch"
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
  "$out/runs" "$warmups" "$measured" ${candidate:+"$candidate" "$earlier"} > "$out/timings.json"
for container in "${containers[@]}"; do
  test "$(docker wait "$container")" = 0
done

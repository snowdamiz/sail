#!/bin/bash
set -euo pipefail

root=$1
fixture=/fixture
umask 077
mkdir "$root"
mkdir -p "$root"/{runtime,home,state/userdata,project,replay}
edition=0.1.17
archive_sha=207e0ad49666c4f1f71ddbeae944bc7f6db304350055e0a49ed40f27bfdc42df
if test -f /capture-source.json; then
  read -r edition archive_sha runtime_sha < <(python3 -I - <<'PY'
import json
from pathlib import Path
import re

source = json.loads(Path("/capture-source.json").read_text())
assert re.fullmatch(r"\d+\.\d+\.\d+", source["version"])
assert re.fullmatch(r"[0-9a-f]{64}", source["archiveSha256"])
assert re.fullmatch(r"[0-9a-f]{64}", source["runtimeSha256"])
print(source["version"], source["archiveSha256"], source["runtimeSha256"])
PY
  )
fi
printf '%s  %s\n' \
  "$archive_sha" /release.tar.gz \
  9f89b7ef6574e4bbf6ddda9f17f1fab5626e93d6f7d852653232d0d3554df975 /chrome.zip \
  | sha256sum -c -
test "$(uname -m)" = aarch64
tar -xzf /release.tar.gz --strip-components=1 -C "$root/runtime"
if test -f /capture-source.json; then
  printf '%s  %s\n' "$runtime_sha" "$root/runtime/t3" | sha256sum -c -
fi
tar -xf /replay-source.tar -C "$root/replay"
git init --quiet --initial-branch=main "$root/project"

configured="$root/state/tools/chrome-headless-shell/linux-arm64"
mkdir -p "$configured"
unzip -q /chrome.zip -d "$configured"
mv "$configured/chrome-headless-shell-linux-arm64" "$configured/158.0.8127.88"
chrome="$configured/158.0.8127.88/chrome-headless-shell"
test "$("$chrome" --version)" = "Google Chrome for Testing 158.0.8127.88"

python3 - "$root" <<'PY'
import json
from pathlib import Path
import sqlite3
import sys

root = Path(sys.argv[1])
with sqlite3.connect("file:/seed.sqlite?immutable=1", uri=True) as source:
    with sqlite3.connect(root / "state/userdata/statev2.sqlite") as target:
        source.backup(target)
settings = {"providerInstances": {
    "devReplay": {
        "displayName": "Replay (dev)",
        "driver": "acpRegistry",
        "config": {
            "source": "local",
            "commandPath": "/usr/local/bin/node",
            "commandArgs": [str(root / "replay/apps/server/scripts/dev-replay-agent.ts")],
        },
    },
    "captureProbe": {
        "displayName": "Capture fixture",
        "driver": "acpRegistry",
        "config": {
            "source": "local",
            "commandPath": "/usr/bin/python3",
            "commandArgs": ["/fixture/linux-chromium/provider.py", str(root)],
        },
    },
}}
(root / "state/userdata/settings.json").write_text(json.dumps(settings))
PY

export HOME="$root/home"
export SAIL_HOME="$root/state"
export T3CODE_HOME="$root/state"
export T3CODE_TELEMETRY_ENABLED=false
export T3CODE_SERVER_BROWSER_SANDBOX=0
cli="$root/runtime/t3"
test "$("$cli" --version)" = "t3 v$edition"
"$cli" serve --base-dir "$root/state" --host 127.0.0.1 --port 47717 --startup-pairing off \
  > "$root/server.private.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do
  if curl -fsS http://127.0.0.1:47717/.well-known/t3/environment > "$root/descriptor.private.json" 2>/dev/null; then
    break
  fi
  kill -0 "$server_pid"
  sleep 0.3
done
test -s "$root/descriptor.private.json"
"$cli" project add --base-dir "$root/state" --title 'Capture fixture' "$root/project" > "$root/cli.private.log"
"$cli" thread start --base-dir "$root/state" --provider captureProbe --model default \
  --title 'Capture fixture' --wait --json "$root/project" 'Capture the saved Replay thread' \
  > "$root/capture-run.private.json"
test -s "$root/receipt.json"
test -s "$root/state.json"
test -s "$root/capture.png"

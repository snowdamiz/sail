#!/usr/bin/env bash
# Runs on a Boat sandbox as `user`. Only fresh sandboxes take a version and installer URL.
# A version of `-` refreshes an existing watchdog using its existing token.
#   SAIL_BOAT_SECRET=<watchdog-secret> [SAIL_CLI_INSTALL_URL=<url>] provision.sh <t3-version|-> <sleep-after-secs> <snapshot-name> <name> <sandbox-id>
# Expects watchdog.mjs next to it. Fresh installs print the environment ID and upstream token.
set -euo pipefail

version="$1" sleep_after="$2" snapshot="$3" name="$4" sandbox="$5"
secret="$SAIL_BOAT_SECRET"
install_url="${SAIL_CLI_INSTALL_URL:-}"
here="$(cd "$(dirname "$0")" && pwd)"
t3_home="$HOME/.t3"
export SAIL_HOME="$t3_home" T3CODE_HOME="$t3_home" T3CODE_INSTALL_BIN_DIR="$HOME/.local/bin"
t3="$T3CODE_INSTALL_BIN_DIR/t3"
boat_dir="$HOME/.sail-boat"
units="$HOME/.config/systemd/user"
mkdir -p "$boat_dir" "$units"
chmod 700 "$boat_dir"

sail_installed() {
  [ "$(cat "$t3_home/runtime/versions/$version/.sail-product" 2>/dev/null)" = sail ] &&
    [ "$("$t3" --version 2>/dev/null)" = "t3 v$version" ]
}
install_sail() {
  local installer="$here/install.sh"
  curl -fsSL --max-time 60 -o "$installer" "$install_url" || return
  T3CODE_VERSION="$version" timeout -k 5s 480s sh "$installer" || {
    local status=$?
    echo "Sail installer exited with status $status" >&2
    return "$status"
  }
  if ! sail_installed; then
    echo "Expected Sail server v$version after install" >&2
    return 1
  fi
}
config="$boat_dir/config.json"
lifecycle="$here/boat-lifecycle.mjs"
boot=""
enrolled=false
if [ -r /proc/sys/kernel/random/boot_id ]; then
  boot="$(node "$lifecycle" boot)"
fi
if [ "$version" != - ]; then
  if ! sail_installed; then
    install_log="$boat_dir/install.log"
    if ! install_sail >"$install_log" 2>&1; then
      echo "Sail server install failed" >&2
      tail -n 40 "$install_log" >&2
      exit 1
    fi
  fi
  mkdir -p "$t3_home/userdata"
  if [ -n "$boot" ] && [ ! -e "$t3_home/runtime/service-state.json" ]; then
    node --no-warnings - "$t3_home" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const home = process.argv[2];
const database = new DatabaseSync(home + "/userdata/statev2.sqlite");
database.close();
for (const file of ["/userdata/environment-id", "/runtime/boat-installation-id"]) {
  try {
    fs.writeFileSync(home + file, crypto.randomUUID() + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
NODE
    sync -f "$t3_home"
  fi
  node -e '
    const fs = require("fs"), f = process.argv[1];
    const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    s.linkedEnvironmentsEnabled = true;
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
  ' "$t3_home/userdata/settings.json"

  # The service reads its display name at startup.
  machine_info="PRETTY_HOSTNAME=$name"
  if [ "$(cat /etc/machine-info 2>/dev/null || true)" != "$machine_info" ]; then
    echo "$machine_info" | sudo tee /etc/machine-info >/dev/null
  fi
  "$t3" service install --base-dir "$t3_home" --allow-downgrade >/dev/null

  descriptor=""
  for _ in $(seq 1 120); do
    if descriptor="$(curl -sf http://127.0.0.1:3773/.well-known/t3/environment)"; then break; fi
    sleep 0.5
  done
  if [ -z "$descriptor" ]; then
    echo "T3 server did not start" >&2
    tail -n 40 "$t3_home/userdata/logs/boot-service.log" >&2 || true
    exit 1
  fi
  environment_id="$(node -e '
    const id = JSON.parse(process.argv[1]).environmentId;
    if (typeof id !== "string" || !id) throw new Error("T3 server did not report an environment ID");
    process.stdout.write(id);
  ' "$descriptor")"
  watchdog_token="$("$t3" auth session issue --token-only --ttl 3650d --label sail-watchdog --scope orchestration:read)"
  upstream_token="$("$t3" auth session issue --token-only --ttl 3650d --label sail-boat)"
else
  if [ -n "$boot" ]; then
    node "$lifecycle" restore "$sandbox"
  fi
  watchdog_token="$(node -e 'try{process.stdout.write(require(process.argv[1]).t3Token||"")}catch{}' "$config")"
  if [ -z "$watchdog_token" ]; then
    echo "Watchdog refresh requires its existing read-only token" >&2
    exit 1
  fi
fi

if [ -f "$t3_home/runtime/boat-installation-id" ]; then
  enrolled=true
  exec 9>>"$t3_home/runtime/boat-lifecycle.lock"
  flock -w 5 9
  [ ! -e "$t3_home/runtime/boat-power-operation" ] || exit 75
fi

# The watchdog names its sandbox by id because BOAT_ID is absent from its environment.
SECRET="$secret" TOKEN="$watchdog_token" SLEEP="$sleep_after" SNAPSHOT="$snapshot" SANDBOX="$sandbox" BOOT="$boot" node -e '
  const e = process.env;
  const fs = require("fs");
  const path = process.argv[1];
  const temporary = path + "." + process.pid;
  fs.writeFileSync(temporary, JSON.stringify({
    secret: e.SECRET, t3Token: e.TOKEN, sleepAfterSecs: Number(e.SLEEP), snapshot: e.SNAPSHOT, sandbox: e.SANDBOX, bootId: e.BOOT
  }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, path);
' "$config"
install -m 600 "$lifecycle" "$boat_dir/boat-lifecycle.mjs"
install -m 600 "$here/watchdog.mjs" "$boat_dir/watchdog.mjs"
# Stop legacy t3boat watchdog unit if migrating an existing sandbox.
systemctl --user disable --now t3boat-watchdog.service >/dev/null 2>&1 || true
cat >"$units/sail-watchdog.service" <<'UNIT'
[Unit]
Description=sail watchdog: stops this sandbox when idle
After=t3code.service

[Service]
ExecStart=/bin/bash -lc 'exec node --no-warnings %h/.sail-boat/watchdog.mjs'
Restart=always
RestartSec=5
StandardOutput=append:%h/.sail-boat/watchdog.log
StandardError=append:%h/.sail-boat/watchdog.log

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable sail-watchdog.service >/dev/null 2>&1
systemctl --user restart sail-watchdog.service

if [ "$version" != - ]; then
  ENV_ID="$environment_id" TOK="$upstream_token" ENROLLED="$enrolled" node -e '
    console.log(JSON.stringify({ environmentId: process.env.ENV_ID, upstreamToken: process.env.TOK, lifecycleEnrolled: process.env.ENROLLED === "true" }));
  '
fi

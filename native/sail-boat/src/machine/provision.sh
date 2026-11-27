#!/usr/bin/env bash
# Runs on a Boat sandbox, as `user`. Idempotent; also used to upgrade a machine. A version of `-`
# upgrades a running machine live: T3 is left as it runs, neither installed nor restarted.
#   SAIL_BOAT_SECRET=<watchdog-secret> [SAIL_CLI_INSTALL_URL=<url>] provision.sh <t3-version|-> <sleep-after-secs> <snapshot-name> <mint-upstream-token:0|1> <name> <sandbox-id> [<check-idle:0|1>]
# Versioned runs need the installer URL. Expects watchdog.mjs next to it. Prints one JSON line: {"environmentId", "upstreamToken"?}.
set -euo pipefail

version="$1" sleep_after="$2" snapshot="$3" mint_upstream="$4" name="$5" sandbox="$6"
check_idle="${7:-0}"
secret="$SAIL_BOAT_SECRET"
install_url="${SAIL_CLI_INSTALL_URL:-}"
here="$(cd "$(dirname "$0")" && pwd)"
t3_home="$HOME/.t3"
export SAIL_HOME="$t3_home" T3CODE_HOME="$t3_home" T3CODE_INSTALL_BIN_DIR="$HOME/.local/bin"
t3="$T3CODE_INSTALL_BIN_DIR/t3"
boat_dir="$HOME/.sail-boat"
units="$HOME/.config/systemd/user"
mkdir -p "$boat_dir" "$units" "$t3_home/userdata"
chmod 700 "$boat_dir"

# Versioned provisioning activates the pinned runtime. A watchdog-only refresh keeps T3 running.
live=0
[ "$version" != - ] || live=1
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
check_server_idle() {
  if [ "$check_idle" = 1 ]; then
    node --no-warnings "$here/watchdog.mjs" --check-idle
  fi
}
check_server_idle
if [ "$live" = 0 ] && ! sail_installed; then
  install_log="$boat_dir/install.log"
  if ! install_sail >"$install_log" 2>&1; then
    echo "Sail server install failed" >&2
    tail -n 40 "$install_log" >&2
    exit 1
  fi
fi
settings="$t3_home/userdata/settings.json"
node -e '
  const fs = require("fs"), f = process.argv[1];
  const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  s.linkedEnvironmentsEnabled = true;
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
' "$settings"
# The machine's name, as other devices show it (T3 Connect, linked environments). T3 reads it
# from here as it starts; without it, they show the sandbox's hostname.
machine_info="PRETTY_HOSTNAME=$name"
if [ "$(cat /etc/machine-info 2>/dev/null || true)" != "$machine_info" ]; then
  echo "$machine_info" | sudo tee /etc/machine-info >/dev/null
fi
if [ "$live" = 0 ]; then
  check_server_idle
  "$t3" service install --base-dir "$t3_home" --allow-downgrade >/dev/null
  systemctl --user daemon-reload
  systemctl --user restart t3code.service
fi

ready=0
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null http://127.0.0.1:3773/.well-known/t3/environment; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  echo "T3 server did not start" >&2
  tail -n 40 "$t3_home/userdata/logs/boot-service.log" >&2 || true
  exit 1
fi

# Watchdog: its own read-only T3 token, kept across upgrades. It names its sandbox by id: no
# BOAT_ID in its env, so `boat stop self` can't resolve.
config="$boat_dir/config.json"
watchdog_token="$(node -e 'try{process.stdout.write(require(process.argv[1]).t3Token||"")}catch{}' "$config")"
if [ -z "$watchdog_token" ]; then
  watchdog_token="$("$t3" auth session issue --token-only --ttl 3650d --label sail-watchdog --scope orchestration:read)"
fi
SECRET="$secret" TOKEN="$watchdog_token" SLEEP="$sleep_after" SNAPSHOT="$snapshot" SANDBOX="$sandbox" node -e '
  const e = process.env;
  require("fs").writeFileSync(process.argv[1], JSON.stringify({
    secret: e.SECRET, t3Token: e.TOKEN, sleepAfterSecs: Number(e.SLEEP), snapshot: e.SNAPSHOT, sandbox: e.SANDBOX
  }, null, 2), { mode: 0o600 });
' "$config"
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

upstream_token=""
if [ "$mint_upstream" = 1 ]; then
  upstream_token="$("$t3" auth session issue --token-only --ttl 3650d --label sail-boat)"
fi
environment_id="$(curl -sf http://127.0.0.1:3773/.well-known/t3/environment | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).environmentId))')"
ENV_ID="$environment_id" TOK="$upstream_token" node -e '
  const o = { environmentId: process.env.ENV_ID };
  if (process.env.TOK) o.upstreamToken = process.env.TOK;
  console.log(JSON.stringify(o));
'

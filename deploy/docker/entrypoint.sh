#!/bin/sh
set -eu

# Claim only the mount itself; all paths inside it must be resolved as sail.
if [ "$(/usr/bin/id -u)" = 0 ]; then
  /usr/bin/chown --no-dereference sail:sail /data
  exec /usr/local/bin/as-sail /usr/local/bin/sail-entrypoint "$@"
fi
/usr/bin/mkdir -p -- /data/home "$SAIL_HOME"

if [ -z "${SAIL_PUBLIC_URL:-}${T3CODE_PUBLIC_URL:-}" ]; then
  if [ -n "${FLY_APP_NAME:-}" ]; then
    SAIL_PUBLIC_URL="https://${FLY_APP_NAME}.fly.dev"
  else
    SAIL_PUBLIC_URL="http://localhost:8080"
  fi
  export SAIL_PUBLIC_URL
fi

cd /data/home
exec /usr/local/bin/t3 serve --host 0.0.0.0 --port 8080 "$@"

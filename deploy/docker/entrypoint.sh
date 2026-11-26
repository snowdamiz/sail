#!/bin/sh
set -eu

# A fresh Fly volume mounts as an empty root-owned /data. Root names commands by path, because
# sail can write to directories on PATH.
if [ "$(/usr/bin/id -u)" = 0 ]; then
  /usr/bin/install -d -o sail -g sail "$HOME" "$SAIL_HOME"
else
  /usr/bin/mkdir -p "$HOME" "$SAIL_HOME"
fi

if [ -z "${SAIL_PUBLIC_URL:-}${T3CODE_PUBLIC_URL:-}" ]; then
  if [ -n "${FLY_APP_NAME:-}" ]; then
    SAIL_PUBLIC_URL="https://${FLY_APP_NAME}.fly.dev"
  else
    SAIL_PUBLIC_URL="http://localhost:8080"
  fi
  export SAIL_PUBLIC_URL
fi

cd "$HOME"
exec /usr/local/bin/t3 serve --host 0.0.0.0 --port 8080 "$@"

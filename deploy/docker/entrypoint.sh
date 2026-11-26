#!/bin/sh
set -eu

# A fresh Fly volume mounts as an empty root-owned /data.
if [ "$(id -u)" = 0 ]; then
  install -d -o sail -g sail /data/home /data/sail
else
  mkdir -p /data/home /data/sail
fi

if [ -z "${SAIL_PUBLIC_URL:-}" ]; then
  if [ -n "${FLY_APP_NAME:-}" ]; then
    SAIL_PUBLIC_URL="https://${FLY_APP_NAME}.fly.dev"
  else
    SAIL_PUBLIC_URL="http://localhost:8080"
  fi
  export SAIL_PUBLIC_URL
fi

cd "$HOME"
exec t3 serve --host 0.0.0.0 --port 8080 "$@"

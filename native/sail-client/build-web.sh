#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
target_dir="${CARGO_TARGET_DIR:-"$PWD/target"}"
out_dir="${1:-"$target_dir/preview"}"
bindgen="${WASM_BINDGEN:-wasm-bindgen}"
locked_version="$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/"/, "", $3); print $3; exit }' Cargo.lock)"
if [[ "$("$bindgen" --version)" != "wasm-bindgen $locked_version" ]]; then
  echo "Install wasm-bindgen-cli $locked_version or point WASM_BINDGEN to its executable." >&2
  exit 1
fi

CARGO_TARGET_DIR="$target_dir" cargo build --locked --release --lib --target wasm32-unknown-unknown
"$bindgen" --target web --no-typescript --out-dir "$out_dir" \
  "$target_dir/wasm32-unknown-unknown/release/sail_client.wasm"
cp web/index.html web/boot.js "$out_dir/"

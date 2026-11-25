#!/bin/sh
set -eu
repo="${SAIL_RELEASE_REPOSITORY:-snowdamiz/sail}"
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl -fsSL --retry 3 "https://github.com/$repo/releases/latest/download/install-desktop.sh" -o "$installer"
sh "$installer"

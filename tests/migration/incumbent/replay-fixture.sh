#!/bin/sh
set -eu

usage() {
  printf 'Usage: %s prepare <new absolute fixture directory>\n' "$0" >&2
  printf '       %s seed <absolute fixture directory> <Sail.app>\n' "$0" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
action=$1
fixture_dir=$2
case "$fixture_dir" in /*) ;; *) usage ;; esac

case "$action" in
  prepare)
    [ "$#" -eq 2 ] || usage
    repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
    source_sha=$(jq -er .incumbentSourceSha "$repo/tests/migration/incumbent/release-inventory.json")
    mkdir "$fixture_dir"
    mkdir -p "$fixture_dir/home" "$fixture_dir/state/userdata" "$fixture_dir/replay-source" "$fixture_dir/project/src"
    git -C "$repo" archive -o "$fixture_dir/replay-source.tar" "$source_sha" \
      apps/server/scripts/dev-replay-agent.ts apps/server/scripts/dev-replay \
      apps/server/src/orchestration-v2/testkit/fixtures
    tar -xf "$fixture_dir/replay-source.tar" -C "$fixture_dir/replay-source"
    node_path=$(node -p process.execPath)
    replay_agent="$fixture_dir/replay-source/apps/server/scripts/dev-replay-agent.ts"
    jq -n --arg node "$node_path" --arg agent "$replay_agent" '{providerInstances:{devReplay:{
      displayName:"Replay (dev)",driver:"acpRegistry",
      config:{source:"local",commandPath:$node,commandArgs:[$agent]}
    }}}' > "$fixture_dir/state/userdata/settings.json"
    printf 'export const sum = (a, b) => a + b;\n' > "$fixture_dir/project/src/math.js"
    git init --quiet --initial-branch=main "$fixture_dir/project"
    git -C "$fixture_dir/project" add src/math.js
    git -C "$fixture_dir/project" -c user.name=Fixture -c user.email=fixture@example.invalid \
      -c commit.gpgsign=false commit --quiet --message 'Add fixture math module'
    printf '%s\n' "$source_sha" > "$fixture_dir/replay-source-sha"
    ;;
  seed)
    [ "$#" -eq 3 ] || usage
    [ -f "$fixture_dir/replay-source-sha" ] || usage
    [ ! -e "$fixture_dir/replay-result.json" ] || usage
    app=$3
    executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
    cli() {
      env HOME="$fixture_dir/home" SAIL_HOME="$fixture_dir/state" T3CODE_HOME="$fixture_dir/state" \
        ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/$executable" \
        "$app/Contents/Resources/app.asar/apps/server/dist/bin.mjs" "$@" --base-dir "$fixture_dir/state"
    }
    cli project add --title 'Compatibility demo' "$fixture_dir/project"
    cli thread start --provider devReplay --model showcase --title 'Compatibility replay' \
      --wait --json "$fixture_dir/project" 'Give me a short tour' > "$fixture_dir/replay-result.json"
    jq -e '.status == "completed" and (.reply | contains("This turn is a replay."))' \
      "$fixture_dir/replay-result.json" >/dev/null
    ;;
  *) usage ;;
esac

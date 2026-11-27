#!/usr/bin/env bash
set -euo pipefail
set +x

usage() {
  cat <<'HELP'
Usage: deploy/fly/deploy.sh --app NAME [--region REGION] [--image IMAGE | --build] [--password-file FILE]
       deploy/fly/deploy.sh --app NAME [--pair | --snapshot]
       Add --dry-run to preview the operation without contacting Fly or GitHub.

Deploy or upgrade one Sail server, set an initial sign-in password on fresh
deploys, and print the Sail URL plus pairing links.
--region REGION       Use this region (default: iad for new volumes).
--image IMAGE         Use a registry image, or a local image name without a slash.
--build               Build this checkout on Fly's remote builder.
--password-file FILE  Read the initial sign-in password (15-256 characters) from FILE.
--pair                Pair with the running deployment without redeploying.
--snapshot            Request a snapshot of the Sail volume without redeploying.
HELP
}

fail() {
  printf 'Sail Fly deploy: %s\n' "$*" >&2
  exit 1
}

app=
region=
image=
password_file=
mode=deploy
build=false
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app|--region|--image|--password-file)
      [ "$#" -ge 2 ] && [[ $2 != -* && -n $2 ]] || fail "$1 requires a value."
      case "$1" in
        --app) app=$2 ;;
        --region) region=$2 ;;
        --image) image=$2 ;;
        --password-file) password_file=$2 ;;
      esac
      shift ;;
    --build) build=true ;;
    --pair|--snapshot)
      [ "$mode" = deploy ] || fail 'Choose one of --pair and --snapshot.'
      mode=${1#--} ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

[[ $app =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'Pass a valid Fly app name with --app.'
[[ -z $region || $region =~ ^[a-z]{3}$ ]] || fail 'Pass a three-letter Fly region.'
[[ -z $image || $image =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_@-]*$ ]] || fail 'Pass a valid image reference.'
[ -z "$image" ] || ! $build || fail 'Choose one of --image and --build.'
if [ "$mode" != deploy ] && { [ -n "$image$region$password_file" ] || $build; }; then
  fail 'Image, build, region, and password options apply only to deploy.'
fi

deployment_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$deployment_dir/../.." && pwd -P)
config="$deployment_dir/fly.toml"
volume_name=$(awk '
  /^[[:space:]]*\[/ { mount = ($0 ~ /^[[:space:]]*\[\[mounts\]\][[:space:]]*$/) }
  mount && /^[[:space:]]*source[[:space:]]*=[[:space:]]*"[a-z0-9_]+"[[:space:]]*$/ {
    split($0, parts, "\"")
    print parts[2]
  }
' "$config")
[[ $volume_name =~ ^[a-z0-9_]+$ ]] || fail 'Expected one volume source in fly.toml.'

if $dry_run; then
  case "$mode" in
    deploy)
      source=${image:-the latest published Sail server image}
      if $build; then source='this checkout on the Fly remote builder'; fi
      printf 'Would ensure app %s and a 10 GB %s volume (new volume region: %s).\n' "$app" "$volume_name" "${region:-iad}"
      if [ -n "$password_file" ]; then
        printf 'Would stage SAIL_INITIAL_OWNER_PASSWORD from %s before deploying.\n' "$password_file"
      else
        printf 'Would stage a generated SAIL_INITIAL_OWNER_PASSWORD if no password is configured yet.\n'
      fi
      printf 'Would deploy %s with one Machine, verify its environment ID, and print sign-in details.\n' "$source" ;;
    pair) printf 'Would verify the running Sail server on %s and mint two pairing links.\n' "$app" ;;
    snapshot) printf 'Would request a snapshot of the existing %s volume on %s.\n' "$volume_name" "$app" ;;
  esac
  exit 0
fi

read_password_file() {
  local file=$1 line= extra= has_extra=false len
  [ -r "$file" ] || fail "Could not read password file: $file"
  {
    IFS= read -r line || [ -n "$line" ] || fail 'Password file is empty.'
    if IFS= read -r extra || [ -n "$extra" ]; then
      has_extra=true
    fi
  } < "$file"
  ! $has_extra || fail 'Password file must contain a single line.'
  line=${line%$'\r'}
  len=${#line}
  (( len >= 15 && len <= 256 )) || fail 'Initial password must be 15-256 characters.'
  printf '%s' "$line"
}

provided_password=
if [ -n "$password_file" ]; then
  provided_password=$(read_password_file "$password_file")
fi

if command -v flyctl >/dev/null 2>&1; then
  fly=flyctl
elif command -v fly >/dev/null 2>&1; then
  fly=fly
else
  fail 'Install flyctl and run fly auth login.'
fi
"$fly" auth whoami >/dev/null || fail 'Fly authentication failed. Run fly auth login and retry.'

json_fields() {
  LC_ALL=C awk -v fields="$1" -v rows="${2:-0}" -f "$deployment_dir/read-json.awk"
}

resolve_app_origin() {
  local status=$1 app_url hostname candidate
  app_url=$(json_fields AppURL <<< "$status") || return 2
  hostname=$(json_fields Hostname <<< "$status") || return 2
  hostname=${hostname%/}
  for candidate in "${app_url%/}" "${hostname:+https://$hostname}"; do
    [ -n "$candidate" ] || continue
    case "$candidate" in
      "https://$app.fly.dev"|"https://$app.localtest.me")
        printf '%s' "$candidate"
        return 0 ;;
      *)
        if [[ $candidate = "https://$app.localtest.me:"* && ${candidate##*:} =~ ^[0-9]{1,5}$ ]]; then
          printf '%s' "$candidate"
          return 0
        fi ;;
    esac
  done
  return 1
}

has_initial_password_secret() {
  local secrets rows
  secrets=$("$fly" secrets list --app "$app" --json) || fail 'Could not list Fly secrets.'
  [ -n "$secrets" ] && [ "$secrets" != null ] || return 1
  rows=$(json_fields 'name Name' 1 <<< "$secrets") || fail 'Invalid Fly secrets response.'
  [ -n "$rows" ] || return 1
  LC_ALL=C awk -F'\t' '$1 == "SAIL_INITIAL_OWNER_PASSWORD" || $2 == "SAIL_INITIAL_OWNER_PASSWORD" { found = 1 } END { exit(found ? 0 : 1) }' <<< "$rows"
}

server_has_owner_password() {
  local pre_status pre_origin session
  pre_status=$("$fly" status --app "$app" --json 2>/dev/null) || return 1
  pre_origin=$(resolve_app_origin "$pre_status" 2>/dev/null) || return 1
  session=$(curl -q -fsS --max-time 10 "$pre_origin/api/auth/session" 2>/dev/null) || return 1
  grep -Eq '"ownerPassword"[[:space:]]*:[[:space:]]*"configured"' <<< "$session"
}

generate_initial_password() {
  local hex
  hex=$(od -An -tx1 -N 16 /dev/urandom | tr -d ' \n')
  [[ $hex =~ ^[0-9a-f]{32}$ ]] || fail 'Could not generate an initial password.'
  printf '%s-%s-%s-%s' "${hex:0:8}" "${hex:8:8}" "${hex:16:8}" "${hex:24:8}"
}

stage_initial_password() {
  printf 'SAIL_INITIAL_OWNER_PASSWORD=%s\n' "$1" |
    "$fly" secrets import --app "$app" --stage >&2 ||
    fail 'Could not stage SAIL_INITIAL_OWNER_PASSWORD on Fly.'
}

load_volume() {
  local volumes rows id name state existing_region
  volumes=$("$fly" volumes list --app "$app" --json) || fail 'Could not list Fly volumes.'
  rows=$(json_fields 'id name state region' 1 <<< "$volumes") || fail 'Invalid Fly volume response.'
  [ -n "$rows" ] || return 0
  while IFS=$'\t' read -r id name state existing_region; do
    [[ $id =~ ^vol_[a-zA-Z0-9]+$ && $name =~ ^[a-z0-9_]+$ &&
      $state =~ ^[a-z_]+$ && $existing_region =~ ^[a-z]{3}$ ]] || fail 'Invalid Fly volume record.'
    [ "$name" = "$volume_name" ] || continue
    [ "$state" = created ] || fail "The $volume_name volume is unavailable."
    [ -z "$volume" ] || fail "Multiple $volume_name volumes exist. Resolve the ambiguity before continuing."
    volume=$id
    volume_region=$existing_region
  done <<< "$rows"
}

volume=
volume_region=
if [ "$mode" = snapshot ]; then
  load_volume
  [ -n "$volume" ] || fail "No $volume_name volume exists for this app."
  "$fly" volumes snapshots create "$volume" --app "$app"
  exit 0
fi

generated_password=
if [ "$mode" = deploy ]; then
  if $build; then
    source_args=(--remote-only --dockerfile "$repo/Dockerfile")
  else
    if [ -z "$image" ]; then
      release=$(curl -q -fsS --max-time 30 https://api.github.com/repos/snowdamiz/sail/releases/latest) ||
        fail 'Could not resolve a published Sail release. Use --image or --build.'
      tag=$(json_fields tag_name <<< "$release") || fail 'Invalid GitHub release response.'
      [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'No stable release tag found. Use --image or --build.'
      # The release workflow tags GHCR with the version, without GitHub's leading v.
      image="ghcr.io/snowdamiz/sail-server:${tag#v}"
    fi
    source_args=(--image "$image")
    if [[ $image != */* ]]; then source_args+=(--local-only); fi
  fi

  apps=$("$fly" apps list --quiet) || fail 'Could not list Fly apps.'
  app_existed=true
  if ! LC_ALL=C awk -v app="$app" '{ gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if ($0 == app) found = 1 } END { exit(found ? 0 : 1) }' <<< "$apps"; then
    app_existed=false
    "$fly" apps create "$app" >&2
  fi

  load_volume
  volume_existed=false
  if [ -n "$volume" ]; then
    volume_existed=true
    [ -z "$region" ] || [ "$region" = "$volume_region" ] ||
      fail "The existing volume is in $volume_region. Omit --region or use $volume_region."
    region=$volume_region
  else
    region=${region:-iad}
    "$fly" volumes create "$volume_name" --app "$app" --region "$region" --size 10 --yes >&2
  fi

  if [ -n "$provided_password" ]; then
    stage_initial_password "$provided_password"
  elif ! has_initial_password_secret; then
    if ! $app_existed || ! $volume_existed || ! server_has_owner_password; then
      generated_password=$(generate_initial_password)
      stage_initial_password "$generated_password"
    fi
  fi

  "$fly" deploy "$repo" --app "$app" --config "$config" \
    --primary-region "$region" --ha=false --yes "${source_args[@]}" >&2
fi

status=$("$fly" status --app "$app" --json) || fail 'Could not read the deployed app URL.'
origin_rc=0
origin=$(resolve_app_origin "$status") || origin_rc=$?
if [ "$origin_rc" -eq 2 ]; then
  fail 'Invalid Fly app status response.'
elif [ "$origin_rc" -ne 0 ]; then
  fail 'Fly did not return the expected HTTPS origin for this app.'
fi

machine_output=$("$fly" machine list --app "$app" --quiet) || fail 'Could not list Fly Machines.'
machine=$(LC_ALL=C awk '{ gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if ($0 != "") print }' <<< "$machine_output")
[[ $machine =~ ^[a-f0-9]+$ ]] || fail 'Expected exactly one Sail Machine.'
ssh=("$fly" ssh console --app "$app" --machine "$machine" --user sail --quiet)
expected=$("${ssh[@]}" -C 'cat /data/sail/userdata/environment-id' </dev/null) ||
  fail 'Could not read the environment ID from the Sail Machine.'
expected=${expected%$'\r'}
[[ $expected =~ ^[a-zA-Z0-9._-]+$ ]] || fail 'The Sail Machine returned an invalid environment ID.'
manifest=$(curl -q -fsS --max-time 60 --retry 4 --retry-connrefused \
  "$origin/.well-known/t3/environment") || fail 'Could not read the public Sail environment.'
actual=$(json_fields environmentId <<< "$manifest") || fail 'Invalid public Sail environment response.'
[ "$actual" = "$expected" ] || fail 'Public environment ID differs from the Sail Machine. Pairing stopped.'

mint() {
  "${ssh[@]}" -C "t3 auth pairing create --json --require-running --label '$1'${2:-}" </dev/null 2>/dev/null ||
    fail 'Pairing failed. Verify the Machine is running a Sail image with Fly deploy support, then retry --pair.'
}

desktop_result=$(mint 'Sail desktop')
browser_result=$(mint 'Browser or phone' ' --qr')
desktop_url=$(json_fields pairUrl <<< "$desktop_result") || fail 'Invalid desktop pairing response.'
browser_url=$(json_fields pairUrl <<< "$browser_result") || fail 'Invalid browser pairing response.'
qr=$(json_fields qr <<< "$browser_result") || fail 'Invalid pairing QR response.'
pair_prefix="$origin/pair#token="
for url in "$desktop_url" "$browser_url"; do
  token=${url#"$pair_prefix"}
  [[ $url = "$pair_prefix"* && $token =~ ^[a-zA-Z0-9_-]+$ ]] ||
    fail 'The Sail Machine did not return a pairing link for the verified HTTPS origin.'
done
[ "$desktop_url" != "$browser_url" ] || fail 'The Sail Machine returned the same token twice.'
qr=${qr//\\n/$'\n'}
qr_check=${qr//[[:space:]]/}
qr_check=${qr_check//█/}
qr_check=${qr_check//▀/}
qr_check=${qr_check//▄/}
[[ -z $qr_check && $qr = *█* ]] || fail 'The Sail Machine did not return a terminal QR code.'

# The HTTPS URL is already restricted to a DNS name, an optional port and a URL-safe token.
desktop_link=${desktop_url//:/%3A}
desktop_link=${desktop_link//\//%2F}
desktop_link=${desktop_link//#/%23}
desktop_link=${desktop_link//=/%3D}
desktop_link="sail://pair?pairingUrl=$desktop_link"

if [ -t 1 ] && [[ ${OSTYPE:-} = darwin* ]]; then
  open "$desktop_link" >/dev/null 2>&1 || printf 'Open the desktop link in Sail to pair.\n' >&2
elif [ -t 1 ] && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$desktop_link" >/dev/null 2>&1 || printf 'Open the desktop link in Sail to pair.\n' >&2
fi
printf 'Sail URL: %s\n' "$origin"
if [ -n "$generated_password" ]; then
  printf 'Initial password: %s\n' "$generated_password"
fi
printf 'Desktop link: %s\nBrowser or phone link: %s\n%s\n' "$desktop_link" "$browser_url" "$qr"

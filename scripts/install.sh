#!/bin/sh
# Installs the T3 Code CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://raw.githubusercontent.com/snowdamiz/sail/main/scripts/install.sh | sh
#
# Environment:
#   T3CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   T3CODE_VERSION           exact version to install (overrides T3CODE_CHANNEL)
#   T3CODE_HOME              T3 home directory (default: ~/.t3)
#   T3CODE_INSTALL_BIN_DIR   where the `t3` command goes (default: ~/.local/bin)
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $T3CODE_HOME/runtime/versions/<version>, the
# same layout `t3 service install` uses, so the service reuses this download
# instead of fetching the release again.
#
# On Linux, pass --stage-only with T3CODE_VERSION to stage a Sail archive under
# runtime/boat-staged/<version>. Prints the verified archive SHA-256 to stdout.
set -eu

repo="snowdamiz/sail"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
t3_home="${T3CODE_HOME:-$HOME/.t3}"
case "$t3_home" in
  /*) ;;
  *)
    # Preserve cwd's trailing newlines; trim only pwd's newline and the sentinel.
    t3_cwd="$(pwd -P && printf .)"
    t3_home="${t3_cwd%??}/$t3_home"
    ;;
esac
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
# Trailing slashes would put `//` in the paths the t3 command guard compares.
while [ "${t3_home%/}" != "$t3_home" ] && [ "$t3_home" != / ]; do t3_home="${t3_home%/}"; done
while [ "${bin_dir%/}" != "$bin_dir" ] && [ "$bin_dir" != / ]; do bin_dir="${bin_dir%/}"; done
# Absolute, so the PATH hint never adds a folder that changes with the working directory.
case "$bin_dir" in /*) ;; *) bin_dir="$PWD/$bin_dir" ;; esac

fail() {
  printf '\nt3 install: %s\n' "$1" >&2
  exit 1
}

stage_only=false
case "$#:${1:-}" in
  0:) ;;
  1:--stage-only) stage_only=true ;;
  *) fail "usage: install.sh [--stage-only]" ;;
esac

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s\n' '██████████ ████████ ' >&2
  printf '  %s\n' '    ███       ▄██▀       T3 Code' >&2
  printf '  %s%s     %sCLI installer%s\n' '    ███       ████▄ ' "$reset" "$muted" "$reset$bold" >&2
  printf '  %s\n' '    ███    ▄     ███' >&2
  printf '  %s\n' '    ███    ███████▀ ' >&2
  printf '%s\n' "$reset" >&2
fi
step "Finding your release..."

# Sleeps 1, 2, then 4 s before retrying a 408, 429, 5xx, or network error. Not curl
# --retry: older curl waits out any Retry-After, however long.
backoff() {
  case "$1" in 408 | 429) ;; 4??) return 1 ;; esac
  [ "$2" -lt 4 ] && sleep "$((1 << ($2 - 1)))"
}

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    attempt=1
    while :; do
      code=0; status="$(curl -sSL -H "Accept: ${3:-*/*}" -w '%{http_code}' "$1" -o "$2")" || code=$?
      case "$code:$status" in 0:2??) break ;; esac
      backoff "$status" "$attempt" || break
      attempt=$((attempt + 1))
    done
    [ "$code" -eq 0 ] || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response --header="Accept: ${3:-*/*}" "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
download_start() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -w '%{http_code}' -D "$2.headers" "$1" -o "$2" >"$2.status" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
}
# Reaps the finished download, then restarts it if curl hit a transient error.
download_retry() {
  result=0; wait "$download_pid" || result=$?
  download_pid=
  [ "$result" -ne 0 ] && [ -f "$2.status" ] && backoff "$(cat "$2.status")" "$attempt" || return 1
  attempt=$((attempt + 1))
  download_start "$1" "$2"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  attempt=1
  download_start "$1" "$2"
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null || download_retry "$1" "$2"; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors" "$2.status"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
if [ "${platform}-${arch}" = darwin-x64 ]; then
  fail "there is no t3 CLI for Intel Macs. Install the desktop app from https://github.com/snowdamiz/sail/releases, or run a server from source: https://github.com/${repo}/blob/main/docs/user/install.md#intel-macs"
fi
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum < "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 < "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${T3CODE_CHANNEL:-stable}"
version="${T3CODE_VERSION:-}"
if "$stage_only"; then
  [ "$platform" = linux ] || fail "staging Boat releases requires Linux"
  case "$version" in
    ''|*[!a-zA-Z0-9.+-]*) fail "staging requires an exact T3CODE_VERSION" ;;
  esac
  number='(0|[1-9][0-9]*)'
  prerelease="($number|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)"
  printf '%s\n' "$version" | LC_ALL=C grep -Eq "^$number\.$number\.$number(-$prerelease(\.$prerelease)*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$" ||
    fail "staging requires an exact T3CODE_VERSION"
elif [ -z "$version" ]; then
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "T3CODE_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  if [ "$channel" = stable ]; then
    # release.yml marks only plain stable releases latest. This is a github.com
    # page, so it is not cut off by a page of newer nightlies or the API quota.
    fetch "https://github.com/${repo}/releases/latest" "$tmp_index" application/json
    version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  else
    page=1
    while [ -z "$version" ] && [ "$page" -le 10 ]; do
      fetch "https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}" "$tmp_index"
      version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
      grep -q '"tag_name"' "$tmp_index" || break
      page=$((page + 1))
    done
  fi
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set T3CODE_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "t3 ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set T3CODE_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${T3CODE_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="t3-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${t3_home}/runtime/versions"
if "$stage_only"; then
  # The launcher and runtime pruner only select from runtime/versions.
  versions_dir="${t3_home}/runtime/boat-staged"
  [ ! -L "$versions_dir" ] || fail "the Boat staging directory is a symlink"
fi
target_dir="${versions_dir}/${version}"

if [ "$platform" = linux ] && { "$stage_only" || [ -e "$t3_home/runtime/boat-installation-id" ]; }; then
  mkdir -p "$t3_home/runtime"
  [ ! -L "$t3_home/runtime" ] && [ ! -L "$t3_home/runtime/boat-lifecycle.lock" ] ||
    fail "the Boat lifecycle requires a canonical runtime directory"
  exec 9>>"$t3_home/runtime/boat-lifecycle.lock"
  flock -w 10 9 || fail "another operation owns the pinned Boat lifecycle"
  [ ! -e "$t3_home/runtime/boat-power-operation" ] || fail "a Boat power operation is pending"
  if [ -e "$t3_home/runtime/boat-installation-id" ]; then
    node - "$t3_home/runtime/service-state.json" <<'NODE' || fail "the Boat service journal requires launcher recovery"
const fs = require("node:fs");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (![2, 3, 4].includes(state?.protocol) || typeof state.activeVersion !== "string" ||
      state.maintenance !== undefined || state.update?.status === "pending") process.exitCode = 1;
} catch (error) {
  if (error.code !== "ENOENT") process.exitCode = 1;
}
NODE
  fi
fi

staged_tree_sha256() {
  # Keep this in step with stagedTreeSha256 in the standalone launcher.
  node - "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.argv[2];
const tree = crypto.createHash("sha256");
async function visit(relative) {
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  if (stat.isDirectory()) {
    tree.update(JSON.stringify([relative, "directory"]));
    for (const name of fs.readdirSync(file).sort()) {
      if (relative !== "" || name !== ".sail-tree-sha256") await visit(path.join(relative, name));
    }
  } else if (stat.isFile() && relative !== "") {
    const content = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) content.update(chunk);
    tree.update(JSON.stringify([relative, "file", stat.mode & 0o777, content.digest("hex")]));
  } else {
    throw new Error("Unsupported entry in staged Sail runtime.");
  }
}
visit("").then(() => console.log(tree.digest("hex"))).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE
}


is_sail_archive() {
  [ -f "$1/.sail-product" ] && [ ! -L "$1/.sail-product" ] &&
    [ "$(cat "$1/.sail-product")" = sail ]
}

reports_exact_version() {
  [ -f "$1/t3" ] && [ ! -L "$1/t3" ] && [ -x "$1/t3" ] &&
    [ "$("$1/t3" --version)" = "t3 v$version" ]
}

staged_release_matches() {
  [ ! -L "$target_dir" ] &&
    [ "$(cat "$target_dir/.install-complete" 2>/dev/null)" = "$version" ] &&
    is_sail_archive "$target_dir" &&
    [ "$(cat "$target_dir/.sail-archive-sha256" 2>/dev/null)" = "$expected" ] &&
    [ -f "$target_dir/.sail-tree-sha256" ] && [ ! -L "$target_dir/.sail-tree-sha256" ] &&
    tree_digest="$(staged_tree_sha256 "$target_dir")" && [ -n "$tree_digest" ] &&
    [ "$(cat "$target_dir/.sail-tree-sha256")" = "$tree_digest" ] &&
    reports_exact_version "$target_dir"
}

report_staged_release() {
  sync -f "$target_dir" || fail "could not sync the staged runtime"
  printf '%s\n' "$expected"
}

# A sandbox may already have an upstream CLI at this version.
if ! "$stage_only" && [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ] &&
  { [ "$platform" != linux ] || { [ -f "${target_dir}/.sail-product" ] && [ "$(cat "${target_dir}/.sail-product")" = sail ]; }; }; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  action=Installing
  if "$stage_only"; then action=Staging; fi
  printf '  %s%s%s T3 Code %s%s%s\n\n' "$muted" "$action" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "t3 ${version} has no release archive for ${platform}-${arch}; releases before the self-contained CLI can only be installed with \`npm install -g t3@${version}\`"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "t3 ${version} has no release archive for ${platform}-${arch}"
  if "$stage_only" && { [ -e "$target_dir" ] || [ -L "$target_dir" ]; }; then
    staged_release_matches || fail "a different or incomplete release occupies $target_dir"
    report_staged_release
    exit 0
  fi
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}" || fail "could not download ${archive}"

  step "Verifying the download..."
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting T3 Code..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  if "$stage_only"; then
    is_sail_archive "$staging" || fail "the downloaded archive is missing its Sail product marker"
    reports_exact_version "$staging" || fail "the downloaded executable does not report t3 v$version"
    printf '%s\n' "$version" > "$staging/.install-complete"
    printf '%s\n' "$expected" > "$staging/.sail-archive-sha256"
    [ ! -e "$staging/.sail-tree-sha256" ] && [ ! -L "$staging/.sail-tree-sha256" ] ||
      fail "the release archive contains a reserved staging receipt"
    tree_digest="$(staged_tree_sha256 "$staging")" || fail "could not digest the staged runtime"
    printf '%s\n' "$tree_digest" > "$staging/.sail-tree-sha256"
    sync -f "$staging" || fail "could not sync the verified staged runtime"
    # Publish only once, after the archive and all extracted bytes have been verified.
    mv -nT "$staging" "$target_dir" || fail "could not publish the staged runtime"
    staged_release_matches || fail "a different or incomplete release occupies $target_dir"
    report_staged_release
    exit 0
  fi
  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' sail > "${staging}/.sail-product"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  # When a concurrent install published first, mv moved this copy inside it; keep only theirs.
  rm -rf "${target_dir}/${staging##*/}"
  trap - EXIT
fi

step "Setting up the t3 command..."
mkdir -p "$bin_dir"
# Exec by absolute path: through a symlink, argv0 is the link, and the Cursor SDK looks for its
# helpers beside it. t3 update and t3 install write the same script.
nl='
'
launcher_head="#!/bin/sh${nl}exec '"
launcher_tail="' \"\$@\"${nl}"
# The x keeps a trailing newline in the path through command substitution.
launcher_script() {
  quoted="$(printf '%sx' "$1" | sed "s/'/'\\\\''/g")"
  printf '%s%s%s' "$launcher_head" "${quoted%x}" "$launcher_tail"
}
# The executable an unedited launcher script at $1 runs; a user's own wrapper prints nothing.
script_t3() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(wc -c < "$1")" -le 4096 ] || return 0
  contents="$(cat "$1"; printf x)"
  contents="${contents%x}"
  case "$contents" in "$launcher_head"*"$launcher_tail") ;; *) return 0 ;; esac
  quoted="${contents#"$launcher_head"}"
  unquoted="$(printf '%sx' "${quoted%"$launcher_tail"}" | sed "s/'\\\\''/'/g")"
  unquoted="${unquoted%x}"
  [ -n "$unquoted" ] && [ "$(launcher_script "$unquoted"; printf x)" = "${contents}x" ] && printf '%s' "$unquoted"
  return 0
}
# Replace only this home's own t3 launchers: into its versions, or the desktop app's launcher.
# Anything else (a user's script, a copied binary) belongs to someone else.
# Exactly <versions>/<version>/t3 ($1 under $2), never another program inside a version.
version_t3() {
  case "$1" in "$2"/*) ;; *) return 1 ;; esac
  case "${1#"$2"/}" in */*/*) return 1 ;; */t3) return 0 ;; *) return 1 ;; esac
}
slot_empty=true
if [ -e "${bin_dir}/t3" ] || [ -L "${bin_dir}/t3" ]; then
  slot_empty=false
  owned=false
  real_versions_dir="$(CDPATH='' cd -P -- "$versions_dir" && pwd)"
  if [ -L "${bin_dir}/t3" ]; then
    existing="$(readlink "${bin_dir}/t3" 2>/dev/null || true)"
    case "$existing" in /*) ;; *) existing="${bin_dir}/${existing}" ;; esac
  else
    existing="$(script_t3 "${bin_dir}/t3")"
  fi
  if [ -n "$existing" ]; then
    # Through a symlinked T3 home the path names the alias; resolve its folder to compare.
    existing_dir="$(CDPATH='' cd -P -- "$(dirname -- "$existing")" 2>/dev/null && pwd || true)"
    # The text alone counts only without . or .. segments (a pruned version leaves a dangling path).
    case "$existing" in
      */./* | */../* | */. | */..) ;;
      *)
        if version_t3 "$existing" "$versions_dir" || version_t3 "$existing" "$real_versions_dir" ||
          [ "$existing" = "${t3_home}/bin/t3" ]; then owned=true; fi
        ;;
    esac
    if [ -n "$existing_dir" ] && version_t3 "${existing_dir}/${existing##*/}" "$real_versions_dir"; then
      owned=true
    fi
  fi
  "$owned" || fail "another t3 is already at ${bin_dir}/t3. Remove it and run this again, or run ${target_dir}/t3 directly."
fi
launcher_tmp="$(mktemp "${bin_dir}/.t3.XXXXXX")"
trap 'rm -f "$launcher_tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
launcher_script "${target_dir}/t3" > "$launcher_tmp"
chmod 755 "$launcher_tmp"
# An empty spot is hard-linked without -f, so a file that appears after the check above is kept.
if "$slot_empty"; then
  ln "$launcher_tmp" "${bin_dir}/t3" || fail "could not write ${bin_dir}/t3; something else was created there."
else
  # Known race, accepted: a file written here after the ownership check above is overwritten.
  # mv replaces a legacy symlink rather than writing through it.
  mv -f "$launcher_tmp" "${bin_dir}/t3"
fi
rm -f "$launcher_tmp"
trap - EXIT
# Pruning keeps what this launcher points at; a background service cannot see bin_dir otherwise.
launcher="$(CDPATH='' cd -P -- "$bin_dir" && pwd)/t3"
launchers="${t3_home}/runtime/launchers"
grep -qxF "$launcher" "$launchers" 2>/dev/null || printf '%s\n' "$launcher" >> "$launchers"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled T3 Code %s%s\n\n' "$green" "$version" "$reset" >&2
# The folder a shell reads its startup file from: $1 when set and safe to paste, else $2 when
# unset. A set but unsafe folder prints nothing, since the default would never be read.
read_from() {
  case "$1" in
    "") printf '%s' "$2" ;;
    /*) case "$1" in *[!A-Za-z0-9_./-]*) ;; *) printf '%s' "$1" ;; esac ;;
  esac
}
# A command to paste for zsh, Linux bash, or fish, like `t3 install` prints. macOS bash reads only
# one of several startup files, so no single file is safe to change there.
path_command=
path_rest="$bin_dir"
path_prefix=
case "$bin_dir" in "$HOME"/*) path_rest="${bin_dir#"$HOME"}" path_prefix='$HOME' ;; esac
case "$path_rest" in *[!A-Za-z0-9_./-]*) path_rest= ;; esac
if [ -n "$path_rest" ]; then
  # Last on PATH, so it never shadows another t3.
  path_line="export PATH=\"\$PATH:${path_prefix}${path_rest}\""
  shell_name="${SHELL:-}"
  case "${shell_name##*/}" in
    zsh)
      # zsh reads .zshrc from ZDOTDIR when it is set; ~/.zshrc would never be read then.
      zsh_dir="$(read_from "${ZDOTDIR:-}" '~')"
      [ -z "$zsh_dir" ] || path_command="printf '\\n%s\\n' '${path_line}' >> ${zsh_dir}/.zshrc" ;;
    bash) [ "$platform" = darwin ] || path_command="printf '\\n%s\\n' '${path_line}' >> ~/.bashrc" ;;
    fish)
      # --path changes $PATH itself; fish_user_paths would go ahead of the system folders.
      config_dir="$(read_from "${XDG_CONFIG_HOME:-}" '~/.config')"
      fish_dir="${config_dir}/fish"
      [ -z "$config_dir" ] || path_command="mkdir -p ${fish_dir} && printf '\\n%s\\n' 'fish_add_path --append --path ${path_prefix}${path_rest}' >> ${fish_dir}/config.fish" ;;
  esac
fi
# A t3 earlier on PATH runs instead; the PATH command adds this folder last.
# A PATH entry with a trailing slash gives `dir//t3`.
first_t3="$(command -v t3 2>/dev/null | tr -s / || true)"
case "$first_t3" in "" | "${bin_dir}/t3") first_t3= ;; esac
if [ -n "$first_t3" ]; then
  printf '  Another t3 at %s runs first, so run %s%s/t3%s to use this one.\n\n' "$first_t3" "$bold" "$bin_dir" "$reset"
else
  case ":${PATH}:" in
    *":${bin_dir}:"* | *":${bin_dir}/:"*) printf '  Run %st3%s to use T3 Code here, or %st3 up%s to use it from your other devices.\n\n' "$bold" "$reset" "$bold" "$reset" ;;
    *)
      if [ -n "$path_command" ]; then
        printf '  %s is not on your PATH yet. Add it with:\n\n    %s\n\n  Then open a new terminal and run %st3%s.\n\n' "$bin_dir" "$path_command" "$bold" "$reset"
      else
        printf '  Add %s to your PATH, then run %st3%s.\n\n' "$bin_dir" "$bold" "$reset"
      fi
      ;;
  esac
fi

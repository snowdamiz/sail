#!/bin/sh
# Generated for one Sail release; curl the release asset rather than this source template.
set -eu
version="__SAIL_VERSION__"
repo="__SAIL_REPOSITORY__"
base="${SAIL_RELEASE_BASE_URL:-__SAIL_RELEASE_BASE__}"
fail() { printf 'Sail install: %s\n' "$1" >&2; exit 1; }
case "$(uname -s)" in
  Darwin) platform=mac; extension=zip ;;
  Linux) platform=linux; extension=AppImage ;;
  *) fail "Sail desktop releases support macOS and Linux." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "This CPU architecture is not supported." ;;
esac
if [ "$platform" = mac ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
archive="Sail-$version-$arch.$extension"
staging="$(mktemp -d)"
replacement=
backup=
target=
cleanup() {
  if [ -n "$backup" ] && [ -d "$backup" ] && [ ! -e "$target" ]; then mv "$backup" "$target"; fi
  [ -z "$replacement" ] || rm -rf "$replacement"
  rm -rf "$staging"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'Downloading Sail %s for %s/%s...\n' "$version" "$platform" "$arch"
curl -fSL --retry 3 --connect-timeout 15 --max-time 900 "$base/v$version/$archive" -o "$staging/$archive"
curl -fsSL --retry 3 "$base/v$version/SHA256SUMS" -o "$staging/SHA256SUMS"
expected="$(awk -v file="$archive" '$2 == file { print $1 }' "$staging/SHA256SUMS")"
[ "${#expected}" = 64 ] || fail "The release has no checksum for $archive."
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$staging/$archive" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$staging/$archive" | cut -d ' ' -f 1)"
fi
[ "$actual" = "$expected" ] || fail "Checksum verification failed; the installed app was not changed."
bin_dir="${SAIL_INSTALL_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
if [ "$platform" = mac ]; then
  install_dir="${SAIL_INSTALL_DIR:-$HOME/Applications}"
  mkdir -p "$install_dir"
  target="$install_dir/Sail.app"
  replacement="$install_dir/.Sail.install.$$"
  backup="$install_dir/.Sail.previous.$$"
  ditto -x -k "$staging/$archive" "$staging/extracted"
  set -- "$staging/extracted/"*.app
  [ "$#" = 1 ] && [ -d "$1" ] || fail "The archive must contain one Sail app."
  name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$1/Contents/Info.plist")"
  case "$name" in Sail*) ;; *) fail "This archive does not contain Sail." ;; esac
  ditto "$1" "$replacement"
  xattr -dr com.apple.quarantine "$replacement" 2>/dev/null || true
  [ ! -e "$target" ] || mv "$target" "$backup"
  mv "$replacement" "$target"
  quoted_target="$(printf '%s' "$target" | sed "s/'/'\\\\''/g")"
  printf "#!/bin/sh\nexec /usr/bin/open '%s' --args \"\$@\"\n" "$quoted_target" > "$bin_dir/sail"
  chmod +x "$bin_dir/sail"
  rm -rf "$backup"
  printf 'Installed %s. Open it from Finder or run sail.\n' "$target"
else
  install_dir="${SAIL_INSTALL_DIR:-$HOME/.local/opt/sail}"
  mkdir -p "$install_dir"
  target="$install_dir/Sail.AppImage"
  replacement="$install_dir/.Sail.install.$$"
  cp "$staging/$archive" "$replacement"
  chmod +x "$replacement"
  mv -f "$replacement" "$target"
  ln -sfn "$target" "$bin_dir/sail"
  desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$desktop_dir"
  printf '[Desktop Entry]\nType=Application\nName=Sail\nExec="%s" %%U\nTerminal=false\nCategories=Development;\n' "$target" > "$desktop_dir/sail.desktop"
  printf 'Installed %s. Open Sail from your app menu or run sail.\n' "$target"
fi
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add %s to your PATH to use the sail command.\n' "$bin_dir" ;; esac

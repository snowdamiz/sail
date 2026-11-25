#!/bin/sh
# The desktop process supplies its own PID and already-verified replacement.
set -eu
pid="$1"
target="$2"
replacement="$3"
backup="$4"
relaunch="$5"
attempt=0
while kill -0 "$pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 120 ] || exit 1
  sleep 1
done
[ -d "$target" ] && [ -d "$replacement" ] && [ ! -e "$backup" ] || exit 1
rollback() {
  if [ ! -e "$target" ] && [ -d "$backup" ]; then
    mv "$backup" "$target"
  fi
}
trap rollback EXIT
trap 'rollback; exit 1' HUP INT TERM
mv "$target" "$backup"
mv "$replacement" "$target"
if [ "$relaunch" = true ]; then
  if ! /usr/bin/open -n "$target"; then
    mv "$target" "$replacement"
    mv "$backup" "$target"
    /usr/bin/open -n "$target" || true
    exit 1
  fi
fi
# A successful launch removes the backup on its next update check.
trap - EXIT HUP INT TERM

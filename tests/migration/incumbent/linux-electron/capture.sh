#!/bin/sh
set -eu

case "$(dpkg --print-architecture)" in
  arm64) arch=arm64; sha=586f462a77a7973d51bea119712dcc3bc1245753cff986f32d6568040fa20f91 ;;
  amd64) arch=x64; sha=31ecd16a6cc3b63bce892aa8f37d24fd8e569acf0461260b3755366890ed59cf ;;
  *) exit 2 ;;
esac
package="/input/Sail-0.1.17-$arch.deb"
printf '%s  %s\n' "$sha" "$package" | sha256sum -c -
dpkg --path-include='/usr/share/doc/sail/*' -i "$package" >/out/install.log 2>&1
dpkg --verify sail >/out/dpkg-verify.log
test ! -s /out/dpkg-verify.log

chown sailfixture /out
probe=probe.py
if [ "${1:-}" = "--display" ]; then
  probe=display.py
  shift
fi
test "$#" -eq 0
exec runuser -u sailfixture -- dbus-run-session -- xvfb-run -a \
  -s '-screen 0 1400x1000x24 -dpi 96 -nolisten tcp' \
  python3 "/fixtures/incumbent/linux-electron/$probe" "$arch" "$sha"

# Published Sail launcher and server runtime

[`v0.1.17-macos-arm64.json`](v0.1.17-macos-arm64.json) records the published macOS arm64 ZIP from Sail v0.1.17, source `18fd0e5d66291fc007163512d783d7268218db16`. The probe verifies the ZIP against the pinned release inventory and checks the entry types, file contents, and symlink targets of the installed app against the ZIP. See [release inventory](../release-inventory.json).

## Reproduce the receipt

Use macOS arm64 and Python 3.11 or newer. Point `fixture` to a directory containing the published ZIP, `installer-home/Applications/Sail.app`, and the installer-generated `installer-home/bin/sail`. The receipt path must be new and outside the fixture.

```sh
fixture=/tmp/sail-p01.sjS5Ni
runtime=tests/migration/incumbent/runtime
receipt_dir=$(mktemp -d)
python3 "$runtime/check.py" "$fixture" \
  --output "$receipt_dir/receipt.json" \
  --expect "$runtime/v0.1.17-macos-arm64.json"
```

The probe reads the installed `sail` wrapper to verify its `open … --args "$@"` invocation. It calls the bundled server through Electron's Node mode. Each launch uses its own temporary `HOME`, XDG directories, working directory, and loopback listener. The probe checks the runtime record's PID, the database location, and the descriptor's identity against the file in the selected home. It sends SIGTERM to the child it started and checks that the listener and runtime record are gone. The release exited with code 130 on each successful shutdown.

The receipt records `--base-dir` taking precedence over `SAIL_HOME` and `T3CODE_HOME`, `SAIL_HOME` taking precedence over `T3CODE_HOME`, and the legacy variable and `$HOME/.sail` fallbacks. The desktop backend selects the home delivered over fd 3. A readiness challenge verifies that the server received the envelope's secret. Removing the envelope's required mode causes startup to fail before publishing a runtime record.

`serve` with startup pairing disabled prints readiness without a pairing URL. Explicit `pair` and control-plane startup pairing each issue a credential that can establish a browser session once. Desktop bootstrap also establishes a browser session. The probe verifies the session endpoint before and after attaching the cookie. The receipt retains protocol 2 metadata, the HTTP 426 response to a protocol 1 request, and descriptor profiles with the observed capability values. Control-plane mode reports `localSessions: false` and omits `serverBrowser`. The desktop backend advertises `serverSelfUpdate: "desktop-managed"`. The machine class in the descriptor is part of the observed profile and may differ on another Mac.

The probe compares JSON values and returns exit 1 for a mismatch. Two fresh runs produced identical receipt data. A third run rejected an expectation with the control-plane `localSessions` capability changed to `true`. Runtime state and captured CLI output are temporary. The receipt uses placeholders for ports and scratch paths and omits generated credentials, proof bytes, cookies, QR codes, PIDs, and environment IDs.

## Main source and remaining coverage

At the time of this check, remote `main` was `bf6b9482a27bdae8e1f723bee173cedfc3fcaa8e` and the server and desktop manifests named `0.1.18`. Source comparison found the same descriptor implementation, protocol constant, desktop bootstrap schema and backend launch configuration. Main adds a built-in skills state path and changes the WS settings handler for isolated provider homes. The focused source tests in `apps/server/src/ws.test.ts` and `packages/client-runtime/src/rpc/session.test.ts` passed 64 tests in the PR worktree at `94730fd425c8d0a2f0c341495d1b784e2d0c245b`. The packaged live receipt is for v0.1.17.

The macOS receipt covers HTTP protocol rejection from the server. The wider live matrix, launchers on other hosts, server side channels, OCI runtime, service launcher, remote pairing, and paired screenshot and trace timing remain open under P01. The run index links the separate client update interaction and desktop observations. [Run index](../observations/run.json)

## Linux installer observations

The [arm64 receipt](v0.1.17-linux-arm64.json) and [x64 receipt](v0.1.17-linux-x64.json) cover the published v0.1.17 CLI archive, AppImage, and Debian package. The CLI ran on Debian 12.15. Desktop ran as an unprivileged user on Debian 13.8 under Xvfb with Electron's sandbox disabled. The Docker engine ran on arm64 and emulated amd64 for x64 runs.

Use the published `install.sh` with `T3CODE_VERSION=0.1.17` and `install-desktop.sh` with a fresh shell home. Both scripts accept a loopback release mirror through `T3CODE_RELEASE_BASE_URL` and `SAIL_RELEASE_BASE_URL`, respectively. Serve the pinned assets and `SHA256SUMS` under `v0.1.17/`. Use `dpkg -i` for the Debian package. On Debian slim, include `--path-include='/usr/share/doc/sail/*'` so that `dpkg --verify sail` can also verify the packaged changelog. The Debian package declares libc6 2.39 or newer.

Launch the installed CLI with `--startup-pairing off` and query `/.well-known/t3/environment`. Run `t3 thread show --json` against a separate launch with a copied v0.1.17 Replay database. In the desktop checks, launch the installed binary or extracted AppImage entrypoint, then open the saved thread in the app and capture its X11 window. The fresh desktop starts at onboarding. The copied home shows the finished Replay reply, highlighted code and four-row table. Only the fixture database was copied into the launch homes, so the checks exercise saved history without installing a provider. The separate preservation probe checks the database bytes before and after the two desktop installers.

The arm64 AppImage launched with `APPIMAGE_EXTRACT_AND_RUN=1` because there was no FUSE device. Its Electron process and backend closed after a DevTools quit request. The x64 AppImage runtime exited 127 under emulation. Extracting the published SquashFS payload with `unsquashfs` and launching its `AppRun` let that desktop app boot. Both Debian installations completed and passed `dpkg --verify`. Their post-install scripts logged an unshare permission diagnostic inside the containers. FUSE, the native x64 AppImage launcher, desktop sandboxing and Linux updates need separate runs.

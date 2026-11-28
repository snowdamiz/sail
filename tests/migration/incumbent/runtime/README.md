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

The macOS receipt covers HTTP protocol rejection from the server. The wider live matrix, launchers on other hosts, server side channels, service launcher, remote pairing, and paired screenshot and trace timing remain open under P01. The run index links the separate client update interaction and desktop observations. [Run index](../observations/run.json)

## Linux installer observations

The [arm64 receipt](v0.1.17-linux-arm64.json) and [x64 receipt](v0.1.17-linux-x64.json) cover the published v0.1.17 CLI archive, AppImage, and Debian package. The CLI ran on Debian 12.15. Desktop ran as an unprivileged user on Debian 13.8 under Xvfb with Electron's sandbox disabled. The Docker engine ran on arm64 and emulated amd64 for x64 runs.

Use the published `install.sh` with `T3CODE_VERSION=0.1.17` and `install-desktop.sh` with a fresh shell home. Both scripts accept a loopback release mirror through `T3CODE_RELEASE_BASE_URL` and `SAIL_RELEASE_BASE_URL`, respectively. Serve the pinned assets and `SHA256SUMS` under `v0.1.17/`. Use `dpkg -i` for the Debian package. On Debian slim, include `--path-include='/usr/share/doc/sail/*'` so that `dpkg --verify sail` can also verify the packaged changelog. The arm64 package requires libc6 2.39 or newer, and the x64 package requires 2.34 or newer.

Launch the installed CLI with `--startup-pairing off` and query `/.well-known/t3/environment`. Run `t3 thread show --json` against a separate launch with a copied v0.1.17 Replay database. In the desktop checks, launch the installed binary or extracted AppImage entrypoint, then open the saved thread in the app and capture its X11 window. The fresh desktop starts at onboarding. The copied home shows the finished Replay reply, highlighted code and four-row table. Only the fixture database was copied into the launch homes, so the checks exercise saved history without installing a provider. The separate preservation probe checks the database bytes before and after the two desktop installers.

The arm64 AppImage launched with `APPIMAGE_EXTRACT_AND_RUN=1` because there was no FUSE device. Its Electron process and backend closed after a DevTools quit request. The x64 AppImage runtime exited 127 under emulation. Extracting the published SquashFS payload with `unsquashfs` and launching its `AppRun` let that desktop app boot. Both Debian installations completed and passed `dpkg --verify`. Their post-install scripts logged an unshare permission diagnostic inside the containers. FUSE, the native x64 AppImage launcher, and desktop sandboxing need separate runs.

## Published foreground CLI upgrade

The [upgrade receipt](v0.1.17-to-v0.1.18-cli.json) covers `t3 update 0.1.18 --yes` on Linux arm64 and emulated x64. Install v0.1.17 into a scratch home with a copy of the Replay database. Run its installed foreground server and establish both a browser cookie session and a bearer session with `orchestration:read`. Serve the published v0.1.18 archives and checksums through `T3CODE_RELEASE_BASE_URL`.

Both launchers rejected the target with a deliberately invalid checksum and left the original server and launcher intact. With the published checksum, the installed command switched to v0.1.18. The foreground server stayed at v0.1.17 until it was stopped. On restarting with the same home and port, v0.1.18 reported the same environment identity and three saved messages, accepted both original sessions with their original scope, and returned HTTP 426 to a protocol 1 request. Both published versions used migration 118. Service-managed upgrades require their own run.

## Published arm64 AppImage update

Use writable copies of the released AppImage and the Replay database in a disposable Debian arm64 container running Xvfb. Start v0.1.17 with `APPIMAGE_EXTRACT_AND_RUN=1`. Set `T3CODE_DESKTOP_MOCK_UPDATES=true` and `T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT` to direct the packaged updater to a loopback mirror. Serve the v0.1.18 `latest-linux-arm64.yml` and AppImage. The mirror rejects byte ranges so the updater takes the full-download path.

Replace both AppImage SHA-512 entries in a scratch copy of the manifest. In **Settings → About**, check for updates and click **Download**. Verify the checksum error and compare the installed AppImage and saved thread with their pre-update state. Restore the published manifest and check again. Click **Download**, then **Install** and **Confirm**. Verify that the app relaunches, the bundled server reports v0.1.18, and the saved Replay thread opens from the sidebar.

The [AppImage update receipt](../observations/electron-linux-arm64/appimage-update/receipt.json) records both archive digests, the failed and successful downloads, and the restarted app. This run covers the loopback full-download path. The public network feed, differential downloads, and the x64 AppImage updater need separate runs.

## Published Debian package update

Install the architecture's v0.1.17 Debian package in a disposable Debian 13.8 container. Include `/usr/share/doc/sail/*` in dpkg's path filters. Launch the installed desktop as an unprivileged fixture user under Xvfb with `--no-sandbox`. This fixture grants the user passwordless root access through `sudo /bin/bash` inside the container, which runs with external networking disabled and the package inputs mounted read-only. Verify the package with `dpkg --verify sail` as root.

Use the same loopback feed override and update controls as the AppImage test. Serve `latest-linux-arm64.yml` for arm64 or `latest-linux.yml` for x64, along with the matching v0.1.18 Debian package. Replace the Debian package's SHA-512 in the first manifest. Check the original package and backend after the failure, then restore the published manifest. After confirming the update, check the dpkg upgrade entry, the relaunched application, and the reopened Replay thread.

Run [the saved-thread fingerprint check](upgrade_state.py) against the fixture database and thread ID before updating, after checksum rejection, and after installation. Compare the persisted message and run fingerprints at all three points.

The [arm64 receipt](../observations/electron-linux-arm64/deb-update/receipt.json) and [x64 receipt](../observations/electron-linux-x64/deb-update/receipt.json) record the checks for the packaged updater through sudo and dpkg. The x64 run used amd64 emulation. Interactive privilege prompts and the public network feed need separate runs.

## Published OCI runtime

The [OCI receipt](v0.1.17-oci.json) records both platform manifests from the pinned v0.1.17 index. Run the default image entrypoint with port 8080 published to loopback and a fresh writable `/data` mount for each case. Run the [wire checker](../../wire/README.md) against the fresh container, using `docker exec … t3` to issue its fixture sessions. For the copied case, put the isolated Replay database under `/data/sail/userdata/` before launch, then read the saved thread with `docker exec … t3 thread show --json`.

Both images ran the server as UID 1000 from `/data/home`. The fresh containers passed the v2 wire checker and the copied containers returned all three Replay messages. On Docker stop, all four removed the runtime record and closed the listener. These observations cover the default image entrypoint on a local host.

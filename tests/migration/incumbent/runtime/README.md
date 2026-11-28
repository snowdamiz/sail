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

The macOS receipt covers HTTP protocol rejection from the server. The wider live matrix, launchers on other hosts, server side channels, OS service registration, remote pairing, and paired screenshot and trace timing remain open under P01. The run index links the separate client update interaction and desktop observations. [Run index](../observations/run.json)

## Published macOS ZIP and DMG formats

The [macOS package receipt](v0.1.17-macos-package-formats.json) records the archive digests and the runs on macOS arm64. Check each archive against the pinned release inventory, `SHA256SUMS`, and the matching SHA-512 entry in `latest-mac.yml`.

Extract each ZIP with `ditto -x -k`. Attach each DMG read-only with `hdiutil attach -readonly -nobrowse`, copy `Sail.app` with `ditto`, and detach the image. Compare the copied app's entry types, file contents, and symlink targets with the ZIP for its architecture using `compare_bundle` from [check.py](check.py).

On Apple silicon with Rosetta, run the published desktop installer from `arch -x86_64 /bin/sh` with a scratch home and loopback release mirror. The translated shell selected the arm64 ZIP and installed the same bundle as the direct arm64 extraction. For the manually extracted Intel ZIP, launch the bundled CLI in Electron Node mode with `arch -x86_64`, a fresh home, and `serve --host 127.0.0.1 --startup-pairing off`. Poll the environment descriptor on the selected port. Startup under translation took more than two minutes on the recorded host.

For the DMG desktop run, copy the saved Replay database and environment ID into a scratch home. Pass the fixture's `sail://threads/…` link to the app executable at startup. Check the loopback listener's desktop parent, the desktop bootstrap session, the selected thread, and the full [saved-thread fingerprints](upgrade_state.py). Move the reply into view before capturing the settled window. The arm64 run reached that capture. The translated Intel run opened the saved thread and preserved the payloads, then timed out waiting for highlighted code. The settled Intel capture and a run on native Intel hardware remain open.

## Linux installer observations

The [arm64 receipt](v0.1.17-linux-arm64.json) and [x64 receipt](v0.1.17-linux-x64.json) cover the published v0.1.17 CLI archive, AppImage, and Debian package. The CLI ran on Debian 12.15. Desktop ran as an unprivileged user on Debian 13.8 under Xvfb with Electron's sandbox disabled. The Docker engine ran on arm64 and emulated amd64 for x64 runs.

Use the published `install.sh` with `T3CODE_VERSION=0.1.17` and `install-desktop.sh` with a fresh shell home. Both scripts accept a loopback release mirror through `T3CODE_RELEASE_BASE_URL` and `SAIL_RELEASE_BASE_URL`, respectively. Serve the pinned assets and `SHA256SUMS` under `v0.1.17/`. Use `dpkg -i` for the Debian package. On Debian slim, include `--path-include='/usr/share/doc/sail/*'` so that `dpkg --verify sail` can also verify the packaged changelog. The arm64 package requires libc6 2.39 or newer, and the x64 package requires 2.34 or newer.

Launch the installed CLI with `--startup-pairing off` and query `/.well-known/t3/environment`. Run `t3 thread show --json` against a separate launch with a copied v0.1.17 Replay database. In the desktop checks, launch the installed binary or extracted AppImage entrypoint, then open the saved thread in the app and capture its X11 window. The fresh desktop starts at onboarding. The copied home shows the finished Replay reply, highlighted code and four-row table. Only the fixture database was copied into the launch homes, so the checks exercise saved history without installing a provider. The separate preservation probe checks the database bytes before and after the two desktop installers.

The arm64 AppImage launched with `APPIMAGE_EXTRACT_AND_RUN=1` because there was no FUSE device. Its Electron process and backend closed after a DevTools quit request. The x64 AppImage runtime exited 127 under emulation. Extracting the published SquashFS payload with `unsquashfs` and launching its `AppRun` let that desktop app boot. Both Debian installations completed and passed `dpkg --verify`. Their post-install scripts logged an unshare permission diagnostic inside the containers. FUSE, the native x64 AppImage launcher, and desktop sandboxing need separate runs.

## Published Linux CLI lifecycle

The [arm64 captures](../observations/cli-linux-arm64/lifecycle) and [x64 captures](../observations/cli-linux-x64/lifecycle) have two independent fresh boots and two independent copied-home boots each. They use the released standalone CLI on Debian 12.15, with x64 under Rosetta in Docker. Each copied boot reopened the saved Replay thread through the live CLI and preserved the complete message and run payloads.

Mount the published tarball at `/archive.tar.gz` and its unpacked runtime at `/release`, both read-only. Mount the isolated Replay backup at `/seed.sqlite` and its saved thread ID file at `/thread-id`. Mount `tests/migration` at `/fixture` and a writable empty capture directory at `/out`. Run the following in a disposable Debian 12 container with network access limited to its own loopback interface.

```sh
python3 /fixture/incumbent/runtime/capture-cli.py \
  /archive.tar.gz /release /seed.sqlite /thread-id /out
```

Add `--emulated` for the x64 Rosetta run, which allows up to 90 seconds for readiness. The capture checks the archive and installed entries, the executable linked from the owned process or mapped by Rosetta, and selection of the explicit home. It records readiness, the descriptor, a one-use read-only browser session with the requested grants, and cleanup after Ctrl-C. Pairing credentials and cookies stay in memory.

Run [render-cli.py](render-cli.py) with Pillow on each output directory after formatting its JSON. It renders the sanitized terminal transcript and binds the PNG to the process and state receipts. The Rust coverage audit checks both boots for each claimed configuration and compares the copied state to the [pinned seed](cli-lifecycle-seed.json).

## Published foreground CLI upgrade

The [upgrade receipt](v0.1.17-to-v0.1.18-cli.json) covers `t3 update 0.1.18 --yes` on Linux arm64 and emulated x64. Install v0.1.17 into a scratch home with a copy of the Replay database. Run its installed foreground server and establish both a browser cookie session and a bearer session with `orchestration:read`. Serve the published v0.1.18 archives and checksums through `T3CODE_RELEASE_BASE_URL`.

Both launchers rejected the target with a deliberately invalid checksum and left the original server and launcher intact. With the published checksum, the installed command switched to v0.1.18. The foreground server stayed at v0.1.17 until it was stopped. On restarting with the same home and port, v0.1.18 reported the same environment identity and three saved messages, accepted both original sessions with their original scope, and returned HTTP 426 to a protocol 1 request. Both published versions used migration 118.

## Published Linux service launcher update

Use an arm64 Debian 12 Docker image with Python 3, curl, and tar. Put the two published arm64 CLI archives and their `SHA256SUMS` files under `$releases/v0.1.17` and `$releases/v0.1.18`. Set `$seed` and `$thread` to the saved Replay fixture database and thread ID. Use a new scratch directory path, Node 24 or newer, and Python 3.11 or newer on the host.

```sh
python3 tests/migration/incumbent/runtime/check-service.py \
  "$releases" "$seed" "$thread" "$image" "$scratch/service" \
  --expect tests/migration/incumbent/runtime/v0.1.17-to-v0.1.18-service.json
```

The probe starts the packaged `__service-launcher` under Docker init with a scratch version selection and a copied database. The read-only session receives the typed update denial. The maintain session first checks a zeroed archive checksum, then retries against the published manifest. Watch the launcher keep its original process, activate a new child, and retain the committed selection when restarted. The probe compares the full saved Replay payloads and checks that both original bearer tokens still work after activation and restart.

The [receipt](v0.1.17-to-v0.1.18-service.json) covers the Linux arm64 launcher protocol and update RPC with a loopback release mirror. Systemd installation and service unit repointing need separate runs.

## Published Linux service trial rollback

Build the [Rust trial gate](service-trial-gate.rs) for Linux arm64. Use the same release assets, seed, and Docker image as the launcher update probe.

```sh
gate_src="$PWD/tests/migration/incumbent/runtime/service-trial-gate.rs"
docker run --rm --network none --platform linux/arm64 \
  --user "$(id -u):$(id -g)" -v "$gate_src:/trial.rs:ro" -v "$scratch:/out" \
  rust:1.100.0-bookworm rustc --edition=2024 -D warnings /trial.rs -o /out/trial-gate
python3 tests/migration/incumbent/runtime/check-service.py \
  "$releases" "$seed" "$thread" "$image" "$scratch/rollback" \
  --trial-gate "$scratch/trial-gate" \
  --expect tests/migration/incumbent/runtime/v0.1.17-to-v0.1.18-rollback.json
```

The probe stages the published target and places the gate at its executable entry point in scratch. Preflight still runs the published binary. The gate pauses the trial startup. Once the probe verifies the pending update ID and the launcher's snapshot, it changes the saved reply payload, adds a marker table to the copied database, and releases the gate. The published trial server exits before activation when it fails to bind. The v0.1.17 launcher restores the saved payloads and removes the marker through snapshot restoration. The probe restarts the launcher on the rolled-back selection, verifies both bearer grants, then retries with the unchanged published target executable. [Rollback receipt](v0.1.17-to-v0.1.18-rollback.json)

## Published arm64 macOS archive update

Extract the verified v0.1.17 arm64 ZIP into a writable scratch directory. Launch its executable with a scratch home and a copy of the Replay database and environment ID. Rerun the [macOS bundle comparison](check.py) after the update to verify the installed files against the published target ZIP.

Use `T3CODE_DESKTOP_MOCK_UPDATES=true` and `T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT` to serve the v0.1.18 ZIP and `latest-mac.yml` on loopback. Replace the arm64 ZIP's SHA-512 in the first manifest with a different value. In **Settings → About**, check for updates and click **Download**. After the checksum error, verify the predecessor version, installed app, and [saved-thread fingerprints](upgrade_state.py).

Restore the published manifest, check for updates, and download again. Click **Install** and **Confirm**. Wait for the updater to relaunch Sail. Check that the server answers on the original port with the same environment ID and protocol. Open the saved thread with its `sail://threads/…` link and check the reply, highlighted code, and table. The next update check removes the previous bundle and staging files.

Use a separate scratch installation with the packaged GitHub feed to repeat the successful upgrade path while v0.1.18 is the latest stable release. Both installed trees matched all 327 entries inside the v0.1.18 ZIP bundle and preserved the saved payloads. The installer creates the outer app directory with mode `0700`. [Update receipt](../observations/electron-macos-arm64/archive-update/receipt.json)

On Apple silicon with Rosetta, repeat the public-feed check from the verified Intel v0.1.17 ZIP. Confirm the desktop bridge reports `appArch: "x64"` and `runningUnderArm64Translation: true`. When the bridge reports v0.1.18 as available, call `downloadUpdate()` and wait for that version to finish downloading. Call `installUpdate("0.1.18")` and wait for the packaged installer to relaunch the app. Check the executable and server architecture, verify the installed files against the arm64 ZIP, and reopen the saved thread. The translated Settings flow timed out waiting for **Download** in a separate run. Native Intel hardware requires a separate run. [Rosetta update receipt](../observations/electron-macos-x64/rosetta-update/receipt.json)

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

# Capture the published Sail baseline

Use the [release inventory](release-inventory.json) to select the asset and check its SHA-256. The published reference uses the v0.1.17 macOS arm64 ZIP and its bundled server. Settled Replay is repeatable in one Chromium profile and one Electron profile. The [coverage catalog](coverage-catalog.json) tracks qualification per state and profile.

## Seed the Replay fixture on macOS

Install the archive into a scratch directory with the release's `install-desktop.sh`. Set `SAIL_INSTALL_DIR` and `SAIL_INSTALL_BIN_DIR` to directories under that scratch directory. Keep the installed app's absolute path in `app` and choose a new absolute path for `fixture`.

```sh
sh tests/migration/incumbent/replay-fixture.sh prepare "$fixture"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
env -u ELECTRON_RUN_AS_NODE HOME="$fixture/home" SAIL_HOME="$fixture/state" \
  T3CODE_HOME="$fixture/state" T3CODE_ENVIRONMENT_LABEL='Compatibility fixture' \
  T3CODE_DISABLE_AUTO_UPDATE=1 "$app/Contents/MacOS/$executable"
```

Once the fixture server opens a window, seed the project and Replay turn from a second terminal. The command checks for a completed response and writes `replay-result.json` under the fixture directory. It runs the pinned Replay recording through the installed server's provider adapter.

```sh
sh tests/migration/incumbent/replay-fixture.sh seed "$fixture" "$app"
```

## Capture the settled Chromium replay

1. Pair the Browser panel to the isolated host. For a second incumbent or a source build, copy the seeded `statev2.sqlite` with SQLite's backup command and use a separate scratch home and port. The hosts need the same fixture project, thread, and Replay settings.
2. Set the Chromium viewport to 640 × 600 CSS pixels at scale 2 and zoom 1, with English, the light theme, and standard motion. Open **Compatibility replay** by its direct URL. Wait for `This turn is a replay.` and the first highlighted code line at `main .chat-markdown-shiki pre code .line:first-child`.
3. Press Tab once to focus **Attach files**. Move the pointer to the blank header margin at CSS point `(1, 45)`. Run [the settled replay probe](settled-replay-browser.js) as a browser expression and await its result. It checks the highlighted code, transcript, focus, and menu state. Save the screenshot and use the returned profile and trace in the capture receipt.
4. For capture timing, repeat the navigation, focus, trace and screenshot sequence on each host in turn. Discard two warmup rounds and retain twelve measured rounds.

The [settled captures and timings](observations/served-chromium-macos/settled) contain two v0.1.17 runs and one local v0.1.18 source build. All 42 captures have the same PNG hash and trace. The earlier heading-click captures remain in `first` and `repeat`. Those captures opened the thread menu. A longer trial also caught frames taken before syntax highlighting had rendered. The settled sequence waits for the highlighted code and checks that the menu is closed.

Capture timing includes Browser panel calls and rendering waits. In this run, waiting for the highlighted reply took the largest share on the published build. The three p95 values are 984 ms, 962 ms, and 953 ms. These results cover one capture profile and one settled thread.

## Capture the settled Electron replay on macOS

1. Launch two copies of the published app with separate scratch homes, each populated from the same seeded database backup. Give each copy its own server port and pass `--remote-debugging-address=127.0.0.1 --remote-debugging-port=<fixture-port>` to the app executable. Use DevTools only for these test windows.
2. Open **Compatibility replay**. Use a window of 1100 × 780 points at display scale 2, zoom 1, English, and the dark theme with standard motion. Close both side panels. Move keyboard focus out of the composer and hover the reply at window point `(570, 543)`.
3. Run `node tests/migration/incumbent/settled-replay-electron.mjs "$devtools_port"` to verify the settled transcript and reply actions. Capture the whole window with `swift tests/migration/capture-macos.swift "$fixture_pid" "$capture_dir/capture.png"`. Keep the windows on the same display and take a new screenshot for each sample.
4. For timing, activate each already-loaded window, hover the reply, run the probe, and take the screenshot. Run hosts in turn for each round and retain two warmups and twelve measured rounds per host.

The [Electron comparisons](observations/electron-macos-arm64/settled-hover/comparisons.json) record zero changed pixels and trace steps between the two v0.1.17 copies and between v0.1.17 and the [published v0.1.18 build](observations/release-revisions/v0.1.18.json). All 42 samples produced matching PNGs and traces. The [native capture timings](observations/electron-macos-arm64/settled-hover/capture-timings.json) show p95s of 710 and 1,050 ms for the two v0.1.17 copies and 968 ms for v0.1.18. The newer release exceeded the 15% budget against the first incumbent. The screenshot stage took 621 ms in that v0.1.18 sample. This timing covers the already-loaded fixture and includes the macOS screenshot command.

## Check approval and client compatibility

The [approval receipt](observations/served-chromium-macos/approval/receipt.json) records the published Chromium client's supervised Replay approval and decline paths, SQLite outcomes, and disabled approval controls in a read-only session. The [version rejection receipt](observations/served-chromium-macos/version-rejection/receipt.json) records the published server's HTTP 426 and the published client's **Update** and **Retry update** states against the [simulated older service](version-rejection/README.md).

The [browser availability receipt](observations/browser-availability.json) records WebDriver startup failures for Safari and stock Firefox on this Mac. Both Replay profiles remain open.

The [run receipt](observations/run.json) records the installer, wire, and SQLite checks. Use the [launcher and runtime probe](runtime/README.md) to reproduce the installed package's startup and capability observations.

# Capture the published Sail baseline

Use the [release inventory](release-inventory.json) to select the asset and check its SHA-256. The published reference uses the v0.1.17 macOS arm64 ZIP and Linux arm64 CLI archive. Settled Replay is repeatable in the recorded Chromium, Electron, and Firefox ESR profiles. The [coverage catalog](coverage-catalog.json) tracks qualification per state and profile.

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

The [packaged migration-head comparison](observations/served-chromium-macos/migration-head-4807bdae) uses Chromium headless shell 156.0.8078.4 in three isolated Playwright profiles. Both v0.1.17 copies matched. The web client built at `4807bdae` differed by 3,478 pixels in the composer and exposed the Poteto control. Its capture p95 was 572 ms against 1,137 and 1,696 ms for the incumbent copies, within the budget for this fixture.

## Capture the settled Firefox replay on Linux

Run the published Linux arm64 CLI archive twice under separate scratch homes with copies of the seeded database. Pair a fresh Firefox ESR profile to each server under Xvfb. Use the same viewport, Tab action, and pointer position as the Chromium capture. Adapt the probe's user-agent match to Firefox and record the installed version from GeckoDriver. The [Linux Firefox receipts](observations/served-firefox-linux/settled) contain both matching captures and the installed package versions.

## Capture the settled Electron replay on macOS

1. Launch two copies of the published app with separate scratch homes, each populated from the same seeded database backup. Give each copy its own server port and pass `--remote-debugging-address=127.0.0.1 --remote-debugging-port=<fixture-port>` to the app executable. Use DevTools only for these test windows.
2. Open **Compatibility replay**. Use a window of 1100 × 780 points at display scale 2, zoom 1, English, and the dark theme with standard motion. Close both side panels. Move keyboard focus out of the composer and hover the reply at window point `(570, 543)`.
3. Run `node tests/migration/incumbent/settled-replay-electron.mjs "$devtools_port"` to verify the settled transcript and reply actions. Capture the whole window with `swift tests/migration/capture-macos.swift "$fixture_pid" "$capture_dir/capture.png"`. Keep the windows on the same display and take a new screenshot for each sample.
4. For timing, activate each already-loaded window, hover the reply, run the probe, and take the screenshot. Run hosts in turn for each round and retain two warmups and twelve measured rounds per host.

The [Electron comparisons](observations/electron-macos-arm64/settled-hover/comparisons.json) record zero changed pixels and trace steps between the two v0.1.17 copies and between v0.1.17 and the [published v0.1.18 build](observations/release-revisions/v0.1.18.json). All 42 samples produced matching PNGs and traces. The [native capture timings](observations/electron-macos-arm64/settled-hover/capture-timings.json) show p95s of 710 and 1,050 ms for the two v0.1.17 copies and 968 ms for v0.1.18. The newer release exceeded the 15% budget against the first incumbent. The screenshot stage took 621 ms in that v0.1.18 sample. This timing covers the already-loaded fixture and includes the macOS screenshot command.

The local macOS package built at `4807bdae` includes the Poteto composer control from trunk. Two v0.1.17 copies matched again. The migration-head package differed by 3,417 pixels in the composer and one control observation. Its capture p95 was 1,085 ms against 1,125 and 544 ms for the incumbent copies. It exceeded the budget against the faster copy. [Package and comparison receipts](observations/electron-macos-arm64/migration-head-4807bdae)

## Capture Electron display variants

Open the settled thread in the packaged macOS app. Use **Settings → Appearance** for light and dark modes and **Settings → General → Language** for German. For 120% zoom, choose **View → Actual Size**, then **View → Zoom In** twice. Read the zoom factor from the desktop bridge and keep the physical capture dimensions with the renderer's CSS dimensions. Capture the docked sidebar at 1100 × 780 points and the thread and sidebar sheet at 640 × 780 points. [Display receipts](observations/electron-macos-arm64/display/receipt.json)

## Check approval and client compatibility

The [approval receipt](observations/served-chromium-macos/approval/receipt.json) records the published Chromium client's supervised Replay approval and decline paths, SQLite outcomes, and disabled approval controls in a read-only session. The [version rejection receipt](observations/served-chromium-macos/version-rejection/receipt.json) records the published server's HTTP 426 and the published client's **Update** and **Retry update** states against the [simulated older service](version-rejection/README.md).

## Capture chat loading and reconnect

Run the packaged server with the seeded home. Put [the loopback gate](thread-load-gate.mjs) in front of it and pair the browser at the gate's port. Use a fresh origin or browser profile so the client has no saved transcript for the thread.

```sh
printf '%s\n' hold > "$gate_file"
node tests/migration/incumbent/thread-load-gate.mjs "$gate_port" "$server_port" "$thread_id" "$gate_file"
```

Capture the empty draft, then open the seeded thread. The gate holds the thread detail request while the released client shows **Loading messages...**. Write `open` to the gate file and confirm the Replay reply appears. For the error view, open that thread under an unpaired environment ID and follow **Open Environments**. [Chat states receipt](observations/served-chromium-macos/chat-states/receipt.json)

For reconnect, keep the gate open and leave an unsent draft in the loaded thread. Stop only the isolated packaged server. Capture the reconnect banner and use **Retry now**. Restart the same server and confirm the warning clears and the transcript and draft are present in that tab. [Reconnect receipt](observations/served-chromium-macos/disconnect-recover/receipt.json)

## Capture the Browser panel fixture

Serve the page from [the title-change scenario](../../../scripts/scenarios/browser-tab-follows-page-title.e2e.ts) on loopback. Open it in the seeded thread's **Browser** panel and click the page canvas. Wait for the tab to display **Updated title** at the same address. Select **Release control** and use the thread provider's `preview_status` to locate the tab. Call `preview_evaluate` on that tab with the expression in the [Browser panel receipt](observations/served-chromium-macos/browser-panel/receipt.json). The receipt includes the packaged v0.1.17 screenshots and the tool's returned value.

The [browser availability receipt](observations/browser-availability.json) records WebDriver startup failures for Safari and stock Firefox on macOS. Those macOS Replay profiles remain open.

The [run receipt](observations/run.json) records the installer, wire, and SQLite checks. Use the [launcher and runtime probe](runtime/README.md) to reproduce the installed package's startup and capability observations.

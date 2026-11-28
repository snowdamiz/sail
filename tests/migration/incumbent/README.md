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

### Linux

Build the fixture image for Linux arm64. Use the pinned CLI archive, the [Chrome for Testing archive](https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.88/linux-arm64/chrome-headless-shell-linux-arm64.zip), and a standalone SQLite backup of the completed Replay seed. Set `$seed_thread_id` to the saved thread ID. Provide absolute paths to the archives and backup.

```sh
fixture="$PWD/tests/migration/incumbent"
mkdir "$scratch/runs"
printf '%s\n' "$seed_thread_id" > "$scratch/thread-id"
git archive -o "$scratch/replay.tar" v0.1.17 \
  apps/server/scripts/dev-replay-agent.ts apps/server/scripts/dev-replay \
  apps/server/src/orchestration-v2/testkit/fixtures
docker build --platform linux/arm64 -t sail-migration-chromium "$fixture/linux-chromium"
for copy in a b; do
  docker run --rm --init --network none --platform linux/arm64 --user "$(id -u):$(id -g)" \
    -v "$fixture:/fixture:ro" -v "$scratch/runs:/runs" -v "$seed_database:/seed.sqlite:ro" \
    -v "$scratch/replay.tar:/replay-source.tar:ro" -v "$chrome_archive:/chrome.zip:ro" \
    -v "$scratch/thread-id:/thread-id:ro" -v "$published_archive:/release.tar.gz:ro" \
    sail-migration-chromium bash /fixture/linux-chromium/capture.sh "/runs/$copy"
done
```

Each server gets its own installed package, home, paired Chrome profile, and capture. The probe calls the released server's Browser panel tools through a fixture ACP session. It checks the launch binary on Linux arm64, pairs through the served page, and requires an available Showcase model, the exact settled table, and **Attach files** focus. Use each run's `capture.png`, `receipt.json`, and `state.json` with the [capture comparator](../README.md#compare-two-captures).

Both Debian 12.15 arm64 captures matched pixel for pixel and had identical action traces at 640 × 600 CSS pixels and 2× scale. Chrome reports `Linux x86_64` through `navigator.platform`. The probe identifies the running browser from its AArch64 executable. [Linux Chromium reference](observations/served-chromium-linux/settled)

To measure capture time, put the same inputs in one directory as `published.tar.gz`, `chrome.zip`, `seed.sqlite`, `thread-id`, and `replay.tar`. For the candidate run, add `head.tar.gz`, the Git archive used to build it as `head-source.tar`, and the build receipt as `head-source.json`. The receipt supplies `version`, `sourceSha`, `sourceTarSha256`, `archiveSha256`, and `databaseMigration`.

```sh
bash "$fixture/linux-chromium/run-timings.sh" "$inputs" "$scratch/incumbents" sail-migration-chromium 2 12
bash "$fixture/linux-chromium/run-timings.sh" "$inputs" "$scratch/paired" sail-migration-chromium 2 12 \
  --candidate "$scratch/incumbents/timings.json"
```

The Rust runner rotates which host starts each round and allows one capture at a time. Timing starts at direct navigation and includes all trace steps through screenshot return. Startup and pairing happen before timing. Keep `timings.json` beside its `runs/` directory. The candidate run checks the earlier report against its samples and screenshots. The result passes only when the candidate meets both the 15% and 2 s limits against each published install in both series.

The [comparison for `87ca7814`](observations/served-chromium-linux/migration-head-87ca7814/receipt.json) records 5,560 changed composer pixels from the Poteto control and the Showcase shift. Both published installs matched each other. The historical runner read the final composer controls after timing. The candidate passed the paired timing comparisons and exceeded both limits against the earlier incumbent-only series. All three paired p95s came from the same round, so timing qualification remains open for this profile.

## Capture the settled Firefox replay

### Linux

Run the published Linux arm64 CLI archive twice under separate scratch homes with copies of the seeded database. Pair a fresh Firefox ESR profile to each server under Xvfb. Use the same viewport, Tab action, and pointer position as the Chromium capture. Record the installed Firefox version from GeckoDriver. The [Linux Firefox receipts](observations/served-firefox-linux/settled) contain both matching captures and the installed package versions.

Both installs of the Linux arm64 archive built at `03c866c2` matched the published reference on the first capture of the settled chat with no provider configured. Subsequent captures also showed a sync status, a scroll offset, or reply hover controls across the incumbent and candidate installs. The [first comparisons](observations/served-firefox-linux/migration-head-03c866c2/first-round-comparisons.json) and [incomplete timing runs](observations/served-firefox-linux/migration-head-03c866c2/repeat-receipt.json) retain those outcomes.

Use the paired runner in a disposable Debian arm64 environment with Firefox ESR 153.8.0, GeckoDriver 0.36.0, DejaVu fonts, Xvfb, xdotool, Pillow, and Python's `websocket-client`. Provide the published and locally built archives and the seed database and settings from a scratch fixture. The runner uses one fresh Firefox profile and WebDriver session across four separate loopback origins, each with an independent server home. The measured navigations use that profile after two warmups.

```sh
xvfb-run -a --server-args="-screen 0 1920x1400x24" \
  python3 tests/migration/incumbent/firefox-capture.py \
  --incumbent-archive "$published_archive" --candidate-archive "$candidate_archive" \
  --candidate-sha "$candidate_commit" --seed "$seed_database" --settings "$seed_settings" \
  --thread-id "$seed_thread_id" --out "$new_capture_dir"
```

The runner waits for the thread's v2 synchronization marker and highlighted transcript, then focuses **Attach files** and settles the transcript at the end of its scroll range. It checks synchronization and geometry again after rendering and after the screenshot. The timer starts at WebDriver navigation and ends when the screenshot arrives. Setup, pairing, and the recorded composer control check run outside that interval. Each install has two warmups and 24 measured rounds by default.

The synchronized run captured 104 identical PNGs and action traces across the two published and two candidate installs. Incumbent p95 was 2.886 and 3.248 seconds. Candidate p95 was 2.910 and 2.655 seconds, within both limits against each incumbent. The four copies shared the light English 640 × 600 CSS-pixel profile at scale 2 and a saved conversation with no configured provider. [Comparisons and raw timing samples](observations/served-firefox-linux/migration-head-03c866c2/synchronized)

### macOS

Use stock Firefox 161.0 and GeckoDriver 0.36.0 with Pillow and Python's `websocket-client`. Pass the two installed macOS arm64 bundles and the seed database and settings from a scratch fixture. The runner starts four packaged servers and four headless Firefox instances. Each has its own home, cookie session, and profile. On macOS 27, the runner uses `MOZ_APP_DATA` to keep Firefox's application data in the scratch directory. It selects non-overlay scrollbars so fading scrollbars do not change the capture.

```sh
python3 tests/migration/incumbent/firefox-capture.py \
  --incumbent-bundle "$published_app" --candidate-bundle "$candidate_app" \
  --browser-binary "$firefox_app/Contents/MacOS/firefox" --browser-version 161.0 \
  --candidate-sha "$candidate_commit" --seed "$seed_database" --settings "$seed_settings" \
  --thread-id "$seed_thread_id" --out "$new_capture_dir"
```

The [macOS Firefox captures](observations/served-firefox-macos/settled) use the light English 640 × 600 CSS-pixel profile at scale 2, with Replay configured. The timer and rotation use the same boundaries as Linux.

## Capture the settled Electron replay on macOS

1. Launch two copies of the published app with separate scratch homes, each populated from the same seeded database backup. Give each copy its own server port and pass `--remote-debugging-address=127.0.0.1 --remote-debugging-port=<fixture-port>` to the app executable. Use DevTools only for these test windows.
2. Open **Compatibility replay**. Use a window of 1100 × 780 points at display scale 2, zoom 1, English, and the dark theme with standard motion. Close both side panels. Move keyboard focus out of the composer and hover the reply at window point `(570, 543)`.
3. Run `node tests/migration/incumbent/settled-replay-electron.mjs "$devtools_port"` to verify the settled transcript and reply actions. Capture the whole window with `swift tests/migration/capture-macos.swift "$fixture_pid" "$capture_dir/capture.png"`. Keep the windows on the same display and take a new screenshot for each sample.
4. For timing, activate each already-loaded window, hover the reply, run the probe, and take the screenshot. Run hosts in turn for each round and retain two warmups and twelve measured rounds per host.

The [Electron comparisons](observations/electron-macos-arm64/settled-hover/comparisons.json) record zero changed pixels and trace steps between the two v0.1.17 copies and between v0.1.17 and the [published v0.1.18 build](observations/release-revisions/v0.1.18.json). All 42 samples produced matching PNGs and traces. The [native capture timings](observations/electron-macos-arm64/settled-hover/capture-timings.json) show p95s of 710 and 1,050 ms for the two v0.1.17 copies and 968 ms for v0.1.18. The newer release exceeded the 15% budget against the first incumbent. The screenshot stage took 621 ms in that v0.1.18 sample. This timing covers the already-loaded fixture and includes the macOS screenshot command.

The local macOS package built at `4807bdae` includes the Poteto composer control from trunk. Two v0.1.17 copies matched again. The migration-head package differed by 3,417 pixels in the composer and one control observation. Its capture p95 was 1,085 ms against 1,125 and 544 ms for the incumbent copies. It exceeded the budget against the faster copy. [Package and comparison receipts](observations/electron-macos-arm64/migration-head-4807bdae)

The later package built at `9982ba07` kept protocol 2, applied SQLite migration 119, and passed the published wire fixture. The two separately installed copies of each build matched within their build. Across builds, 3,417 composer pixels and the post-timing Poteto control observation differed. In the rotated capture run, the two incumbent p95s were 1,023 and 559 ms. The two copies of the exact-head package measured 516 and 1,956 ms. The slower copy exceeded the 15% limit against both incumbents and stayed within the 2 s absolute limit. Its slowest sample spent 1,072 ms in the screenshot and geometry stage. [Package, comparisons, and raw timings](observations/electron-macos-arm64/migration-head-9982ba07)

For that four-installation repeat, select **Settings → Appearance → Dark** in each window, open the copied thread, close both panels, and click outside the composer before the warmups. Compile the capture program once with `swiftc -O tests/migration/capture-macos.swift -o "$scratch/capture-macos"`. For each timed sample, activate the window, move the native pointer to `(570, 543)`, call the trace probe with `--blur-composer` before its port argument, and run the compiled capture program with the fixture PID and a fresh PNG path. This probe clears any composer focus restored by activation once before it waits for the settled state. Rotate the order `a, head-a, b, head-b` one position per round and retain two warmups and 12 measured rounds per installation.

The persistent capture retest uses the same window setup and trace probe. Start the [capture process](../README.md#reuse-the-macos-capture-process) before warmups and send it the fixture PID and fresh PNG path at the screenshot stage. Rotate the four installations as before. This retest kept two warmups and 48 measured rounds per installation. A capture-only pilot first verified identical decoded pixels from both screenshot paths. The retest reproduced the decoded reference pixels on all 200 captures and passed the timing limits against both incumbents. The cross-build comparison still differs by 3,417 composer pixels and one control observation. [Pilot, raw samples, and comparisons](observations/electron-macos-arm64/native-capture-session)

## Capture Electron display variants

Open the settled thread in the packaged macOS app. Use **Settings → Appearance** for light and dark modes and **Settings → General → Language** for German. For 120% zoom, choose **View → Actual Size**, then **View → Zoom In** twice. Read the zoom factor from the desktop bridge and keep the physical capture dimensions with the renderer's CSS dimensions. Capture the docked sidebar at 1100 × 780 points and the thread and sidebar sheet at 640 × 780 points. [Display receipts](observations/electron-macos-arm64/display/receipt.json)

## Check approval and client compatibility

The [approval receipt](observations/served-chromium-macos/approval/receipt.json) records the published Chromium client's supervised Replay approval and decline paths, SQLite outcomes, and disabled approval controls in a read-only session. The [version rejection receipt](observations/served-chromium-macos/version-rejection/receipt.json) records the published server's HTTP 426 and the published client's **Update** and **Retry update** states against the [simulated older service](version-rejection/README.md).

## Capture Stop and browser relink

Prepare an isolated published package with the pinned Replay provider. Add the fixture project, then run its CLI with `thread start "$fixture/project" "Ask me something" --provider devReplay --model question --title "Compatibility stop" --json`. Pair a browser through a one-time link labeled for this run and open the new thread. The Question recording keeps the run active until the user answers or stops it.

Close the sidebar and thread details, capture the pending question, then click **Stop generation**. Confirm **Run interrupted · Stopped by user** appears, the composer returns, and `thread show --json` reports the original run as interrupted with no pending request. Keep the paired page open. Use `auth session list --json` to find the scratch browser's labeled cookie session and `auth session revoke` to revoke that session.

Reopen the same thread URL. The published client shows **Pair with this environment** on that fresh visit. Redeem a new link in the same browser profile and reopen the original thread. The [capture receipt](observations/served-chromium-macos/stop-and-relink/receipt.json) records socket closure, rejection of the revoked cookie, and restoration of the same interrupted run. This covers the directly served loopback browser and a Replay run awaiting input.

## Capture read-only chat

Start the scratch server with `T3CODE_ENVIRONMENT_LABEL="Compatibility host"` so the permissions notice shows the fixture name. Seed the Showcase turn, mint a pairing link with `pair --scope orchestration:read`, and open the settled thread. Type **A read-only draft** and press Enter. The composer keeps the draft and Send stays disabled with the accessible label **This connection cannot change threads.**

Use the same browser cookie to request a v2 WebSocket ticket. Read the projection, send the [Replay fixture's message request](../wire/incumbent-replay-v2.json) with a fresh command ID and this thread's ID, and read the projection again. The server returns `EnvironmentAuthorizationError` requiring `orchestration:operate` and preserves one run and three messages. In a separate browser profile with both scopes, the same request succeeds and creates a second run.

The [read-only receipt](observations/served-chromium-macos/read-only-chat/receipt.json) records the published and candidate behavior. The candidate shows the Poteto control alongside the disabled Send action. The whole-window comparison records 3,478 changed composer pixels and 219 changed pixels from the independently seeded runs' elapsed-time labels.

## Capture the reading position and empty thread

On the published scratch host, start a Replay **Multi turn** thread with **Start**. Submit the [70-sentence reading fixture](../../../scripts/scenarios/side-panel-preserves-reading-position.e2e.ts) through the browser composer and wait for **second fixture turn complete**. Create an empty thread using the Replay wire fixture's `thread.create` request. Use a different thread ID and title and leave its transcript empty. Back up this SQLite state for the candidate host.

In the long thread, close the sidebar and details, expand the full user message, and position character 2,500 at 48 CSS pixels from the timeline's top. Open the right panel and check the same character and active control. In the empty thread, focus the composer and check the empty hint and zero saved runs and messages.

The [reading position receipt](observations/served-chromium-macos/reading-position/receipt.json) records Browser panel actions and two full-resolution Chromium captures per state and build. The anchor stayed at 47.75 CSS pixels across the panel transition, and the empty composer kept focus. The cross-build images differ by 3,170 pixels in the composer row where Poteto shifts the model control.

## Capture hosted HTTPS pairing

Build the web client at the release tag with `VITE_HOSTED_APP_CHANNEL=latest` and `VITE_HOSTED_APP_URL` set to the hosted fixture's HTTPS origin. Serve the static assets with an index fallback for application routes. Expose the isolated installed backend on a second HTTPS origin with HTTP and WebSocket forwarding. Keep the backend's CORS responses and forward the public host and scheme.

Mint a one-time link with `pair --scope orchestration:read`. Observe request starts and WebSocket connections to the backend before opening the hosted `/pair` route. Pass the backend origin as `host` and the pairing token in the fragment. Verify **Add this backend?** names the backend. Capture the dialog and confirm that the browser has started zero backend requests before clicking **Add backend**. Open the seeded thread and reload it. Check that the same DPoP session remains active and a fresh browser context cannot redeem the used link.

The [hosted pairing receipt](observations/hosted-chromium-macos/approved-pairing/receipt.json) records the two loopback HTTPS fixture origins, the confirmation and thread screenshots, and the sanitized exchange through WSS. The official hosted deployment identity remains open.

## Capture the bundled desktop connection and thread link

1. Back up a seeded Replay database with zero active sessions. Copy the backup, `environment-id`, and Replay `settings.json` into `state/userdata` in a new scratch home per launch.
2. Use the isolated launch environment from the seed procedure. Set `T3CODE_PORT` to a free loopback port and pass `sail://threads/<environment-id>/<encoded-thread-id>` as an argument to the installed executable. Set the window to 1100 × 780 points on a 2× display in dark mode.
3. Use `lsof -nP -iTCP:<port> -sTCP:LISTEN` and `ps` to check that the listener is a child of the app. Read the environment descriptor and check protocol 2 and the `desktop-managed` update capability. Use the packaged CLI to list sessions in the scratch home and check for the new desktop bearer session.
4. Verify **Compatibility replay** opens with its saved reply and the composer focused. Capture the whole window with [the macOS capture tool](../capture-macos.swift). Check that the copied database retains the original run and messages.

The [desktop activation comparison](observations/electron-macos-arm64/local-activation/comparison.json) records one launch per build. The launch traces match. The screenshots differ by 3,485 pixels, including the candidate's Poteto control and the shifted Showcase control.

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

# Capture the published Sail baseline

Use the [release inventory](release-inventory.json) to select the asset and check its SHA-256. The published captures use the v0.1.17 macOS arm64 ZIP and its bundled server. The settled Chromium replay is repeatable in one display profile. The [coverage catalog](coverage-catalog.json) keeps the remaining chat states and profiles open.

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

The [run receipt](observations/run.json) records the installer, wire, and SQLite checks. Use the [launcher and runtime probe](runtime/README.md) to reproduce the installed package's startup and capability observations.

# Capture the published Sail baseline

Use the [release inventory](release-inventory.json) to select the asset and check its SHA-256. The captures here use the v0.1.17 macOS arm64 ZIP and its bundled server. The [observations](observations) are provisional. The Chromium captures match in behavior and differ by 169 pixels. The desktop capture records one run. Keep the `chat-turn` parity gate open for both surfaces.

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

On desktop, select **Compatibility replay** and read its reply before taking the window capture. For served web, pair to the isolated host in the Browser panel. Open the thread by its direct URL and wait for `This turn is a replay.` Click the thread heading to clear composer focus before capturing. The fixture's two Chromium observations used a 640 × 600 CSS viewport at scale 2 and zoom 1.

The [run receipt](observations/run.json) records the installer, wire and SQLite checks. The [coverage catalog](coverage-catalog.json) records the remaining comparison, platform and performance requirements.

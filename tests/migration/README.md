# Sail migration fixtures

The [release inventory](incumbent/release-inventory.json) pins the compatibility reference to Sail v0.1.17. The [coverage catalog](incumbent/coverage-catalog.json) lists the cases required by the migration plan. The [wire fixture](wire/README.md) checks HTTP protocol alignment and Effect RPC frames against a running server.

## Record a visual and behavior capture

1. Use an isolated home and the pinned release, or the candidate at the exact SHA under review. For a Replay fixture, build the state through the CLI or API so the runtime writes its own events and projections.
2. Reproduce the reference profile and run the same actions in order. Use the Browser panel for web. On macOS, use the actual desktop window and capture it by the PID of the fixture app that you started.

   ```sh
   swift tests/migration/capture-macos.swift "$app_pid" "$capture_dir/capture.png"
   ```

3. Save `receipt.json` beside `capture.png`. Record `schemaVersion` as `1`, the catalog `fixtureId`, the full `sourceSha`, and the actual `client` and `server` implementations. Include the `profile` with `surface`, `platform`, `browser`, `origin`, `locale`, `theme`, `motion`, `fonts`, and `viewport`. For `desktop`, record the renderer in `client` and set `browser` to `null`. List the pinned fonts in order. The `viewport` holds `width` and `height` in CSS pixels or window points, its effective device `scale`, and the `zoom` multiplier. Save screenshots at the physical dimensions implied by the width, height, and scale. Use the same profile values for both implementations within a comparison.
4. Set `trace` to the ordered array of `{ "action": "…", "observed": { … } }` steps. Record visible behavior and relevant server outcomes. Use stable names for fixture entities, and keep tokens and random identifiers out of the trace. Set `screenshotSha256` to the value printed by `python3 tests/migration/compare.py digest "$capture_dir/capture.png"`.

## Compare two captures

Use Python 3.11 or newer and Pillow. Pass the two capture directories and both expected commit SHAs.

```sh
python3 tests/migration/compare.py compare "$reference" "$candidate" \
  --baseline-sha "$reference_sha" --candidate-sha "$candidate_sha" \
  --diff "$evidence_dir/diff.png"
```

The command reports pixel differences and the positions of changed, added, or missing trace steps. Exit code `1` means a difference. Exit code `2` means the inputs could not be compared. The diff path must be new, so each check can retain its result. Compare a capture against its own surface and display profile.

Run the negative controls with `python3 -m unittest discover -s tests/migration -p 'test_*.py'`.

## Reuse the macOS capture process

For repeated native captures on macOS 14.2 or later, compile the
[ScreenCaptureKit driver](capture-macos-session.swift) with
`swiftc -parse-as-library -O tests/migration/capture-macos-session.swift -o "$scratch/capture-macos-session"`.
Start it once and wait for `ready` on stdout. For each capture, send one line of JSON
with the owned app's PID in `processID` and an unused absolute PNG path in `output`.
Read one JSON line after each request. It contains the window size in points and pixels
and the elapsed frame and PNG encoding times. Keep one request in flight and close stdin
after the last capture.

Use the same capture driver for every installation compared in a timing run. Verify
geometry and decoded pixels against the existing reference before changing the driver
for a profile. Record which processes start inside the timed interval and retain
separate durations for activation, trace, and screenshot.

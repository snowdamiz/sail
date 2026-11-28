# Sail GPUI preview

This is the fixed project, thread, and composer fixture for P02 of the [Rust migration plan](../../docs/plans/sail-rust-gpui-migration.md). The fixture runs in its own process or browser document and uses in-memory data.

## Run the preview

Install [rustup](https://rustup.rs/) and run these commands from `native/sail-client`. Cargo selects the pinned toolchain in this directory.

```sh
cargo test --locked
cargo run --locked
```

On Linux, install the Fontconfig, XKB, and Wayland development packages and use a desktop with a supported graphics backend. See the native job in the [preview workflow](../../.github/workflows/gpui-preview.yml) for the packages on Ubuntu. On macOS, GPUI compiles the Metal shaders at runtime.

Build the browser page with the version of `wasm-bindgen-cli` in `Cargo.lock`. Set `WASM_BINDGEN` to its executable if it is outside your path.

```sh
./build-web.sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory target/preview
```

Open `http://127.0.0.1:8765/`. The browser tries WebGPU first, then WebGL2. To run one backend, use `?backend=webgpu` or `?backend=webgl`. When serving the fixture separately from Sail, append `incumbent` with its loopback HTTP or HTTPS URL to exercise the **Open Sail** link. The standalone preview shows that link when the URL is configured.

## Capture verification receipts

Run the drivers from the repository root. Use a fresh output directory for each run.

- Build the native executable. On macOS, run `swift tests/migration/gpui/native-macos.swift SAIL_CLIENT OUT --close-reopen` with Accessibility and Screen Recording access. On Linux, run `python3 tests/migration/gpui/native-linux.py SAIL_CLIENT OUT --close-reopen` in an X11 desktop session with AT-SPI, PyGObject, xdotool, ImageMagick, and wmctrl. Replace `SAIL_CLIENT` with the executable path, such as `native/sail-client/target/debug/sail-client`. The drivers launch the fixture and check its exit status.
- Start ChromeDriver for Chromium or GeckoDriver for Firefox. Run `python3 tests/migration/gpui/browser-verify.py --help` for browser, viewport, scale, and fallback options. Capture both forced backends with matching browser, viewport, and scale before comparing.
- Install Pillow in your test environment. Run `python3 tests/migration/gpui/compare-pixels.py compare WEBGPU.png WEBGL.png --diff DIFF.png` for exact pixel equality. Run `python3 tests/migration/gpui/compare-pixels.py control BASELINE.png --out OUT` to check that a deliberate pixel change fails.

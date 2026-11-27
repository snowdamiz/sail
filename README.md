<p align="center">
  <img src="assets/prod/logo.svg" alt="Sail" width="84" height="84" />
</p>

<h1 align="center">Sail</h1>

<p align="center">
  Unified agentic coding desktop workspace combining T3 Code and Boat remote cloud sandboxes in a single repository and desktop app.
</p>

## What Sail Includes

- **Single Desktop App**: Runs the local Sail server, web workspace, and the native Rust `sail-boatd` remote sandbox engine inside one Electron application. No separate external T3 Code or T3 Boat app is required.
- **Built-in Boats Workspace (`/boats`)**: Provision, warm, sleep, wake, pair, and manage ephemeral Boat cloud machines directly inside Sail with the animated ocean status header, live health/pairing proxy, and MCP bridge (`SAIL_MCP_PORT=47731`).
- **Isolated Runtime**: Uses `~/.sail` (overridable via `SAIL_HOME` or `T3CODE_HOME`), `sail://` / `sail-dev://` protocol links, and `com.sail.desktop` app identity so Sail runs side-by-side without colliding with other T3 Code or Acid installs.
- **Unsigned macOS CLI Install & Auto-Update**: Builds ad-hoc signed macOS `.zip` and `.dmg` archives with `SHA256SUMS` and `install-desktop.sh`, stripping macOS quarantine attributes on install and supporting in-app unsigned archive updates without Apple Developer signing credentials.

## Install on macOS via CLI (No App Signing Required)

Install the latest release from GitHub Releases directly to `~/Applications/Sail.app` and `~/.local/bin/sail`:

```sh
curl -fsSL https://github.com/snowdamiz/sail/releases/latest/download/install-desktop.sh | sh
```

Or install from this repository's public installer script:

```sh
curl -fsSL https://raw.githubusercontent.com/snowdamiz/sail/main/scripts/public-install-desktop.sh | sh
```

Then launch Sail from Terminal or Spotlight:

```sh
sail
```

## Run Sail on Fly.io

Deploy your own always-on server and connect Sail from another device. See [Run a Sail server on Fly.io](docs/user/self-host-fly.md).

## Development

### Prerequisites

- Node.js 24+ and `vp` / `pnpm`
- Rust toolchain (`cargo`, `rustc`) for `native/sail-boat` and `native/resource-monitor`

### Install dependencies

```sh
vp install
```

### Build native Rust sidecars

```sh
cargo build --release --manifest-path native/sail-boat/Cargo.toml
cargo build --release --manifest-path native/resource-monitor/Cargo.toml
```

### Run checks and tests

```sh
vp run icons:check
vp run typecheck
vp test run
cargo test --manifest-path native/sail-boat/Cargo.toml
```

### Package unsigned macOS desktop archive locally

```sh
vp run build:desktop
vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --skip-build
vp exec tsx scripts/build-desktop-installers.ts --release-dir release
```

---
name: deploy-sail
description: Deploy or upgrade a personal Sail server on Fly.io, pair another device, or request a volume snapshot using deploy/fly/deploy.sh.
---

Use [the Fly deployment guide](../../../docs/user/self-host-fly.md) for prerequisites, pricing, and recovery. Run the script from the user's Sail checkout with their chosen app name.

- A Fly.io Sail server runs as a **control plane** (`SAIL_LOCAL_SESSIONS=off`, `shared-cpu-1x` / `1 GB` RAM / `3 GB` volume): it manages **Boats**, synced preferences, device access, and synced provider credentials (`Settings → Providers`), and does **not** run coding sessions, local projects, or local terminals on the Fly VM. Mention that coding sessions run on Boat machines (set up during onboarding or from **Boats**) or on a paired Local computer.
- Deploy or upgrade with `deploy/fly/deploy.sh --app NAME`. Pass the requested `--region`, `--image`, `--build`, or `--password-file` when deploying.
- Use `--pair` for fresh pairing links from a running deployment and `--snapshot` to request a volume snapshot.
- Use `--dry-run` when the user asks for a preview.
- If the script reports a Fly authentication failure, stop and ask the user to run `fly auth login` in their own terminal. Resume after they confirm.
- On a fresh deploy (or an upgrade where no password is configured yet), the script stages a generated `SAIL_INITIAL_OWNER_PASSWORD` Fly secret and prints `Sail URL:` and `Initial password:` along with pairing links. Hand the **Sail URL** (`https://NAME.fly.dev`) and **Initial password** (in inline code) directly back to the requesting user in your reply so they can sign in right away in any browser with no pairing token or 5-minute expiry.
- If you also share the `sail://` desktop pairing link, render it as inline code rather than a Markdown hyperlink (many chat clients strip custom URL schemes from Markdown links), and include the HTTPS pairing link as well. Keep the initial password, pairing links, and QR code out of shared logs, commits, PRs, screenshots, and public reports.
- Tell the user the initial password works immediately for future sign-ins and can be changed anytime in **Settings → Sharing & access** (or reset later using `--pair` if forgotten). Never ask the user to paste their own personal password into chat; point them to `--password-file` if they want to supply one from a local file.

## First-Time Setup: Desktop App GitHub Release

When a user has cloned or forked this repository and is setting up Sail for the first time, check existing GitHub releases first (`gh release list -L 3`) and **ask the user** whether they want you to run a GitHub release of Sail so they can download the desktop app. Do **not** trigger a release automatically without asking, because a release may already be published.

- If a release already exists, show them the latest release URL and desktop install command (`curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install-desktop.sh | sh`) and ask whether they want to use it or publish a fresh release.
- If the user asks you to run a release, trigger [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) via `gh workflow run release.yml --ref main` (optionally passing `-f version=<version>`) or by pushing a `v<version>` tag (`git tag v<version> && git push origin v<version>`).
- Once the release workflow publishes the GitHub release, give the user the GitHub Releases link (`https://github.com/<owner>/<repo>/releases/latest`) and the `install-desktop.sh` download command (`curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install-desktop.sh | sh`) so they can install the Sail desktop app right away.

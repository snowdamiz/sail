---
name: deploy-sail
description: Deploy or upgrade a personal Sail server on Fly.io, pair another device, or request a volume snapshot using deploy/fly/deploy.sh.
---

Use [the Fly deployment guide](../../../docs/user/self-host-fly.md) for prerequisites, pricing, and recovery. Run the script from the user's Sail checkout with their chosen app name.

- Deploy or upgrade with `deploy/fly/deploy.sh --app NAME`. Pass the requested `--region`, `--image`, `--build`, or `--password-file` when deploying.
- Use `--pair` for fresh pairing links from a running deployment and `--snapshot` to request a volume snapshot.
- Use `--dry-run` when the user asks for a preview.
- If the script reports a Fly authentication failure, stop and ask the user to run `fly auth login` in their own terminal. Resume after they confirm.
- On a fresh deploy (or an upgrade where no password is configured yet), the script stages a generated `SAIL_INITIAL_OWNER_PASSWORD` Fly secret and prints `Sail URL:` and `Initial password:` along with pairing links. Hand the **Sail URL** (`https://NAME.fly.dev`) and **Initial password** (in inline code) directly back to the requesting user in your reply so they can sign in right away in any browser with no pairing token or 5-minute expiry.
- If you also share the `sail://` desktop pairing link, render it as inline code rather than a Markdown hyperlink (many chat clients strip custom URL schemes from Markdown links), and include the HTTPS pairing link as well. Keep the initial password, pairing links, and QR code out of shared logs, commits, PRs, screenshots, and public reports.
- Tell the user the initial password works immediately for future sign-ins and can be changed anytime in **Settings → Sharing & access** (or reset later using `--pair` if forgotten). Never ask the user to paste their own personal password into chat; point them to `--password-file` if they want to supply one from a local file.

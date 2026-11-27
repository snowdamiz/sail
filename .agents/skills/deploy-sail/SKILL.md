---
name: deploy-sail
description: Deploy or upgrade a personal Sail server on Fly.io, pair another device, or request a volume snapshot using deploy/fly/deploy.sh.
---

Use [the Fly deployment guide](../../../docs/user/self-host-fly.md) for prerequisites, pricing, and recovery. Run the script from the user's Sail checkout with their chosen app name.

- Deploy or upgrade with `deploy/fly/deploy.sh --app NAME`. Pass the requested `--region`, `--image`, `--build`, or `--password-file` when deploying.
- Use `--pair` for fresh pairing links from a running deployment and `--snapshot` to request a volume snapshot.
- Use `--dry-run` when the user asks for a preview.
- If the script reports a Fly authentication failure, stop and ask the user to run `fly auth login` in their own terminal. Resume after they confirm.
- On a fresh deploy (or an upgrade where no password is configured yet), the script sets a generated `SAIL_INITIAL_OWNER_PASSWORD` Fly secret and prints `Sail URL:` and `Initial password:` along with pairing links. Hand the **Sail URL** (`https://NAME.fly.dev`) and **Initial password** directly back to the requesting user in your reply so they can sign in right away in any browser with no pairing token or 5-minute expiry. Also pass along the `sail://` link if they want to pair Sail Desktop directly. Keep the password, pairing links, and QR code out of shared logs, commits, PRs, screenshots, and public reports.
- Tell the user they can change the sign-in password anytime in **Settings → Sharing & access**. They can use `--pair` if they ever need to recover access and reset it. Never ask the user to paste their own personal password into chat.

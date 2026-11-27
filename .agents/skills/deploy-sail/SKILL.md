---
name: deploy-sail
description: Deploy or upgrade a personal Sail server on Fly.io, pair another device, or request a volume snapshot using deploy/fly/deploy.sh.
---

Use [the Fly deployment guide](../../../docs/user/self-host-fly.md) for prerequisites, pricing, and recovery. Run the script from the user's Sail checkout with their chosen app name.

- Deploy or upgrade with `deploy/fly/deploy.sh --app NAME`. Pass the requested `--region`, `--image`, or `--build` when deploying.
- Use `--pair` for fresh links from a running deployment and `--snapshot` to request a volume snapshot.
- Use `--dry-run` when the user asks for a preview.
- If the script reports a Fly authentication failure, stop and ask the user to run `fly auth login` in their own terminal. Resume after they confirm.
- When the script returns two links, hand both back privately to the requesting user. Label the `sail://` link for desktop and the HTTPS link for a browser or phone. Each link works once. Keep the output, including the QR code, out of shared logs, screenshots, and reports.

- The owner’s first HTTPS pairing opens Settings → Sharing & access to set a 15–256 character browser sign-in password. They can use `--pair` again to recover access and change it. Never ask for their password.

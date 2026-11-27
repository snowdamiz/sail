# Run a Sail server on Fly.io

A personal Sail server keeps running when you close Sail or turn off your
computer. It stores threads, files, settings, and provider sign-ins on a Fly
volume mounted at `/data`.

## Deploy

Install [flyctl](https://docs.fly.io/flyctl/install), make sure Bash and
`curl` are available, and sign in to your Fly account with `fly auth login`.
From a Sail checkout, run the following command with an app name available on
Fly.io. To select a region for the new volume, add `--region` with a
[Fly region code](https://docs.fly.io/reference/regions).

```bash
deploy/fly/deploy.sh --app my-sail
```

The script starts one Machine and creates a 10 GB volume. When Sail is ready,
the script opens a pairing prompt in the desktop app if you run it in a terminal
on a computer with Sail installed. Confirm the address in Sail. Use the
separate HTTPS link to sign in from a browser, or scan its QR code with your
phone. Each link works once. Keep both links and the QR code private.

The script uses the image for the latest published Sail release. Use
`--image IMAGE` to pick a specific image that supports Fly deployment. Include
the registry host for a remote image, such as `ghcr.io/snowdamiz/sail-server`.
An image name without a slash uses your local Docker daemon. Use `--build` to
build the checkout on Fly's remote builder. Add `--dry-run` to preview your
command without contacting Fly or GitHub.

## Sign in to providers

Open the in-app terminal on your Fly environment and sign in where your
agents will run. For Claude, run `claude auth login` and follow the browser
instructions. For Codex, run `codex login --device-auth` and follow its
device-code instructions. Then select the provider when you start a thread.

## Add another device

Request fresh links without restarting Sail.

```bash
deploy/fly/deploy.sh --app my-sail --pair
```

On mobile, use **Add environment** and paste the HTTPS pairing link or scan
its QR code. To revoke a device, open **Settings → Sharing & access** on the
server. See [Remote access](./remote-access.md) for more about device access.

## Share preferences

When the browser and Sail Desktop use the same main server, settings such as
code font size and diff layout follow you between them. Edits made offline sync
when you reconnect. Browser viewport and desktop quit confirmation stay on
each device. If you upgraded with Sail Desktop's Local environment already off,
choose your saved server under **Settings → General → Main server**.

Turn off **Use the same preferences on every device** under **Settings → General**
to keep future edits on that device. Turning sync off or removing the main
server keeps your current preferences.

## Upgrade

Run the original deployment command again. It reuses your volume in its
existing region and deploys the latest release. Pass `--image` again if you want
to upgrade to a specific image. The server can be briefly unavailable during
the upgrade. Paired devices can reconnect using their existing sessions.

## Back up and restore

Fly takes daily snapshots and keeps them for five days by default. Request an
on-demand snapshot before an upgrade or maintenance.

```bash
deploy/fly/deploy.sh --app my-sail --snapshot
fly volumes list --app my-sail
fly volumes snapshots list VOLUME_ID --app my-sail
```

To restore in the same app, choose a completed snapshot. Use the original
volume's region and a size at least as large as the original volume. The
example assumes a 10 GB volume in `iad` and a restore target named
`sail_restore`. Keep an independent backup of data you cannot lose.
[Fly volume restore reference](https://docs.fly.io/volumes/volume-manage/#restore-a-deleted-volume)

1. Restore the snapshot to a new volume. Keep the original volume so you
   can switch back if needed.

   ```bash
   fly volumes create sail_restore --app my-sail --region iad --size 10 --snapshot-id SNAPSHOT_ID
   ```

2. Set `source = "sail_restore"` in the `[[mounts]]` section of
   `deploy/fly/fly.toml` and keep `destination = "/data"`.
3. Find the old Machine with `fly machine list --app my-sail`. Stop and
   destroy that Machine with `--force`. This interrupts running turns. The
   volume stays in the app and is available for rollback.

   ```bash
   fly machine destroy MACHINE_ID --app my-sail --force
   ```

4. Deploy with the image that created the snapshot. Pair a client if needed,
   then check your threads, attachments, and settings. Keep the new mount
   source in your deployment config for future upgrades and snapshots.

   ```bash
   deploy/fly/deploy.sh --app my-sail --image IMAGE
   ```

## Cost and removal

The default Machine runs continuously with two shared CPUs and 4 GB of RAM.
Fly bills for compute, the 10 GB provisioned volume, snapshot storage, and
network usage. Use the region where you plan to deploy to estimate your bill.
[Fly pricing calculator](https://fly.io/calculator/)

To stop billing for the app, first copy any data you want to keep, then destroy
the app. This deletes its Machine and volumes.

```bash
fly apps destroy my-sail
```

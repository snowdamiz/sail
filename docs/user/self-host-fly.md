# Run a Sail server on Fly.io

A personal Sail server on Fly.io is an always-on **control plane** that stays
online when you close Sail or turn off your computer. It manages **Boats**,
synced preferences, device access, and synced provider credentials on a Fly
volume mounted at `/data`.

Coding sessions, local projects, and terminals do **not** run on the Fly VM
itself (`SAIL_LOCAL_SESSIONS=off`). Run coding sessions on **Boat** cloud
machines managed from the Fly server or on a **Local** computer paired with
Sail.

## Deploy

Install [flyctl](https://docs.fly.io/flyctl/install), make sure Bash and
`curl` are available, and sign in to your Fly account with `fly auth login`.
From a Sail checkout, run the following command with an app name available on
Fly.io. To select a region for the new volume, add `--region` with a
[Fly region code](https://docs.fly.io/reference/regions).

```bash
deploy/fly/deploy.sh --app my-sail
```

The script starts one lightweight Machine, creates a 3 GB volume, and stages a
generated initial sign-in password in Fly secrets
(`SAIL_INITIAL_OWNER_PASSWORD`) before booting the server. Open the printed
**Sail URL** (`https://my-sail.fly.dev`) in any browser and sign in with the
printed **Initial password** — no pairing token or local command is needed. To
supply your own 15–256 character initial password instead of generating one, pass
`--password-file FILE`.

When run in a local terminal with Sail Desktop installed, the script also opens
a pairing prompt in the desktop app and prints one-time desktop/browser pairing
links and a QR code. Keep the initial password, pairing links, and QR code
private.

The script uses the image for the latest published Sail release. Use
`--image IMAGE` to pick a specific image that supports Fly deployment. Include
the registry host for a remote image, such as `ghcr.io/snowdamiz/sail-server`.
An image name without a slash uses your local Docker daemon. Use `--build` to
build the checkout on Fly's remote builder. Add `--dry-run` to preview your
command without contacting Fly or GitHub.

## Owner sign-in password

Fresh Fly deployments boot with password sign-in already configured via
`SAIL_INITIAL_OWNER_PASSWORD`, so visiting `https://my-sail.fly.dev` opens
directly to **Sign in to Sail**. You can use the same HTTPS URL and password
in Sail Desktop from the welcome screen (**Sign in to your server**) or under
**Settings → Environments → Add environment → Password**.

Once signed in from the server's web app, you can change the password anytime
in **Settings → Sharing & access** (15–256 characters). Your updated password
is stored on the `/data` volume and is preserved across restarts and upgrades
even while `SAIL_INITIAL_OWNER_PASSWORD` remains set in Fly secrets.

If you forget your password, request fresh pairing links using the command under
[Add another device](#add-another-device), open the HTTPS link, and change the
password in Sharing & access. Changing your password signs out every browser
and Sail Desktop session that signed in using the password, including the
current browser if it used that password. Independently paired devices stay
signed in. Desktop and mobile can also pair from **Settings → Sharing & access**
(using **Open in Sail desktop** or a new pairing link) or with `--pair`.

## Connect a Boat machine

On first visit, Sail walks you through setting up **Boats** directly from the
welcome screen: install/sign in to Boat if needed, connect an existing Boat
machine, or launch a new one from **Boats**.

You can also open **Boats** anytime from your browser or Sail Desktop while
connected to your Fly server. If you have several servers, choose your Fly
server in **Boats server**. On a machine's row, choose **Add to Sail** (or
**Connect**) and confirm its Boat HTTPS address. Your client saves a direct
connection to that Boat machine, where your projects, terminals, and coding
sessions run.

When an added machine is asleep, open **Boats** on the Fly server and choose
**Wake now** on the machine's row. Open a thread from the machine's details
or go back to its environment. To revoke a device's access to a Boat machine,
use **Settings → Sharing & access** on the Boat machine.

If Boat restores the machine from a snapshot at a new address, use
**Add to Sail again** from the machine's menu to save its new address.

## Sync provider credentials to Boats

Manage provider API keys and supported OAuth sign-ins (such as Codex ChatGPT
sign-in) in **Settings → Providers** on your Fly server (or during onboarding).
Configured provider credentials sync down to your Boat machines automatically so
you do not need to manage agent CLIs on each Boat by hand.

## Add another device

Request fresh links without restarting Sail.

```bash
deploy/fly/deploy.sh --app my-sail --pair
```

On Sail Desktop, sign in directly with your HTTPS server address and owner
password under **Add environment → Password**, or open the desktop pairing link.
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
example assumes a 3 GB volume in `iad` and a restore target named
`sail_restore`. Keep an independent backup of data you cannot lose.
[Fly volume restore reference](https://docs.fly.io/volumes/volume-manage/#restore-a-deleted-volume)

1. Restore the snapshot to a new volume. Keep the original volume so you
   can switch back if needed.

   ```bash
   fly volumes create sail_restore --app my-sail --region iad --size 3 --snapshot-id SNAPSHOT_ID
   ```

2. Set `source = "sail_restore"` in the `[[mounts]]` section of
   `deploy/fly/fly.toml` and keep `destination = "/data"`.
3. Find the old Machine with `fly machine list --app my-sail`. Stop and
   destroy that Machine with `--force`. The volume stays in the app and is
   available for rollback.

   ```bash
   fly machine destroy MACHINE_ID --app my-sail --force
   ```

4. Deploy with the image that created the snapshot. Pair a client if needed,
   then check your settings, Boats setup, and provider sync configuration. Keep
   the new mount source in your deployment config for future upgrades and
   snapshots.

   ```bash
   deploy/fly/deploy.sh --app my-sail --image IMAGE
   ```

## Cost and removal

Because coding sessions run on Boat machines rather than the Fly VM, the
default Machine runs continuously with one shared CPU and 1 GB of RAM. Fly bills
for compute, the 3 GB provisioned volume, snapshot storage, and network usage.
Use the region where you plan to deploy to estimate your bill.
[Fly pricing calculator](https://fly.io/calculator/)

To stop billing for the app, first copy any data you want to keep, then destroy
the app. This deletes its Machine and volumes.

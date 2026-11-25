// @effect-diagnostics nodeBuiltinImport:off - Drives the fake `fly` CLI and the Docker it manages.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { caddyDirInUse, publicUrl, removeSite, rootCertPath } from "./lib/caddy.ts";
import { docker, exists, hasDocker } from "./lib/docker.ts";

// Key lists copied from flyctl v0.4.123 and fly-go v0.11.6 (`fly.App` has no JSON tags).
const APP_KEYS = [
  "ID",
  "InternalNumericID",
  "Name",
  "State",
  "Status",
  "Deployed",
  "Hostname",
  "AppURL",
  "Version",
  "NetworkID",
  "Network",
  "Release",
  "Organization",
  "Secrets",
  "CurrentRelease",
  "Releases",
  "IPAddresses",
  "EgressIpAddresses",
  "SharedIPAddress",
  "CNAMETarget",
  "IPAddress",
  "Certificates",
  "Certificate",
  "PostgresAppRole",
  "Image",
  "ImageUpgradeAvailable",
  "ImageVersionTrackingEnabled",
  "ImageDetails",
  "LatestImageDetails",
  "PlatformVersion",
  "Machines",
  "CurrentLock",
];
const ORGANIZATION_KEYS = [
  "ID",
  "InternalNumericID",
  "Name",
  "RemoteBuilderImage",
  "RemoteBuilderApp",
  "Slug",
  "RawSlug",
  "Type",
  "PaidPlan",
  "Billable",
  "Settings",
  "AllowedReplaySourceOrgSlugs",
  "AllowAllCrossNetworkReplays",
  "WireGuardPeer",
  "WireGuardPeers",
  "DelegatedWireGuardTokens",
  "LoggedCertificates",
];
const RELEASE_KEYS = [
  "ID",
  "Version",
  "Stable",
  "InProgress",
  "Reason",
  "Description",
  "Status",
  "DeploymentStrategy",
  "Metadata",
  "User",
  "EvaluationID",
  "CreatedAt",
  "ImageRef",
];
// `fly.Volume` tags; `required_host_features` and `host_features` are omitempty and empty here.
const VOLUME_KEYS = [
  "id",
  "name",
  "state",
  "size_gb",
  "region",
  "zone",
  "encrypted",
  "attached_machine_id",
  "attached_alloc_id",
  "created_at",
  "host_dedication_id",
  "snapshot_retention",
  "auto_backup_enabled",
  "host_status",
];
const SNAPSHOT_KEYS = [
  "id",
  "size",
  "volume_size",
  "digest",
  "created_at",
  "status",
  "retention_days",
];
// `fly.Machine` tags; `checks`, `nonce`, `host_features`, `containers`, and `incomplete_config`
// are omitempty and empty here.
const MACHINE_KEYS = [
  "id",
  "name",
  "state",
  "region",
  "image_ref",
  "instance_id",
  "version",
  "private_ip",
  "created_at",
  "updated_at",
  "config",
  "events",
  "host_status",
  "cordoned",
];
const MACHINE_CONFIG_KEYS = [
  "env",
  "init",
  "guest",
  "metadata",
  "mounts",
  "services",
  "image",
  "restart",
];
const IMAGE_KEYS = ["MachineID", "Registry", "Repository", "Tag", "Version", "Digest", "Labels"];
const LOG_KEYS = ["timestamp", "message", "level", "instance", "region"];

const MUTATING: Readonly<Record<string, boolean>> = {
  "auth whoami": false,
  "auth login": true,
  "auth logout": true,
  "apps create": true,
  "apps list": false,
  "apps destroy": true,
  "volumes create": true,
  "volumes list": false,
  "volumes destroy": true,
  "volumes snapshots create": true,
  "volumes snapshots list": false,
  deploy: true,
  "ssh console": false,
  logs: false,
  "image show": false,
  "machine status": false,
  "machine list": false,
  "machine destroy": true,
  bogus: false,
};

const keys = (value: unknown) => Object.keys(value as object).toSorted();
const sorted = (list: ReadonlyArray<string>) => list.toSorted();

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Response {
  readonly status: number;
  readonly location: string | undefined;
  readonly body: string;
}

function get(url: string): Promise<Response> {
  const secure = url.startsWith("https:");
  return new Promise((resolve, reject) => {
    const onResponse = (response: NodeHttp.IncomingMessage) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, location: response.headers.location, body }),
      );
    };
    const request = secure
      ? NodeHttps.get(url, { ca: NodeFS.readFileSync(rootCertPath()) }, onResponse)
      : NodeHttp.get(url, onResponse);
    request.on("error", reject);
  });
}

describe.skipIf(!hasDocker())("fake fly", () => {
  const suffix = NodeCrypto.randomBytes(3).toString("hex");
  const app = `fake-fly-test-${suffix}`;
  const image = `sail-fake-fly-test:${suffix}`;
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-fly-test-"));
  const home = NodePath.join(root, "home");
  const appDir = NodePath.join(root, "app");
  const env = {
    ...process.env,
    FAKE_FLY_HOME: home,
    FLY_API_TOKEN: "",
    FLY_ACCESS_TOKEN: "",
    FLY_APP: "",
    PATH: `${NodePath.join(import.meta.dirname, "fake-fly")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  };
  let calls = 0;
  let url = "";
  let firstMachine = "";
  let follower: NodeChildProcess.ChildProcess | undefined;
  let followerOutput = "";
  let followerWaits: Array<() => boolean> = [];

  const fly = (args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}): Run => {
    calls++;
    const result = NodeChildProcess.spawnSync("fly", args, {
      cwd: appDir,
      encoding: "utf8",
      input: "",
      env: { ...env, ...extraEnv },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const ok = (args: ReadonlyArray<string>): string => {
    const result = fly(args);
    expect(result, `fly ${args.join(" ")}`).toMatchObject({ status: 0 });
    return result.stdout;
  };
  const json = (args: ReadonlyArray<string>): unknown => JSON.parse(ok(args));
  const ssh = (command: string) => fly(["ssh", "console", "-q", "-C", command]);
  const volumes = () => json(["volumes", "list", "-j"]) as Array<Record<string, unknown>>;
  const machines = () => json(["machine", "list", "-j"]) as Array<Record<string, unknown>>;
  const machineId = () => String(machines()[0]?.id);
  const followerSees = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (followerOutput.split("serving initial configuration").length - 1 < count) return false;
        resolve();
        return true;
      };
      if (!check()) followerWaits.push(check);
    });

  beforeAll(() => {
    const build = NodePath.join(root, "image");
    NodeFS.mkdirSync(build, { recursive: true });
    NodeFS.mkdirSync(appDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(build, "Caddyfile"),
      `:8080 {\n\trespond /unhealthy 503\n\trespond "proto={header.X-Forwarded-Proto} fly={header.Fly-Forwarded-Proto}"\n}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(build, "Dockerfile"),
      "FROM caddy:2\nRUN adduser -D sail\nCOPY Caddyfile /etc/caddy/Caddyfile\n",
    );
    docker(["build", "--quiet", "--tag", image, build]);
    NodeFS.writeFileSync(
      NodePath.join(appDir, "fly.toml"),
      `app = "${app}"
primary_region = "iad" # comment

[env]
  GREETING = "hello world"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/"

[[mounts]]
  source = "data"
  destination = "/data"
  initial_size = "1gb"

[[vm]]
  memory = "256mb"
  size = "shared-cpu-1x"
`,
    );
  });

  afterAll(() => {
    follower?.kill("SIGTERM");
    for (const name of [app, `${app}-c`]) {
      fly(["apps", "destroy", name, "--yes"]);
      if (exists("container", `sail-fly-${name}`)) docker(["rm", "--force", `sail-fly-${name}`]);
      removeSite(`fly-${name}`);
    }
    for (const [kind, prefix] of [
      ["volumes", "sail-fly-vol-"],
      ["snapshots", "sail-fly-snap-"],
    ] as const) {
      const dir = NodePath.join(home, kind);
      if (!NodeFS.existsSync(dir)) continue;
      for (const file of NodeFS.readdirSync(dir)) {
        const name = `${prefix}${file.replace(/\.json$/, "")}`;
        if (exists("volume", name)) docker(["volume", "rm", "--force", name]);
      }
    }
    if (exists("image", image)) docker(["image", "rm", image]);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("signs in and out like flyctl", () => {
    expect(ok(["auth", "whoami"])).toBe("fake@localtest.me\n");
    expect(json(["auth", "whoami", "-j"])).toEqual({ email: "fake@localtest.me" });
    ok(["auth", "logout"]);
    const signedOut = fly(["apps", "list"]);
    expect(signedOut.status).toBe(1);
    expect(signedOut.stderr).toBe(
      "Error: no access token available. Please login with 'flyctl auth login'\n",
    );
    expect(fly(["auth", "whoami"]).status).toBe(1);
    expect(fly(["apps", "list", "-q"], { FLY_API_TOKEN: "token" }).status).toBe(0);
    expect(fly(["-t", "token", "apps", "list", "-q"]).status).toBe(0);
    ok(["auth", "login"]);
    expect(fly(["auth", "whoami"]).status).toBe(0);
  });

  it("fails unknown commands and flags as cobra does", () => {
    expect(fly(["bogus"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('Error: unknown command "bogus" for "fly"'),
    });
    expect(fly(["apps", "list", "--bogus"])).toMatchObject({
      status: 1,
      stderr: "Error: unknown flag: --bogus\n",
    });
    expect(fly(["apps", "list", "-x"])).toMatchObject({
      status: 1,
      stderr: "Error: unknown shorthand flag: 'x' in -x\n",
    });
    expect(fly(["volumes", "snapshots", "create"])).toMatchObject({
      status: 1,
      stderr: "Error: accepts 1 arg(s), received 0\n",
    });
  });

  it("creates and lists apps in fly.App's shape", () => {
    expect(ok(["apps", "create", app])).toBe(`New app created: ${app}\n`);
    expect(fly(["apps", "create", app])).toMatchObject({
      status: 1,
      stderr: "Error: Validation failed: Name has already been taken\n",
    });
    expect(keys(json(["apps", "create", `${app}-j`, "--json"]))).toEqual(sorted(APP_KEYS));
    ok(["apps", "destroy", `${app}-j`, "--yes"]);
    const listed = (json(["apps", "list", "-j"]) as Array<Record<string, unknown>>).find(
      (entry) => entry.Name === app,
    );
    expect(keys(listed)).toEqual(sorted(APP_KEYS));
    expect(keys(listed?.Organization)).toEqual(sorted(ORGANIZATION_KEYS));
    expect(listed).toMatchObject({
      ID: app,
      Hostname: "",
      Status: "pending",
      Deployed: false,
      CurrentRelease: null,
      Organization: { Slug: "personal" },
    });
    expect(ok(["apps", "list", "-q"]).split("\n")).toContain(app);
  });

  it("creates volumes in fly.Volume's shape and rejects bad names", () => {
    const volume = json(["volumes", "create", "data", "-r", "iad", "-s", "1", "-y", "-j"]);
    expect(keys(volume)).toEqual(sorted(VOLUME_KEYS));
    expect(volume).toMatchObject({
      id: expect.stringMatching(/^vol_[a-z0-9]{16}$/),
      name: "data",
      size_gb: 1,
      region: "iad",
      attached_machine_id: null,
    });
    expect(fly(["volumes", "create", "Bad-Name", "-r", "iad", "-y"]).status).toBe(1);
    expect(volumes().map((entry) => entry.id)).toEqual([(volume as { id: string }).id]);
  });

  it("deploys behind Caddy with Fly Proxy's headers", async () => {
    const [volume] = volumes();
    const deployed = ok(["deploy", "--image", image, "--ha=false", "--strategy", "immediate"]);
    url = publicUrl(`${app}.localtest.me`);
    expect(deployed.trimEnd().split("\n").at(-1)).toBe(`Visit your newly deployed app at ${url}/`);
    const [machine] = machines();
    expect(keys(machine)).toEqual(sorted(MACHINE_KEYS));
    expect(machine).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{14}$/),
      state: "started",
    });
    firstMachine = String(machine?.id);
    expect(volumes()[0]).toMatchObject({ id: volume?.id, attached_machine_id: firstMachine });
    const listed = (json(["apps", "list", "-j"]) as Array<Record<string, unknown>>).find(
      (entry) => entry.Name === app,
    );
    expect(listed).toMatchObject({ Status: "deployed", Deployed: true });
    expect(keys(listed?.CurrentRelease)).toEqual(sorted(RELEASE_KEYS));

    await expect(get(`${url}/`)).resolves.toMatchObject({
      status: 200,
      body: "proto=https fly=https",
    });
    await expect(get(`${publicUrl(`${app}.localtest.me`, "http")}/`)).resolves.toMatchObject({
      status: 308,
      location: `https://${app}.localtest.me/`,
    });
  });

  it("runs ssh console commands as the given user without a shell", () => {
    const whoami = fly(["ssh", "console", "-u", "sail", "-C", "id -un"]);
    expect(whoami).toMatchObject({ status: 0, stdout: "sail\n" });
    expect(whoami.stderr).toMatch(/^Connecting to fdaa:[0-9a-f:]+\.\.\. complete\n$/);
    expect(ssh("printenv GREETING SAIL_PUBLIC_URL FLY_APP_NAME FLY_MACHINE_ID").stdout).toBe(
      `hello world\n${url}\n${app}\n${firstMachine}\n`,
    );
    expect(ssh(`echo "a b" '$HOME'`).stdout).toBe("a b $HOME\n");
    expect(ssh("sh -c 'exit 3'").status).toBe(3);
  });

  it("redeploys onto the same machine and volume, and logs follow the new container", async () => {
    follower = NodeChildProcess.spawn("fly", ["logs"], { cwd: appDir, env });
    calls++;
    follower.stdout?.setEncoding("utf8");
    follower.stdout?.on("data", (chunk: string) => {
      followerOutput += chunk;
      followerWaits = followerWaits.filter((check) => !check());
    });
    await followerSees(1);
    const before = json(["machine", "list", "-j"]) as Array<{ version: string }>;
    const volume = volumes()[0]?.id;

    ok(["deploy", "--image", image, "-e", "EXTRA=1"]);
    const [after] = machines() as Array<{
      id: string;
      version: string;
      config: { metadata: Record<string, string>; mounts: Array<{ volume: string }> };
    }>;
    expect(after?.id).toBe(firstMachine);
    expect((after?.version ?? "") > (before[0]?.version ?? "")).toBe(true);
    expect(after?.config.metadata.fly_release_version).toBe("2");
    expect(after?.config.mounts[0]?.volume).toBe(volume);
    expect(ssh("printenv EXTRA").stdout).toBe("1\n");
    await followerSees(2);

    const lines = ok(["logs", "--no-tail"]).trimEnd().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^\\S+Z app\\[${firstMachine}\\] iad \\[info\\] \\S`));
    const entry = JSON.parse(ok(["logs", "-n", "-j"]).split("\n")[0] ?? "");
    expect(keys(entry)).toEqual(sorted(LOG_KEYS));
    expect(entry).toMatchObject({ instance: firstMachine, region: "iad", level: "info" });
  });

  it("restores a snapshot to a new volume and a new machine", () => {
    const [volume] = volumes() as Array<{ id: string }>;
    const original = volume?.id ?? "";
    expect(ssh("sh -c 'echo one > /data/before'").status).toBe(0);
    expect(ok(["volumes", "snapshots", "create", original])).toBe(
      `Scheduled to snapshot volume ${original}\n`,
    );
    const snapshots = json(["volumes", "snapshots", "list", original, "-j"]) as Array<{
      id: string;
    }>;
    expect(snapshots).toHaveLength(1);
    expect(keys(snapshots[0])).toEqual(sorted(SNAPSHOT_KEYS));
    expect(snapshots[0]).toMatchObject({
      id: expect.stringMatching(/^vs_[A-Za-z0-9]+$/),
      status: "created",
      retention_days: 5,
    });
    expect(ssh("sh -c 'echo two > /data/after'").status).toBe(0);

    const restored = json([
      "volumes",
      "create",
      "data",
      "--snapshot-id",
      snapshots[0]?.id ?? "",
      "-r",
      "iad",
      "-y",
      "-j",
    ]) as { id: string };
    expect(fly(["volumes", "destroy", original, "-y"]).status).toBe(1);
    expect(fly(["machine", "destroy", firstMachine]).status).toBe(1);
    ok(["machine", "destroy", firstMachine, "--force"]);
    ok(["volumes", "destroy", original, "-y"]);
    ok(["deploy", "--image", image]);

    expect(machineId()).not.toBe(firstMachine);
    expect(volumes()).toMatchObject([{ id: restored.id, attached_machine_id: machineId() }]);
    expect(ssh("ls /data").stdout.split("\n")).toContain("before");
    expect(ssh("ls /data").stdout.split("\n")).not.toContain("after");
  });

  it("shows the image and machine status in flyctl's shapes", () => {
    const id = machineId();
    const digest = docker(["image", "inspect", "--format", "{{.Id}}", image]).trim();
    const shown = json(["image", "show", "-j"]) as Array<Record<string, string>>;
    expect(shown).toHaveLength(1);
    expect(keys(shown[0])).toEqual(sorted(IMAGE_KEYS));
    expect(shown[0]).toMatchObject({ MachineID: id, Digest: digest, Version: "N/A" });
    expect(keys(json(["image", "show", id, "-j"]))).toEqual(sorted(IMAGE_KEYS));

    const status = ok(["machine", "status"]);
    expect(status).toMatch(
      new RegExp(`^Machine ID: ${id}\nVersion: \\w+\nState: started\nHostStatus: ok\n\nVM\n`),
    );
    const config = json(["machine", "status", "-d"]);
    expect(keys(config)).toEqual(sorted(MACHINE_CONFIG_KEYS));
    expect(config).toMatchObject({
      env: { GREETING: "hello world", FLY_PROCESS_GROUP: "app", PRIMARY_REGION: "iad" },
      guest: { memory_mb: 256, cpus: 1 },
      restart: { policy: "on-failure" },
    });
  });

  it("destroys the app with its container, volumes, snapshots, and site", async () => {
    const owned = [
      ...volumes().map((entry) => `sail-fly-vol-${String(entry.id)}`),
      ...NodeFS.readdirSync(NodePath.join(home, "snapshots")).map(
        (file) => `sail-fly-snap-${file.replace(/\.json$/, "")}`,
      ),
    ];
    expect(owned).toHaveLength(2);
    expect(fly(["apps", "destroy", app])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("yes flag must be specified when not running interactively"),
    });
    const running = follower;
    const exited = new Promise((resolve) => running?.once("exit", resolve));
    expect(ok(["apps", "destroy", app, "--yes"])).toBe(`Destroyed app ${app}\n`);
    expect(exists("container", `sail-fly-${app}`)).toBe(false);
    for (const name of owned) expect(exists("volume", name), name).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(caddyDirInUse(), "sites", `fly-${app}.caddy`))).toBe(
      false,
    );
    await expect(exited).resolves.toBe(0);
    follower = undefined;
  });

  it("waits for http_service checks to pass before deploy returns", () => {
    const checked = `${app}-c`;
    NodeFS.writeFileSync(
      NodePath.join(appDir, "checks.toml"),
      `app = "${checked}"\n\n[http_service]\n  internal_port = 8080\n\n  [[http_service.checks]]\n    path = "/unhealthy"\n`,
    );
    ok(["apps", "create", checked]);
    const failed = fly(["deploy", "-c", "checks.toml", "--image", image, "--wait-timeout", "2s"]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("timeout reached waiting for machine");
    ok(["apps", "destroy", checked, "--yes"]);
  });

  it("logs one call per invocation with the command's mutating flag", () => {
    const logged = NodeFS.readFileSync(NodePath.join(home, "calls.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: Array<string>; mutating: boolean; cwd: string });
    expect(logged).toHaveLength(calls);
    for (const call of logged) {
      const words = call.argv.filter((arg, i) => !arg.startsWith("-") && call.argv[i - 1] !== "-t");
      const command = Object.keys(MUTATING).find((key) => words.join(" ").startsWith(key));
      expect(command, call.argv.join(" ")).toBeDefined();
      expect(call.mutating, call.argv.join(" ")).toBe(MUTATING[command ?? ""]);
      expect(call.cwd).toBe(NodeFS.realpathSync(appDir));
    }
  });
});

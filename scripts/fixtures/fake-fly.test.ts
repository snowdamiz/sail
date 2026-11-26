// @effect-diagnostics nodeBuiltinImport:off - Drives the fake `fly` CLI and the Docker it manages.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { caddyDir, publicUrl, removeSite, rootCertPath } from "./lib/caddy.ts";
import { docker, exists, hasDocker, DOCKER_TEST_TIMEOUT_MS } from "./lib/docker.ts";
import { fixturesRoot, homeId } from "./lib/state.ts";

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Docker work on the VM every lane shares, not a hidden wait.
vi.setConfig({ testTimeout: DOCKER_TEST_TIMEOUT_MS, hookTimeout: DOCKER_TEST_TIMEOUT_MS });

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
// `renderMachineJSONStatus` in flyctl's internal/command/status/machines.go; `Network` only when set.
const STATUS_KEYS = [
  "ID",
  "Name",
  "Deployed",
  "Status",
  "Hostname",
  "Version",
  "AppURL",
  "Organization",
  "PlatformVersion",
  "Machines",
];
const ORGANIZATION_BASIC_KEYS = ["ID", "InternalNumericID", "Name", "Slug", "RawSlug", "PaidPlan"];
const IMAGE_KEYS = ["MachineID", "Registry", "Repository", "Tag", "Version", "Digest", "Labels"];
// flyctl's `logs.LogEntry` in field order; `Meta` has no JSON tags but `status_code`.
const LOG_KEYS = ["level", "instance", "message", "region", "timestamp", "meta"];
const EMPTY_LOG_META = {
  HTTP: { Request: { ID: "", Method: "", Version: "" }, Response: { status_code: 0 } },
  Error: { Code: 0, Message: "" },
  URL: { Full: "" },
};

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
  status: false,
  "machine start": false,
  "apps restart": false,
  "volumes snapshots": false,
  apps: false,
  bogus: false,
};
const VALUE_FLAGS = new Set(["-t", "--access-token", "-a", "--app"]);

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
  // Pulling from a closed local port fails at once, so a remote lookup of it never finds it.
  const unpullable = `localhost:1/sail-fake-fly-test:${suffix}`;
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-fly-test-"));
  const home = NodePath.join(root, "home");
  const appDir = NodePath.join(root, "app");
  const fakeDir = NodePath.join(import.meta.dirname, "fake-fly");
  const env = {
    ...process.env,
    FAKE_FLY_HOME: home,
    FLY_API_TOKEN: "",
    FLY_ACCESS_TOKEN: "",
    FLY_APP: "",
    FLY_REGION: "",
    FAKE_FLY_SNAPSHOT_SECS: "0",
    PATH: `${fakeDir}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  };
  let calls = 0;
  let url = "";
  let firstMachine = "";
  let follower: NodeChildProcess.ChildProcess | undefined;
  let followerOutput = "";
  let followerWaits: Array<() => boolean> = [];

  const run = (
    args: ReadonlyArray<string>,
    extraEnv: Readonly<Record<string, string | undefined>>,
    cwd: string,
  ): Run => {
    const result = NodeChildProcess.spawnSync("fly", args, {
      cwd,
      encoding: "utf8",
      input: "",
      env: { ...env, ...extraEnv },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const fly = (
    args: ReadonlyArray<string>,
    extraEnv: Readonly<Record<string, string>> = {},
    cwd = appDir,
  ): Run => {
    calls++;
    return run(args, extraEnv, cwd);
  };
  const otherHome = NodePath.join(root, "other-home");
  const flyElsewhere = (args: ReadonlyArray<string>) =>
    run(args, { FAKE_FLY_HOME: otherHome }, root);
  const slashHome = NodePath.join(root, "slash-home");
  const builtImages = (appName: string) =>
    docker(["image", "ls", "--quiet", `registry.fly.io/${appName}`]).trim();
  const label = (kind: "container" | "volume", name: string) =>
    docker([
      kind,
      "inspect",
      "--format",
      `{{index ${kind === "container" ? ".Config.Labels" : ".Labels"} "sail-fixture.home"}}`,
      name,
    ]).trim();
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
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (followerOutput.split("serving initial configuration").length - 1 < count) return false;
        resolve();
        return true;
      };
      if (check()) return;
      const gone = () => reject(new Error(`fly logs exited before it showed start ${count}`));
      if (!follower || follower.exitCode !== null) return gone();
      followerWaits.push(check);
      follower.once("exit", gone);
    });

  beforeAll(() => {
    const build = NodePath.join(root, "image");
    NodeFS.mkdirSync(build, { recursive: true });
    NodeFS.mkdirSync(appDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(build, "Caddyfile"),
      `:8080 {\n\t@unchecked {\n\t\tpath /checked\n\t\tnot header X-Check yes\n\t}\n\trespond @unchecked 503\n\trespond /unhealthy 503\n\trespond "proto={header.X-Forwarded-Proto} fly={header.Fly-Forwarded-Proto} port={header.X-Forwarded-Port} ssl={header.X-Forwarded-Ssl}"\n}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(build, "start.sh"),
      `caddy run --config /etc/caddy/Caddyfile & pid=$!\nfor signal in INT TERM; do trap "echo $signal >> /data/signals; kill $pid; exit 0" $signal; done\nwait $pid\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(build, "Dockerfile"),
      'FROM caddy:2\nRUN adduser -D sail\nLABEL fly.version="1.2.3"\nCOPY Caddyfile /etc/caddy/Caddyfile\nCOPY start.sh /start.sh\nCMD ["sh", "/start.sh"]\n',
    );
    docker(["build", "--quiet", "--tag", image, build]);
    docker(["tag", image, unpullable]);
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
    interval = "15s"
    timeout = "2s"
    grace_period = "60s"

  [[http_service.checks]]
    path = "/checked"
    headers = { X-Check = "yes" }

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
    for (const name of [app, `${app}-b`, `${app}-c`, `${app}-d`, `${app}-f`, `${app}-s`]) {
      fly(["apps", "destroy", name, "--yes"]);
      flyElsewhere(["apps", "destroy", name, "--yes"]);
      run(["apps", "destroy", name, "--yes"], { FAKE_FLY_HOME: slashHome }, root);
      if (exists("container", `sail-fly-${name}`)) docker(["rm", "--force", `sail-fly-${name}`]);
      removeSite(`fly-${name}`);
    }
    for (const owner of [home, slashHome]) {
      const ids = docker([
        "image",
        "ls",
        "--quiet",
        "--filter",
        `label=sail-fixture.home=${homeId(owner)}`,
      ]).trim();
      if (ids) docker(["image", "rm", "--force", ...new Set(ids.split("\n"))]);
    }
    if (exists("image", unpullable)) docker(["image", "rm", unpullable]);
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
    if (exists("image", image)) docker(["image", "rm", "--force", image]);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("signs in and out like flyctl", () => {
    expect(ok(["auth", "whoami"])).toBe("fake@localtest.me\n");
    expect(json(["auth", "whoami", "-j"])).toEqual({ email: "fake@localtest.me" });
    ok(["auth", "logout"]);
    const signedOut = fly(["apps", "list"]);
    const whoamiOut = fly(["auth", "whoami"]);
    const withEnvToken = fly(["apps", "list", "-q"], { FLY_API_TOKEN: "token" });
    const withFlagToken = fly(["-t", "token", "apps", "list", "-q"]);
    ok(["auth", "login"]);
    expect(signedOut).toMatchObject({
      status: 1,
      stderr: `Error: no access token available. Please login with '${NodePath.join(fakeDir, "fly")} auth login' (fake fly)\n`,
    });
    expect(whoamiOut.status).toBe(1);
    expect(withEnvToken.status).toBe(0);
    expect(withFlagToken.status).toBe(0);
    expect(fly(["auth", "whoami"]).status).toBe(0);
  });

  it("answers as both fly and flyctl when first on PATH", () => {
    const callLog = NodePath.join(home, "calls.jsonl");
    for (const name of ["fly", "flyctl"]) {
      const found = NodeChildProcess.spawnSync("sh", ["-c", `command -v ${name}`], {
        env,
        encoding: "utf8",
      }).stdout.trim();
      // Checked before running it, so a missing shim never reaches the real flyctl's account.
      expect(NodePath.dirname(found), name).toBe(fakeDir);
      const before = NodeFS.readFileSync(callLog, "utf8");
      calls++;
      const whoami = NodeChildProcess.spawnSync(found, ["auth", "whoami"], {
        cwd: appDir,
        env,
        encoding: "utf8",
        input: "",
      });
      expect(whoami, name).toMatchObject({ status: 0, stdout: "fake@localtest.me\n" });
      const logged = NodeFS.readFileSync(callLog, "utf8").slice(before.length);
      expect(JSON.parse(logged), name).toMatchObject({ argv: ["auth", "whoami"], exitCode: 0 });
    }
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

  it("fails real flyctl subcommands it does not implement instead of printing help", () => {
    for (const words of [
      ["machine", "start"],
      ["apps", "restart"],
    ]) {
      expect(fly([...words, "-a", app, "x"])).toMatchObject({
        status: 1,
        stderr: `Error: fake fly does not implement "fly ${words.join(" ")}"\n`,
      });
    }
    const help = fly(["apps", "--help"]);
    expect(help).toMatchObject({ status: 0, stdout: expect.stringContaining("  create\n") });
    expect(help.stdout).toContain("does not implement");
    expect(fly(["apps"]).status).toBe(0);
    expect(fly(["ssh", "console", "--help"])).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("--command"),
    });
    expect(fly(["volumes", "snapshots", "--help"])).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("  list\n"),
    });
  });

  it("keeps one default state home per checkout", () => {
    const state = NodePath.join(root, "xdg");
    const defaults = { FAKE_FLY_HOME: undefined, XDG_STATE_HOME: state };
    expect(run(["auth", "logout"], defaults, root).status).toBe(0);
    const homes = NodeFS.readdirSync(NodePath.join(state, "sail-fixtures", "fly"), {
      withFileTypes: true,
    });
    expect(homes.map((entry) => entry.isDirectory())).toEqual([true]);
    expect(run(["apps", "list", "-q"], defaults, root).status).toBe(1);
    expect(fly(["apps", "list", "-q"]).status).toBe(0);
  });

  it("creates and lists apps in fly.App's shape", () => {
    expect(ok(["apps", "create", app])).toBe(`New app created: ${app}\n`);
    expect(fly(["apps", "create", app])).toMatchObject({
      status: 1,
      stderr: "Error: Validation failed: Name has already been taken\n",
    });
    expect(flyElsewhere(["apps", "create", app])).toMatchObject({
      status: 1,
      stderr: "Error: Validation failed: Name has already been taken\n",
    });
    const reserved = fly(["apps", "create", "auth"]);
    if (reserved.status === 0) fly(["apps", "destroy", "auth", "--yes"]);
    expect(reserved).toMatchObject({
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
    expect(fly(["volumes", "create", "data", "-r", "iad", "-s", "0", "-y"]).status).toBe(1);
    expect(volumes().map((entry) => entry.id)).toEqual([(volume as { id: string }).id]);
    expect(label("volume", `sail-fly-vol-${(volume as { id: string }).id}`)).toBe(homeId(home));
    expect(fly(["volumes", "list", "--all"])).toMatchObject({
      status: 1,
      stderr: expect.stringMatching(/^Error: fake fly .*destroyed volumes/),
    });
  });

  it("reads flags before and between subcommand words", () => {
    for (const args of [
      ["-a", app, "volumes", "list", "-j"],
      ["volumes", "-a", app, "list", "-j"],
      ["volumes", "list", "--app", app, "-j"],
    ]) {
      const listed = fly(args, {}, root);
      expect(listed, args.join(" ")).toMatchObject({ status: 0 });
      expect(JSON.parse(listed.stdout)).toHaveLength(1);
    }
  });

  it("refuses fly.toml files flyctl refuses, before touching Docker", () => {
    const CHECK = "[http_service]\n  internal_port = 8080\n  [[http_service.checks]]\n";
    const configs: ReadonlyArray<readonly [string, string]> = [
      ["internal_port", '[http_service]\n  internal_port = "8080oops"\n'],
      ["duplicate", 'primary_region = "iad"\nprimary_region = "ord"\n'],
      ["bare", "primary_region = iad\n"],
      ["force_https", '[http_service]\n  internal_port = 8080\n  force_https = "yes"\n'],
      [
        "initial_size",
        '[[mounts]]\n  source = "data"\n  destination = "/data"\n  initial_size = "10oops"\n',
      ],
      [
        "initial_size",
        '[[mounts]]\n  source = "data"\n  destination = "/data"\n  initial_size = "500mb"\n',
      ],
      ["memory", '[[vm]]\n  memory = "256xb"\n'],
      ["memory", '[[vm]]\n  memory = "1.2.3gb"\n'],
      ["memory", '[[vm]]\n  memory = "256gi"\n'],
      ["memory", '[[vm]]\n  memory = "-256"\n'],
      ["memory", '[[vm]]\n  memory = "1e309gb"\n'],
      [
        "initial_size",
        '[[mounts]]\n  source = "data"\n  destination = "/data"\n  initial_size = "1e309gb"\n',
      ],
      [
        "initial_size",
        '[[mounts]]\n  source = "data"\n  destination = "/data"\n  initial_size = "10gi"\n',
      ],
      ["internal_port", "[http_service]\n  internal_port = 8080.5\n"],
      ["kill_timeout", 'kill_timeout = "5 parsecs"\n'],
      ["interval", `${CHECK}    interval = "5 parsecs"\n`],
      ["headers", `${CHECK}    headers = { X-Check = 1 }\n`],
      [
        "checks",
        '[http_service]\n  internal_port = 8080\n  [http_service.checks]\n    path = "/"\n',
      ],
    ];
    for (const [field, body] of configs) {
      const file = NodePath.join(root, `bad-${NodeCrypto.randomBytes(3).toString("hex")}.toml`);
      NodeFS.writeFileSync(file, `app = "${app}"\n${body}`);
      const result = fly(["deploy", "-c", file, "--image", image]);
      expect(result.status, body).toBe(1);
      expect(result.stderr, body).toMatch(
        /^Error: (failed loading app config|App configuration is not valid)/,
      );
      if (field !== "duplicate" && field !== "bare") expect(result.stderr, body).toContain(field);
    }
    const timeout = fly(["deploy", "--image", image, "--wait-timeout", "5sgarbage"]);
    expect(timeout).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("invalid duration"),
    });
    expect(exists("container", `sail-fly-${app}`)).toBe(false);
  });

  it("refuses deploy flags flyctl refuses, before touching Docker", () => {
    expect(fly(["deploy", "--image", image, "--strategy", "bogus"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(
        "unsupported deployment strategy 'bogus'; Apps v2 supports the following strategies: canary, rolling, immediate, bluegreen",
      ),
    });
    expect(fly(["deploy", "--image", image, "--strategy", "canary"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(
        "canary deployment strategy is not supported when using mounted volumes",
      ),
    });
    expect(fly(["deploy", "--image", unpullable, "--remote-only"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(`could not find image "${unpullable}"`),
    });
    expect(fly(["deploy", "--image", image, "--remote-only", "--local-only"])).toMatchObject({
      status: 1,
      stderr: "Error: no docker daemon available\n",
    });
    expect(exists("container", `sail-fly-${app}`)).toBe(false);
  });

  it("deploys behind Caddy with Fly Proxy's headers", async () => {
    const [volume] = volumes();
    const first = fly(["deploy", "--image", image, "--ha=false", "--strategy", "immediate"]);
    expect(first).toMatchObject({ status: 0 });
    expect(first.stderr, "real flyctl needs --local-only for a local image").toContain(
      "--local-only",
    );
    const deployed = first.stdout;
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
      body: "proto=https fly=https port=443 ssl=",
    });
    expect(label("container", `sail-fly-${app}`)).toBe(homeId(home));

    const status = json(["status", "-j"]) as Record<string, unknown>;
    expect(keys(status)).toEqual(sorted(STATUS_KEYS));
    expect(keys(status.Organization)).toEqual(sorted(ORGANIZATION_BASIC_KEYS));
    expect(status).toMatchObject({
      Name: app,
      Hostname: `${app}.localtest.me`,
      Deployed: true,
      Version: 1,
    });
    expect((status.Machines as Array<unknown>).map(keys)).toEqual([sorted(MACHINE_KEYS)]);
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
    expect(fly(["ssh", "console", "-r", "iad", "-q", "-C", "id -un"]).stdout).toBe("root\n");
    expect(fly(["ssh", "console", "--region", "nowhere", "-q", "-C", "id -un"])).toMatchObject({
      status: 1,
      stdout: "",
      stderr: `Error: app ${app} has no VMs in region nowhere\n`,
    });
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

    const redeployed = fly([
      "deploy",
      "--image",
      image,
      "--local-only",
      "-e",
      "EXTRA=1",
      "--strategy",
      "immediate",
    ]);
    expect(redeployed).toMatchObject({ status: 0 });
    expect(redeployed.stderr).not.toContain("--local-only");
    expect(redeployed.stdout).toContain(
      `Updating existing machines in '${app}' with immediate strategy\n`,
    );
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
    expect(ssh("cat /data/signals").stdout).toBe("INT\n");
    await followerSees(2);

    const lines = ok(["logs", "--no-tail"]).trimEnd().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^\\S+Z app\\[${firstMachine}\\] iad \\[info\\] \\S`));
  });

  it("prints logs as a stream of flyctl's LogEntry JSON", () => {
    const entries = (text: string): Array<Record<string, unknown>> =>
      text === ""
        ? []
        : text
            .trimEnd()
            .split(/\n(?=\{)/)
            .map((value) => JSON.parse(value));
    const raw = ok(["logs", "-n", "-j"]);
    expect(raw).toMatch(/^\{\n {4}"level": "info",\n {4}"instance": /);
    const [entry] = entries(raw);
    expect(Object.keys(entry ?? {})).toEqual(LOG_KEYS);
    expect(entry).toEqual({
      level: "info",
      instance: firstMachine,
      message: expect.any(String),
      region: "iad",
      timestamp: expect.stringMatching(/Z$/),
      meta: {
        Instance: firstMachine,
        Region: "iad",
        Event: { Provider: "app" },
        ...EMPTY_LOG_META,
      },
    });
    const byMachine = ok(["logs", "-n", "-j", "--machine", firstMachine, "--region", "nowhere"]);
    expect(entries(byMachine).length).toBe(entries(raw).length);
    expect(fly(["logs", "-n", "-j", "--region", "nowhere"]).stdout).toBe("");
    expect(fly(["logs", "-n", "-j"], { FLY_REGION: "nowhere" }).stdout).toBe("");
  });

  it("restores a snapshot to a new volume and a new machine", () => {
    const [volume] = volumes() as Array<{ id: string }>;
    const original = volume?.id ?? "";
    expect(ssh("sh -c 'echo one > /data/before'").status).toBe(0);
    const slow = fly(["volumes", "snapshots", "create", original], {
      FAKE_FLY_SNAPSHOT_SECS: "3600",
    });
    expect(slow).toMatchObject({ status: 0, stdout: `Scheduled to snapshot volume ${original}\n` });
    const pendingId = NodeFS.readdirSync(NodePath.join(home, "snapshots"))[0]?.replace(
      /\.json$/,
      "",
    );
    const homeVolumes = () =>
      docker(["volume", "ls", "-q", "--filter", `label=sail-fixture.home=${homeId(home)}`]);
    const volumesBefore = homeVolumes();
    for (const delay of ["99999999999999999", "604801"]) {
      expect(
        fly(["volumes", "snapshots", "create", original], { FAKE_FLY_SNAPSHOT_SECS: delay }),
        delay,
      ).toMatchObject({ status: 1, stderr: expect.stringContaining("FAKE_FLY_SNAPSHOT_SECS") });
    }
    expect(homeVolumes()).toBe(volumesBefore);
    expect(NodeFS.readdirSync(NodePath.join(home, "snapshots"))).toEqual([`${pendingId}.json`]);
    const listing = fly(["volumes", "snapshots", "list", original, "-j"]);
    expect(JSON.parse(listing.stdout)).toMatchObject([
      { id: "", status: "pending", size: 0, digest: "" },
    ]);
    expect(fly(["volumes", "snapshots", "list", original]).stdout).toContain("(pending)");
    expect(
      fly(["volumes", "create", "data", "--snapshot-id", pendingId ?? "", "-r", "iad", "-y"]),
    ).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("pending"),
    });
    expect(fly(["volumes", "snapshots", "list", original, "-a", `${app}-nope`])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("not found"),
    });
    expect(
      fly(["volumes", "snapshots", "list", "vol_0000000000000000", "-j"], {}, root),
    ).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("not found"),
    });
    ok(["volumes", "snapshots", "create", original]);
    const snapshots = json(["volumes", "snapshots", "list", original, "-j"]) as Array<{
      id: string;
      status: string;
    }>;
    expect(snapshots.map((snapshot) => snapshot.status)).toEqual(["pending", "created"]);
    const created = snapshots[1];
    expect(label("volume", `sail-fly-snap-${created?.id}`)).toBe(homeId(home));
    expect(keys(created)).toEqual(sorted(SNAPSHOT_KEYS));
    expect(created).toMatchObject({
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
      created?.id ?? "",
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

  it("shows the image in flyctl's shape with its fly.version", () => {
    const id = machineId();
    const digest = docker(["image", "inspect", "--format", "{{.Id}}", image]).trim();
    const shown = json(["image", "show", "-j"]) as Array<Record<string, string>>;
    expect(shown).toHaveLength(1);
    expect(keys(shown[0])).toEqual(sorted(IMAGE_KEYS));
    expect(shown[0]).toMatchObject({ MachineID: id, Digest: digest, Version: "1.2.3" });
    expect(JSON.parse(shown[0]?.Labels ?? "")).toMatchObject({ "fly.version": "1.2.3" });
    expect(json(["image", "show", id, "-j"])).toMatchObject({ MachineID: id, Version: "1.2.3" });
    expect(ok(["image", "show", id])).toMatch(/\bVersion\b.* 1\.2\.3\n/);
    expect(ok(["machine", "status", id])).toMatch(/\bImage\b.* \(1\.2\.3\)\n/);
  });

  it("shows machine status in flyctl's shape, finding the app from the machine", () => {
    const id = machineId();
    expect(fly(["machine", "status"])).toMatchObject({
      status: 1,
      stderr: "Error: a machine ID must be specified when not running interactively\n",
    });
    expect(fly(["machine", "status"], {}, root)).toMatchObject({
      status: 1,
      stderr: "Error: a machine ID or an app name is required\n",
    });
    expect(flyElsewhere(["machine", "status", id, "-d"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("could not get machine from GraphQL to determine app name"),
    });
    expect(fly(["machine", "status", id], {}, root).stdout).toMatch(
      new RegExp(`^Machine ID: ${id}\nVersion: \\w+\nState: started\nHostStatus: ok\n\nVM\n`),
    );
    const fromId = fly(["machine", "status", id, "-d"], {}, root);
    expect(fromId.stdout).toMatch(/^\{\n {2}"env": \{\n {4}"/);
    const config = JSON.parse(fromId.stdout) as {
      env: Record<string, string>;
      services: Array<{ checks: unknown }>;
    };
    expect(keys(config)).toEqual(sorted(MACHINE_CONFIG_KEYS));
    expect(config.env).not.toHaveProperty("SAIL_PUBLIC_URL");
    expect(config).toMatchObject({
      env: { GREETING: "hello world", FLY_PROCESS_GROUP: "app", PRIMARY_REGION: "iad" },
      guest: { memory_mb: 256, cpus: 1 },
      restart: { policy: "on-failure" },
    });
    expect(config.services[0]?.checks).toEqual([
      {
        type: "http",
        interval: "15s",
        timeout: "2s",
        grace_period: "1m0s",
        method: "GET",
        path: "/",
      },
      { type: "http", path: "/checked", headers: [{ name: "X-Check", values: ["yes"] }] },
    ]);
  });

  it("never replaces or removes another home's container", () => {
    const taken = `${app}-f`;
    const foreign = docker([
      "create",
      "--name",
      `sail-fly-${taken}`,
      "--label",
      "sail-fixture.home=someone-else",
      "--memory",
      "64m",
      image,
    ]).trim();
    ok(["apps", "create", taken]);
    const deployed = fly(["deploy", "-a", taken, "--image", image]);
    expect(deployed.status).toBe(1);
    expect(deployed.stderr).toContain("another fake fly home");
    ok(["apps", "destroy", taken, "--yes"]);
    expect(docker(["inspect", "--format", "{{.Id}}", `sail-fly-${taken}`]).trim()).toBe(foreign);
    docker(["rm", "--force", foreign]);
  });

  it("deploys a working directory with its own fly.toml on plain HTTP", async () => {
    const dirApp = `${app}-d`;
    const dir = NodePath.join(root, "dir-app");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "Dockerfile"), `FROM ${image}\n`);
    NodeFS.writeFileSync(
      NodePath.join(dir, "fly.toml"),
      `app = "${dirApp}"\nprimary_region = "iad"\nkill_signal = "SIGTERM"\nkill_timeout = 3\n\n[http_service]\n  internal_port = 8080\n\n[[mounts]]\n  source = "data"\n  destination = "/data"\n  initial_size = "10"\n`,
    );
    ok(["apps", "create", dirApp]);
    const first = fly(["deploy", dir], {}, root);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain("one machine");
    expect(fly(["deploy", dir, "--ha=false", "--remote-only"], {}, root).stderr).not.toContain(
      "one machine",
    );
    const [shown] = json(["image", "show", "-a", dirApp, "-j"]) as Array<{ Labels: string }>;
    const labels = Object.keys(JSON.parse(shown?.Labels ?? ""));
    expect(labels).toContain("fly.version");
    expect(labels.filter((key) => key.startsWith("sail-fixture"))).toEqual([]);
    const host = `${dirApp}.localtest.me`;
    await expect(get(`${publicUrl(host, "http")}/`)).resolves.toMatchObject({
      status: 200,
      body: "proto=http fly=http port=80 ssl=",
    });
    await expect(get(`${publicUrl(host)}/`)).resolves.toMatchObject({
      body: "proto=https fly=https port=443 ssl=",
    });
    expect(json(["volumes", "list", "-a", dirApp, "-j"])).toMatchObject([{ size_gb: 10 }]);
    expect(fly(["ssh", "console", "-a", dirApp, "-q", "-C", "cat /data/signals"]).stdout).toBe(
      "TERM\n",
    );
    ok(["apps", "destroy", dirApp, "--yes"]);
  });

  it("labels the images it builds, builds none for bad flags, and removes them with the app", () => {
    const built = `${app}-b`;
    const dir = NodePath.join(root, "built-app");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "Dockerfile"), `FROM ${image}\n`);
    NodeFS.writeFileSync(
      NodePath.join(dir, "fly.toml"),
      `app = "${built}"\nprimary_region = "iad"\n\n[[mounts]]\n  source = "Bad-Name"\n  destination = "/data"\n`,
    );
    ok(["apps", "create", built]);
    expect(fly(["deploy", dir, "--env", "BADPAIR"], {}, root)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("BADPAIR"),
    });
    expect(builtImages(built)).toBe("");
    expect(fly(["deploy", dir], {}, root)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("failed creating volume"),
    });
    expect(builtImages(built)).not.toBe("");
    const labelled = docker([
      "image",
      "ls",
      "--quiet",
      "--filter",
      `label=sail-fixture.home=${homeId(home)}`,
      "--filter",
      `label=sail-fixture.fly-app=${built}`,
    ]).trim();
    expect(labelled).toBe(builtImages(built));
    ok(["apps", "destroy", built, "--yes"]);
    expect(builtImages(built)).toBe("");
  });

  it("treats a home written with a trailing slash as the same home", () => {
    const slashed = `${app}-s`;
    const site = NodePath.join(caddyDir(), "sites", `fly-${slashed}.caddy`);
    const reservation = NodePath.join(fixturesRoot(), "names", "fly-app", slashed);
    expect(run(["apps", "create", slashed], { FAKE_FLY_HOME: `${slashHome}/` }, root).status).toBe(
      0,
    );
    const deployed = run(
      ["deploy", "-a", slashed, "--image", image, "--ha=false"],
      { FAKE_FLY_HOME: slashHome },
      root,
    );
    expect(deployed.status, deployed.stderr).toBe(0);
    expect(NodeFS.existsSync(site)).toBe(true);
    expect(
      run(["apps", "destroy", slashed, "--yes"], { FAKE_FLY_HOME: slashHome }, root).status,
    ).toBe(0);
    expect(exists("container", `sail-fly-${slashed}`)).toBe(false);
    expect(NodeFS.existsSync(site)).toBe(false);
    expect(NodeFS.existsSync(reservation)).toBe(false);
  });

  it("destroys the app with its container, volumes, snapshots, and site", async () => {
    const owned = [
      ...volumes().map((entry) => `sail-fly-vol-${String(entry.id)}`),
      ...NodeFS.readdirSync(NodePath.join(home, "snapshots")).map(
        (file) => `sail-fly-snap-${file.replace(/\.json$/, "")}`,
      ),
    ];
    expect(owned).toHaveLength(3);
    expect(fly(["apps", "destroy", app])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("yes flag must be specified when not running interactively"),
    });
    const running = follower;
    const exited = new Promise((resolve) => running?.once("exit", resolve));
    expect(ok(["apps", "destroy", app, "--yes"])).toBe(`Destroyed app ${app}\n`);
    expect(exists("container", `sail-fly-${app}`)).toBe(false);
    for (const name of owned) expect(exists("volume", name), name).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(caddyDir(), "sites", `fly-${app}.caddy`))).toBe(false);
    await expect(exited).resolves.toBe(0);
    follower = undefined;
    expect(flyElsewhere(["apps", "create", app]).status).toBe(0);
    expect(flyElsewhere(["apps", "destroy", app, "--yes"]).status).toBe(0);
  });

  it("waits for every http_service check to pass before deploy returns", () => {
    const checked = `${app}-c`;
    NodeFS.writeFileSync(
      NodePath.join(appDir, "checks.toml"),
      `app = "${checked}"\n\n[http_service]\n  internal_port = 8080\n\n  [[http_service.checks]]\n    path = "/"\n\n  [[http_service.checks]]\n    path = "/unhealthy"\n`,
    );
    ok(["apps", "create", checked]);
    const failed = fly(["deploy", "-c", "checks.toml", "--image", image, "--wait-timeout", "20s"]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("timeout reached waiting for machine");
    ok(["apps", "destroy", checked, "--yes"]);
  });

  it("logs one call per invocation with the command's mutating flag", () => {
    fly(["--access-token=secret-one", "apps", "list", "-q"]);
    fly(["apps", "list", "-t", "secret-two", "-q"]);
    fly(["apps", "list", "-tsecret-three", "-q"]);
    fly(["-qtsecret-four", "apps", "list"]);
    fly(["apps", "list", "-jt", "secret-five"]);
    const text = NodeFS.readFileSync(NodePath.join(home, "calls.jsonl"), "utf8");
    expect(text).not.toContain("secret-");
    const logged = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: Array<string>; mutating: boolean; cwd: string });
    expect(logged).toHaveLength(calls);
    for (const call of logged) {
      const words = call.argv.filter(
        (arg, i) => !arg.startsWith("-") && !VALUE_FLAGS.has(call.argv[i - 1] ?? ""),
      );
      const command = Object.keys(MUTATING).find((key) => words.join(" ").startsWith(key));
      expect(command, call.argv.join(" ")).toBeDefined();
      expect(call.mutating, call.argv.join(" ")).toBe(MUTATING[command ?? ""]);
      expect([NodeFS.realpathSync(appDir), NodeFS.realpathSync(root)]).toContain(call.cwd);
    }
  });
});

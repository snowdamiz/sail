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
const TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z`;
// What the test app prints first: a CRLF line, and a progress meter's redraws before a line separator.
const LOG_REDRAWS = ["progress 10%\r", "\r 45%\r100%server\u2028ready"];
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
// flyctl's `env.IsCI`; with Depot, flyctl's default builder, none of them changes where it looks.
const CI_VARIABLES = ["CI", "GITHUB_ACTIONS", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "RUN_ID"];

const keys = (value: unknown) => Object.keys(value as object).toSorted();
const sorted = (list: ReadonlyArray<string>) => list.toSorted();

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Follower {
  readonly child: NodeChildProcess.ChildProcess;
  readonly output: () => string;
  /** Resolves once the follower has shown the app's `count`th start. */
  readonly sees: (count: number) => Promise<void>;
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
  // Docker refuses a closed IPv4 port at once; `localhost` tries `[::1]` in the VM and waits 30 s.
  const unpullable = `127.0.0.1:1/sail-fake-fly-test:${suffix}`;
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
  let followers: Array<Follower> = [];

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
    extraEnv: Readonly<Record<string, string | undefined>> = {},
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
  const follow = (
    args: ReadonlyArray<string>,
    extraEnv: Readonly<Record<string, string>>,
  ): Follower => {
    const child = NodeChildProcess.spawn("fly", args, {
      cwd: appDir,
      env: { ...env, ...extraEnv },
    });
    calls++;
    let output = "";
    let waits: Array<() => boolean> = [];
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      waits = waits.filter((check) => !check());
    });
    const sees = (count: number) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (output.split("serving initial configuration").length - 1 < count) return false;
          resolve();
          return true;
        };
        if (check()) return;
        const gone = () =>
          reject(new Error(`fly ${args.join(" ")} exited before it showed start ${count}`));
        if (child.exitCode !== null) return gone();
        waits.push(check);
        child.once("exit", gone);
      });
    const follower = { child, output: () => output, sees };
    followers.push(follower);
    return follower;
  };
  /** An app whose `fly.toml` has one check of `path` on `port`, the port the test app listens on. */
  const blueGreenApp = (name: string) => {
    const dir = NodePath.join(root, name);
    NodeFS.mkdirSync(dir);
    return {
      name,
      site: () => publicUrl(`${name}.localtest.me`),
      configure: (path: string, port: number) =>
        NodeFS.writeFileSync(
          NodePath.join(dir, "fly.toml"),
          `app = "${name}"\n\n[env]\n  PORT = "${port}"\n\n[http_service]\n  internal_port = ${port}\n\n  [[http_service.checks]]\n    path = "${path}"\n`,
        ),
      args: (strategy = "bluegreen", flags: ReadonlyArray<string> = []) => [
        "deploy",
        dir,
        "--image",
        image,
        "--local-only",
        "--ha=false",
        "--strategy",
        strategy,
        ...flags,
      ],
      live: () => ({
        machines: (json(["machine", "list", "-j", "-a", name]) as Array<{ id: string }>).map(
          (machine) => machine.id,
        ),
        serving: fly([
          "ssh",
          "console",
          "-a",
          name,
          "-q",
          "-C",
          "printenv FLY_MACHINE_ID",
        ]).stdout.trim(),
        containers: docker([
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=sail-fixture.fly-app=${name}`,
        ])
          .trim()
          .split("\n").length,
      }),
    };
  };
  /** A `docker` first on `PATH` that runs `lines` before it hands the call to the real one. */
  const dockerShim = (name: string, lines: ReadonlyArray<string>) => {
    const dir = NodePath.join(root, name);
    NodeFS.mkdirSync(dir);
    NodeFS.writeFileSync(
      NodePath.join(dir, "docker"),
      ["#!/bin/sh", "PATH=${PATH#*:}", ...lines, 'exec docker "$@"', ""].join("\n"),
      { mode: 0o755 },
    );
    return { PATH: `${dir}${NodePath.delimiter}${env.PATH}` };
  };

  beforeAll(() => {
    const build = NodePath.join(root, "image");
    NodeFS.mkdirSync(build, { recursive: true });
    NodeFS.mkdirSync(appDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(build, "Caddyfile"),
      `:{$PORT:8080} {\n\t@unchecked {\n\t\tpath /checked\n\t\tnot header X-Check yes\n\t}\n\trespond @unchecked 503\n\trespond /unhealthy 503\n\trespond /machine "{env.FLY_MACHINE_ID}"\n\trespond "proto={header.X-Forwarded-Proto} fly={header.Fly-Forwarded-Proto} port={header.X-Forwarded-Port} ssl={header.X-Forwarded-Ssl}"\n}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(build, "start.sh"),
      `printf '${LOG_REDRAWS.map((line) => line.replaceAll("%", "%%")).join("\\n")}\\n'\ncaddy run --config /etc/caddy/Caddyfile & pid=$!\nfor signal in INT TERM; do trap "echo $signal >> /data/signals; kill $pid; exit 0" $signal; done\nwait $pid\n`,
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
    grace_period = "0"
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
    for (const { child } of followers) child.kill("SIGTERM");
    for (const name of [
      app,
      `${app}-b`,
      `${app}-c`,
      `${app}-d`,
      `${app}-f`,
      `${app}-g`,
      `${app}-k`,
      `${app}-l`,
      `${app}-s`,
      `${app}-t`,
      `${app}-y`,
      `${app}-z`,
    ]) {
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
      ["interval", `${CHECK}    interval = "${"9".repeat(400)}s"\n`],
      ["unsupported value: +Inf", `${CHECK}    interval = inf\n`],
      ["unsupported value: NaN", `${CHECK}    timeout = nan\n`],
      ["headers", `${CHECK}    headers = { X-Check = 1 }\n`],
      [
        "checks",
        '[http_service]\n  internal_port = 8080\n  [http_service.checks]\n    path = "/"\n',
      ],
    ];
    for (const [field, body] of configs) {
      const file = NodePath.join(root, `bad-${NodeCrypto.randomBytes(3).toString("hex")}.toml`);
      NodeFS.writeFileSync(file, `app = "${app}"\n${body}`);
      const result = fly(["deploy", "-c", file, "--image", image, "--local-only"]);
      expect(result.status, body).toBe(1);
      expect(result.stderr, body).toMatch(
        /^Error: (failed loading app config|App configuration is not valid)/,
      );
      if (field !== "duplicate" && field !== "bare") expect(result.stderr, body).toContain(field);
    }
    const timeout = fly([
      "deploy",
      "--image",
      image,
      "--local-only",
      "--wait-timeout",
      "5sgarbage",
    ]);
    expect(timeout).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("invalid duration"),
    });
    expect(exists("container", `sail-fly-${app}`)).toBe(false);
  });

  it("refuses deploy flags flyctl refuses, before touching Docker", () => {
    expect(fly(["deploy", "--image", image, "--local-only", "--strategy", "bogus"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(
        "unsupported deployment strategy 'bogus'; Apps v2 supports the following strategies: canary, rolling, immediate, bluegreen",
      ),
    });
    expect(fly(["deploy", "--image", image, "--local-only", "--strategy", "canary"])).toMatchObject(
      {
        status: 1,
        stderr: expect.stringContaining(
          "canary deployment strategy is not supported when using mounted volumes",
        ),
      },
    );
    expect(fly(["deploy", "--image", unpullable, "--remote-only"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(`could not find image "${unpullable}"`),
    });
    expect(
      fly(["deploy", "--image", unpullable, "--remote-only", "--local-only", "--ha=false"]),
    ).toMatchObject({
      status: 1,
      stderr: "Error: failed to fetch an image or build from source: no docker daemon available\n",
    });
    expect(exists("container", `sail-fly-${app}`)).toBe(false);
  });

  it("looks in the local Docker daemon only with --local-only, in CI or not", () => {
    const local = `${app}-l`;
    ok(["apps", "create", local]);
    const noCi = Object.fromEntries(CI_VARIABLES.map((name) => [name, undefined]));
    for (const ci of [noCi, { ...noCi, CI: "" }, { ...noCi, GITHUB_ACTIONS: "true" }]) {
      expect(
        fly(["deploy", "-a", local, "--image", unpullable, "--ha=false"], ci, root),
        JSON.stringify(ci),
      ).toMatchObject({
        status: 1,
        stderr: expect.stringContaining(`could not find image "${unpullable}"`),
      });
    }
    expect(exists("container", `sail-fly-${local}`)).toBe(false);
    ok(["apps", "destroy", local, "--yes"]);
  });

  it("deploys behind Caddy with Fly Proxy's headers", async () => {
    const [volume] = volumes();
    const first = fly(["deploy", "--image", image, "--local-only", "--ha=false"]);
    expect(first).toMatchObject({ status: 0 });
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

  it("redeploys onto the same machine and volume, and logs follow the new container with only its lines", async () => {
    // Docker on a loaded VM: a stopped container lingers before its removal, so a follower can
    // ask for its logs just as it goes.
    const racy = dockerShim("slow-docker", [
      "for target; do :; done",
      "case $1 in",
      "rm) sleep 2 ;;",
      `logs) for _ in $(seq 100); do [ "$(docker inspect --format '{{.State.Running}}' "$target" 2>/dev/null)" = false ] || break; sleep 0.1; done ;;`,
      "esac",
    ]);
    const plainLogs = follow(["logs"], racy);
    const jsonLogs = follow(["logs", "--json"], racy);
    await Promise.all([plainLogs.sees(1), jsonLogs.sees(1)]);
    const before = machines() as Array<{ version: string }>;
    const volume = volumes()[0]?.id;

    const redeployed = fly(
      ["deploy", "--image", image, "--local-only", "-e", "EXTRA=1", "--strategy", "immediate"],
      racy,
    );
    expect(redeployed).toMatchObject({ status: 0 });
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
    await Promise.all([plainLogs.sees(2), jsonLogs.sees(2)]);
    const plainLine = new RegExp(`^${TIMESTAMP} app\\[${firstMachine}\\] iad \\[info\\] `);
    const lines = plainLogs.output().split("\n").slice(0, -1);
    const times = [...jsonLogs.output().matchAll(/^ {4}"timestamp": "(.*)",$/gm)].map(([, t]) => t);
    expect(times.length).toBeGreaterThan(1);
    expect({
      plain: lines.filter((line) => !plainLine.test(line)),
      json: times.filter((time) => !new RegExp(`^${TIMESTAMP}$`).test(time ?? "")),
    }).toEqual({ plain: [], json: [] });

    const noTail = ok(["logs", "--no-tail"]).trimEnd().split("\n");
    expect(noTail[0]).toMatch(new RegExp(`^\\S+Z app\\[${firstMachine}\\] iad \\[info\\] \\S`));
  });

  it("prints logs as a stream of flyctl's LogEntry JSON, keeping each app line whole", () => {
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
    const plain = ok(["logs", "--no-tail"]);
    expect({
      json: entries(raw)
        .map((logged) => logged.message)
        .filter((message) => LOG_REDRAWS.includes(String(message))),
      plain: LOG_REDRAWS.filter((line) =>
        plain.includes(`app[${firstMachine}] iad [info] ${line}\n`),
      ),
    }).toEqual({ json: LOG_REDRAWS, plain: LOG_REDRAWS });
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
    ok(["deploy", "--image", image, "--local-only"]);

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
      {
        type: "http",
        grace_period: "0s",
        path: "/checked",
        headers: [{ name: "X-Check", values: ["yes"] }],
      },
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
    const deployed = fly(["deploy", "-a", taken, "--image", image, "--local-only"]);
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
    expect(
      fly(["deploy", dir, "--remote-only", "--local-only", "--ha=false"], {}, root),
    ).toMatchObject({
      status: 1,
      stderr:
        "Error: failed to fetch an image or build from source: docker is unavailable to build the deployment image\n",
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
    const otherTag = `sail-fake-fly-test-other:${suffix}`;
    const alias = `registry.fly.io/${built}:deployment-backup`;
    docker(["tag", labelled, otherTag]);
    docker(["tag", labelled, alias]);
    ok(["apps", "destroy", built, "--yes"]);
    expect(
      docker(["image", "ls", "--format", "{{.Tag}}", `registry.fly.io/${built}`]).trim(),
      "of the app's repository only the alias someone added is left",
    ).toBe("deployment-backup");
    expect(exists("image", otherTag), "a tag someone else added survives").toBe(true);
    docker(["image", "rm", otherTag, alias]);
  });

  it("reads [deploy] strategy from fly.toml, which --strategy overrides", () => {
    const strategic = `${app}-t`;
    const dir = NodePath.join(root, "strategy-app");
    NodeFS.mkdirSync(dir, { recursive: true });
    const deployWith = (strategy: string, more = "", flags: ReadonlyArray<string> = []) => {
      NodeFS.writeFileSync(
        NodePath.join(dir, "fly.toml"),
        `app = "${strategic}"\n\n[deploy]\n  strategy = "${strategy}"\n${more}`,
      );
      return fly(
        ["deploy", dir, "--image", image, "--local-only", "--ha=false", ...flags],
        {},
        root,
      );
    };
    ok(["apps", "create", strategic]);
    const bogus = deployWith("bogus", "", ["--strategy", "rolling"]);
    expect(bogus).toMatchObject({ status: 1, stderr: "Error: App configuration is not valid\n" });
    expect(bogus.stdout).toContain(
      "unsupported deployment strategy 'bogus'; Apps v2 supports the following strategies: canary, rolling, immediate, bluegreen",
    );
    const mounts = '\n[[mounts]]\n  source = "data"\n  destination = "/data"\n';
    expect(deployWith("canary", mounts)).toMatchObject({
      status: 1,
      stdout: expect.stringContaining(
        "canary deployment strategy is not supported when using mounted volumes",
      ),
    });
    expect(exists("container", `sail-fly-${strategic}`)).toBe(false);
    expect(deployWith("bluegreen")).toMatchObject({ status: 0 });
    const [launched] = json(["machine", "list", "-j", "-a", strategic]) as Array<{ id: string }>;
    expect(deployWith("bluegreen")).toMatchObject({
      status: 1,
      stdout: expect.stringContaining(
        `Updating existing machines in '${strategic}' with bluegreen strategy\n`,
      ),
      stderr: `\nVerifying if app can be safely deployed \n\n[WARN] Machine ${launched?.id} [app] doesn't have healthchecks setup. We won't check its health.\n\nYou need to define at least 1 check in order to use blue-green deployments. Refer to https://fly.io/docs/reference/configuration/#services-tcp_checks\nError: app not in valid state for bluegreen deployments\n`,
    });
    // flyctl counts these checks too, so it would deploy both apps.
    for (const [table, more] of [
      ["[checks]", '\n[checks.alive]\n  type = "tcp"\n  port = 8080\n'],
      [
        "[[services]]",
        '\n[[services]]\n  internal_port = 8080\n  protocol = "tcp"\n\n  [[services.tcp_checks]]\n    interval = "15s"\n',
      ],
    ])
      expect(deployWith("bluegreen", more), table).toMatchObject({
        status: 1,
        stderr: `Error: fake fly does not model bluegreen deploys of an app with ${table}\n`,
      });
    expect(json(["machine", "list", "-j", "-a", strategic])).toMatchObject([
      { id: launched?.id, state: "started" },
    ]);
    expect(deployWith("bluegreen", "", ["--strategy", "immediate"]).stdout).toContain(
      `Updating existing machines in '${strategic}' with immediate strategy\n`,
    );
    ok(["apps", "destroy", strategic, "--yes"]);
  });

  it("moves traffic to a new machine in a bluegreen deploy before blue stops, and keeps it when the next one fails", async () => {
    const swapped = blueGreenApp(`${app}-g`);
    ok(["apps", "create", swapped.name]);
    swapped.configure("/", 8080);
    expect(fly(swapped.args(), {}, root)).toMatchObject({ status: 0 });
    const blue = swapped.live().serving;

    const answers = NodePath.join(root, "bluegreen-answers");
    const askOnStop = dockerShim("ask-on-stop", [
      `[ "$1" = stop ] && curl -s -w ' %{http_code}\\n' --cacert '${rootCertPath()}' '${swapped.site()}/machine' >> '${answers}'`,
    ]);
    swapped.configure("/", 9090);
    expect(fly(swapped.args(), askOnStop, root)).toMatchObject({ status: 0 });
    const green = swapped.live().serving;
    expect(green).not.toBe(blue);
    expect(
      NodeFS.readFileSync(answers, "utf8"),
      "green answers on its new port as blue starts to stop",
    ).toBe(`${green} 200\n`);
    expect(swapped.live()).toEqual({ machines: [green], serving: green, containers: 1 });
    await expect(get(`${swapped.site()}/machine`)).resolves.toMatchObject({
      status: 200,
      body: green,
    });

    swapped.configure("/unhealthy", 9090);
    const failed = fly(swapped.args("bluegreen", ["--wait-timeout", "2s"]), {}, root);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(
      /\nRolling back failed deployment\n {2}Deleted machine [0-9a-f]{14} \[app\]\nError: wait timeout\ncould not get all green machines to be healthy\n$/,
    );
    expect(swapped.live()).toEqual({ machines: [green], serving: green, containers: 1 });
    ok(["apps", "destroy", swapped.name, "--yes"]);
  });

  it("keeps blue serving when a bluegreen swap fails, and settles a killed one on the next deploy", async () => {
    const swapped = blueGreenApp(`${app}-k`);
    ok(["apps", "create", swapped.name]);
    swapped.configure("/", 8080);
    expect(fly(swapped.args(), {}, root)).toMatchObject({ status: 0 });
    const blue = swapped.live().serving;

    const intoPlace = `[ "$*" = "rename sail-fly-${swapped.name}_green sail-fly-${swapped.name}" ]`;
    const refused = fly(
      swapped.args(),
      dockerShim("refuse-rename", [
        `${intoPlace} && { echo 'Error response from daemon: injected' >&2; exit 1; }`,
      ]),
      root,
    );
    expect(refused.status).toBe(1);
    expect(swapped.live()).toEqual({ machines: [blue], serving: blue, containers: 1 });
    expect(refused.stderr).toMatch(
      /\nRolling back failed deployment\n {2}Deleted machine [0-9a-f]{14} \[app\]\nError: .*injected\nfailed to mark green machines as ready\n$/,
    );
    await expect(get(`${swapped.site()}/machine`)).resolves.toMatchObject({
      status: 200,
      body: blue,
    });

    // `run`, not `fly`: a killed fly never records its call.
    const killed = run(
      swapped.args(),
      dockerShim("kill-on-rename", [`${intoPlace} && { kill -9 $PPID; exit 1; }`]),
      root,
    );
    expect(killed.status).toBeNull();
    await expect(get(`${swapped.site()}/machine`)).resolves.toMatchObject({
      status: 200,
      body: blue,
    });
    expect(fly(swapped.args("immediate"), {}, root)).toMatchObject({ status: 0 });
    expect(swapped.live()).toEqual({ machines: [blue], serving: blue, containers: 1 });
    ok(["apps", "destroy", swapped.name, "--yes"]);
  });

  it("treats a home written with a trailing slash as the same home", () => {
    const slashed = `${app}-s`;
    const site = NodePath.join(caddyDir(), "sites", `fly-${slashed}.caddy`);
    const reservation = NodePath.join(fixturesRoot(), "names", "fly-app", slashed);
    expect(run(["apps", "create", slashed], { FAKE_FLY_HOME: `${slashHome}/` }, root).status).toBe(
      0,
    );
    const deployed = run(
      ["deploy", "-a", slashed, "--image", image, "--local-only", "--ha=false"],
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

  it("treats a home spelled through a symlink and by its real path as one home", () => {
    const linked = `${app}-y`;
    const volumeId = `vol_legacy${suffix}`;
    const link = `${root}-link`;
    NodeFS.symlinkSync(root, link);
    try {
      const spelled = NodePath.join(link, "sym-home");
      const real = NodePath.join(NodeFS.realpathSync(root), "sym-home");
      const site = NodePath.join(caddyDir(), "sites", `fly-${linked}.caddy`);
      const reservation = NodePath.join(fixturesRoot(), "names", "fly-app", linked);
      expect(run(["apps", "create", linked], { FAKE_FLY_HOME: spelled }, root).status).toBe(0);
      const deployed = run(
        ["deploy", "-a", linked, "--image", image, "--local-only", "--ha=false"],
        { FAKE_FLY_HOME: spelled },
        root,
      );
      expect(deployed.status, deployed.stderr).toBe(0);

      const record = NodePath.join(otherHome, "apps", `${linked}.json`);
      NodeFS.mkdirSync(NodePath.dirname(record), { recursive: true });
      NodeFS.copyFileSync(NodePath.join(real, "apps", `${linked}.json`), record);
      const refused = flyElsewhere(["apps", "destroy", linked, "--yes"]);
      expect(refused.status, "a record whose name another home holds").toBe(1);
      expect(refused.stderr).toContain("another fake fly home");
      expect(NodeFS.existsSync(record)).toBe(true);
      NodeFS.rmSync(record);
      expect(exists("container", `sail-fly-${linked}`)).toBe(true);

      // A volume a revision before canonical ids labeled with the hash of the spelled home.
      const legacy = `${app}-z`;
      const legacyId = NodeCrypto.createHash("sha256").update(spelled).digest("hex").slice(0, 12);
      expect(run(["apps", "create", legacy], { FAKE_FLY_HOME: spelled }, root).status).toBe(0);
      docker([
        "volume",
        "create",
        "--label",
        `sail-fixture.home=${legacyId}`,
        `sail-fly-vol-${volumeId}`,
      ]);
      const volumeRecord = NodePath.join(real, "volumes", `${volumeId}.json`);
      NodeFS.mkdirSync(NodePath.dirname(volumeRecord), { recursive: true });
      NodeFS.writeFileSync(
        volumeRecord,
        JSON.stringify({
          id: volumeId,
          app: legacy,
          name: "data",
          sizeGb: 1,
          region: "iad",
          zone: "a1b2",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      );
      const elsewhere = run(["apps", "destroy", legacy, "--yes"], { FAKE_FLY_HOME: real }, root);
      expect(elsewhere.status, "the other spelling never made that volume").toBe(1);
      expect(elsewhere.stderr).toContain(`volume sail-fly-vol-${volumeId}`);
      expect(NodeFS.existsSync(volumeRecord), "and its record stays").toBe(true);
      const own = run(["apps", "destroy", legacy, "--yes"], { FAKE_FLY_HOME: spelled }, root);
      expect(own.status, own.stderr).toBe(0);
      expect(
        exists("volume", `sail-fly-vol-${volumeId}`),
        "the spelling that made it removes it",
      ).toBe(false);

      const destroyed = run(["apps", "destroy", linked, "--yes"], { FAKE_FLY_HOME: real }, root);
      expect(destroyed.status, destroyed.stderr).toBe(0);
      expect(exists("container", `sail-fly-${linked}`)).toBe(false);
      expect(NodeFS.existsSync(site)).toBe(false);
      expect(NodeFS.existsSync(reservation)).toBe(false);
    } finally {
      NodeFS.rmSync(link);
      if (exists("volume", `sail-fly-vol-${volumeId}`))
        docker(["volume", "rm", "--force", `sail-fly-vol-${volumeId}`]);
    }
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
    const exited = Promise.all(
      followers.map(({ child }) => new Promise((resolve) => child.once("exit", resolve))),
    );
    expect(ok(["apps", "destroy", app, "--yes"])).toBe(`Destroyed app ${app}\n`);
    expect(exists("container", `sail-fly-${app}`)).toBe(false);
    for (const name of owned) expect(exists("volume", name), name).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(caddyDir(), "sites", `fly-${app}.caddy`))).toBe(false);
    await expect(exited).resolves.toEqual([0, 0]);
    followers = [];
    expect(flyElsewhere(["apps", "create", app]).status).toBe(0);
    expect(flyElsewhere(["apps", "destroy", app, "--yes"]).status).toBe(0);
  });

  it("waits for every http_service check to pass before deploy returns, except with immediate", () => {
    const checked = `${app}-c`;
    NodeFS.writeFileSync(
      NodePath.join(appDir, "checks.toml"),
      `app = "${checked}"\n\n[http_service]\n  internal_port = 8080\n\n  [[http_service.checks]]\n    path = "/"\n\n  [[http_service.checks]]\n    path = "/unhealthy"\n`,
    );
    ok(["apps", "create", checked]);
    const failed = fly([
      "deploy",
      "-c",
      "checks.toml",
      "--image",
      image,
      "--local-only",
      "--wait-timeout",
      "20s",
    ]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("timeout reached waiting for machine");
    const immediate = fly([
      "deploy",
      "-c",
      "checks.toml",
      "--image",
      image,
      "--local-only",
      "--strategy",
      "immediate",
      "--wait-timeout",
      "20s",
    ]);
    expect(immediate).toMatchObject({ status: 0 });
    expect(immediate.stdout).not.toContain("to become healthy");
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

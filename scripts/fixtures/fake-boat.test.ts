// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Drives the fake boat CLI and its Docker sandboxes end to end.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AUTH_HOST, caddyDir, publicUrl, removeSite, rootCertPath } from "./lib/caddy.ts";
import { docker, dockerSucceeds, hasDocker, DOCKER_TEST_TIMEOUT_MS } from "./lib/docker.ts";
import { homeId, takeLock } from "./lib/state.ts";
import { WORKER_ARG } from "./fake-boat/outbox-worker.ts";
import { waitForApproval } from "./fake-boat/sandbox/auth.ts";
import { requestFile } from "./fake-boat/sandbox/outbox.ts";

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Docker work on the VM every lane shares, not a hidden wait.
vi.setConfig({ testTimeout: DOCKER_TEST_TIMEOUT_MS, hookTimeout: DOCKER_TEST_TIMEOUT_MS });

const FAKE_DIR = NodePath.join(import.meta.dirname, "fake-boat");
const RECORDED = NodePath.join(FAKE_DIR, "recorded");
const RECORD = process.env.FAKE_BOAT_RECORD === "1";
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const SANDBOX_ID = /^bx-[0-9a-f]{12}$/;
const USER_CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const WEB_PORT = 8123;
const WEB_BODY = "hello from the sandbox\n";
const POLL = { timeout: 120_000, interval: 250 };
const OTHER_ORIGIN = "https://auth.localtest.me:8443";

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface SandboxJson {
  readonly id: string;
  readonly type: string;
  readonly state: string;
  readonly stoppedAt: string | null;
  readonly archiveAfter: string | null;
  readonly ttlSeconds: number | null;
}

interface ExecJson {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Failure {
  readonly code: string;
  readonly error: string;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  timeout = 0,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      { env, maxBuffer: 16 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        if (error?.killed) resolve({ status: null, stdout, stderr });
        else if (error && typeof error.code !== "number") reject(error);
        else resolve({ status: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
}

function jsonLines(text: string): ReadonlyArray<unknown> {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as unknown);
}

function lastJson<T>(text: string): T {
  const line = jsonLines(text).at(-1);
  if (line === undefined) throw new Error(`no JSON in: ${text}`);
  return line as T;
}

/** What changes from run to run, so recorded output can be compared by value. */
const VOLATILE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "<time>"],
  [/bx-[0-9a-f]{12}/g, "<sandbox>"],
  [/[A-Z2-9]{4}-[A-Z2-9]{4}/g, "<code>"],
  [/fake-boat-test-[0-9a-f]{6}/g, "fake-boat-test-<run>"],
  [/(\.localtest\.me):\d+/g, "$1"],
];
const VOLATILE_NUMBERS: ReadonlySet<string> = new Set(["seconds"]);

function stable(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return VOLATILE.reduce(
      (text, [pattern, placeholder]) => text.replace(pattern, placeholder),
      value,
    );
  }
  if (typeof value === "number" && VOLATILE_NUMBERS.has(key)) return "<number>";
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, field]) => [name, stable(field, name)]),
    );
  }
  return value;
}

function stableLines(text: string): ReadonlyArray<unknown> {
  const building = (line: unknown) =>
    typeof line === "object" && line !== null && "progress" in line && line.progress === "building";
  return jsonLines(text)
    .filter((line) => !building(line))
    .map((line) => stable(line));
}

async function matchesRecordedResult(file: string, output: string): Promise<void> {
  const path = NodePath.join(RECORDED, file);
  if (RECORD) {
    await NodeFSP.writeFile(path, output);
    return;
  }
  const recorded = await NodeFSP.readFile(path, "utf8");
  expect(stableLines(output), file).toEqual(stableLines(recorded));
}

async function freePort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return address.port;
}

function refuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

function connected(port: number): Promise<NodeNet.Socket> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function strippedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("FAKE_BOAT_") && !key.startsWith("FAKE_AUTH_"),
    ),
  );
}

const BOAT_PATH = `${FAKE_DIR}${NodePath.delimiter}${process.env.PATH ?? ""}`;

const SANDBOX = NodePath.join(FAKE_DIR, "sandbox");
const CLAUDE_PROBE_ARGV = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  "--setting-sources=user,project,local",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--settings",
  '{"disableAllHooks":true}',
];

function converse(
  script: string,
  args: ReadonlyArray<string>,
  frames: ReadonlyArray<object>,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly status: number | null; readonly replies: ReadonlyArray<unknown> }> {
  const child = NodeChildProcess.spawn("node", [NodePath.join(SANDBOX, script), ...args], { env });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stdin.end(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
  return new Promise((resolve) =>
    child.once("close", (status) => resolve({ status, replies: jsonLines(stdout) })),
  );
}

describe("fake claude and codex answering T3's provider probes", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fake-probe-test-"));
    const inherited = Object.entries(strippedEnv()).filter(
      ([key]) => !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "BROWSER"].includes(key),
    );
    env = {
      ...Object.fromEntries(inherited),
      HOME: home,
      FAKE_AUTH_APPROVE_SECS: "0",
      FAKE_AUTH_ORIGIN: OTHER_ORIGIN,
    };
  });

  afterAll(async () => {
    if (home) await NodeFSP.rm(home, { recursive: true, force: true });
  });

  it("reports the Claude account to the Agent SDK's initialize, signed out and after a pasted code", async () => {
    const probe = () =>
      converse(
        "claude.ts",
        CLAUDE_PROBE_ARGV,
        [
          {
            request_id: "a",
            type: "control_request",
            request: { subtype: "initialize", systemPrompt: [""] },
          },
          {
            request_id: "b",
            type: "control_request",
            request: { subtype: "get_usage", skip_behaviors: true },
          },
          { request_id: "c", type: "control_request", request: { subtype: "get_settings" } },
          {
            type: "user",
            message: { role: "user", content: "hi" },
            parent_tool_use_id: null,
            session_id: "",
          },
        ],
        env,
      );
    const signedOut = await probe();
    expect(signedOut.status).toBe(0);
    expect(signedOut.replies).toMatchObject([
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "a",
          response: { account: { tokenSource: "none" } },
        },
      },
      { type: "control_response", response: { subtype: "error", request_id: "b" } },
      { type: "control_response", response: { subtype: "error", request_id: "c" } },
      { type: "result", subtype: "error_during_execution", is_error: true },
    ]);
    expect(signedOut.replies[0]).not.toHaveProperty("response.response.account.email");

    const login = NodeChildProcess.spawn(
      "node",
      [NodePath.join(SANDBOX, "claude.ts"), "auth", "login"],
      { env },
    );
    let printed = "";
    login.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString()));
    await expect.poll(() => printed, POLL).toContain("Paste code here if prompted > ");
    const manual = /https:\/\/\S+\/claude\/authorize\?\S+/.exec(printed)?.[0] ?? "";
    expect(manual.startsWith(`${OTHER_ORIGIN}/claude/authorize?`), manual).toBe(true);
    expect(new URL(manual).searchParams.get("redirect_uri")).toBe(
      `${OTHER_ORIGIN}/claude/code/callback`,
    );
    const state = new URL(manual).searchParams.get("state") ?? "";
    login.stdin.write(`fake-code#${state}\n`);
    expect(await new Promise((resolve) => login.once("close", resolve))).toBe(0);

    const signedIn = await probe();
    expect(signedIn.replies[0]).toMatchObject({
      response: {
        response: {
          account: {
            tokenSource: "claude.ai",
            email: "fake-user@localtest.me",
            subscriptionType: "max",
            apiProvider: "firstParty",
          },
        },
      },
    });
  });

  it("reports the Codex account over app-server JSON-RPC, signed out and after a device code", async () => {
    const appServer = () =>
      converse(
        "codex.ts",
        ["app-server", "-c", "thread_unload_delay_secs=0"],
        [
          { id: 0, method: "account/read", params: {} },
          {
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.0" },
              capabilities: { experimentalApi: true },
            },
          },
          { method: "initialized" },
          { id: 2, method: "account/read", params: {} },
          { id: 3, method: "skills/list", params: { cwds: [home] } },
          { id: 4, method: "model/list", params: {} },
          { id: 5, method: "config/read", params: { includeLayers: false } },
        ],
        env,
      );
    const signedOut = await appServer();
    expect(signedOut.status).toBe(0);
    expect(signedOut.replies).toMatchObject([
      { id: 0, error: { message: "Not initialized" } },
      {
        id: 1,
        result: {
          codexHome: NodePath.join(home, ".codex"),
          userAgent: expect.stringMatching(/\/0\.200\.0/),
        },
      },
      { id: 2, result: { account: null, requiresOpenaiAuth: true } },
      { id: 3, result: { data: [] } },
      { id: 4, result: { data: [], nextCursor: null } },
      { id: 5, error: { code: -32601 } },
    ]);
    const cachePath = NodePath.join(home, ".codex", "models_cache.json");
    expect(NodeFS.existsSync(cachePath)).toBe(false);

    const login = await run(
      "node",
      [NodePath.join(SANDBOX, "codex.ts"), "login", "--device-auth"],
      env,
    );
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toContain(`\n   ${OTHER_ORIGIN}/codex/device\n`);
    expect(login.stdout).toMatch(/\n {3}[A-Z2-9]{4}-[A-Z2-9]{4}\n/);
    const signedIn = await appServer();
    expect(signedIn.replies[2]).toEqual({
      id: 2,
      result: {
        account: { type: "chatgpt", email: "fake-user@localtest.me", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    });
    const cache = JSON.parse(await NodeFSP.readFile(cachePath, "utf8")) as { fetched_at: string };
    const signedInAt = NodeFS.statSync(NodePath.join(home, ".codex", "auth.json")).mtimeMs;
    expect(Date.parse(cache.fetched_at)).toBeGreaterThanOrEqual(Math.floor(signedInAt));
  });
});

describe("fake sign-in codes", () => {
  it("never approves a code once it has expired, even one set to approve itself", async () => {
    const device = {
      kind: "boat" as const,
      code: "ABCD-EFGH",
      issuedAtMs: 0,
      approveAtMs: 0,
      expiresAtMs: 1_000,
    };
    const noLog = NodePath.join(NodeOS.tmpdir(), `no-auth-log-${process.pid}`);
    expect(await waitForApproval(device, noLog)).toBe("expired");
    const current = { ...device, expiresAtMs: Number.MAX_SAFE_INTEGER };
    expect(await waitForApproval(current, noLog)).toBe("approved");
  });
});

/** A process whose command line names the fake, as a real worker's does. */
function fakeBoatProcess() {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60_000)", NodePath.join("fake-boat", "boat.ts")],
    { stdio: "ignore" },
  );
  return {
    pid: child.pid ?? 0,
    [Symbol.asyncDispose]: async () => {
      child.kill();
      await NodeEvents.EventEmitter.once(child, "exit");
    },
  };
}

/** Holds `home`'s worker lock from the moment this resolves until it is disposed. */
async function workerLockHolder(home: string) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { takeLock } from ${JSON.stringify(NodePath.join(import.meta.dirname, "lib", "state.ts"))};
       if (!takeLock(${JSON.stringify(NodePath.join(home, "worker.lock"))}, 60_000)) process.exit(3);
       process.stdout.write("held\\n");
       setInterval(() => {}, 60_000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const [line] = await NodeEvents.EventEmitter.once(child.stdout, "data");
  expect(String(line)).toBe("held\n");
  return {
    [Symbol.asyncDispose]: async () => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    },
  };
}

function deadPid(): number {
  const ran = NodeChildProcess.spawnSync("true");
  if (ran.pid === undefined) throw new Error("no pid");
  return ran.pid;
}

describe("fake boat records and output", () => {
  let state: string;

  beforeAll(async () => {
    state = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fake-boat-state-test-"));
  });

  afterAll(async () => {
    if (state) await NodeFSP.rm(state, { recursive: true, force: true });
  });

  it("keeps each checkout's records in a home of its own unless FAKE_BOAT_HOME names one", async () => {
    const env = { ...strippedEnv(), XDG_STATE_HOME: state, PATH: BOAT_PATH };
    expect((await run("boat", ["--json", "status"], env)).status).toBe(0);
    const boatDir = NodePath.join(state, "sail-fixtures", "boat");
    const homes = await NodeFSP.readdir(boatDir);
    expect(homes).toEqual([expect.stringMatching(/^[0-9a-f]{12}$/)]);
    const calls = await NodeFSP.readFile(
      NodePath.join(boatDir, homes[0] ?? "", "calls.jsonl"),
      "utf8",
    );
    expect(calls).toContain('"argv":["--json","status"]');
  });

  it("prints JSON only when --json comes before any --", async () => {
    const env = { ...strippedEnv(), FAKE_BOAT_HOME: state, PATH: BOAT_PATH };
    const plain = await run("boat", ["status"], env);
    expect(plain.status).toBe(1);
    expect(lastJson<Failure>(plain.stderr)).toEqual({
      code: "json_required",
      error: expect.stringContaining("--json"),
    });
    expect((await run("boat", ["status", "--json"], env)).status).toBe(0);
    const late = await run("boat", ["exec", "bx-000000000000", "--", "echo", "--json"], env);
    expect(lastJson<Failure>(late.stderr).code).toBe("json_required");
  });

  it("warns on success that Sail Boat would run a real boat in ~/.ascii/bin instead", async () => {
    const userHome = await NodeFSP.mkdtemp(NodePath.join(state, "user-home-"));
    const env = {
      ...strippedEnv(),
      HOME: userHome,
      FAKE_BOAT_HOME: NodePath.join(userHome, "fake-boat"),
      PATH: BOAT_PATH,
    };
    const installed = NodePath.join(userHome, ".ascii", "bin", "boat");
    await NodeFSP.mkdir(installed, { recursive: true });
    expect((await run("boat", ["--json", "status"], env)).stderr, "a directory is no CLI").toBe("");
    await NodeFSP.rm(installed, { recursive: true });
    await NodeFSP.writeFile(installed, "#!/bin/sh\n", { mode: 0o755 });
    const warned = await run("boat", ["--json", "status"], env);
    expect(warned.status).toBe(0);
    expect(lastJson(warned.stdout)).toEqual({
      account: { identifier: null, signedIn: false, plan: null },
    });
    expect(warned.stderr.trim().split("\n")).toEqual([expect.stringContaining(installed)]);
    const failed = await run("boat", ["--json", "list", "--all"], env);
    expect(failed.stderr, "Sail Boat shows a failed call's stderr whole").toBe(
      `${JSON.stringify({ code: "not_signed_in", error: "Not signed in. Run boat onboard." })}\n`,
    );
  });

  it("lists saved snapshots while one still saves, and fails a command that needs that save", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(state, "saving-"));
    const id = "bx-000000000001";
    const name = "still-saving";
    await using reused = fakeBoatProcess();
    await NodeFSP.mkdir(NodePath.join(home, "sandboxes"));
    await NodeFSP.mkdir(NodePath.join(home, "snapshots"));
    await NodeFSP.mkdir(NodePath.join(home, "outbox", id), { recursive: true });
    const createdAt = "2026-01-01T00:00:00.000Z";
    await NodeFSP.writeFile(
      NodePath.join(home, "account.json"),
      JSON.stringify({ identifier: "saving@example.com", plan: "paid", signedInAt: createdAt }),
    );
    await NodeFSP.writeFile(
      NodePath.join(home, "sandboxes", `${id}.json`),
      JSON.stringify({ id, name, type: "small", createdAt, ttlSeconds: null, archiveAfter: null }),
    );
    await NodeFSP.writeFile(
      NodePath.join(home, "snapshots", "saved.json"),
      JSON.stringify({ name: "saved", sandboxId: id, createdAt, imageId: "sha256:saved" }),
    );
    await NodeFSP.writeFile(
      NodePath.join(
        home,
        "outbox",
        id,
        requestFile({ stage: "claimed", base: name, pid: reused.pid }),
      ),
      JSON.stringify({ sandboxId: id, name, requestedAt: createdAt }),
    );
    const base = { ...strippedEnv(), FAKE_BOAT_HOME: home, PATH: BOAT_PATH };
    const listed = await run("boat", ["--json", "snapshots"], base);
    expect({ status: listed.status, stdout: lastJson(listed.stdout) }).toEqual({
      status: 0,
      stdout: { named: [{ name: "saved", sandboxId: id, createdAt }] },
    });
    const env = { ...base, FAKE_BOAT_SETTLE_SECS: "1" };
    const commands = [
      ["snapshot", "rm", name],
      ["snapshot", id, name],
      ["new", "--name", "late", "--type", "small", "--from", name, "--no-auto-stop"],
      ["stop", id],
      ["delete", id, "--yes"],
    ];
    {
      await using _worker = await workerLockHolder(home);
      for (const args of commands) {
        const ran = await run("boat", ["--json", ...args], env);
        expect({ status: ran.status, stdout: ran.stdout }, args.join(" ")).toEqual({
          status: 1,
          stdout: "",
        });
        expect(lastJson<Failure>(ran.stderr).code, args.join(" ")).toBe("snapshot_in_progress");
      }
      const garbled = await run("boat", ["--json", "snapshot", "rm", name], {
        ...env,
        FAKE_BOAT_SETTLE_SECS: "soon",
      });
      expect(lastJson<Failure>(garbled.stderr).error).toContain("FAKE_BOAT_SETTLE_SECS");
    }
    // The claim's pid now runs another fake boat, but nobody holds the worker lock.
    const after = await run("boat", ["--json", "snapshot", "rm", name], env);
    expect(after.stderr, "a dead worker's claim holds nothing").not.toContain(
      "snapshot_in_progress",
    );
  });

  it("finishes only a stop it began, for a sandbox id, without touching anything else", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(state, "internal-"));
    const shim = NodePath.join(home, "bin");
    await NodeFSP.mkdir(shim);
    await NodeFSP.writeFile(
      NodePath.join(shim, "docker"),
      `#!/bin/sh\necho "$@" >> '${NodePath.join(home, "docker-ran")}'\n`,
      { mode: 0o755 },
    );
    const env = {
      ...strippedEnv(),
      FAKE_BOAT_HOME: home,
      PATH: `${shim}${NodePath.delimiter}${BOAT_PATH}`,
    };
    const until = "2100-01-01T00:00:00.000Z";
    const outside = NodePath.join(home, "x.json");
    await NodeFSP.writeFile(outside, JSON.stringify({ state: "stopping", until }));
    const id = "bx-000000000002";
    await NodeFSP.mkdir(NodePath.join(home, "sandboxes"));
    await NodeFSP.writeFile(
      NodePath.join(home, "sandboxes", `${id}.json`),
      JSON.stringify({
        id,
        name: "n",
        type: "small",
        createdAt: "2026-01-01T00:00:00.000Z",
        ttlSeconds: null,
        archiveAfter: null,
      }),
    );
    await NodeFSP.mkdir(NodePath.join(home, "transitions"));
    const theirs = NodePath.join(home, "transitions", `${id}.json`);
    const transition = JSON.stringify({ id, state: "stopping", until, token: "theirs" });
    await NodeFSP.writeFile(theirs, transition);
    for (const argv of [
      ["--finish-transition", "../x"],
      ["--finish-transition", id, "mine"],
      ["--finish-transition", id],
      ["--watch-outbox", "../x"],
    ]) {
      const ran = await run("boat", argv, env);
      expect(ran.status, argv.join(" ")).toBe(1);
    }
    expect(await NodeFSP.readFile(outside, "utf8")).toContain("stopping");
    expect(await NodeFSP.readFile(theirs, "utf8")).toBe(transition);
    expect(NodeFS.existsSync(NodePath.join(home, "docker-ran")), "no docker ran").toBe(false);
  });
});

describe.skipIf(!hasDocker())("fake boat", () => {
  let home: string;
  let otherHome: string;
  let env: NodeJS.ProcessEnv;
  let otherEnv: NodeJS.ProcessEnv;
  let sandbox: string;
  let otherSandbox: string;
  let fromSnapshot: string;
  let hostedUrl: string;
  /** Ahead of the real `docker` on the PATH of everything the fake starts from `env`. */
  let hookBin: string;
  const sandboxes: Array<string> = [];
  const children: Array<NodeChildProcess.ChildProcess> = [];
  const suffix = NodeCrypto.randomBytes(3).toString("hex");
  const snapshot = `fake-boat-test-${suffix}-a`;
  const insideSnapshot = `fake-boat-test-${suffix}-b`;
  const curl = (args: ReadonlyArray<string>) =>
    run("curl", ["-sS", "--max-time", "5", ...args], env);
  const snapshotImage = (forHome: string, name: string) =>
    `sail-fake-boat-snapshot:${homeId(forHome)}-${name}`;

  const json = (args: ReadonlyArray<string>, extra: NodeJS.ProcessEnv = {}) =>
    run("boat", ["--json", ...args], { ...env, ...extra });
  const failure = async (args: ReadonlyArray<string>, extra?: NodeJS.ProcessEnv) => {
    const ran = await json(args, extra);
    expect(ran.status, ran.stdout).toBe(1);
    return lastJson<Failure>(ran.stderr);
  };
  const exec = async (script: string, extra?: NodeJS.ProcessEnv, id = sandbox) => {
    const ran = await json(["exec", id, "--timeout", "60", "--", "bash", "-lc", script], extra);
    const result = lastJson<ExecJson>(ran.stdout);
    expect(ran.status).toBe(result.exitCode ?? 124);
    return result;
  };
  const info = async (id = sandbox) =>
    lastJson<{ sandbox: SandboxJson }>((await json(["info", id])).stdout).sandbox;
  const signIn = async (plan: "paid" | "trial", extra: NodeJS.ProcessEnv = {}) => {
    const approveNow = { ...extra, FAKE_AUTH_APPROVE_SECS: "0" };
    expect((await run("boat", ["--json", "onboard"], { ...env, ...approveNow })).status).toBe(0);
    const waited = await run("boat", ["--json", "onboard", "--wait"], {
      ...env,
      ...approveNow,
      FAKE_BOAT_PLAN: plan,
    });
    expect(waited.status, waited.stderr).toBe(0);
  };
  const background = (args: ReadonlyArray<string>, extra: NodeJS.ProcessEnv = {}) => {
    const child = NodeChildProcess.spawn("boat", args, { env: { ...env, ...extra } });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  };
  const waitForSignIn = async (extra: NodeJS.ProcessEnv = {}) => {
    const waiting = background(["--json", "onboard", "--wait"], extra);
    await expect.poll(waiting.stdout, POLL).toContain('"progress":"waiting"');
    return waiting;
  };
  const forward = async (remote: number) => {
    const local = await freePort();
    const forwarding = background([
      "forward",
      sandbox,
      "--remote",
      String(remote),
      "--local",
      String(local),
    ]);
    await expect.poll(() => refuses(local), POLL).toBe(false);
    return { local, child: forwarding.child, exited: forwarding.exited };
  };
  const pipesInside = async (port: number) =>
    Number((await exec(`pgrep -fc '[s]ocat - TCP:127.0.0.1:${port}'`)).stdout.trim());
  const authorizeLink = async (url: string) => {
    const page = await curl(["--cacert", rootCertPath(), url]);
    const href = /id="authorize" href="([^"]+)"/.exec(page.stdout)?.[1];
    if (!href) throw new Error(`no Authorize link in ${page.stdout}`);
    return href.replaceAll("&amp;", "&");
  };
  /** Types the code into the device page's form and submits it, as a person in a browser does. */
  const approveOnPage = async (pageUrl: string, code: string) => {
    const page = await curl(["--cacert", rootCertPath(), pageUrl]);
    const action = /<form action="([^"]+)"/.exec(page.stdout)?.[1];
    const field = /<input id="code" name="([^"]+)"/.exec(page.stdout)?.[1];
    if (!action || !field) throw new Error(`no approve form in ${page.stdout}`);
    const target = new URL(action, pageUrl);
    target.search = new URLSearchParams({ [field]: code }).toString();
    const approved = await curl(["--cacert", rootCertPath(), "--fail", target.toString()]);
    expect(approved.stdout, approved.stderr).toContain(code);
  };
  /** Writes a `docker` into `dir` that runs `script` first, with `$real` the real one and `$here` `dir`. */
  const writeDocker = async (dir: string, script: string) => {
    const real = NodeChildProcess.execFileSync("sh", ["-c", "command -v docker"], {
      encoding: "utf8",
    }).trim();
    const shim = NodePath.join(dir, "docker");
    await NodeFSP.writeFile(
      shim,
      `#!/bin/sh\nreal='${real}'\nhere='${dir}'\n${script}\nexec "$real" "$@"\n`,
      { mode: 0o755 },
    );
    return shim;
  };
  /** An env whose `docker` runs `script` first. */
  const withDocker = async (script: string) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(home, "docker-"));
    await writeDocker(dir, script);
    return { dir, env: { PATH: `${dir}${NodePath.delimiter}${BOAT_PATH}` } };
  };
  /** Makes every `docker` the fake's own processes run, detached ones included, run `script` first. */
  const hookDocker = async (script: string) => {
    const shim = await writeDocker(hookBin, script);
    return { [Symbol.asyncDispose]: () => NodeFSP.rm(shim, { force: true }) };
  };
  /** The command lines of every process on this computer that names `id`. */
  const processesFor = (id: string) =>
    NodeChildProcess.execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(id));
  const running = (id: string) =>
    docker(["inspect", "--format", "{{.State.Running}}", `sail-boat-${id}`]).trim() === "true";
  const workerIdle = (forHome: string) => {
    const release = takeLock(NodePath.join(forHome, "worker.lock"));
    release?.();
    return release !== undefined;
  };
  const names = async () =>
    lastJson<{ named: Array<{ name: string }> }>((await json(["snapshots"])).stdout).named.map(
      (row) => row.name,
    );
  const saveInside = async () =>
    expect(await exec(`boat snapshot ${sandbox} ${insideSnapshot} --json`)).toEqual({
      exitCode: 0,
      stdout: "{}\n",
      stderr: "",
    });
  const startWeb = () =>
    exec(
      `systemd-run --user --unit fake-boat-test-web node -e 'require("http").createServer((q, s) => s.end(${JSON.stringify(WEB_BODY)})).listen(${WEB_PORT}, "127.0.0.1")'`,
    );
  /** The watchdog's `boat snapshot` with no controller: plain `docker exec`, no host `boat`. */
  const askUnattended = (name: string) =>
    run(
      "docker",
      ["exec", "-u", "user", `sail-boat-${sandbox}`, "boat", "--json", "snapshot", sandbox, name],
      env,
      120_000,
    );
  const savedUnattended = { status: 0, stdout: "{}\n", stderr: "" };
  const linesOf = (file: string) =>
    NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  const starts = () => linesOf(NodePath.join(home, "starts.jsonl")).length;
  const state = async () => (await info()).state;
  const transitionFiles = () => {
    const dir = NodePath.join(home, "transitions");
    return NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir).filter((f) => f.includes(sandbox)) : [];
  };
  /** A `docker` that holds `docker start` until the test writes `release`, then starts or fails. */
  const holdStart = (then: "start" | "fail") =>
    withDocker(`if [ "$1" = start ]; then
  : > "$here/starting"
  i=0; while [ ! -e "$here/release" ] && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done
  ${then === "fail" ? "exit 1" : ":"}
fi`);

  beforeAll(async () => {
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fake-boat-test-"));
    otherHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fake-boat-test-other-"));
    const image = process.env.FAKE_BOAT_IMAGE
      ? { FAKE_BOAT_IMAGE: process.env.FAKE_BOAT_IMAGE }
      : {};
    hookBin = NodePath.join(home, "hook-bin");
    await NodeFSP.mkdir(hookBin);
    env = {
      ...strippedEnv(),
      ...image,
      FAKE_BOAT_HOME: home,
      PATH: `${hookBin}${NodePath.delimiter}${BOAT_PATH}`,
    };
    otherEnv = { ...env, FAKE_BOAT_HOME: otherHome };
  });

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    const homes = [home, otherHome].filter(Boolean);
    const labelled = (forHome: string, kind: "ps" | "images") => {
      const label = `label=sail-fixture.home=${homeId(forHome)}`;
      return docker(
        kind === "ps" ? ["ps", "-aq", "--filter", label] : ["images", "-q", "--filter", label],
      )
        .split("\n")
        .filter(Boolean);
    };
    // Containers first: a save still queued then fails at once instead of being waited out.
    for (const forHome of homes) {
      for (const id of labelled(forHome, "ps")) dockerSucceeds(["rm", "--force", "--volumes", id]);
    }
    for (const id of sandboxes) {
      dockerSucceeds(["rm", "--force", "--volumes", `sail-boat-${id}`]);
      removeSite(`boat-${id}-${WEB_PORT}`);
    }
    for (const forHome of homes) {
      try {
        await vi.waitFor(() => {
          if (!workerIdle(forHome)) throw new Error(`a snapshot worker for ${forHome} still runs`);
          const left = sandboxes.flatMap(processesFor);
          if (left.length > 0) throw new Error(`still running for a removed sandbox: ${left}`);
        }, POLL);
      } finally {
        for (const id of new Set(labelled(forHome, "images"))) {
          dockerSucceeds(["image", "rm", "--force", id]);
        }
      }
    }
    for (const name of [snapshot, insideSnapshot]) {
      dockerSucceeds(["image", "rm", "--force", `sail-fake-boat-snapshot:${name}`]);
    }
    for (const forHome of [home, otherHome]) {
      if (forHome) await NodeFSP.rm(forHome, { recursive: true, force: true });
    }
  });

  it("refuses all but sign-in while signed out, and unknown commands and flags", async () => {
    const status = await json(["status"]);
    expect(lastJson(status.stdout)).toEqual({
      account: { identifier: null, signedIn: false, plan: null },
    });
    expect((await failure(["list", "--all"])).code).toBe("not_signed_in");
    expect((await failure(["bogus"])).code).toBe("unknown_command");
    expect((await failure(["list", "--bogus"])).code).toBe("unknown_flag");
    const calls = (await NodeFSP.readFile(NodePath.join(home, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: Array<string>; exitCode: number });
    expect(calls.map((call) => [call.argv.join(" "), call.exitCode])).toEqual([
      ["--json status", 0],
      ["--json list --all", 1],
      ["--json bogus", 1],
      ["--json list --bogus", 1],
    ]);
  });

  it("lets a code nobody approves expire instead of approving itself", async () => {
    const shortLived = { FAKE_AUTH_CODE_TTL_SECS: "5" };
    expect((await json(["onboard"], shortLived)).status).toBe(0);
    expect((await failure(["onboard", "--wait"])).code).toBe("sign_in_expired");
    expect(lastJson((await json(["status"])).stdout)).toMatchObject({
      account: { signedIn: false },
    });
  });

  it("signs in once someone approves the code on the sign-in page", async () => {
    const started = await json(["onboard"]);
    const signIn = lastJson<{ url: string; userCode: string }>(started.stdout);
    expect(signIn.userCode).toMatch(USER_CODE);
    expect(signIn.url).toBe(`${publicUrl(AUTH_HOST)}/boat/device?code=${signIn.userCode}`);
    expect(lastJson((await json(["onboard"])).stdout)).toEqual(signIn);
    await matchesRecordedResult("onboard.jsonl", started.stdout);

    const waiting = await waitForSignIn({ FAKE_BOAT_PLAN: "trial" });
    await approveOnPage(signIn.url, signIn.userCode);
    expect(await waiting.exited, waiting.stderr()).toBe(0);
    const status = await json(["status"]);
    expect(lastJson(status.stdout)).toEqual({
      account: { identifier: "fake-user@localtest.me", signedIn: true, plan: "trial" },
    });
    await matchesRecordedResult("status.jsonl", status.stdout);
    expect((await failure(["onboard"])).code).toBe("already_signed_in");
  });

  it("never signs in from an attempt that a logout or a newer onboard replaced", async () => {
    expect((await json(["logout"])).status).toBe(0);
    const first = lastJson<{ url: string; userCode: string }>((await json(["onboard"])).stdout);
    const stale = await waitForSignIn({ FAKE_BOAT_PLAN: "trial" });
    expect((await json(["logout"])).status).toBe(0);
    const second = lastJson<{ url: string; userCode: string }>((await json(["onboard"])).stdout);
    expect(second.userCode).not.toBe(first.userCode);
    await approveOnPage(first.url, first.userCode);
    expect(await stale.exited).toBe(1);
    expect(lastJson<Failure>(stale.stderr()).code).toBe("sign_in_cancelled");
    expect(lastJson((await json(["status"])).stdout)).toMatchObject({
      account: { signedIn: false },
    });

    const current = await waitForSignIn({ FAKE_BOAT_PLAN: "trial" });
    await approveOnPage(second.url, second.userCode);
    expect(await current.exited, current.stderr()).toBe(0);
    expect(lastJson((await json(["status"])).stdout)).toMatchObject({
      account: { signedIn: true, plan: "trial" },
    });
  });

  it("creates a trial sandbox only with a lifetime of two hours or less", async () => {
    const create = ["new", "--name", "sail · fake boat test", "--type", "small"];
    const refused = await json([...create, "--no-auto-stop"]);
    expect(lastJson(refused.stderr)).toEqual({
      code: "trial_auto_stop_required",
      error: "Set a TTL of 2 hours or less",
    });
    await matchesRecordedResult("new-trial-refused.stderr", refused.stderr);
    expect((await failure([...create, "--ttl", "7201"])).code).toBe("trial_auto_stop_required");
    expect((await failure(["new", "--name", "x", "--type", "huge", "--ttl", "60"])).code).toBe(
      "invalid_type",
    );

    const created = await json([...create, "--ttl", "7200"]);
    expect(created.status, created.stderr).toBe(0);
    const result = lastJson<SandboxJson & { name: string }>(created.stdout);
    sandbox = result.id;
    sandboxes.push(sandbox);
    expect(result).toMatchObject({
      id: expect.stringMatching(SANDBOX_ID),
      name: "sail · fake boat test",
      type: "small",
      state: "running",
      stoppedAt: null,
      archiveAfter: expect.stringMatching(ISO),
      ttlSeconds: 7200,
    });
    await matchesRecordedResult("new.jsonl", created.stdout);
    const labels = docker([
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      `sail-boat-${sandbox}`,
    ]);
    expect(JSON.parse(labels)).toMatchObject({ "sail-fixture.home": homeId(home) });
  });

  it("reports the sandbox through info and list --all", async () => {
    const shown = await json(["info", sandbox]);
    expect(lastJson<{ sandbox: SandboxJson }>(shown.stdout).sandbox).toMatchObject({
      id: sandbox,
      state: "running",
      stoppedAt: null,
      ttlSeconds: 7200,
    });
    await matchesRecordedResult("info.jsonl", shown.stdout);
    const listed = await json(["list", "--all"]);
    const rows = lastJson<{ sandboxes: Array<SandboxJson> }>(listed.stdout).sandboxes;
    expect(rows.map((row) => row.id)).toEqual([sandbox]);
    await matchesRecordedResult("list.jsonl", listed.stdout);
    expect((await failure(["info", "bx-000000000000"])).code).toBe("not_found");
  });

  it("runs commands as user, with a systemd user manager, lingering, and the sign-in origin", async () => {
    const script =
      'id -un; pwd; systemctl --user status >/dev/null && echo answered; loginctl show-user "$(id -u)" --property=Linger --value';
    const ran = await json(["exec", sandbox, "--timeout", "30", "--", "bash", "-lc", script]);
    expect(lastJson(ran.stdout)).toEqual({
      exitCode: 0,
      stdout: "user\n/home/user\nanswered\nyes\n",
      stderr: "",
    });
    await matchesRecordedResult("exec.jsonl", ran.stdout);
    const failed = await json([
      "exec",
      sandbox,
      "--",
      "sh",
      "-c",
      "echo out; echo err >&2; exit 7",
    ]);
    expect(failed.status).toBe(7);
    expect(lastJson(failed.stdout)).toEqual({ exitCode: 7, stdout: "out\n", stderr: "err\n" });
    expect((await exec("printenv FAKE_AUTH_PROBE", { FAKE_AUTH_PROBE: "through" })).stdout).toBe(
      "through\n",
    );
    const forwarded = await json(["exec", sandbox, "--", "printenv", "FAKE_AUTH_ORIGIN"], {
      FAKE_AUTH_ORIGIN: OTHER_ORIGIN,
    });
    expect(lastJson<ExecJson>(forwarded.stdout).stdout).toBe(`${OTHER_ORIGIN}\n`);
    const expireAtOnce = { FAKE_AUTH_CODE_TTL_SECS: "0" };
    const deviceLink = async () =>
      (await exec("env -u FAKE_AUTH_ORIGIN codex login --device-auth", expireAtOnce)).stdout;
    expect(await deviceLink()).toContain(`\n   ${publicUrl(AUTH_HOST)}/codex/device\n`);
    const originFile = NodePath.join(home, "readonly", sandbox, "auth-origin");
    const origin = await NodeFSP.readFile(originFile, "utf8");
    await NodeFSP.writeFile(originFile, JSON.stringify(OTHER_ORIGIN));
    try {
      expect(await deviceLink(), "a CLI started without boat exec's env").toContain(
        `\n   ${OTHER_ORIGIN}/codex/device\n`,
      );
    } finally {
      await NodeFSP.writeFile(originFile, origin);
    }
    const slow = await json(["exec", sandbox, "--timeout", "1", "--", "sleep", "30"]);
    expect(lastJson<ExecJson>(slow.stdout).exitCode).toBeNull();
  });

  it("keeps a login shell's output clean when its script ends with exit", async () => {
    expect(await exec("echo out; echo err >&2; exit 0")).toEqual({
      exitCode: 0,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("waits out the pause a snapshot save takes instead of failing an exec", async () => {
    const name = `sail-boat-${sandbox}`;
    const shim = await withDocker(`if [ "$1" = inspect ] && [ ! -e "$here/seen" ]; then
  "$real" "$@"; status=$?
  : > "$here/seen"
  "$real" unpause ${name} >/dev/null
  exit $status
fi`);
    docker(["pause", name]);
    try {
      const ran = await json(["exec", sandbox, "--", "echo", "after the pause"], shim.env);
      expect(lastJson<ExecJson>(ran.stdout)).toMatchObject({
        exitCode: 0,
        stdout: "after the pause\n",
      });
      expect(NodeFS.existsSync(NodePath.join(shim.dir, "seen")), "it asked while paused").toBe(
        true,
      );
    } finally {
      dockerSucceeds(["unpause", name]);
    }
  });

  it("copies files both ways, landing owned by user", async () => {
    const local = NodePath.join(home, "notes.txt");
    await NodeFSP.writeFile(local, "kept across stops\n", { mode: 0o755 });
    expect((await json(["scp", local, `${sandbox}:notes.txt`])).status).toBe(0);
    expect((await json(["scp", local, `${sandbox}:/tmp/`])).status).toBe(0);
    expect((await exec("stat -c '%U %a %n' notes.txt /tmp/notes.txt")).stdout).toBe(
      "user 755 notes.txt\nuser 755 /tmp/notes.txt\n",
    );
    const back = NodePath.join(home, "back");
    await NodeFSP.mkdir(back);
    expect((await json(["scp", `${sandbox}:/home/user/notes.txt`, back])).status).toBe(0);
    expect(await NodeFSP.readFile(NodePath.join(back, "notes.txt"), "utf8")).toBe(
      "kept across stops\n",
    );
  });

  it("hosts a loopback port at a public URL over https and http", async () => {
    expect((await startWeb()).exitCode).toBe(0);
    const hosted = await json(["host", sandbox, String(WEB_PORT), "--public", "--localhost"]);
    hostedUrl = lastJson<{ url: string }>(hosted.stdout).url;
    expect(hostedUrl).toMatch(
      new RegExp(`^https://${sandbox}-${WEB_PORT}\\.localtest\\.me(:\\d+)?$`),
    );
    await matchesRecordedResult("host.jsonl", hosted.stdout);
    await expect
      .poll(async () => (await curl(["--cacert", rootCertPath(), hostedUrl])).stdout, POLL)
      .toBe(WEB_BODY);

    const plain = await json(["host", sandbox, String(WEB_PORT), "--public", "--localhost"], {
      FAKE_BOAT_HOST_SCHEME: "http",
    });
    const httpUrl = lastJson<{ url: string }>(plain.stdout).url;
    expect(httpUrl).toMatch(new RegExp(`^http://${sandbox}-${WEB_PORT}\\.localtest\\.me(:\\d+)?$`));
    expect((await curl([httpUrl])).stdout).toBe(WEB_BODY);
  });

  it("forwards a local port into the sandbox until killed, closing each pipe with its connection", async () => {
    const { local, child } = await forward(WEB_PORT);
    expect((await curl([`http://127.0.0.1:${local}/`])).stdout).toBe(WEB_BODY);
    const held = await connected(local);
    await expect.poll(() => pipesInside(WEB_PORT), POLL).toBe(1);
    held.destroy();
    await expect.poll(() => pipesInside(WEB_PORT), POLL).toBe(0);
    child.kill("SIGKILL");
    await expect.poll(() => refuses(local), POLL).toBe(true);

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const forwarding = await forward(WEB_PORT);
      const open = await connected(forwarding.local);
      await expect.poll(() => pipesInside(WEB_PORT), POLL).toBe(1);
      forwarding.child.kill(signal);
      await forwarding.exited;
      await expect.poll(() => refuses(forwarding.local), POLL).toBe(true);
      await expect.poll(() => pipesInside(WEB_PORT), POLL).toBe(0);
      open.destroy();
    }
  });

  it("waits out a pause that starts after the pause check, for exec, scp, and host", async () => {
    const name = `sail-boat-${sandbox}`;
    /** Pauses the sandbox right before the first `docker exec`, as a commit starting then does. */
    const pausedAtExec = async (args: ReadonlyArray<string>) => {
      const shim = await withDocker(`if [ "$1" = exec ] && [ ! -e "$here/refused" ]; then
  "$real" pause ${name} >/dev/null || exit 1
  "$real" "$@"; status=$?
  : > "$here/refused"
  exit $status
fi`);
      const refused = NodePath.join(shim.dir, "refused");
      const ran = json(args, shim.env);
      try {
        await expect.poll(() => NodeFS.existsSync(refused), POLL).toBe(true);
      } finally {
        dockerSucceeds(["unpause", name]);
      }
      const done = await ran;
      expect(done.status, `${args.join(" ")}: ${done.stderr}`).toBe(0);
      return done;
    };
    const ran = await pausedAtExec(["exec", sandbox, "--", "echo", "after the pause"]);
    expect(lastJson<ExecJson>(ran.stdout)).toMatchObject({
      exitCode: 0,
      stdout: "after the pause\n",
    });
    const local = NodePath.join(home, "notes.txt");
    await pausedAtExec(["scp", local, `${sandbox}:/tmp/paused.txt`]);
    const back = NodePath.join(home, "paused-back.txt");
    await pausedAtExec(["scp", `${sandbox}:/tmp/paused.txt`, back]);
    expect(await NodeFSP.readFile(back, "utf8")).toBe("kept across stops\n");
    await pausedAtExec(["host", sandbox, String(WEB_PORT), "--public", "--localhost"]);
    expect((await curl(["--cacert", rootCertPath(), hostedUrl])).stdout).toBe(WEB_BODY);
  });

  it("saves and lists named snapshots, from here and from inside", async () => {
    expect((await json(["snapshot", sandbox, snapshot])).status).toBe(0);
    const listed = await json(["snapshots"]);
    expect(lastJson(listed.stdout)).toEqual({
      named: [{ name: snapshot, sandboxId: sandbox, createdAt: expect.stringMatching(ISO) }],
    });
    await matchesRecordedResult("snapshots.jsonl", listed.stdout);

    expect((await exec("head -c 150M /dev/urandom > big")).exitCode).toBe(0);
    await saveInside();
    expect(
      dockerSucceeds(["image", "inspect", snapshotImage(home, insideSnapshot)]),
      "boat snapshot inside returns once the save is done",
    ).toBe(true);
    expect(await names()).toEqual([snapshot, insideSnapshot]);
  });

  it("fails boat snapshot inside with the reason when its save fails", async () => {
    await expect.poll(() => workerIdle(home), POLL).toBe(true);
    const failing = `fake-boat-test-${suffix}-failing`;
    await using _refused = await hookDocker(
      `[ "$1" = commit ] && { echo 'commit refused by the test' >&2; exit 1; }`,
    );
    const failed = await exec(`boat snapshot ${sandbox} ${failing} --json`);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toBe("");
    expect(lastJson<Failure>(failed.stderr)).toEqual({
      code: "snapshot_failed",
      error: expect.stringContaining("commit refused by the test"),
    });
    expect(dockerSucceeds(["image", "inspect", snapshotImage(home, failing)])).toBe(false);
    expect(await names()).toEqual([snapshot, insideSnapshot]);
  });

  it("never brings back a removed snapshot from a save still in flight", async () => {
    await expect.poll(() => workerIdle(home), POLL).toBe(true);
    const requested = {
      sandboxId: sandbox,
      name: insideSnapshot,
      requestedAt: "2026-01-01T00:00:00Z",
    };
    await NodeFSP.writeFile(
      NodePath.join(
        home,
        "outbox",
        sandbox,
        requestFile({ stage: "pending", base: insideSnapshot }),
      ),
      JSON.stringify(requested),
    );
    expect((await json(["snapshot", "rm", insideSnapshot])).status).toBe(0);
    await expect.poll(() => workerIdle(home), POLL).toBe(true);
    expect(await names(), "a save still in flight never brings a removed snapshot back").toEqual([
      snapshot,
    ]);
    expect(dockerSucceeds(["image", "inspect", snapshotImage(home, insideSnapshot)])).toBe(false);
    expect((await exec("rm big")).exitCode).toBe(0);
    const plain = await exec(`boat snapshot ${sandbox} ${insideSnapshot}`);
    expect(lastJson<Failure>(plain.stderr).code).toBe("json_required");
    expect((await failure(["snapshot", "rm", insideSnapshot])).code).toBe("not_found");
    expect((await failure(["snapshot", sandbox, "Not_Valid"])).code).toBe("invalid_name");
  });

  it("saves a snapshot asked for inside with no boat command running on the computer", async () => {
    await expect.poll(() => workerIdle(home), POLL).toBe(true);
    const name = `fake-boat-test-${suffix}-unattended`;
    expect(
      await askUnattended(name),
      "the watchdog's call with no controller, well inside its 10 minutes",
    ).toEqual(savedUnattended);
    expect(await names()).toEqual([snapshot, name]);
    expect((await json(["snapshot", "rm", name])).status).toBe(0);
  });

  it("stops and resumes, keeping files and the public host", async () => {
    expect((await json(["stop", sandbox])).status).toBe(0);
    const stopped = await json(["info", sandbox]);
    expect(lastJson<{ sandbox: SandboxJson }>(stopped.stdout).sandbox).toMatchObject({
      state: "stopped",
      stoppedAt: expect.stringMatching(ISO),
      archiveAfter: null,
    });
    await matchesRecordedResult("info-stopped.jsonl", stopped.stdout);
    expect((await failure(["exec", sandbox, "--", "true"])).code).toBe("sandbox_not_running");

    const expired = await json(["resume", sandbox, "--ttl", "7200"], {
      FAKE_BOAT_DISK_TTL_SECS: "0",
    });
    expect(expired.status).toBe(1);
    expect(lastJson<Failure>(expired.stderr).code).toBe("snapshot_data_expired");
    await matchesRecordedResult("resume-expired.stderr", expired.stderr);
    expect((await info()).state).toBe("stopped");

    const resumed = await json(["resume", sandbox, "--type", "default", "--ttl", "7200"]);
    expect(lastJson<SandboxJson>(resumed.stdout)).toMatchObject({
      id: sandbox,
      type: "default",
      state: "running",
      stoppedAt: null,
      archiveAfter: expect.stringMatching(ISO),
    });
    expect((await exec("cat notes.txt")).stdout).toBe("kept across stops\n");
    expect((await startWeb()).exitCode).toBe(0);
    await expect
      .poll(async () => (await curl(["--cacert", rootCertPath(), hostedUrl])).stdout, POLL)
      .toBe(WEB_BODY);
    const garbled = await failure(["resume", sandbox], { FAKE_BOAT_DISK_TTL_SECS: "soon" });
    expect(garbled).toEqual({
      code: "invalid_arguments",
      error: expect.stringContaining("FAKE_BOAT_DISK_TTL_SECS"),
    });
  });

  it("stops itself from inside, as the watchdog does", async () => {
    expect(await exec(`boat stop ${sandbox} --json`)).toEqual({
      exitCode: 0,
      stdout: "{}\n",
      stderr: "",
    });
    await expect.poll(async () => (await info()).state, POLL).toBe("stopped");
    const inside = await NodeFSP.readFile(
      NodePath.join(home, "outbox", sandbox, "calls.jsonl"),
      "utf8",
    );
    expect(inside).toContain(`"argv":["stop","${sandbox}","--json"]`);
    expect((await json(["resume", sandbox])).status).toBe(0);
  });

  it("reports usage since a time, and today's starts", async () => {
    const usage = await json(["usage", sandbox, "--since", "0"]);
    expect(lastJson(usage.stdout)).toEqual({ dollars: 0, seconds: expect.any(Number) });
    await matchesRecordedResult("usage.jsonl", usage.stdout);
    expect(lastJson((await json(["usage", sandbox, "--since", "4102444800"])).stdout)).toEqual({
      dollars: 0,
      seconds: 0,
    });
    const limits = await json(["limits", "--all"]);
    expect(lastJson(limits.stdout)).toEqual({ starts: { day: { used: 3, limit: 100 } } });
    await matchesRecordedResult("limits.jsonl", limits.stdout);
  });

  it("signs Claude in through its localhost callback, the way Sail Boat runs it", async () => {
    expect((await exec("claude auth status")).exitCode).toBe(1);
    const started = await exec(
      `d=$(mktemp -d); printf '#!/bin/sh\\necho "$1" > %s/url\\n' "$d" > "$d/browser"; chmod +x "$d/browser"; BROWSER="$d/browser" nohup script -qfec 'claude auth login' "$d/log" >/dev/null 2>&1 & echo "$d"`,
    );
    const dir = started.stdout.trim();
    await expect.poll(async () => (await exec(`cat ${dir}/url`)).stdout, POLL).toMatch(/^https:/);
    const url = new URL((await exec(`cat ${dir}/url`)).stdout.trim());
    expect(url.origin).toBe(publicUrl(AUTH_HOST));
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    expect(redirect.hostname).toBe("localhost");
    expect((await exec(`cat ${dir}/log`)).stdout).toContain("Paste code here if prompted > ");

    const { local, child } = await forward(Number(redirect.port));
    const callback = new URL(await authorizeLink(url.toString()));
    expect(callback.searchParams.get("state")).toBe(url.searchParams.get("state"));
    callback.host = `127.0.0.1:${local}`;
    expect((await curl([callback.toString()])).stdout).toContain("Signed in");
    child.kill("SIGKILL");
    await expect.poll(async () => (await exec("claude auth status")).exitCode, POLL).toBe(0);
    await expect
      .poll(async () => (await exec("pgrep -f 'claude auth logi[n]'")).exitCode, POLL)
      .toBe(1);
  });

  it("signs Claude in by a pasted code", async () => {
    expect((await exec("claude auth logout")).exitCode).toBe(0);
    expect((await exec("claude auth status")).exitCode).toBe(1);
    const started = await exec(
      `d=$(mktemp -d); mkfifo "$d/in"; nohup sh -c 'exec 3<>"$1/in"; exec script -qfec "claude auth login" "$1/log" <&3' sh "$d" >/dev/null 2>&1 & echo "$d"`,
    );
    const dir = started.stdout.trim();
    const auth = publicUrl(AUTH_HOST);
    const manual = new RegExp(`${RegExp.escape(auth)}/claude/authorize\\?\\S+`);
    await expect.poll(async () => (await exec(`cat ${dir}/log`)).stdout, POLL).toMatch(manual);
    const url = manual.exec((await exec(`cat ${dir}/log`)).stdout)?.[0] ?? "";
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(`${auth}/claude/code/callback`);
    const page = await curl(["--cacert", rootCertPath(), await authorizeLink(url)]);
    const code = /<pre id="code">([^<]+)<\/pre>/.exec(page.stdout)?.[1] ?? "";
    expect(code).toBe(`fake-code#${new URL(url).searchParams.get("state")}`);
    expect((await exec(`printf '%s\\n' '${code}' > ${dir}/in`)).exitCode).toBe(0);
    await expect.poll(async () => (await exec("claude auth status")).exitCode, POLL).toBe(0);
  });

  it("signs Codex in once its device code is approved on the page, else lets it expire", async () => {
    expect((await exec("codex login status")).exitCode).toBe(1);
    const expired = await exec("codex login --device-auth", { FAKE_AUTH_CODE_TTL_SECS: "5" });
    expect(expired.exitCode).toBe(1);
    expect(expired.stderr).toContain("device code expired");

    const started = await exec(
      'd=$(mktemp -d); nohup codex login --device-auth > "$d/log" 2>&1 & echo "$d"',
    );
    const dir = started.stdout.trim();
    const codeLine = /\n {3}([A-Z2-9]{4}-[A-Z2-9]{4})\n/;
    await expect.poll(async () => (await exec(`cat ${dir}/log`)).stdout, POLL).toMatch(codeLine);
    const log = (await exec(`cat ${dir}/log`)).stdout;
    const link = `${publicUrl(AUTH_HOST)}/codex/device`;
    expect(log).toContain(`\n   ${link}\n`);
    expect((await exec("codex login status")).exitCode).toBe(1);
    await approveOnPage(link, codeLine.exec(log)?.[1] ?? "");
    await expect
      .poll(async () => (await exec(`cat ${dir}/log`)).stdout, POLL)
      .toContain("Successfully logged in");
    expect((await exec("codex login status")).exitCode).toBe(0);

    expect((await exec("codex logout")).exitCode).toBe(0);
    const browser = await exec(
      `d=$(mktemp -d); printf '#!/bin/sh\\necho "$1" > %s/url\\n' "$d" > "$d/browser"; chmod +x "$d/browser"; BROWSER="$d/browser" nohup script -qfec 'codex login' "$d/log" >/dev/null 2>&1 & echo "$d"`,
    );
    const browserDir = browser.stdout.trim();
    await expect
      .poll(async () => (await exec(`cat ${browserDir}/url`)).stdout, POLL)
      .toMatch(/^https:/);
    const url = new URL((await exec(`cat ${browserDir}/url`)).stdout.trim());
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    const { local, child } = await forward(1455);
    const callback = new URL(await authorizeLink(url.toString()));
    callback.host = `127.0.0.1:${local}`;
    expect((await curl([callback.toString()])).stdout).toContain("Signed in");
    child.kill("SIGKILL");
    await expect.poll(async () => (await exec("codex login status")).exitCode, POLL).toBe(0);
  });

  it("saves a snapshot asked for inside, unattended, that a worker which died had claimed", async () => {
    await expect.poll(() => workerIdle(home), POLL).toBe(true);
    const name = `fake-boat-test-${suffix}-orphaned`;
    const outbox = NodePath.join(home, "outbox", sandbox);
    const pending = NodePath.join(outbox, requestFile({ stage: "pending", base: name }));
    let asked: Promise<Ran>;
    {
      // A live holder of the worker lock keeps the request unsaved until it is a dead worker's claim.
      await using _holder = await workerLockHolder(home);
      asked = askUnattended(name);
      await expect.poll(() => NodeFS.existsSync(pending), POLL).toBe(true);
      const claimed = requestFile({ stage: "claimed", base: name, pid: deadPid() });
      await NodeFSP.rename(pending, NodePath.join(outbox, claimed));
    }
    expect(await asked, "a dead worker's claim saves as if still queued").toEqual(savedUnattended);
    expect(await names()).toEqual([snapshot, name]);
    expect((await json(["snapshot", "rm", name])).status).toBe(0);
  });

  it("saves unattended in the watcher itself, starting no worker per poll", async () => {
    await expect.poll(() => workerIdle(home), POLL).toBe(true);
    const workers = NodePath.join(home, "worker-starts");
    const slowWorker = NodePath.join(home, "slow-worker.mjs");
    await NodeFSP.writeFile(
      slowWorker,
      [
        'import * as NodeFS from "node:fs";',
        `if (process.argv.includes(${JSON.stringify(WORKER_ARG)})) {`,
        `  NodeFS.appendFileSync(${JSON.stringify(workers)}, process.pid + "\\n");`,
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);",
        "}",
      ].join("\n"),
    );
    // Every Node process the new watcher starts loads it: a worker takes a second, as at load 40.
    const slowStart = { NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${slowWorker}`.trim() };
    expect((await json(["stop", sandbox])).status).toBe(0);
    expect((await json(["resume", sandbox], slowStart)).status).toBe(0);
    const name = `fake-boat-test-${suffix}-one-saver`;
    expect(await askUnattended(name)).toEqual(savedUnattended);
    expect(linesOf(workers).length, "worker processes started for one save").toBeLessThanOrEqual(1);
    expect((await json(["snapshot", "rm", name])).status).toBe(0);
  });

  it("keeps saving unattended after docker wait fails while the sandbox runs", async () => {
    await expect.poll(() => workerIdle(home), POLL).toBe(true);
    const failed = NodePath.join(home, "wait-failed");
    {
      await using _flaky = await hookDocker(
        `[ "$1" = wait ] && [ ! -e '${failed}' ] && { : > '${failed}'; exit 1; }`,
      );
      expect((await json(["stop", sandbox])).status).toBe(0);
      expect((await json(["resume", sandbox])).status).toBe(0);
      await expect.poll(() => NodeFS.existsSync(failed), POLL).toBe(true);
    }
    const name = `fake-boat-test-${suffix}-waited-again`;
    expect(await askUnattended(name), "the watcher outlived its failed docker wait").toEqual(
      savedUnattended,
    );
    expect((await json(["snapshot", "rm", name])).status).toBe(0);
  });

  it("counts every awake stretch since a time in usage, across a stop and resume", async () => {
    const awake = async (since: string) =>
      lastJson<{ seconds: number }>((await json(["usage", sandbox, "--since", since])).stdout)
        .seconds;
    const before = await awake("0");
    expect((await json(["stop", sandbox])).status).toBe(0);
    const { stoppedAt } = await info();
    expect((await json(["resume", sandbox])).status).toBe(0);
    expect(await awake("0"), "the stretch before the stop still counts").toBeGreaterThanOrEqual(
      before,
    );
    const sinceStop = String(Math.ceil(Date.parse(stoppedAt ?? "") / 1000));
    expect(await awake(sinceStop), "only the stretch since the resume").toBeLessThan(before);
  });

  it("returns from stop while it still stops, and from resume once running, with FAKE_BOAT_TRANSITION_SECS", async () => {
    const listed = async () =>
      lastJson<{ sandboxes: Array<SandboxJson> }>((await json(["list", "--all"])).stdout)
        .sandboxes.filter((row) => row.id === sandbox)
        .map((row) => row.state);
    expect(
      (await failure(["stop", sandbox], { FAKE_BOAT_TRANSITION_SECS: "soon" })).error,
    ).toContain("FAKE_BOAT_TRANSITION_SECS");
    expect(await state()).toBe("running");

    const held = await withDocker(`if [ "$1" = stop ]; then
  i=0; while [ ! -e "$here/release" ] && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done
fi`);
    const stopped = await json(["stop", sandbox], { FAKE_BOAT_TRANSITION_SECS: "1", ...held.env });
    try {
      expect(stopped).toMatchObject({ status: 0, stdout: "{}\n" });
      expect([await state(), ...(await listed())]).toEqual(["stopping", "stopping"]);
      expect((await failure(["exec", sandbox, "--", "true"])).code).toBe("sandbox_not_running");
      expect((await failure(["resume", sandbox])).code).toBe("sandbox_transitioning");
      expect((await failure(["extend", sandbox, "--ttl", "60"])).code).toBe(
        "sandbox_transitioning",
      );
      expect((await json(["stop", sandbox])).status, "Boat took the stop already").toBe(0);
    } finally {
      await NodeFSP.writeFile(NodePath.join(held.dir, "release"), "");
    }
    await expect.poll(state, POLL).toBe("stopped");
    expect((await info()).stoppedAt).toMatch(ISO);

    const startsBefore = starts();
    const resumes = [0, 1].map(() =>
      background(["--json", "resume", sandbox, "--ttl", "7200"], {
        FAKE_BOAT_TRANSITION_SECS: "10",
      }),
    );
    await expect.poll(state, POLL).toBe("resuming");
    for (const resuming of resumes) {
      expect(await resuming.exited, resuming.stderr()).toBe(0);
      expect(lastJson<SandboxJson>(resuming.stdout()).state, "returns once running").toBe(
        "running",
      );
      expect(resuming.stderr()).toBe("");
    }
    expect(starts() - startsBefore, "only one of the two resumes booted it").toBe(1);
    expect(await state(), "running once resume returns").toBe("running");
    const hosted = await json(["host", sandbox, String(WEB_PORT), "--public", "--localhost"]);
    expect(hosted.status, `host right after the resume: ${hosted.stderr}`).toBe(0);
    expect(await info()).toMatchObject({
      ttlSeconds: 7200,
      archiveAfter: expect.stringMatching(ISO),
    });
  });

  it("shows starting while a create boots, and returns once running, with FAKE_BOAT_TRANSITION_SECS", async () => {
    const creating = background(
      ["--json", "new", "--name", "starting", "--type", "small", "--ttl", "600"],
      { FAKE_BOAT_TRANSITION_SECS: "15" },
    );
    await expect.poll(creating.stdout, POLL).toContain('"progress":"creating"');
    const { id } = JSON.parse(creating.stdout().split("\n")[0] ?? "") as { readonly id: string };
    sandboxes.push(id);
    const stateOf = async () => {
      const shown = await json(["info", id]);
      return shown.status === 0
        ? lastJson<{ sandbox: SandboxJson }>(shown.stdout).sandbox.state
        : "";
    };
    expect(await stateOf(), "from the moment new prints the id").toBe("starting");
    const listed = lastJson<{ sandboxes: Array<SandboxJson> }>(
      (await json(["list", "--all"])).stdout,
    );
    expect(listed.sandboxes.find((row) => row.id === id)?.state).toBe("starting");
    expect((await failure(["exec", id, "--", "true"])).code).toBe("sandbox_not_running");
    expect((await failure(["resume", id])).code).toBe("sandbox_transitioning");
    expect(await creating.exited, creating.stderr()).toBe(0);
    expect(lastJson<SandboxJson>(creating.stdout()).state, "returns once running").toBe("running");
    expect(await stateOf()).toBe("running");
    expect((await json(["delete", id, "--yes"])).status).toBe(0);
  });

  it("counts no transition whose owner is gone, though its pid now runs another fake boat", async () => {
    expect(await state()).toBe("running");
    await NodeFSP.mkdir(NodePath.join(home, "transitions"), { recursive: true });
    const file = NodePath.join(home, "transitions", `${sandbox}.json`);
    await using reused = fakeBoatProcess();
    const until = "2100-01-01T00:00:00.000Z";
    const stale = { id: sandbox, state: "stopping", until, token: "gone", pid: reused.pid };
    try {
      for (const left of [
        JSON.stringify(stale),
        JSON.stringify({ ...stale, started: "Thu Jan  1 00:00:00 1970" }),
        JSON.stringify(stale).slice(0, 40),
      ]) {
        await NodeFSP.writeFile(file, left);
        expect(await state(), left).toBe("running");
      }
      const extended = await json(["extend", sandbox, "--ttl", "60"]);
      expect(extended.status, extended.stderr).toBe(0);
    } finally {
      await NodeFSP.rm(file, { force: true });
    }
  });

  it("writes no transition for a resume without FAKE_BOAT_TRANSITION_SECS, and nothing on stderr", async () => {
    expect((await json(["stop", sandbox])).status).toBe(0);
    const held = await holdStart("start");
    const resuming = background(["--json", "resume", sandbox], held.env);
    try {
      await expect
        .poll(() => NodeFS.existsSync(NodePath.join(held.dir, "starting")), POLL)
        .toBe(true);
      expect([await state(), transitionFiles()], "Docker's own state while it boots").toEqual([
        "stopped",
        [],
      ]);
    } finally {
      await NodeFSP.writeFile(NodePath.join(held.dir, "release"), "");
    }
    expect(await resuming.exited, resuming.stderr()).toBe(0);
    expect(lastJson<SandboxJson>(resuming.stdout()).state).toBe("running");
    expect(resuming.stderr()).toBe("");
  });

  it("reports Docker's own state at once after a resume in flight is killed", async () => {
    expect((await json(["stop", sandbox])).status).toBe(0);
    const held = await holdStart("fail");
    try {
      const killed = background(["--json", "resume", sandbox], {
        FAKE_BOAT_TRANSITION_SECS: "1",
        ...held.env,
      });
      await expect.poll(state, POLL).toBe("resuming");
      killed.child.kill("SIGKILL");
      await killed.exited;
      expect([await state(), running(sandbox)], "as Sail Boat's next wake reads it").toEqual([
        "stopped",
        false,
      ]);
    } finally {
      await NodeFSP.writeFile(NodePath.join(held.dir, "release"), "");
    }
    const slowBoot = await withDocker(`[ "$1" = start ] && sleep 2`);
    const resumed = await json(["resume", sandbox], {
      FAKE_BOAT_TRANSITION_SECS: "1",
      ...slowBoot.env,
    });
    expect(resumed, "the next wake's resume, booting past its window").toMatchObject({
      status: 0,
      stderr: "",
    });
    expect(lastJson<SandboxJson>(resumed.stdout).state).toBe("running");
  });

  it("stops a sandbox when its lifetime ends, with nobody calling boat", async () => {
    expect((await failure(["extend", sandbox, "--ttl", "7201"])).code).toBe(
      "trial_auto_stop_required",
    );
    expect((await json(["extend", sandbox, "--ttl", "2"])).status).toBe(0);
    await expect.poll(() => running(sandbox), POLL).toBe(false);
    expect((await info()).state).toBe("stopped");
    expect((await json(["resume", sandbox, "--ttl", "7200"])).status).toBe(0);
    expect((await info()).state).toBe("running");
  });

  it("keeps another home's sandboxes and same-named snapshots apart", async () => {
    const other = (args: ReadonlyArray<string>) => run("boat", ["--json", ...args], otherEnv);
    await signIn("paid", { FAKE_BOAT_HOME: otherHome });
    const created = await other(["new", "--name", "other", "--type", "small", "--no-auto-stop"]);
    expect(created.status, created.stderr).toBe(0);
    otherSandbox = lastJson<SandboxJson>(created.stdout).id;
    sandboxes.push(otherSandbox);
    const marked = await other(["exec", otherSandbox, "--", "bash", "-lc", "echo other > marker"]);
    expect(lastJson<ExecJson>(marked.stdout).exitCode).toBe(0);
    expect((await other(["snapshot", otherSandbox, snapshot])).status).toBe(0);
    const ids = async (ran: Promise<Ran>) =>
      lastJson<{ sandboxes: Array<SandboxJson> }>((await ran).stdout).sandboxes.map(
        (row) => row.id,
      );
    expect(await ids(other(["list", "--all"]))).toEqual([otherSandbox]);
    expect(await ids(json(["list", "--all"]))).toEqual([sandbox]);
    const labels = docker([
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      `sail-boat-${otherSandbox}`,
    ]);
    expect(JSON.parse(labels)).toMatchObject({ "sail-fixture.home": homeId(otherHome) });
    expect(dockerSucceeds(["image", "inspect", snapshotImage(otherHome, snapshot)])).toBe(true);
    expect(dockerSucceeds(["image", "inspect", snapshotImage(home, snapshot)])).toBe(true);
  });

  it("reports a snapshot request it cannot save instead of dropping it or failing later commands", async () => {
    const other = (args: ReadonlyArray<string>) => run("boat", ["--json", ...args], otherEnv);
    const outbox = NodePath.join(otherHome, "outbox", otherSandbox);
    const gone = `fake-boat-test-${suffix}-gone`;
    const request = {
      sandboxId: otherSandbox,
      name: gone,
      requestedAt: "1970-01-01T00:00:00.000Z",
    };
    expect(dockerSucceeds(["rm", "--force", "--volumes", `sail-boat-${otherSandbox}`])).toBe(true);
    await NodeFSP.writeFile(
      NodePath.join(outbox, `${gone}.snapshot.json`),
      JSON.stringify(request),
    );
    await NodeFSP.writeFile(NodePath.join(outbox, "junk.snapshot.json"), "not json");
    const statuses: Array<number | null> = [];
    const reported = async () => {
      const listed = await other(["snapshots"]);
      statuses.push(listed.status);
      return jsonLines(listed.stderr);
    };
    await expect
      .poll(reported, POLL)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "snapshot_failed", name: gone }),
          expect.objectContaining({ code: "snapshot_failed", name: "junk" }),
        ]),
      );
    expect(new Set(statuses)).toEqual(new Set([0]));
    expect((await other(["status"])).status).toBe(0);
    expect(dockerSucceeds(["image", "inspect", snapshotImage(otherHome, gone)])).toBe(false);
    expect((await other(["delete", otherSandbox, "--yes"])).status).toBe(0);
    expect(lastJson((await other(["list", "--all"])).stdout)).toEqual({ sandboxes: [] });
    expect((await other(["snapshot", "rm", snapshot])).status).toBe(0);
  });

  it("creates a paid sandbox from its own home's snapshot with no lifetime", async () => {
    expect((await json(["logout"])).status).toBe(0);
    expect((await failure(["list", "--all"])).code).toBe("not_signed_in");
    await signIn("paid");
    const resave = `echo resaved > resaved && head -c 150M /dev/urandom > big && boat snapshot ${sandbox} ${snapshot} --json && rm big`;
    expect((await exec(resave)).exitCode).toBe(0);
    const created = await json([
      "new",
      "--name",
      "from snapshot",
      "--type",
      "small",
      "--from",
      snapshot,
      "--no-auto-stop",
    ]);
    expect(created.status, created.stderr).toBe(0);
    const result = lastJson<SandboxJson>(created.stdout);
    fromSnapshot = result.id;
    sandboxes.push(fromSnapshot);
    expect(result).toMatchObject({ state: "running", archiveAfter: null, ttlSeconds: null });
    expect((await exec("cat notes.txt", {}, fromSnapshot)).stdout).toBe("kept across stops\n");
    expect((await exec("cat resaved", {}, fromSnapshot)).stdout, "the save just asked for").toBe(
      "resaved\n",
    );
    expect((await exec("test -e marker", {}, fromSnapshot)).exitCode).toBe(1);
    expect((await json(["extend", fromSnapshot, "--ttl", "9000"])).status).toBe(0);
    expect((await info(fromSnapshot)).ttlSeconds).toBe(9000);
  });

  it("keeps the old size and lifetime when a resume cannot boot", async () => {
    expect((await exec("sudo ln -sf /bin/false /sbin/init", {}, fromSnapshot)).exitCode).toBe(0);
    expect((await json(["stop", fromSnapshot])).status).toBe(0);
    for (const extra of [{}, { FAKE_BOAT_TRANSITION_SECS: "5" }]) {
      const resume = ["resume", fromSnapshot, "--type", "large", "--ttl", "60"];
      expect((await failure(resume, extra)).code).toBe("boot_failed");
      expect(await info(fromSnapshot)).toMatchObject({
        type: "small",
        state: "stopped",
        ttlSeconds: 9000,
      });
    }
  });

  it("deletes sandboxes with nothing left behind, keeping named snapshots", async () => {
    expect((await failure(["delete", sandbox])).code).toBe("confirmation_required");
    expect(processesFor(sandbox), "a running sandbox has its watcher").not.toEqual([]);
    for (const id of [sandbox, fromSnapshot]) {
      expect((await json(["delete", id, "--yes"])).status).toBe(0);
      await expect.poll(() => processesFor(id), POLL).toEqual([]);
      expect(dockerSucceeds(["container", "inspect", `sail-boat-${id}`])).toBe(false);
      expect(
        NodeFS.existsSync(NodePath.join(caddyDir(), "sites", `boat-${id}-${WEB_PORT}.caddy`)),
      ).toBe(false);
    }
    expect(lastJson((await json(["list", "--all"])).stdout)).toEqual({ sandboxes: [] });
    const named = lastJson<{ named: Array<{ name: string }> }>((await json(["snapshots"])).stdout);
    expect(named.named.map((row) => row.name)).toEqual([snapshot]);
    expect((await json(["snapshot", "rm", snapshot])).status).toBe(0);
    const calls = (await NodeFSP.readFile(NodePath.join(home, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: Array<string>; mutating: boolean });
    const mutating = (sub: string) => calls.find((call) => call.argv[1] === sub)?.mutating;
    expect([mutating("info"), mutating("new"), mutating("delete")]).toEqual([false, true, true]);
  });
});

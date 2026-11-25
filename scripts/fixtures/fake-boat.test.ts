// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Drives the fake boat CLI and its Docker sandboxes end to end.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { caddyDirInUse, removeSite, rootCertPath } from "./lib/caddy.ts";
import { dockerSucceeds, hasDocker } from "./lib/docker.ts";

const FAKE_DIR = NodePath.join(import.meta.dirname, "fake-boat");
const RECORDED = NodePath.join(FAKE_DIR, "recorded");
const RECORD = process.env.FAKE_BOAT_RECORD === "1";
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const SANDBOX_ID = /^bx-[0-9a-f]{12}$/;
const WEB_PORT = 8123;
const WEB_BODY = "hello from the sandbox\n";
const POLL = { timeout: 30_000, interval: 250 };

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface SandboxJson {
  readonly id: string;
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

function run(command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      { env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
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

function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, field]) => [key, shapeOf(field)]),
    );
  }
  return typeof value;
}

async function matchesRecordedResult(file: string, output: string): Promise<void> {
  const path = NodePath.join(RECORDED, file);
  if (RECORD) {
    await NodeFSP.writeFile(path, output);
    return;
  }
  const recorded = await NodeFSP.readFile(path, "utf8");
  expect(shapeOf(lastJson(output)), file).toEqual(shapeOf(lastJson(recorded)));
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
    const inherited = Object.entries(process.env).filter(
      ([key]) =>
        !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "BROWSER"].includes(key) &&
        !key.startsWith("FAKE_AUTH_"),
    );
    env = { ...Object.fromEntries(inherited), HOME: home, FAKE_AUTH_APPROVE_SECS: "0" };
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
    const state = /[?&]state=([^&\s]+)/.exec(printed)?.[1] ?? "";
    login.stdin.write(`fake-code#${decodeURIComponent(state)}\n`);
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

describe.skipIf(!hasDocker())("fake boat", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let sandbox: string;
  let fromSnapshot: string;
  let hostedUrl: string;
  const sandboxes: Array<string> = [];
  const forwards: Array<NodeChildProcess.ChildProcess> = [];
  const suffix = NodeCrypto.randomBytes(3).toString("hex");
  const snapshot = `fake-boat-test-${suffix}-a`;
  const insideSnapshot = `fake-boat-test-${suffix}-b`;
  const curl = (args: ReadonlyArray<string>) =>
    run("curl", ["-sS", "--max-time", "5", ...args], env);

  const json = (args: ReadonlyArray<string>, extra: NodeJS.ProcessEnv = {}) =>
    run("boat", ["--json", ...args], { ...env, ...extra });
  const failure = async (args: ReadonlyArray<string>, extra?: NodeJS.ProcessEnv) => {
    const ran = await json(args, extra);
    expect(ran.status, ran.stdout).toBe(1);
    return lastJson<{ code: string; error: string }>(ran.stderr);
  };
  const exec = async (script: string, extra?: NodeJS.ProcessEnv, id = sandbox) => {
    const ran = await json(["exec", id, "--timeout", "60", "--", "bash", "-lc", script], extra);
    const result = lastJson<ExecJson>(ran.stdout);
    expect(ran.status).toBe(result.exitCode ?? 124);
    return result;
  };
  const info = async (id = sandbox) =>
    lastJson<{ sandbox: SandboxJson }>((await json(["info", id])).stdout).sandbox;
  const signIn = async (plan: "paid" | "trial") => {
    expect((await json(["onboard"])).status).toBe(0);
    expect((await json(["onboard", "--wait"], { FAKE_BOAT_PLAN: plan })).status).toBe(0);
  };
  const forward = async (remote: number) => {
    const local = await freePort();
    const child = NodeChildProcess.spawn(
      "boat",
      ["forward", sandbox, "--remote", String(remote), "--local", String(local)],
      { env, stdio: "ignore" },
    );
    forwards.push(child);
    await expect.poll(() => refuses(local), POLL).toBe(false);
    return { local, child };
  };
  const authorizeLink = async (url: string) => {
    const page = await curl(["--cacert", rootCertPath(), url]);
    const href = /id="authorize" href="([^"]+)"/.exec(page.stdout)?.[1];
    if (!href) throw new Error(`no Authorize link in ${page.stdout}`);
    return href.replaceAll("&amp;", "&");
  };
  const startWeb = () =>
    exec(
      `systemd-run --user --unit fake-boat-test-web node -e 'require("http").createServer((q, s) => s.end(${JSON.stringify(WEB_BODY)})).listen(${WEB_PORT}, "127.0.0.1")'`,
    );

  beforeAll(async () => {
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fake-boat-test-"));
    const inherited = Object.entries(process.env).filter(
      ([key]) => !key.startsWith("FAKE_BOAT_") && !key.startsWith("FAKE_AUTH_"),
    );
    env = {
      ...Object.fromEntries(inherited),
      FAKE_BOAT_HOME: home,
      FAKE_AUTH_APPROVE_SECS: "1",
      PATH: `${FAKE_DIR}${NodePath.delimiter}${process.env.PATH ?? ""}`,
    };
    if (process.env.FAKE_BOAT_IMAGE) env.FAKE_BOAT_IMAGE = process.env.FAKE_BOAT_IMAGE;
  });

  afterAll(async () => {
    for (const child of forwards) child.kill("SIGKILL");
    for (const id of sandboxes) {
      dockerSucceeds(["rm", "--force", "--volumes", `sail-boat-${id}`]);
      removeSite(`boat-${id}-${WEB_PORT}`);
    }
    for (const name of [snapshot, insideSnapshot]) {
      dockerSucceeds(["image", "rm", "--force", `sail-fake-boat-snapshot:${name}`]);
    }
    if (home) await NodeFSP.rm(home, { recursive: true, force: true });
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

  it("signs in through onboard and onboard --wait, and lets an unapproved code expire", async () => {
    const neverApproved = { FAKE_AUTH_APPROVE_SECS: "never", FAKE_AUTH_CODE_TTL_SECS: "1" };
    expect((await json(["onboard"], neverApproved)).status).toBe(0);
    expect((await failure(["onboard", "--wait"])).code).toBe("sign_in_expired");

    const started = await json(["onboard"]);
    const signIn = lastJson<{ url: string; userCode: string }>(started.stdout);
    expect(signIn.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(signIn.url).toBe(`https://auth.localtest.me/boat/device?code=${signIn.userCode}`);
    expect(lastJson((await json(["onboard"])).stdout)).toEqual(signIn);
    await matchesRecordedResult("onboard.jsonl", started.stdout);

    expect((await json(["onboard", "--wait"], { FAKE_BOAT_PLAN: "trial" })).status).toBe(0);
    const status = await json(["status"]);
    expect(lastJson(status.stdout)).toEqual({
      account: { identifier: "fake-user@localtest.me", signedIn: true, plan: "trial" },
    });
    await matchesRecordedResult("status.jsonl", status.stdout);
    expect((await failure(["onboard"])).code).toBe("already_signed_in");
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
    const result = lastJson<SandboxJson & { name: string; type: string }>(created.stdout);
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

  it("runs commands as user, with a systemd user manager and lingering", async () => {
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
    const slow = await json(["exec", sandbox, "--timeout", "1", "--", "sleep", "30"]);
    expect(lastJson<ExecJson>(slow.stdout).exitCode).toBeNull();
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

  it("forwards a local port into the sandbox until killed", async () => {
    const { local, child } = await forward(WEB_PORT);
    expect((await curl([`http://127.0.0.1:${local}/`])).stdout).toBe(WEB_BODY);
    child.kill("SIGKILL");
    await expect.poll(() => refuses(local), POLL).toBe(true);
  });

  it("saves, lists, and removes named snapshots, from here and from inside", async () => {
    expect((await json(["snapshot", sandbox, snapshot])).status).toBe(0);
    const listed = await json(["snapshots"]);
    expect(lastJson(listed.stdout)).toEqual({
      named: [{ name: snapshot, sandboxId: sandbox, createdAt: expect.stringMatching(ISO) }],
    });
    await matchesRecordedResult("snapshots.jsonl", listed.stdout);

    expect(await exec(`boat snapshot ${sandbox} ${insideSnapshot} --json`)).toEqual({
      exitCode: 0,
      stdout: "{}\n",
      stderr: "",
    });
    const named = lastJson<{ named: Array<{ name: string }> }>((await json(["snapshots"])).stdout);
    expect(named.named.map((row) => row.name)).toEqual([snapshot, insideSnapshot]);
    expect(dockerSucceeds(["image", "inspect", `sail-fake-boat-snapshot:${insideSnapshot}`])).toBe(
      true,
    );

    expect((await json(["snapshot", "rm", insideSnapshot])).status).toBe(0);
    expect(dockerSucceeds(["image", "inspect", `sail-fake-boat-snapshot:${insideSnapshot}`])).toBe(
      false,
    );
    expect((await failure(["snapshot", "rm", insideSnapshot])).code).toBe("not_found");
    expect((await failure(["snapshot", sandbox, "Not_Valid"])).code).toBe("invalid_name");
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

    const resumed = await json(["resume", sandbox, "--type", "default", "--ttl", "7200"]);
    expect(lastJson<SandboxJson & { type: string }>(resumed.stdout)).toMatchObject({
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
  });

  it("stops a sandbox once its lifetime ends", async () => {
    expect((await failure(["extend", sandbox, "--ttl", "7201"])).code).toBe(
      "trial_auto_stop_required",
    );
    expect((await json(["extend", sandbox, "--ttl", "2"])).status).toBe(0);
    await expect.poll(async () => (await info()).state, POLL).toBe("stopped");
    expect((await json(["resume", sandbox, "--ttl", "7200"])).status).toBe(0);
    expect((await info()).state).toBe("running");
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
    expect(lastJson(limits.stdout)).toEqual({ starts: { day: { used: 4, limit: 100 } } });
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
    const manual = /https:\/\/auth\.localtest\.me\/claude\/authorize\?\S+/;
    await expect.poll(async () => (await exec(`cat ${dir}/log`)).stdout, POLL).toMatch(manual);
    const url = manual.exec((await exec(`cat ${dir}/log`)).stdout)?.[0] ?? "";
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      "https://auth.localtest.me/claude/code/callback",
    );
    const page = await curl(["--cacert", rootCertPath(), await authorizeLink(url)]);
    const code = /<pre id="code">([^<]+)<\/pre>/.exec(page.stdout)?.[1] ?? "";
    expect(code).toBe(`fake-code#${new URL(url).searchParams.get("state")}`);
    expect((await exec(`printf '%s\\n' '${code}' > ${dir}/in`)).exitCode).toBe(0);
    await expect.poll(async () => (await exec("claude auth status")).exitCode, POLL).toBe(0);
  });

  it("signs Codex in with a device code, which can expire, and by callback", async () => {
    expect((await exec("codex login status")).exitCode).toBe(1);
    const expired = await exec("codex login --device-auth", {
      FAKE_AUTH_APPROVE_SECS: "never",
      FAKE_AUTH_CODE_TTL_SECS: "1",
    });
    expect(expired.exitCode).toBe(1);
    expect(expired.stderr).toContain("device code expired");

    const started = await exec(
      'd=$(mktemp -d); nohup codex login --device-auth > "$d/log" 2>&1 & echo "$d"',
    );
    const dir = started.stdout.trim();
    await expect
      .poll(async () => (await exec(`cat ${dir}/log`)).stdout, POLL)
      .toContain("Successfully logged in");
    const log = (await exec(`cat ${dir}/log`)).stdout;
    const code = /device\?code=([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(log)?.[1];
    expect(log).toContain(`\n   ${code}\n`);
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

  it("creates a paid sandbox from a snapshot with no lifetime", async () => {
    expect((await json(["logout"])).status).toBe(0);
    expect((await failure(["list", "--all"])).code).toBe("not_signed_in");
    await signIn("paid");
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
    expect((await json(["extend", fromSnapshot, "--ttl", "9000"])).status).toBe(0);
    expect((await info(fromSnapshot)).ttlSeconds).toBe(9000);
  });

  it("deletes sandboxes with nothing left behind, keeping named snapshots", async () => {
    expect((await failure(["delete", sandbox])).code).toBe("confirmation_required");
    for (const id of [sandbox, fromSnapshot]) {
      expect((await json(["delete", id, "--yes"])).status).toBe(0);
      expect(dockerSucceeds(["container", "inspect", `sail-boat-${id}`])).toBe(false);
      expect(
        NodeFS.existsSync(NodePath.join(caddyDirInUse(), "sites", `boat-${id}-${WEB_PORT}.caddy`)),
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

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "../../../packages/contracts/src/auth.ts";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "../../../packages/contracts/src/environment.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "../../../packages/contracts/src/orchestrationV2.ts";
import { WS_METHODS } from "../../../packages/contracts/src/rpc.ts";
import { checkWire } from "./check.ts";
import replayFixture from "./incumbent-replay-v2.json" with { type: "json" };
import { checkReplay } from "./replay.ts";
import incumbent from "./incumbent-v2.json" with { type: "json" };

const repo = NodeURL.fileURLToPath(new URL("../../..", import.meta.url));
const cliPath = NodePath.join(repo, "apps/server/src/bin.ts");
const exec = NodeUtil.promisify(NodeChildProcess.execFile);

async function readOrigin(userdata: string, pid: number | undefined, signal: AbortSignal) {
  const watcher = NodeFS.watch(userdata);
  const changes = NodeEvents.EventEmitter.on(watcher, "change", { signal });
  try {
    while (true) {
      const contents = await NodeFSP.readFile(
        NodePath.join(userdata, "server-runtime.json"),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (contents !== undefined) {
        const state: unknown = JSON.parse(contents);
        NodeAssert.ok(
          typeof state === "object" &&
            state !== null &&
            "pid" in state &&
            state.pid === pid &&
            "origin" in state &&
            typeof state.origin === "string",
          "Expected the fixture server runtime record",
        );
        const origin = new URL(state.origin);
        NodeAssert.equal(origin.hostname, "127.0.0.1");
        return origin;
      }
      const change = await changes.next();
      NodeAssert.ok(!change.done, "Runtime state watcher closed");
    }
  } finally {
    watcher.close();
    await changes.return?.();
  }
}

interface ServerFixture {
  readonly origin: URL;
  readonly workspaceRoot: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly issue: (...scopes: AuthEnvironmentScope[]) => Promise<string>;
}

async function withServerFixture(
  run: (fixture: ServerFixture) => Promise<void>,
  withReplayProvider = false,
) {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sail-wire-"));
  const userdata = NodePath.join(home, "userdata");
  const workspaceRoot = NodePath.join(home, "project");
  try {
    await Promise.all([NodeFSP.mkdir(userdata), NodeFSP.mkdir(workspaceRoot)]);
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
    if (withReplayProvider) {
      await NodeFSP.writeFile(
        NodePath.join(userdata, "settings.json"),
        JSON.stringify({
          providerInstances: {
            devReplay: {
              displayName: "Replay (dev)",
              driver: "acpRegistry",
              config: {
                source: "local",
                commandPath: process.execPath,
                commandArgs: [NodePath.join(repo, "apps/server/scripts/dev-replay-agent.ts")],
              },
            },
          },
        }),
      );
      const git = (...args: string[]) => exec("git", args, { cwd: workspaceRoot, env });
      await git("init", "--quiet", "--initial-branch=main");
      await git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "--message",
        "Replay fixture",
      );
    }
    const server = NodeChildProcess.spawn(
      process.execPath,
      [cliPath, "serve", "--host", "127.0.0.1", "--base-dir", home, "--startup-pairing", "off"],
      { cwd: home, env, stdio: ["ignore", "ignore", "inherit"] },
    );
    const stopped = NodeEvents.EventEmitter.once(server, "close");
    const startup = new AbortController();
    try {
      const origin = await Promise.race([
        readOrigin(
          userdata,
          server.pid,
          AbortSignal.any([startup.signal, AbortSignal.timeout(20_000)]),
        ),
        stopped.then(([code, signal]) => {
          throw new Error(`Fixture server stopped during startup (${code ?? signal})`);
        }),
      ]);
      const issue = async (...scopes: AuthEnvironmentScope[]) => {
        const { stdout } = await exec(
          process.execPath,
          [
            cliPath,
            "auth",
            "session",
            "issue",
            "--base-dir",
            home,
            "--token-only",
            ...scopes.flatMap((scope) => ["--scope", scope]),
          ],
          { cwd: home, env, timeout: 10_000 },
        );
        return stdout.trim();
      };
      await run({ origin, issue, workspaceRoot, home, env });
    } finally {
      startup.abort();
      const forceStop = setTimeout(() => server.kill("SIGKILL"), 5_000);
      server.kill();
      try {
        await stopped;
      } finally {
        clearTimeout(forceStop);
      }
    }
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
}

it("matches the incumbent websocket frames and HTTP resume and alignment responses", async () => {
  expect(incumbent.sessionScopes).toEqual([AuthOrchestrationReadScope]);
  expect(incumbent.socket.path).toBe(
    `/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
  );
  expect(incumbent.http.at(-1)?.headers).toEqual({
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  });
  expect(incumbent.socket.steps.flatMap((step) => step.send?.tag ?? [])).toEqual([
    ORCHESTRATION_V2_WS_METHODS.getThreadTitles,
    ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
    WS_METHODS.projectsMutate,
    ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ]);

  await withServerFixture(async ({ origin, workspaceRoot, issue, home, env }) => {
    const writer = await issue(AuthOrchestrationOperateScope);
    for (const payload of [{ ...incumbent.seed.create, workspaceRoot }, incumbent.seed.remove]) {
      const response = await fetch(new URL("/api/projects/mutate", origin), {
        method: "POST",
        headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      NodeAssert.equal(response.status, 200, `Seeding ${payload.type}: ${await response.text()}`);
    }
    const reader = await issue(AuthOrchestrationReadScope);
    await exec(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("./check.ts", import.meta.url)), origin.href],
      { cwd: home, env: { ...env, SAIL_WIRE_READ_TOKEN: reader }, timeout: 20_000 },
    );

    const changed = structuredClone(incumbent);
    const replay = changed.socket.steps
      .flatMap((step) => step.receive?.values ?? [])
      .find((item) => item.kind === "project.removed");
    NodeAssert.ok(replay && "sequence" in replay);
    replay.sequence = 3;
    await expect(checkWire(origin, reader, changed)).rejects.toThrow("Socket fixture step 10");
  });
});

it("matches the published Replay transcript across reconnect, command retry, and scope denial", async () => {
  await withServerFixture(async ({ origin, workspaceRoot, issue }) => {
    const read = await issue(AuthOrchestrationReadScope);
    const operate = await issue(AuthOrchestrationReadScope, AuthOrchestrationOperateScope);
    const result = await checkReplay(origin, { read, operate }, workspaceRoot);
    expect(result.resumedThrough).toBeGreaterThan(result.disconnectedAt);
  }, true);
});

it("rejects a changed reply in the Replay reference", async () => {
  const changed = structuredClone(replayFixture);
  const reply = changed.expected.messages.at(-1);
  NodeAssert.ok(reply);
  reply.text += " Extra reply text.";
  await withServerFixture(async ({ origin, workspaceRoot, issue }) => {
    const read = await issue(AuthOrchestrationReadScope);
    const operate = await issue(AuthOrchestrationReadScope, AuthOrchestrationOperateScope);
    await expect(checkReplay(origin, { read, operate }, workspaceRoot, changed)).rejects.toThrow(
      "Replayed conversation messages",
    );
  }, true);
});

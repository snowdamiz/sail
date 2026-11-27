import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeStream from "node:stream";
import { expect, test, vi } from "vite-plus/test";

const { homedir, createServer } = vi.hoisted(() => ({
  homedir: vi.fn(),
  createServer: vi.fn(() => ({ listen() {} })),
}));

vi.mock("node:os", async (importOriginal) => ({ ...(await importOriginal()), homedir }));
vi.mock("node:http", () => ({ createServer }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  const proc = new Map([
    ["/proc/stat", "cpu 0 0 0 100"],
    ["/proc/sys/kernel/random/boot_id", "fixture-boot"],
    ["/proc/1/stat", `1 (init) ${Array(20).fill("0").join(" ")}`],
  ]);
  return {
    ...fs,
    readFileSync: (path, ...args) => proc.get(path) ?? fs.readFileSync(path, ...args),
  };
});

async function fixture(onTestFinished, threads = []) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sail-watchdog-"));
  onTestFinished(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    NodeFS.rmSync(home, { recursive: true, force: true });
  });
  vi.resetModules();
  vi.useFakeTimers();
  homedir.mockReturnValue(home);
  createServer.mockClear();
  vi.stubGlobal("fetch", async () => Response.json({ threads }));

  const configDir = NodePath.join(home, ".sail-boat");
  const databaseDir = NodePath.join(home, ".t3", "userdata");
  NodeFS.mkdirSync(configDir);
  NodeFS.mkdirSync(databaseDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(configDir, "config.json"),
    JSON.stringify({
      sandbox: "fixture",
      bootId: "fixture-boot:0",
      secret: "fixture",
      sleepAfterSecs: 3600,
    }),
  );
  const db = new NodeSqlite.DatabaseSync(NodePath.join(databaseDir, "statev2.sqlite"));
  onTestFinished(() => db.close());
  db.exec(`
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY, event_type TEXT, aggregate_kind TEXT,
      application_event_version INTEGER, stream_id TEXT
    );
  `);
  await import("./watchdog.mjs");
  await vi.advanceTimersByTimeAsync(0);

  const [[handler]] = createServer.mock.calls;
  const request = async (method, url, body = {}) => {
    let status;
    let payload;
    await handler(
      Object.assign(NodeStream.Readable.from([JSON.stringify(body)]), {
        method,
        url,
        headers: { authorization: "Bearer fixture" },
      }),
      {
        writeHead(code) {
          status = code;
        },
        end(json) {
          payload = JSON.parse(json);
        },
      },
    );
    return { status, payload };
  };
  return { db, request };
}

test("a new person event cancels Sleep now once", async ({ onTestFinished }) => {
  const { db, request } = await fixture(onTestFinished);
  const append = db.prepare(
    "INSERT INTO orchestration_events (event_type, aggregate_kind, application_event_version, stream_id) VALUES (?, 'thread', 2, 'thread')",
  );

  expect(await request("POST", "/drain")).toMatchObject({
    status: 200,
    payload: { phase: "draining" },
  });
  append.run("turn.completed");
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await request("GET", "/status")).payload.phase).toBe("draining");

  append.run("thread.pinned");
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await request("GET", "/status")).payload.phase).toBe("active");

  await request("POST", "/drain");
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await request("GET", "/status")).payload.phase).toBe("draining");
});

test("Sleep now allows a lone held approval and blocks independent work beside it", async ({
  onTestFinished,
}) => {
  const { db, request } = await fixture(onTestFinished, [
    {
      id: "thread",
      activeProviderThreadId: "provider",
      activeRunId: "run",
      status: "waiting",
      pendingRuntimeRequest: { id: "approval", kind: "command_execution_approval", blocking: true },
    },
  ]);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_turn_items (
      thread_id TEXT, run_id TEXT, type TEXT, status TEXT, node_id TEXT, provider_turn_id TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (
      runtime_request_id TEXT, node_id TEXT, thread_id TEXT, status TEXT, kind TEXT,
      provider_turn_id TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT, parent_node_id TEXT, run_id TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (
      thread_id TEXT, provider_thread_id TEXT, payload_json TEXT
    );
    INSERT INTO orchestration_v2_projection_runs VALUES ('run', 'waiting');
    INSERT INTO orchestration_v2_projection_turn_items
      VALUES ('thread', 'run', 'command_execution', 'pending', 'command', 'turn', '{}');
    INSERT INTO orchestration_v2_projection_nodes VALUES ('gate', 'command', 'run');
    INSERT INTO orchestration_v2_projection_runtime_requests
      VALUES ('approval', 'gate', 'thread', 'pending', 'command_execution_approval', 'turn', '{}');
  `);

  expect(await request("POST", "/drain")).toMatchObject({
    status: 200,
    payload: { phase: "draining", waitingThreads: 1, workingThreads: 0 },
  });

  db.exec(`
    INSERT INTO orchestration_v2_projection_turn_items
      VALUES ('thread', 'run', 'command_execution', 'running', 'background', 'turn', '{}');
  `);
  expect(await request("POST", "/drain")).toMatchObject({
    status: 409,
    payload: { error: "an agent is working", waitingThreads: 1, workingThreads: 1 },
  });
});

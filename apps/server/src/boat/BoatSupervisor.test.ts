// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - A fake sail-boatd reports to a plain node:http listener that stands in for this server's origin.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { BoatError, type BoatEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "../config.ts";
import * as BoatDaemonBinary from "./BoatDaemonBinary.ts";
import * as BoatSupervisor from "./BoatSupervisor.ts";

const DAEMON_ENV = [
  "SAIL_HOME",
  "SAIL_DESKTOP_CLI",
  "SAIL_DESKTOP_ORIGIN",
  "SAIL_BOAT_DATA_DIR",
  "SAIL_BOAT_CONTROL_PORT",
  "SAIL_BOATD_EXIT_ON_STDIN_EOF",
  "ELECTRON_RUN_AS_NODE",
] as const;

interface CliRun {
  readonly argv: ReadonlyArray<string>;
  readonly electronRunAsNode: string | null;
  readonly sailHome: string | null;
  readonly t3codeHome: string | null;
  readonly devUrl: string | null;
}

type Report =
  | {
      readonly event: "started";
      readonly pid: number;
      readonly env: Record<(typeof DAEMON_ENV)[number], string | null>;
      readonly stdinIsPipe: boolean;
      readonly cli: CliRun;
    }
  | { readonly event: "shutdown"; readonly pid: number }
  | { readonly event: "add_project"; readonly pid: number; readonly answered: boolean | null };

const fakeDaemonSource = `#!${process.execPath}
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const token = "fake-token";
const env = Object.fromEntries(${JSON.stringify(DAEMON_ENV)}.map((name) => [name, process.env[name] ?? null]));
const report = (body) =>
  fetch(env.SAIL_DESKTOP_ORIGIN + "/boat-report", { method: "POST", body: JSON.stringify({ pid: process.pid, ...body }) });
const streams = new Set();
const emit = (event, data) => {
  for (const res of streams) res.write("event: " + event + "\\ndata: " + JSON.stringify(data) + "\\n\\n");
};
const state = { machines: [{ name: "m1" }], pid: process.pid };
const reply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
let heldReply = null;
const commands = {
  latest_thread: () => {
    if (heldReply !== null) heldReply();
    return [200, { ok: true, data: null }];
  },
  get_state: () => [200, { ok: true, data: state }],
  sign_in_agent: () => [200, { ok: true, data: { started: true }, openUrl: "https://boat.example/device", userCode: "WXYZ-1234" }],
  create_machine: () => [409, { ok: false, error: "Sign in to Boat first." }],
  update_settings: () => {
    emit("desktop_action", { type: "activate" });
    emit("notify", { title: "Machine ready", body: "m1 is awake." });
    return [200, { ok: true, data: null, openUrl: null }];
  },
};
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + token) return reply(res, 401, { ok: false, error: "unauthorized" });
  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    streams.add(res);
    req.on("close", () => streams.delete(res));
    res.write("event: state\\ndata: " + JSON.stringify(state) + "\\n\\n");
    return;
  }
  const name = req.url.slice("/api/command/".length);
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    if (name === "shutdown") {
      await report({ event: "shutdown" });
      reply(res, 200, { ok: true, data: null });
      for (const stream of streams) stream.end();
      server.close(() => process.exit(0));
      return;
    }
    if (name === "add_project") {
      await report({ event: "add_project", answered: null });
      res.on("close", () => {
        if (!res.writableEnded) report({ event: "add_project", answered: false });
      });
      heldReply = () => {
        heldReply = null;
        if (res.destroyed) return;
        reply(res, 200, { ok: true, data: null });
        report({ event: "add_project", answered: true });
      };
      return;
    }
    if (name === "sleep_machine") {
      reply(res, 200, { ok: true, data: null });
      res.on("finish", () => process.stderr.write("boatd lost its sandbox\\n", () => process.exit(3)));
      return;
    }
    const command = commands[name];
    if (!command) return reply(res, 404, { ok: false, error: "unknown command " + name });
    const [status, payload] = command(JSON.parse(body || "{}"));
    reply(res, status, payload);
  });
});
server.listen(0, "127.0.0.1", async () => {
  const cli = JSON.parse(execFileSync(env.SAIL_DESKTOP_CLI, ["environment", "list", "--json"], { encoding: "utf8" }));
  const stdin = require("node:fs").fstatSync(0);
  const stdinIsPipe = stdin.isFIFO() || stdin.isSocket();
  await report({ event: "started", env, cli, stdinIsPipe });
  console.log("sail-boatd starting");
  console.log(JSON.stringify({ ready: true, port: server.address().port, token, mcpPort: 0 }));
});
`;

const fakeServerEntrySource = `console.log(JSON.stringify({
  argv: process.argv.slice(2),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  sailHome: process.env.SAIL_HOME ?? null,
  t3codeHome: process.env.T3CODE_HOME ?? null,
  devUrl: process.env.VITE_DEV_SERVER_URL ?? null,
}));
`;

const reportListener = Effect.gen(function* () {
  const reports = yield* Queue.unbounded<Report>();
  const listener = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      Queue.offerUnsafe(reports, JSON.parse(body) as Report);
      response.end();
    });
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0));
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        listener.closeAllConnections();
        listener.close(() => resume(Effect.void));
      }),
  );
  return { reports, port };
});

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-boat-supervisor-" });
  const fixturesDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-boat-fixtures-" });
  const daemonPath = path.join(fixturesDir, "sail-boatd");
  const serverEntry = path.join(fixturesDir, "server-entry.cjs");
  yield* fileSystem.writeFileString(daemonPath, fakeDaemonSource);
  yield* fileSystem.chmod(daemonPath, 0o755);
  yield* fileSystem.writeFileString(serverEntry, fakeServerEntrySource);
  const { reports, port } = yield* reportListener;
  const saveBoatState = (state: unknown, dataDir = path.join(baseDir, "boat")) =>
    fileSystem
      .makeDirectory(dataDir, { recursive: true })
      .pipe(
        Effect.andThen(
          fileSystem.writeFileString(path.join(dataDir, "state.json"), JSON.stringify(state)),
        ),
      );

  const supervisor = (
    configure?: (
      config: ServerConfig.ServerConfig["Service"],
    ) => Partial<ServerConfig.ServerConfig["Service"]>,
    hostEnvironment: Readonly<Record<string, string>> = {},
  ) =>
    BoatSupervisor.layer.pipe(
      Layer.provide(BoatDaemonBinary.layer),
      Layer.provide(
        Layer.succeed(
          HttpServer.HttpServer,
          HttpServer.make({
            serve: () => Effect.void,
            address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", port),
          }),
        ),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        configure === undefined
          ? ServerConfig.layerTest(process.cwd(), baseDir)
          : Layer.effect(
              ServerConfig.ServerConfig,
              Effect.gen(function* () {
                const config = yield* ServerConfig.ServerConfig;
                return { ...config, ...configure(config) };
              }),
            ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Environment, {
            PATH: process.env.PATH,
            SAIL_BOATD_PATH: daemonPath,
            ELECTRON_RUN_AS_NODE: "1",
            ...hostEnvironment,
          }),
          Layer.succeed(HostProcess.IsExecutable, false),
          Layer.succeed(HostProcess.ExecutablePath, process.execPath),
          Layer.succeed(HostProcess.Arguments, [process.execPath, serverEntry]),
        ),
      ),
    );

  return { baseDir, port, reports, saveBoatState, supervisor };
});

const isReady = (event: BoatEvent) => event._tag === "status" && event.status.phase === "ready";

const untilReady = (boats: BoatSupervisor.BoatSupervisor["Service"]) =>
  boats.events.pipe(
    Stream.takeUntil(isReady),
    Stream.filter((event) => event._tag === "status"),
    Stream.map((event) => event.status.phase),
    Stream.runCollect,
  );

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("BoatSupervisor", () => {
  it.live(
    "starts sail-boatd on first use, maps its replies, and shuts it down with the server",
    () =>
      Effect.gen(function* () {
        const { reports, supervisor } = yield* setup;

        const pid = yield* Effect.gen(function* () {
          const boats = yield* BoatSupervisor.BoatSupervisor;
          assert.deepEqual(yield* untilReady(boats), ["stopped", "starting", "ready"]);

          const state = yield* boats.invoke({ command: "get_state" });
          const started = yield* Queue.take(reports);
          assert.deepEqual(state, { data: { machines: [{ name: "m1" }], pid: started.pid } });

          assert.deepEqual(
            yield* boats.invoke({ command: "sign_in_agent", args: { agent: "x" } }),
            {
              data: { started: true },
              openUrl: "https://boat.example/device",
              userCode: "WXYZ-1234",
            },
          );
          const refused = yield* boats
            .invoke({ command: "create_machine", args: {} })
            .pipe(Effect.flip);
          assert.instanceOf(refused, BoatError);
          assert.equal(refused.message, "Sign in to Boat first.");
          return started.pid;
        }).pipe(Effect.provide(supervisor()));

        assert.deepEqual(yield* Queue.take(reports), { event: "shutdown", pid });
        assert.isFalse(isAlive(pid), "the server's shutdown ends the daemon it spawned");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([
    { home: "an explicit home", devState: false },
    { home: "an implicit dev home", devState: true },
  ])("gives sail-boatd this server's home, origin, data dir, and a t3 for $home", ({ devState }) =>
    Effect.gen(function* () {
      const { baseDir, port, reports, supervisor } = yield* setup;
      const path = yield* Path.Path;
      const devUrl = "http://localhost:5733/";
      const stateDir = path.join(baseDir, devState ? "dev" : "userdata");
      const layer = devState
        ? supervisor(() => ({ devUrl: new URL(devUrl), stateDir }))
        : supervisor();

      const report = yield* Effect.gen(function* () {
        const boats = yield* BoatSupervisor.BoatSupervisor;
        yield* boats.invoke({ command: "get_state" });
        return yield* Queue.take(reports);
      }).pipe(Effect.provide(layer));

      assert.deepInclude(report, {
        event: "started",
        env: {
          SAIL_HOME: baseDir,
          SAIL_DESKTOP_CLI: path.join(stateDir, "boat", "t3"),
          SAIL_DESKTOP_ORIGIN: `http://127.0.0.1:${port}`,
          SAIL_BOAT_DATA_DIR: path.join(baseDir, "boat"),
          SAIL_BOAT_CONTROL_PORT: "0",
          SAIL_BOATD_EXIT_ON_STDIN_EOF: "1",
          ELECTRON_RUN_AS_NODE: null,
        },
        stdinIsPipe: true,
        cli: {
          argv: ["environment", "list", "--json"],
          electronRunAsNode: "1",
          sailHome: devState ? null : baseDir,
          t3codeHome: null,
          devUrl: devState ? devUrl : null,
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("starts sail-boatd at boot, with no Boats call, when state.json has a machine", () =>
    Effect.gen(function* () {
      const { reports, saveBoatState, supervisor } = yield* setup;
      yield* saveBoatState({ machines: [{ name: "m1" }], doomed: [] });

      const report = yield* Queue.take(reports).pipe(Effect.provide(supervisor()));

      assert.equal(report.event, "started");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "keeps a SAIL_BOAT_DATA_DIR the server was started with, and starts at boot from it",
    () =>
      Effect.gen(function* () {
        const { reports, saveBoatState, supervisor } = yield* setup;
        const fileSystem = yield* FileSystem.FileSystem;
        const dataDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-boat-data-" });
        yield* saveBoatState({ doomed: [{ sandbox: "sb-1" }] }, dataDir);

        const report = yield* Queue.take(reports).pipe(
          Effect.provide(supervisor(undefined, { SAIL_BOAT_DATA_DIR: dataDir })),
        );

        assert.deepInclude(report, { event: "started" });
        assert.equal(
          report.event === "started" ? report.env.SAIL_BOAT_DATA_DIR : null,
          dataDir,
          "an upgrade must not strand machines saved under an overridden data dir",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("keeps a percent sign in a Windows launcher literal", () => {
    const script = BoatSupervisor.launcherScript({
      platform: "win32",
      executable: "C:\\Sail 100%\\node.exe",
      entry: "C:\\Sail 100%\\bin.mjs",
      environment: { VITE_DEV_SERVER_URL: "http://localhost:5733/a%20b", SAIL_HOME: undefined },
    });
    assert.include(script, 'set "VITE_DEV_SERVER_URL=http://localhost:5733/a%%20b"');
    assert.include(script, 'set "SAIL_HOME="');
    assert.include(script, '"C:\\Sail 100%%\\node.exe" "C:\\Sail 100%%\\bin.mjs" %*');
  });

  it.each([
    { name: "an unreadable file", saved: undefined, needsDaemon: false },
    { name: "no records", saved: {}, needsDaemon: false },
    {
      name: "empty records",
      saved: { machines: [], doomed: [], pendingSandboxes: [] },
      needsDaemon: false,
    },
    { name: "a machine", saved: { machines: [{ name: "m1" }] }, needsDaemon: true },
    {
      name: "an unconfirmed deletion",
      saved: { doomed: [{ sandbox: "sb-1" }] },
      needsDaemon: true,
    },
    {
      name: "a pending sandbox",
      saved: { pendingSandboxes: [{ sandbox: "sb-2" }] },
      needsDaemon: true,
    },
    { name: "a malformed record list", saved: { machines: "m1" }, needsDaemon: false },
  ])("starts at boot for $name: $needsDaemon", ({ saved, needsDaemon }) => {
    assert.equal(
      BoatSupervisor.savedStateNeedsDaemon(
        saved === undefined ? "not json" : JSON.stringify(saved),
      ),
      needsDaemon,
    );
  });

  it.live("streams notify and state events, and gives a late subscriber the latest state", () =>
    Effect.gen(function* () {
      const { supervisor } = yield* setup;

      yield* Effect.gen(function* () {
        const boats = yield* BoatSupervisor.BoatSupervisor;
        const connected = yield* Deferred.make<void>();
        const notice = yield* boats.events.pipe(
          Stream.tap((event) =>
            event._tag === "state" ? Deferred.succeed(connected, undefined) : Effect.void,
          ),
          Stream.filter((event) => event._tag === "notify"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(connected);

        yield* boats.invoke({ command: "update_settings", args: {} });

        const notify = yield* Fiber.join(notice);
        assert.deepEqual(notify._tag === "Some" ? notify.value : undefined, {
          _tag: "notify",
          title: "Machine ready",
          body: "m1 is awake.",
        });
        const late = yield* boats.events.pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(
          late.map((event) => event._tag),
          ["status", "state"],
        );
      }).pipe(Effect.provide(supervisor()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a command running on sail-boatd after its caller goes away", () =>
    Effect.gen(function* () {
      const { reports, supervisor } = yield* setup;

      yield* Effect.gen(function* () {
        const boats = yield* BoatSupervisor.BoatSupervisor;
        yield* boats.invoke({ command: "get_state" });
        assert.equal((yield* Queue.take(reports)).event, "started");

        const caller = yield* boats
          .invoke({ command: "add_project", args: { id: "m1", projectId: "p1" } })
          .pipe(Effect.forkScoped);
        assert.deepInclude(yield* Queue.take(reports), { event: "add_project", answered: null });
        yield* Fiber.interrupt(caller);

        yield* boats.invoke({ command: "latest_thread", args: { id: "m1" } });
        assert.deepInclude(
          yield* Queue.take(reports),
          { event: "add_project", answered: true },
          "a client that disconnects mid create_machine must not cancel the create",
        );
      }).pipe(Effect.provide(supervisor()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports an unexpected exit and starts sail-boatd again on the next call", () =>
    Effect.gen(function* () {
      const { reports, supervisor } = yield* setup;

      yield* Effect.gen(function* () {
        const boats = yield* BoatSupervisor.BoatSupervisor;
        yield* untilReady(boats);
        const first = yield* Queue.take(reports);
        const failed = yield* boats.events.pipe(
          Stream.filter((event) => event._tag === "status" && event.status.phase === "error"),
          Stream.runHead,
          Effect.forkScoped,
        );

        yield* boats.invoke({ command: "sleep_machine", args: { machine: "m1" } });
        const status = yield* Fiber.join(failed);

        assert.deepEqual(status._tag === "Some" ? status.value : undefined, {
          _tag: "status",
          status: {
            phase: "error",
            error: "sail-boatd exited unexpectedly (exit code 3)",
          },
        });
        const joinedDuringRestart = yield* boats.events.pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(
          joinedDuringRestart.map((event) => event._tag),
          ["status", "status"],
          "a client joining after the crash never sees the dead daemon's state",
        );
        const restarted = yield* boats.invoke({ command: "get_state" });
        const second = yield* Queue.take(reports);
        assert.notEqual(second.pid, first.pid);
        assert.deepEqual(restarted.data, { machines: [{ name: "m1" }], pid: second.pid });
      }).pipe(Effect.provide(supervisor()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

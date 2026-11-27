// @effect-diagnostics nodeBuiltinImport:off - Git initializes the isolated checkpoint fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import {
  AuthAdministrativeClientScopes,
  CommandId,
  defaultInstanceIdForDriver,
  EnvironmentHttpApi,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  WsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  RELAY_HOOK_DELIVERY_HEADER,
  RELAY_HOOK_DELIVERY_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "./auth/ServerSecretStore.ts";
import { setCliDesiredCloudLink } from "./cloud/CliState.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET, RELAY_URL_SECRET } from "./cloud/config.ts";
import { ServiceLauncherHostProcess } from "./cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
} from "./cloud/serviceProtocol.ts";
import * as ServerConfig from "./config.ts";
import { ProjectToolkit } from "./mcp/toolkits/project/tools.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "./orchestration-v2/Orchestrator.ts";
import { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";
import { BUILT_IN_DRIVERS } from "./provider/builtInDrivers.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerMcpClient from "./peer/PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, servePeer } from "./peer/PeerLinks.testkit.ts";
import { layerServer } from "./server.ts";
import * as Admission from "./serverAdmission.ts";
import serverPackage from "../package.json" with { type: "json" };

const replayId = ProviderInstanceId.make("replayFixture");
const replayAgent = new URL("../scripts/dev-replay-agent.ts", import.meta.url);
const commandId = (id: string) => CommandId.make(id);
const projectId = ProjectId.make("drain-project");
const liveServices = Layer.mergeAll(
  NodeServices.layer,
  PlatformNodeCrypto.layer,
  NetService.layer,
  FetchHttpClient.layer,
);

const fixture = Effect.fn("ServingDrain.fixture")(function* (
  launcher: "production" | "fixture-positive" | "none" = "none",
  mode: "replay" | "standalone-management" = "replay",
  linkedEnvironmentsEnabled = false,
) {
  const controlled = launcher !== "none";
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-serving-drain-" })
    .pipe(Effect.flatMap(fs.realPath));
  const workspace = path.join(home, "workspace");
  yield* fs.makeDirectory(workspace);
  const git = (args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: workspace,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    })
      .toString()
      .trim();
  yield* Effect.sync(() => {
    git(["init", "--quiet", "--initial-branch=main"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Initial",
    ]);
  });
  const configContext = yield* Layer.build(ServerConfig.layerTest(workspace, home));
  const config = Context.get(configContext, ServerConfig.ServerConfig);
  const agentPidPath = path.join(home, "replay.pid");
  const listStarted = path.join(home, "list-started");
  const listRelease = path.join(home, "release-list");
  const agentPath =
    mode === "replay" ? yield* path.fromFileUrl(replayAgent) : path.join(home, "manage.mjs");
  if (mode === "standalone-management") {
    yield* fs.writeFileString(
      agentPath,
      `
      import { existsSync, watch, writeFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      const release = ${JSON.stringify(listRelease)};
      const started = ${JSON.stringify(listStarted)};
      const root = ${JSON.stringify(home)};
      for await (const line of createInterface({ input: process.stdin })) {
        const { id, method } = JSON.parse(line);
        if (id === undefined) continue;
        let result = {};
        if (method === "initialize") {
          result = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } };
        } else if (method === "session/list") {
          await new Promise(resolve => {
            const watcher = watch(root, () => {
              if (!existsSync(release)) return;
              watcher.close();
              resolve();
            });
            if (existsSync(release)) { watcher.close(); resolve(); }
            writeFileSync(started, String(process.pid));
          });
          result = { sessions: [{ sessionId: "synthetic", cwd: process.cwd() }] };
        }
        console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
      }
    `,
    );
  }
  const pidRecorder = path.join(home, "record-replay-pid.mjs");
  if (controlled) {
    yield* fs.writeFileString(
      pidRecorder,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(agentPidPath)}, String(process.pid));`,
      ].join("\n"),
    );
  }
  yield* fs.writeFileString(
    config.settingsPath,
    JSON.stringify({
      linkedEnvironmentsEnabled,
      providerInstances: {
        ...Object.fromEntries(
          BUILT_IN_DRIVERS.map(({ driverKind }) => [
            defaultInstanceIdForDriver(driverKind),
            { driver: driverKind, enabled: false },
          ]),
        ),
        [replayId]: {
          driver: "acpRegistry",
          displayName: "Replay (fixture)",
          enabled: mode === "replay",
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: controlled ? ["--import", pidRecorder, agentPath] : [agentPath],
          },
        },
      },
    }),
  );
  const nativeFetch = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "127.0.0.1") {
      return Promise.reject(new Error("The serving fixture only allows loopback HTTP"));
    }
    // @effect-diagnostics-next-line globalFetch:off - Guard the FetchHttpClient transport itself.
    return nativeFetch(input, init);
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      fetch.mockRestore();
    }),
  );
  const serverScope = yield* Scope.fork(yield* Effect.scope);
  const draining = yield* Deferred.make<void>();
  const replies = yield* Queue.unbounded<ServiceLauncherChildMessage>();
  const ipc = new NodeEvents.EventEmitter();
  const peer = {
    baseDir: home,
    installationId: "fixture-installation",
    environmentId: "fixture-environment",
    instanceId: "00000000-0000-0000-0000-000000000001",
  };
  const fence = {
    incumbent: peer,
    updateId: "00000000-0000-0000-0000-000000000002",
    release: { version: "1.1.0", archiveSha256: "a".repeat(64), treeSha256: "b".repeat(64) },
  };
  const send = (message: ServiceLauncherParentMessage) => ipc.emit("message", message);
  const production = layerServer.pipe(
    Layer.provide(
      ServerConfig.layer({
        ...config,
        host: "127.0.0.1",
        noBrowser: true,
        shellEnvironmentPrepared: true,
        startupPairing: "off",
      }),
    ),
    Layer.provide(Layer.succeed(PeerLinks.LoopbackHost, (host) => host === "localhost")),
  );
  if (controlled) {
    yield* fs.writeFileString(config.environmentIdPath, peer.environmentId + "\n");
  }
  if (launcher === "fixture-positive") {
    const makeAdmission = Admission.makeAdmission;
    // This synthetic Replay fixture opts into idle retirement and the positive inventory verdict.
    const inventory = vi
      .spyOn(Admission, "makeAdmission")
      .mockImplementation(<E>(observe: Parameters<typeof makeAdmission<E>>[0]) => {
        const admission = makeAdmission(observe.pipe(Effect.orDie), "complete", {
          retireIdleProviders: true,
        });
        const drain: typeof admission.drain = (token, budget) =>
          Effect.gen(function* () {
            const active = yield* admission
              .drain(token, budget)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.succeed(draining, undefined);
            return yield* Fiber.join(active);
          });
        return { ...admission, drain };
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        inventory.mockRestore();
      }),
    );
  }
  const server = yield* Layer.buildWithScope(production, serverScope).pipe((build) =>
    controlled
      ? build.pipe(
          Effect.provideService(HostProcess.Environment, {
            [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              childVersion: serverPackage.version,
              maintenancePeer: peer,
            }),
          }),
          Effect.provideService(ServiceLauncherHostProcess, {
            connected: true,
            send: (message, callback) => {
              Queue.offerUnsafe(replies, message);
              callback?.(null);
              return true;
            },
            on: (name, listener) => {
              ipc.on(name, listener);
            },
            off: (name, listener) => {
              ipc.off(name, listener);
            },
          }),
        )
      : build,
  );
  if (controlled) {
    const ready = yield* Queue.take(replies).pipe(Effect.timeout("15 seconds"));
    expect(ready).toMatchObject({ type: "maintenance-ready" });
    if (launcher === "fixture-positive") expect(ready).toHaveProperty("censusComplete", true);
    else expect(ready).not.toHaveProperty("censusComplete");
  }
  const address = Context.get(server, HttpServer.HttpServer).address;
  if (typeof address === "string" || !("port" in address))
    throw new Error("Expected a loopback TCP listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const auth = Context.get(server, EnvironmentAuth);
  const { token } = yield* auth.issueSession({ scopes: AuthAdministrativeClientScopes });
  const headers = { authorization: `Bearer ${token}` };
  const api = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
  const { ticket } = yield* api.auth.webSocketTicket({ headers });
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `ws://127.0.0.1:${address.port}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(Redacted.value(ticket))}`,
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(NodeWS.layerWebSocketConstructor),
    ),
  );
  const rpc = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
  const admission = Context.get(server, Admission.ServerAdmission);
  if (!admission) throw new Error("The production admission service is missing");
  yield* api.projects.mutate({
    headers,
    payload: {
      type: "project.create",
      commandId: commandId("create-project"),
      projectId,
      title: TrimmedNonEmptyString.make("Drain fixture"),
      workspaceRoot: TrimmedNonEmptyString.make(workspace),
    },
  });
  return {
    server,
    git,
    workspace,
    origin,
    rpc,
    admission,
    serverScope,
    agentPidPath,
    listStarted,
    listRelease,
    config,
    replies,
    draining,
    fence,
    send,
  };
});

it.live.each(["none", "fixture-positive", "production"] as const)(
  "finishes a Replay approval and checkpoint during drain under %s admission",
  (launcher) =>
    Effect.gen(function* () {
      const {
        server,
        workspace,
        git,
        rpc,
        admission,
        serverScope,
        agentPidPath,
        config,
        replies,
        draining,
        fence,
        send,
      } = yield* fixture(launcher);
      const controlled = launcher === "fixture-positive";
      const orchestrator = Context.get(server, OrchestratorV2);
      const dispatch = rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand];
      const threadId = ThreadId.make("drain-thread");
      yield* dispatch({
        type: "thread.create",
        commandId: commandId("create-thread"),
        projectId,
        threadId,
        createdBy: "user",
        creationSource: "web",
        title: TrimmedNonEmptyString.make("Drain fixture"),
        modelSelection: { instanceId: replayId, model: TrimmedNonEmptyString.make("approval") },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const message = (id: string) =>
        ({
          type: "message.dispatch",
          commandId: commandId(id),
          messageId: MessageId.make(id),
          threadId,
          createdBy: "user",
          creationSource: "web",
          text: "Run the synthetic turn",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        }) satisfies OrchestrationV2Command;
      yield* dispatch(message("accepted"));
      const threadEvents = orchestrator.streamStoredEvents.pipe(
        Stream.map((entry) => entry.event),
        Stream.filter((event) => event.threadId === threadId),
      );
      const requested = yield* threadEvents.pipe(
        Stream.filter((event) => event.type === "runtime-request.updated"),
        Stream.filter((event) => event.payload.status === "pending"),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );

      const fs = yield* FileSystem.FileSystem;
      const agentPid =
        launcher === "none" ? undefined : Number(yield* fs.readFileString(agentPidPath));
      if (agentPid !== undefined) {
        expect(Number.isSafeInteger(agentPid) && agentPid > 0).toBe(true);
        expect(process.kill(agentPid, 0)).toBe(true);
      }

      const deferred = message("deferred");
      const sql = Context.get(server, SqlClient.SqlClient);
      const messages = sql<{ readonly message_id: string }>`
      SELECT message_id FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND message_id = ${deferred.messageId}
    `;
      const token = Symbol();
      const attempt = controlled
        ? undefined
        : yield* admission
            .drain(token, "30 seconds")
            .pipe(Effect.forkScoped({ startImmediately: true }));
      if (controlled) {
        send({ type: "maintenance-drain", fence, budgetMs: 10_000 });
        yield* Deferred.await(draining).pipe(Effect.timeout("12 seconds"));
      }
      const refused = yield* dispatch(deferred).pipe(Effect.result);
      expect(Result.isFailure(refused) && refused.failure).toMatchObject({ retryable: true });
      expect(yield* messages).toEqual([]);
      yield* rpc[WS_METHODS.serverGetConfig]({});

      yield* fs.writeFileString(`${workspace}/fixture.txt`, "checkpoint content");
      yield* dispatch({
        type: "runtime-request.respond",
        commandId: commandId("approve"),
        threadId,
        requestId: requested.payload.id,
        decision: "accept",
      });
      const checkpoint = yield* threadEvents.pipe(
        Stream.filter((event) => event.type === "checkpoint.captured"),
        Stream.filter((event) => event.payload.runId !== null),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(checkpoint.payload.status).toBe("ready");
      expect(git(["show", `${checkpoint.payload.ref}:fixture.txt`])).toBe("checkpoint content");

      const completed = yield* threadEvents.pipe(
        Stream.filter((event) => event.type === "run.updated"),
        Stream.filter(
          (event) =>
            event.payload.id === checkpoint.payload.runId && event.payload.status === "completed",
        ),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(completed.payload.status).toBe("completed");
      if (attempt !== undefined) {
        expect(yield* admission.abort(token)).toBe(true);
        expect(yield* Fiber.join(attempt)).toMatchObject({ kind: "aborted", reason: "requested" });
        if (launcher === "production") {
          expect(yield* admission.drain(Symbol(), "2 seconds")).toMatchObject({
            kind: "aborted",
            reason: "deadline",
            blockers: expect.arrayContaining([
              "provider-retirement-unverified",
              "producer-inventory-incomplete",
            ]),
          });
          expect(agentPid === undefined ? false : process.kill(agentPid, 0)).toBe(true);
        }
        yield* dispatch(deferred);
        expect(yield* messages).toEqual([{ message_id: deferred.messageId }]);
        return;
      }
      expect(yield* Queue.take(replies).pipe(Effect.timeout("15 seconds"))).toEqual({
        type: "maintenance-sealed",
        fence,
      });
      expect(yield* admission.isConfirmedSeal).toBe(true);
      if (agentPid !== undefined) {
        expect(() => process.kill(agentPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
      yield* rpc[WS_METHODS.serverGetConfig]({});
      expect(Result.isFailure(yield* dispatch(deferred).pipe(Effect.result))).toBe(true);
      expect(yield* messages).toEqual([]);
      yield* Scope.close(serverScope, Exit.void);
      const backupPath = config.dbPath + ".fixture-backup";
      yield* fs.copyFile(config.dbPath, backupPath);
      yield* Effect.sync(() => {
        using backup = new NodeSqlite.DatabaseSync(backupPath, { readOnly: true });
        expect(backup.prepare("PRAGMA integrity_check").get()).toMatchObject({
          integrity_check: "ok",
        });
        expect(
          backup
            .prepare("SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ?")
            .get(completed.payload.id),
        ).toMatchObject({ status: "completed" });
        expect(
          backup.prepare("SELECT status FROM orchestration_v2_projection_provider_sessions").all(),
        ).toEqual([expect.objectContaining({ status: "stopped" })]);
      });
    }).pipe(Effect.scoped, Effect.provide(liveServices)),
);

it.effect("holds a due interval in SQLite until the serving scheduler reopens", () =>
  Effect.gen(function* () {
    const { server, rpc, admission } = yield* fixture();
    const task = (yield* rpc[WS_METHODS.scheduledTasksUpsert]({
      title: TrimmedNonEmptyString.make("Synthetic timer"),
      prompt: TrimmedNonEmptyString.make("Process a scheduled run"),
      projectId,
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      threadMode: "continue",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: replayId, model: TrimmedNonEmptyString.make("multi-turn") },
      runtimeMode: "approval-required",
      interactionMode: "default",
    })).task;
    const sql = Context.get(server, SqlClient.SqlClient);
    const readTask = sql<{ readonly run_count: number; readonly next_run_at: string }>`
      SELECT run_count, next_run_at FROM scheduled_tasks WHERE task_id = ${task.id}
    `;
    const token = Symbol();
    const drain = yield* admission
      .drain(token, "5 minutes")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust("65 seconds");
    expect(yield* readTask).toEqual([{ run_count: 0, next_run_at: task.nextRunAt }]);
    expect(yield* admission.abort(token)).toBe(true);
    yield* Fiber.join(drain);

    yield* TestClock.adjust("5 seconds");
    yield* rpc[WS_METHODS.scheduledTasksSubscribe]({}).pipe(
      Stream.filter((snapshot) =>
        snapshot.tasks.some(
          (candidate) => candidate.id === task.id && candidate.lastRunStatus === "succeeded",
        ),
      ),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(yield* readTask).toEqual([{ run_count: 1, next_run_at: expect.any(String) }]);
  }).pipe(Effect.scoped, Effect.provide(liveServices)),
);

it.live("retries a synthetic relay delivery through the scheduled task serving route", () =>
  Effect.gen(function* () {
    const { server, origin, rpc, admission } = yield* fixture();
    const task = (yield* rpc[WS_METHODS.scheduledTasksUpsert]({
      title: TrimmedNonEmptyString.make("Synthetic webhook"),
      prompt: TrimmedNonEmptyString.make("Process the synthetic payload"),
      projectId,
      enabled: true,
      schedule: { type: "webhook" },
      threadMode: "continue",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: replayId, model: TrimmedNonEmptyString.make("multi-turn") },
      runtimeMode: "approval-required",
      interactionMode: "default",
    })).task;
    const endpoint = task.webhook?.path;
    if (!endpoint) throw new Error("The scheduler did not issue a hook path");
    const hookId = task.id;

    const keys = NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const secrets = Context.get(server, ServerSecretStore);
    const environmentId = yield* Context.get(server, ServerEnvironment).getEnvironmentId;
    const issuer = "https://synthetic-relay.example.invalid";
    const encoder = new TextEncoder();
    yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, encoder.encode(keys.publicKey));
    yield* secrets.set(RELAY_ISSUER_SECRET, encoder.encode(issuer));
    const received = yield* DateTime.now;
    const now = DateTime.toEpochMillis(received);
    const receivedAt = DateTime.formatIso(received);
    const deliveryId = "fixture-delivery";
    const proof = yield* signRelayJwt({
      privateKey: keys.privateKey,
      typ: RELAY_HOOK_DELIVERY_TYP,
      payload: {
        iss: issuer,
        aud: `t3-env:${environmentId}`,
        sub: environmentId,
        jti: `proof:${deliveryId}`,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 3600,
        environmentId,
        deliveryId,
        receivedAt,
        hookId,
      },
    });
    const deliver = HttpClient.execute(
      HttpClientRequest.post(`${origin}${endpoint}`).pipe(
        HttpClientRequest.setHeaders({
          [RELAY_HOOK_DELIVERY_HEADER]: proof,
          "x-t3-relay-delivery-id": deliveryId,
          "x-t3-relay-received-at": receivedAt,
        }),
        HttpClientRequest.bodyText('{"kind":"synthetic"}', "application/json"),
      ),
    );
    const sql = Context.get(server, SqlClient.SqlClient);
    const claims = sql<{ readonly relay_delivery_id: string }>`
      SELECT relay_delivery_id FROM scheduled_task_webhook_relay_deliveries
      WHERE task_id = ${task.id}
    `;
    const token = Symbol();
    const drain = yield* admission
      .drain(token, "30 seconds")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    const deferred = yield* deliver;
    expect([
      deferred.status,
      deferred.headers["retry-after"],
      deferred.headers["x-t3-hook-outcome"],
    ]).toEqual([503, "1", "error"]);
    expect(yield* claims).toEqual([]);
    expect(yield* admission.abort(token)).toBe(true);
    yield* Fiber.join(drain);

    const accepted = yield* deliver;
    expect([accepted.status, accepted.headers["x-t3-hook-outcome"]]).toEqual([202, "accepted"]);
    const replayed = yield* deliver;
    expect([replayed.status, replayed.headers["x-t3-hook-outcome"]]).toEqual([202, "duplicate"]);
    const responseBody = (response: typeof accepted) =>
      response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ deliveryId: Schema.String }))),
      );
    expect(yield* responseBody(accepted)).toEqual({ deliveryId: `delivery:relay:${deliveryId}` });
    expect(yield* responseBody(replayed)).toEqual({ deliveryId: `delivery:relay:${deliveryId}` });
    expect(yield* claims).toEqual([{ relay_delivery_id: deliveryId }]);

    const finished = yield* rpc[WS_METHODS.scheduledTasksSubscribe]({}).pipe(
      Stream.map((snapshot) => snapshot.tasks.find((candidate) => candidate.id === task.id)),
      Stream.filter((candidate) => candidate?.lastRunStatus === "succeeded"),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    const threadId = finished?.threadId;
    if (!threadId) throw new Error("The scheduled task did not bind its thread");
    yield* Context.get(server, OrchestratorV2)
      .streamStoredEventsFrom({
        threadId,
        eventType: "run.updated",
      })
      .pipe(
        Stream.filter(
          ({ event }) => event.type === "run.updated" && event.payload.status === "completed",
        ),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
  }).pipe(Effect.scoped, Effect.provide(liveServices)),
);

it.live(
  "holds a standalone ACP session list through reap and refuses another start during drain",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { server, admission, workspace, listStarted, listRelease } = yield* fixture(
        "production",
        "standalone-management",
      );
      const registry = Context.get(server, ProviderInstanceRegistry);
      const instance = yield* registry.getInstance(replayId);
      const manager = instance?.acpSessionManagement;
      if (manager === undefined) return yield* Effect.die("Synthetic ACP management is missing");
      const list = manager.listSessions({ cwd: workspace });
      const running = yield* list.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.callback<void>((resume) => {
        const watcher = NodeFS.watch(path.dirname(listStarted), () => {
          if (NodeFS.existsSync(listStarted)) resume(Effect.void);
        });
        if (NodeFS.existsSync(listStarted)) resume(Effect.void);
        return Effect.sync(() => watcher.close());
      }).pipe(Effect.timeout("10 seconds"));
      const pid = Number(yield* fs.readFileString(listStarted));
      expect(pid).toBeGreaterThan(0);
      const token = Symbol();
      const draining = yield* admission
        .drain(token, "10 seconds")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      expect(yield* list.pipe(Effect.flip)).toMatchObject({ reason: "maintenance_busy" });
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(running.pollUnsafe()).toBeUndefined();
      yield* fs.writeFileString(listRelease, "release");
      expect(yield* Fiber.join(running)).toMatchObject({ sessions: [{ sessionId: "synthetic" }] });
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(yield* admission.abort(token)).toBe(true);
      expect(yield* Fiber.join(draining)).toMatchObject({ kind: "aborted", reason: "requested" });
      expect(yield* list).toMatchObject({ sessions: [{ sessionId: "synthetic" }] });
    }).pipe(Effect.scoped, Effect.provide(liveServices)),
);

it.live(
  "reports specific configured optional blockers and refuses settings enablement while closed",
  () =>
    Effect.gen(function* () {
      const { server, rpc, admission } = yield* fixture("production");
      const getSettings = rpc[WS_METHODS.serverGetSettings];
      const updateSettings = rpc[WS_METHODS.serverUpdateSettings];
      const optionalSettings = {
        guestSharingEnabled: true,
        workflowsEnabled: true,
        linkedEnvironmentsEnabled: true,
        enableDeviceSupport: true,
      };
      const token = Symbol();
      const drain = yield* admission
        .drain(token, "30 seconds")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      expect(
        Result.isFailure(yield* updateSettings({ patch: optionalSettings }).pipe(Effect.result)),
      ).toBe(true);
      expect(yield* getSettings({})).toMatchObject({
        guestSharingEnabled: false,
        workflowsEnabled: false,
        linkedEnvironmentsEnabled: false,
        enableDeviceSupport: false,
      });
      const catalog = yield* rpc[WS_METHODS.serverSearchAcpRegistry]({ query: "fixture" }).pipe(
        Effect.flip,
      );
      expect(catalog).toMatchObject({ reason: "maintenance_busy" });
      expect(yield* admission.abort(token)).toBe(true);
      yield* Fiber.join(drain);

      expect(
        (yield* updateSettings({ patch: { guestSharingEnabled: true } })).guestSharingEnabled,
      ).toBe(true);
      const secrets = Context.get(server, ServerSecretStore);
      const setDesired = (desired: boolean) =>
        setCliDesiredCloudLink(desired, "publish_only").pipe(
          Effect.provideService(ServerSecretStore, secrets),
        );
      yield* setDesired(true);
      yield* secrets.set(
        RELAY_URL_SECRET,
        new TextEncoder().encode("https://synthetic-relay.example.invalid"),
      );
      const blocked = yield* admission.drain(Symbol(), "2 seconds");
      expect(blocked).toMatchObject({
        kind: "aborted",
        reason: "deadline",
        blockers: [
          "guest-sharing-configured",
          "connect-configured",
          "relay-webhook-configured",
          "producer-inventory-incomplete",
        ],
      });
      expect(
        (yield* updateSettings({ patch: { guestSharingEnabled: false } })).guestSharingEnabled,
      ).toBe(false);
      yield* setDesired(false);
      yield* secrets.remove(RELAY_URL_SECRET);
      expect(yield* admission.drain(Symbol(), "2 seconds")).toMatchObject({
        kind: "aborted",
        reason: "deadline",
        blockers: ["producer-inventory-incomplete"],
      });
    }).pipe(Effect.scoped, Effect.provide(liveServices)),
);

it.live.each(["fixture-positive", "production"] as const)(
  "reports the idle owned and incoming peer links under %s admission",
  (launcher) =>
    Effect.gen(function* () {
      const { admission, origin, rpc, server } = yield* fixture(launcher, "replay", true);
      const upstreamServer = yield* Layer.build(NodeHttpServer.layerTest);
      const upstream = yield* servePeer(
        descriptorOf("linked-home-fixture", "Home"),
        Layer.empty,
      ).pipe(Effect.provideContext(upstreamServer));
      const home = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("incoming-home-fixture", "Incoming home")),
      );
      const auth = Context.get(server, EnvironmentAuth);
      const sql = Context.get(server, SqlClient.SqlClient);
      const upstreamPairing = yield* upstream.auth.issuePairingCredential();
      const owned = yield* rpc[WS_METHODS.peerLinksLink]({
        url: upstream.url,
        pairingCode: upstreamPairing.credential,
        access: "auto",
      });
      const pairing = yield* auth.issuePairingCredential().pipe(Effect.provideContext(server));
      const homeLink = yield* Context.get(home, PeerLinks.PeerLinks).link({
        url: origin,
        pairingCode: pairing.credential,
        access: "auto",
      });
      const rows = sql`SELECT * FROM peer_environment_links`;
      const before = yield* rows;
      const incoming = yield* auth
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.filter((session) => session.client.label?.startsWith("T3 Code · ")),
          ),
        );
      expect(before).toHaveLength(1);
      expect(incoming).toHaveLength(1);

      const seal = Symbol();
      const outcome = yield* admission.drain(seal, "2 seconds");
      if (launcher === "production") {
        expect(outcome).toMatchObject({
          kind: "aborted",
          reason: "deadline",
          blockers: ["producer-inventory-incomplete"],
        });
        expect(yield* rows).toEqual(before);
        expect(yield* auth.listSessions()).toEqual(expect.arrayContaining(incoming));
        return;
      }
      expect(outcome).toEqual({ kind: "sealed" });
      yield* Ref.set(upstream.descriptor, descriptorOf("linked-home-fixture", "New label"));
      const listed = yield* rpc[WS_METHODS.peerLinksList]({});
      expect(listed.links[0]).toMatchObject({ label: owned.label, status: "reachable" });
      const refused = yield* rpc[WS_METHODS.peerLinksUnlink]({
        environmentId: owned.environmentId,
      }).pipe(Effect.result);
      expect(refused).toMatchObject({ _tag: "Failure", failure: { reason: "maintenance" } });
      const launch = ProjectToolkit.tools.t3_thread_launch;
      const incomingLaunch = yield* Context.get(home, PeerMcpClient.PeerMcpClient)
        .call({
          environmentId: homeLink.environmentId,
          tool: launch.name,
          arguments: {
            projectId,
            title: "Sealed peer launch",
            clientRequestId: "seal:incoming-launch",
          },
          limits: { runtimeMode: "approval-required", interactionMode: "default" },
          success: launch.successSchema,
        })
        .pipe(Effect.result);
      expect(incomingLaunch).toMatchObject({
        _tag: "Failure",
        failure: {
          retryable: true,
          message: "Server maintenance is in progress. Retry the same request.",
        },
      });
      expect(yield* admission.confirmSeal(seal, Effect.void)).toBe(true);
      expect(yield* rows).toEqual(before);
      expect(
        (yield* auth.listSessions()).filter((session) =>
          session.client.label?.startsWith("T3 Code · "),
        ),
      ).toEqual(incoming);
      yield* admission.abort(seal);
      expect((yield* rpc[WS_METHODS.peerLinksList]({})).links[0]?.label).toBe("New label");
    }).pipe(Effect.scoped, Effect.provide(liveServices)),
);

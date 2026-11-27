// @effect-diagnostics nodeBuiltinImport:off - Git initializes the isolated checkpoint fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
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
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "./auth/ServerSecretStore.ts";
import { setCliDesiredCloudLink } from "./cloud/CliState.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET, RELAY_URL_SECRET } from "./cloud/config.ts";
import * as ServerConfig from "./config.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "./orchestration-v2/Orchestrator.ts";
import { BUILT_IN_DRIVERS } from "./provider/builtInDrivers.ts";
import { layerServer } from "./server.ts";
import { ServerAdmission } from "./serverAdmission.ts";

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

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-serving-drain-" });
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
  const agentPath = yield* path.fromFileUrl(replayAgent);
  yield* fs.writeFileString(
    config.settingsPath,
    JSON.stringify({
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
          config: { source: "local", commandPath: process.execPath, commandArgs: [agentPath] },
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
  const server = yield* Layer.build(
    layerServer.pipe(
      Layer.provide(
        ServerConfig.layer({
          ...config,
          host: "127.0.0.1",
          noBrowser: true,
          shellEnvironmentPrepared: true,
          startupPairing: "off",
        }),
      ),
    ),
  );
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
  const admission = Context.get(server, ServerAdmission);
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
  return { server, git, workspace, origin, rpc, admission };
});

it.live("finishes a Replay approval and checkpoint while production root admission is closed", () =>
  Effect.gen(function* () {
    const { server, workspace, git, rpc, admission } = yield* fixture;
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

    const deferred = message("deferred");
    const sql = Context.get(server, SqlClient.SqlClient);
    const messages = sql<{ readonly message_id: string }>`
      SELECT message_id FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND message_id = ${deferred.messageId}
    `;
    const token = Symbol();
    const attempt = yield* admission
      .drain(token, "30 seconds")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    const refused = yield* dispatch(deferred).pipe(Effect.result);
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({ retryable: true });
    expect(yield* messages).toEqual([]);
    yield* rpc[WS_METHODS.serverGetConfig]({});

    const fs = yield* FileSystem.FileSystem;
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
    expect(yield* admission.abort(token)).toBe(true);
    expect(yield* Fiber.join(attempt)).toMatchObject({ kind: "aborted", reason: "requested" });
    yield* dispatch(deferred);
    expect(yield* messages).toEqual([{ message_id: deferred.messageId }]);
  }).pipe(Effect.scoped, Effect.provide(liveServices)),
);

it.live("retries a synthetic relay delivery through the scheduled task serving route", () =>
  Effect.gen(function* () {
    const { server, origin, rpc, admission } = yield* fixture;
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
  "reports specific configured optional blockers and refuses settings enablement while closed",
  () =>
    Effect.gen(function* () {
      const { server, rpc, admission } = yield* fixture;
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
          "producer-inventory-incomplete",
          "guest-sharing-configured",
          "connect-configured",
          "relay-webhook-configured",
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

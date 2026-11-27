// @effect-diagnostics nodeBuiltinImport:off - This fixture asserts within a standalone Node process.
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import { observeDurableObligations } from "../../../serverAdmissionObligations.ts";
import { CodexProviderCapabilitiesV2 } from "../../Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskQuestionReactor from "../../DelegatedTaskQuestionReactor.ts";
import * as EventSink from "../../EventSink.ts";
import * as Orchestrator from "../../Orchestrator.ts";
import * as ProjectionStore from "../../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../ProviderReplayHarness.ts";

const [phase, dbPath] = process.argv.slice(2);
NodeAssert.ok(phase === "accept" || phase === "recover");
NodeAssert.ok(dbPath);

const threadId = ThreadId.make("restart:parent");
const requestId = RuntimeRequestId.make("restart:question");
const questionId = MessageId.make(`message:delegated-task-question:${threadId}:${requestId}`);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const registry = ProviderAdapterRegistry.layerFromAdapters([
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("The delivery fixture does not open a provider process"),
  }),
]);
const database = Sqlite.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "delegated-delivery-restart" },
  registry,
  {
    databaseLayer: database,
    runEffectWorker: false,
    runContinuationWorker: phase === "recover",
  },
);
const layer = Layer.mergeAll(
  ProjectionStore.layer,
  DelegatedTaskQuestionReactor.layer.pipe(Layer.provide(ProjectionStore.layer)),
).pipe(Layer.provideMerge(runtime), Layer.provideMerge(database));

const main = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const projection = engine.getThreadProjection(threadId);

  if (phase === "accept") {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("restart:create"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("restart:project"),
      title: "Delegation parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart:prompt"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make("restart:parent-prompt"),
      text: "Delegate the research.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    const [run] = (yield* projection).runs;
    NodeAssert.ok(run?.rootNodeId);
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("restart:provider-thread");
    yield* sink.write({
      events: [
        {
          id: EventId.make("restart:provider-thread-event"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: modelSelection.instanceId,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: run.rootNodeId,
            nativeThreadRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "restart:fixture",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("restart:provider-attached-to-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, providerThreadId },
        },
      ],
    });
    yield* engine.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("restart:delegate"),
      createdBy: "agent",
      creationSource: "mcp",
      parentThreadId: threadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId,
      task: "Review the synthetic source.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
    });
    const child = (yield* projection).subagents[0]?.childThreadId;
    NodeAssert.ok(child);
    const [childRun] = (yield* engine.getThreadProjection(child)).runs;
    NodeAssert.ok(childRun?.rootNodeId);
    const event = {
      id: EventId.make("restart:question-event"),
      type: "runtime-request.updated",
      threadId: child,
      runId: childRun.id,
      occurredAt: yield* DateTime.now,
      payload: {
        id: requestId,
        nodeId: childRun.rootNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: yield* DateTime.now,
        resolvedAt: null,
      },
    } as const;
    yield* sink.write({ events: [event] });
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    yield* reactor.handle(event);

    yield* engine.dispatch({
      type: "delegated_task.remote.request",
      commandId: CommandId.make("restart:remote-request"),
      parentThreadId: threadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId,
      task: "Return a result from the synthetic peer.",
      driver: ProviderDriverKind.make("remote"),
      modelSelection,
      remoteChild: {
        environmentId: EnvironmentId.make("restart:peer"),
        threadId: ThreadId.make("restart:remote-child"),
        label: "Synthetic peer",
      },
      completionWake: "always",
    });
    const remote = (yield* projection).subagents.find((task) => task.remoteChild !== undefined);
    NodeAssert.ok(remote);
    yield* engine.dispatch({
      type: "delegated_task.remote.complete",
      commandId: CommandId.make("restart:remote-completion"),
      parentThreadId: threadId,
      taskId: remote.id,
      status: "completed",
      result: "Synthetic answer",
      stoppedThere: "ran-out",
      settlementVerified: true,
    });
    const accepted = yield* projection;
    NodeAssert.equal(accepted.messages.filter((message) => message.id === questionId).length, 1);
    const delivery = accepted.runs.find((candidate) => candidate.id === run.id)?.delegatedCompletion
      ?.delivery;
    NodeAssert.ok(delivery);
    NodeAssert.ok(!accepted.messages.some((message) => message.id === delivery.messageId));
    NodeAssert.ok(
      (yield* observeDurableObligations()).some((blocker) => blocker === "delegated-work"),
    );
    return;
  }

  yield* engine.recoverDelegatedTasks;
  const before = yield* projection;
  const [question] = before.messages.filter((message) => message.id === questionId);
  NodeAssert.ok(question?.notification?.source.kind === "delegated_task");
  NodeAssert.equal(before.messages.filter((message) => message.id === questionId).length, 1);
  const remote = before.subagents.find((task) => task.remoteChild !== undefined);
  NodeAssert.equal(remote?.result, "Synthetic answer");
  const delivery = before.runs.find((run) => run.id === remote?.runId)?.delegatedCompletion
    ?.delivery;
  NodeAssert.ok(delivery);
  // The genuine continuation worker materializes the claimed completion after reconnecting to SQLite.
  yield* engine
    .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "message.updated" })
    .pipe(
      Stream.filter(
        ({ event }) => event.type === "message.updated" && event.payload.id === delivery.messageId,
      ),
      Stream.take(1),
      Stream.runDrain,
    );
  for (const messageId of [questionId, delivery.messageId]) {
    const input = {
      type: "notification.delivery.accept",
      commandId: CommandId.make(`restart:delivery-accepted:${messageId}`),
      threadId,
      messageId,
    } as const;
    NodeAssert.equal((yield* engine.dispatch(input)).replayed, undefined);
    NodeAssert.equal((yield* engine.dispatch(input)).replayed, true);
  }
  const after = yield* projection;
  NodeAssert.equal(after.messages.filter((message) => message.id === questionId).length, 1);
  NodeAssert.equal(after.messages.filter((message) => message.id === delivery.messageId).length, 1);
  NodeAssert.equal(
    after.subagents.find((task) => task.id === remote.id)?.completionDelivery?.state,
    "delivered",
  );
}).pipe(Effect.provide(layer), Effect.scoped);

await Effect.runPromise(main.pipe(Effect.timeout("20 seconds")));
process.stdout.write(JSON.stringify({ phase, pid: process.pid }) + "\n");

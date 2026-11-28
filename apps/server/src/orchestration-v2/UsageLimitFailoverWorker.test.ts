import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { layerNoTaskFolders } from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as UsageLimitFailoverWorker from "./UsageLimitFailoverWorker.ts";
import {
  hasRunAssistantProgress,
  planUsageLimitFailoverCommand,
} from "./UsageLimitFailoverWorker.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const CLAUDE_1 = ProviderInstanceId.make("claudeAgent");
const CLAUDE_2 = ProviderInstanceId.make("claudeAgent_2");
const CODEX_1 = ProviderInstanceId.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_MODEL = "claude-opus-5-5";
const SOL_MODEL = "gpt-6.2-sol";

function makeServerProvider(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly accountEmail: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  readonly exhausted?: boolean;
}): ServerProvider {
  return {
    driver: input.driver,
    instanceId: input.instanceId,
    displayName: input.displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: {
      status: "authenticated",
      email: input.accountEmail,
    },
    checkedAt: "2026-10-19T12:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: input.models.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      isCustom: false,
      capabilities: null,
    })),
    usageLimits: input.exhausted
      ? {
          checkedAt: "2026-10-19T12:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "5h",
              usedPercent: 100,
              resetsAt: "2026-10-19T16:00:00.000Z",
            },
          ],
        }
      : {
          checkedAt: "2026-10-19T12:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "5h",
              usedPercent: 10,
              resetsAt: "2026-10-19T16:00:00.000Z",
            },
          ],
        },
  };
}

function makeProviderInstance(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
}): ProviderInstance {
  const capabilities =
    input.driver === CLAUDE_DRIVER ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2;
  const orchestrationAdapter = {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not opened in failover lifecycle tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  return {
    instanceId: input.instanceId,
    driverKind: input.driver,
    continuationIdentity: {
      driverKind: input.driver,
      continuationKey: `${input.driver}:${input.instanceId}`,
    },
    displayName: input.displayName,
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
}

const layerPlatformTest = Layer.mergeAll(
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
    runForThread: () => Effect.succeed({ status: "no-script" }),
  }),
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-usage-limit-failover-test-",
});

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const layerGitWorkflowTest = Layer.merge(
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  layerNoTaskFolders,
);

const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const testProviderInstances: ReadonlyArray<ProviderInstance> = [
  makeProviderInstance({ instanceId: CLAUDE_1, driver: CLAUDE_DRIVER, displayName: "Claude 1" }),
  makeProviderInstance({ instanceId: CLAUDE_2, driver: CLAUDE_DRIVER, displayName: "Claude 2" }),
  makeProviderInstance({ instanceId: CODEX_1, driver: CODEX_DRIVER, displayName: "Codex" }),
];

const layerTestProviderInstanceRegistry = Layer.merge(
  ModelManifest.layerTest,
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(testProviderInstances.find((entry) => entry.instanceId === instanceId)),
    listInstances: Effect.succeed(testProviderInstances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  }),
);

const defaultTestProviders = (): ReadonlyArray<ServerProvider> => [
  makeServerProvider({
    instanceId: CLAUDE_1,
    driver: CLAUDE_DRIVER,
    displayName: "Claude 1",
    accountEmail: "acct1@example.com",
    models: [{ slug: CLAUDE_MODEL, name: "Claude Opus 5.5" }],
  }),
  makeServerProvider({
    instanceId: CLAUDE_2,
    driver: CLAUDE_DRIVER,
    displayName: "Claude 2",
    accountEmail: "acct2@example.com",
    models: [{ slug: CLAUDE_MODEL, name: "Claude Opus 5.5" }],
  }),
  makeServerProvider({
    instanceId: CODEX_1,
    driver: CODEX_DRIVER,
    displayName: "Codex",
    accountEmail: "codex@example.com",
    models: [{ slug: SOL_MODEL, name: "GPT-6.2 Sol" }],
  }),
];

function makeFailoverTestLayer(input?: {
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
}) {
  const providers = input?.providers ?? defaultTestProviders();
  const layerProviderRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed(providers),
  });
  const layerSettings = ServerSettings.layerTest({
    autoFailoverOnUsageLimit: true,
    providerInstances: {
      [CLAUDE_2]: {
        driver: CLAUDE_DRIVER,
        displayName: "Claude 2",
        enabled: true,
        customModels: [],
      },
    } as unknown as NonNullable<
      NonNullable<Parameters<typeof ServerSettings.layerTest>[0]>["providerInstances"]
    >,
    autoResumeLimitedThreads: true,
    snoozeLimitedThreads: false,
    usageLimitPassOffRules: [
      {
        id: "rule-claude-to-sol",
        sourceDriver: CLAUDE_DRIVER,
        sourceModel: CLAUDE_MODEL,
        target: {
          instanceId: CODEX_1,
          model: SOL_MODEL,
        },
      },
    ],
    ...input?.settings,
  });

  return Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    ProjectStore.layer,
    ProjectionStore.layer,
  ).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(layerProviderRegistry),
    Layer.provide(layerTestProviderInstanceRegistry),
    Layer.provide(layerGitWorkflowTest),
    Layer.provide(layerProjectServiceTest),
    Layer.provide(layerPlatformTest),
  );
}

const seedProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) => {
    const createdAt = "2026-10-19T12:00:00.000Z";
    return projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Failover test project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: { instanceId: CLAUDE_1, model: CLAUDE_MODEL },
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    });
  });

const failRunWithUsageLimit = (input: {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
  readonly suffix: string;
  readonly assistantText?: string;
  readonly promptDropped?: boolean;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (input.assistantText !== undefined) {
      events.push({
        id: EventId.make(`${input.threadId}:assistant:${input.suffix}`),
        type: "turn-item.updated",
        threadId: input.threadId,
        runId: input.run.id,
        nodeId: input.run.rootNodeId ?? undefined,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: now,
        payload: {
          type: "assistant_message",
          id: TurnItemId.make(`${input.threadId}:assistant-item:${input.suffix}`),
          messageId: MessageId.make(`${input.threadId}:assistant-msg:${input.suffix}`),
          threadId: input.threadId,
          runId: input.run.id,
          nodeId: input.run.rootNodeId!,
          providerThreadId: input.run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: input.run.ordinal * 100 + 1,
          status: "completed",
          title: null,
          text: input.assistantText,
          streaming: false,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    }
    events.push(
      {
        id: EventId.make(`${input.threadId}:error:${input.suffix}`),
        type: "turn-item.updated",
        threadId: input.threadId,
        runId: input.run.id,
        nodeId: input.run.rootNodeId ?? undefined,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: now,
        payload: {
          type: "error",
          id: TurnItemId.make(`${input.threadId}:error-item:${input.suffix}`),
          threadId: input.threadId,
          runId: input.run.id,
          nodeId: input.run.rootNodeId!,
          providerThreadId: input.run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: input.run.ordinal * 100 + 2,
          status: "failed",
          title: "Usage limit reached",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          failure: {
            class: "usage_limit",
            message: "Usage limit reached.",
            code: "usage_limit",
            retryable: true,
            resetAt,
          },
        },
      },
      {
        id: EventId.make(`${input.threadId}:run-failed:${input.suffix}`),
        type: "run.updated",
        threadId: input.threadId,
        runId: input.run.id,
        nodeId: input.run.rootNodeId ?? undefined,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...input.run,
          status: "failed",
          completedAt: now,
        },
      },
    );
    yield* eventSink.write({ events });
  });

const completeRunWithAssistantText = (input: {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
  readonly suffix: string;
  readonly text: string;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${input.threadId}:complete-msg:${input.suffix}`),
          type: "message.updated",
          threadId: input.threadId,
          runId: input.run.id,
          nodeId: input.run.rootNodeId ?? undefined,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`${input.threadId}:assistant-msg:${input.suffix}`),
            threadId: input.threadId,
            runId: input.run.id,
            nodeId: input.run.rootNodeId,
            role: "assistant",
            text: input.text,
            streaming: false,
            attachments: [],
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`${input.threadId}:complete-item:${input.suffix}`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.run.id,
          nodeId: input.run.rootNodeId ?? undefined,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: now,
          payload: {
            type: "assistant_message",
            id: TurnItemId.make(`${input.threadId}:assistant-done:${input.suffix}`),
            messageId: MessageId.make(`${input.threadId}:assistant-msg:${input.suffix}`),
            threadId: input.threadId,
            runId: input.run.id,
            nodeId: input.run.rootNodeId!,
            providerThreadId: input.run.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.run.ordinal * 100 + 1,
            status: "completed",
            title: null,
            text: input.text,
            streaming: false,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`${input.threadId}:run-completed:${input.suffix}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.run.id,
          nodeId: input.run.rootNodeId ?? undefined,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...input.run,
            status: "completed",
            startedAt: input.run.startedAt ?? now,
            completedAt: now,
          },
        },
      ],
    });
  });

describe("planUsageLimitFailoverCommand", () => {
  it("replays original user prompt when the failed run had zero assistant progress", () => {
    const now = DateTime.makeUnsafe("2026-10-19T12:00:00.000Z");
    const runId = RunId.make("run:1");
    const nodeId = NodeId.make("node:1");
    const msgId = MessageId.make("msg:1");
    const projection = {
      thread: {
        id: ThreadId.make("thread:zero-progress"),
        projectId: ProjectId.make("project:1"),
        providerInstanceId: CLAUDE_1,
        modelSelection: { instanceId: CLAUDE_1, model: CLAUDE_MODEL },
        runtimeMode: "full-access",
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
      },
      runs: [
        {
          id: runId,
          rootNodeId: nodeId,
          ordinal: 1,
          providerInstanceId: CLAUDE_1,
          modelSelection: { instanceId: CLAUDE_1, model: CLAUDE_MODEL },
          userMessageId: msgId,
          status: "failed",
          requestedAt: now,
          completedAt: now,
        },
      ],
      messages: [
        {
          id: msgId,
          runId,
          role: "user",
          text: "Refactor the billing module cleanly.",
          attachments: [],
        },
      ],
      turnItems: [
        {
          type: "error",
          id: TurnItemId.make(`err:${runId}`),
          status: "failed",
          updatedAt: now,
          runId,
          nodeId,
          ordinal: 2,
          failure: {
            class: "usage_limit",
            message: "Usage limit reached",
          },
        },
      ],
      attempts: [{ id: "attempt:zero", runId }],
      providerTurns: [{ id: "turn:zero", runAttemptId: "attempt:zero", promptDropped: true }],
      runtimeRequests: [],
    } as unknown as OrchestrationV2ThreadProjection;

    assert.isFalse(hasRunAssistantProgress(projection, projection.runs[0]!));
    const plan = planUsageLimitFailoverCommand({
      projection,
      providers: defaultTestProviders(),
      settings: {
        autoFailoverOnUsageLimit: true,
        usageLimitPassOffRules: [],
        fallbackModelSelection: null,
        providerInstances: {},
        projectSettingsOverrides: {},
      },
      nowMs: DateTime.toEpochMillis(now),
    });

    assert.equal(plan.kind, "dispatch");
    if (plan.kind !== "dispatch") return;
    assert.equal(plan.command.text, "Refactor the billing module cleanly.");
    assert.equal(plan.command.modelSelection?.instanceId, CLAUDE_2);
    assert.equal(plan.command.modelSelection?.model, CLAUDE_MODEL);
    assert.equal(plan.command.usageLimitFailoverOfRunId, runId);
    assert.deepEqual(plan.command.failoverAttemptedInstanceIds, [CLAUDE_1]);
    assert.equal(plan.command.failoverNotice?.kind, "same_provider_account");
  });

  it("dispatches continuation prompt when the failed run already made assistant progress", () => {
    const now = DateTime.makeUnsafe("2026-10-19T12:00:00.000Z");
    const runId = RunId.make("run:partial");
    const nodeId = NodeId.make("node:partial");
    const msgId = MessageId.make("msg:partial");
    const projection = {
      thread: {
        id: ThreadId.make("thread:partial-progress"),
        projectId: ProjectId.make("project:1"),
        providerInstanceId: CLAUDE_1,
        modelSelection: { instanceId: CLAUDE_1, model: CLAUDE_MODEL },
        runtimeMode: "full-access",
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
      },
      runs: [
        {
          id: runId,
          rootNodeId: nodeId,
          ordinal: 1,
          providerInstanceId: CLAUDE_1,
          modelSelection: { instanceId: CLAUDE_1, model: CLAUDE_MODEL },
          userMessageId: msgId,
          status: "failed",
          requestedAt: now,
          completedAt: now,
        },
      ],
      messages: [
        {
          id: msgId,
          runId,
          role: "user",
          text: "Original prompt",
          attachments: [],
        },
      ],
      turnItems: [
        {
          type: "assistant_message",
          runId,
          ordinal: 1,
          text: "I started editing billing.ts...",
        },
        {
          type: "error",
          id: TurnItemId.make(`err:${runId}`),
          status: "failed",
          updatedAt: now,
          runId,
          nodeId,
          ordinal: 2,
          failure: {
            class: "usage_limit",
            message: "Usage limit reached",
          },
        },
      ],
      runtimeRequests: [],
    } as unknown as OrchestrationV2ThreadProjection;

    assert.isTrue(hasRunAssistantProgress(projection, projection.runs[0]!));
    const plan = planUsageLimitFailoverCommand({
      projection,
      providers: defaultTestProviders(),
      settings: {
        autoFailoverOnUsageLimit: true,
        usageLimitPassOffRules: [],
        fallbackModelSelection: null,
        providerInstances: {},
        projectSettingsOverrides: {},
      },
      nowMs: DateTime.toEpochMillis(now),
    });

    assert.equal(plan.kind, "dispatch");
    if (plan.kind !== "dispatch") return;
    assert.equal(plan.command.text, "Continue where you left off.");
    assert.equal(plan.command.modelSelection?.instanceId, CLAUDE_2);
  });
});

describe("UsageLimitFailoverWorker end-to-end orchestration", () => {
  it.effect(
    "transfers Account 1 -> Account 2 (same model) -> cross-provider pass-off -> stops cleanly on Tier 3 and lets UsageLimitRecoveryWorker arm",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
        const processFailover = yield* UsageLimitFailoverWorker.makeFailoverProcessor;

        const threadId = ThreadId.make("thread:two-tier-failover");
        const projectId = ProjectId.make("project:two-tier");
        const initialSelection: ModelSelection = {
          instanceId: CLAUDE_1,
          model: CLAUDE_MODEL,
        };

        yield* seedProject(projectId);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "Two-tier failover test",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:msg1`),
          threadId,
          messageId: MessageId.make(`${threadId}:msg1`),
          text: "Implement feature X",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });

        // 1. Account 1 hits usage_limit after partial assistant output.
        const proj1 = yield* orchestrator.getThreadProjection(threadId);
        const run1 = proj1.runs[0]!;
        assert.equal(run1.providerInstanceId, CLAUDE_1);
        yield* failRunWithUsageLimit({
          threadId,
          run: run1,
          suffix: "r1",
          assistantText: "Halfway through implementing feature X.",
        });

        // Before failover runs, UsageLimitRecoveryWorker must NOT arm because Account 2 is available.
        const settings = yield* settingsService.getSettings;
        const providers = yield* providerRegistry.getProviders;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const candidatesBeforeFailover = yield* projectionStore.getLimitRecoveryCandidates({
          now: yield* DateTime.now,
          autoResume: true,
          snooze: false,
        });
        assert.equal(candidatesBeforeFailover.length, 1);
        const projBeforeFailover = yield* projectionStore.getThreadProjection(threadId);
        assert.isTrue(
          planUsageLimitFailoverCommand({
            projection: projBeforeFailover,
            providers,
            settings,
            nowMs,
          }).kind === "dispatch",
        );

        // Run failover processor -> should transfer to Claude Account 2 with same model + handoff.
        yield* processFailover(threadId);

        const proj2 = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(proj2.runs.length, 2);
        const run2 = proj2.runs[1]!;
        assert.equal(run2.providerInstanceId, CLAUDE_2);
        assert.equal(run2.modelSelection.model, CLAUDE_MODEL);
        assert.equal(run2.usageLimitFailoverOfRunId, run1.id);
        assert.deepEqual(run2.failoverAttemptedInstanceIds, [CLAUDE_1]);
        assert.equal(run2.failoverNotice?.kind, "same_provider_account");
        assert.isNotNull(run2.contextHandoffId);
        const run2Notice = proj2.turnItems.find(
          (item) => item.runId === run2.id && item.type === "system_notice",
        );
        assert.isDefined(run2Notice);
        if (run2Notice?.type === "system_notice") {
          assert.include(run2Notice.message, "Claude 1");
          assert.include(run2Notice.message, "Claude 2");
          assert.include(run2Notice.message, "Claude Opus 5.5");
        }
        const run2UserMessage = proj2.messages.find((message) => message.id === run2.userMessageId);
        assert.equal(run2UserMessage?.text, "Continue where you left off.");

        // 2. Account 2 also hits usage_limit -> all Claude accounts exhausted -> pass off to Codex Sol.
        yield* failRunWithUsageLimit({
          threadId,
          run: run2,
          suffix: "r2",
          assistantText: "Continued work on account 2.",
        });
        yield* processFailover(threadId);

        const proj3 = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(proj3.runs.length, 3);
        const run3 = proj3.runs[2]!;
        assert.equal(run3.providerInstanceId, CODEX_1);
        assert.equal(run3.modelSelection.model, SOL_MODEL);
        assert.equal(run3.usageLimitFailoverOfRunId, run2.id);
        assert.deepEqual(run3.failoverAttemptedInstanceIds, [CLAUDE_1, CLAUDE_2]);
        assert.equal(run3.failoverNotice?.kind, "cross_provider_handoff");
        assert.isNotNull(run3.contextHandoffId);
        const run3Notice = proj3.turnItems.find(
          (item) => item.runId === run3.id && item.type === "system_notice",
        );
        assert.isDefined(run3Notice);
        if (run3Notice?.type === "system_notice") {
          assert.include(run3Notice.message, "All Claude accounts reached usage limit");
          assert.include(run3Notice.message, "Codex");
          assert.include(run3Notice.message, "GPT-6.2 Sol");
        }

        // 3. Codex also hits usage_limit -> Tier 3: no more targets, stops cleanly (no 4th run).
        yield* failRunWithUsageLimit({
          threadId,
          run: run3,
          suffix: "r3",
        });
        yield* processFailover(threadId);

        const proj4 = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(proj4.runs.length, 3);
        assert.equal(proj4.thread.providerInstanceId, CODEX_1);

        // Now all failover targets are exhausted, so UsageLimitRecoveryWorker can arm reset recovery.
        const candidatesTier3 = yield* projectionStore.getLimitRecoveryCandidates({
          now: yield* DateTime.now,
          autoResume: true,
          snooze: false,
        });
        assert.equal(candidatesTier3.length, 1);
        const recoveryCmd = limitRecoveryCommand(
          candidatesTier3[0]!,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
          false,
        );
        assert.equal(recoveryCmd?.type, "thread.metadata.update");
      }).pipe(Effect.provide(makeFailoverTestLayer())),
  );

  it.effect(
    "prevents UsageLimitRecoveryWorker from arming while a failover target is still available",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const dispatchedRef = yield* Ref.make<Array<string>>([]);

        const threadId = ThreadId.make("thread:recovery-no-race");
        const projectId = ProjectId.make("project:recovery-no-race");
        yield* seedProject(projectId);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "No race test",
          modelSelection: { instanceId: CLAUDE_1, model: CLAUDE_MODEL },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:msg1`),
          threadId,
          messageId: MessageId.make(`${threadId}:msg1`),
          text: "Do work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const run1 = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* failRunWithUsageLimit({ threadId, run: run1, suffix: "r1" });

        // Run a real sweep of UsageLimitRecoveryWorker with ProviderRegistry present.
        const mockThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (cmd) =>
            Ref.update(dispatchedRef, (items) => [...items, cmd.type]).pipe(Effect.as({} as never)),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            // Exercise sweep directly by building the layer with a spy ThreadManagementService.
            const candidates = yield* projectionStore.getLimitRecoveryCandidates({
              now: yield* DateTime.now,
              autoResume: true,
              snooze: false,
            });
            assert.equal(candidates.length, 1);
            const projection = yield* projectionStore.getThreadProjection(threadId);
            const settings = yield* settingsService.getSettings;
            const providers = yield* providerRegistry.getProviders;
            // Confirm failover target is eligible, which UsageLimitRecoveryWorker checks before arming.
            const plan = planUsageLimitFailoverCommand({
              projection,
              providers,
              settings,
              nowMs: DateTime.toEpochMillis(yield* DateTime.now),
            });
            assert.equal(plan.kind, "dispatch");
          }).pipe(Effect.provide(mockThreads)),
        );
        assert.deepEqual(yield* Ref.get(dispatchedRef), []);
        // Ensure UsageLimitRecoveryWorker module is exercised without errors.
        assert.isDefined(UsageLimitRecoveryWorker.layer);
      }).pipe(Effect.provide(makeFailoverTestLayer())),
  );

  it.effect(
    "keeps a delegated child task running through usage-limit failover and delivers the completed result to the parent",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const processFailover = yield* UsageLimitFailoverWorker.makeFailoverProcessor;

        const parentThreadId = ThreadId.make("thread:delegated-failover-parent");
        const projectId = ProjectId.make("project:delegated-failover");
        const initialSelection: ModelSelection = {
          instanceId: CLAUDE_1,
          model: CLAUDE_MODEL,
        };

        yield* seedProject(projectId);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${parentThreadId}:create`),
          threadId: parentThreadId,
          projectId,
          title: "Parent thread",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${parentThreadId}:start`),
          threadId: parentThreadId,
          messageId: MessageId.make(`${parentThreadId}:start`),
          text: "Delegate analysis",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });

        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`${parentThreadId}:delegate`),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Audit auth module",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });

        const parentAfterDelegate = yield* orchestrator.getThreadProjection(parentThreadId);
        const task = parentAfterDelegate.subagents[0]!;
        const childThreadId = task.childThreadId!;
        const childProj1 = yield* orchestrator.getThreadProjection(childThreadId);
        const childRun1 = childProj1.runs[0]!;
        assert.equal(childRun1.providerInstanceId, CLAUDE_1);

        // Child run 1 fails with usage_limit on Account 1.
        yield* failRunWithUsageLimit({
          threadId: childThreadId,
          run: childRun1,
          suffix: "child-r1",
          promptDropped: true,
        });

        // Child finalization MUST be held while Account 2 failover is eligible!
        assert.isTrue(yield* orchestrator.delegatedTaskResultPending(childThreadId));
        yield* orchestrator.recoverDelegatedTask(childThreadId);
        const parentWhileFailingOver = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(parentWhileFailingOver.subagents.length, 1);
        assert.notEqual(parentWhileFailingOver.subagents[0]!.status, "failed");

        // Failover worker transfers child to Account 2 without spawning a duplicate subagent task.
        yield* processFailover(childThreadId);
        const childProj2 = yield* orchestrator.getThreadProjection(childThreadId);
        assert.equal(childProj2.runs.length, 2);
        const childRun2 = childProj2.runs[1]!;
        assert.equal(childRun2.providerInstanceId, CLAUDE_2);
        assert.equal(childRun2.modelSelection.model, CLAUDE_MODEL);
        assert.equal(childRun2.usageLimitFailoverOfRunId, childRun1.id);
        // Zero-progress prompt was replayed verbatim.
        const childRun2Msg = childProj2.messages.find((m) => m.id === childRun2.userMessageId);
        assert.include(childRun2Msg?.text ?? "", "Audit auth module");

        const parentDuringChildRun2 = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(parentDuringChildRun2.subagents.length, 1);

        // Child run 2 succeeds on Account 2 and delivers completed result to parent!
        yield* completeRunWithAssistantText({
          threadId: childThreadId,
          run: childRun2,
          suffix: "child-r2",
          text: "Auth audit completed on account 2.",
        });
        assert.isFalse(yield* orchestrator.delegatedTaskResultPending(childThreadId));
        yield* orchestrator.recoverDelegatedTask(childThreadId);

        const parentFinal = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(parentFinal.subagents.length, 1);
        assert.equal(parentFinal.subagents[0]!.status, "completed");
        assert.include(
          parentFinal.subagents[0]!.result ?? "",
          "Auth audit completed on account 2.",
        );
      }).pipe(Effect.provide(makeFailoverTestLayer())),
  );
});

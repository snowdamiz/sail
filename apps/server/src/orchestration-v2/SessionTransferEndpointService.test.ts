// @effect-diagnostics nodeBuiltinImport:off -- test harness initializes real git repos and inspects restored files/attachments on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EnvironmentId,
  EventId,
  GitRefName,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  SessionTransferId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as AssetSigner from "../assets/AssetSigner.ts";
import {
  resolveExportBundlePath,
  resolveImportBundlePath,
  resolveTransferStagingDir,
} from "../assets/SessionTransferToken.ts";
import { createAttachmentId, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceBundle from "../vcs/WorkspaceBundle.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as SessionTransferEndpointService from "./SessionTransferEndpointService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitRepo(dir: string): void {
  NodeFS.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Transfer Test"]);
  git(dir, ["config", "user.email", "transfer@example.com"]);
  NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "base readme\n");
  NodeFS.writeFileSync(NodePath.join(dir, "app.ts"), "export const v = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial commit"]);
}

interface MockRecorder {
  readonly dispatches: Array<Record<string, unknown>>;
  readonly forceStops: Array<ThreadId>;
  readonly detachedSessions: Array<ProviderSessionId>;
  readonly sentMessages: Array<{
    readonly threadId: ThreadId;
    readonly text: string;
    readonly mode: string | undefined;
    readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
  }>;
}

function makeEndpointTestLayer(options: {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  readonly providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: "codex" | "claudeAgent";
    readonly enabled?: boolean;
  }>;
  readonly recorder: MockRecorder;
}) {
  const baseLayer = Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer);
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: `t3-xfer-endpoint-${options.environmentId}-`,
  }).pipe(Layer.provideMerge(baseLayer));

  const sqliteLayer = SqlitePersistence.layerMemory.pipe(Layer.provideMerge(configLayer));
  const eventStoreLayer = EventStore.layer.pipe(Layer.provideMerge(sqliteLayer));
  const projectionStoreLayer = ProjectionStore.layer.pipe(Layer.provideMerge(eventStoreLayer));
  const eventSinkLayer = EventSink.layer.pipe(Layer.provideMerge(projectionStoreLayer));

  const secretLayer = ServerSecretStore.layer.pipe(Layer.provideMerge(configLayer));
  const signerLayer = AssetSigner.layer.pipe(Layer.provideMerge(secretLayer));
  const documentTextLayer = DocumentText.layer.pipe(Layer.provideMerge(configLayer));
  const vcsProcessLayer = VcsProcess.layer.pipe(Layer.provideMerge(configLayer));
  const workspaceBundleLayer = WorkspaceBundle.layer.pipe(Layer.provideMerge(vcsProcessLayer));

  const envIdentityLayer = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make(options.environmentId)),
  });
  const envLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make(options.environmentId),
      label: options.environmentLabel,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
    } as never),
  });

  const projectMap = new Map(
    options.projects.map((p) => [
      p.id,
      {
        id: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
      },
    ]),
  );

  const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(Option.fromNullishOr(projectMap.get(id)) as never),
  });

  const providerMetaMap = new Map(
    options.providers.map((p) => [
      p.instanceId,
      {
        driver: ProviderDriverKind.make(p.driver),
        continuationKey: String(p.instanceId),
        enabled: p.enabled ?? true,
        capabilities: CodexProviderCapabilitiesV2,
      },
    ]),
  );

  const providerRegistryLayer = Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
    list: () => Effect.succeed(options.providers.map((p) => p.instanceId)),
    getMetadata: (id) => {
      const meta = providerMetaMap.get(id);
      return meta
        ? Effect.succeed(meta)
        : Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
              instanceId: id,
            }),
          );
    },
  });

  const providerSessionManagerLayer = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
    detach: (input) =>
      Effect.sync(() => {
        options.recorder.detachedSessions.push(input.providerSessionId);
      }),
  });

  // Wire dispatch so thread.stop marks running runs interrupted and thread.archive sets archivedAt.
  const threadManagementLayer = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      return {
        dispatch: (command: Record<string, unknown>) =>
          Effect.gen(function* () {
            options.recorder.dispatches.push(command);
            const now = yield* DateTime.now;
            if (command.type === "thread.stop") {
              const threadId = command.threadId as ThreadId;
              const records = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
              const events: OrchestrationV2DomainEvent[] = [];
              for (const run of records.runs) {
                if (
                  run.status === "running" ||
                  run.status === "starting" ||
                  run.status === "preparing" ||
                  run.status === "waiting"
                ) {
                  events.push({
                    id: EventId.make(`stop-run:${run.id}:${DateTime.toEpochMillis(now)}`),
                    type: "run.updated",
                    threadId,
                    runId: run.id,
                    occurredAt: now,
                    payload: {
                      ...run,
                      status: "interrupted",
                      completedAt: now,
                    },
                  });
                }
              }
              if (events.length > 0) {
                yield* eventSink.write({ events });
              }
            } else if (command.type === "thread.archive") {
              const threadId = command.threadId as ThreadId;
              const records = yield* projectionStore.getThreadRecords(threadId, []);
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make(`archive:${threadId}:${DateTime.toEpochMillis(now)}`),
                    type: "thread.archived",
                    threadId,
                    occurredAt: now,
                    payload: {
                      ...records.thread,
                      archivedAt: now,
                      updatedAt: now,
                    },
                  },
                ],
              });
            }
            return { sequence: 1 };
          }),
        forceStopThread: (input: { readonly threadId: ThreadId }) =>
          Effect.sync(() => {
            options.recorder.forceStops.push(input.threadId);
            return { sequence: 1 };
          }),
        sendToThread: (input: {
          readonly threadId: ThreadId;
          readonly text: string;
          readonly mode?: string;
          readonly attachments: ReadonlyArray<{ readonly id: ChatAttachmentId }>;
        }) =>
          Effect.sync(() => {
            options.recorder.sentMessages.push({
              threadId: input.threadId,
              text: input.text,
              mode: input.mode,
              attachmentIds: input.attachments.map((a) => a.id),
            });
            return {
              sequence: 1,
              runId: RunId.make(`sent-run:${options.recorder.sentMessages.length}`),
            };
          }),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"];
    }),
  ).pipe(Layer.provideMerge(eventSinkLayer));

  const depsLayer = Layer.mergeAll(
    eventSinkLayer,
    signerLayer,
    documentTextLayer,
    workspaceBundleLayer,
    envIdentityLayer,
    envLayer,
    projectServiceLayer,
    providerRegistryLayer,
    providerSessionManagerLayer,
    threadManagementLayer,
  );

  return SessionTransferEndpointService.layer.pipe(Layer.provideMerge(depsLayer));
}

function seedThreadEvents(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly branch: string;
  readonly worktreePath: string;
  readonly modelSelection: ModelSelection;
  readonly running: boolean;
  readonly pendingRuntimeRequest?: boolean;
  readonly presentAttachmentId?: ChatAttachmentId;
  readonly missingAttachmentId?: ChatAttachmentId;
  readonly queuedText?: string;
  readonly queuedAttachmentId?: ChatAttachmentId;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const createdAt = DateTime.makeUnsafe("2026-08-01T10:00:00.000Z");
  const updatedAt = DateTime.makeUnsafe("2026-08-01T10:05:00.000Z");
  const providerSessionId = ProviderSessionId.make(`psess:${input.threadId}`);
  const run1Id = RunId.make(`run-1:${input.threadId}`);
  const run2Id = RunId.make(`run-2:${input.threadId}`);
  const msg1Id = MessageId.make(`msg-1:${input.threadId}`);
  const msg2Id = MessageId.make(`msg-2:${input.threadId}`);
  const qMsgId = MessageId.make(`qmsg:${input.threadId}`);

  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: input.projectId,
    title: "Implement session transfer",
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: GitRefName.make(input.branch),
    worktreePath: TrimmedNonEmptyString.make(input.worktreePath),
    tags: ["transfer", "pr2"],
    activeProviderThreadId: ProviderThreadId.make(`pt:${input.threadId}`),
    lineage: {
      rootThreadId: input.threadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdAt,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };

  const attachments = [
    ...(input.presentAttachmentId
      ? [
          {
            type: "image" as const,
            id: input.presentAttachmentId,
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ]
      : []),
    ...(input.missingAttachmentId
      ? [
          {
            type: "image" as const,
            id: input.missingAttachmentId,
            name: "pruned.png",
            mimeType: "image/png",
            sizeBytes: 24,
          },
        ]
      : []),
  ];

  const userMsg: OrchestrationV2ConversationMessage = {
    createdBy: "user",
    creationSource: "web",
    id: msg1Id,
    threadId: input.threadId,
    runId: run1Id,
    nodeId: null,
    role: "user",
    text: "Please implement the lossless transfer bundle.",
    attachments,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };

  const assistantMsg: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: msg2Id,
    threadId: input.threadId,
    runId: run1Id,
    nodeId: null,
    role: "assistant",
    text: "Working on WorkspaceBundle export and import.",
    attachments: [],
    streaming: false,
    createdAt: updatedAt,
    updatedAt,
  };

  const userItem: OrchestrationV2TurnItem = {
    createdBy: "user",
    creationSource: "web",
    id: TurnItemId.make(`ti-user:${input.threadId}`),
    threadId: input.threadId,
    runId: run1Id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: createdAt,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "user_message",
    messageId: msg1Id,
    inputIntent: "turn_start",
    text: userMsg.text,
    attachments,
  };

  const plan: OrchestrationV2PlanArtifact = {
    id: PlanId.make(`plan:${input.threadId}`),
    threadId: input.threadId,
    runId: run1Id,
    nodeId: NodeId.make(`plan-node:${input.threadId}`),
    kind: "proposed_plan",
    markdown: "- Step 1: Bundle\n- Step 2: Endpoints",
    status: "active",
  };

  const run1: OrchestrationV2Run = {
    id: run1Id,
    threadId: input.threadId,
    ordinal: 1,
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    providerThreadId: null,
    userMessageId: msg1Id,
    rootNodeId: null,
    activeAttemptId: null,
    status: input.running ? "running" : "completed",
    queuePosition: null,
    requestedAt: createdAt,
    startedAt: createdAt,
    completedAt: input.running ? null : updatedAt,
    checkpointId: null,
    contextHandoffId: null,
  };

  const session: OrchestrationV2ProviderSession = {
    id: providerSessionId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: input.modelSelection.instanceId,
    status: "running",
    cwd: TrimmedNonEmptyString.make(input.worktreePath),
    model: TrimmedNonEmptyString.make(input.modelSelection.model),
    capabilities: CodexProviderCapabilitiesV2,
    createdAt,
    updatedAt,
    lastError: null,
  };

  const events: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make(`seed:${input.threadId}:thread`),
      type: "thread.created",
      threadId: input.threadId,
      occurredAt: createdAt,
      payload: thread,
    },
    {
      id: EventId.make(`seed:${input.threadId}:session`),
      type: "provider-session.updated",
      threadId: input.threadId,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: createdAt,
      payload: session,
    },
    {
      id: EventId.make(`seed:${input.threadId}:provider-thread`),
      type: "provider-thread.updated",
      threadId: input.threadId,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: createdAt,
      payload: {
        id: ProviderThreadId.make(`pt:${input.threadId}`),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: input.modelSelection.instanceId,
        providerSessionId,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt,
        updatedAt,
      },
    },
    {
      id: EventId.make(`seed:${input.threadId}:run1`),
      type: "run.created",
      threadId: input.threadId,
      runId: run1Id,
      providerInstanceId: input.modelSelection.instanceId,
      occurredAt: createdAt,
      payload: run1,
    },
    {
      id: EventId.make(`seed:${input.threadId}:msg1`),
      type: "message.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: createdAt,
      payload: userMsg,
    },
    {
      id: EventId.make(`seed:${input.threadId}:msg2`),
      type: "message.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: updatedAt,
      payload: assistantMsg,
    },
    {
      id: EventId.make(`seed:${input.threadId}:ti1`),
      type: "turn-item.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: createdAt,
      payload: userItem,
    },
    {
      id: EventId.make(`seed:${input.threadId}:plan`),
      type: "plan.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: updatedAt,
      payload: plan,
    },
  ];

  if (input.pendingRuntimeRequest) {
    const req: OrchestrationV2RuntimeRequest = {
      id: RuntimeRequestId.make(`rreq:${input.threadId}`),
      nodeId: NodeId.make(`node:${input.threadId}`),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: {
        type: "live",
        providerSessionId,
      },
      createdAt: updatedAt,
      resolvedAt: null,
      feedback: "Approve running rm -rf build/",
    };
    events.push({
      id: EventId.make(`seed:${input.threadId}:rreq`),
      type: "runtime-request.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: updatedAt,
      payload: req,
    });
  }

  if (input.queuedText !== undefined) {
    const queuedAttachments = input.queuedAttachmentId
      ? [
          {
            type: "image" as const,
            id: input.queuedAttachmentId,
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ]
      : [];
    events.push(
      {
        id: EventId.make(`seed:${input.threadId}:qmsg`),
        type: "message.updated",
        threadId: input.threadId,
        runId: run2Id,
        occurredAt: updatedAt,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: qMsgId,
          threadId: input.threadId,
          runId: run2Id,
          nodeId: null,
          role: "user",
          text: input.queuedText,
          attachments: queuedAttachments,
          streaming: false,
          createdAt: updatedAt,
          updatedAt,
        },
      },
      {
        id: EventId.make(`seed:${input.threadId}:qrun`),
        type: "run.created",
        threadId: input.threadId,
        runId: run2Id,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: updatedAt,
        payload: {
          id: run2Id,
          threadId: input.threadId,
          ordinal: 2,
          providerInstanceId: input.modelSelection.instanceId,
          modelSelection: input.modelSelection,
          providerThreadId: null,
          userMessageId: qMsgId,
          rootNodeId: null,
          activeAttemptId: null,
          status: "queued",
          queuePosition: 1,
          queueHeld: true,
          requestedAt: updatedAt,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    );
  }

  return events;
}

describe("SessionTransferEndpointService", () => {
  it.effect(
    "completes full roundtrip: pauses running source, transfers git+attachments, commits with idempotent replay, auto-resumes, and finalizes source",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-e2e-"));
        const sourceRepo = NodePath.join(tmpRoot, "source-repo");
        const destRepo = NodePath.join(tmpRoot, "dest-repo");
        initGitRepo(sourceRepo);
        git(tmpRoot, ["clone", sourceRepo, destRepo]);
        git(destRepo, ["config", "user.name", "Transfer Test"]);
        git(destRepo, ["config", "user.email", "transfer@example.com"]);

        // Add unpushed commit + staged + unstaged + untracked changes on source feature branch.
        git(sourceRepo, ["checkout", "-b", "feat/session-move"]);
        NodeFS.writeFileSync(NodePath.join(sourceRepo, "committed.ts"), "export const x = 42;\n");
        git(sourceRepo, ["add", "committed.ts"]);
        git(sourceRepo, ["commit", "-m", "unpushed feature work"]);

        NodeFS.writeFileSync(NodePath.join(sourceRepo, "app.ts"), "export const v = 2;\n");
        git(sourceRepo, ["add", "app.ts"]);
        NodeFS.writeFileSync(NodePath.join(sourceRepo, "app.ts"), "export const v = 3;\n");
        NodeFS.writeFileSync(NodePath.join(sourceRepo, "notes.txt"), "untracked notes\n");

        const projectId = ProjectId.make("proj-xfer-1");
        const sourceThreadId = ThreadId.make("thread-src-1");
        const transferId = SessionTransferId.make("xfer-e2e-001");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };

        const sourceRecorder: MockRecorder = {
          dispatches: [],
          forceStops: [],
          detachedSessions: [],
          sentMessages: [],
        };
        const destRecorder: MockRecorder = {
          dispatches: [],
          forceStops: [],
          detachedSessions: [],
          sentMessages: [],
        };

        const sourceLayer = makeEndpointTestLayer({
          environmentId: "env-local",
          environmentLabel: "Local MacBook",
          projects: [{ id: projectId, title: "Sail", workspaceRoot: sourceRepo }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder: sourceRecorder,
        });
        const destLayer = makeEndpointTestLayer({
          environmentId: "env-boat",
          environmentLabel: "Boat Cloud",
          projects: [{ id: projectId, title: "Sail", workspaceRoot: destRepo }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder: destRecorder,
        });

        try {
          // 1. Seed & prepare on SOURCE.
          const presentAttachmentId = ChatAttachmentId.make(createAttachmentId(sourceThreadId)!);
          const missingAttachmentId = ChatAttachmentId.make("att-missing-pruned");
          const attachmentBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

          const preparedData = yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            // Write real source attachment on disk.
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${presentAttachmentId}.png`),
              attachmentBytes,
            );

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "feat/session-move",
                worktreePath: sourceRepo,
                modelSelection,
                running: true,
                presentAttachmentId,
                missingAttachmentId,
                queuedText: "Follow-up queued prompt after resume",
                queuedAttachmentId: presentAttachmentId,
              }),
            });

            const prepared = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });

            // Concurrent transfer on same thread with different transferId is rejected.
            const conflict = yield* Effect.result(
              svc.prepareSource({
                transferId: SessionTransferId.make("xfer-conflict-999"),
                threadId: sourceThreadId,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(conflict)).toBe(true);
            if (Result.isFailure(conflict)) {
              expect(conflict.failure.code).toBe("already_in_flight");
            }

            // Idempotent retry with same transferId succeeds with valid download URL.
            const retried = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            expect(retried.manifest.sourceThreadId).toBe(sourceThreadId);
            expect(retried.bundleDownloadRelativeUrl).not.toBeNull();

            const exportPath = resolveExportBundlePath(config.stateDir, transferId, path)!;
            const bundleBytes = NodeFS.readFileSync(exportPath);
            return { prepared, bundleBytes, sourceStateDir: config.stateDir };
          }).pipe(Effect.provide(sourceLayer));

          expect(sourceRecorder.dispatches.some((d) => d.type === "thread.stop")).toBe(true);
          expect(sourceRecorder.detachedSessions).toHaveLength(1);
          expect(preparedData.prepared.manifest.sourceState.wasRunning).toBe(true);
          expect(preparedData.prepared.manifest.sourceState.heldQueuedRunCount).toBe(1);
          expect(preparedData.prepared.manifest.attachments).toHaveLength(2);
          const presentRef = preparedData.prepared.manifest.attachments.find(
            (a) => a.attachmentId === presentAttachmentId,
          );
          const missingRef = preparedData.prepared.manifest.attachments.find(
            (a) => a.attachmentId === missingAttachmentId,
          );
          expect(presentRef?.downloadRelativeUrl).toMatch(/^\/api\/assets\//);
          expect(missingRef?.downloadRelativeUrl).toBeUndefined();

          // 2. Stage + upload bundle & attachment + commit on DESTINATION.
          const commitResult = yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const staged = yield* svc.stageImport({
              transferId,
              manifest: preparedData.prepared.manifest,
              targetProjectId: projectId,
            });
            expect(staged.bundleUploadRelativeUrl).toMatch(/^\/api\/session-transfers\//);
            expect(staged.attachmentUploads).toHaveLength(1);
            expect(staged.attachmentUploads[0]?.sourceAttachmentId).toBe(presentAttachmentId);

            // Simulate streaming bundle upload -> import.bundle.
            const importPath = resolveImportBundlePath(config.stateDir, transferId, path)!;
            NodeFS.mkdirSync(NodePath.dirname(importPath), { recursive: true });
            NodeFS.writeFileSync(importPath, preparedData.bundleBytes);

            // Simulate uploading pending attachment bytes on destination.
            const pendingDestId = staged.attachmentUploads[0]!.destinationAttachmentId;
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${pendingDestId}.png`),
              attachmentBytes,
            );

            const committed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: preparedData.prepared.manifest,
              autoResume: true,
              attachmentIdMap: {
                [presentAttachmentId]: pendingDestId,
              },
            });

            expect(committed.resumed).toBe(true);
            expect(committed.destinationBranch).toBe("feat/session-move");
            expect(committed.destinationWorktreePath).not.toBeNull();

            // Verify lossless git restoration on destination worktree.
            const wt = committed.destinationWorktreePath!;
            expect(NodeFS.readFileSync(NodePath.join(wt, "committed.ts"), "utf8")).toBe(
              "export const x = 42;\n",
            );
            expect(git(wt, ["show", ":app.ts"])).toBe("export const v = 2;");
            expect(NodeFS.readFileSync(NodePath.join(wt, "app.ts"), "utf8")).toBe(
              "export const v = 3;\n",
            );
            expect(NodeFS.readFileSync(NodePath.join(wt, "notes.txt"), "utf8")).toBe(
              "untracked notes\n",
            );

            // Verify persisted thread projection on destination.
            const destProj = yield* projectionStore.getThreadProjection(
              committed.destinationThreadId,
            );
            expect(destProj.thread.transferOrigin?.transferId).toBe(transferId);
            expect(destProj.thread.transferOrigin?.threadId).toBe(sourceThreadId);
            expect(destProj.thread.historyOrigin).toBe("v1_import");
            expect(destProj.thread.tags).toEqual(["transfer", "pr2"]);
            expect(destProj.plans).toHaveLength(1);
            expect(destProj.contextHandoffs).toHaveLength(1);
            expect(destProj.contextHandoffs[0]?.strategy).toBe("full_thread_summary");
            expect(destProj.contextHandoffs[0]?.summaryText).toContain("Session Transfer Context");

            // Verify attachment ID rewriting in imported message & turn item, and stub preserved for missing.
            const importedUserMsg = destProj.messages.find((m) => m.role === "user");
            const rewrittenPresent = importedUserMsg?.attachments.find(
              (a) => a.name === "diagram.png",
            );
            const preservedMissing = importedUserMsg?.attachments.find(
              (a) => a.name === "pruned.png",
            );
            expect(rewrittenPresent?.id).toBeDefined();
            expect(rewrittenPresent?.id).not.toBe(presentAttachmentId);
            expect(
              resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId: rewrittenPresent!.id,
              }),
            ).not.toBeNull();
            expect(preservedMissing?.id).toBe(missingAttachmentId);

            // Verify auto-resume sent exactly one continuation turn + one re-enqueued held prompt with rewritten attachment ID.
            expect(destRecorder.sentMessages).toHaveLength(2);
            expect(destRecorder.sentMessages[0]?.mode).toBe("auto");
            expect(destRecorder.sentMessages[0]?.text).toContain(
              "Session transferred from Local MacBook",
            );
            expect(destRecorder.sentMessages[1]?.mode).toBe("queue");
            expect(destRecorder.sentMessages[1]?.text).toBe("Follow-up queued prompt after resume");
            expect(destRecorder.sentMessages[1]?.attachmentIds).toEqual([rewrittenPresent!.id]);

            // Idempotent commitImport replay returns exact same result without duplicating turns.
            const replayed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: preparedData.prepared.manifest,
              autoResume: true,
            });
            expect(replayed).toEqual(committed);
            expect(destRecorder.sentMessages).toHaveLength(2);

            // Destination abort AFTER commit does NOT delete committed worktree.
            const postCommitAbort = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(postCommitAbort.cleanedUp).toBe(false);
            expect(NodeFS.existsSync(wt)).toBe(true);

            return committed;
          }).pipe(Effect.provide(destLayer));

          // 3. Finalize on SOURCE (fresh invocation with same seeded state + verify archive & transferredTo).
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "feat/session-move",
                worktreePath: sourceRepo,
                modelSelection,
                running: false,
              }),
            });

            // Prepare then finalize on same instance to confirm lock + staging cleanup.
            yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            const stagingDir = resolveTransferStagingDir(config.stateDir, transferId, path)!;
            expect(NodeFS.existsSync(stagingDir)).toBe(true);

            const finalized = yield* svc.finalizeSource({
              transferId,
              threadId: sourceThreadId,
              destination: {
                transferId,
                environmentId: EnvironmentId.make("env-boat"),
                environmentName: TrimmedNonEmptyString.make("Boat Cloud"),
                machineId: null,
                projectId: commitResult.destinationProjectId,
                threadId: commitResult.destinationThreadId,
                transferredAt: IsoDateTime.make("2026-08-01T10:10:00.000Z"),
              },
            });
            expect(finalized.archived).toBe(true);
            expect(NodeFS.existsSync(stagingDir)).toBe(false);

            const srcProj = yield* projectionStore.getThreadProjection(sourceThreadId);
            expect(srcProj.thread.transferredTo?.transferId).toBe(transferId);
            expect(srcProj.thread.transferredTo?.threadId).toBe(commitResult.destinationThreadId);
            expect(srcProj.thread.archivedAt).not.toBeNull();
          }).pipe(Effect.provide(sourceLayer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "pauses destination without auto-resuming when source had pending runtime request and preserves held queued runs",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-pending-"));
        const sourceRepo = NodePath.join(tmpRoot, "source");
        const destRepo = NodePath.join(tmpRoot, "dest");
        initGitRepo(sourceRepo);
        git(tmpRoot, ["clone", sourceRepo, destRepo]);

        const projectId = ProjectId.make("proj-pending");
        const sourceThreadId = ThreadId.make("thread-pending");
        const transferId = SessionTransferId.make("xfer-pending-001");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };
        const recorder: MockRecorder = {
          dispatches: [],
          forceStops: [],
          detachedSessions: [],
          sentMessages: [],
        };

        const layer = makeEndpointTestLayer({
          environmentId: "env-shared",
          environmentLabel: "Shared Env",
          projects: [
            { id: projectId, title: "Repo", workspaceRoot: sourceRepo },
            { id: ProjectId.make("proj-dest"), title: "DestRepo", workspaceRoot: destRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "main",
                worktreePath: sourceRepo,
                modelSelection,
                running: true,
                pendingRuntimeRequest: true,
                queuedText: "Queued prompt held behind approval",
              }),
            });

            const prepared = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            expect(prepared.manifest.sourceState.hadPendingRuntimeRequest).toBe(true);
            expect(prepared.manifest.sourceState.pendingRuntimeRequests).toHaveLength(1);
            expect(prepared.manifest.sourceState.pendingRuntimeRequests[0]?.summary).toContain(
              "Approve running rm -rf build/",
            );

            const staged = yield* svc.stageImport({
              transferId,
              manifest: prepared.manifest,
              targetProjectId: ProjectId.make("proj-dest"),
            });

            // Copy export.bundle -> import.bundle.
            const exportPath = resolveExportBundlePath(config.stateDir, transferId, path)!;
            const importPath = resolveImportBundlePath(config.stateDir, transferId, path)!;
            NodeFS.copyFileSync(exportPath, importPath);

            const committed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prepared.manifest,
              autoResume: true, // Must still stay paused because of pending runtime request!
            });

            expect(committed.resumed).toBe(false);
            expect(recorder.sentMessages).toHaveLength(0);

            const destProj = yield* projectionStore.getThreadProjection(
              committed.destinationThreadId,
            );
            expect(destProj.contextHandoffs[0]?.summaryText).toContain(
              "pending approval/user-input request",
            );
            expect(destProj.runs).toHaveLength(1);
            expect(destProj.runs[0]?.status).toBe("queued");
            expect(destProj.runs[0]?.queueHeld).toBe(true);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "maps provider instances by driverKind fallback, honors modelSelectionOverride, and rejects unavailable providers",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-models-"));
        const repoDir = NodePath.join(tmpRoot, "repo");
        initGitRepo(repoDir);

        const projectId = ProjectId.make("proj-models");
        const sourceThreadId = ThreadId.make("thread-models");
        const recorder: MockRecorder = {
          dispatches: [],
          forceStops: [],
          detachedSessions: [],
          sentMessages: [],
        };

        const sourceLayer = makeEndpointTestLayer({
          environmentId: "env-src",
          environmentLabel: "Source",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("codex-work"), driver: "codex" }],
          recorder,
        });
        const fallbackDestLayer = makeEndpointTestLayer({
          environmentId: "env-dst-fallback",
          environmentLabel: "Dest Fallback",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("codex-boat"), driver: "codex" }],
          recorder,
        });
        const incompatibleDestLayer = makeEndpointTestLayer({
          environmentId: "env-dst-claude",
          environmentLabel: "Dest Claude Only",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("claude"), driver: "claudeAgent" }],
          recorder,
        });

        try {
          const manifest = yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex-work"),
                  model: "gpt-5.4",
                },
                running: false,
              }),
            });
            const prep = yield* svc.prepareSource({
              transferId: SessionTransferId.make("xfer-model-1"),
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            return prep.manifest;
          }).pipe(Effect.provide(sourceLayer));

          // 1. Fallback to same driverKind ('codex') succeeds with warning.
          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const staged = yield* svc.stageImport({
              transferId: SessionTransferId.make("xfer-model-1"),
              manifest,
              targetProjectId: projectId,
            });
            expect(staged.resolvedModelSelection.instanceId).toBe("codex-boat");
            expect(staged.warnings.some((w) => w.includes("codex-boat"))).toBe(true);
          }).pipe(Effect.provide(fallbackDestLayer));

          // 2. Incompatible destination fails with target_unavailable unless override is given.
          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const rejected = yield* Effect.result(
              svc.stageImport({
                transferId: SessionTransferId.make("xfer-model-2"),
                manifest,
                targetProjectId: projectId,
              }),
            );
            expect(Result.isFailure(rejected)).toBe(true);
            if (Result.isFailure(rejected)) {
              expect(rejected.failure.code).toBe("target_unavailable");
            }

            const overridden = yield* svc.stageImport({
              transferId: SessionTransferId.make("xfer-model-2"),
              manifest,
              targetProjectId: projectId,
              modelSelectionOverride: {
                instanceId: ProviderInstanceId.make("claude"),
                model: "claude-sonnet-4-6",
              },
            });
            expect(overridden.resolvedModelSelection.instanceId).toBe("claude");
            expect(overridden.resolvedModelSelection.model).toBe("claude-sonnet-4-6");
          }).pipe(Effect.provide(incompatibleDestLayer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "abort releases source lock & cleans staging leaving source unarchived, and cleans uncommitted destination staging",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-abort-"));
        const repoDir = NodePath.join(tmpRoot, "repo");
        initGitRepo(repoDir);

        const projectId = ProjectId.make("proj-abort");
        const sourceThreadId = ThreadId.make("thread-abort");
        const recorder: MockRecorder = {
          dispatches: [],
          forceStops: [],
          detachedSessions: [],
          sentMessages: [],
        };

        const layer = makeEndpointTestLayer({
          environmentId: "env-abort",
          environmentLabel: "Abort Test",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
                running: false,
              }),
            });

            const xfer1 = SessionTransferId.make("xfer-abort-1");
            const prep1 = yield* svc.prepareSource({
              transferId: xfer1,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            const staging1 = resolveTransferStagingDir(config.stateDir, xfer1, path)!;
            expect(NodeFS.existsSync(staging1)).toBe(true);

            // Abort source -> releases lock + cleans staging + keeps thread intact & unarchived.
            const abortedSource = yield* svc.abort({
              transferId: xfer1,
              role: "source",
              threadId: sourceThreadId,
            });
            expect(abortedSource.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(staging1)).toBe(false);

            const srcAfterAbort = yield* projectionStore.getThreadProjection(sourceThreadId);
            expect(srcAfterAbort.thread.archivedAt).toBeNull();
            expect(srcAfterAbort.thread.transferredTo ?? null).toBeNull();

            // Subsequent prepareSource with a NEW transferId now succeeds because the lock was released.
            const xfer2 = SessionTransferId.make("xfer-abort-2");
            yield* svc.prepareSource({
              transferId: xfer2,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });

            // Stage on destination then abort before commit -> deletes staged directory.
            const xferDest = SessionTransferId.make("xfer-abort-dest");
            yield* svc.stageImport({
              transferId: xferDest,
              manifest: prep1.manifest,
              targetProjectId: projectId,
            });
            const destStaging = resolveTransferStagingDir(config.stateDir, xferDest, path)!;
            expect(NodeFS.existsSync(destStaging)).toBe(true);

            const abortedDest = yield* svc.abort({
              transferId: xferDest,
              role: "destination",
            });
            expect(abortedDest.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(destStaging)).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );
});

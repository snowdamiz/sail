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
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as AssetSigner from "../assets/AssetSigner.ts";
import {
  resolveExportBundlePath,
  resolveImportBundlePath,
  resolveTransferStagingDir,
  SESSION_TRANSFER_TOKEN_TTL_MS,
  validateSessionTransferBundleToken,
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

function decodeSignedAssetExpiresAt(relativeUrl: string): number {
  const segments = relativeUrl.split("/");
  // /api/assets/<encoded>.<sig>/<filename>
  const token = segments[3] ?? "";
  const encodedPayload = token.split(".")[0] ?? "";
  const json = Buffer.from(encodedPayload, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { readonly expiresAt?: number };
  return parsed.expiresAt ?? 0;
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
  importBundleCount?: number;
}

class TestHookError extends Schema.TaggedError<TestHookError>()("TestHookError", {
  message: Schema.String,
}) {}

interface EndpointTestHooks {
  readonly onThreadStop?: (ctx: {
    readonly threadId: ThreadId;
    readonly eventSink: EventSink.EventSinkV2["Service"];
    readonly projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
    readonly defaultStop: Effect.Effect<void, TestHookError>;
  }) => Effect.Effect<void, TestHookError>;
  readonly onForceStop?: (ctx: {
    readonly threadId: ThreadId;
    readonly eventSink: EventSink.EventSinkV2["Service"];
    readonly projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
  }) => Effect.Effect<{ readonly sequence: number }, TestHookError>;
  readonly onSendToThread?: (ctx: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly mode: string | undefined;
    readonly attachments: ReadonlyArray<{ readonly id: ChatAttachmentId }>;
    readonly defaultSend: Effect.Effect<{ readonly sequence: number; readonly runId: RunId }>;
  }) => Effect.Effect<{ readonly sequence: number; readonly runId: RunId }, TestHookError>;
  readonly onEventSinkWrite?: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<void, TestHookError>;
  readonly onGetThreadRecords?: (ctx: {
    readonly threadId: ThreadId;
    readonly fields: ReadonlyArray<string>;
    readonly next: Effect.Effect<
      unknown,
      ProjectionStore.ProjectionStoreV2Error | ProjectionStore.ProjectionStoreThreadNotFoundError
    >;
  }) => Effect.Effect<
    unknown,
    | ProjectionStore.ProjectionStoreV2Error
    | ProjectionStore.ProjectionStoreThreadNotFoundError
    | TestHookError
  >;
  readonly onImportWorkspaceBundle?: <A, E>(next: Effect.Effect<A, E>) => Effect.Effect<A, E>;
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
  readonly hooks?: EndpointTestHooks;
}) {
  const baseLayer = Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer);
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: `t3-xfer-endpoint-${options.environmentId}-`,
  }).pipe(Layer.provideMerge(baseLayer));

  const sqliteLayer = SqlitePersistence.layerMemory.pipe(Layer.provideMerge(configLayer));
  const eventStoreLayer = EventStore.layer.pipe(Layer.provideMerge(sqliteLayer));
  const rawProjectionStoreLayer = ProjectionStore.layer.pipe(Layer.provideMerge(eventStoreLayer));
  const projectionStoreLayer =
    options.hooks?.onGetThreadRecords !== undefined
      ? Layer.effect(
          ProjectionStore.ProjectionStoreV2,
          Effect.gen(function* () {
            const inner = yield* ProjectionStore.ProjectionStoreV2;
            const hook = options.hooks!.onGetThreadRecords!;
            return {
              ...inner,
              getThreadRecords: (threadId, fields, filter) =>
                hook({
                  threadId,
                  fields,
                  next: inner.getThreadRecords(threadId, fields, filter),
                }) as never,
            } satisfies ProjectionStore.ProjectionStoreV2["Service"];
          }),
        ).pipe(Layer.provideMerge(rawProjectionStoreLayer))
      : rawProjectionStoreLayer;

  const rawEventSinkLayer = EventSink.layer.pipe(Layer.provideMerge(projectionStoreLayer));
  const eventSinkLayer =
    options.hooks?.onEventSinkWrite !== undefined
      ? Layer.effect(
          EventSink.EventSinkV2,
          Effect.gen(function* () {
            const inner = yield* EventSink.EventSinkV2;
            const hook = options.hooks!.onEventSinkWrite!;
            return {
              ...inner,
              write: (writeInput) =>
                Effect.gen(function* () {
                  yield* hook(writeInput.events).pipe(
                    Effect.mapError(
                      (cause) =>
                        new EventSink.EventSinkWriteError({
                          eventCount: writeInput.events.length,
                          cause,
                        }),
                    ),
                  );
                  return yield* inner.write(writeInput);
                }),
            } satisfies EventSink.EventSinkV2["Service"];
          }),
        ).pipe(Layer.provideMerge(rawEventSinkLayer))
      : rawEventSinkLayer;

  const secretLayer = ServerSecretStore.layer.pipe(Layer.provideMerge(configLayer));
  const signerLayer = AssetSigner.layer.pipe(Layer.provideMerge(secretLayer));
  const documentTextLayer = DocumentText.layer.pipe(Layer.provideMerge(configLayer));
  const vcsProcessLayer = VcsProcess.layer.pipe(Layer.provideMerge(configLayer));
  const rawWorkspaceBundleLayer = WorkspaceBundle.layer.pipe(Layer.provideMerge(vcsProcessLayer));
  const workspaceBundleLayer = Layer.effect(
    WorkspaceBundle.WorkspaceBundle,
    Effect.gen(function* () {
      const inner = yield* WorkspaceBundle.WorkspaceBundle;
      return WorkspaceBundle.WorkspaceBundle.of({
        ...inner,
        importWorkspaceBundle: (importInput) => {
          options.recorder.importBundleCount = (options.recorder.importBundleCount ?? 0) + 1;
          const next = inner.importWorkspaceBundle(importInput);
          return options.hooks?.onImportWorkspaceBundle !== undefined
            ? options.hooks.onImportWorkspaceBundle(next)
            : next;
        },
      });
    }),
  ).pipe(Layer.provideMerge(rawWorkspaceBundleLayer));

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

  // Wire dispatch so thread.stop marks running runs interrupted, thread.archive sets archivedAt,
  // and sendToThread persists the continuation message/run into SQLite just like real Orchestrator.
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
              const defaultStop = Effect.gen(function* () {
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
              });

              if (options.hooks?.onThreadStop !== undefined) {
                yield* options.hooks.onThreadStop({
                  threadId,
                  eventSink,
                  projectionStore,
                  defaultStop: defaultStop.pipe(
                    Effect.mapError((cause) => new TestHookError({ message: String(cause) })),
                  ),
                });
              } else {
                yield* defaultStop;
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
          Effect.gen(function* () {
            options.recorder.forceStops.push(input.threadId);
            if (options.hooks?.onForceStop !== undefined) {
              return yield* options.hooks.onForceStop({
                threadId: input.threadId,
                eventSink,
                projectionStore,
              });
            }
            return { sequence: 1 };
          }),
        sendToThread: (input: {
          readonly threadId: ThreadId;
          readonly messageId: MessageId;
          readonly text: string;
          readonly mode?: string;
          readonly modelSelection?: ModelSelection;
          readonly attachments: ReadonlyArray<{ readonly id: ChatAttachmentId }>;
        }) => {
          const defaultSend = Effect.gen(function* () {
            options.recorder.sentMessages.push({
              threadId: input.threadId,
              text: input.text,
              mode: input.mode,
              attachmentIds: input.attachments.map((a) => a.id),
            });
            const now = yield* DateTime.now;
            const runId = RunId.make(`sent-run:${options.recorder.sentMessages.length}`);
            const records = yield* projectionStore
              .getThreadRecords(input.threadId, ["runs"])
              .pipe(Effect.orElseSucceed(() => null));
            if (records !== null) {
              const ordinal = records.runs.reduce((max, run) => Math.max(max, run.ordinal), 0) + 1;
              const selection = input.modelSelection ?? records.thread.modelSelection;
              yield* eventSink
                .write({
                  events: [
                    {
                      id: EventId.make(`sent-msg:${input.messageId}`),
                      type: "message.updated",
                      threadId: input.threadId,
                      runId,
                      occurredAt: now,
                      payload: {
                        createdBy: "system",
                        creationSource: "server",
                        id: input.messageId,
                        threadId: input.threadId,
                        runId,
                        nodeId: null,
                        role: "user",
                        text: input.text,
                        attachments: [],
                        streaming: false,
                        createdAt: now,
                        updatedAt: now,
                      },
                    },
                    {
                      id: EventId.make(`sent-run:${runId}`),
                      type: "run.created",
                      threadId: input.threadId,
                      runId,
                      providerInstanceId: selection.instanceId,
                      occurredAt: now,
                      payload: {
                        id: runId,
                        threadId: input.threadId,
                        ordinal,
                        providerInstanceId: selection.instanceId,
                        modelSelection: selection,
                        providerThreadId: null,
                        userMessageId: input.messageId,
                        rootNodeId: null,
                        activeAttemptId: null,
                        status: "running",
                        queuePosition: null,
                        requestedAt: now,
                        startedAt: now,
                        completedAt: null,
                        checkpointId: null,
                        contextHandoffId: null,
                      },
                    },
                  ],
                })
                .pipe(Effect.ignore);
            }
            return {
              sequence: 1,
              runId,
            };
          });

          if (options.hooks?.onSendToThread !== undefined) {
            return options.hooks.onSendToThread({
              threadId: input.threadId,
              messageId: input.messageId,
              text: input.text,
              mode: input.mode,
              attachments: input.attachments,
              defaultSend,
            });
          }
          return defaultSend;
        },
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

  return Layer.fresh(SessionTransferEndpointService.layer.pipe(Layer.provideMerge(depsLayer)));
}

function seedThreadEvents(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly branch: string;
  readonly worktreePath: string;
  readonly modelSelection: ModelSelection;
  readonly running: boolean;
  readonly pendingRuntimeRequest?: boolean;
  readonly pendingSecretRequest?: boolean;
  readonly presentAttachmentId?: ChatAttachmentId;
  readonly missingAttachmentId?: ChatAttachmentId;
  readonly assistantOnlyAttachmentId?: ChatAttachmentId;
  readonly questionAnswerOnlyAttachmentId?: ChatAttachmentId;
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
  const planId = PlanId.make(`plan:${input.threadId}`);
  const userItemId = TurnItemId.make(`ti-user:${input.threadId}`);

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
    id: userItemId,
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

  const assistantItem: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`ti-asst:${input.threadId}`),
    threadId: input.threadId,
    runId: run1Id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: userItemId,
    ordinal: 2,
    status: "completed",
    title: null,
    startedAt: updatedAt,
    completedAt: updatedAt,
    updatedAt,
    type: "assistant_message",
    messageId: msg2Id,
    text: assistantMsg.text,
    streaming: false,
    ...(input.assistantOnlyAttachmentId !== undefined
      ? {
          attachments: [
            {
              type: "image" as const,
              id: input.assistantOnlyAttachmentId,
              name: "assistant-output.png",
              mimeType: "image/png",
              sizeBytes: 12,
            },
          ],
        }
      : {}),
  };

  const plan: OrchestrationV2PlanArtifact = {
    id: planId,
    threadId: input.threadId,
    runId: run1Id,
    nodeId: NodeId.make(`plan-node:${input.threadId}`),
    kind: "proposed_plan",
    markdown: "- Step 1: Bundle\n- Step 2: Endpoints",
    status: "active",
  };

  const planItem: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`ti-plan:${input.threadId}`),
    threadId: input.threadId,
    runId: run1Id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 3,
    status: "completed",
    title: "Plan",
    startedAt: updatedAt,
    completedAt: updatedAt,
    updatedAt,
    type: "proposed_plan",
    planId,
    markdown: plan.markdown,
    streaming: false,
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
      id: EventId.make(`seed:${input.threadId}:ti2`),
      type: "turn-item.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: updatedAt,
      payload: assistantItem,
    },
    {
      id: EventId.make(`seed:${input.threadId}:ti3`),
      type: "turn-item.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: updatedAt,
      payload: planItem,
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

  if (input.questionAnswerOnlyAttachmentId !== undefined) {
    const qaItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make(`ti-uir:${input.threadId}`),
      threadId: input.threadId,
      runId: run1Id,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 4,
      status: "completed",
      title: "Question",
      startedAt: updatedAt,
      completedAt: updatedAt,
      updatedAt,
      type: "user_input_request",
      requestId: RuntimeRequestId.make(`rreq-qa:${input.threadId}`),
      questions: [
        {
          id: "q-screenshot",
          header: "Screenshot",
          question: "Attach screenshot?",
          options: [{ label: "Yes", description: "Attached" }],
        },
      ],
      questionAnswer: {
        requestId: TrimmedNonEmptyString.make(`rreq-qa:${input.threadId}`),
        answers: { "q-screenshot": "Yes" },
        attachmentsByQuestionId: {
          "q-screenshot": [
            {
              type: "image",
              id: input.questionAnswerOnlyAttachmentId,
              name: "question-answer.png",
              mimeType: "image/png",
              sizeBytes: 12,
            },
          ],
        },
      },
    };
    events.push({
      id: EventId.make(`seed:${input.threadId}:ti-qa`),
      type: "turn-item.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: updatedAt,
      payload: qaItem,
    });
  }

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

  if (input.pendingSecretRequest) {
    const secretItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make(`ti-secret:${input.threadId}`),
      threadId: input.threadId,
      runId: run1Id,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 5,
      status: "running",
      title: "Secret request",
      startedAt: updatedAt,
      completedAt: null,
      updatedAt,
      type: "secret_request",
      label: TrimmedNonEmptyString.make("OPENAI_API_KEY"),
      reason: "Needed to run integration check",
      secretStatus: "pending",
    };
    events.push({
      id: EventId.make(`seed:${input.threadId}:secret`),
      type: "turn-item.updated",
      threadId: input.threadId,
      runId: run1Id,
      occurredAt: updatedAt,
      payload: secretItem,
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
    "completes full roundtrip: pauses running source, transfers git+attachments, commits with idempotent replay, auto-resumes, releases persisted queued runs, and finalizes source",
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
            const importedUserMsg = destProj.messages.find(
              (m) => m.role === "user" && m.text.includes("lossless transfer bundle"),
            );
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

            // Verify auto-resume sent exactly one continuation turn, and the held queued prompt
            // was persisted atomically in the event batch and released (queueHeld: false) with rewritten attachment ID.
            expect(destRecorder.sentMessages).toHaveLength(1);
            expect(destRecorder.sentMessages[0]?.mode).toBe("auto");
            expect(destRecorder.sentMessages[0]?.text).toContain(
              "Session transferred from Local MacBook",
            );
            const persistedQueuedRun = destProj.runs.find((r) => r.status === "queued");
            expect(persistedQueuedRun).toBeDefined();
            expect(persistedQueuedRun?.queueHeld).toBe(false);
            expect(persistedQueuedRun?.rootNodeId).not.toBeNull();
            expect(persistedQueuedRun?.activeAttemptId).not.toBeNull();
            expect(persistedQueuedRun?.providerThreadId).not.toBeNull();
            const persistedQueuedMsg = destProj.messages.find(
              (m) => m.id === persistedQueuedRun?.userMessageId,
            );
            expect(persistedQueuedMsg?.text).toBe("Follow-up queued prompt after resume");
            expect(persistedQueuedMsg?.attachments.map((a) => a.id)).toEqual([
              rewrittenPresent!.id,
            ]);

            // Idempotent commitImport replay returns exact same result without duplicating turns or runs.
            const replayed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: preparedData.prepared.manifest,
              autoResume: true,
            });
            expect(replayed).toEqual(committed);
            expect(destRecorder.sentMessages).toHaveLength(1);

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
    "pauses destination without auto-resuming for pending runtime request, open secret_request in turnItems, or request arriving during settlement",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-pending-"));
        const sourceRepo = NodePath.join(tmpRoot, "source");
        const destRepo = NodePath.join(tmpRoot, "dest");
        initGitRepo(sourceRepo);
        git(tmpRoot, ["clone", sourceRepo, destRepo]);

        const projectId = ProjectId.make("proj-pending");
        const destProjectId = ProjectId.make("proj-dest");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };

        try {
          // Case A: Pending runtime request + held queued run stays paused.
          const recorderA: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          const layerA = makeEndpointTestLayer({
            environmentId: "env-pending-a",
            environmentLabel: "Shared Env A",
            projects: [
              { id: projectId, title: "Repo", workspaceRoot: sourceRepo },
              { id: destProjectId, title: "DestRepo", workspaceRoot: destRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorderA,
          });

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const sourceThreadId = ThreadId.make("thread-pending-rreq");
            const transferId = SessionTransferId.make("xfer-pending-rreq");

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
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            const committed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prepared.manifest,
              autoResume: true,
            });
            expect(committed.resumed).toBe(false);
            expect(recorderA.sentMessages).toHaveLength(0);

            const destProj = yield* projectionStore.getThreadProjection(
              committed.destinationThreadId,
            );
            expect(destProj.contextHandoffs[0]?.summaryText).toContain(
              "pending approval/user-input request",
            );
            expect(destProj.runs).toHaveLength(1);
            expect(destProj.runs[0]?.status).toBe("queued");
            expect(destProj.runs[0]?.queueHeld).toBe(true);
          }).pipe(Effect.provide(layerA));

          // Case B: Open secret_request item in turnItems (no entry in runtimeRequests) blocks auto-resume.
          const recorderB: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          const layerB = makeEndpointTestLayer({
            environmentId: "env-pending-b",
            environmentLabel: "Shared Env B",
            projects: [
              { id: projectId, title: "Repo", workspaceRoot: sourceRepo },
              { id: destProjectId, title: "DestRepo", workspaceRoot: destRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorderB,
          });

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const sourceThreadId = ThreadId.make("thread-pending-secret");
            const transferId = SessionTransferId.make("xfer-pending-secret");

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "main",
                worktreePath: sourceRepo,
                modelSelection,
                running: true,
                pendingSecretRequest: true,
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
              "OPENAI_API_KEY",
            );
            expect(prepared.manifest.sourceState.pendingRuntimeRequests[0]?.userOnly).toBe(true);

            const staged = yield* svc.stageImport({
              transferId,
              manifest: prepared.manifest,
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            const committed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prepared.manifest,
              autoResume: true,
            });
            expect(committed.resumed).toBe(false);
            expect(recorderB.sentMessages).toHaveLength(0);
          }).pipe(Effect.provide(layerB));

          // Case C: Runtime request arrives DURING settlement (and is cancelled as not_resumable by thread.stop).
          const recorderC: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          const layerC = makeEndpointTestLayer({
            environmentId: "env-pending-c",
            environmentLabel: "Shared Env C",
            projects: [
              { id: projectId, title: "Repo", workspaceRoot: sourceRepo },
              { id: destProjectId, title: "DestRepo", workspaceRoot: destRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorderC,
            hooks: {
              onThreadStop: ({ threadId, eventSink, defaultStop }) =>
                Effect.gen(function* () {
                  yield* defaultStop;
                  const now = yield* DateTime.now;
                  // Inject a late-arriving approval request that was cancelled by the stop.
                  yield* eventSink
                    .write({
                      events: [
                        {
                          id: EventId.make(`late-rreq:${threadId}`),
                          type: "runtime-request.updated",
                          threadId,
                          runId: RunId.make(`run-1:${threadId}`),
                          occurredAt: now,
                          payload: {
                            id: RuntimeRequestId.make(`rreq-late:${threadId}`),
                            nodeId: NodeId.make(`node-late:${threadId}`),
                            providerTurnId: null,
                            nativeRequestRef: null,
                            kind: "command",
                            status: "cancelled",
                            responseCapability: {
                              type: "not_resumable",
                              reason: "The run was interrupted.",
                            },
                            createdAt: now,
                            resolvedAt: now,
                            feedback: "Late approval during settlement",
                          },
                        },
                      ],
                    })
                    .pipe(
                      Effect.mapError((cause) => new TestHookError({ message: String(cause) })),
                    );
                }),
            },
          });

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const sourceThreadId = ThreadId.make("thread-late-rreq");
            const transferId = SessionTransferId.make("xfer-late-rreq");

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "main",
                worktreePath: sourceRepo,
                modelSelection,
                running: true,
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
              "Late approval during settlement",
            );

            const staged = yield* svc.stageImport({
              transferId,
              manifest: prepared.manifest,
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            const committed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prepared.manifest,
              autoResume: true,
            });
            expect(committed.resumed).toBe(false);
            expect(recorderC.sentMessages).toHaveLength(0);
          }).pipe(Effect.provide(layerC));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "preserves archived thread history on A -> B -> A roundtrip via deterministic ID remapping and rejects occupied destinationThreadId",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-aba-"));
        const repoA = NodePath.join(tmpRoot, "repo-a");
        const repoB = NodePath.join(tmpRoot, "repo-b");
        initGitRepo(repoA);
        git(tmpRoot, ["clone", repoA, repoB]);

        const projectA = ProjectId.make("proj-a");
        const projectB = ProjectId.make("proj-b");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };
        const recorderA: MockRecorder = {
          dispatches: [],
          forceStops: [],
          detachedSessions: [],
          sentMessages: [],
        };
        const recorderB: MockRecorder = {
          dispatches: [],
          forceStops: [],
          detachedSessions: [],
          sentMessages: [],
        };

        const layerA = makeEndpointTestLayer({
          environmentId: "env-a",
          environmentLabel: "Machine A",
          projects: [{ id: projectA, title: "Repo A", workspaceRoot: repoA }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder: recorderA,
        });
        const layerB = makeEndpointTestLayer({
          environmentId: "env-b",
          environmentLabel: "Machine B",
          projects: [{ id: projectB, title: "Repo B", workspaceRoot: repoB }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder: recorderB,
        });

        try {
          const threadA1 = ThreadId.make("thread-a1");
          const xferAB = SessionTransferId.make("xfer-a-to-b");
          const xferBA = SessionTransferId.make("xfer-b-to-a");

          // Prepare + finalize A -> B on A, then import on B -> prepare B -> A on B,
          // then import B -> A BACK ON THE SAME MACHINE A SQLITE STORE!
          // We run both A steps inside the SAME layerA scope so SQLite is shared across A -> B -> A.
          yield* Effect.gen(function* () {
            const configA = yield* ServerConfig.ServerConfig;
            const pathA = yield* Path.Path;
            const eventSinkA = yield* EventSink.EventSinkV2;
            const projectionStoreA = yield* ProjectionStore.ProjectionStoreV2;
            const svcA = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            yield* eventSinkA.write({
              events: seedThreadEvents({
                projectId: projectA,
                threadId: threadA1,
                branch: "main",
                worktreePath: repoA,
                modelSelection,
                running: false,
              }),
            });

            const originalA1 = yield* projectionStoreA.getThreadProjection(threadA1);
            const origMsgIds = originalA1.messages.map((m) => m.id);
            const origItemIds = originalA1.turnItems.map((t) => t.id);
            const origPlanIds = originalA1.plans.map((p) => p.id);

            // Step 1: Prepare A -> B on A.
            const prepAB = yield* svcA.prepareSource({
              transferId: xferAB,
              threadId: threadA1,
              direction: "local_to_boat",
            });
            const bundleAB = NodeFS.readFileSync(
              resolveExportBundlePath(configA.stateDir, xferAB, pathA)!,
            );

            // Step 2: Import on B, then prepare B -> A on B.
            const { committedB, prepBA, bundleBA } = yield* Effect.gen(function* () {
              const configB = yield* ServerConfig.ServerConfig;
              const pathB = yield* Path.Path;
              const svcB = yield* SessionTransferEndpointService.SessionTransferEndpointService;

              const stagedB = yield* svcB.stageImport({
                transferId: xferAB,
                manifest: prepAB.manifest,
                targetProjectId: projectB,
              });
              const importPathB = resolveImportBundlePath(configB.stateDir, xferAB, pathB)!;
              NodeFS.mkdirSync(NodePath.dirname(importPathB), { recursive: true });
              NodeFS.writeFileSync(importPathB, bundleAB);

              const committed = yield* svcB.commitImport({
                transferId: xferAB,
                destinationProjectId: stagedB.destinationProjectId,
                destinationThreadId: stagedB.destinationThreadId,
                manifest: prepAB.manifest,
                autoResume: false,
              });

              const prepBack = yield* svcB.prepareSource({
                transferId: xferBA,
                threadId: committed.destinationThreadId,
                direction: "boat_to_local",
              });
              const bundleBack = NodeFS.readFileSync(
                resolveExportBundlePath(configB.stateDir, xferBA, pathB)!,
              );
              return { committedB: committed, prepBA: prepBack, bundleBA: bundleBack };
            }).pipe(Effect.provide(layerB));

            // Finalize & archive A1 on A.
            yield* svcA.finalizeSource({
              transferId: xferAB,
              threadId: threadA1,
              destination: {
                transferId: xferAB,
                environmentId: EnvironmentId.make("env-b"),
                environmentName: TrimmedNonEmptyString.make("Machine B"),
                machineId: null,
                projectId: committedB.destinationProjectId,
                threadId: committedB.destinationThreadId,
                transferredAt: IsoDateTime.make("2026-08-01T10:15:00.000Z"),
              },
            });

            // Step 3: Conflict check — attempting to commitImport targeting occupied threadA1 MUST fail!
            const conflictResult = yield* Effect.result(
              svcA.commitImport({
                transferId: xferBA,
                destinationProjectId: projectA,
                destinationThreadId: threadA1, // Occupied by original thread (no matching transferOrigin)
                manifest: prepBA.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(conflictResult)).toBe(true);
            if (Result.isFailure(conflictResult)) {
              expect(conflictResult.failure.code).toBe("invalid_phase");
            }

            // Step 4: Stage & commit B -> A onto fresh destinationThreadId on SAME SQLite DB!
            const stagedA2 = yield* svcA.stageImport({
              transferId: xferBA,
              manifest: prepBA.manifest,
              targetProjectId: projectA,
            });
            const importPathA2 = resolveImportBundlePath(configA.stateDir, xferBA, pathA)!;
            NodeFS.mkdirSync(NodePath.dirname(importPathA2), { recursive: true });
            NodeFS.writeFileSync(importPathA2, bundleBA);

            const committedA2 = yield* svcA.commitImport({
              transferId: xferBA,
              destinationProjectId: stagedA2.destinationProjectId,
              destinationThreadId: stagedA2.destinationThreadId,
              manifest: prepBA.manifest,
              autoResume: false,
            });

            // Verify archived thread A1 STILL owns ALL its original messages, turnItems, and plans!
            const archivedA1 = yield* projectionStoreA.getThreadProjection(threadA1);
            expect(archivedA1.thread.archivedAt).not.toBeNull();
            expect(archivedA1.messages.map((m) => m.id)).toEqual(origMsgIds);
            expect(archivedA1.turnItems.map((t) => t.id)).toEqual(origItemIds);
            expect(archivedA1.plans.map((p) => p.id)).toEqual(origPlanIds);

            // Verify returned thread A2 has its own remapped IDs with consistent internal cross-references!
            const returnedA2 = yield* projectionStoreA.getThreadProjection(
              committedA2.destinationThreadId,
            );
            expect(returnedA2.messages).toHaveLength(origMsgIds.length);
            expect(returnedA2.turnItems).toHaveLength(origItemIds.length);
            expect(returnedA2.plans).toHaveLength(origPlanIds.length);

            for (const msg of returnedA2.messages) {
              expect(origMsgIds).not.toContain(msg.id);
              expect(msg.threadId).toBe(committedA2.destinationThreadId);
            }
            const a2MsgIds = new Set(returnedA2.messages.map((m) => m.id));
            const a2ItemIds = new Set(returnedA2.turnItems.map((t) => t.id));
            const a2PlanIds = new Set(returnedA2.plans.map((p) => p.id));

            for (const item of returnedA2.turnItems) {
              expect(origItemIds).not.toContain(item.id);
              if (item.parentItemId !== null) {
                expect(a2ItemIds.has(item.parentItemId)).toBe(true);
              }
              if (item.type === "user_message" || item.type === "assistant_message") {
                expect(a2MsgIds.has(item.messageId)).toBe(true);
              }
              if (item.type === "proposed_plan" || item.type === "todo_list") {
                expect(a2PlanIds.has(item.planId)).toBe(true);
              }
            }
          }).pipe(Effect.provide(layerA));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "destination abort after reusing a pre-existing branch removes the created worktree without deleting the pre-existing branch",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-branch-safe-"));
        const sourceRepo = NodePath.join(tmpRoot, "source");
        const destRepo = NodePath.join(tmpRoot, "dest");
        initGitRepo(sourceRepo);
        git(sourceRepo, ["checkout", "-b", "feat/preexisting"]);
        NodeFS.writeFileSync(NodePath.join(sourceRepo, "shared.txt"), "shared\n");
        git(sourceRepo, ["add", "shared.txt"]);
        git(sourceRepo, ["commit", "-m", "shared feature commit"]);

        git(tmpRoot, ["clone", sourceRepo, destRepo]);
        // On destination, check out main so feat/preexisting exists as an IDLE local branch at the same SHA.
        git(destRepo, ["checkout", "-b", "main", "origin/main"]);
        const preexistingSha = git(destRepo, ["rev-parse", "refs/heads/feat/preexisting"]);

        const projectId = ProjectId.make("proj-branch-safe");
        const destProjectId = ProjectId.make("proj-branch-safe-dest");
        const sourceThreadId = ThreadId.make("thread-branch-safe");
        const transferId = SessionTransferId.make("xfer-branch-safe");
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

        let failDestinationCommit = false;
        const layer = makeEndpointTestLayer({
          environmentId: "env-branch-safe",
          environmentLabel: "Branch Safe Env",
          projects: [
            { id: projectId, title: "Source", workspaceRoot: sourceRepo },
            { id: destProjectId, title: "Dest", workspaceRoot: destRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onEventSinkWrite: () =>
              failDestinationCommit
                ? Effect.fail(
                    new TestHookError({
                      message: "Simulated DB write failure after worktree creation",
                    }),
                  )
                : Effect.void,
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "feat/preexisting",
                worktreePath: sourceRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            // Fail eventSink.write AFTER WorkspaceBundle.importWorkspaceBundle creates the worktree
            // reusing the pre-existing feat/preexisting branch.
            failDestinationCommit = true;
            const failedCommit = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: staged.destinationProjectId,
                destinationThreadId: staged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(failedCommit)).toBe(true);
            failDestinationCommit = false;

            // Confirm worktree was created before failure.
            const wtListBeforeAbort = git(destRepo, ["worktree", "list", "--porcelain"]);
            expect(wtListBeforeAbort).toContain("branch refs/heads/feat/preexisting");

            // Abort destination -> MUST remove created worktree AND keep feat/preexisting intact!
            const aborted = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(aborted.cleanedUp).toBe(true);

            const wtListAfterAbort = git(destRepo, ["worktree", "list", "--porcelain"]);
            expect(wtListAfterAbort).not.toContain("branch refs/heads/feat/preexisting");
            expect(git(destRepo, ["rev-parse", "refs/heads/feat/preexisting"])).toBe(
              preexistingSha,
            );
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "serializes concurrent commitImport calls, reuses worktree on retry after event-write failure, and recovers continuation+queue release on durable replay",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-commit-"));
        const sourceRepo = NodePath.join(tmpRoot, "source");
        const destRepo = NodePath.join(tmpRoot, "dest");
        initGitRepo(sourceRepo);
        git(tmpRoot, ["clone", sourceRepo, destRepo]);

        const projectId = ProjectId.make("proj-commit");
        const destProjectId = ProjectId.make("proj-commit-dest");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };

        try {
          // 5a: Concurrent commitImport calls for same transferId allocate only 1 worktree and 1 thread.
          const recorderA: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          const importEntered = yield* Deferred.make<void>();
          const releaseImport = yield* Deferred.make<void>();
          let firstImport = true;

          const layerA = makeEndpointTestLayer({
            environmentId: "env-conc",
            environmentLabel: "Conc Env",
            projects: [
              { id: projectId, title: "Src", workspaceRoot: sourceRepo },
              { id: destProjectId, title: "Dst", workspaceRoot: destRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorderA,
            hooks: {
              onImportWorkspaceBundle: (next) =>
                Effect.gen(function* () {
                  if (firstImport) {
                    firstImport = false;
                    yield* Deferred.succeed(importEntered, undefined);
                    yield* Deferred.await(releaseImport);
                  }
                  return yield* next;
                }),
            },
          });

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThread = ThreadId.make("thread-conc");
            const xferId = SessionTransferId.make("xfer-conc");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: srcThread,
                branch: "main",
                worktreePath: sourceRepo,
                modelSelection,
                running: true,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId: xferId,
              threadId: srcThread,
              direction: "local_to_boat",
            });
            const staged = yield* svc.stageImport({
              transferId: xferId,
              manifest: prep.manifest,
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, xferId, path)!,
              resolveImportBundlePath(config.stateDir, xferId, path)!,
            );

            const commitInput = {
              transferId: xferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: true,
            };

            const fiber1 = yield* Effect.forkChild(svc.commitImport(commitInput));
            yield* Deferred.await(importEntered);
            const fiber2 = yield* Effect.forkChild(svc.commitImport(commitInput));
            yield* Deferred.succeed(releaseImport, undefined);

            const [res1, res2] = yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)]);
            expect(res1).toEqual(res2);
            expect(recorderA.importBundleCount).toBe(1);
            expect(recorderA.sentMessages).toHaveLength(1);
          }).pipe(Effect.provide(layerA));

          // 5b: Retry after simulated event-write failure reuses the already-created worktree.
          const recorderB: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          let failNextCommitWrite = false;
          const layerB = makeEndpointTestLayer({
            environmentId: "env-retry-wt",
            environmentLabel: "Retry WT Env",
            projects: [
              { id: projectId, title: "Src", workspaceRoot: sourceRepo },
              { id: destProjectId, title: "Dst", workspaceRoot: destRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorderB,
            hooks: {
              onEventSinkWrite: () => {
                if (failNextCommitWrite) {
                  failNextCommitWrite = false;
                  return Effect.fail(
                    new TestHookError({ message: "Simulated transient SQLite failure" }),
                  );
                }
                return Effect.void;
              },
            },
          });

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThread = ThreadId.make("thread-retry-wt");
            const xferId = SessionTransferId.make("xfer-retry-wt");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: srcThread,
                branch: "main",
                worktreePath: sourceRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId: xferId,
              threadId: srcThread,
              direction: "local_to_boat",
            });
            const staged = yield* svc.stageImport({
              transferId: xferId,
              manifest: prep.manifest,
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, xferId, path)!,
              resolveImportBundlePath(config.stateDir, xferId, path)!,
            );

            failNextCommitWrite = true;
            const firstAttempt = yield* Effect.result(
              svc.commitImport({
                transferId: xferId,
                destinationProjectId: staged.destinationProjectId,
                destinationThreadId: staged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(firstAttempt)).toBe(true);
            expect(recorderB.importBundleCount).toBe(1);

            // Second attempt reuses the existing worktree without calling importWorkspaceBundle again.
            const secondAttempt = yield* svc.commitImport({
              transferId: xferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: false,
            });
            expect(secondAttempt.destinationWorktreePath).not.toBeNull();
            expect(recorderB.importBundleCount).toBe(1);
          }).pipe(Effect.provide(layerB));

          // 5c: Replay after simulated crash between event write and continuation/queue release
          // completes continuation and releases queueHeld: false without duplicating events or worktrees.
          const recorderC: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          let failNextSend = false;
          const layerC = makeEndpointTestLayer({
            environmentId: "env-crash-replay",
            environmentLabel: "Crash Replay Env",
            projects: [
              { id: projectId, title: "Src", workspaceRoot: sourceRepo },
              { id: destProjectId, title: "Dst", workspaceRoot: destRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorderC,
            hooks: {
              onSendToThread: ({ defaultSend }) => {
                if (failNextSend) {
                  failNextSend = false;
                  return Effect.fail(
                    new TestHookError({ message: "Simulated crash before continuation" }),
                  );
                }
                return defaultSend;
              },
            },
          });

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThread = ThreadId.make("thread-crash-replay");
            const xferId = SessionTransferId.make("xfer-crash-replay");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: srcThread,
                branch: "main",
                worktreePath: sourceRepo,
                modelSelection,
                running: true,
                queuedText: "Queued prompt surviving crash before continuation",
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId: xferId,
              threadId: srcThread,
              direction: "local_to_boat",
            });
            const staged = yield* svc.stageImport({
              transferId: xferId,
              manifest: prep.manifest,
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, xferId, path)!,
              resolveImportBundlePath(config.stateDir, xferId, path)!,
            );

            // Attempt 1: event write succeeds (persisting thread + held queued run), then continuation fails.
            failNextSend = true;
            const firstCommit = yield* svc.commitImport({
              transferId: xferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: true,
            });
            expect(firstCommit.resumed).toBe(false);
            expect(recorderC.sentMessages).toHaveLength(0);
            expect(recorderC.importBundleCount).toBe(1);

            const projMid = yield* projectionStore.getThreadProjection(
              firstCommit.destinationThreadId,
            );
            expect(projMid.runs).toHaveLength(1);
            expect(projMid.runs[0]?.status).toBe("queued");
            expect(projMid.runs[0]?.queueHeld).toBe(true);

            // Attempt 2 (replay): completes continuation AND releases the held queued run without duplicating worktree or runs!
            const replayCommit = yield* svc.commitImport({
              transferId: xferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: true,
            });
            expect(replayCommit.resumed).toBe(true);
            expect(recorderC.sentMessages).toHaveLength(1);
            expect(recorderC.importBundleCount).toBe(1);

            const projAfter = yield* projectionStore.getThreadProjection(
              firstCommit.destinationThreadId,
            );
            const queuedRunsAfter = projAfter.runs.filter((r) => r.status === "queued");
            expect(queuedRunsAfter).toHaveLength(1);
            expect(queuedRunsAfter[0]?.queueHeld).toBe(false);

            // Attempt 3 (further replay): completely idempotent, no second continuation turn!
            const thirdCommit = yield* svc.commitImport({
              transferId: xferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: true,
            });
            expect(thirdCommit.resumed).toBe(true);
            expect(recorderC.sentMessages).toHaveLength(1);
            expect(recorderC.importBundleCount).toBe(1);
          }).pipe(Effect.provide(layerC));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "refuses to export live source on settlement read error or failed/ineffective forceStop, and protects concurrent prepareSource with same transferId",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-src-guard-"));
        const repoDir = NodePath.join(tmpRoot, "repo");
        initGitRepo(repoDir);

        const projectId = ProjectId.make("proj-src-guard");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };

        try {
          // 6a: Projection-read error during settlement propagates (NOT treated as settled).
          let failSettlementRead = false;
          const layerReadErr = makeEndpointTestLayer({
            environmentId: "env-read-err",
            environmentLabel: "ReadErr Env",
            projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onThreadStop: () => {
                // Trigger projection read error when awaitThreadSettled checks isThreadSettled.
                failSettlementRead = true;
                return Effect.void;
              },
              onGetThreadRecords: ({ fields, next }) => {
                if (failSettlementRead && fields.includes("providerTurns")) {
                  return Effect.fail(
                    new TestHookError({ message: "SQLite read error during settlement" }),
                  );
                }
                return next;
              },
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const threadId = ThreadId.make("thread-read-err");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection,
                running: true,
              }),
            });

            const res = yield* Effect.result(
              svc.prepareSource({
                transferId: SessionTransferId.make("xfer-read-err"),
                threadId,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(res)).toBe(true);
            if (Result.isFailure(res)) {
              expect(res.failure.code).toBe("internal");
              expect(res.failure.message).toContain("settlement");
            }
          }).pipe(Effect.provide(layerReadErr));

          // 6b: forceStopThread failure AND still-running thread after forceStop both reject export.
          const recorderForceFail: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          let forceStopMode: "fail" | "noop" = "fail";
          const layerForceFail = makeEndpointTestLayer({
            environmentId: "env-force-fail",
            environmentLabel: "ForceFail Env",
            projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorderForceFail,
            hooks: {
              // Do not mark run interrupted on thread.stop so awaitThreadSettled times out.
              onThreadStop: () => Effect.void,
              onForceStop: () =>
                forceStopMode === "fail"
                  ? Effect.fail(new TestHookError({ message: "forceStopThread RPC failed" }))
                  : Effect.succeed({ sequence: 1 }),
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const threadId = ThreadId.make("thread-force-fail");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection,
                running: true,
              }),
            });

            // Subcase 1: forceStopThread itself fails.
            forceStopMode = "fail";
            const fiberFail = yield* Effect.forkChild(
              Effect.result(
                svc.prepareSource({
                  transferId: SessionTransferId.make("xfer-force-fail-1"),
                  threadId,
                  direction: "local_to_boat",
                }),
              ),
            );
            yield* TestClock.adjust(Duration.seconds(16));
            const resFail = yield* Fiber.join(fiberFail);
            expect(Result.isFailure(resFail)).toBe(true);
            if (Result.isFailure(resFail)) {
              expect(resFail.failure.code).toBe("internal");
              expect(resFail.failure.message).toContain("force-stop");
            }
            expect(recorderForceFail.forceStops).toHaveLength(1);

            // Subcase 2: forceStopThread returns OK, but thread is STILL running on reload -> MUST fail!
            forceStopMode = "noop";
            const fiberStillLive = yield* Effect.forkChild(
              Effect.result(
                svc.prepareSource({
                  transferId: SessionTransferId.make("xfer-force-fail-2"),
                  threadId,
                  direction: "local_to_boat",
                }),
              ),
            );
            yield* TestClock.adjust(Duration.seconds(16));
            const resStillLive = yield* Fiber.join(fiberStillLive);
            expect(Result.isFailure(resStillLive)).toBe(true);
            if (Result.isFailure(resStillLive)) {
              expect(resStillLive.failure.code).toBe("internal");
              expect(resStillLive.failure.message).toContain("still running");
            }
          }).pipe(Effect.provide(layerForceFail));

          // 6c: Concurrent prepareSource with SAME transferId while preparing rejects attempt 2
          // without releasing attempt 1's lock or deleting its staging directory.
          const stopEntered = yield* Deferred.make<void>();
          const releaseStop = yield* Deferred.make<void>();
          const layerConcPrep = makeEndpointTestLayer({
            environmentId: "env-conc-prep",
            environmentLabel: "ConcPrep Env",
            projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onThreadStop: ({ defaultStop }) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(stopEntered, undefined);
                  yield* Deferred.await(releaseStop);
                  yield* defaultStop;
                }),
            },
          });

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const threadId = ThreadId.make("thread-conc-prep");
            const sameTransferId = SessionTransferId.make("xfer-conc-prep-same");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection,
                running: true,
              }),
            });

            // Pre-create staging marker to verify attempt 2's rejection does NOT wipe staging.
            const stagingDir = resolveTransferStagingDir(config.stateDir, sameTransferId, path)!;
            NodeFS.mkdirSync(stagingDir, { recursive: true });
            const markerFile = NodePath.join(stagingDir, "keep.marker");
            NodeFS.writeFileSync(markerFile, "owned-by-attempt-1");

            const fiber1 = yield* Effect.forkChild(
              svc.prepareSource({
                transferId: sameTransferId,
                threadId,
                direction: "local_to_boat",
              }),
            );
            yield* Deferred.await(stopEntered);

            // Attempt 2 with the SAME transferId during "preparing" must fail with already_in_flight.
            const attempt2 = yield* Effect.result(
              svc.prepareSource({
                transferId: sameTransferId,
                threadId,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(attempt2)).toBe(true);
            if (Result.isFailure(attempt2)) {
              expect(attempt2.failure.code).toBe("already_in_flight");
            }
            // Attempt 1's staging directory and lock must still be intact!
            expect(NodeFS.existsSync(markerFile)).toBe(true);

            // Different transferId must ALSO still be blocked (attempt 1 still holds lock).
            const attemptOther = yield* Effect.result(
              svc.prepareSource({
                transferId: SessionTransferId.make("xfer-other-while-prep"),
                threadId,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(attemptOther)).toBe(true);
            if (Result.isFailure(attemptOther)) {
              expect(attemptOther.failure.code).toBe("already_in_flight");
            }

            // Release attempt 1 -> succeeds cleanly.
            yield* Deferred.succeed(releaseStop, undefined);
            const result1 = yield* Fiber.join(fiber1);
            expect(result1.manifest.sourceThreadId).toBe(threadId);
          }).pipe(Effect.provide(layerConcPrep));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "exports, transfers, and rewrites attachments present only in assistant_message and user_input_request.questionAnswer.attachmentsByQuestionId",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-att-all-"));
        const sourceRepo = NodePath.join(tmpRoot, "source");
        const destRepo = NodePath.join(tmpRoot, "dest");
        initGitRepo(sourceRepo);
        git(tmpRoot, ["clone", sourceRepo, destRepo]);

        const projectId = ProjectId.make("proj-att-all");
        const destProjectId = ProjectId.make("proj-att-all-dest");
        const sourceThreadId = ThreadId.make("thread-att-all");
        const transferId = SessionTransferId.make("xfer-att-all");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };
        const layer = makeEndpointTestLayer({
          environmentId: "env-att-all",
          environmentLabel: "Att All Env",
          projects: [
            { id: projectId, title: "Src", workspaceRoot: sourceRepo },
            { id: destProjectId, title: "Dst", workspaceRoot: destRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const assistantAttId = ChatAttachmentId.make(createAttachmentId(sourceThreadId)!);
            const questionAttId = ChatAttachmentId.make(createAttachmentId(sourceThreadId)!);
            const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${assistantAttId}.png`),
              pngBytes,
            );
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${questionAttId}.png`),
              pngBytes,
            );

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "main",
                worktreePath: sourceRepo,
                modelSelection,
                running: false,
                assistantOnlyAttachmentId: assistantAttId,
                questionAnswerOnlyAttachmentId: questionAttId,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            const exportedIds = new Set(prep.manifest.attachments.map((a) => a.attachmentId));
            expect(exportedIds.has(assistantAttId)).toBe(true);
            expect(exportedIds.has(questionAttId)).toBe(true);
            for (const ref of prep.manifest.attachments) {
              expect(ref.downloadRelativeUrl).toMatch(/^\/api\/assets\//);
            }

            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: destProjectId,
            });
            expect(staged.attachmentUploads).toHaveLength(2);
            const attachmentIdMap: Record<string, ChatAttachmentId> = {};
            for (const upload of staged.attachmentUploads) {
              NodeFS.writeFileSync(
                NodePath.join(config.attachmentsDir, `${upload.destinationAttachmentId}.png`),
                pngBytes,
              );
              attachmentIdMap[upload.sourceAttachmentId] = upload.destinationAttachmentId;
            }
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            const committed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: false,
              attachmentIdMap,
            });

            const destProj = yield* projectionStore.getThreadProjection(
              committed.destinationThreadId,
            );
            const asstItem = destProj.turnItems.find((i) => i.type === "assistant_message");
            expect(asstItem?.type).toBe("assistant_message");
            if (asstItem?.type === "assistant_message") {
              expect(asstItem.attachments).toHaveLength(1);
              expect(asstItem.attachments![0]!.id).not.toBe(assistantAttId);
              expect(
                resolveAttachmentPathById({
                  attachmentsDir: config.attachmentsDir,
                  attachmentId: asstItem.attachments![0]!.id,
                }),
              ).not.toBeNull();
            }

            const uirItem = destProj.turnItems.find((i) => i.type === "user_input_request");
            expect(uirItem?.type).toBe("user_input_request");
            if (uirItem?.type === "user_input_request") {
              const qaAtts = uirItem.questionAnswer?.attachmentsByQuestionId["q-screenshot"] ?? [];
              expect(qaAtts).toHaveLength(1);
              expect(qaAtts[0]!.id).not.toBe(questionAttId);
              expect(
                resolveAttachmentPathById({
                  attachmentsDir: config.attachmentsDir,
                  attachmentId: qaAtts[0]!.id,
                }),
              ).not.toBeNull();
            }
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "refreshes all attachment download URLs and bundle URL on cached prepareSource retry and assigns collision-free destinationThreadIds",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-refresh-"));
        const repoDir = NodePath.join(tmpRoot, "repo");
        initGitRepo(repoDir);

        const projectId = ProjectId.make("proj-refresh");
        const sourceThreadId = ThreadId.make("thread-refresh");
        const transferId = SessionTransferId.make("xfer-refresh-urls");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };
        const layer = makeEndpointTestLayer({
          environmentId: "env-refresh",
          environmentLabel: "Refresh Env",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const attId = ChatAttachmentId.make(createAttachmentId(sourceThreadId)!);
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${attId}.png`),
              new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]),
            );

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection,
                running: false,
                presentAttachmentId: attId,
              }),
            });

            const first = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            const firstBundleUrl = first.bundleDownloadRelativeUrl!;
            const firstAttUrl = first.manifest.attachments[0]!.downloadRelativeUrl!;
            const firstAttExpiresAt = decodeSignedAssetExpiresAt(firstAttUrl);

            // Advance clock past the 15-minute token TTL.
            yield* TestClock.adjust(Duration.millis(SESSION_TRANSFER_TOKEN_TTL_MS + 60_000));
            const nowAfterAdvance = yield* Clock.currentTimeMillis;

            // Old bundle token is now expired.
            const firstBundleToken = firstBundleUrl.split("/")[3]!;
            expect(
              yield* validateSessionTransferBundleToken(firstBundleToken, "download"),
            ).toBeNull();
            expect(firstAttExpiresAt).toBeLessThan(nowAfterAdvance);

            // Retry prepareSource -> both bundle URL AND every attachment URL are freshly signed!
            const retried = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            const retriedBundleUrl = retried.bundleDownloadRelativeUrl!;
            const retriedAttUrl = retried.manifest.attachments[0]!.downloadRelativeUrl!;
            expect(retriedBundleUrl).not.toBe(firstBundleUrl);
            expect(retriedAttUrl).not.toBe(firstAttUrl);

            const retriedBundleToken = retriedBundleUrl.split("/")[3]!;
            const validBundleClaims = yield* validateSessionTransferBundleToken(
              retriedBundleToken,
              "download",
            );
            expect(validBundleClaims).not.toBeNull();
            expect(decodeSignedAssetExpiresAt(retriedAttUrl)).toBeGreaterThan(nowAfterAdvance);

            // Punctuation-distinct transferIds must yield distinct deterministic destinationThreadIds!
            const stagedSlash = yield* svc.stageImport({
              transferId: SessionTransferId.make("xfer/punct"),
              manifest: first.manifest,
              targetProjectId: projectId,
            });
            const stagedColon = yield* svc.stageImport({
              transferId: SessionTransferId.make("xfer:punct"),
              manifest: first.manifest,
              targetProjectId: projectId,
            });
            expect(stagedSlash.destinationThreadId).not.toBe(stagedColon.destinationThreadId);
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

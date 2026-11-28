// @effect-diagnostics nodeBuiltinImport:off -- test harness initializes real git repos and inspects restored files/attachments on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ChatAttachmentId,
  ComposerContextId,
  EnvironmentId,
  EventId,
  GitRefName,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationMessageContext,
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
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  SessionTransferId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AssetSigner from "../assets/AssetSigner.ts";
import {
  resolveExportBundlePath,
  resolveImportBundlePath,
  resolveTransferStagingDir,
  resolveWorktreeOwnershipPath,
  SESSION_TRANSFER_STALE_TTL_MS,
  SESSION_TRANSFER_TOKEN_TTL_MS,
  sweepStaleSessionTransferStaging,
  validateSessionTransferBundleToken,
} from "../assets/SessionTransferToken.ts";
import { createAttachmentId, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as BoatSupervisor from "../boat/BoatSupervisor.ts";
import * as SessionTransferCoordinator from "../boat/SessionTransferCoordinator.ts";
import * as SessionTransferRepository from "../persistence/SessionTransferRepository.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
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

function cloneGitRepo(srcRepo: string, dstRepo: string): void {
  git(NodePath.dirname(dstRepo), ["clone", srcRepo, dstRepo]);
  git(dstRepo, ["config", "user.name", "Transfer Test"]);
  git(dstRepo, ["config", "user.email", "transfer@example.com"]);
}

function readGitCommonDirIdentitySync(repoDir: string) {
  const commonDir = NodeFS.realpathSync(NodePath.join(repoDir, ".git"));
  const commonStat = NodeFS.lstatSync(commonDir, { bigint: true });
  const objectsStat = NodeFS.lstatSync(NodePath.join(commonDir, "objects"), { bigint: true });
  return {
    deviceId: commonStat.dev.toString(),
    inode: commonStat.ino.toString(),
    birthtimeNs: commonStat.birthtimeNs > 0n ? commonStat.birthtimeNs.toString() : null,
    objectsInode: objectsStat.ino.toString(),
    objectsBirthtimeNs: objectsStat.birthtimeNs > 0n ? objectsStat.birthtimeNs.toString() : null,
  };
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
  readonly onGetThreadWorktreePaths?: (ctx: {
    readonly next: ReturnType<
      ProjectionStore.ProjectionStoreV2["Service"]["getThreadWorktreePaths"]
    >;
  }) => ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadWorktreePaths"]>;
  readonly onImportWorkspaceBundle?: <A, E>(next: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly onExportWorkspaceBundle?: <A, E>(
    next: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | WorkspaceBundle.WorkspaceBundleError>;
  readonly onFileSystemRemove?: (ctx: {
    readonly targetPath: string;
    readonly next: Effect.Effect<void, PlatformError.PlatformError>;
  }) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly onProjectGetById?: <A, E>(next: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly onVcsRun?: (ctx: {
    readonly input: VcsProcess.VcsProcessInput;
    readonly next: ReturnType<VcsProcess.VcsProcess["Service"]["run"]>;
  }) => ReturnType<VcsProcess.VcsProcess["Service"]["run"]>;
  readonly onAssetSign?: (ctx: {
    readonly next: ReturnType<AssetSigner.AssetSigner["Service"]["sign"]>;
  }) => ReturnType<AssetSigner.AssetSigner["Service"]["sign"]>;
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
  readonly sharedBaseDir?: string;
}) {
  const rawBaseLayer = Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer);
  const baseLayer =
    options.hooks?.onFileSystemRemove !== undefined
      ? Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const inner = yield* FileSystem.FileSystem;
            const hook = options.hooks!.onFileSystemRemove!;
            return {
              ...inner,
              remove: (targetPath, removeOptions) =>
                hook({
                  targetPath,
                  next: inner.remove(targetPath, removeOptions),
                }),
            } satisfies FileSystem.FileSystem;
          }),
        ).pipe(Layer.provideMerge(rawBaseLayer))
      : rawBaseLayer;
  const configLayer = ServerConfig.layerTest(
    process.cwd(),
    options.sharedBaseDir ?? {
      prefix: `t3-xfer-endpoint-${options.environmentId}-`,
    },
  ).pipe(Layer.provideMerge(baseLayer));

  const sqliteLayer = (
    options.sharedBaseDir !== undefined
      ? SqlitePersistence.layerConfig
      : SqlitePersistence.layerMemory
  ).pipe(Layer.provideMerge(configLayer));
  const eventStoreLayer = EventStore.layer.pipe(Layer.provideMerge(sqliteLayer));
  const rawProjectionStoreLayer = ProjectionStore.layer.pipe(Layer.provideMerge(eventStoreLayer));
  const projectionStoreLayer =
    options.hooks?.onGetThreadRecords !== undefined ||
    options.hooks?.onGetThreadWorktreePaths !== undefined
      ? Layer.effect(
          ProjectionStore.ProjectionStoreV2,
          Effect.gen(function* () {
            const inner = yield* ProjectionStore.ProjectionStoreV2;
            const getThreadRecordsHook = options.hooks?.onGetThreadRecords;
            const getThreadWorktreePathsHook = options.hooks?.onGetThreadWorktreePaths;
            return {
              ...inner,
              ...(getThreadRecordsHook !== undefined
                ? {
                    getThreadRecords: (threadId, fields, filter) =>
                      getThreadRecordsHook({
                        threadId,
                        fields,
                        next: inner.getThreadRecords(threadId, fields, filter),
                      }) as never,
                  }
                : {}),
              ...(getThreadWorktreePathsHook !== undefined
                ? {
                    getThreadWorktreePaths: (queryOptions) =>
                      getThreadWorktreePathsHook({
                        next: inner.getThreadWorktreePaths(queryOptions),
                      }),
                  }
                : {}),
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
  const rawSignerLayer = AssetSigner.layer.pipe(Layer.provideMerge(secretLayer));
  const signerLayer =
    options.hooks?.onAssetSign !== undefined
      ? Layer.effect(
          AssetSigner.AssetSigner,
          Effect.gen(function* () {
            const inner = yield* AssetSigner.AssetSigner;
            const hook = options.hooks!.onAssetSign!;
            return AssetSigner.AssetSigner.of({
              ...inner,
              sign: (payload) =>
                hook({
                  next: inner.sign(payload),
                }),
            });
          }),
        ).pipe(Layer.provideMerge(rawSignerLayer))
      : rawSignerLayer;
  const documentTextLayer = DocumentText.layer.pipe(Layer.provideMerge(configLayer));
  const rawVcsProcessLayer = VcsProcess.layer.pipe(Layer.provideMerge(configLayer));
  const vcsProcessLayer =
    options.hooks?.onVcsRun !== undefined
      ? Layer.effect(
          VcsProcess.VcsProcess,
          Effect.gen(function* () {
            const inner = yield* VcsProcess.VcsProcess;
            const hook = options.hooks!.onVcsRun!;
            return VcsProcess.VcsProcess.of({
              run: (runInput) =>
                hook({
                  input: runInput,
                  next: inner.run(runInput),
                }),
            });
          }),
        ).pipe(Layer.provideMerge(rawVcsProcessLayer))
      : rawVcsProcessLayer;
  const rawWorkspaceBundleLayer = WorkspaceBundle.layer.pipe(Layer.provideMerge(vcsProcessLayer));
  const workspaceBundleLayer = Layer.effect(
    WorkspaceBundle.WorkspaceBundle,
    Effect.gen(function* () {
      const inner = yield* WorkspaceBundle.WorkspaceBundle;
      return WorkspaceBundle.WorkspaceBundle.of({
        ...inner,
        exportWorkspaceBundle: (exportInput) => {
          const next = inner.exportWorkspaceBundle(exportInput);
          return options.hooks?.onExportWorkspaceBundle !== undefined
            ? options.hooks.onExportWorkspaceBundle(next)
            : next;
        },
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
    getById: (id) => {
      const next = Effect.succeed(Option.fromNullishOr(projectMap.get(id)) as never);
      return options.hooks?.onProjectGetById !== undefined
        ? options.hooks.onProjectGetById(next)
        : next;
    },
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
    const qAttId = RunAttemptId.make(`qatt-2:${input.threadId}`);
    const qNodeId = NodeId.make(`qnode-2:${input.threadId}`);
    const qProviderThreadId = ProviderThreadId.make(`pt:${input.threadId}`);
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
        nodeId: qNodeId,
        occurredAt: updatedAt,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: qMsgId,
          threadId: input.threadId,
          runId: run2Id,
          nodeId: qNodeId,
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
        nodeId: qNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: updatedAt,
        payload: {
          id: run2Id,
          threadId: input.threadId,
          ordinal: 2,
          providerInstanceId: input.modelSelection.instanceId,
          modelSelection: input.modelSelection,
          providerThreadId: qProviderThreadId,
          userMessageId: qMsgId,
          rootNodeId: qNodeId,
          activeAttemptId: qAttId,
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
      {
        id: EventId.make(`seed:${input.threadId}:qatt`),
        type: "run-attempt.created",
        threadId: input.threadId,
        runId: run2Id,
        nodeId: qNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: updatedAt,
        payload: {
          id: qAttId,
          runId: run2Id,
          attemptOrdinal: 1,
          rootNodeId: qNodeId,
          providerInstanceId: input.modelSelection.instanceId,
          providerThreadId: qProviderThreadId,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
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

  it.effect(
    "settles cleanly when a queued run has a pending attempt (activeAttemptId set) on both running and idle threads",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-queued-att-"));
        const repoDir = NodePath.join(tmpRoot, "repo");
        initGitRepo(repoDir);

        const projectId = ProjectId.make("proj-qatt");
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
          environmentId: "env-qatt",
          environmentLabel: "Queued Attempt Env",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
        });

        try {
          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            // Case 1: Running thread + queued run with pending attempt settles without force-stop or timeout.
            const runningThreadId = ThreadId.make("thread-running-with-qatt");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: runningThreadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection,
                running: true,
                queuedText: "Queued prompt with pending attempt",
              }),
            });

            const seededRunning = yield* projectionStore.getThreadProjection(runningThreadId);
            const queuedRun = seededRunning.runs.find((r) => r.status === "queued");
            expect(queuedRun?.activeAttemptId).not.toBeNull();
            expect(
              seededRunning.attempts.some(
                (a) => a.id === queuedRun?.activeAttemptId && a.status === "pending",
              ),
            ).toBe(true);

            const prepRunning = yield* svc.prepareSource({
              transferId: SessionTransferId.make("xfer-qatt-running"),
              threadId: runningThreadId,
              direction: "local_to_boat",
            });
            expect(prepRunning.manifest.sourceState.wasRunning).toBe(true);
            expect(prepRunning.manifest.heldQueuedRuns).toHaveLength(1);
            expect(prepRunning.manifest.heldQueuedRuns[0]?.text).toBe(
              "Queued prompt with pending attempt",
            );
            expect(recorder.forceStops).toHaveLength(0);

            // Case 2: Idle thread (no active run) + queued run with pending attempt -> wasRunning is false, no stop needed.
            const idleThreadId = ThreadId.make("thread-idle-with-qatt");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: idleThreadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection,
                running: false,
                queuedText: "Queued on idle thread",
              }),
            });
            const dispatchesBefore = recorder.dispatches.length;
            const prepIdle = yield* svc.prepareSource({
              transferId: SessionTransferId.make("xfer-qatt-idle"),
              threadId: idleThreadId,
              direction: "local_to_boat",
            });
            expect(prepIdle.manifest.sourceState.wasRunning).toBe(false);
            expect(prepIdle.manifest.heldQueuedRuns).toHaveLength(1);
            expect(recorder.dispatches.length).toBe(dispatchesBefore);
            expect(recorder.forceStops).toHaveLength(0);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "serializes concurrent commitImport calls with distinct transferIds targeting the same destinationThreadId",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-dual-lock-"));
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);

        const projectId = ProjectId.make("proj-dual");
        const destProjectId = ProjectId.make("proj-dual-dest");
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

        const importEntered = yield* Deferred.make<void>();
        const releaseImport = yield* Deferred.make<void>();
        let importCalls = 0;

        const layer = makeEndpointTestLayer({
          environmentId: "env-dual",
          environmentLabel: "Dual Lock Env",
          projects: [
            { id: projectId, title: "Src", workspaceRoot: srcRepo },
            { id: destProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            // Pause the first transfer inside importWorkspaceBundle so a second transfer overlaps
            // unless commitImport serializes on destinationThreadId.
            onImportWorkspaceBundle: (next) =>
              Effect.gen(function* () {
                importCalls += 1;
                yield* Deferred.succeed(importEntered, undefined);
                yield* Deferred.await(releaseImport);
                return yield* next;
              }),
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThread1 = ThreadId.make("thread-dual-src-1");
            const srcThread2 = ThreadId.make("thread-dual-src-2");
            yield* eventSink.write({
              events: [
                ...seedThreadEvents({
                  projectId,
                  threadId: srcThread1,
                  branch: "main",
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId,
                  threadId: srcThread2,
                  branch: "main",
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
              ],
            });

            const xfer1 = SessionTransferId.make("xfer-dual-1");
            const xfer2 = SessionTransferId.make("xfer-dual-2");
            const prep1 = yield* svc.prepareSource({
              transferId: xfer1,
              threadId: srcThread1,
              direction: "local_to_boat",
            });
            const prep2 = yield* svc.prepareSource({
              transferId: xfer2,
              threadId: srcThread2,
              direction: "local_to_boat",
            });

            yield* svc.stageImport({
              transferId: xfer1,
              manifest: prep1.manifest,
              targetProjectId: destProjectId,
            });
            yield* svc.stageImport({
              transferId: xfer2,
              manifest: prep2.manifest,
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, xfer1, path)!,
              resolveImportBundlePath(config.stateDir, xfer1, path)!,
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, xfer2, path)!,
              resolveImportBundlePath(config.stateDir, xfer2, path)!,
            );

            const sharedDestThreadId = ThreadId.make("thread-shared-vacant-target");
            const fiber1 = yield* Effect.forkChild(
              Effect.result(
                svc.commitImport({
                  transferId: xfer1,
                  destinationProjectId: destProjectId,
                  destinationThreadId: sharedDestThreadId,
                  manifest: prep1.manifest,
                  autoResume: false,
                }),
              ),
            );
            const fiber2 = yield* Effect.forkChild(
              Effect.result(
                svc.commitImport({
                  transferId: xfer2,
                  destinationProjectId: destProjectId,
                  destinationThreadId: sharedDestThreadId,
                  manifest: prep2.manifest,
                  autoResume: false,
                }),
              ),
            );
            yield* Deferred.await(importEntered);
            yield* Effect.yieldNow;
            expect(importCalls).toBe(1);
            yield* Deferred.succeed(releaseImport, undefined);
            const res1 = yield* Fiber.join(fiber1);
            const res2 = yield* Fiber.join(fiber2);

            const outcomes = [
              { transferId: xfer1, result: res1 },
              { transferId: xfer2, result: res2 },
            ];
            const winners = outcomes.filter((o) => Result.isSuccess(o.result));
            const losers = outcomes.filter((o) => Result.isFailure(o.result));
            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
            if (Result.isFailure(losers[0]!.result)) {
              expect(losers[0]!.result.failure.code).toBe("invalid_phase");
            }

            const committed = yield* projectionStore.getThreadProjection(sharedDestThreadId);
            expect(committed.thread.transferOrigin?.transferId).toBe(winners[0]!.transferId);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "replays transfer continuation even when an unrelated non-queued run exists on the destination thread",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-replay-exact-"));
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);

        const projectId = ProjectId.make("proj-exact");
        const destProjectId = ProjectId.make("proj-exact-dest");
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

        let failSend = true;
        const layer = makeEndpointTestLayer({
          environmentId: "env-exact",
          environmentLabel: "Exact Replay Env",
          projects: [
            { id: projectId, title: "Src", workspaceRoot: srcRepo },
            { id: destProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onSendToThread: ({ defaultSend }) =>
              failSend
                ? Effect.fail(new TestHookError({ message: "transient send failure" }))
                : defaultSend,
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const sourceThreadId = ThreadId.make("thread-exact-src");
            const transferId = SessionTransferId.make("xfer-exact-replay");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: sourceThreadId,
                branch: "main",
                worktreePath: srcRepo,
                modelSelection,
                running: true,
                queuedText: "Held queued prompt",
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

            // First commit fails to send continuation -> resumed: false, queued run still held.
            const firstCommit = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: true,
            });
            expect(firstCommit.resumed).toBe(false);
            expect(recorder.sentMessages).toHaveLength(0);

            // Inject an UNRELATED completed non-queued run onto the destination thread.
            const now = yield* DateTime.now;
            const unrelatedMsgId = MessageId.make("unrelated-msg-1");
            const unrelatedRunId = RunId.make("unrelated-run-1");
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("unrelated-msg-evt"),
                  type: "message.updated",
                  threadId: staged.destinationThreadId,
                  runId: unrelatedRunId,
                  occurredAt: now,
                  payload: {
                    createdBy: "user",
                    creationSource: "web",
                    id: unrelatedMsgId,
                    threadId: staged.destinationThreadId,
                    runId: unrelatedRunId,
                    nodeId: null,
                    role: "user",
                    text: "Unrelated user prompt",
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
                {
                  id: EventId.make("unrelated-run-evt"),
                  type: "run.created",
                  threadId: staged.destinationThreadId,
                  runId: unrelatedRunId,
                  providerInstanceId: modelSelection.instanceId,
                  occurredAt: now,
                  payload: {
                    id: unrelatedRunId,
                    threadId: staged.destinationThreadId,
                    ordinal: 99,
                    providerInstanceId: modelSelection.instanceId,
                    modelSelection,
                    providerThreadId: null,
                    userMessageId: unrelatedMsgId,
                    rootNodeId: null,
                    activeAttemptId: null,
                    status: "completed",
                    queuePosition: null,
                    queueHeld: false,
                    requestedAt: now,
                    startedAt: now,
                    completedAt: now,
                    checkpointId: null,
                    contextHandoffId: null,
                  },
                },
              ],
            });

            // Replay while sendToThread STILL fails: must NOT falsely claim resumed: true or release held queue!
            const secondCommitStillFailing = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: true,
            });
            expect(secondCommitStillFailing.resumed).toBe(false);
            expect(recorder.sentMessages).toHaveLength(0);
            const projMid = yield* projectionStore.getThreadProjection(staged.destinationThreadId);
            expect(projMid.runs.find((r) => r.status === "queued")?.queueHeld).toBe(true);

            // Now allow sendToThread to succeed: replay actually sends the transfer continuation and releases held queue!
            failSend = false;
            const thirdCommit = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: true,
            });
            expect(thirdCommit.resumed).toBe(true);
            expect(recorder.sentMessages).toHaveLength(1);
            const projAfter = yield* projectionStore.getThreadProjection(
              staged.destinationThreadId,
            );
            expect(projAfter.runs.find((r) => r.status === "queued")?.queueHeld).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "serializes concurrent stageImport and commitImport on the same transferId without clobbering worktreePath or createdBranch",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-stage-race-"));
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);
        git(srcRepo, ["checkout", "-b", "feat/stage-race"]);
        NodeFS.writeFileSync(NodePath.join(srcRepo, "race.txt"), "stage race\n");
        git(srcRepo, ["add", "race.txt"]);
        git(srcRepo, ["commit", "-m", "stage race commit"]);

        const projectId = ProjectId.make("proj-stage-race");
        const destProjectId = ProjectId.make("proj-stage-race-dst");
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

        const commitImportEntered = yield* Deferred.make<void>();
        const allowCommitImportFinish = yield* Deferred.make<void>();
        let failNextCommitEventWrite = false;
        let pauseImport = false;

        const layer = makeEndpointTestLayer({
          environmentId: "env-stage-race",
          environmentLabel: "Stage Race Env",
          projects: [
            { id: projectId, title: "Src", workspaceRoot: srcRepo },
            { id: destProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onImportWorkspaceBundle: (next) =>
              Effect.gen(function* () {
                const imported = yield* next;
                if (pauseImport) {
                  yield* Deferred.succeed(commitImportEntered, undefined);
                  yield* Deferred.await(allowCommitImportFinish);
                }
                return imported;
              }),
            onEventSinkWrite: (events) => {
              if (failNextCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                failNextCommitEventWrite = false;
                return Effect.fail(new TestHookError({ message: "fail commit after worktree" }));
              }
              return Effect.void;
            },
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThreadId = ThreadId.make("thread-stage-race");
            const transferId = SessionTransferId.make("xfer-stage-race");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId: srcThreadId,
                branch: "feat/stage-race",
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "local_to_boat",
            });
            const initialStaged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: destProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            // Launch commitImport (which imports worktree, records worktreePath/createdBranch, then fails event write)
            // concurrently with a second stageImport on the same transferId.
            pauseImport = true;
            failNextCommitEventWrite = true;
            const commitFiber = yield* Effect.forkChild(
              Effect.result(
                svc.commitImport({
                  transferId,
                  destinationProjectId: initialStaged.destinationProjectId,
                  destinationThreadId: initialStaged.destinationThreadId,
                  manifest: prep.manifest,
                  autoResume: false,
                }),
              ),
            );
            yield* Deferred.await(commitImportEntered);

            // Start concurrent stageImport while commitImport holds the transferId lock.
            const stageFiber = yield* Effect.forkChild(
              svc.stageImport({
                transferId,
                manifest: prep.manifest,
                targetProjectId: destProjectId,
              }),
            );
            yield* Effect.yieldNow;
            yield* Deferred.succeed(allowCommitImportFinish, undefined);

            const commitResult = yield* Fiber.join(commitFiber);
            expect(Result.isFailure(commitResult)).toBe(true);
            const secondStaged = yield* Fiber.join(stageFiber);

            // Concurrent stageImport must NOT clobber the recorded worktreePath/branch/createdBranch!
            expect(secondStaged.destinationWorktreePath).not.toBeNull();
            expect(secondStaged.destinationBranch).toBe("feat/stage-race");
            const worktreePath = secondStaged.destinationWorktreePath!;
            expect(NodeFS.existsSync(worktreePath)).toBe(true);

            // Destination abort still sees worktreePath & createdBranch: true and cleans BOTH cleanly!
            const aborted = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(aborted.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(worktreePath)).toBe(false);
            const branchList = git(dstRepo, ["branch", "--list", "feat/stage-race"]).trim();
            expect(branchList).toBe("");
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "guards source transfer locks on both threadId and transferId, and finishes staging cleanup before releasing the lock on error",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-src-lock-"));
        const repoDir = NodePath.join(tmpRoot, "repo");
        initGitRepo(repoDir);

        const projectId = ProjectId.make("proj-src-lock");
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

        const cleanupEntered = yield* Deferred.make<void>();
        const allowCleanupFinish = yield* Deferred.make<void>();
        let failFirstExport = true;
        let pauseCleanup = false;
        let cleanupTargetPrefix = "";

        const layer = makeEndpointTestLayer({
          environmentId: "env-src-lock",
          environmentLabel: "Source Lock Env",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onExportWorkspaceBundle: (next) =>
              Effect.gen(function* () {
                const exported = yield* next;
                if (failFirstExport) {
                  failFirstExport = false;
                  return yield* new WorkspaceBundle.WorkspaceBundleError({
                    code: "git_error",
                    message: "simulated export failure after staging write",
                  });
                }
                return exported;
              }),
            onFileSystemRemove: ({ targetPath, next }) =>
              Effect.gen(function* () {
                if (
                  pauseCleanup &&
                  cleanupTargetPrefix.length > 0 &&
                  targetPath.includes(cleanupTargetPrefix)
                ) {
                  pauseCleanup = false;
                  yield* Deferred.succeed(cleanupEntered, undefined);
                  yield* Deferred.await(allowCleanupFinish);
                }
                return yield* next;
              }),
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const threadA = ThreadId.make("thread-src-lock-A");
            const threadB = ThreadId.make("thread-src-lock-B");
            yield* eventSink.write({
              events: [
                ...seedThreadEvents({
                  projectId,
                  threadId: threadA,
                  branch: "main",
                  worktreePath: repoDir,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId,
                  threadId: threadB,
                  branch: "main",
                  worktreePath: repoDir,
                  modelSelection,
                  running: false,
                }),
              ],
            });

            // Part 1: On error cleanup, lock stays held until cleanupTransferStagingDir completes!
            const xferCleanup = SessionTransferId.make("xfer-cleanup-order");
            const stagingDir = resolveTransferStagingDir(config.stateDir, xferCleanup, path)!;
            cleanupTargetPrefix = NodePath.basename(stagingDir);
            pauseCleanup = true;

            const failedFiber = yield* Effect.forkChild(
              Effect.result(
                svc.prepareSource({
                  transferId: xferCleanup,
                  threadId: threadA,
                  direction: "local_to_boat",
                }),
              ),
            );

            // Wait until cleanupOnOwnError is inside fileSystem.remove(stagingDir).
            yield* Deferred.await(cleanupEntered);

            // While cleanup is still running, retry on threadA AND competing threadB with same transferId are BOTH rejected!
            const retryDuringCleanup = yield* Effect.result(
              svc.prepareSource({
                transferId: xferCleanup,
                threadId: threadA,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(retryDuringCleanup)).toBe(true);
            if (Result.isFailure(retryDuringCleanup)) {
              expect(retryDuringCleanup.failure.code).toBe("already_in_flight");
            }

            const otherThreadDuringCleanup = yield* Effect.result(
              svc.prepareSource({
                transferId: xferCleanup,
                threadId: threadB,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(otherThreadDuringCleanup)).toBe(true);
            if (Result.isFailure(otherThreadDuringCleanup)) {
              expect(otherThreadDuringCleanup.failure.code).toBe("already_in_flight");
            }

            // Finish cleanup -> first call returns error, staging dir is already gone, and immediate retry succeeds!
            yield* Deferred.succeed(allowCleanupFinish, undefined);
            const firstOutcome = yield* Fiber.join(failedFiber);
            expect(Result.isFailure(firstOutcome)).toBe(true);
            expect(NodeFS.existsSync(stagingDir)).toBe(false);

            const retryAfterCleanup = yield* svc.prepareSource({
              transferId: xferCleanup,
              threadId: threadA,
              direction: "local_to_boat",
            });
            expect(retryAfterCleanup.manifest.sourceThreadId).toBe(threadA);
            expect(
              NodeFS.existsSync(resolveExportBundlePath(config.stateDir, xferCleanup, path)!),
            ).toBe(true);

            // Part 2: Different source thread attempting the SAME transferId while threadA owns it is rejected cleanly.
            const crossThreadConflict = yield* Effect.result(
              svc.prepareSource({
                transferId: xferCleanup,
                threadId: threadB,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(crossThreadConflict)).toBe(true);
            if (Result.isFailure(crossThreadConflict)) {
              expect(crossThreadConflict.failure.code).toBe("already_in_flight");
            }
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "scopes cancelled secret_request pause guard only to runs interrupted by this transfer, ignoring historical interrupted runs",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-hist-secret-"));
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);

        const projectId = ProjectId.make("proj-hist-secret");
        const destProjectId = ProjectId.make("proj-hist-secret-dst");
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
          environmentId: "env-hist-secret",
          environmentLabel: "Historical Secret Env",
          projects: [
            { id: projectId, title: "Src", workspaceRoot: srcRepo },
            { id: destProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const sourceThreadId = ThreadId.make("thread-hist-secret");
            const transferId = SessionTransferId.make("xfer-hist-secret");

            // Seed a thread with an EARLIER interrupted run (run-1) that had a cancelled secret_request,
            // followed by a CLEAN later running turn (run-2) with no open requests.
            const baseEvents = seedThreadEvents({
              projectId,
              threadId: sourceThreadId,
              branch: "main",
              worktreePath: srcRepo,
              modelSelection,
              running: false,
            });
            const oldInterruptedAt = DateTime.makeUnsafe("2026-01-01T00:00:05.000Z");
            const run1Id = RunId.make(`run-1:${sourceThreadId}`);
            const run2Id = RunId.make(`run-2-clean:${sourceThreadId}`);
            const msg2Id = MessageId.make(`msg-2-clean:${sourceThreadId}`);
            const laterStart = DateTime.makeUnsafe("2026-01-01T00:01:00.000Z");

            yield* eventSink.write({
              events: [
                ...baseEvents,
                // Mark run-1 as historically interrupted at oldInterruptedAt
                {
                  id: EventId.make(`hist-int-run1:${sourceThreadId}`),
                  type: "run.updated",
                  threadId: sourceThreadId,
                  runId: run1Id,
                  providerInstanceId: modelSelection.instanceId,
                  occurredAt: oldInterruptedAt,
                  payload: {
                    id: run1Id,
                    threadId: sourceThreadId,
                    ordinal: 1,
                    providerInstanceId: modelSelection.instanceId,
                    modelSelection,
                    providerThreadId: ProviderThreadId.make(`pt:${sourceThreadId}`),
                    userMessageId: MessageId.make(`msg-1:${sourceThreadId}`),
                    rootNodeId: null,
                    activeAttemptId: null,
                    status: "interrupted",
                    queuePosition: null,
                    queueHeld: false,
                    requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                    startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                    completedAt: oldInterruptedAt,
                    checkpointId: null,
                    contextHandoffId: null,
                  },
                },
                // Historical secret_request cancelled when run-1 was interrupted earlier
                {
                  id: EventId.make(`hist-secret-run1:${sourceThreadId}`),
                  type: "turn-item.updated",
                  threadId: sourceThreadId,
                  runId: run1Id,
                  occurredAt: oldInterruptedAt,
                  payload: {
                    id: TurnItemId.make(`ti-hist-secret:${sourceThreadId}`),
                    threadId: sourceThreadId,
                    runId: run1Id,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 10,
                    status: "cancelled",
                    title: null,
                    startedAt: DateTime.makeUnsafe("2026-01-01T00:00:02.000Z"),
                    completedAt: oldInterruptedAt,
                    updatedAt: oldInterruptedAt,
                    type: "secret_request",
                    label: TrimmedNonEmptyString.make("OLD_SECRET_KEY"),
                    reason: "Old secret from earlier interrupted turn",
                    secretStatus: "cancelled",
                  },
                },
                // Clean later running turn (run-2)
                {
                  id: EventId.make(`clean-msg-run2:${sourceThreadId}`),
                  type: "message.updated",
                  threadId: sourceThreadId,
                  runId: run2Id,
                  occurredAt: laterStart,
                  payload: {
                    createdBy: "user",
                    creationSource: "web",
                    id: msg2Id,
                    threadId: sourceThreadId,
                    runId: run2Id,
                    nodeId: null,
                    role: "user",
                    text: "Clean follow-up turn",
                    attachments: [],
                    streaming: false,
                    createdAt: laterStart,
                    updatedAt: laterStart,
                  },
                },
                {
                  id: EventId.make(`clean-run2:${sourceThreadId}`),
                  type: "run.created",
                  threadId: sourceThreadId,
                  runId: run2Id,
                  providerInstanceId: modelSelection.instanceId,
                  occurredAt: laterStart,
                  payload: {
                    id: run2Id,
                    threadId: sourceThreadId,
                    ordinal: 2,
                    providerInstanceId: modelSelection.instanceId,
                    modelSelection,
                    providerThreadId: ProviderThreadId.make(`pt:${sourceThreadId}`),
                    userMessageId: msg2Id,
                    rootNodeId: null,
                    activeAttemptId: null,
                    status: "running",
                    queuePosition: null,
                    queueHeld: false,
                    requestedAt: laterStart,
                    startedAt: laterStart,
                    completedAt: null,
                    checkpointId: null,
                    contextHandoffId: null,
                  },
                },
              ],
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            expect(prep.manifest.sourceState.wasRunning).toBe(true);
            expect(prep.manifest.sourceState.hadPendingRuntimeRequest).toBe(false);
            expect(prep.manifest.sourceState.pendingRuntimeRequests).toHaveLength(0);

            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
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
              manifest: prep.manifest,
              autoResume: true,
            });
            expect(committed.resumed).toBe(true);
            expect(recorder.sentMessages).toHaveLength(1);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "collects and rewrites composer context.records[].attachmentId on messages, user_message turn items, and held queued runs",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-ctx-att-"));
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);

        const projectId = ProjectId.make("proj-ctx-att");
        const destProjectId = ProjectId.make("proj-ctx-att-dst");
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
          environmentId: "env-ctx-att",
          environmentLabel: "Context Attachments Env",
          projects: [
            { id: projectId, title: "Src", workspaceRoot: srcRepo },
            { id: destProjectId, title: "Dst", workspaceRoot: dstRepo },
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

            const sourceThreadId = ThreadId.make("thread-ctx-att");
            const transferId = SessionTransferId.make("xfer-ctx-att");

            const inlineImageId = ChatAttachmentId.make(createAttachmentId(sourceThreadId)!);
            const contextOnlyFileId = ChatAttachmentId.make(
              createAttachmentId(sourceThreadId, "txt")!,
            );
            const queuedContextImageId = ChatAttachmentId.make(createAttachmentId(sourceThreadId)!);

            const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
            const txtBytes = new TextEncoder().encode("context-only-file-content");
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${inlineImageId}.png`),
              pngBytes,
            );
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${contextOnlyFileId}.txt`),
              txtBytes,
            );
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${queuedContextImageId}.png`),
              pngBytes,
            );

            const userContext: OrchestrationMessageContext = {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: ComposerContextId.make("ctx-img-1"),
                  label: "diagram.png",
                  kind: "image",
                  attachmentId: inlineImageId,
                  name: TrimmedNonEmptyString.make("diagram.png"),
                  mimeType: TrimmedNonEmptyString.make("image/png"),
                  sizeBytes: pngBytes.byteLength,
                },
                {
                  version: 1,
                  contextId: ComposerContextId.make("ctx-file-only"),
                  label: "spec.txt",
                  kind: "file",
                  attachmentId: contextOnlyFileId,
                  name: TrimmedNonEmptyString.make("spec.txt"),
                  mimeType: TrimmedNonEmptyString.make("text/plain"),
                  sizeBytes: txtBytes.byteLength,
                },
              ],
            };

            const queuedContext: OrchestrationMessageContext = {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: ComposerContextId.make("ctx-q-img"),
                  label: "queued.png",
                  kind: "image",
                  attachmentId: queuedContextImageId,
                  name: TrimmedNonEmptyString.make("queued.png"),
                  mimeType: TrimmedNonEmptyString.make("image/png"),
                  sizeBytes: pngBytes.byteLength,
                },
              ],
            };

            // Inject context onto seeded message, user_message turn item, and held queued run message.
            const seeded = seedThreadEvents({
              projectId,
              threadId: sourceThreadId,
              branch: "main",
              worktreePath: srcRepo,
              modelSelection,
              running: false,
              presentAttachmentId: inlineImageId,
              queuedText: "Queued prompt with inline context image",
            }).map((event) => {
              if (
                event.type === "message.updated" &&
                event.payload.id === MessageId.make(`msg-1:${sourceThreadId}`)
              ) {
                return {
                  ...event,
                  payload: { ...event.payload, context: userContext },
                };
              }
              if (event.type === "turn-item.updated" && event.payload.type === "user_message") {
                return {
                  ...event,
                  payload: { ...event.payload, context: userContext },
                };
              }
              if (
                event.type === "message.updated" &&
                event.payload.id === MessageId.make(`qmsg:${sourceThreadId}`)
              ) {
                return {
                  ...event,
                  payload: { ...event.payload, context: queuedContext },
                };
              }
              return event;
            });

            yield* eventSink.write({ events: seeded });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });

            // All 3 attachments (including context-only file and queued context image) must be collected!
            const exportedIds = new Set(prep.manifest.attachments.map((a) => a.attachmentId));
            expect(exportedIds.has(inlineImageId)).toBe(true);
            expect(exportedIds.has(contextOnlyFileId)).toBe(true);
            expect(exportedIds.has(queuedContextImageId)).toBe(true);
            expect(prep.manifest.heldQueuedRuns[0]?.context?.records).toHaveLength(1);

            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: destProjectId,
            });
            expect(staged.attachmentUploads).toHaveLength(3);

            const attachmentIdMap: Record<string, ChatAttachmentId> = {};
            for (const upload of staged.attachmentUploads) {
              const isTxt = upload.sourceAttachmentId === contextOnlyFileId;
              NodeFS.writeFileSync(
                NodePath.join(
                  config.attachmentsDir,
                  `${upload.destinationAttachmentId}.${isTxt ? "txt" : "png"}`,
                ),
                isTxt ? txtBytes : pngBytes,
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

            // 1. Check imported user message context.records[].attachmentId
            const destUserMsg = destProj.messages.find(
              (m) => m.role === "user" && m.text.includes("lossless transfer bundle"),
            );
            expect(destUserMsg?.context?.records).toHaveLength(2);
            for (const record of destUserMsg?.context?.records ?? []) {
              expect("attachmentId" in record).toBe(true);
              if ("attachmentId" in record) {
                expect(record.attachmentId).not.toBe(inlineImageId);
                expect(record.attachmentId).not.toBe(contextOnlyFileId);
                expect(
                  resolveAttachmentPathById({
                    attachmentsDir: config.attachmentsDir,
                    attachmentId: record.attachmentId,
                  }),
                ).not.toBeNull();
              }
            }

            // 2. Check imported user_message turn item context.records[].attachmentId
            const destUserItem = destProj.turnItems.find((i) => i.type === "user_message");
            expect(destUserItem?.type).toBe("user_message");
            if (destUserItem?.type === "user_message") {
              expect(destUserItem.context?.records).toHaveLength(2);
              for (const record of destUserItem.context?.records ?? []) {
                expect("attachmentId" in record).toBe(true);
                if ("attachmentId" in record) {
                  expect(record.attachmentId).not.toBe(inlineImageId);
                  expect(record.attachmentId).not.toBe(contextOnlyFileId);
                  expect(
                    resolveAttachmentPathById({
                      attachmentsDir: config.attachmentsDir,
                      attachmentId: record.attachmentId,
                    }),
                  ).not.toBeNull();
                }
              }
            }

            // 3. Check persisted held queued run user message context.records[].attachmentId
            const destQueuedRun = destProj.runs.find((r) => r.status === "queued");
            expect(destQueuedRun).toBeDefined();
            const destQueuedMsg = destProj.messages.find(
              (m) => m.id === destQueuedRun?.userMessageId,
            );
            expect(destQueuedMsg?.context?.records).toHaveLength(1);
            const qRec = destQueuedMsg?.context?.records[0];
            expect(qRec?.kind).toBe("image");
            expect(qRec !== undefined && "attachmentId" in qRec).toBe(true);
            if (qRec !== undefined && "attachmentId" in qRec) {
              expect(qRec.attachmentId).not.toBe(queuedContextImageId);
              expect(
                resolveAttachmentPathById({
                  attachmentsDir: config.attachmentsDir,
                  attachmentId: qRec.attachmentId,
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
    "serializes concurrent source abort calls while lock is in cleaning without premature lock release",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-conc-abort-"));
        const repoDir = NodePath.join(tmpRoot, "repo");
        initGitRepo(repoDir);

        const projectId = ProjectId.make("proj-conc-abort");
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

        const cleanupEntered = yield* Deferred.make<void>();
        const allowCleanupFinish = yield* Deferred.make<void>();
        let pauseCleanup = false;
        let cleanupTargetPrefix = "";
        let removeCalls = 0;

        const layer = makeEndpointTestLayer({
          environmentId: "env-conc-abort",
          environmentLabel: "Concurrent Abort Env",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onFileSystemRemove: ({ targetPath, next }) =>
              Effect.gen(function* () {
                if (cleanupTargetPrefix.length > 0 && targetPath.includes(cleanupTargetPrefix)) {
                  removeCalls += 1;
                  if (pauseCleanup) {
                    pauseCleanup = false;
                    yield* Deferred.succeed(cleanupEntered, undefined);
                    yield* Deferred.await(allowCleanupFinish);
                  }
                }
                return yield* next;
              }),
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const threadId = ThreadId.make("thread-conc-abort");
            const transferId = SessionTransferId.make("xfer-conc-abort");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection,
                running: false,
              }),
            });

            // Prepare first so the lock is held in `prepared` and export.bundle exists in staging.
            const firstPrep = yield* svc.prepareSource({
              transferId,
              threadId,
              direction: "local_to_boat",
            });
            expect(firstPrep.manifest.sourceThreadId).toBe(threadId);

            const stagingDir = resolveTransferStagingDir(config.stateDir, transferId, path)!;
            const exportBundlePath = resolveExportBundlePath(config.stateDir, transferId, path)!;
            expect(NodeFS.existsSync(exportBundlePath)).toBe(true);

            cleanupTargetPrefix = NodePath.basename(stagingDir);
            pauseCleanup = true;

            // Start first source abort; pause while it is deleting the staging directory.
            const abortFiber1 = yield* Effect.forkChild(svc.abort({ role: "source", transferId }));
            yield* Deferred.await(cleanupEntered);
            expect(removeCalls).toBe(1);

            // Launch a second concurrent source abort while lock is already in `cleaning`.
            const abortFiber2 = yield* Effect.forkChild(svc.abort({ role: "source", transferId }));
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;

            // Second abort MUST await the first cleanup, NOT overwrite attemptId, run a competing
            // cleanup, or release the lock early.
            expect(abortFiber2.pollUnsafe()).toBeUndefined();
            expect(removeCalls).toBe(1);

            // A retry while first cleanup is still running MUST still be rejected with already_in_flight.
            const retryDuringCleaning = yield* Effect.result(
              svc.prepareSource({
                transferId,
                threadId,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(retryDuringCleaning)).toBe(true);
            if (Result.isFailure(retryDuringCleaning)) {
              expect(retryDuringCleaning.failure.code).toBe("already_in_flight");
            }

            // Release the first cleanup -> both abort calls complete cleanly and staging is removed once.
            yield* Deferred.succeed(allowCleanupFinish, undefined);
            const [res1, res2] = yield* Effect.all([
              Fiber.join(abortFiber1),
              Fiber.join(abortFiber2),
            ]);
            expect(res1.cleanedUp).toBe(true);
            expect(res2.cleanedUp).toBe(true);
            expect(removeCalls).toBe(1);
            expect(NodeFS.existsSync(stagingDir)).toBe(false);

            // Immediate retry now acquires a fresh lock and keeps its new staging bundle intact.
            const retryAfterCleanup = yield* svc.prepareSource({
              transferId,
              threadId,
              direction: "local_to_boat",
            });
            expect(retryAfterCleanup.manifest.sourceThreadId).toBe(threadId);
            expect(NodeFS.existsSync(exportBundlePath)).toBe(true);
            expect(removeCalls).toBe(1);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "blocks auto-resume when a queued run transitions to running and has its secret_request cancelled by thread.stop",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-queued-stop-"));
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);

        const projectId = ProjectId.make("proj-queued-stop");
        const destProjectId = ProjectId.make("proj-queued-stop-dst");
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

        const sourceThreadId = ThreadId.make("thread-queued-stop");
        const historicalRunId = RunId.make(`run-hist:${sourceThreadId}`);
        const initialActiveRunId = RunId.make(`run-1:${sourceThreadId}`);
        const queuedRunId = RunId.make(`run-2:${sourceThreadId}`);
        const queuedMsgId = MessageId.make(`qmsg:${sourceThreadId}`);

        const layer = makeEndpointTestLayer({
          environmentId: "env-queued-stop",
          environmentLabel: "Queued Run Stop Env",
          projects: [
            { id: projectId, title: "Src", workspaceRoot: srcRepo },
            { id: destProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onThreadStop: ({ threadId, eventSink, projectionStore }) =>
              Effect.gen(function* () {
                // Simulate the race between initial snapshot and thread.stop:
                // 1) initialActiveRunId completes cleanly
                // 2) queuedRunId transitions queued -> running, emits a secret_request,
                //    and then thread.stop interrupts queuedRunId and cancels that secret_request.
                const records = yield* projectionStore.getThreadRecords(threadId, [
                  "runs",
                  "attempts",
                ]);
                const activeRun = records.runs.find((r) => r.id === initialActiveRunId)!;
                const queuedRun = records.runs.find((r) => r.id === queuedRunId)!;
                const queuedAttempts = records.attempts.filter((a) => a.runId === queuedRun.id);
                const completedFirstAt = DateTime.makeUnsafe("2026-01-01T00:02:00.000Z");
                const interruptedQueuedAt = DateTime.makeUnsafe("2026-01-01T00:02:05.000Z");

                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make(`complete-run1:${threadId}`),
                      type: "run.updated",
                      threadId,
                      runId: activeRun.id,
                      providerInstanceId: modelSelection.instanceId,
                      occurredAt: completedFirstAt,
                      payload: {
                        ...activeRun,
                        status: "completed",
                        completedAt: completedFirstAt,
                      },
                    },
                    {
                      id: EventId.make(`start-then-stop-queued:${threadId}`),
                      type: "run.updated",
                      threadId,
                      runId: queuedRun.id,
                      providerInstanceId: modelSelection.instanceId,
                      occurredAt: interruptedQueuedAt,
                      payload: {
                        ...queuedRun,
                        status: "interrupted",
                        queuePosition: null,
                        startedAt: completedFirstAt,
                        completedAt: interruptedQueuedAt,
                      },
                    },
                    ...queuedAttempts.map((attempt) => ({
                      id: EventId.make(`interrupt-queued-attempt:${attempt.id}`),
                      type: "run-attempt.updated" as const,
                      threadId,
                      runId: queuedRun.id,
                      runAttemptId: attempt.id,
                      providerInstanceId: modelSelection.instanceId,
                      occurredAt: interruptedQueuedAt,
                      payload: {
                        ...attempt,
                        status: "interrupted" as const,
                        startedAt: completedFirstAt,
                        completedAt: interruptedQueuedAt,
                      },
                    })),
                    {
                      id: EventId.make(`cancel-queued-secret:${threadId}`),
                      type: "turn-item.updated",
                      threadId,
                      runId: queuedRun.id,
                      occurredAt: interruptedQueuedAt,
                      payload: {
                        id: TurnItemId.make(`ti-queued-secret:${threadId}`),
                        threadId,
                        runId: queuedRun.id,
                        nodeId: null,
                        providerThreadId: null,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 20,
                        status: "cancelled",
                        title: null,
                        startedAt: DateTime.makeUnsafe("2026-01-01T00:02:02.000Z"),
                        completedAt: interruptedQueuedAt,
                        updatedAt: interruptedQueuedAt,
                        type: "secret_request",
                        label: TrimmedNonEmptyString.make("DEPLOY_TOKEN"),
                        reason: "Needed by newly-started queued run",
                        secretStatus: "cancelled",
                      },
                    },
                  ],
                });
              }).pipe(Effect.mapError((cause) => new TestHookError({ message: String(cause) }))),
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const transferId = SessionTransferId.make("xfer-queued-stop");
            const oldInterruptedAt = DateTime.makeUnsafe("2026-01-01T00:00:05.000Z");

            const baseEvents = seedThreadEvents({
              projectId,
              threadId: sourceThreadId,
              branch: "main",
              worktreePath: srcRepo,
              modelSelection,
              running: true,
              queuedText: "Follow-up run that starts right before thread.stop",
            });

            yield* eventSink.write({
              events: [
                ...baseEvents,
                // Also include a historical interrupted run with an old cancelled secret_request
                // to prove historical cancelled secrets are still ignored.
                {
                  id: EventId.make(`hist-run:${sourceThreadId}`),
                  type: "run.created",
                  threadId: sourceThreadId,
                  runId: historicalRunId,
                  providerInstanceId: modelSelection.instanceId,
                  occurredAt: oldInterruptedAt,
                  payload: {
                    id: historicalRunId,
                    threadId: sourceThreadId,
                    ordinal: 3,
                    providerInstanceId: modelSelection.instanceId,
                    modelSelection,
                    providerThreadId: ProviderThreadId.make(`pt:${sourceThreadId}`),
                    userMessageId: queuedMsgId,
                    rootNodeId: null,
                    activeAttemptId: null,
                    status: "interrupted",
                    queuePosition: null,
                    queueHeld: false,
                    requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                    startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                    completedAt: oldInterruptedAt,
                    checkpointId: null,
                    contextHandoffId: null,
                  },
                },
                {
                  id: EventId.make(`hist-secret:${sourceThreadId}`),
                  type: "turn-item.updated",
                  threadId: sourceThreadId,
                  runId: historicalRunId,
                  occurredAt: oldInterruptedAt,
                  payload: {
                    id: TurnItemId.make(`ti-old-secret:${sourceThreadId}`),
                    threadId: sourceThreadId,
                    runId: historicalRunId,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 5,
                    status: "cancelled",
                    title: null,
                    startedAt: DateTime.makeUnsafe("2026-01-01T00:00:02.000Z"),
                    completedAt: oldInterruptedAt,
                    updatedAt: oldInterruptedAt,
                    type: "secret_request",
                    label: TrimmedNonEmptyString.make("HISTORICAL_SECRET"),
                    reason: "Old secret from earlier interrupted run",
                    secretStatus: "cancelled",
                  },
                },
              ],
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: sourceThreadId,
              direction: "local_to_boat",
            });
            expect(prep.manifest.sourceState.wasRunning).toBe(true);
            expect(prep.manifest.sourceState.hadPendingRuntimeRequest).toBe(true);
            expect(prep.manifest.sourceState.pendingRuntimeRequests).toHaveLength(1);
            expect(prep.manifest.sourceState.pendingRuntimeRequests[0]?.summary).toContain(
              "DEPLOY_TOKEN",
            );
            expect(prep.manifest.sourceState.pendingRuntimeRequests[0]?.userOnly).toBe(true);

            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
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
              manifest: prep.manifest,
              autoResume: true,
            });
            expect(committed.resumed).toBe(false);
            expect(recorder.sentMessages).toHaveLength(0);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "completes source staging cleanup uninterruptibly on mid-cleanup Fiber.interrupt and propagates unexpected staging removal errors",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-unint-abort-"));
        const repoDir = NodePath.join(tmpRoot, "repo");
        initGitRepo(repoDir);

        const projectId = ProjectId.make("proj-unint-abort");
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

        const cleanupEntered = yield* Deferred.make<void>();
        const allowCleanupFinish = yield* Deferred.make<void>();
        const failEntered = yield* Deferred.make<void>();
        const allowFailFinish = yield* Deferred.make<void>();
        let hookMode: "none" | "pause" | "fail" = "none";
        let cleanupTargetPrefix = "";
        let removeCalls = 0;

        const layer = makeEndpointTestLayer({
          environmentId: "env-unint-abort",
          environmentLabel: "Uninterruptible Abort Env",
          projects: [{ id: projectId, title: "Repo", workspaceRoot: repoDir }],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onFileSystemRemove: ({ targetPath, next }) =>
              Effect.gen(function* () {
                if (cleanupTargetPrefix.length > 0 && targetPath.includes(cleanupTargetPrefix)) {
                  removeCalls += 1;
                  if (hookMode === "pause") {
                    hookMode = "none";
                    yield* Deferred.succeed(cleanupEntered, undefined);
                    yield* Deferred.await(allowCleanupFinish);
                  } else if (hookMode === "fail") {
                    hookMode = "none";
                    yield* Deferred.succeed(failEntered, undefined);
                    yield* Deferred.await(allowFailFinish);
                    return yield* PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: targetPath,
                    });
                  }
                }
                return yield* next;
              }),
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const threadId = ThreadId.make("thread-unint-abort");
            const transferId1 = SessionTransferId.make("xfer-unint-abort-1");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId,
                threadId,
                branch: "main",
                worktreePath: repoDir,
                modelSelection,
                running: false,
              }),
            });

            // Part A: Explicit Fiber.interrupt on the owning abort mid-cleanup must NOT release
            // the lock or resolve cleanupDeferred before staging deletion actually completes.
            yield* svc.prepareSource({
              transferId: transferId1,
              threadId,
              direction: "local_to_boat",
            });
            const stagingDir1 = resolveTransferStagingDir(config.stateDir, transferId1, path)!;
            expect(NodeFS.existsSync(stagingDir1)).toBe(true);

            cleanupTargetPrefix = NodePath.basename(stagingDir1);
            hookMode = "pause";

            const abortFiber1 = yield* Effect.forkChild(
              svc.abort({ role: "source", transferId: transferId1 }),
            );
            yield* Deferred.await(cleanupEntered);
            expect(removeCalls).toBe(1);

            const abortFiber2 = yield* Effect.forkChild(
              svc.abort({ role: "source", transferId: transferId1 }),
            );
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            expect(abortFiber2.pollUnsafe()).toBeUndefined();

            // Interrupt the first abort fiber while staging removal is blocked mid-flight.
            const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(abortFiber1));
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;

            // Cleanup must STILL be running uninterruptibly: lock held, staging intact, waiter blocked.
            expect(abortFiber1.pollUnsafe()).toBeUndefined();
            expect(abortFiber2.pollUnsafe()).toBeUndefined();
            expect(NodeFS.existsSync(stagingDir1)).toBe(true);

            const blockedRetry = yield* Effect.result(
              svc.prepareSource({
                transferId: SessionTransferId.make("xfer-blocked-during-interrupted-cleanup"),
                threadId,
                direction: "local_to_boat",
              }),
            );
            expect(Result.isFailure(blockedRetry)).toBe(true);
            if (Result.isFailure(blockedRetry)) {
              expect(blockedRetry.failure.code).toBe("already_in_flight");
            }

            // Unblock staging removal -> deletion finishes before lock release and before waiter resolves.
            yield* Deferred.succeed(allowCleanupFinish, undefined);
            yield* Fiber.join(interruptFiber);
            const abort2Result = yield* Fiber.join(abortFiber2);
            expect(abort2Result.cleanedUp).toBe(true);
            expect(removeCalls).toBe(1);
            expect(NodeFS.existsSync(stagingDir1)).toBe(false);

            // Part B: Unexpected non-ENOENT staging deletion error fails both owning and waiting
            // aborts instead of falsely returning cleanedUp: true, while still releasing the lock.
            const transferId2 = SessionTransferId.make("xfer-unint-abort-2");
            yield* svc.prepareSource({
              transferId: transferId2,
              threadId,
              direction: "local_to_boat",
            });
            const stagingDir2 = resolveTransferStagingDir(config.stateDir, transferId2, path)!;
            expect(NodeFS.existsSync(stagingDir2)).toBe(true);

            cleanupTargetPrefix = NodePath.basename(stagingDir2);
            hookMode = "fail";

            const failAbort1 = yield* Effect.forkChild(
              Effect.result(svc.abort({ role: "source", transferId: transferId2 })),
            );
            yield* Deferred.await(failEntered);

            const failAbort2 = yield* Effect.forkChild(
              Effect.result(svc.abort({ role: "source", transferId: transferId2 })),
            );
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            expect(failAbort2.pollUnsafe()).toBeUndefined();

            yield* Deferred.succeed(allowFailFinish, undefined);
            const [failRes1, failRes2] = yield* Effect.all([
              Fiber.join(failAbort1),
              Fiber.join(failAbort2),
            ]);
            expect(Result.isFailure(failRes1)).toBe(true);
            expect(Result.isFailure(failRes2)).toBe(true);
            if (Result.isFailure(failRes1)) {
              expect(failRes1.failure.code).toBe("internal");
            }
            if (Result.isFailure(failRes2)) {
              expect(failRes2.failure.code).toBe("internal");
            }
            expect(NodeFS.existsSync(stagingDir2)).toBe(true);

            // Lock was released despite cleanup error, so a subsequent abort succeeds and deletes staging.
            const retryAbort = yield* svc.abort({ role: "source", transferId: transferId2 });
            expect(retryAbort.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(stagingDir2)).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "continues destination worktree, created branch, and pending attachment cleanup when staging removal fails with PermissionDenied",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-dst-abort-eacces-"),
        );
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);
        git(srcRepo, ["checkout", "-b", "feat/dst-abort-eacces"]);
        NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.txt"), "feature change\n");
        git(srcRepo, ["add", "feature.txt"]);
        git(srcRepo, ["commit", "-m", "feature commit"]);

        const srcProjectId = ProjectId.make("proj-dst-abort-src");
        const dstProjectId = ProjectId.make("proj-dst-abort-dst");
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

        let failNextCommitEventWrite = false;
        let failStagingRemove = false;
        let stagingTargetPrefix = "";

        const layer = makeEndpointTestLayer({
          environmentId: "env-dst-abort-eacces",
          environmentLabel: "Destination Abort EACCES Env",
          projects: [
            { id: srcProjectId, title: "Src", workspaceRoot: srcRepo },
            { id: dstProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onEventSinkWrite: (events) => {
              if (failNextCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                failNextCommitEventWrite = false;
                return Effect.fail(new TestHookError({ message: "fail commit after worktree" }));
              }
              return Effect.void;
            },
            onFileSystemRemove: ({ targetPath, next }) =>
              Effect.gen(function* () {
                if (
                  failStagingRemove &&
                  stagingTargetPrefix.length > 0 &&
                  targetPath.includes(stagingTargetPrefix)
                ) {
                  return yield* PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: targetPath,
                  });
                }
                return yield* next;
              }),
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThreadId = ThreadId.make("thread-dst-abort-eacces");
            const transferId = SessionTransferId.make("xfer-dst-abort-eacces");
            const srcAttachmentId = ChatAttachmentId.make(createAttachmentId(srcThreadId)!);
            const attachmentBytes = new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]);
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${srcAttachmentId}.png`),
              attachmentBytes,
            );

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: "feat/dst-abort-eacces",
                worktreePath: srcRepo,
                modelSelection,
                running: false,
                presentAttachmentId: srcAttachmentId,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "local_to_boat",
            });
            const initialStaged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            expect(initialStaged.attachmentUploads).toHaveLength(1);

            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            // Trigger commitImport so it creates the destination worktree + branch (`createdBranch: true`),
            // then fails before committing the thread events.
            failNextCommitEventWrite = true;
            const commitRes = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: initialStaged.destinationProjectId,
                destinationThreadId: initialStaged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitRes)).toBe(true);

            // Re-read staged metadata via idempotent stageImport to obtain the created worktreePath
            // and current pending attachment target, then write the pending attachment file on disk.
            const stagedWithWorktree = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            expect(stagedWithWorktree.attachmentUploads).toHaveLength(1);
            const pendingDestId = stagedWithWorktree.attachmentUploads[0]!.destinationAttachmentId;
            const pendingAttachmentPath = NodePath.join(
              config.attachmentsDir,
              `${pendingDestId}.png`,
            );
            NodeFS.writeFileSync(pendingAttachmentPath, attachmentBytes);
            expect(NodeFS.existsSync(pendingAttachmentPath)).toBe(true);
            expect(stagedWithWorktree.destinationWorktreePath).not.toBeNull();
            expect(stagedWithWorktree.destinationBranch).toBe("feat/dst-abort-eacces");
            const worktreePath = stagedWithWorktree.destinationWorktreePath!;
            expect(NodeFS.existsSync(worktreePath)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", "feat/dst-abort-eacces"]).trim()).not.toBe("");

            const stagingDir = resolveTransferStagingDir(config.stateDir, transferId, path)!;
            expect(NodeFS.existsSync(stagingDir)).toBe(true);

            // Inject EACCES (PermissionDenied) on staging directory removal during destination abort.
            stagingTargetPrefix = NodePath.basename(stagingDir);
            failStagingRemove = true;

            const abortRes = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortRes)).toBe(true);
            if (Result.isFailure(abortRes)) {
              expect(abortRes.failure.code).toBe("internal");
            }

            // Staging dir still exists due to injected EACCES, BUT all independent cleanup steps
            // (worktree removal, created branch deletion, and pending attachment deletion) MUST have run!
            expect(NodeFS.existsSync(stagingDir)).toBe(true);
            expect(NodeFS.existsSync(worktreePath)).toBe(false);
            expect(git(dstRepo, ["branch", "--list", "feat/dst-abort-eacces"]).trim()).toBe("");
            expect(NodeFS.existsSync(pendingAttachmentPath)).toBe(false);

            // Once permissions recover, a subsequent destination abort cleans up staging cleanly.
            failStagingRemove = false;
            const retryAbort = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(retryAbort.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(stagingDir)).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "propagates pending attachment PermissionDenied during destination abort, retains only the failed attachment for retry, and returns cleanedUp: true on recovery",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-dst-abort-att-eacces-"),
        );
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);
        git(srcRepo, ["checkout", "-b", "feat/dst-abort-att-eacces"]);
        NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.txt"), "feature change\n");
        git(srcRepo, ["add", "feature.txt"]);
        git(srcRepo, ["commit", "-m", "feature commit"]);

        const srcProjectId = ProjectId.make("proj-dst-abort-att-src");
        const dstProjectId = ProjectId.make("proj-dst-abort-att-dst");
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

        let failNextCommitEventWrite = false;
        let blockedAttachmentPath = "";
        let failBlockedAttachment = false;
        const retryRemoveCalls: Array<string> = [];
        let recordRemoveCalls = false;

        const layer = makeEndpointTestLayer({
          environmentId: "env-dst-abort-att-eacces",
          environmentLabel: "Destination Abort Attachment EACCES Env",
          projects: [
            { id: srcProjectId, title: "Src", workspaceRoot: srcRepo },
            { id: dstProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onEventSinkWrite: (events) => {
              if (failNextCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                failNextCommitEventWrite = false;
                return Effect.fail(new TestHookError({ message: "fail commit after worktree" }));
              }
              return Effect.void;
            },
            onFileSystemRemove: ({ targetPath, next }) =>
              Effect.gen(function* () {
                if (recordRemoveCalls) {
                  retryRemoveCalls.push(targetPath);
                }
                if (
                  failBlockedAttachment &&
                  blockedAttachmentPath.length > 0 &&
                  targetPath === blockedAttachmentPath
                ) {
                  return yield* PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: targetPath,
                  });
                }
                return yield* next;
              }),
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThreadId = ThreadId.make("thread-dst-abort-att-eacces");
            const transferId = SessionTransferId.make("xfer-dst-abort-att-eacces");
            const srcAttachmentId1 = ChatAttachmentId.make(createAttachmentId(srcThreadId)!);
            const srcAttachmentId2 = ChatAttachmentId.make(createAttachmentId(srcThreadId)!);
            const attachmentBytes = new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]);
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${srcAttachmentId1}.png`),
              attachmentBytes,
            );
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${srcAttachmentId2}.png`),
              attachmentBytes,
            );

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: "feat/dst-abort-att-eacces",
                worktreePath: srcRepo,
                modelSelection,
                running: false,
                presentAttachmentId: srcAttachmentId1,
                assistantOnlyAttachmentId: srcAttachmentId2,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "local_to_boat",
            });
            const initialStaged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            expect(initialStaged.attachmentUploads).toHaveLength(2);

            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            failNextCommitEventWrite = true;
            const commitRes = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: initialStaged.destinationProjectId,
                destinationThreadId: initialStaged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitRes)).toBe(true);

            const stagedWithWorktree = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            expect(stagedWithWorktree.attachmentUploads).toHaveLength(2);
            const pendingDestId1 = stagedWithWorktree.attachmentUploads[0]!.destinationAttachmentId;
            const pendingDestId2 = stagedWithWorktree.attachmentUploads[1]!.destinationAttachmentId;
            const pendingPath1 = NodePath.join(config.attachmentsDir, `${pendingDestId1}.png`);
            const pendingPath2 = NodePath.join(config.attachmentsDir, `${pendingDestId2}.png`);
            NodeFS.writeFileSync(pendingPath1, attachmentBytes);
            NodeFS.writeFileSync(pendingPath2, attachmentBytes);

            const worktreePath = stagedWithWorktree.destinationWorktreePath!;
            const stagingDir = resolveTransferStagingDir(config.stateDir, transferId, path)!;
            expect(NodeFS.existsSync(worktreePath)).toBe(true);
            expect(NodeFS.existsSync(stagingDir)).toBe(true);
            expect(NodeFS.existsSync(pendingPath1)).toBe(true);
            expect(NodeFS.existsSync(pendingPath2)).toBe(true);

            // Inject PermissionDenied on the second pending attachment only.
            blockedAttachmentPath = pendingPath2;
            failBlockedAttachment = true;

            const abortRes = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortRes)).toBe(true);
            if (Result.isFailure(abortRes)) {
              expect(abortRes.failure.code).toBe("internal");
            }

            // Independent cleanup steps (staging dir, worktree, branch, and first pending attachment)
            // all completed, while the blocked second pending attachment remains on disk.
            expect(NodeFS.existsSync(stagingDir)).toBe(false);
            expect(NodeFS.existsSync(worktreePath)).toBe(false);
            expect(git(dstRepo, ["branch", "--list", "feat/dst-abort-att-eacces"]).trim()).toBe("");
            expect(NodeFS.existsSync(pendingPath1)).toBe(false);
            expect(NodeFS.existsSync(pendingPath2)).toBe(true);

            // Once permissions recover, retrying abort deletes the remaining pending attachment
            // (without retrying already-cleaned items) and succeeds with cleanedUp: true.
            failBlockedAttachment = false;
            recordRemoveCalls = true;
            const retryAbort = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(retryAbort.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(pendingPath2)).toBe(false);
            expect(retryRemoveCalls).toContain(pendingPath2);
            expect(retryRemoveCalls).not.toContain(pendingPath1);

            // Staged state is now cleared, so another abort returns cleanedUp: false.
            const finalAbort = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(finalAbort.cleanedUp).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "propagates destination worktree and created-branch removal failures during abort, retains uncleaned items, and recovers cleanly on retry",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-dst-abort-wt-fail-"),
        );
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);
        git(srcRepo, ["checkout", "-b", "feat/dst-abort-wt-fail"]);
        NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.txt"), "feature change\n");
        git(srcRepo, ["add", "feature.txt"]);
        git(srcRepo, ["commit", "-m", "feature commit"]);

        const srcProjectId = ProjectId.make("proj-dst-abort-wt-src");
        const dstProjectId = ProjectId.make("proj-dst-abort-wt-dst");
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

        let failNextCommitEventWrite = false;
        let blockedWorktreePath = "";
        let blockWorktreeRemoval = false;

        const layer = makeEndpointTestLayer({
          environmentId: "env-dst-abort-wt-fail",
          environmentLabel: "Destination Abort Worktree Failure Env",
          projects: [
            { id: srcProjectId, title: "Src", workspaceRoot: srcRepo },
            { id: dstProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onEventSinkWrite: (events) => {
              if (failNextCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                failNextCommitEventWrite = false;
                return Effect.fail(new TestHookError({ message: "fail commit after worktree" }));
              }
              return Effect.void;
            },
            onVcsRun: ({ input: vcsInput, next }) =>
              blockWorktreeRemoval && vcsInput.operation === "WorkspaceBundle.removeWorktree"
                ? Effect.succeed({
                    exitCode: 128 as VcsProcess.VcsProcessOutput["exitCode"],
                    stdout: "",
                    stderr: "error: failed to remove worktree: Permission denied",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  })
                : next,
            onFileSystemRemove: ({ targetPath, next }) =>
              blockWorktreeRemoval &&
              blockedWorktreePath.length > 0 &&
              targetPath === blockedWorktreePath
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: targetPath,
                    }),
                  )
                : next,
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThreadId = ThreadId.make("thread-dst-abort-wt-fail");
            const transferId = SessionTransferId.make("xfer-dst-abort-wt-fail");
            const srcAttachmentId = ChatAttachmentId.make(createAttachmentId(srcThreadId)!);
            const attachmentBytes = new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]);
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${srcAttachmentId}.png`),
              attachmentBytes,
            );

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: "feat/dst-abort-wt-fail",
                worktreePath: srcRepo,
                modelSelection,
                running: false,
                presentAttachmentId: srcAttachmentId,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "local_to_boat",
            });
            const initialStaged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            failNextCommitEventWrite = true;
            const commitRes = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: initialStaged.destinationProjectId,
                destinationThreadId: initialStaged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitRes)).toBe(true);

            const stagedWithWorktree = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            const pendingDestId = stagedWithWorktree.attachmentUploads[0]!.destinationAttachmentId;
            const pendingAttachmentPath = NodePath.join(
              config.attachmentsDir,
              `${pendingDestId}.png`,
            );
            NodeFS.writeFileSync(pendingAttachmentPath, attachmentBytes);

            const worktreePath = stagedWithWorktree.destinationWorktreePath!;
            const stagingDir = resolveTransferStagingDir(config.stateDir, transferId, path)!;
            expect(NodeFS.existsSync(worktreePath)).toBe(true);
            expect(NodeFS.existsSync(stagingDir)).toBe(true);
            expect(NodeFS.existsSync(pendingAttachmentPath)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", "feat/dst-abort-wt-fail"]).trim()).not.toBe(
              "",
            );

            // Attempt 1: block worktree removal -> abort fails, independent attachment cleanup
            // still runs, and stagingDir (with durable worktree-ownership.json) remains intact on
            // disk alongside worktree + created branch so cleanup survives a destination restart.
            blockedWorktreePath = worktreePath;
            blockWorktreeRemoval = true;
            const abort1 = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abort1)).toBe(true);
            if (Result.isFailure(abort1)) {
              expect(abort1.failure.code).toBe("workspace_error");
            }
            const ownershipPath = resolveWorktreeOwnershipPath(config.stateDir, transferId, path)!;
            expect(NodeFS.existsSync(stagingDir)).toBe(true);
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            expect(NodeFS.existsSync(NodePath.join(stagingDir, "worktree-ownership.json"))).toBe(
              false,
            );
            expect(NodeFS.existsSync(pendingAttachmentPath)).toBe(false);
            expect(NodeFS.existsSync(worktreePath)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", "feat/dst-abort-wt-fail"]).trim()).not.toBe(
              "",
            );

            // Attempt 2: unblock worktree removal, but lock the created branch ref so worktree
            // removal succeeds while branch deletion fails -> abort fails and retains createdBranch.
            blockWorktreeRemoval = false;
            const branchLockPath = NodePath.join(
              dstRepo,
              ".git",
              "refs",
              "heads",
              "feat",
              "dst-abort-wt-fail.lock",
            );
            NodeFS.writeFileSync(branchLockPath, "locked\n");
            try {
              const abort2 = yield* Effect.result(
                svc.abort({
                  transferId,
                  role: "destination",
                }),
              );
              expect(Result.isFailure(abort2)).toBe(true);
              if (Result.isFailure(abort2)) {
                expect(abort2.failure.code).toBe("workspace_error");
              }
              expect(NodeFS.existsSync(worktreePath)).toBe(false);
              expect(git(dstRepo, ["branch", "--list", "feat/dst-abort-wt-fail"]).trim()).not.toBe(
                "",
              );
            } finally {
              NodeFS.rmSync(branchLockPath, { force: true });
            }

            // Attempt 3: once branch deletion is unblocked, retry finishes deleting the leftover
            // branch, removes stagingDir & ownership file, clears staged state, and returns cleanedUp: true.
            const abort3 = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(abort3.cleanedUp).toBe(true);
            expect(git(dstRepo, ["branch", "--list", "feat/dst-abort-wt-fail"]).trim()).toBe("");
            expect(NodeFS.existsSync(stagingDir)).toBe(false);

            // Attempt 4: subsequent abort is a clean no-op.
            const abort4 = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(abort4.cleanedUp).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "cleans orphaned pending .txt sidecar on destination abort retry after primary deletion and .txt PermissionDenied",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-dst-abort-sidecar-"),
        );
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);
        git(srcRepo, ["checkout", "-b", "feat/dst-abort-sidecar"]);
        NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.txt"), "feature change\n");
        git(srcRepo, ["add", "feature.txt"]);
        git(srcRepo, ["commit", "-m", "feature commit"]);

        const srcProjectId = ProjectId.make("proj-dst-abort-sidecar-src");
        const dstProjectId = ProjectId.make("proj-dst-abort-sidecar-dst");
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

        let blockedSidecarPath = "";
        let blockSidecar = false;

        const layer = makeEndpointTestLayer({
          environmentId: "env-dst-abort-sidecar",
          environmentLabel: "Destination Abort Sidecar Env",
          projects: [
            { id: srcProjectId, title: "Src", workspaceRoot: srcRepo },
            { id: dstProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onFileSystemRemove: ({ targetPath, next }) =>
              blockSidecar && blockedSidecarPath.length > 0 && targetPath === blockedSidecarPath
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: targetPath,
                    }),
                  )
                : next,
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThreadId = ThreadId.make("thread-dst-abort-sidecar");
            const transferId = SessionTransferId.make("xfer-dst-abort-sidecar");
            const srcAttachmentId = ChatAttachmentId.make(createAttachmentId(srcThreadId)!);
            const attachmentBytes = new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]);
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${srcAttachmentId}.png`),
              attachmentBytes,
            );

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: "feat/dst-abort-sidecar",
                worktreePath: srcRepo,
                modelSelection,
                running: false,
                presentAttachmentId: srcAttachmentId,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "local_to_boat",
            });
            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            expect(staged.attachmentUploads).toHaveLength(1);

            const pendingDestId = staged.attachmentUploads[0]!.destinationAttachmentId;
            const pendingPrimaryPath = NodePath.join(config.attachmentsDir, `${pendingDestId}.png`);
            const pendingSidecarPath = `${pendingPrimaryPath}.txt`;
            const unrelatedPath = NodePath.join(
              config.attachmentsDir,
              "pending-00000000-0000-4000-8000-0000000000f9.png",
            );
            NodeFS.writeFileSync(pendingPrimaryPath, attachmentBytes);
            NodeFS.writeFileSync(pendingSidecarPath, "extracted sidecar text");
            NodeFS.writeFileSync(unrelatedPath, attachmentBytes);

            blockedSidecarPath = pendingSidecarPath;
            blockSidecar = true;

            // Attempt 1: primary file is deleted, .txt sidecar fails with PermissionDenied.
            const abort1 = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abort1)).toBe(true);
            if (Result.isFailure(abort1)) {
              expect(abort1.failure.code).toBe("internal");
            }
            expect(NodeFS.existsSync(pendingPrimaryPath)).toBe(false);
            expect(NodeFS.existsSync(pendingSidecarPath)).toBe(true);
            expect(NodeFS.existsSync(unrelatedPath)).toBe(true);

            // Attempt 2: after permission restore, retry must find and remove the orphaned .txt sidecar.
            blockSidecar = false;
            const abort2 = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(abort2.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(pendingSidecarPath)).toBe(false);
            expect(NodeFS.existsSync(unrelatedPath)).toBe(true);

            const abort3 = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(abort3.cleanedUp).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "fails destination abort when attachmentsDir is chmod 000, retains pending attachment, and cleans up after chmod 700",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32" || process.getuid?.() === 0) {
          return;
        }
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-dst-abort-chmod000-"),
        );
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);
        git(srcRepo, ["checkout", "-b", "feat/dst-abort-chmod000"]);
        NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.txt"), "feature change\n");
        git(srcRepo, ["add", "feature.txt"]);
        git(srcRepo, ["commit", "-m", "feature commit"]);

        const srcProjectId = ProjectId.make("proj-dst-abort-chmod000-src");
        const dstProjectId = ProjectId.make("proj-dst-abort-chmod000-dst");
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
          environmentId: "env-dst-abort-chmod000",
          environmentLabel: "Destination Abort Chmod 000 Env",
          projects: [
            { id: srcProjectId, title: "Src", workspaceRoot: srcRepo },
            { id: dstProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThreadId = ThreadId.make("thread-dst-abort-chmod000");
            const transferId = SessionTransferId.make("xfer-dst-abort-chmod000");
            const srcAttachmentId = ChatAttachmentId.make(createAttachmentId(srcThreadId)!);
            const attachmentBytes = new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]);
            NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(config.attachmentsDir, `${srcAttachmentId}.png`),
              attachmentBytes,
            );

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: "feat/dst-abort-chmod000",
                worktreePath: srcRepo,
                modelSelection,
                running: false,
                presentAttachmentId: srcAttachmentId,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "local_to_boat",
            });
            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            expect(staged.attachmentUploads).toHaveLength(1);

            const pendingDestId = staged.attachmentUploads[0]!.destinationAttachmentId;
            const pendingPath = NodePath.join(config.attachmentsDir, `${pendingDestId}.png`);
            NodeFS.writeFileSync(pendingPath, attachmentBytes);

            try {
              NodeFS.chmodSync(config.attachmentsDir, 0o000);
              const abort1 = yield* Effect.result(
                svc.abort({
                  transferId,
                  role: "destination",
                }),
              );
              expect(Result.isFailure(abort1)).toBe(true);
              if (Result.isFailure(abort1)) {
                expect(abort1.failure.code).toBe("internal");
              }
            } finally {
              NodeFS.chmodSync(config.attachmentsDir, 0o700);
            }

            // Attachment must still be present on disk, and retry after restoring 0700 deletes it.
            expect(NodeFS.existsSync(pendingPath)).toBe(true);
            const abort2 = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(abort2.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(pendingPath)).toBe(false);

            const abort3 = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(abort3.cleanedUp).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "fails destination abort without deleting a locked worktree, retains staged state, and cleans up after git worktree unlock",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-dst-abort-locked-wt-"),
        );
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);
        git(srcRepo, ["checkout", "-b", "feat/dst-abort-locked-wt"]);
        NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.txt"), "feature change\n");
        git(srcRepo, ["add", "feature.txt"]);
        git(srcRepo, ["commit", "-m", "feature commit"]);

        const srcProjectId = ProjectId.make("proj-dst-abort-locked-wt-src");
        const dstProjectId = ProjectId.make("proj-dst-abort-locked-wt-dst");
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

        let failNextCommitEventWrite = false;
        const layer = makeEndpointTestLayer({
          environmentId: "env-dst-abort-locked-wt",
          environmentLabel: "Destination Abort Locked Worktree Env",
          projects: [
            { id: srcProjectId, title: "Src", workspaceRoot: srcRepo },
            { id: dstProjectId, title: "Dst", workspaceRoot: dstRepo },
          ],
          providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
          recorder,
          hooks: {
            onEventSinkWrite: (events) => {
              if (failNextCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                failNextCommitEventWrite = false;
                return Effect.fail(new TestHookError({ message: "fail commit after worktree" }));
              }
              return Effect.void;
            },
          },
        });

        try {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const srcThreadId = ThreadId.make("thread-dst-abort-locked-wt");
            const transferId = SessionTransferId.make("xfer-dst-abort-locked-wt");

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: "feat/dst-abort-locked-wt",
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "local_to_boat",
            });
            const initialStaged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            failNextCommitEventWrite = true;
            const commitRes = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: initialStaged.destinationProjectId,
                destinationThreadId: initialStaged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitRes)).toBe(true);

            const stagedWithWorktree = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            const worktreePath = stagedWithWorktree.destinationWorktreePath!;
            expect(NodeFS.existsSync(worktreePath)).toBe(true);
            const realWorktreePath = NodeFS.realpathSync(worktreePath);

            git(dstRepo, ["worktree", "lock", worktreePath]);
            let unlocked = false;
            try {
              // Attempt 1: locked worktree must fail abort without deleting directory or dropping state.
              const abort1 = yield* Effect.result(
                svc.abort({
                  transferId,
                  role: "destination",
                }),
              );
              expect(Result.isFailure(abort1)).toBe(true);
              if (Result.isFailure(abort1)) {
                expect(abort1.failure.code).toBe("workspace_error");
              }
              expect(NodeFS.existsSync(worktreePath)).toBe(true);
              const lockedPorcelain = git(dstRepo, ["worktree", "list", "--porcelain"]);
              expect(lockedPorcelain).toContain(`worktree ${realWorktreePath}`);
              expect(lockedPorcelain).toContain("locked");
              expect(
                git(dstRepo, ["branch", "--list", "feat/dst-abort-locked-wt"]).trim(),
              ).not.toBe("");

              // Unlock and retry abort: removes worktree, unregisters from git, deletes created branch.
              git(dstRepo, ["worktree", "unlock", worktreePath]);
              unlocked = true;

              const abort2 = yield* svc.abort({
                transferId,
                role: "destination",
              });
              expect(abort2.cleanedUp).toBe(true);
              expect(NodeFS.existsSync(worktreePath)).toBe(false);
              const afterPorcelain = git(dstRepo, ["worktree", "list", "--porcelain"]);
              expect(afterPorcelain).not.toContain(realWorktreePath);
              expect(git(dstRepo, ["branch", "--list", "feat/dst-abort-locked-wt"]).trim()).toBe(
                "",
              );

              const abort3 = yield* svc.abort({
                transferId,
                role: "destination",
              });
              expect(abort3.cleanedUp).toBe(false);
            } finally {
              if (!unlocked) {
                yield* Effect.try({
                  try: () => git(dstRepo, ["worktree", "unlock", worktreePath]),
                  catch: (cause) => new TestHookError({ message: String(cause) }),
                }).pipe(Effect.ignore);
              }
            }
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "cleans up created worktree and branch after destination server restart when commit fails before creating the thread",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-dst-restart-cleanup-"),
        );
        const srcRepo = NodePath.join(tmpRoot, "src");
        const dstRepo = NodePath.join(tmpRoot, "dst");
        const sharedBaseDirRaw = NodePath.join(tmpRoot, "server-base");
        NodeFS.mkdirSync(sharedBaseDirRaw, { recursive: true });
        const sharedBaseDir = NodeFS.realpathSync(sharedBaseDirRaw);

        initGitRepo(srcRepo);
        git(tmpRoot, ["clone", srcRepo, dstRepo]);
        const featureBranch = "feat/dst-restart-cleanup";
        git(srcRepo, ["checkout", "-b", featureBranch]);
        NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.txt"), "restart cleanup feature\n");
        git(srcRepo, ["add", "feature.txt"]);
        git(srcRepo, ["commit", "-m", "feature commit"]);

        const srcProjectId = ProjectId.make("proj-dst-restart-src");
        const dstProjectId = ProjectId.make("proj-dst-restart-dst");
        const srcThreadId = ThreadId.make("thread-dst-restart-src");
        const transferId = SessionTransferId.make("tx-dst-restart-cleanup-1");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };
        const boatEnvId = EnvironmentId.make("env-boat-restart-src");
        const localEnvId = EnvironmentId.make("env-dst-restart");
        const nowIso = IsoDateTime.make("2026-11-28T05:00:00.000Z");

        try {
          let worktreePath = "";
          let stagingDir = "";
          let ownershipPath = "";
          let destinationThreadId: ThreadId | null = null;

          // Instance 1: commits workspace bundle (creating real worktree & branch), fails before
          // persisting the thread, and fails the initial abort worktree removal.
          let failNextCommitEventWrite = false;
          let blockWorktreeRemoval = false;
          let blockedWorktreePath: string | null = null;
          const recorder1: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          const instance1Layer = makeEndpointTestLayer({
            environmentId: localEnvId,
            environmentLabel: "Destination Restart Host",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorder1,
            hooks: {
              onEventSinkWrite: (events) => {
                if (
                  failNextCommitEventWrite &&
                  events.some((event) => event.type === "thread.created")
                ) {
                  failNextCommitEventWrite = false;
                  return Effect.fail(
                    new TestHookError({
                      message: "Simulated crash before creating destination thread",
                    }),
                  );
                }
                return Effect.void;
              },
              onVcsRun: ({ input: vcsInput, next }) =>
                blockWorktreeRemoval && vcsInput.operation === "WorkspaceBundle.removeWorktree"
                  ? Effect.succeed({
                      exitCode: 128 as VcsProcess.VcsProcessOutput["exitCode"],
                      stdout: "",
                      stderr: "fatal: simulated worktree removal failure before restart",
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    })
                  : next,
              onFileSystemRemove: ({ targetPath, next }) =>
                blockWorktreeRemoval &&
                blockedWorktreePath !== null &&
                targetPath === blockedWorktreePath
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "remove",
                        pathOrDescriptor: targetPath,
                      }),
                    )
                  : next,
            },
          });

          const repo1Layer = SessionTransferRepository.layer.pipe(
            Layer.provideMerge(instance1Layer),
          );

          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const eventSink = yield* EventSink.EventSinkV2;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const repo = yield* SessionTransferRepository.SessionTransferRepository;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: featureBranch,
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            destinationThreadId = staged.destinationThreadId;

            const exportBundlePath = resolveExportBundlePath(config.stateDir, transferId, path)!;
            const importBundlePath = resolveImportBundlePath(config.stateDir, transferId, path)!;
            NodeFS.mkdirSync(NodePath.dirname(importBundlePath), { recursive: true });
            NodeFS.copyFileSync(exportBundlePath, importBundlePath);

            // Commit creates the real worktree and git branch, writes durable worktree-ownership.json,
            // then fails eventSink.write before the thread is created.
            failNextCommitEventWrite = true;
            const commitRes = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: staged.destinationProjectId,
                destinationThreadId: staged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitRes)).toBe(true);

            const stagedAfterFailedCommit = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            worktreePath = stagedAfterFailedCommit.destinationWorktreePath!;
            stagingDir = resolveTransferStagingDir(config.stateDir, transferId, path)!;
            ownershipPath = resolveWorktreeOwnershipPath(config.stateDir, transferId, path)!;

            expect(NodeFS.existsSync(worktreePath)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", featureBranch])).not.toBe("");
            expect(NodeFS.existsSync(stagingDir)).toBe(true);
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);

            // Seed the in-flight coordinator record in shared SQLite at committing_target.
            yield* repo.insertIfAbsent({
              transferId,
              direction: "boat_to_local",
              phase: "committing_target",
              phaseDetail: "Committing destination...",
              sourceEnvironmentId: boatEnvId,
              sourceEnvironmentName: TrimmedNonEmptyString.make("dev-boat"),
              sourceMachineId: TrimmedNonEmptyString.make("machine-1"),
              sourceProjectId: srcProjectId,
              sourceThreadId: srcThreadId,
              destinationEnvironmentId: localEnvId,
              destinationEnvironmentName: TrimmedNonEmptyString.make("Destination Restart Host"),
              destinationMachineId: null,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              destinationBranch: GitRefName.make(featureBranch),
              destinationWorktreePath: TrimmedNonEmptyString.make(worktreePath),
              sourceWasRunning: false,
              hadPendingRuntimeRequest: false,
              modelSelectionOverride: null,
              cloneDestinationPath: null,
              autoResume: false,
              warnings: [],
              errorMessage: null,
              createdAt: nowIso,
              updatedAt: nowIso,
              completedAt: null,
            });

            // First abort fails to remove the worktree -> ownership file and stagingDir must stay.
            blockedWorktreePath = worktreePath;
            blockWorktreeRemoval = true;
            const abort1 = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abort1)).toBe(true);
            if (Result.isFailure(abort1)) {
              expect(abort1.failure.code).toBe("workspace_error");
            }
            expect(NodeFS.existsSync(worktreePath)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", featureBranch])).not.toBe("");
            expect(NodeFS.existsSync(stagingDir)).toBe(true);
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
          }).pipe(Effect.provide(repo1Layer));

          // Simulate a full destination server restart: build a brand-new SessionTransferEndpointService
          // (fresh empty stagedImports in-memory map) + SessionTransferCoordinator sharing the same
          // on-disk stateDir and SQLite DB.
          const recorder2: MockRecorder = {
            dispatches: [],
            forceStops: [],
            detachedSessions: [],
            sentMessages: [],
          };
          const instance2Layer = makeEndpointTestLayer({
            environmentId: localEnvId,
            environmentLabel: "Destination Restart Host",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: recorder2,
          });

          const remoteSourceAbortCalls: Array<string> = [];
          const coordinator2SupportLayer = Layer.mergeAll(
            SessionTransferRepository.layer.pipe(Layer.provideMerge(instance2Layer)),
            Layer.succeed(
              BoatSupervisor.BoatSupervisor,
              BoatSupervisor.BoatSupervisor.of({
                invoke: () => Effect.succeed({ data: { ok: true } }),
                getMachineProxyAccess: () =>
                  Effect.succeed({
                    machineId: "machine-1",
                    machineName: "dev-boat",
                    environmentId: boatEnvId,
                    state: "idle",
                    localUrl: "http://127.0.0.1:41999",
                    bearerToken: "internal-boat-token",
                  }),
                hasConfiguredBoats: Effect.succeed(true),
                currentState: Effect.succeedNone,
                passiveEvents: Stream.empty,
                events: Stream.empty,
                notices: Stream.empty,
              }),
            ),
            Layer.succeed(
              SessionTransferCoordinator.BoatRemoteClient,
              SessionTransferCoordinator.BoatRemoteClient.of({
                getServerConfig: () => Effect.die("unused"),
                getShellSnapshot: () => Effect.die("unused"),
                getThreadSummary: () => Effect.die("unused"),
                prepareSource: () => Effect.die("unused"),
                stageImport: () => Effect.die("unused"),
                commitImport: () => Effect.die("unused"),
                finalizeSource: () => Effect.die("unused"),
                abort: (_endpoint, input) =>
                  Effect.sync(() => {
                    remoteSourceAbortCalls.push(`${input.transferId}:${input.role}`);
                    return { cleanedUp: true };
                  }),
                streamHttpTransfer: () => Effect.die("unused"),
              }),
            ),
            Layer.succeed(ProviderRegistry.ProviderRegistry, {
              getProviders: Effect.succeed([]),
            } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
            Layer.succeed(
              RepositoryIdentityResolver.RepositoryIdentityResolver,
              RepositoryIdentityResolver.RepositoryIdentityResolver.of({
                resolve: () => Effect.succeed(null),
              }),
            ),
          );

          const coordinator2Layer = SessionTransferCoordinator.layer.pipe(
            Layer.provideMerge(coordinator2SupportLayer),
          );

          yield* Effect.gen(function* () {
            const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
            const repo = yield* SessionTransferRepository.SessionTransferRepository;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

            // Confirm destination thread was never committed before reconciliation.
            const threadCheck = yield* Effect.result(
              projectionStore.getThreadProjection(destinationThreadId!),
            );
            expect(Result.isFailure(threadCheck)).toBe(true);

            // Reconcile on startup against the fresh endpoint service instance!
            yield* coordinator.reconcileOnStartup;

            // Worktree directory, created branch, ownership file, and staging dir must all be gone.
            expect(NodeFS.existsSync(worktreePath)).toBe(false);
            expect(git(dstRepo, ["branch", "--list", featureBranch])).toBe("");
            expect(NodeFS.existsSync(ownershipPath)).toBe(false);
            expect(NodeFS.existsSync(stagingDir)).toBe(false);

            // Source was aborted and the SQLite transfer record transitioned cleanly to failed.
            expect(remoteSourceAbortCalls).toEqual([`${transferId}:source`]);
            const reconciled = yield* repo.getById(transferId);
            expect(Option.isSome(reconciled) && reconciled.value.phase).toBe("failed");
            const activeAfterReconcile = yield* repo.listActive();
            expect(activeAfterReconcile.map((r) => r.transferId)).not.toContain(transferId);

            // Subsequent abort on the restarted instance is an idempotent no-op.
            const repeatAbort = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(repeatAbort.cleanedUp).toBe(false);
          }).pipe(Effect.scoped, Effect.provide(coordinator2Layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "retry of commitImport never commits a partially imported worktree and restores dirty files on same and restarted instances",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-partial-wt-retry-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          const sharedBaseDir = NodePath.join(tmpRoot, "state-base");
          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, dstRepo);

          const branchA = "feat/partial-wt-same-instance";
          const branchB = "feat/partial-wt-restarted-instance";
          const dirtyFileName = "dirty-untracked.txt";
          const dirtyFileContent = "important uncommitted dirty work\n";

          git(srcRepo, ["checkout", "-b", branchA]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "committed.ts"), "export const x = 1;\n");
          git(srcRepo, ["add", "committed.ts"]);
          git(srcRepo, ["commit", "-m", "feature commit"]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, dirtyFileName), dirtyFileContent);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "app.ts"), "export const v = 999;\n");

          const srcProjectId = ProjectId.make("proj-partial-src");
          const dstProjectId = ProjectId.make("proj-partial-dst");
          const srcThreadId = ThreadId.make("thread-partial-src");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          };

          let failDirtyApply = false;
          let blockCleanup = false;
          let blockedWorktreePath: string | null = null;

          const makeInstanceLayer = () => {
            const recorder: MockRecorder = {
              dispatches: [],
              forceStops: [],
              detachedSessions: [],
              sentMessages: [],
            };
            return makeEndpointTestLayer({
              environmentId: "env-partial-wt-retry",
              environmentLabel: "Partial Retry Host",
              sharedBaseDir,
              projects: [
                { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
                { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
              ],
              providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
              recorder,
              hooks: {
                onVcsRun: ({ input, next }) => {
                  if (input.operation === "WorkspaceBundle.addWorktree") {
                    const sepIdx = input.args.indexOf("--");
                    if (sepIdx !== -1 && input.args[sepIdx + 1] !== undefined) {
                      blockedWorktreePath = input.args[sepIdx + 1]!;
                    }
                  }
                  if (failDirtyApply && input.operation === "WorkspaceBundle.applyWorktreeLayer") {
                    return Effect.succeed({
                      exitCode: 128 as VcsProcess.VcsProcessOutput["exitCode"],
                      stdout: "",
                      stderr: "Simulated interruption before restoring dirty files",
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    });
                  }
                  if (
                    failDirtyApply &&
                    input.operation === "WorkspaceBundle.applyWorktreeLayerForce"
                  ) {
                    return Effect.fail(
                      new VcsProcessExitError({
                        operation: input.operation,
                        command: input.command,
                        cwd: input.cwd,
                        exitCode: 128,
                        detail: "Simulated interruption before restoring dirty files",
                      }),
                    );
                  }
                  if (blockCleanup && input.operation === "WorkspaceBundle.removeWorktree") {
                    return Effect.succeed({
                      exitCode: 128 as VcsProcess.VcsProcessOutput["exitCode"],
                      stdout: "",
                      stderr: "Simulated transient worktree cleanup lock",
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    });
                  }
                  return next;
                },
                onFileSystemRemove: ({ targetPath, next }) => {
                  if (
                    blockCleanup &&
                    blockedWorktreePath !== null &&
                    (targetPath === blockedWorktreePath ||
                      targetPath.startsWith(`${blockedWorktreePath}${NodePath.sep}`))
                  ) {
                    return Effect.fail(
                      PlatformError.systemError({
                        _tag: "Busy",
                        module: "FileSystem",
                        method: "remove",
                        pathOrDescriptor: targetPath,
                        description: "Simulated busy worktree directory during partial cleanup",
                      }),
                    );
                  }
                  return next;
                },
              },
            });
          };

          // Part A: Same-instance retry after partial import + failed first cleanup.
          const layer1 = makeInstanceLayer();
          const transferIdA = SessionTransferId.make("xfer-partial-wt-same");
          const transferIdB = SessionTransferId.make("xfer-partial-wt-restart");
          let stagedBManifest: {
            readonly destinationProjectId: ProjectId;
            readonly destinationThreadId: ThreadId;
            readonly manifest: Parameters<
              SessionTransferEndpointService.SessionTransferEndpointServiceShape["commitImport"]
            >[0]["manifest"];
          } | null = null;
          let partialWorktreeB = "";
          let ownershipPathB = "";

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: branchA,
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prepA = yield* svc.prepareSource({
              transferId: transferIdA,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const stagedA = yield* svc.stageImport({
              transferId: transferIdA,
              manifest: prepA.manifest,
              targetProjectId: dstProjectId,
            });
            const exportBundleA = resolveExportBundlePath(config.stateDir, transferIdA, path)!;
            const importBundleA = resolveImportBundlePath(config.stateDir, transferIdA, path)!;
            NodeFS.mkdirSync(NodePath.dirname(importBundleA), { recursive: true });
            NodeFS.copyFileSync(exportBundleA, importBundleA);

            const ownershipPathA = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferIdA,
              path,
            )!;

            // Fail dirty-layer restore AND block cleanup so partial worktree stays on disk with importCompleted: false.
            failDirtyApply = true;
            blockCleanup = true;
            blockedWorktreePath = null;
            const attempt1 = yield* Effect.result(
              svc.commitImport({
                transferId: transferIdA,
                destinationProjectId: stagedA.destinationProjectId,
                destinationThreadId: stagedA.destinationThreadId,
                manifest: prepA.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(attempt1)).toBe(true);
            expect(NodeFS.existsSync(ownershipPathA)).toBe(true);
            const ownershipA = JSON.parse(NodeFS.readFileSync(ownershipPathA, "utf8")) as {
              readonly worktreePath: string;
              readonly importCompleted: boolean;
            };
            expect(ownershipA.importCompleted).toBe(false);
            blockedWorktreePath = ownershipA.worktreePath;
            // Ensure partial worktree exists on disk WITHOUT the dirty file.
            expect(NodeFS.existsSync(ownershipA.worktreePath)).toBe(true);
            expect(NodeFS.existsSync(NodePath.join(ownershipA.worktreePath, dirtyFileName))).toBe(
              false,
            );

            // Retry while cleanup is STILL blocked -> must fail with workspace_error (never commit partial worktree).
            failDirtyApply = false;
            const attempt2 = yield* Effect.result(
              svc.commitImport({
                transferId: transferIdA,
                destinationProjectId: stagedA.destinationProjectId,
                destinationThreadId: stagedA.destinationThreadId,
                manifest: prepA.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(attempt2)).toBe(true);
            if (Result.isFailure(attempt2)) {
              expect(attempt2.failure.code).toBe("workspace_error");
            }

            // Unblock cleanup and retry on the SAME service instance -> cleans up partial worktree,
            // runs a fresh full import, and commits with the dirty file intact!
            blockCleanup = false;
            const committedA = yield* svc.commitImport({
              transferId: transferIdA,
              destinationProjectId: stagedA.destinationProjectId,
              destinationThreadId: stagedA.destinationThreadId,
              manifest: prepA.manifest,
              autoResume: false,
            });
            expect(committedA.destinationWorktreePath).not.toBeNull();
            expect(
              NodeFS.readFileSync(
                NodePath.join(committedA.destinationWorktreePath!, dirtyFileName),
                "utf8",
              ),
            ).toBe(dirtyFileContent);
            expect(
              NodeFS.readFileSync(
                NodePath.join(committedA.destinationWorktreePath!, "app.ts"),
                "utf8",
              ),
            ).toBe("export const v = 999;\n");
            expect(NodeFS.existsSync(ownershipPathA)).toBe(false);

            // Release source lock from transferIdA before preparing transferIdB from the same source thread.
            yield* svc.abort({ transferId: transferIdA, role: "source" });

            // Part B setup: prepare second transfer, fail dirty-layer restore + block cleanup on instance 1.
            git(srcRepo, ["checkout", "-b", branchB]);
            const prepB = yield* svc.prepareSource({
              transferId: transferIdB,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const stagedB = yield* svc.stageImport({
              transferId: transferIdB,
              manifest: prepB.manifest,
              targetProjectId: dstProjectId,
            });
            const exportBundleB = resolveExportBundlePath(config.stateDir, transferIdB, path)!;
            const importBundleB = resolveImportBundlePath(config.stateDir, transferIdB, path)!;
            NodeFS.mkdirSync(NodePath.dirname(importBundleB), { recursive: true });
            NodeFS.copyFileSync(exportBundleB, importBundleB);
            ownershipPathB = resolveWorktreeOwnershipPath(config.stateDir, transferIdB, path)!;

            failDirtyApply = true;
            blockCleanup = true;
            blockedWorktreePath = null;
            const attemptB1 = yield* Effect.result(
              svc.commitImport({
                transferId: transferIdB,
                destinationProjectId: stagedB.destinationProjectId,
                destinationThreadId: stagedB.destinationThreadId,
                manifest: prepB.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(attemptB1)).toBe(true);
            const ownershipB = JSON.parse(NodeFS.readFileSync(ownershipPathB, "utf8")) as {
              readonly worktreePath: string;
              readonly importCompleted: boolean;
            };
            expect(ownershipB.importCompleted).toBe(false);
            partialWorktreeB = ownershipB.worktreePath;
            expect(NodeFS.existsSync(partialWorktreeB)).toBe(true);
            expect(NodeFS.existsSync(NodePath.join(partialWorktreeB, dirtyFileName))).toBe(false);

            stagedBManifest = {
              destinationProjectId: stagedB.destinationProjectId,
              destinationThreadId: stagedB.destinationThreadId,
              manifest: prepB.manifest,
            };
          }).pipe(Effect.provide(layer1));

          // Part B: Retry commitImport across a FRESH restarted service instance!
          failDirtyApply = false;
          blockCleanup = false;
          blockedWorktreePath = null;
          const layer2 = makeInstanceLayer();
          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const committedB = yield* svc.commitImport({
              transferId: transferIdB,
              destinationProjectId: stagedBManifest!.destinationProjectId,
              destinationThreadId: stagedBManifest!.destinationThreadId,
              manifest: stagedBManifest!.manifest,
              autoResume: false,
            });
            expect(committedB.destinationWorktreePath).not.toBeNull();
            expect(
              NodeFS.readFileSync(
                NodePath.join(committedB.destinationWorktreePath!, dirtyFileName),
                "utf8",
              ),
            ).toBe(dirtyFileContent);
            expect(
              NodeFS.readFileSync(
                NodePath.join(committedB.destinationWorktreePath!, "app.ts"),
                "utf8",
              ),
            ).toBe("export const v = 999;\n");
            expect(NodeFS.existsSync(ownershipPathB)).toBe(false);
          }).pipe(Effect.provide(layer2));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "late destination abort fails and preserves committed worktree, branch, and ownership on projection read error",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-abort-proj-err-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          const sharedBaseDir = NodePath.join(tmpRoot, "state-base");
          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, dstRepo);

          const featureBranch = "feat/abort-proj-read-error";
          git(srcRepo, ["checkout", "-b", featureBranch]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "kept.ts"), "export const kept = true;\n");
          git(srcRepo, ["add", "kept.ts"]);
          git(srcRepo, ["commit", "-m", "committed feature"]);

          const srcProjectId = ProjectId.make("proj-projerr-src");
          const dstProjectId = ProjectId.make("proj-projerr-dst");
          const srcThreadId = ThreadId.make("thread-projerr-src");
          const transferId = SessionTransferId.make("xfer-abort-proj-err");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          };

          let committedWorktreePath = "";
          let committedBranch = "";
          let ownershipPath = "";
          let destinationThreadId: ThreadId | null = null;

          // Instance 1: commit the thread completely, then simulate a surviving ownership file
          // (as if the host crashed right after SQLite commit before best-effort ownership cleanup).
          const layer1 = makeEndpointTestLayer({
            environmentId: "env-projerr-1",
            environmentLabel: "ProjErr Host",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: featureBranch,
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            const exportBundle = resolveExportBundlePath(config.stateDir, transferId, path)!;
            const importBundle = resolveImportBundlePath(config.stateDir, transferId, path)!;
            NodeFS.mkdirSync(NodePath.dirname(importBundle), { recursive: true });
            NodeFS.copyFileSync(exportBundle, importBundle);

            const committed = yield* svc.commitImport({
              transferId,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              manifest: prep.manifest,
              autoResume: false,
            });
            committedWorktreePath = committed.destinationWorktreePath!;
            committedBranch = committed.destinationBranch!;
            destinationThreadId = committed.destinationThreadId;
            ownershipPath = resolveWorktreeOwnershipPath(config.stateDir, transferId, path)!;

            // Simulate surviving durable ownership file left behind after commit.
            NodeFS.mkdirSync(NodePath.dirname(ownershipPath), { recursive: true });
            NodeFS.writeFileSync(
              ownershipPath,
              JSON.stringify({
                schemaVersion: 1,
                transferId,
                destinationProjectId: dstProjectId,
                projectWorkspaceRoot: dstRepo,
                destinationThreadId,
                worktreePath: committedWorktreePath,
                branch: committedBranch,
                createdBranch: true,
                importCompleted: true,
              }),
            );
          }).pipe(Effect.provide(layer1));

          // Instance 2 (fresh restart, empty stagedImports): inject transient SQLite projection
          // read failure during late abort -> abort MUST fail and preserve worktree, branch, and ownership.
          let failProjectionRead = true;
          const layer2 = makeEndpointTestLayer({
            environmentId: "env-projerr-2",
            environmentLabel: "ProjErr Host",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onGetThreadRecords: ({ threadId, next }) => {
                if (failProjectionRead && threadId === destinationThreadId) {
                  return Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: new Error("SQLITE_BUSY: simulated transient projection read error"),
                    }),
                  );
                }
                return next;
              },
            },
          });

          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;

            const failedAbort = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(failedAbort)).toBe(true);
            if (Result.isFailure(failedAbort)) {
              expect(failedAbort.failure.code).toBe("internal");
            }

            // Worktree, branch, and ownership file must ALL remain completely intact!
            expect(NodeFS.existsSync(committedWorktreePath)).toBe(true);
            expect(NodeFS.existsSync(NodePath.join(committedWorktreePath, "kept.ts"))).toBe(true);
            expect(git(dstRepo, ["branch", "--list", committedBranch])).not.toBe("");
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);

            // Once projection reads recover, abort observes the committed thread, returns
            // cleanedUp: false, deletes the stale ownership file, and keeps worktree + branch intact.
            failProjectionRead = false;
            const recoveredAbort = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(recoveredAbort.cleanedUp).toBe(false);
            expect(NodeFS.existsSync(committedWorktreePath)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", committedBranch])).not.toBe("");
            expect(NodeFS.existsSync(ownershipPath)).toBe(false);
          }).pipe(Effect.provide(layer2));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "serializes concurrent commitImport calls into the same repo so each gets a distinct worktree/branch and aborting one preserves the other",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-concurrent-repo-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, dstRepo);

          const sharedBranch = "feat/concurrent-shared";
          git(srcRepo, ["checkout", "-b", sharedBranch]);
          NodeFS.writeFileSync(
            NodePath.join(srcRepo, "concurrent.ts"),
            "export const winner = true;\n",
          );
          git(srcRepo, ["add", "concurrent.ts"]);
          git(srcRepo, ["commit", "-m", "shared feature commit"]);

          const srcProjectId = ProjectId.make("proj-conc-src");
          const dstProjectId = ProjectId.make("proj-conc-dst");
          const srcThread1 = ThreadId.make("thread-conc-src-1");
          const srcThread2 = ThreadId.make("thread-conc-src-2");
          const transfer1 = SessionTransferId.make("xfer-conc-1");
          const transfer2 = SessionTransferId.make("xfer-conc-2");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          };

          let destThread2Id: ThreadId | null = null;
          const layer = makeEndpointTestLayer({
            environmentId: "env-conc-repo",
            environmentLabel: "Concurrent Repo Host",
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onEventSinkWrite: (events) => {
                if (
                  destThread2Id !== null &&
                  events.some((event) => event.threadId === destThread2Id)
                ) {
                  return Effect.fail(
                    new TestHookError({
                      message: "Simulated commit failure for concurrent transfer 2",
                    }),
                  );
                }
                return Effect.void;
              },
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: [
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThread1,
                  branch: sharedBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThread2,
                  branch: sharedBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
              ],
            });

            const [prep1, prep2] = yield* Effect.all([
              svc.prepareSource({
                transferId: transfer1,
                threadId: srcThread1,
                direction: "boat_to_local",
              }),
              svc.prepareSource({
                transferId: transfer2,
                threadId: srcThread2,
                direction: "boat_to_local",
              }),
            ]);

            const [staged1, staged2] = yield* Effect.all([
              svc.stageImport({
                transferId: transfer1,
                manifest: prep1.manifest,
                targetProjectId: dstProjectId,
              }),
              svc.stageImport({
                transferId: transfer2,
                manifest: prep2.manifest,
                targetProjectId: dstProjectId,
              }),
            ]);
            destThread2Id = staged2.destinationThreadId;

            for (const txId of [transfer1, transfer2]) {
              const exportBundle = resolveExportBundlePath(config.stateDir, txId, path)!;
              const importBundle = resolveImportBundlePath(config.stateDir, txId, path)!;
              NodeFS.mkdirSync(NodePath.dirname(importBundle), { recursive: true });
              NodeFS.copyFileSync(exportBundle, importBundle);
            }

            // Run both commitImport calls concurrently against the SAME destination git repo
            // and SAME source branch name.
            const [res1, res2] = yield* Effect.all(
              [
                Effect.result(
                  svc.commitImport({
                    transferId: transfer1,
                    destinationProjectId: staged1.destinationProjectId,
                    destinationThreadId: staged1.destinationThreadId,
                    manifest: prep1.manifest,
                    autoResume: false,
                  }),
                ),
                Effect.result(
                  svc.commitImport({
                    transferId: transfer2,
                    destinationProjectId: staged2.destinationProjectId,
                    destinationThreadId: staged2.destinationThreadId,
                    manifest: prep2.manifest,
                    autoResume: false,
                  }),
                ),
              ],
              { concurrency: "unbounded" },
            );

            expect(Result.isSuccess(res1)).toBe(true);
            expect(Result.isFailure(res2)).toBe(true);
            if (!Result.isSuccess(res1)) {
              throw new Error("Expected transfer 1 to commit");
            }

            const winnerWorktree = res1.success.destinationWorktreePath!;
            const winnerBranch = res1.success.destinationBranch!;

            const ownership2Path = resolveWorktreeOwnershipPath(config.stateDir, transfer2, path)!;
            expect(NodeFS.existsSync(ownership2Path)).toBe(true);
            const ownership2 = JSON.parse(NodeFS.readFileSync(ownership2Path, "utf8")) as {
              readonly worktreePath: string;
              readonly branch: string;
              readonly createdBranch: boolean;
            };
            const loserWorktree = ownership2.worktreePath;
            const loserBranch = ownership2.branch;

            // Both transfers must have allocated distinct worktrees and distinct branches!
            expect(loserWorktree).not.toBe(winnerWorktree);
            expect(loserBranch).not.toBe(winnerBranch);
            expect(ownership2.createdBranch).toBe(true);
            expect(NodeFS.existsSync(winnerWorktree)).toBe(true);
            expect(NodeFS.existsSync(loserWorktree)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", winnerBranch])).not.toBe("");
            expect(git(dstRepo, ["branch", "--list", loserBranch])).not.toBe("");

            // Aborting the failed transfer deletes ONLY its own worktree and branch, leaving the
            // winner's worktree and branch completely intact.
            const abort2 = yield* svc.abort({
              transferId: transfer2,
              role: "destination",
            });
            expect(abort2.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(loserWorktree)).toBe(false);
            expect(git(dstRepo, ["branch", "--list", loserBranch])).toBe("");
            expect(NodeFS.existsSync(ownership2Path)).toBe(false);

            expect(NodeFS.existsSync(winnerWorktree)).toBe(true);
            expect(NodeFS.existsSync(NodePath.join(winnerWorktree, "concurrent.ts"))).toBe(true);
            expect(git(dstRepo, ["branch", "--list", winnerBranch])).not.toBe("");
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "1-hour staging TTL sweep reclaims expired staging dir while preserving worktree ownership ledger for post-restart cleanup",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-ttl-sweep-ownership-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          const sharedBaseDir = NodePath.join(tmpRoot, "state-base");
          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, dstRepo);

          const featureBranch = "feat/ttl-sweep-survivor";
          git(srcRepo, ["checkout", "-b", featureBranch]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "swept.ts"), "export const s = 1;\n");
          git(srcRepo, ["add", "swept.ts"]);
          git(srcRepo, ["commit", "-m", "feature commit"]);

          const localEnvId = EnvironmentId.make("env-ttl-sweep-local");
          const boatEnvId = EnvironmentId.make("env-ttl-sweep-boat");
          const srcProjectId = ProjectId.make("proj-ttl-src");
          const dstProjectId = ProjectId.make("proj-ttl-dst");
          const srcThreadId = ThreadId.make("thread-ttl-src");
          const transferId = SessionTransferId.make("xfer-ttl-sweep-ownership");
          const nowIso = IsoDateTime.make("2026-11-28T08:00:00.000Z");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          };

          let failNextCommitEventWrite = false;
          let blockWorktreeRemoval = false;
          let blockedWorktreePath: string | null = null;
          let worktreePath = "";
          let stagingDir = "";
          let ownershipPath = "";

          const instance1Layer = makeEndpointTestLayer({
            environmentId: localEnvId,
            environmentLabel: "TTL Sweep Host",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onEventSinkWrite: () => {
                if (failNextCommitEventWrite) {
                  failNextCommitEventWrite = false;
                  return Effect.fail(
                    new TestHookError({
                      message: "Simulated SQLite failure after worktree creation",
                    }),
                  );
                }
                return Effect.void;
              },
              onVcsRun: ({ input, next }) => {
                if (blockWorktreeRemoval && input.operation === "WorkspaceBundle.removeWorktree") {
                  return Effect.succeed({
                    exitCode: 128 as VcsProcess.VcsProcessOutput["exitCode"],
                    stdout: "",
                    stderr: "Simulated transient git worktree remove failure",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  });
                }
                return next;
              },
              onFileSystemRemove: ({ targetPath, next }) => {
                if (
                  blockWorktreeRemoval &&
                  blockedWorktreePath !== null &&
                  (targetPath === blockedWorktreePath ||
                    targetPath.startsWith(`${blockedWorktreePath}${NodePath.sep}`))
                ) {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "Busy",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: targetPath,
                      description: "Simulated busy worktree directory",
                    }),
                  );
                }
                return next;
              },
            },
          });

          const repo1Layer = SessionTransferRepository.layer.pipe(
            Layer.provideMerge(instance1Layer),
          );

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const repo = yield* SessionTransferRepository.SessionTransferRepository;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: featureBranch,
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const staged = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            const exportBundle = resolveExportBundlePath(config.stateDir, transferId, path)!;
            const importBundle = resolveImportBundlePath(config.stateDir, transferId, path)!;
            NodeFS.mkdirSync(NodePath.dirname(importBundle), { recursive: true });
            NodeFS.copyFileSync(exportBundle, importBundle);

            failNextCommitEventWrite = true;
            const commitRes = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: staged.destinationProjectId,
                destinationThreadId: staged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitRes)).toBe(true);

            stagingDir = resolveTransferStagingDir(config.stateDir, transferId, path)!;
            ownershipPath = resolveWorktreeOwnershipPath(config.stateDir, transferId, path)!;
            const ownership = JSON.parse(NodeFS.readFileSync(ownershipPath, "utf8")) as {
              readonly worktreePath: string;
            };
            worktreePath = ownership.worktreePath;

            yield* repo.insertIfAbsent({
              transferId,
              direction: "boat_to_local",
              phase: "committing_target",
              phaseDetail: "Committing destination...",
              sourceEnvironmentId: boatEnvId,
              sourceEnvironmentName: TrimmedNonEmptyString.make("dev-boat"),
              sourceMachineId: TrimmedNonEmptyString.make("machine-1"),
              sourceProjectId: srcProjectId,
              sourceThreadId: srcThreadId,
              destinationEnvironmentId: localEnvId,
              destinationEnvironmentName: TrimmedNonEmptyString.make("TTL Sweep Host"),
              destinationMachineId: null,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              destinationBranch: GitRefName.make(featureBranch),
              destinationWorktreePath: TrimmedNonEmptyString.make(worktreePath),
              sourceWasRunning: false,
              hadPendingRuntimeRequest: false,
              modelSelectionOverride: null,
              cloneDestinationPath: null,
              autoResume: false,
              warnings: [],
              errorMessage: null,
              createdAt: nowIso,
              updatedAt: nowIso,
              completedAt: null,
            });

            // First abort fails worktree removal.
            blockedWorktreePath = worktreePath;
            blockWorktreeRemoval = true;
            const abort1 = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abort1)).toBe(true);

            // Age BOTH the staging directory contents AND the ownership file well past the 1-hour
            // TTL, then run the production staging sweeper.
            const futureNowMs =
              (yield* Clock.currentTimeMillis) + SESSION_TRANSFER_STALE_TTL_MS * 3;
            const oldSec = Math.floor(
              (futureNowMs - SESSION_TRANSFER_STALE_TTL_MS - 120_000) / 1000,
            );
            for (const entry of NodeFS.readdirSync(stagingDir)) {
              NodeFS.utimesSync(NodePath.join(stagingDir, entry), oldSec, oldSec);
            }
            NodeFS.utimesSync(stagingDir, oldSec, oldSec);
            NodeFS.utimesSync(ownershipPath, oldSec, oldSec);

            const swept = yield* sweepStaleSessionTransferStaging({
              stateDir: config.stateDir,
              nowMs: futureNowMs,
            });
            expect(swept.deletedDirs).toBeGreaterThanOrEqual(1);
            // Expired staging payload dir IS swept, while the durable ownership ledger SURVIVES!
            expect(NodeFS.existsSync(stagingDir)).toBe(false);
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            expect(NodeFS.existsSync(worktreePath)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", featureBranch])).not.toBe("");
          }).pipe(Effect.provide(repo1Layer));

          // Simulate destination restart after the 1-hour sweep with worktree removal unblocked.
          const instance2Layer = makeEndpointTestLayer({
            environmentId: localEnvId,
            environmentLabel: "TTL Sweep Host",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
          });

          const coordinator2SupportLayer = Layer.mergeAll(
            SessionTransferRepository.layer.pipe(Layer.provideMerge(instance2Layer)),
            Layer.succeed(
              BoatSupervisor.BoatSupervisor,
              BoatSupervisor.BoatSupervisor.of({
                invoke: () => Effect.succeed({ data: { ok: true } }),
                getMachineProxyAccess: () =>
                  Effect.succeed({
                    machineId: "machine-1",
                    machineName: "dev-boat",
                    environmentId: boatEnvId,
                    state: "idle",
                    localUrl: "http://127.0.0.1:41999",
                    bearerToken: "internal-boat-token",
                  }),
                hasConfiguredBoats: Effect.succeed(true),
                currentState: Effect.succeedNone,
                passiveEvents: Stream.empty,
                events: Stream.empty,
                notices: Stream.empty,
              }),
            ),
            Layer.succeed(
              SessionTransferCoordinator.BoatRemoteClient,
              SessionTransferCoordinator.BoatRemoteClient.of({
                getServerConfig: () => Effect.die("unused"),
                getShellSnapshot: () => Effect.die("unused"),
                getThreadSummary: () => Effect.die("unused"),
                prepareSource: () => Effect.die("unused"),
                stageImport: () => Effect.die("unused"),
                commitImport: () => Effect.die("unused"),
                finalizeSource: () => Effect.die("unused"),
                abort: () => Effect.succeed({ cleanedUp: true }),
                streamHttpTransfer: () => Effect.die("unused"),
              }),
            ),
            Layer.succeed(ProviderRegistry.ProviderRegistry, {
              getProviders: Effect.succeed([]),
            } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
            Layer.succeed(
              RepositoryIdentityResolver.RepositoryIdentityResolver,
              RepositoryIdentityResolver.RepositoryIdentityResolver.of({
                resolve: () => Effect.succeed(null),
              }),
            ),
          );

          const coordinator2Layer = SessionTransferCoordinator.layer.pipe(
            Layer.provideMerge(coordinator2SupportLayer),
          );

          yield* Effect.gen(function* () {
            const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
            const repo = yield* SessionTransferRepository.SessionTransferRepository;

            yield* coordinator.reconcileOnStartup;

            expect(NodeFS.existsSync(worktreePath)).toBe(false);
            expect(git(dstRepo, ["branch", "--list", featureBranch])).toBe("");
            expect(NodeFS.existsSync(ownershipPath)).toBe(false);
            const reconciled = yield* repo.getById(transferId);
            expect(Option.isSome(reconciled) && reconciled.value.phase).toBe("failed");
          }).pipe(Effect.scoped, Effect.provide(coordinator2Layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "prevents an interrupted pre-add allocation from colliding with another transfer and refuses to delete committed thread worktrees on abort",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-interrupted-alloc-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, dstRepo);

          const sharedBranch = "feat/interrupted-alloc";
          git(srcRepo, ["checkout", "-b", sharedBranch]);
          NodeFS.writeFileSync(
            NodePath.join(srcRepo, "interrupted-alloc.ts"),
            "export const kept = 42;\n",
          );
          git(srcRepo, ["add", "interrupted-alloc.ts"]);
          git(srcRepo, ["commit", "-m", "feature commit"]);

          const srcProjectId = ProjectId.make("proj-int-alloc-src");
          const dstProjectId = ProjectId.make("proj-int-alloc-dst");
          const srcThreadA = ThreadId.make("thread-int-alloc-src-a");
          const srcThreadB = ThreadId.make("thread-int-alloc-src-b");
          const srcThreadA2 = ThreadId.make("thread-int-alloc-src-a2");
          const transferA = SessionTransferId.make("xfer-int-alloc-a");
          const transferB = SessionTransferId.make("xfer-int-alloc-b");
          const transferA2 = SessionTransferId.make("xfer-int-alloc-a2");
          const transferC = SessionTransferId.make("xfer-int-alloc-c-manual");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          };

          const pauseAddEnteredA = yield* Deferred.make<void>();
          const pauseAddEnteredA2 = yield* Deferred.make<void>();
          let pauseAddMode: "none" | "pause-a" | "pause-a2" = "none";
          let blockedOwnershipPath: string | null = null;
          let failGetThreadWorktreePaths = false;

          const layer = makeEndpointTestLayer({
            environmentId: "env-int-alloc",
            environmentLabel: "Interrupted Allocation Env",
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onVcsRun: ({ input, next }) => {
                if (
                  input.operation === "WorkspaceBundle.addWorktree" &&
                  pauseAddMode === "pause-a"
                ) {
                  pauseAddMode = "none";
                  return Deferred.succeed(pauseAddEnteredA, undefined).pipe(
                    Effect.andThen(Effect.never),
                  );
                }
                if (
                  input.operation === "WorkspaceBundle.addWorktree" &&
                  pauseAddMode === "pause-a2"
                ) {
                  pauseAddMode = "none";
                  return Deferred.succeed(pauseAddEnteredA2, undefined).pipe(
                    Effect.andThen(Effect.never),
                  );
                }
                return next;
              },
              onFileSystemRemove: ({ targetPath, next }) => {
                if (blockedOwnershipPath !== null && targetPath === blockedOwnershipPath) {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: targetPath,
                    }),
                  );
                }
                return next;
              },
              onGetThreadWorktreePaths: ({ next }) =>
                failGetThreadWorktreePaths
                  ? Effect.fail(
                      new ProjectionStore.ProjectionStoreSetupError({
                        cause: new Error("SQLITE_BUSY: simulated worktree lookup error"),
                      }),
                    )
                  : next,
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: [
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThreadA,
                  branch: sharedBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThreadB,
                  branch: sharedBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThreadA2,
                  branch: sharedBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
              ],
            });

            const prepA = yield* svc.prepareSource({
              transferId: transferA,
              threadId: srcThreadA,
              direction: "boat_to_local",
            });
            const stagedA = yield* svc.stageImport({
              transferId: transferA,
              manifest: prepA.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferA, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferA, path)!,
              resolveImportBundlePath(config.stateDir, transferA, path)!,
            );

            const prepB = yield* svc.prepareSource({
              transferId: transferB,
              threadId: srcThreadB,
              direction: "boat_to_local",
            });
            const stagedB = yield* svc.stageImport({
              transferId: transferB,
              manifest: prepB.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferB, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferB, path)!,
              resolveImportBundlePath(config.stateDir, transferB, path)!,
            );

            const ownershipPathA = resolveWorktreeOwnershipPath(config.stateDir, transferA, path)!;

            // Part 1: Interrupt Transfer A immediately after persisting its ownership record and
            // before `git worktree add` runs, while blocking ownership unlink to simulate a crash
            // leaving A's persisted ownership record on disk.
            blockedOwnershipPath = ownershipPathA;
            pauseAddMode = "pause-a";
            const fiberA = yield* Effect.forkChild(
              svc.commitImport({
                transferId: transferA,
                destinationProjectId: stagedA.destinationProjectId,
                destinationThreadId: stagedA.destinationThreadId,
                manifest: prepA.manifest,
                autoResume: false,
              }),
            );
            yield* Deferred.await(pauseAddEnteredA);
            expect(NodeFS.existsSync(ownershipPathA)).toBe(true);
            yield* Fiber.interrupt(fiberA);

            // Ownership record A survived on disk while neither worktree nor branch was created in git.
            expect(NodeFS.existsSync(ownershipPathA)).toBe(true);
            const ownershipA = JSON.parse(NodeFS.readFileSync(ownershipPathA, "utf8")) as {
              readonly worktreePath: string;
              readonly branch: string;
              readonly gitCommonDir: string;
              readonly importCompleted: boolean;
            };
            expect(ownershipA.importCompleted).toBe(false);
            expect(ownershipA.branch).toBe(sharedBranch);
            expect(ownershipA.gitCommonDir).toBe(
              NodeFS.realpathSync(NodePath.join(dstRepo, ".git")),
            );
            expect(NodeFS.existsSync(ownershipA.worktreePath)).toBe(false);
            expect(git(dstRepo, ["branch", "--list", ownershipA.branch])).toBe("");

            // Now commit Transfer B with the SAME requested branch into the SAME repo:
            // Layer 1 must observe A's persisted ownership record and pick a DIFFERENT path & branch!
            const committedB = yield* svc.commitImport({
              transferId: transferB,
              destinationProjectId: stagedB.destinationProjectId,
              destinationThreadId: stagedB.destinationThreadId,
              manifest: prepB.manifest,
              autoResume: false,
            });
            expect(committedB.destinationWorktreePath).not.toBeNull();
            expect(committedB.destinationBranch).not.toBeNull();
            expect(committedB.destinationWorktreePath).not.toBe(ownershipA.worktreePath);
            expect(committedB.destinationBranch).not.toBe(ownershipA.branch);
            expect(NodeFS.existsSync(committedB.destinationWorktreePath!)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", committedB.destinationBranch!])).not.toBe("");

            // Unblock ownership unlink and abort Transfer A: A cleans up its own record and leaves
            // Transfer B's committed worktree and branch completely intact!
            blockedOwnershipPath = null;
            const abortA = yield* svc.abort({
              transferId: transferA,
              role: "destination",
            });
            expect(abortA.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(ownershipPathA)).toBe(false);
            expect(NodeFS.existsSync(committedB.destinationWorktreePath!)).toBe(true);
            expect(
              NodeFS.existsSync(
                NodePath.join(committedB.destinationWorktreePath!, "interrupted-alloc.ts"),
              ),
            ).toBe(true);
            expect(git(dstRepo, ["branch", "--list", committedB.destinationBranch!])).not.toBe("");

            // Part 2: Graceful Fiber.interrupt between onWorktreeAllocated and git worktree add
            // clears ownership atomically under the repo lock (Layer 2).
            const prepA2 = yield* svc.prepareSource({
              transferId: transferA2,
              threadId: srcThreadA2,
              direction: "boat_to_local",
            });
            const stagedA2 = yield* svc.stageImport({
              transferId: transferA2,
              manifest: prepA2.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferA2, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferA2, path)!,
              resolveImportBundlePath(config.stateDir, transferA2, path)!,
            );

            const ownershipPathA2 = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferA2,
              path,
            )!;
            pauseAddMode = "pause-a2";
            const fiberA2 = yield* Effect.forkChild(
              svc.commitImport({
                transferId: transferA2,
                destinationProjectId: stagedA2.destinationProjectId,
                destinationThreadId: stagedA2.destinationThreadId,
                manifest: prepA2.manifest,
                autoResume: false,
              }),
            );
            yield* Deferred.await(pauseAddEnteredA2);
            expect(NodeFS.existsSync(ownershipPathA2)).toBe(true);
            yield* Fiber.interrupt(fiberA2);
            expect(NodeFS.existsSync(ownershipPathA2)).toBe(false);

            // Part 3: Defense-in-depth in abort (Layer 3): even if an ownership file manually names
            // Transfer B's committed worktree path, abort propagates DB read errors and refuses to
            // delete Transfer B's committed worktree or branch!
            const ownershipPathC = resolveWorktreeOwnershipPath(config.stateDir, transferC, path)!;
            NodeFS.mkdirSync(NodePath.dirname(ownershipPathC), { recursive: true });
            NodeFS.writeFileSync(
              ownershipPathC,
              JSON.stringify({
                schemaVersion: 1,
                transferId: transferC,
                destinationProjectId: dstProjectId,
                projectWorkspaceRoot: dstRepo,
                gitCommonDir: NodeFS.realpathSync(NodePath.join(dstRepo, ".git")),
                gitCommonDirIdentity: readGitCommonDirIdentitySync(dstRepo),
                destinationThreadId: ThreadId.make("thread-uncommitted-c"),
                worktreePath: committedB.destinationWorktreePath!,
                branch: committedB.destinationBranch!,
                branchHeadSha: git(dstRepo, [
                  "rev-parse",
                  `refs/heads/${committedB.destinationBranch!}`,
                ]),
                createdBranch: true,
                importCompleted: false,
              }),
            );

            // DB read failure must propagate without deleting worktree, branch, or ownership file.
            failGetThreadWorktreePaths = true;
            const abortCFail = yield* Effect.result(
              svc.abort({
                transferId: transferC,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortCFail)).toBe(true);
            if (Result.isFailure(abortCFail)) {
              expect(abortCFail.failure.code).toBe("internal");
            }
            expect(NodeFS.existsSync(ownershipPathC)).toBe(true);
            expect(NodeFS.existsSync(committedB.destinationWorktreePath!)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", committedB.destinationBranch!])).not.toBe("");

            // Once DB reads succeed, abort refuses to delete B's committed worktree/branch and
            // safely clears C's stale ownership record.
            failGetThreadWorktreePaths = false;
            const abortC = yield* svc.abort({
              transferId: transferC,
              role: "destination",
            });
            expect(abortC.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(ownershipPathC)).toBe(false);
            expect(NodeFS.existsSync(committedB.destinationWorktreePath!)).toBe(true);
            expect(
              NodeFS.existsSync(
                NodePath.join(committedB.destinationWorktreePath!, "interrupted-alloc.ts"),
              ),
            ).toBe(true);
            expect(git(dstRepo, ["branch", "--list", committedB.destinationBranch!])).not.toBe("");
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "fails destination abort on ownership-file unlink PermissionDenied, blocks name reuse while ownership survives, and recovers on retry",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-ownership-unlink-eacces-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, dstRepo);

          const featureBranch = "feat/ownership-unlink-eacces";
          git(srcRepo, ["checkout", "-b", featureBranch]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "owned.ts"), "export const owned = true;\n");
          git(srcRepo, ["add", "owned.ts"]);
          git(srcRepo, ["commit", "-m", "feature commit"]);

          const srcProjectId = ProjectId.make("proj-own-eacces-src");
          const dstProjectId = ProjectId.make("proj-own-eacces-dst");
          const srcThreadA = ThreadId.make("thread-own-eacces-a");
          const srcThreadB = ThreadId.make("thread-own-eacces-b");
          const transferA = SessionTransferId.make("xfer-own-eacces-a");
          const transferB = SessionTransferId.make("xfer-own-eacces-b");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          };

          let failNextCommitEventWrite = false;
          let blockedOwnershipPath: string | null = null;

          const layer = makeEndpointTestLayer({
            environmentId: "env-own-eacces",
            environmentLabel: "Ownership Unlink EACCES Env",
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onEventSinkWrite: (events) => {
                if (failNextCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                  failNextCommitEventWrite = false;
                  return Effect.fail(
                    new TestHookError({ message: "Simulated commit failure after worktree" }),
                  );
                }
                return Effect.void;
              },
              onFileSystemRemove: ({ targetPath, next }) => {
                if (blockedOwnershipPath !== null && targetPath === blockedOwnershipPath) {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: targetPath,
                    }),
                  );
                }
                return next;
              },
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: [
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThreadA,
                  branch: featureBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThreadB,
                  branch: featureBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
              ],
            });

            const prepA = yield* svc.prepareSource({
              transferId: transferA,
              threadId: srcThreadA,
              direction: "boat_to_local",
            });
            const stagedA = yield* svc.stageImport({
              transferId: transferA,
              manifest: prepA.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferA, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferA, path)!,
              resolveImportBundlePath(config.stateDir, transferA, path)!,
            );

            // Commit A creates worktree + branch + ownership record, then fails SQLite commit.
            failNextCommitEventWrite = true;
            const commitA = yield* Effect.result(
              svc.commitImport({
                transferId: transferA,
                destinationProjectId: stagedA.destinationProjectId,
                destinationThreadId: stagedA.destinationThreadId,
                manifest: prepA.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitA)).toBe(true);

            const ownershipPathA = resolveWorktreeOwnershipPath(config.stateDir, transferA, path)!;
            expect(NodeFS.existsSync(ownershipPathA)).toBe(true);
            const ownershipA = JSON.parse(NodeFS.readFileSync(ownershipPathA, "utf8")) as {
              readonly worktreePath: string;
              readonly branch: string;
            };
            expect(NodeFS.existsSync(ownershipA.worktreePath)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", ownershipA.branch])).not.toBe("");

            // Inject PermissionDenied ONLY on ownership-file unlink during abort!
            blockedOwnershipPath = ownershipPathA;
            const abortA1 = yield* Effect.result(
              svc.abort({
                transferId: transferA,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortA1)).toBe(true);
            if (Result.isFailure(abortA1)) {
              expect(abortA1.failure.code).toBe("internal");
            }
            // Worktree & branch were cleaned, while the ownership file survived due to EACCES.
            expect(NodeFS.existsSync(ownershipA.worktreePath)).toBe(false);
            expect(git(dstRepo, ["branch", "--list", ownershipA.branch])).toBe("");
            expect(NodeFS.existsSync(ownershipPathA)).toBe(true);

            // While A's stale ownership file survives on disk, Transfer B CANNOT claim A's names!
            const prepB = yield* svc.prepareSource({
              transferId: transferB,
              threadId: srcThreadB,
              direction: "boat_to_local",
            });
            const stagedB = yield* svc.stageImport({
              transferId: transferB,
              manifest: prepB.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferB, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferB, path)!,
              resolveImportBundlePath(config.stateDir, transferB, path)!,
            );

            const committedB = yield* svc.commitImport({
              transferId: transferB,
              destinationProjectId: stagedB.destinationProjectId,
              destinationThreadId: stagedB.destinationThreadId,
              manifest: prepB.manifest,
              autoResume: false,
            });
            expect(committedB.destinationBranch).not.toBe(ownershipA.branch);
            expect(committedB.destinationWorktreePath).not.toBe(ownershipA.worktreePath);

            // Restore unlink permission and retry abort for A -> succeeds, deletes ownership file,
            // and leaves Transfer B's committed worktree and branch intact!
            blockedOwnershipPath = null;
            const abortA2 = yield* svc.abort({
              transferId: transferA,
              role: "destination",
            });
            expect(abortA2.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(ownershipPathA)).toBe(false);
            expect(NodeFS.existsSync(committedB.destinationWorktreePath!)).toBe(true);
            expect(git(dstRepo, ["branch", "--list", committedB.destinationBranch!])).not.toBe("");

            // Third abort is an idempotent no-op.
            const abortA3 = yield* svc.abort({
              transferId: transferA,
              role: "destination",
            });
            expect(abortA3.cleanedUp).toBe(false);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "serializes concurrent commitImport calls targeting a main checkout and a linked Git worktree on the same gitCommonDir mutex",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-linked-wt-mutex-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const dstMainRepo = NodePath.join(tmpRoot, "dst-main-repo");
          const dstLinkedWt = NodePath.join(tmpRoot, "dst-linked-wt");
          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, dstMainRepo);
          git(dstMainRepo, ["worktree", "add", "-b", "linked-base", dstLinkedWt, "HEAD"]);

          const sharedBranch = "feat/linked-wt-shared-mutex";
          git(srcRepo, ["checkout", "-b", sharedBranch]);
          NodeFS.writeFileSync(
            NodePath.join(srcRepo, "linked-mutex.ts"),
            "export const serialized = true;\n",
          );
          git(srcRepo, ["add", "linked-mutex.ts"]);
          git(srcRepo, ["commit", "-m", "shared branch commit"]);

          const srcProjectId = ProjectId.make("proj-linked-mutex-src");
          const dstMainProjectId = ProjectId.make("proj-linked-mutex-main");
          const dstLinkedProjectId = ProjectId.make("proj-linked-mutex-wt");
          const srcThread1 = ThreadId.make("thread-linked-mutex-1");
          const srcThread2 = ThreadId.make("thread-linked-mutex-2");
          const transfer1 = SessionTransferId.make("xfer-linked-mutex-1");
          const transfer2 = SessionTransferId.make("xfer-linked-mutex-2");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          };

          let activeCriticalSections = 0;
          let maxConcurrentCriticalSections = 0;
          let listBranchesCount = 0;
          const firstAddEntered = yield* Deferred.make<void>();
          const allowFirstAdd = yield* Deferred.make<void>();
          let delayedFirstAdd = false;

          const layer = makeEndpointTestLayer({
            environmentId: "env-linked-wt-mutex",
            environmentLabel: "Linked Worktree Mutex Env",
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstMainProjectId, title: "dst-main", workspaceRoot: dstMainRepo },
              { id: dstLinkedProjectId, title: "dst-linked", workspaceRoot: dstLinkedWt },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onVcsRun: ({ input, next }) => {
                if (input.operation === "WorkspaceBundle.listLocalBranches") {
                  return Effect.sync(() => {
                    listBranchesCount += 1;
                    activeCriticalSections += 1;
                    if (activeCriticalSections > maxConcurrentCriticalSections) {
                      maxConcurrentCriticalSections = activeCriticalSections;
                    }
                  }).pipe(Effect.andThen(next));
                }
                if (input.operation === "WorkspaceBundle.addWorktree") {
                  const shouldDelay = !delayedFirstAdd;
                  if (shouldDelay) {
                    delayedFirstAdd = true;
                  }
                  return Effect.gen(function* () {
                    if (shouldDelay) {
                      yield* Deferred.succeed(firstAddEntered, undefined);
                      yield* Deferred.await(allowFirstAdd);
                    }
                    return yield* next;
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        activeCriticalSections = Math.max(0, activeCriticalSections - 1);
                      }),
                    ),
                  );
                }
                return next;
              },
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: [
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThread1,
                  branch: sharedBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThread2,
                  branch: sharedBranch,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
              ],
            });

            const prep1 = yield* svc.prepareSource({
              transferId: transfer1,
              threadId: srcThread1,
              direction: "boat_to_local",
            });
            const staged1 = yield* svc.stageImport({
              transferId: transfer1,
              manifest: prep1.manifest,
              targetProjectId: dstMainProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transfer1, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transfer1, path)!,
              resolveImportBundlePath(config.stateDir, transfer1, path)!,
            );

            const prep2 = yield* svc.prepareSource({
              transferId: transfer2,
              threadId: srcThread2,
              direction: "boat_to_local",
            });
            const staged2 = yield* svc.stageImport({
              transferId: transfer2,
              manifest: prep2.manifest,
              targetProjectId: dstLinkedProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transfer2, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transfer2, path)!,
              resolveImportBundlePath(config.stateDir, transfer2, path)!,
            );

            // Launch both commitImport calls concurrently: one targeting dstMainRepo and the other
            // targeting its linked worktree dstLinkedWt with the SAME requested branch name!
            const fiber1 = yield* Effect.forkChild(
              svc.commitImport({
                transferId: transfer1,
                destinationProjectId: staged1.destinationProjectId,
                destinationThreadId: staged1.destinationThreadId,
                manifest: prep1.manifest,
                autoResume: false,
              }),
            );
            const fiber2 = yield* Effect.forkChild(
              svc.commitImport({
                transferId: transfer2,
                destinationProjectId: staged2.destinationProjectId,
                destinationThreadId: staged2.destinationThreadId,
                manifest: prep2.manifest,
                autoResume: false,
              }),
            );

            // Once the first transfer enters git worktree add, give the second transfer plenty of
            // turns to try to enter listLocalBranches; it must stay blocked on the shared gitCommonDir mutex.
            yield* Deferred.await(firstAddEntered);
            for (let i = 0; i < 10; i += 1) {
              yield* Effect.yieldNow;
            }
            expect(activeCriticalSections).toBe(1);
            expect(listBranchesCount).toBe(1);

            yield* Deferred.succeed(allowFirstAdd, undefined);
            const [res1, res2] = yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)]);

            // Both imports must have serialized on the same gitCommonDir mutex (never overlapping).
            expect(listBranchesCount).toBe(2);
            expect(maxConcurrentCriticalSections).toBe(1);
            expect(res1.destinationBranch).not.toBeNull();
            expect(res2.destinationBranch).not.toBeNull();
            expect(res1.destinationBranch).not.toBe(res2.destinationBranch);
            expect(res1.destinationWorktreePath).not.toBeNull();
            expect(res2.destinationWorktreePath).not.toBeNull();
            expect(res1.destinationWorktreePath).not.toBe(res2.destinationWorktreePath);
            expect(
              NodeFS.existsSync(NodePath.join(res1.destinationWorktreePath!, "linked-mutex.ts")),
            ).toBe(true);
            expect(
              NodeFS.existsSync(NodePath.join(res2.destinationWorktreePath!, "linked-mutex.ts")),
            ).toBe(true);
            expect(git(dstMainRepo, ["branch", "--list", res1.destinationBranch!])).not.toBe("");
            expect(git(dstMainRepo, ["branch", "--list", res2.destinationBranch!])).not.toBe("");
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );
  it.effect(
    "preserves an externally created branch on pre-add interruption and on post-restart abort of worktreeCreated: false ownership records",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-ext-branch-protect-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          const sharedBaseDir = NodePath.join(tmpRoot, "state-base");
          initGitRepo(srcRepo);
          git(tmpRoot, ["clone", srcRepo, dstRepo]);

          const externalBranch = "feat/external-branch-probe";
          git(srcRepo, ["checkout", "-b", externalBranch]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "probe.ts"), "export const probe = 1;\n");
          git(srcRepo, ["add", "-A"]);
          git(srcRepo, ["commit", "-m", "probe commit"]);

          const srcProjectId = ProjectId.make("proj-ext-probe-src");
          const dstProjectId = ProjectId.make("proj-ext-probe-dst");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          };

          // Part 1: Live interruption probe — pause right after onWorktreeAllocated (before git worktree add),
          // independently create the requested branch in dstRepo, then interrupt the transfer.
          const pauseAddEntered = yield* Deferred.make<void>();
          let pauseAdd = true;

          const layer1 = makeEndpointTestLayer({
            environmentId: "env-ext-probe-1",
            environmentLabel: "External Branch Probe 1",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onVcsRun: ({ input, next }) => {
                if (input.operation === "WorkspaceBundle.addWorktree" && pauseAdd) {
                  pauseAdd = false;
                  return Deferred.succeed(pauseAddEntered, undefined).pipe(
                    Effect.andThen(Effect.never),
                  );
                }
                return next;
              },
            },
          });

          const transferLive = SessionTransferId.make("xfer-ext-branch-live");
          const transferRestart = SessionTransferId.make("xfer-ext-branch-restart");
          const transferRegisteredCrash = SessionTransferId.make("xfer-ext-branch-reg-crash");

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            const srcThreadId = ThreadId.make("thread-ext-probe-live");
            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: externalBranch,
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId: transferLive,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const staged = yield* svc.stageImport({
              transferId: transferLive,
              manifest: prep.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferLive, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferLive, path)!,
              resolveImportBundlePath(config.stateDir, transferLive, path)!,
            );

            const ownershipPath = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferLive,
              path,
            )!;

            const commitFiber = yield* Effect.forkChild(
              svc.commitImport({
                transferId: transferLive,
                destinationProjectId: staged.destinationProjectId,
                destinationThreadId: staged.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            yield* Deferred.await(pauseAddEntered);

            // Ownership record must already exist on disk with worktreeCreated: false and repoRoot.
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            const persistedPreAdd = JSON.parse(NodeFS.readFileSync(ownershipPath, "utf8")) as {
              readonly repoRoot: string;
              readonly gitCommonDir: string;
              readonly branch: string;
              readonly worktreePath: string;
              readonly worktreeCreated: boolean;
              readonly importCompleted: boolean;
            };
            expect(persistedPreAdd.worktreeCreated).toBe(false);
            expect(persistedPreAdd.importCompleted).toBe(false);
            expect(persistedPreAdd.repoRoot).toBe(dstRepo);
            expect(persistedPreAdd.gitCommonDir).toBe(
              NodeFS.realpathSync(NodePath.join(dstRepo, ".git")),
            );
            expect(persistedPreAdd.branch).toBe(externalBranch);

            // Independently create the requested branch in dstRepo before interrupting the transfer.
            git(dstRepo, ["branch", externalBranch]);
            const expectedBranchSha = git(dstRepo, ["rev-parse", `refs/heads/${externalBranch}`]);

            yield* Fiber.interrupt(commitFiber);

            // Externally created branch MUST still exist untouched, and ownership record MUST be cleared!
            expect(git(dstRepo, ["rev-parse", `refs/heads/${externalBranch}`])).toBe(
              expectedBranchSha,
            );
            expect(NodeFS.existsSync(ownershipPath)).toBe(false);
            expect(NodeFS.existsSync(persistedPreAdd.worktreePath)).toBe(false);
          }).pipe(Effect.provide(layer1));

          // Part 2: Crash/restart variant — persist an ownership record with worktreeCreated: false
          // while externalBranch exists independently in dstRepo (no worktree at worktreePath), then
          // run destination abort on a fresh service instance.
          const layer2 = makeEndpointTestLayer({
            environmentId: "env-ext-probe-2",
            environmentLabel: "External Branch Probe 2",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: dstRepo },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
          });

          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            const expectedBranchSha = git(dstRepo, ["rev-parse", `refs/heads/${externalBranch}`]);
            const nonexistentWorktreePath = NodePath.join(tmpRoot, "never-created-wt");
            const restartOwnershipPath = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferRestart,
              path,
            )!;
            NodeFS.mkdirSync(NodePath.dirname(restartOwnershipPath), { recursive: true });
            NodeFS.writeFileSync(
              restartOwnershipPath,
              JSON.stringify({
                schemaVersion: 1,
                transferId: transferRestart,
                destinationProjectId: dstProjectId,
                projectWorkspaceRoot: dstRepo,
                repoRoot: dstRepo,
                gitCommonDir: NodeFS.realpathSync(NodePath.join(dstRepo, ".git")),
                gitCommonDirIdentity: readGitCommonDirIdentitySync(dstRepo),
                destinationThreadId: ThreadId.make("thread-ext-probe-restart"),
                worktreePath: nonexistentWorktreePath,
                branch: externalBranch,
                branchHeadSha: null,
                createdBranch: true,
                worktreeCreated: false,
                importCompleted: false,
              }),
            );

            const abortedRestart = yield* svc.abort({
              transferId: transferRestart,
              role: "destination",
            });
            expect(abortedRestart.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(restartOwnershipPath)).toBe(false);
            expect(git(dstRepo, ["rev-parse", `refs/heads/${externalBranch}`])).toBe(
              expectedBranchSha,
            );

            // Part 3: Positive-proof crash variant — worktreeCreated: false, but git worktree add
            // DID register worktreePath on refs/heads/<branch> right before crashing.
            // Destination abort MUST clean up both the registered worktree and its bound branch.
            const boundBranch = "feat/bound-before-crash";
            const boundWorktreePath = NodePath.join(tmpRoot, "bound-before-crash-wt");
            git(dstRepo, ["worktree", "add", "-b", boundBranch, boundWorktreePath, "HEAD"]);
            const regCrashOwnershipPath = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferRegisteredCrash,
              path,
            )!;
            NodeFS.mkdirSync(NodePath.dirname(regCrashOwnershipPath), { recursive: true });
            NodeFS.writeFileSync(
              regCrashOwnershipPath,
              JSON.stringify({
                schemaVersion: 1,
                transferId: transferRegisteredCrash,
                destinationProjectId: dstProjectId,
                projectWorkspaceRoot: dstRepo,
                repoRoot: dstRepo,
                gitCommonDir: NodeFS.realpathSync(NodePath.join(dstRepo, ".git")),
                gitCommonDirIdentity: readGitCommonDirIdentitySync(dstRepo),
                destinationThreadId: ThreadId.make("thread-ext-probe-reg-crash"),
                worktreePath: boundWorktreePath,
                branch: boundBranch,
                branchHeadSha: null,
                createdBranch: true,
                worktreeCreated: false,
                importCompleted: false,
              }),
            );

            const abortedBound = yield* svc.abort({
              transferId: transferRegisteredCrash,
              role: "destination",
            });
            expect(abortedBound.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(regCrashOwnershipPath)).toBe(false);
            expect(NodeFS.existsSync(boundWorktreePath)).toBe(false);
            expect(git(dstRepo, ["branch", "--list", boundBranch])).toBe("");
            // External branch is still untouched.
            expect(git(dstRepo, ["rev-parse", `refs/heads/${externalBranch}`])).toBe(
              expectedBranchSha,
            );
          }).pipe(Effect.provide(layer2));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "isolates ownership repository identity on cross-project restaging so abort never deletes a branch in Repo B",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-cross-repo-"));
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const repoA = NodePath.join(tmpRoot, "repo-a");
          const repoB = NodePath.join(tmpRoot, "repo-b");
          const sharedBaseDir = NodePath.join(tmpRoot, "state-base");

          // Repo A and Repo B are completely distinct Git repositories.
          initGitRepo(srcRepo);
          git(tmpRoot, ["clone", srcRepo, repoA]);
          initGitRepo(repoB);
          NodeFS.writeFileSync(NodePath.join(repoB, "repo-b-only.txt"), "repo B\n");
          git(repoB, ["add", "-A"]);
          git(repoB, ["commit", "-m", "repo B unique commit"]);

          const sharedBranchName = "feat/cross-repo-branch";
          // Existing unoccupied branch B in Repo B that MUST NEVER be deleted!
          git(repoB, ["branch", sharedBranchName]);
          const repoBBranchSha = git(repoB, ["rev-parse", `refs/heads/${sharedBranchName}`]);

          git(srcRepo, ["checkout", "-b", sharedBranchName]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "cross.ts"), "export const cross = 1;\n");
          git(srcRepo, ["add", "-A"]);
          git(srcRepo, ["commit", "-m", "source feature commit"]);

          const srcProjectId = ProjectId.make("proj-cross-src");
          const projectAId = ProjectId.make("proj-cross-a");
          const projectBId = ProjectId.make("proj-cross-b");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          };

          let failCommitEventWrite = false;
          const layer = makeEndpointTestLayer({
            environmentId: "env-cross-repo",
            environmentLabel: "Cross Repo Env",
            sharedBaseDir,
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: projectAId, title: "Repo A", workspaceRoot: repoA },
              { id: projectBId, title: "Repo B", workspaceRoot: repoB },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onEventSinkWrite: (events) => {
                if (failCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                  failCommitEventWrite = false;
                  return Effect.fail(new TestHookError({ message: "simulated commit event fail" }));
                }
                return Effect.void;
              },
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            const srcThread1 = ThreadId.make("thread-cross-1");
            const srcThread2 = ThreadId.make("thread-cross-2");
            const srcThread3 = ThreadId.make("thread-cross-3");
            yield* eventSink.write({
              events: [
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThread1,
                  branch: sharedBranchName,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThread2,
                  branch: sharedBranchName,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
                ...seedThreadEvents({
                  projectId: srcProjectId,
                  threadId: srcThread3,
                  branch: sharedBranchName,
                  worktreePath: srcRepo,
                  modelSelection,
                  running: false,
                }),
              ],
            });

            // Case 1 (worktreeCreated: true): Transfer T1 creates real worktree + branch B in Repo A
            // (commitImport fails on event write, leaving ownership in Repo A with worktreeCreated: true),
            // then T1 is restaged against Repo B and aborted.
            const transfer1 = SessionTransferId.make("xfer-cross-created-true");
            const prep1 = yield* svc.prepareSource({
              transferId: transfer1,
              threadId: srcThread1,
              direction: "boat_to_local",
            });
            const staged1A = yield* svc.stageImport({
              transferId: transfer1,
              manifest: prep1.manifest,
              targetProjectId: projectAId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transfer1, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transfer1, path)!,
              resolveImportBundlePath(config.stateDir, transfer1, path)!,
            );

            failCommitEventWrite = true;
            const commitFail1 = yield* Effect.result(
              svc.commitImport({
                transferId: transfer1,
                destinationProjectId: staged1A.destinationProjectId,
                destinationThreadId: staged1A.destinationThreadId,
                manifest: prep1.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitFail1)).toBe(true);

            const ownershipPath1 = resolveWorktreeOwnershipPath(config.stateDir, transfer1, path)!;
            expect(NodeFS.existsSync(ownershipPath1)).toBe(true);
            const ownership1 = JSON.parse(NodeFS.readFileSync(ownershipPath1, "utf8")) as {
              readonly repoRoot: string;
              readonly gitCommonDir: string;
              readonly worktreePath: string;
              readonly branch: string;
              readonly worktreeCreated: boolean;
            };
            expect(ownership1.repoRoot).toBe(repoA);
            expect(ownership1.gitCommonDir).toBe(NodeFS.realpathSync(NodePath.join(repoA, ".git")));
            expect(ownership1.branch).toBe(sharedBranchName);
            expect(ownership1.worktreeCreated).toBe(true);
            expect(NodeFS.existsSync(ownership1.worktreePath)).toBe(true);
            expect(git(repoA, ["branch", "--list", sharedBranchName])).not.toBe("");

            // Restage T1 against Repo B -> must clean up Repo A's worktree & branch in Repo A,
            // never carry them into Repo B's staged state, and leave Repo B's branch B untouched!
            const restaged1B = yield* svc.stageImport({
              transferId: transfer1,
              manifest: prep1.manifest,
              targetProjectId: projectBId,
            });
            expect(restaged1B.destinationProjectId).toBe(projectBId);
            expect(restaged1B.destinationWorktreePath).toBeNull();
            expect(restaged1B.destinationBranch).toBeNull();
            expect(NodeFS.existsSync(ownership1.worktreePath)).toBe(false);
            expect(git(repoA, ["branch", "--list", sharedBranchName])).toBe("");
            expect(NodeFS.existsSync(ownershipPath1)).toBe(false);
            expect(git(repoB, ["rev-parse", `refs/heads/${sharedBranchName}`])).toBe(
              repoBBranchSha,
            );

            // Abort T1 -> Repo B's branch B MUST STILL EXIST completely untouched!
            const abort1 = yield* svc.abort({
              transferId: transfer1,
              role: "destination",
            });
            expect(abort1.cleanedUp).toBe(true);
            expect(git(repoB, ["rev-parse", `refs/heads/${sharedBranchName}`])).toBe(
              repoBBranchSha,
            );

            // Case 2 (worktreeCreated: false): Persist an ownership record for T2 in Repo A with
            // worktreeCreated: false and createdBranch: B (and an independent branch B in Repo A),
            // restage T2 against Repo B, and call destination abort(T2).
            const transfer2 = SessionTransferId.make("xfer-cross-created-false");
            const prep2 = yield* svc.prepareSource({
              transferId: transfer2,
              threadId: srcThread2,
              direction: "boat_to_local",
            });
            git(repoA, ["branch", sharedBranchName]);
            const repoAExtBranchSha = git(repoA, ["rev-parse", `refs/heads/${sharedBranchName}`]);
            const ownershipPath2 = resolveWorktreeOwnershipPath(config.stateDir, transfer2, path)!;
            NodeFS.mkdirSync(NodePath.dirname(ownershipPath2), { recursive: true });
            NodeFS.writeFileSync(
              ownershipPath2,
              JSON.stringify({
                schemaVersion: 1,
                transferId: transfer2,
                destinationProjectId: projectAId,
                projectWorkspaceRoot: repoA,
                repoRoot: repoA,
                gitCommonDir: NodeFS.realpathSync(NodePath.join(repoA, ".git")),
                gitCommonDirIdentity: readGitCommonDirIdentitySync(repoA),
                destinationThreadId: ThreadId.make("thread-cross-2-dst"),
                worktreePath: NodePath.join(tmpRoot, "repo-a-uncreated-wt"),
                branch: sharedBranchName,
                branchHeadSha: null,
                createdBranch: true,
                worktreeCreated: false,
                importCompleted: false,
              }),
            );

            const restaged2B = yield* svc.stageImport({
              transferId: transfer2,
              manifest: prep2.manifest,
              targetProjectId: projectBId,
            });
            expect(restaged2B.destinationProjectId).toBe(projectBId);
            expect(restaged2B.destinationWorktreePath).toBeNull();
            expect(restaged2B.destinationBranch).toBeNull();
            expect(NodeFS.existsSync(ownershipPath2)).toBe(false);
            // Both Repo B's branch B AND Repo A's externally created branch B remain untouched!
            expect(git(repoB, ["rev-parse", `refs/heads/${sharedBranchName}`])).toBe(
              repoBBranchSha,
            );
            expect(git(repoA, ["rev-parse", `refs/heads/${sharedBranchName}`])).toBe(
              repoAExtBranchSha,
            );

            const abort2 = yield* svc.abort({
              transferId: transfer2,
              role: "destination",
            });
            expect(abort2.cleanedUp).toBe(true);
            expect(git(repoB, ["rev-parse", `refs/heads/${sharedBranchName}`])).toBe(
              repoBBranchSha,
            );
            expect(git(repoA, ["rev-parse", `refs/heads/${sharedBranchName}`])).toBe(
              repoAExtBranchSha,
            );

            // Clean up Repo A's external branch before Case 3.
            git(repoA, ["branch", "-D", sharedBranchName]);

            // Case 3: Cross-repo restage MUST fail if Repo A cleanup fails (locked worktree),
            // keeping Repo A ownership intact; and direct abort uses ownership.repoRoot (Repo A),
            // never deleting Repo B's branch B even when staged in-memory against Repo B.
            const transfer3 = SessionTransferId.make("xfer-cross-locked-cleanup");
            const prep3 = yield* svc.prepareSource({
              transferId: transfer3,
              threadId: srcThread3,
              direction: "boat_to_local",
            });
            const staged3A = yield* svc.stageImport({
              transferId: transfer3,
              manifest: prep3.manifest,
              targetProjectId: projectAId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transfer3, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transfer3, path)!,
              resolveImportBundlePath(config.stateDir, transfer3, path)!,
            );

            failCommitEventWrite = true;
            const commitFail3 = yield* Effect.result(
              svc.commitImport({
                transferId: transfer3,
                destinationProjectId: staged3A.destinationProjectId,
                destinationThreadId: staged3A.destinationThreadId,
                manifest: prep3.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitFail3)).toBe(true);

            const ownershipPath3 = resolveWorktreeOwnershipPath(config.stateDir, transfer3, path)!;
            const ownership3 = JSON.parse(NodeFS.readFileSync(ownershipPath3, "utf8")) as {
              readonly worktreePath: string;
            };
            git(repoA, ["worktree", "lock", "--reason", "held in repo A", ownership3.worktreePath]);
            let unlocked3 = false;
            try {
              const failedRestage3B = yield* Effect.result(
                svc.stageImport({
                  transferId: transfer3,
                  manifest: prep3.manifest,
                  targetProjectId: projectBId,
                }),
              );
              expect(Result.isFailure(failedRestage3B)).toBe(true);
              if (Result.isFailure(failedRestage3B)) {
                expect(failedRestage3B.failure.code).toBe("workspace_error");
              }
              expect(NodeFS.existsSync(ownershipPath3)).toBe(true);
              expect(NodeFS.existsSync(ownership3.worktreePath)).toBe(true);
              expect(git(repoB, ["rev-parse", `refs/heads/${sharedBranchName}`])).toBe(
                repoBBranchSha,
              );

              git(repoA, ["worktree", "unlock", ownership3.worktreePath]);
              unlocked3 = true;

              const abort3 = yield* svc.abort({
                transferId: transfer3,
                role: "destination",
              });
              expect(abort3.cleanedUp).toBe(true);
              expect(NodeFS.existsSync(ownershipPath3)).toBe(false);
              expect(NodeFS.existsSync(ownership3.worktreePath)).toBe(false);
              expect(git(repoA, ["branch", "--list", sharedBranchName])).toBe("");
              expect(git(repoB, ["rev-parse", `refs/heads/${sharedBranchName}`])).toBe(
                repoBBranchSha,
              );
            } finally {
              if (!unlocked3) {
                yield* Effect.try({
                  try: () => git(repoA, ["worktree", "unlock", ownership3.worktreePath]),
                  catch: () => undefined,
                }).pipe(Effect.ignore);
              }
            }
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "refuses to force-remove an independent worktree on a different branch during abort (for both worktreeCreated: false and worktreeCreated: true)",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-diff-branch-wt-"),
        );
        try {
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          const sharedBaseDir = NodePath.join(tmpRoot, "state-base");
          initGitRepo(dstRepo);

          const dstProjectId = ProjectId.make("proj-diff-branch-dst");
          const layer = makeEndpointTestLayer({
            environmentId: "env-diff-branch",
            environmentLabel: "Diff Branch Guard Env",
            sharedBaseDir,
            projects: [{ id: dstProjectId, title: "dst", workspaceRoot: dstRepo }],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
          });

          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            // Part 1 (worktreeCreated: false): an independent worktree on a different branch
            // with an uncommitted file (and an unattached branch matching ownership.branch) must
            // all survive abort while this transfer's ownership record is cleared.
            const transferFalse = SessionTransferId.make("xfer-diff-branch-false");
            const independentWt1 = NodePath.join(tmpRoot, "independent-wt-1");
            const independentBranch1 = "feat/independent-work-1";
            const expectedBranch1 = "feat/expected-transfer-1";
            git(dstRepo, ["worktree", "add", "-b", independentBranch1, independentWt1, "HEAD"]);
            const uncommittedFile1 = NodePath.join(independentWt1, "uncommitted-work.txt");
            NodeFS.writeFileSync(uncommittedFile1, "precious uncommitted edit\n");
            git(dstRepo, ["branch", expectedBranch1]);
            const expectedBranch1Sha = git(dstRepo, ["rev-parse", `refs/heads/${expectedBranch1}`]);
            const independentBranch1Sha = git(dstRepo, [
              "rev-parse",
              `refs/heads/${independentBranch1}`,
            ]);

            const ownershipPathFalse = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferFalse,
              path,
            )!;
            NodeFS.mkdirSync(NodePath.dirname(ownershipPathFalse), { recursive: true });
            NodeFS.writeFileSync(
              ownershipPathFalse,
              JSON.stringify({
                schemaVersion: 1,
                transferId: transferFalse,
                destinationProjectId: dstProjectId,
                projectWorkspaceRoot: dstRepo,
                repoRoot: dstRepo,
                gitCommonDir: NodeFS.realpathSync(NodePath.join(dstRepo, ".git")),
                gitCommonDirIdentity: readGitCommonDirIdentitySync(dstRepo),
                destinationThreadId: ThreadId.make("thread-diff-branch-false"),
                worktreePath: independentWt1,
                branch: expectedBranch1,
                branchHeadSha: null,
                createdBranch: true,
                worktreeCreated: false,
                importCompleted: false,
              }),
            );

            const abortFalse = yield* svc.abort({
              transferId: transferFalse,
              role: "destination",
            });
            expect(abortFalse.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(ownershipPathFalse)).toBe(false);
            expect(NodeFS.existsSync(independentWt1)).toBe(true);
            expect(NodeFS.readFileSync(uncommittedFile1, "utf8")).toBe(
              "precious uncommitted edit\n",
            );
            expect(git(dstRepo, ["rev-parse", `refs/heads/${independentBranch1}`])).toBe(
              independentBranch1Sha,
            );
            expect(git(dstRepo, ["rev-parse", `refs/heads/${expectedBranch1}`])).toBe(
              expectedBranch1Sha,
            );

            // Part 2 (worktreeCreated: true): registered worktree at worktreePath is on a
            // DIFFERENT branch -> abort MUST refuse to force-remove it and leave worktree,
            // uncommitted file, and branch intact!
            const transferTrue = SessionTransferId.make("xfer-diff-branch-true");
            const independentWt2 = NodePath.join(tmpRoot, "independent-wt-2");
            const independentBranch2 = "feat/independent-work-2";
            const expectedBranch2 = "feat/expected-transfer-2";
            git(dstRepo, ["worktree", "add", "-b", independentBranch2, independentWt2, "HEAD"]);
            const uncommittedFile2 = NodePath.join(independentWt2, "active-wip.txt");
            NodeFS.writeFileSync(uncommittedFile2, "active branch edit\n");
            const independentBranch2Sha = git(dstRepo, [
              "rev-parse",
              `refs/heads/${independentBranch2}`,
            ]);

            const ownershipPathTrue = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferTrue,
              path,
            )!;
            NodeFS.writeFileSync(
              ownershipPathTrue,
              JSON.stringify({
                schemaVersion: 1,
                transferId: transferTrue,
                destinationProjectId: dstProjectId,
                projectWorkspaceRoot: dstRepo,
                repoRoot: dstRepo,
                gitCommonDir: NodeFS.realpathSync(NodePath.join(dstRepo, ".git")),
                gitCommonDirIdentity: readGitCommonDirIdentitySync(dstRepo),
                destinationThreadId: ThreadId.make("thread-diff-branch-true"),
                worktreePath: independentWt2,
                branch: expectedBranch2,
                branchHeadSha: git(dstRepo, ["rev-parse", "HEAD"]),
                createdBranch: true,
                worktreeCreated: true,
                importCompleted: false,
              }),
            );

            const abortTrue = yield* Effect.result(
              svc.abort({
                transferId: transferTrue,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortTrue)).toBe(true);
            if (Result.isFailure(abortTrue)) {
              expect(abortTrue.failure.code).toBe("workspace_error");
            }
            expect(NodeFS.existsSync(ownershipPathTrue)).toBe(true);
            expect(NodeFS.existsSync(independentWt2)).toBe(true);
            expect(NodeFS.readFileSync(uncommittedFile2, "utf8")).toBe("active branch edit\n");
            expect(git(dstRepo, ["rev-parse", `refs/heads/${independentBranch2}`])).toBe(
              independentBranch2Sha,
            );
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "clears in-memory staged allocation immediately after Repo A cleanup so failed bundle-URL signing during cross-repo restaging never lets abort delete a recreated branch in Repo A",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-restage-sign-fail-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const repoA = NodePath.join(tmpRoot, "repo-a");
          const repoB = NodePath.join(tmpRoot, "repo-b");
          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, repoA);
          initGitRepo(repoB);
          NodeFS.writeFileSync(NodePath.join(repoB, "b.txt"), "repo b\n");
          git(repoB, ["add", "-A"]);
          git(repoB, ["commit", "-m", "repo b commit"]);

          const branchName = "feat/restage-sign-fail";
          git(srcRepo, ["checkout", "-b", branchName]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.ts"), "export const x = 1;\n");
          git(srcRepo, ["add", "-A"]);
          git(srcRepo, ["commit", "-m", "feature commit"]);

          const srcProjectId = ProjectId.make("proj-signfail-src");
          const projectAId = ProjectId.make("proj-signfail-a");
          const projectBId = ProjectId.make("proj-signfail-b");
          const srcThreadId = ThreadId.make("thread-signfail-src");
          const transferId = SessionTransferId.make("xfer-restage-sign-fail");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          };

          let failCommitEventWrite = false;
          let failNextAssetSign = false;

          const layer = makeEndpointTestLayer({
            environmentId: "env-restage-sign-fail",
            environmentLabel: "Restage Sign Fail Env",
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: projectAId, title: "Repo A", workspaceRoot: repoA },
              { id: projectBId, title: "Repo B", workspaceRoot: repoB },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onEventSinkWrite: (events) => {
                if (failCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                  failCommitEventWrite = false;
                  return Effect.fail(new TestHookError({ message: "simulated commit fail" }));
                }
                return Effect.void;
              },
              onAssetSign: ({ next }) => {
                if (failNextAssetSign) {
                  failNextAssetSign = false;
                  return Effect.fail(
                    new ServerSecretStore.SecretStoreReadError({
                      resource: "asset-access-signing-key",
                      cause: new Error("Simulated bundle URL signing failure"),
                    }),
                  );
                }
                return next;
              },
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: branchName,
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const stagedA = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: projectAId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferId, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            // Commit creates worktree + branch in Repo A, then fails SQLite commit so Repo A
            // allocation lives both on disk AND in stagedImports in memory.
            failCommitEventWrite = true;
            const failedCommit = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: stagedA.destinationProjectId,
                destinationThreadId: stagedA.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(failedCommit)).toBe(true);

            const ownershipPath = resolveWorktreeOwnershipPath(config.stateDir, transferId, path)!;
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            const ownershipA = JSON.parse(NodeFS.readFileSync(ownershipPath, "utf8")) as {
              readonly worktreePath: string;
            };
            expect(NodeFS.existsSync(ownershipA.worktreePath)).toBe(true);
            expect(git(repoA, ["branch", "--list", branchName])).not.toBe("");

            // Restage from Repo A to Repo B, letting Repo A cleanup succeed, while injecting a
            // failure in bundle-URL signing BEFORE stagedImports is rewritten for Repo B!
            failNextAssetSign = true;
            const failedRestage = yield* Effect.result(
              svc.stageImport({
                transferId,
                manifest: prep.manifest,
                targetProjectId: projectBId,
              }),
            );
            expect(Result.isFailure(failedRestage)).toBe(true);
            if (Result.isFailure(failedRestage)) {
              expect(failedRestage.failure.code).toBe("internal");
            }
            // Repo A cleanup already succeeded on disk:
            expect(NodeFS.existsSync(ownershipA.worktreePath)).toBe(false);
            expect(NodeFS.existsSync(ownershipPath)).toBe(false);
            expect(git(repoA, ["branch", "--list", branchName])).toBe("");

            // Independently recreate the branch in Repo A after the failed restage!
            git(repoA, ["branch", branchName]);
            const recreatedSha = git(repoA, ["rev-parse", `refs/heads/${branchName}`]);

            // Now call destination abort: because in-memory stagedImports was synchronously cleared
            // when Repo A cleanup succeeded, abort MUST NOT delete the recreated branch in Repo A!
            yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(git(repoA, ["rev-parse", `refs/heads/${branchName}`])).toBe(recreatedSha);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "fails closed on repository identity check error or mismatch when repoRoot is redirected to Repo B, never deleting Repo B's same-named branch",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-repo-id-fail-closed-"),
        );
        try {
          const repoAReal = NodePath.join(tmpRoot, "repo-a-real");
          const repoBReal = NodePath.join(tmpRoot, "repo-b-real");
          const repoLink = NodePath.join(tmpRoot, "repo-link");
          initGitRepo(repoAReal);
          initGitRepo(repoBReal);
          NodeFS.writeFileSync(NodePath.join(repoBReal, "repo-b.txt"), "repo b unique\n");
          git(repoBReal, ["add", "-A"]);
          git(repoBReal, ["commit", "-m", "repo b unique"]);

          // Symlink repoLink initially points to Repo A.
          NodeFS.symlinkSync(repoAReal, repoLink);

          const sharedBranch = "feat/same-name-in-both";
          // Independent branch in Repo B that MUST NEVER be deleted!
          git(repoBReal, ["branch", sharedBranch]);
          const repoBBranchSha = git(repoBReal, ["rev-parse", `refs/heads/${sharedBranch}`]);

          const repoACommonDir = NodeFS.realpathSync(NodePath.join(repoAReal, ".git"));
          const dstProjectId = ProjectId.make("proj-repoid-dst");
          const transferId = SessionTransferId.make("xfer-repoid-redirect");

          let resolveMode: "normal" | "return-null" | "throw-error" = "normal";

          const layer = makeEndpointTestLayer({
            environmentId: "env-repoid-guard",
            environmentLabel: "Repo Identity Guard Env",
            projects: [{ id: dstProjectId, title: "Linked Repo", workspaceRoot: repoLink }],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onVcsRun: ({ input, next }) => {
                if (input.operation === "WorkspaceBundle.resolveGitCommonDir") {
                  if (resolveMode === "return-null") {
                    return Effect.succeed({
                      exitCode: 128 as VcsProcess.VcsProcessOutput["exitCode"],
                      stdout: "",
                      stderr: "fatal: simulated git rev-parse failure",
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    });
                  }
                  if (resolveMode === "throw-error") {
                    return Effect.fail(
                      new VcsProcessExitError({
                        operation: input.operation,
                        command: "git rev-parse --path-format=absolute --git-common-dir",
                        cwd: input.cwd,
                        exitCode: 128,
                        detail: "fatal: simulated git process error",
                      }),
                    );
                  }
                }
                return next;
              },
            },
          });

          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            // Persist an ownership record for Repo A (via repoLink) with worktreeCreated: true and
            // createdBranch: true for sharedBranch.
            const ownershipPath = resolveWorktreeOwnershipPath(config.stateDir, transferId, path)!;
            NodeFS.mkdirSync(NodePath.dirname(ownershipPath), { recursive: true });
            NodeFS.writeFileSync(
              ownershipPath,
              JSON.stringify({
                schemaVersion: 1,
                transferId,
                destinationProjectId: dstProjectId,
                projectWorkspaceRoot: repoLink,
                repoRoot: repoLink,
                gitCommonDir: repoACommonDir,
                gitCommonDirIdentity: readGitCommonDirIdentitySync(repoAReal),
                destinationThreadId: ThreadId.make("thread-repoid-dst"),
                worktreePath: NodePath.join(tmpRoot, "missing-wt-in-a"),
                branch: sharedBranch,
                branchHeadSha: repoBBranchSha,
                createdBranch: true,
                worktreeCreated: true,
                importCompleted: false,
              }),
            );

            // Redirect repoLink from Repo A -> Repo B!
            NodeFS.unlinkSync(repoLink);
            NodeFS.symlinkSync(repoBReal, repoLink);

            // Case 1a: git rev-parse --git-common-dir returns exit 128 (resolveGitCommonDir -> null)
            // while repoRoot exists on disk -> abort MUST fail closed (code: "internal") and leave
            // Repo B's branch AND ownership untouched!
            resolveMode = "return-null";
            const abortNull = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortNull)).toBe(true);
            if (Result.isFailure(abortNull)) {
              expect(abortNull.failure.code).toBe("internal");
            }
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            expect(git(repoBReal, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(
              repoBBranchSha,
            );

            // Case 1b: git rev-parse --git-common-dir fails with VcsProcessExitError -> abort MUST
            // fail closed (code: "internal") and leave Repo B's branch untouched!
            resolveMode = "throw-error";
            const abortErr = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortErr)).toBe(true);
            if (Result.isFailure(abortErr)) {
              expect(abortErr.failure.code).toBe("internal");
            }
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            expect(git(repoBReal, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(
              repoBBranchSha,
            );

            // Case 2: Non-error redirect case (resolvedCommonDir === repoBCommonDir !== repoACommonDir)
            // while Repo A still exists -> abort MUST fail closed (code: "workspace_error") and
            // leave Repo B's branch untouched!
            resolveMode = "normal";
            const abortMismatch = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortMismatch)).toBe(true);
            if (Result.isFailure(abortMismatch)) {
              expect(abortMismatch.failure.code).toBe("workspace_error");
            }
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            expect(git(repoBReal, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(
              repoBBranchSha,
            );

            // Case 3: Once original Repo A (gitCommonDir) is completely gone while repoLink still
            // points to Repo B, abort skips deletion in Repo B, clears stale ownership safely, and
            // leaves Repo B's branch completely untouched!
            NodeFS.rmSync(repoAReal, { recursive: true, force: true });
            const abortCleared = yield* svc.abort({
              transferId,
              role: "destination",
            });
            expect(abortCleared.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(ownershipPath)).toBe(false);
            expect(git(repoBReal, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(
              repoBBranchSha,
            );
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "does not re-realpath stored gitCommonDir when Repo A is moved away and replaced with a symlink to Repo B, leaving Repo B's same-named branch untouched on abort and restage",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-symlink-swap-repoid-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const repoA = NodePath.join(tmpRoot, "repo-a");
          const repoAMoved = NodePath.join(tmpRoot, "repo-a-moved");
          const repoB = NodePath.join(tmpRoot, "repo-b");

          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, repoA);
          initGitRepo(repoB);
          NodeFS.writeFileSync(NodePath.join(repoB, "repo-b-only.txt"), "repo b content\n");
          git(repoB, ["add", "-A"]);
          git(repoB, ["commit", "-m", "repo b unique commit"]);

          const sharedBranch = "feat/symlink-swap-branch";
          // Independent branch in Repo B that MUST NEVER be deleted!
          git(repoB, ["branch", sharedBranch]);
          const repoBBranchSha = git(repoB, ["rev-parse", `refs/heads/${sharedBranch}`]);

          git(srcRepo, ["checkout", "-b", sharedBranch]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "swap.ts"), "export const swap = 1;\n");
          git(srcRepo, ["add", "-A"]);
          git(srcRepo, ["commit", "-m", "source feature commit"]);

          const srcProjectId = ProjectId.make("proj-swap-src");
          const projectAId = ProjectId.make("proj-swap-a");
          const projectBId = ProjectId.make("proj-swap-b");
          const srcThreadId = ThreadId.make("thread-swap-src");
          const transferId = SessionTransferId.make("xfer-symlink-swap-a-to-b");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          };

          let failCommitEventWrite = false;
          const layer = makeEndpointTestLayer({
            environmentId: "env-symlink-swap",
            environmentLabel: "Symlink Swap Repo Identity Env",
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: projectAId, title: "Repo A", workspaceRoot: repoA },
              { id: projectBId, title: "Repo B", workspaceRoot: repoB },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onEventSinkWrite: (events) => {
                if (failCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                  failCommitEventWrite = false;
                  return Effect.fail(new TestHookError({ message: "simulated commit fail" }));
                }
                return Effect.void;
              },
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: sharedBranch,
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            const prep = yield* svc.prepareSource({
              transferId,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const stagedA = yield* svc.stageImport({
              transferId,
              manifest: prep.manifest,
              targetProjectId: projectAId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferId, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferId, path)!,
              resolveImportBundlePath(config.stateDir, transferId, path)!,
            );

            // Commit creates worktree + branch in Repo A (a real directory, not a symlink),
            // writes durable ownership recording canonical gitCommonDir = realpath(repoA/.git),
            // and fails on SQLite event write.
            failCommitEventWrite = true;
            const failedCommit = yield* Effect.result(
              svc.commitImport({
                transferId,
                destinationProjectId: stagedA.destinationProjectId,
                destinationThreadId: stagedA.destinationThreadId,
                manifest: prep.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(failedCommit)).toBe(true);

            const ownershipPath = resolveWorktreeOwnershipPath(config.stateDir, transferId, path)!;
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            const ownership = JSON.parse(NodeFS.readFileSync(ownershipPath, "utf8")) as {
              readonly repoRoot: string;
              readonly gitCommonDir: string;
              readonly worktreePath: string;
              readonly branch: string;
              readonly worktreeCreated: boolean;
            };
            expect(ownership.repoRoot).toBe(repoA);
            expect(ownership.gitCommonDir).toBe(NodeFS.realpathSync(NodePath.join(repoA, ".git")));
            expect(ownership.branch).toBe(sharedBranch);
            expect(ownership.worktreeCreated).toBe(true);

            // Move Repo A away and replace Repo A's original path with a symlink to Repo B!
            // Also remove the orphaned worktree dir so only the branch deletion path would run if
            // the identity check were bypassed.
            NodeFS.rmSync(ownership.worktreePath, { recursive: true, force: true });
            NodeFS.renameSync(repoA, repoAMoved);
            NodeFS.symlinkSync(repoB, repoA);

            // Abort MUST detect mismatch between freshly resolved realpath(repoB/.git) and stored
            // literal gitCommonDir (repoA/.git), fail closed, and leave Repo B's branch untouched!
            const abortRes = yield* Effect.result(
              svc.abort({
                transferId,
                role: "destination",
              }),
            );
            expect(Result.isFailure(abortRes)).toBe(true);
            if (Result.isFailure(abortRes)) {
              expect(abortRes.failure.code).toBe("workspace_error");
            }
            expect(NodeFS.existsSync(ownershipPath)).toBe(true);
            expect(git(repoB, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(repoBBranchSha);

            // Restaging against Repo B MUST NOT treat stored gitCommonDir as matching Repo B via
            // re-realpath, and must fail closed without touching Repo B's branch!
            const restageRes = yield* Effect.result(
              svc.stageImport({
                transferId,
                manifest: prep.manifest,
                targetProjectId: projectBId,
              }),
            );
            expect(Result.isFailure(restageRes)).toBe(true);
            if (Result.isFailure(restageRes)) {
              expect(restageRes.failure.code).toBe("workspace_error");
            }
            expect(git(repoB, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(repoBBranchSha);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "fails closed on abort when persisted ownership JSON is missing gitCommonDir, has null gitCommonDir, or has blank gitCommonDir, never deleting an independent branch",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-missing-gitcommondir-"),
        );
        try {
          const dstRepo = NodePath.join(tmpRoot, "dst-repo");
          initGitRepo(dstRepo);

          const protectedBranch = "feat/independent-protected-branch";
          git(dstRepo, ["branch", protectedBranch]);
          const protectedBranchSha = git(dstRepo, ["rev-parse", `refs/heads/${protectedBranch}`]);

          const dstProjectId = ProjectId.make("proj-missing-gcd-dst");
          const layer = makeEndpointTestLayer({
            environmentId: "env-missing-gcd",
            environmentLabel: "Missing gitCommonDir Guard Env",
            projects: [{ id: dstProjectId, title: "dst", workspaceRoot: dstRepo }],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
          });

          yield* Effect.gen(function* () {
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            const validCommonDir = NodeFS.realpathSync(NodePath.join(dstRepo, ".git"));
            const validIdentity = readGitCommonDirIdentitySync(dstRepo);
            const variants: ReadonlyArray<{
              readonly label: string;
              readonly transferId: SessionTransferId;
              readonly extraFields: Record<string, unknown>;
            }> = [
              {
                label: "omitted",
                transferId: SessionTransferId.make("xfer-missing-gcd-omitted"),
                extraFields: { gitCommonDirIdentity: validIdentity },
              },
              {
                label: "null",
                transferId: SessionTransferId.make("xfer-missing-gcd-null"),
                extraFields: { gitCommonDir: null, gitCommonDirIdentity: validIdentity },
              },
              {
                label: "empty",
                transferId: SessionTransferId.make("xfer-missing-gcd-empty"),
                extraFields: { gitCommonDir: "", gitCommonDirIdentity: validIdentity },
              },
              {
                label: "whitespace",
                transferId: SessionTransferId.make("xfer-missing-gcd-whitespace"),
                extraFields: { gitCommonDir: "   ", gitCommonDirIdentity: validIdentity },
              },
              {
                label: "missing-identity",
                transferId: SessionTransferId.make("xfer-missing-gcd-identity"),
                extraFields: { gitCommonDir: validCommonDir },
              },
              {
                label: "blank-identity-inode",
                transferId: SessionTransferId.make("xfer-blank-gcd-identity-inode"),
                extraFields: {
                  gitCommonDir: validCommonDir,
                  gitCommonDirIdentity: { ...validIdentity, inode: "  " },
                },
              },
            ];

            for (const variant of variants) {
              const ownershipPath = resolveWorktreeOwnershipPath(
                config.stateDir,
                variant.transferId,
                path,
              )!;
              NodeFS.mkdirSync(NodePath.dirname(ownershipPath), { recursive: true });
              NodeFS.writeFileSync(
                ownershipPath,
                JSON.stringify({
                  schemaVersion: 1,
                  transferId: variant.transferId,
                  destinationProjectId: dstProjectId,
                  projectWorkspaceRoot: dstRepo,
                  repoRoot: dstRepo,
                  destinationThreadId: ThreadId.make(`thread-missing-gcd-${variant.label}`),
                  worktreePath: NodePath.join(tmpRoot, `nonexistent-wt-${variant.label}`),
                  branch: protectedBranch,
                  branchHeadSha: protectedBranchSha,
                  createdBranch: true,
                  worktreeCreated: true,
                  importCompleted: false,
                  ...variant.extraFields,
                }),
              );

              const abortRes = yield* Effect.result(
                svc.abort({
                  transferId: variant.transferId,
                  role: "destination",
                }),
              );
              expect(Result.isFailure(abortRes)).toBe(true);
              if (Result.isFailure(abortRes)) {
                expect(abortRes.failure.code).toBe("internal");
              }
              expect(NodeFS.existsSync(ownershipPath)).toBe(true);
              expect(git(dstRepo, ["rev-parse", `refs/heads/${protectedBranch}`])).toBe(
                protectedBranchSha,
              );
            }
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "never deletes a same-named branch in a replacement repository re-cloned or re-initialized at the exact same path (same SHA or different SHA) or a branch whose tip moved",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-xfer-reclone-same-path-"),
        );
        try {
          const srcRepo = NodePath.join(tmpRoot, "src-repo");
          const repoSamePath = NodePath.join(tmpRoot, "dst-repo");
          const sharedBranch = "feat/reclone-same-path-branch";

          initGitRepo(srcRepo);
          cloneGitRepo(srcRepo, repoSamePath);

          git(srcRepo, ["checkout", "-b", sharedBranch]);
          NodeFS.writeFileSync(NodePath.join(srcRepo, "feature.ts"), "export const f = 1;\n");
          git(srcRepo, ["add", "-A"]);
          git(srcRepo, ["commit", "-m", "feature commit"]);
          const featureCommitSha = git(srcRepo, ["rev-parse", "HEAD"]);

          const srcProjectId = ProjectId.make("proj-reclone-src");
          const dstProjectId = ProjectId.make("proj-reclone-dst");
          const srcThreadId = ThreadId.make("thread-reclone-src");
          const modelSelection: ModelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          };

          let failCommitEventWrite = false;
          const layer = makeEndpointTestLayer({
            environmentId: "env-reclone-same-path",
            environmentLabel: "Reclone Same Path Env",
            projects: [
              { id: srcProjectId, title: "src", workspaceRoot: srcRepo },
              { id: dstProjectId, title: "dst", workspaceRoot: repoSamePath },
            ],
            providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex" }],
            recorder: { dispatches: [], forceStops: [], detachedSessions: [], sentMessages: [] },
            hooks: {
              onEventSinkWrite: (events) => {
                if (failCommitEventWrite && events.some((e) => e.type === "thread.created")) {
                  failCommitEventWrite = false;
                  return Effect.fail(new TestHookError({ message: "simulated commit fail" }));
                }
                return Effect.void;
              },
            },
          });

          yield* Effect.gen(function* () {
            const eventSink = yield* EventSink.EventSinkV2;
            const svc = yield* SessionTransferEndpointService.SessionTransferEndpointService;
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;

            yield* eventSink.write({
              events: seedThreadEvents({
                projectId: srcProjectId,
                threadId: srcThreadId,
                branch: sharedBranch,
                worktreePath: srcRepo,
                modelSelection,
                running: false,
              }),
            });

            // Scenario 1: Re-clone from the SAME origin at the EXACT SAME PATH with the EXACT SAME
            // commit SHA on the same-named branch!
            const transferReclone = SessionTransferId.make("xfer-reclone-same-sha");
            const prep1 = yield* svc.prepareSource({
              transferId: transferReclone,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const staged1 = yield* svc.stageImport({
              transferId: transferReclone,
              manifest: prep1.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferReclone, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferReclone, path)!,
              resolveImportBundlePath(config.stateDir, transferReclone, path)!,
            );

            failCommitEventWrite = true;
            const commitFail1 = yield* Effect.result(
              svc.commitImport({
                transferId: transferReclone,
                destinationProjectId: staged1.destinationProjectId,
                destinationThreadId: staged1.destinationThreadId,
                manifest: prep1.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitFail1)).toBe(true);

            const ownershipPath1 = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferReclone,
              path,
            )!;
            expect(NodeFS.existsSync(ownershipPath1)).toBe(true);
            const ownership1 = JSON.parse(NodeFS.readFileSync(ownershipPath1, "utf8")) as {
              readonly gitCommonDir: string;
              readonly gitCommonDirIdentity: WorkspaceBundle.GitCommonDirIdentity;
              readonly worktreePath: string;
              readonly branch: string;
              readonly branchHeadSha: string | null;
              readonly worktreeCreated: boolean;
            };
            expect(ownership1.worktreeCreated).toBe(true);
            expect(ownership1.branch).toBe(sharedBranch);
            expect(ownership1.branchHeadSha).toBe(featureCommitSha);

            // Remove the worktree so registration is absent, rm -rf Repo A, and re-clone Repo B
            // from srcRepo at the EXACT SAME PATH with the same-named branch at the EXACT SAME SHA!
            NodeFS.rmSync(ownership1.worktreePath, { recursive: true, force: true });
            NodeFS.rmSync(repoSamePath, { recursive: true, force: true });
            cloneGitRepo(srcRepo, repoSamePath);
            git(repoSamePath, ["checkout", "-B", "main", "origin/main"]);
            git(repoSamePath, ["branch", "-f", sharedBranch, featureCommitSha]);
            expect(NodeFS.realpathSync(NodePath.join(repoSamePath, ".git"))).toBe(
              ownership1.gitCommonDir,
            );
            expect(git(repoSamePath, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(
              featureCommitSha,
            );

            // Destination abort MUST detect gitCommonDirIdentity mismatch, NOT delete the
            // replacement clone's branch, and cleanly clear the stale ownership record!
            const abortReclone = yield* svc.abort({
              transferId: transferReclone,
              role: "destination",
            });
            expect(abortReclone.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(ownershipPath1)).toBe(false);
            expect(git(repoSamePath, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(
              featureCommitSha,
            );
            yield* svc.abort({
              transferId: transferReclone,
              role: "source",
            });

            // Scenario 2: Fresh re-init repository at the EXACT SAME PATH with a DIFFERENT commit SHA.
            // First reset repoSamePath to a clean clone of main so commitImport creates sharedBranch.
            NodeFS.rmSync(repoSamePath, { recursive: true, force: true });
            cloneGitRepo(srcRepo, repoSamePath);
            git(repoSamePath, ["checkout", "-B", "main", "origin/main"]);
            git(repoSamePath, ["branch", "-D", sharedBranch]);

            const transferFreshInit = SessionTransferId.make("xfer-reinit-diff-sha");
            const prep2 = yield* svc.prepareSource({
              transferId: transferFreshInit,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const staged2 = yield* svc.stageImport({
              transferId: transferFreshInit,
              manifest: prep2.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(resolveImportBundlePath(config.stateDir, transferFreshInit, path)!),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferFreshInit, path)!,
              resolveImportBundlePath(config.stateDir, transferFreshInit, path)!,
            );

            failCommitEventWrite = true;
            const commitFail2 = yield* Effect.result(
              svc.commitImport({
                transferId: transferFreshInit,
                destinationProjectId: staged2.destinationProjectId,
                destinationThreadId: staged2.destinationThreadId,
                manifest: prep2.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitFail2)).toBe(true);

            const ownershipPath2 = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferFreshInit,
              path,
            )!;
            const ownership2 = JSON.parse(NodeFS.readFileSync(ownershipPath2, "utf8")) as {
              readonly gitCommonDir: string;
              readonly worktreePath: string;
              readonly branchHeadSha: string | null;
            };
            expect(ownership2.branchHeadSha).toBe(featureCommitSha);

            NodeFS.rmSync(ownership2.worktreePath, { recursive: true, force: true });
            NodeFS.rmSync(repoSamePath, { recursive: true, force: true });
            initGitRepo(repoSamePath);
            NodeFS.writeFileSync(NodePath.join(repoSamePath, "replacement.txt"), "brand new\n");
            git(repoSamePath, ["add", "-A"]);
            git(repoSamePath, ["commit", "-m", "brand new repo commit"]);
            git(repoSamePath, ["branch", sharedBranch]);
            const freshRepoBranchSha = git(repoSamePath, [
              "rev-parse",
              `refs/heads/${sharedBranch}`,
            ]);
            expect(freshRepoBranchSha).not.toBe(featureCommitSha);
            expect(NodeFS.realpathSync(NodePath.join(repoSamePath, ".git"))).toBe(
              ownership2.gitCommonDir,
            );

            const abortFreshInit = yield* svc.abort({
              transferId: transferFreshInit,
              role: "destination",
            });
            expect(abortFreshInit.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(ownershipPath2)).toBe(false);
            expect(git(repoSamePath, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(
              freshRepoBranchSha,
            );
            yield* svc.abort({
              transferId: transferFreshInit,
              role: "source",
            });

            // Scenario 3 (CAS layer in SAME repo): Even in the exact same repository (matching
            // gitCommonDir + gitCommonDirIdentity), if the worktree was removed and someone moved
            // the branch to a DIFFERENT commit SHA, atomic CAS refuses to delete the moved branch
            // and safely clears stale ownership.
            NodeFS.rmSync(repoSamePath, { recursive: true, force: true });
            cloneGitRepo(srcRepo, repoSamePath);
            git(repoSamePath, ["checkout", "-B", "main", "origin/main"]);
            git(repoSamePath, ["branch", "-D", sharedBranch]);

            const transferMovedBranch = SessionTransferId.make("xfer-cas-moved-branch");
            const prep3 = yield* svc.prepareSource({
              transferId: transferMovedBranch,
              threadId: srcThreadId,
              direction: "boat_to_local",
            });
            const staged3 = yield* svc.stageImport({
              transferId: transferMovedBranch,
              manifest: prep3.manifest,
              targetProjectId: dstProjectId,
            });
            NodeFS.mkdirSync(
              NodePath.dirname(
                resolveImportBundlePath(config.stateDir, transferMovedBranch, path)!,
              ),
              { recursive: true },
            );
            NodeFS.copyFileSync(
              resolveExportBundlePath(config.stateDir, transferMovedBranch, path)!,
              resolveImportBundlePath(config.stateDir, transferMovedBranch, path)!,
            );

            failCommitEventWrite = true;
            const commitFail3 = yield* Effect.result(
              svc.commitImport({
                transferId: transferMovedBranch,
                destinationProjectId: staged3.destinationProjectId,
                destinationThreadId: staged3.destinationThreadId,
                manifest: prep3.manifest,
                autoResume: false,
              }),
            );
            expect(Result.isFailure(commitFail3)).toBe(true);

            const ownershipPath3 = resolveWorktreeOwnershipPath(
              config.stateDir,
              transferMovedBranch,
              path,
            )!;
            const ownership3 = JSON.parse(NodeFS.readFileSync(ownershipPath3, "utf8")) as {
              readonly worktreePath: string;
              readonly branchHeadSha: string | null;
            };
            expect(ownership3.branchHeadSha).toBe(featureCommitSha);

            // Remove the worktree cleanly, then move the same-named branch to a new commit SHA.
            git(repoSamePath, ["worktree", "remove", "--force", ownership3.worktreePath]);
            NodeFS.writeFileSync(NodePath.join(repoSamePath, "moved.txt"), "user commit\n");
            git(repoSamePath, ["add", "-A"]);
            git(repoSamePath, ["commit", "-m", "independent user commit"]);
            const movedSha = git(repoSamePath, ["rev-parse", "HEAD"]);
            git(repoSamePath, ["branch", "-f", sharedBranch, movedSha]);
            expect(movedSha).not.toBe(featureCommitSha);

            const abortMoved = yield* svc.abort({
              transferId: transferMovedBranch,
              role: "destination",
            });
            expect(abortMoved.cleanedUp).toBe(true);
            expect(NodeFS.existsSync(ownershipPath3)).toBe(false);
            expect(git(repoSamePath, ["rev-parse", `refs/heads/${sharedBranch}`])).toBe(movedSha);
          }).pipe(Effect.provide(layer));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );
});

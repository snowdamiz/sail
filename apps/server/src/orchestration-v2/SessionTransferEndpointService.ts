// @effect-diagnostics nodeBuiltinImport:off -- streaming sha256 checksum for exported attachments avoids loading whole files in memory.
import * as NodeCrypto from "node:crypto";
import {
  type AttachmentCreateUploadUrlInput,
  type ChatAttachment,
  ChatAttachmentId,
  CommandId,
  ContextHandoffId,
  EventId,
  GitRefName,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  PlanId,
  ProviderThreadId,
  RunId,
  type SessionTransferAbortInput,
  type SessionTransferAbortResult,
  type SessionTransferAttachmentRef,
  type SessionTransferAttachmentUploadTarget,
  type SessionTransferCommitImportInput,
  type SessionTransferCommitImportResult,
  SessionTransferError,
  type SessionTransferFinalizeSourceInput,
  type SessionTransferFinalizeSourceResult,
  type SessionTransferId,
  type SessionTransferManifest,
  type SessionTransferPendingRuntimeRequest,
  type SessionTransferPrepareSourceInput,
  type SessionTransferPrepareSourceResult,
  type SessionTransferQueuedRun,
  type SessionTransferStageImportInput,
  type SessionTransferStageImportResult,
  type SessionTransferThreadOrigin,
  type SessionTransferWorkspaceSpec,
  ThreadId,
  TurnItemId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as AssetSigner from "../assets/AssetSigner.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "../assets/AttachmentUpload.ts";
import {
  cleanupTransferStagingDir,
  issueSessionTransferAttachmentDownloadUrl,
  issueSessionTransferBundleUrl,
  resolveExportBundlePath,
  resolveImportBundlePath,
  resolveTransferStagingDir,
  sanitizeTransferSegment,
} from "../assets/SessionTransferToken.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as WorkspaceBundle from "../vcs/WorkspaceBundle.ts";
import { claimPendingAttachments } from "./AttachmentClaims.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const SOURCE_SETTLE_TIMEOUT_MS = 15_000;
const SETUP_HOOK_TIMEOUT_MS = 60_000;

type GitRefNameValue = typeof GitRefName.Type;
type TrimmedNonEmptyStringValue = typeof TrimmedNonEmptyString.Type;

const UPLOADABLE_IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const WORKING_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const ACTIVE_SUBAGENT_STATUSES = new Set(["pending", "running", "waiting"]);

interface StagedImportState {
  readonly transferId: SessionTransferId;
  readonly destinationProjectId: SessionTransferStageImportResult["destinationProjectId"];
  readonly projectWorkspaceRoot: string;
  readonly destinationThreadId: ThreadId;
  readonly resolvedModelSelection: ModelSelection;
  readonly attachmentUploads: ReadonlyArray<SessionTransferAttachmentUploadTarget>;
  readonly warnings: ReadonlyArray<string>;
  readonly worktreePath: string | null;
  readonly branch: GitRefNameValue | null;
  readonly committed: boolean;
  readonly committedResult: SessionTransferCommitImportResult | null;
}

export interface SessionTransferEndpointServiceShape {
  readonly prepareSource: (
    input: SessionTransferPrepareSourceInput,
  ) => Effect.Effect<SessionTransferPrepareSourceResult, SessionTransferError>;
  readonly stageImport: (
    input: SessionTransferStageImportInput,
  ) => Effect.Effect<SessionTransferStageImportResult, SessionTransferError>;
  readonly commitImport: (
    input: SessionTransferCommitImportInput,
  ) => Effect.Effect<SessionTransferCommitImportResult, SessionTransferError>;
  readonly finalizeSource: (
    input: SessionTransferFinalizeSourceInput,
  ) => Effect.Effect<SessionTransferFinalizeSourceResult, SessionTransferError>;
  readonly abort: (
    input: SessionTransferAbortInput,
  ) => Effect.Effect<SessionTransferAbortResult, SessionTransferError>;
}

export class SessionTransferEndpointService extends Context.Service<
  SessionTransferEndpointService,
  SessionTransferEndpointServiceShape
>()("t3/orchestration-v2/SessionTransferEndpointService") {}

function toIsoDateTime(value: DateTime.Utc): IsoDateTime {
  return IsoDateTime.make(DateTime.formatIso(value));
}

function deterministicDestinationThreadId(transferId: SessionTransferId): ThreadId {
  const segment = sanitizeTransferSegment(transferId) ?? "transfer";
  return ThreadId.make(`xfer-${segment}`);
}

function buildAttachmentUploadInput(
  attachment: SessionTransferAttachmentRef,
): AttachmentCreateUploadUrlInput | null {
  if (attachment.type === "file") {
    return {
      type: "file",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  }
  if (attachment.type === "image") {
    if (UPLOADABLE_IMAGE_MIMES.has(attachment.mimeType)) {
      return {
        type: "image",
        name: attachment.name,
        mimeType: attachment.mimeType as "image/gif" | "image/jpeg" | "image/png" | "image/webp",
        sizeBytes: attachment.sizeBytes,
      };
    }
    return {
      type: "file",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  }
  return null;
}

function collectThreadAttachments(input: {
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly heldQueuedRuns: ReadonlyArray<SessionTransferQueuedRun>;
}): ReadonlyArray<ChatAttachment> {
  const byId = new Map<ChatAttachmentId, ChatAttachment>();
  for (const message of input.messages) {
    for (const attachment of message.attachments) {
      if (!byId.has(attachment.id)) {
        byId.set(attachment.id, attachment);
      }
    }
  }
  for (const item of input.turnItems) {
    if (item.type === "user_message") {
      for (const attachment of item.attachments) {
        if (!byId.has(attachment.id)) {
          byId.set(attachment.id, attachment);
        }
      }
    }
  }
  for (const run of input.heldQueuedRuns) {
    for (const attachment of run.attachments) {
      if (!byId.has(attachment.id)) {
        byId.set(attachment.id, attachment);
      }
    }
  }
  return [...byId.values()];
}

function rewriteAttachments(
  attachments: ReadonlyArray<ChatAttachment>,
  idMap: ReadonlyMap<ChatAttachmentId, ChatAttachmentId>,
): ReadonlyArray<ChatAttachment> {
  if (attachments.length === 0 || idMap.size === 0) return attachments;
  return attachments.map((attachment) => {
    const mappedId = idMap.get(attachment.id);
    return mappedId === undefined ? attachment : { ...attachment, id: mappedId };
  });
}

function buildHandoffSummaryFromProjection(
  projection: OrchestrationV2ThreadProjection,
): string | null {
  const latestReadyHandoff = projection.contextHandoffs.findLast(
    (handoff) => handoff.status === "ready" && handoff.summaryText.trim().length > 0,
  );
  if (latestReadyHandoff !== undefined) {
    return latestReadyHandoff.summaryText;
  }

  const lines: string[] = [];
  const recentMessages = projection.messages.slice(-12);
  for (const message of recentMessages) {
    const trimmed = message.text.trim();
    if (!trimmed) continue;
    const compact = trimmed.replace(/\s+/g, " ").slice(0, 300);
    lines.push(`${message.role}: ${compact}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function buildTransferContextNote(input: {
  readonly manifest: SessionTransferManifest;
  readonly destinationBranch: GitRefNameValue | null;
}): string {
  const sourceLabel = input.manifest.sourceEnvironmentName ?? input.manifest.sourceEnvironmentId;
  const parts: string[] = [
    `[Session Transfer Context]`,
    `This session was transferred (${input.manifest.direction}) from ${sourceLabel} (source thread ${input.manifest.sourceThreadId}).`,
  ];

  if (input.destinationBranch !== null) {
    parts.push(`Destination git branch: ${input.destinationBranch}.`);
  }

  if (input.manifest.workspace.isGitRepo) {
    const dirtyBits: string[] = [];
    if (input.manifest.workspace.hasStagedChanges) dirtyBits.push("staged changes");
    if (input.manifest.workspace.hasUnstagedChanges) dirtyBits.push("unstaged edits");
    if (input.manifest.workspace.hasUntrackedFiles) dirtyBits.push("untracked files");
    if (dirtyBits.length > 0) {
      parts.push(`Workspace state restored losslessly including ${dirtyBits.join(", ")}.`);
    }
  }

  if (input.manifest.sourceState.hadPendingRuntimeRequest) {
    const requestList = input.manifest.sourceState.pendingRuntimeRequests
      .map((req) => `- ${req.kind}${req.summary ? `: ${req.summary}` : ""} (id: ${req.id})`)
      .join("\n");
    parts.push(
      `The source session had pending approval/user-input request(s) when transferred and was intentionally paused:\n${requestList}\nDo not assume approval was granted; wait for explicit user confirmation before executing privileged actions.`,
    );
  } else if (input.manifest.sourceState.wasRunning) {
    parts.push(
      `The previous run on the source environment was paused mid-execution for this transfer. Inspect the current workspace and conversation history, then continue cleanly from where work left off without repeating completed steps.`,
    );
  }

  if (input.manifest.handoffSummary) {
    parts.push(`\nPrior thread summary:\n${input.manifest.handoffSummary}`);
  }

  return parts.join("\n");
}

function buildAutoResumePrompt(manifest: SessionTransferManifest): string {
  const sourceLabel = manifest.sourceEnvironmentName ?? manifest.sourceEnvironmentId;
  return [
    `Session transferred from ${sourceLabel}.`,
    `The previous turn was interrupted so this session could move to the new environment with its full workspace state intact.`,
    `Inspect the current repository state and recent conversation context, then continue the interrupted task from where it left off.`,
  ].join(" ");
}

function summarizeRuntimeRequest(
  request: OrchestrationV2ThreadProjection["runtimeRequests"][number],
): string | null {
  if (request.feedback && request.feedback.trim().length > 0) {
    return request.feedback.trim();
  }
  return `${request.kind} request`;
}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const serverEnvironmentOption = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const eventSink = yield* EventSink.EventSinkV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const projectService = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const providerAdapterRegistry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const providerInstanceRegistryOption = yield* Effect.serviceOption(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
  );
  const setupScriptRunnerOption = yield* Effect.serviceOption(
    ProjectSetupScriptRunner.ProjectSetupScriptRunner,
  );
  const workspaceBundle = yield* WorkspaceBundle.WorkspaceBundle;
  const assetSigner = yield* AssetSigner.AssetSigner;
  const documentText = yield* DocumentText.DocumentText;
  const secureRandom = yield* SecureRandom.SecureRandom;

  const sourceLocks = yield* Ref.make(new Map<ThreadId, SessionTransferId>());
  const preparedSources = yield* Ref.make(
    new Map<SessionTransferId, SessionTransferPrepareSourceResult>(),
  );
  const stagedImports = yield* Ref.make(new Map<SessionTransferId, StagedImportState>());

  const runWithAssetContext = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | ServerConfig.ServerConfig
      | FileSystem.FileSystem
      | Path.Path
      | AssetSigner.AssetSigner
      | DocumentText.DocumentText
      | SecureRandom.SecureRandom
    >,
  ) =>
    effect.pipe(
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(AssetSigner.AssetSigner, assetSigner),
      Effect.provideService(DocumentText.DocumentText, documentText),
      Effect.provideService(SecureRandom.SecureRandom, secureRandom),
    );

  const isThreadSettled = (threadId: ThreadId) =>
    projectionStore.getThreadRecords(threadId, ["runs", "attempts", "providerTurns"]).pipe(
      Effect.map(
        ({ runs, attempts, providerTurns }) =>
          !runs.some((run) => WORKING_RUN_STATUSES.has(run.status)) &&
          !attempts.some(
            (attempt) => attempt.status === "pending" || attempt.status === "running",
          ) &&
          !providerTurns.some((turn) => turn.status === "running"),
      ),
      Effect.orElseSucceed(() => true),
    );

  const awaitThreadSettled = Effect.fn("SessionTransferEndpointService.awaitThreadSettled")(
    function* (threadId: ThreadId, timeoutMs: number) {
      const afterSequence = yield* eventSink
        .latestSequence({ threadId })
        .pipe(Effect.orElseSucceed(() => 0));
      if (yield* isThreadSettled(threadId)) return true;

      const settled = yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" ||
            event.type === "run-attempt.updated" ||
            event.type === "provider-turn.updated",
        ),
        Stream.mapEffect(() => isThreadSettled(threadId)),
        Stream.takeUntil((done) => done),
        Stream.runDrain,
        Effect.as(true),
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.orElseSucceed(() => Option.none<boolean>()),
      );
      if (Option.isSome(settled)) return true;
      return yield* isThreadSettled(threadId);
    },
  );

  const sha256FileOptional = (filePath: string) =>
    fileSystem.stream(filePath).pipe(
      Stream.runFold(
        () => NodeCrypto.createHash("sha256"),
        (hash, chunk) => hash.update(chunk),
      ),
      Effect.map((hash) => hash.digest("hex")),
      Effect.orElseSucceed(() => null),
    );

  const resolveDestinationModelSelection = Effect.fn(
    "SessionTransferEndpointService.resolveDestinationModelSelection",
  )(function* (input: {
    readonly transferId: SessionTransferId;
    readonly manifest: SessionTransferManifest;
    readonly override?: ModelSelection;
  }) {
    const warnings: string[] = [];
    const availableIds = yield* providerAdapterRegistry.list();

    const getInstanceMetadata = (instanceId: ModelSelection["instanceId"]) =>
      providerAdapterRegistry.getMetadata !== undefined
        ? providerAdapterRegistry.getMetadata(instanceId).pipe(Effect.orElseSucceed(() => null))
        : providerAdapterRegistry.get(instanceId).pipe(
            Effect.map((adapter) => ({
              driver: adapter.driver,
              continuationKey: String(instanceId),
              enabled: true,
              capabilities: undefined,
            })),
            Effect.orElseSucceed(() => null),
          );

    const checkModelInSnapshot = (
      instanceId: ModelSelection["instanceId"],
      model: string,
    ): Effect.Effect<boolean | null> =>
      Option.match(providerInstanceRegistryOption, {
        onNone: () => Effect.succeed(null),
        onSome: (registry) =>
          registry.getInstance(instanceId).pipe(
            Effect.flatMap((instance) =>
              instance === undefined
                ? Effect.succeed(null)
                : instance.snapshot.getSnapshot.pipe(
                    Effect.map((snapshot) =>
                      snapshot.models.length === 0
                        ? true
                        : snapshot.models.some((m) => m.slug === model),
                    ),
                    Effect.orElseSucceed(() => null),
                  ),
            ),
          ),
      });

    if (input.override !== undefined) {
      const meta = yield* getInstanceMetadata(input.override.instanceId);
      if (meta === null || !meta.enabled) {
        return yield* new SessionTransferError({
          code: "target_unavailable",
          transferId: input.transferId,
          message: `Selected override provider instance '${input.override.instanceId}' is not available or enabled on destination.`,
        });
      }
      return { resolvedModelSelection: input.override, warnings };
    }

    const desired = input.manifest.modelSelection;
    const exactMeta = yield* getInstanceMetadata(desired.instanceId);
    if (exactMeta !== null && exactMeta.enabled) {
      const modelSupported = yield* checkModelInSnapshot(desired.instanceId, desired.model);
      if (modelSupported === false) {
        warnings.push(
          `Model '${desired.model}' is not in the advertised model list for '${desired.instanceId}' on destination; proceeding with requested selection.`,
        );
      }
      return { resolvedModelSelection: desired, warnings };
    }

    // Fallback to an enabled provider instance with the same driver kind.
    const desiredDriver = input.manifest.providerDriverKind ?? String(desired.instanceId);
    for (const candidateId of availableIds) {
      const candidateMeta = yield* getInstanceMetadata(candidateId);
      if (candidateMeta === null || !candidateMeta.enabled) continue;
      if (candidateMeta.driver === desiredDriver) {
        warnings.push(
          `Provider instance '${desired.instanceId}' is unavailable on destination; mapped to compatible '${candidateId}' (${desiredDriver}).`,
        );
        return {
          resolvedModelSelection: {
            ...desired,
            instanceId: candidateId,
          } satisfies ModelSelection,
          warnings,
        };
      }
    }

    return yield* new SessionTransferError({
      code: "target_unavailable",
      transferId: input.transferId,
      message: `Provider '${desired.instanceId}' (${desiredDriver}, model '${desired.model}') is unavailable on destination. Provide modelSelectionOverride to select an available provider.`,
    });
  });

  const prepareSource: SessionTransferEndpointServiceShape["prepareSource"] = Effect.fn(
    "SessionTransferEndpointService.prepareSource",
  )(function* (input) {
    // Idempotent retry check for same transferId.
    const existingPrepared = (yield* Ref.get(preparedSources)).get(input.transferId);
    if (
      existingPrepared !== undefined &&
      existingPrepared.manifest.sourceThreadId === input.threadId
    ) {
      if (existingPrepared.manifest.workspace.mode === "git_bundle") {
        const exportPath = resolveExportBundlePath(serverConfig.stateDir, input.transferId, path);
        const exists =
          exportPath !== null &&
          (yield* fileSystem.exists(exportPath).pipe(Effect.orElseSucceed(() => false)));
        if (exists) {
          const freshUrl = yield* runWithAssetContext(
            issueSessionTransferBundleUrl({
              transferId: input.transferId,
              operation: "download",
              ...(existingPrepared.manifest.workspace.bundleSizeBytes !== null
                ? { maxBytes: existingPrepared.manifest.workspace.bundleSizeBytes }
                : {}),
              ...(existingPrepared.manifest.workspace.bundleSha256 !== null
                ? { expectedSha256: existingPrepared.manifest.workspace.bundleSha256 }
                : {}),
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new SessionTransferError({
                  code: "internal",
                  transferId: input.transferId,
                  message: cause.message,
                  cause,
                }),
            ),
          );
          const refreshed: SessionTransferPrepareSourceResult = {
            ...existingPrepared,
            bundleDownloadRelativeUrl: TrimmedNonEmptyString.make(freshUrl.relativeUrl),
            bundleExpiresAt: freshUrl.expiresAt,
          };
          yield* Ref.update(preparedSources, (map) => {
            const next = new Map(map);
            next.set(input.transferId, refreshed);
            return next;
          });
          return refreshed;
        }
      } else {
        return existingPrepared;
      }
    }

    // Atomically acquire per-thread transfer lock.
    const lockAcquired = yield* Ref.modify(sourceLocks, (current) => {
      const holder = current.get(input.threadId);
      if (holder !== undefined && holder !== input.transferId) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.set(input.threadId, input.transferId);
      return [true, next] as const;
    });
    if (!lockAcquired) {
      return yield* new SessionTransferError({
        code: "already_in_flight",
        transferId: input.transferId,
        message: `Thread '${input.threadId}' already has an in-flight session transfer.`,
      });
    }

    const releaseSourceLock = Ref.update(sourceLocks, (current) => {
      if (current.get(input.threadId) !== input.transferId) return current;
      const next = new Map(current);
      next.delete(input.threadId);
      return next;
    });

    return yield* Effect.gen(function* () {
      let projection = yield* projectionStore.getThreadProjection(input.threadId).pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProjectionStoreThreadNotFoundError"
            ? new SessionTransferError({
                code: "not_found",
                transferId: input.transferId,
                message: `Source thread '${input.threadId}' was not found.`,
                cause,
              })
            : new SessionTransferError({
                code: "internal",
                transferId: input.transferId,
                message: `Failed to read source thread '${input.threadId}': ${cause.message}`,
                cause,
              }),
        ),
      );

      if (projection.thread.deletedAt !== null) {
        return yield* new SessionTransferError({
          code: "not_found",
          transferId: input.transferId,
          message: `Source thread '${input.threadId}' has been deleted.`,
        });
      }

      const wasRunning =
        projection.runs.some((run) => WORKING_RUN_STATUSES.has(run.status)) ||
        projection.providerTurns.some((turn) => turn.status === "running");
      const openRuntimeRequests = projection.runtimeRequests.filter(
        (req) => req.status === "pending",
      );
      const hadPendingRuntimeRequest = openRuntimeRequests.length > 0;
      const pendingRuntimeRequests: ReadonlyArray<SessionTransferPendingRuntimeRequest> =
        openRuntimeRequests.map((req) => ({
          id: req.id,
          kind: req.kind,
          createdAt: toIsoDateTime(req.createdAt),
          summary: summarizeRuntimeRequest(req),
          blocking: req.responseCapability.type === "live",
        }));
      const activeSubagentCount = projection.subagents.filter((sub) =>
        ACTIVE_SUBAGENT_STATUSES.has(sub.status),
      ).length;

      // Pause active execution and hold queued runs before snapshotting state.
      if (wasRunning || hadPendingRuntimeRequest || activeSubagentCount > 0) {
        yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`xfer-stop:${input.transferId}`),
            threadId: input.threadId,
            reason: "Paused for session transfer.",
          })
          .pipe(Effect.ignore);

        const settled = yield* awaitThreadSettled(input.threadId, SOURCE_SETTLE_TIMEOUT_MS);
        if (!settled) {
          yield* threadManagement
            .forceStopThread({
              threadId: input.threadId,
            })
            .pipe(Effect.ignore);
        }

        // Re-read fresh projection after settling so exported history includes everything up to pause.
        projection = yield* projectionStore.getThreadProjection(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new SessionTransferError({
                code: "internal",
                transferId: input.transferId,
                message: `Failed to reload settled source thread '${input.threadId}'.`,
                cause,
              }),
          ),
        );
      }

      // Detach any live/attached provider sessions so exclusive provider locks are released.
      const sessionIdsToDetach = new Set(
        projection.providerSessions
          .filter((session) => session.status !== "stopped")
          .map((session) => session.id),
      );
      for (const providerThread of projection.providerThreads) {
        if (providerThread.providerSessionId !== null) {
          sessionIdsToDetach.add(providerThread.providerSessionId);
        }
      }
      for (const providerSessionId of sessionIdsToDetach) {
        yield* providerSessionManager
          .detach({
            providerSessionId,
            threadId: input.threadId,
            detail: "Detached for session transfer.",
          })
          .pipe(Effect.ignore);
      }

      // Collect held queued runs in ordinal order.
      const messagesById = new Map(projection.messages.map((message) => [message.id, message]));
      const heldQueuedRuns: SessionTransferQueuedRun[] = projection.runs
        .filter((run) => run.status === "queued")
        .toSorted((a, b) => a.ordinal - b.ordinal)
        .map((run) => {
          const message = messagesById.get(run.userMessageId);
          return {
            runId: run.id,
            text: message?.text ?? "",
            attachments: message?.attachments ?? [],
            modelSelection: run.modelSelection,
            runtimeMode: projection.thread.runtimeMode,
            interactionMode: projection.thread.interactionMode,
            requestedAt: toIsoDateTime(run.requestedAt),
          };
        });

      const projectOption = yield* projectService
        .getById(projection.thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const project = Option.getOrUndefined(projectOption);
      const workspaceCwd = projection.thread.worktreePath ?? project?.workspaceRoot ?? null;

      // Export git workspace bundle when workspace is inside a git repository.
      let workspaceSpec: SessionTransferWorkspaceSpec = {
        mode: "none",
        isGitRepo: false,
        branch: projection.thread.branch,
        headSha: null,
        baseRef: null,
        isDetachedHead: false,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        hasUntrackedFiles: false,
        bundleSizeBytes: null,
        bundleSha256: null,
        repositoryIdentity: project?.repositoryIdentity ?? null,
        warnings: [],
      };
      let bundleDownloadRelativeUrl: TrimmedNonEmptyStringValue | null = null;
      let bundleExpiresAt: IsoDateTime | null = null;

      if (workspaceCwd !== null) {
        const exportBundlePath = resolveExportBundlePath(
          serverConfig.stateDir,
          input.transferId,
          path,
        );
        if (exportBundlePath === null) {
          return yield* new SessionTransferError({
            code: "workspace_error",
            transferId: input.transferId,
            message: `Invalid transfer identifier '${input.transferId}'.`,
          });
        }

        const exportResult = yield* Effect.result(
          workspaceBundle.exportWorkspaceBundle({
            transferId: input.transferId,
            cwd: workspaceCwd,
            outputPath: exportBundlePath,
            ...(input.sharedRemoteRefs !== undefined
              ? { sharedRemoteRefs: input.sharedRemoteRefs }
              : {}),
          }),
        );

        if (Result.isFailure(exportResult)) {
          const err = exportResult.failure;
          if (err.code === "not_git_repo") {
            workspaceSpec = {
              ...workspaceSpec,
              warnings: ["Source workspace is not a Git repository; files were not bundled."],
            };
          } else if (err.code === "bundle_too_large") {
            return yield* new SessionTransferError({
              code: "bundle_too_large",
              transferId: input.transferId,
              message: err.message,
              cause: err,
            });
          } else {
            return yield* new SessionTransferError({
              code: "workspace_error",
              transferId: input.transferId,
              message: err.message,
              cause: err,
            });
          }
        } else {
          const exported = exportResult.success;
          workspaceSpec = {
            mode: "git_bundle",
            isGitRepo: true,
            branch: exported.branch !== null ? GitRefName.make(exported.branch) : null,
            headSha: TrimmedNonEmptyString.make(exported.headSha),
            baseRef:
              exported.baseRef !== null ? TrimmedNonEmptyString.make(exported.baseRef) : null,
            isDetachedHead: exported.isDetachedHead,
            hasStagedChanges: exported.hasStagedChanges,
            hasUnstagedChanges: exported.hasUnstagedChanges,
            hasUntrackedFiles: exported.hasUntrackedFiles,
            bundleSizeBytes: exported.bundleSizeBytes,
            bundleSha256: TrimmedNonEmptyString.make(exported.bundleSha256),
            repositoryIdentity: project?.repositoryIdentity ?? null,
            warnings: exported.warnings,
          };

          const issuedBundle = yield* runWithAssetContext(
            issueSessionTransferBundleUrl({
              transferId: input.transferId,
              operation: "download",
              maxBytes: exported.bundleSizeBytes,
              expectedSha256: exported.bundleSha256,
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new SessionTransferError({
                  code: "internal",
                  transferId: input.transferId,
                  message: cause.message,
                  cause,
                }),
            ),
          );
          bundleDownloadRelativeUrl = TrimmedNonEmptyString.make(issuedBundle.relativeUrl);
          bundleExpiresAt = issuedBundle.expiresAt;
        }
      }

      // Collect and sign attachment download URLs (preserving stubs if any file was pruned).
      const uniqueAttachments = collectThreadAttachments({
        messages: projection.messages,
        turnItems: projection.turnItems,
        heldQueuedRuns,
      });
      const attachmentWarnings: string[] = [];
      const attachmentRefs: SessionTransferAttachmentRef[] = [];
      for (const attachment of uniqueAttachments) {
        const attachmentPath = resolveAttachmentPathById({
          attachmentsDir: serverConfig.attachmentsDir,
          attachmentId: attachment.id,
        });
        if (attachmentPath === null) {
          attachmentWarnings.push(
            `Attachment '${attachment.name}' (${attachment.id}) is missing on source; metadata stub exported.`,
          );
          attachmentRefs.push({
            attachmentId: attachment.id,
            type:
              attachment.type === "image" || attachment.type === "file"
                ? attachment.type
                : "unknown",
            name: TrimmedNonEmptyString.make(attachment.name),
            mimeType: TrimmedNonEmptyString.make(attachment.mimeType),
            sizeBytes: attachment.sizeBytes,
            sha256: null,
          });
          continue;
        }

        const sha256 = yield* sha256FileOptional(attachmentPath);
        const signedAsset = yield* runWithAssetContext(
          issueSessionTransferAttachmentDownloadUrl({
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          }),
        ).pipe(Effect.orElseSucceed(() => null));

        if (signedAsset === null) {
          attachmentWarnings.push(
            `Could not mint download URL for attachment '${attachment.name}' (${attachment.id}); metadata stub exported.`,
          );
        }

        attachmentRefs.push({
          attachmentId: attachment.id,
          type:
            attachment.type === "image" || attachment.type === "file" ? attachment.type : "unknown",
          name: TrimmedNonEmptyString.make(attachment.name),
          mimeType: TrimmedNonEmptyString.make(attachment.mimeType),
          sizeBytes: attachment.sizeBytes,
          sha256: sha256 !== null ? TrimmedNonEmptyString.make(sha256) : null,
          ...(signedAsset !== null
            ? { downloadRelativeUrl: TrimmedNonEmptyString.make(signedAsset.relativeUrl) }
            : {}),
        });
      }

      if (attachmentWarnings.length > 0) {
        workspaceSpec = {
          ...workspaceSpec,
          warnings: [...workspaceSpec.warnings, ...attachmentWarnings],
        };
      }

      const sourceEnvironmentId = yield* environmentIdentity.getEnvironmentId;
      const descriptor = yield* Option.match(serverEnvironmentOption, {
        onNone: () => Effect.succeed(null),
        onSome: (env) => env.getDescriptor.pipe(Effect.orElseSucceed(() => null)),
      });
      const sourceEnvironmentName =
        descriptor?.label && descriptor.label.trim().length > 0
          ? TrimmedNonEmptyString.make(descriptor.label.trim())
          : null;

      const providerMeta =
        providerAdapterRegistry.getMetadata !== undefined
          ? yield* providerAdapterRegistry
              .getMetadata(projection.thread.providerInstanceId)
              .pipe(Effect.orElseSucceed(() => null))
          : null;

      const now = yield* DateTime.now;
      const manifest: SessionTransferManifest = {
        schemaVersion: 1,
        transferId: input.transferId,
        direction: input.direction,
        exportedAt: toIsoDateTime(now),
        sourceEnvironmentId,
        sourceEnvironmentName,
        sourceMachineId: null,
        sourceProjectId: projection.thread.projectId,
        sourceProjectName: project ? TrimmedNonEmptyString.make(project.title) : null,
        sourceWorkspaceRoot: project?.workspaceRoot
          ? TrimmedNonEmptyString.make(project.workspaceRoot)
          : null,
        sourceThreadId: projection.thread.id,
        title: projection.thread.title,
        ...(projection.thread.titleRenamed !== undefined
          ? { titleRenamed: projection.thread.titleRenamed }
          : {}),
        providerInstanceId: projection.thread.providerInstanceId,
        ...(providerMeta !== null ? { providerDriverKind: providerMeta.driver } : {}),
        modelSelection: projection.thread.modelSelection,
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
        sourceState: {
          wasRunning,
          hadPendingRuntimeRequest,
          pendingRuntimeRequests,
          heldQueuedRunCount: heldQueuedRuns.length,
          activeSubagentCount,
          branch: workspaceSpec.branch,
          headSha: workspaceSpec.headSha,
          isDirty:
            workspaceSpec.hasStagedChanges ||
            workspaceSpec.hasUnstagedChanges ||
            workspaceSpec.hasUntrackedFiles,
          isGitRepo: workspaceSpec.isGitRepo,
        },
        workspace: workspaceSpec,
        attachments: attachmentRefs,
        messages: projection.messages,
        turnItems: projection.turnItems,
        plans: projection.plans,
        heldQueuedRuns,
        ...(projection.thread.linkedPullRequest !== undefined
          ? { linkedPullRequest: projection.thread.linkedPullRequest }
          : {}),
        ...(projection.thread.pullRequests !== undefined
          ? { pullRequests: projection.thread.pullRequests }
          : {}),
        ...(projection.thread.issues !== undefined ? { issues: projection.thread.issues } : {}),
        ...(projection.thread.tags !== undefined ? { tags: projection.thread.tags } : {}),
        handoffSummary: buildHandoffSummaryFromProjection(projection),
        createdAt: toIsoDateTime(projection.thread.createdAt),
        updatedAt: toIsoDateTime(projection.thread.updatedAt),
      };

      const result: SessionTransferPrepareSourceResult = {
        manifest,
        bundleDownloadRelativeUrl,
        bundleExpiresAt,
      };
      yield* Ref.update(preparedSources, (map) => {
        const next = new Map(map);
        next.set(input.transferId, result);
        return next;
      });
      return result;
    }).pipe(
      Effect.onError(() =>
        Effect.all(
          [
            releaseSourceLock,
            runWithAssetContext(cleanupTransferStagingDir(input.transferId)).pipe(Effect.ignore),
          ],
          { discard: true },
        ),
      ),
    );
  });

  const stageImport: SessionTransferEndpointServiceShape["stageImport"] = Effect.fn(
    "SessionTransferEndpointService.stageImport",
  )(function* (input) {
    const targetProjectId = input.targetProjectId ?? input.manifest.sourceProjectId;
    const projectOption = yield* projectService.getById(targetProjectId).pipe(
      Effect.mapError(
        (cause) =>
          new SessionTransferError({
            code: "internal",
            transferId: input.transferId,
            message: `Failed to inspect target project '${targetProjectId}'.`,
            cause,
          }),
      ),
    );
    if (Option.isNone(projectOption)) {
      return yield* new SessionTransferError({
        code: "not_found",
        transferId: input.transferId,
        message: `Target project '${targetProjectId}' was not found on destination.`,
      });
    }
    const project = projectOption.value;

    const { resolvedModelSelection, warnings: modelWarnings } =
      yield* resolveDestinationModelSelection({
        transferId: input.transferId,
        manifest: input.manifest,
        ...(input.modelSelectionOverride !== undefined
          ? { override: input.modelSelectionOverride }
          : {}),
      });

    // Idempotently reuse destinationThreadId keyed by transferId.
    const existingStaged = (yield* Ref.get(stagedImports)).get(input.transferId);
    const destinationThreadId =
      existingStaged?.destinationThreadId ?? deterministicDestinationThreadId(input.transferId);

    // Ensure staging directory exists for bundle upload.
    const stagingDir = resolveTransferStagingDir(serverConfig.stateDir, input.transferId, path);
    if (stagingDir === null) {
      return yield* new SessionTransferError({
        code: "workspace_error",
        transferId: input.transferId,
        message: `Invalid transfer identifier '${input.transferId}'.`,
      });
    }
    yield* fileSystem.makeDirectory(stagingDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionTransferError({
            code: "workspace_error",
            transferId: input.transferId,
            message: `Failed to prepare transfer staging directory.`,
            cause,
          }),
      ),
    );

    let bundleUploadRelativeUrl: TrimmedNonEmptyStringValue | null = null;
    let bundleUploadExpiresAt: IsoDateTime | null = null;
    if (input.manifest.workspace.mode === "git_bundle") {
      // Verify destination project has a git repository before accepting a git bundle.
      const gitMarkerExists = yield* fileSystem
        .exists(path.join(project.workspaceRoot, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (!gitMarkerExists) {
        return yield* new SessionTransferError({
          code: "workspace_error",
          transferId: input.transferId,
          message: `Destination project '${project.title}' at '${project.workspaceRoot}' is not a Git repository.`,
        });
      }

      const issuedUpload = yield* runWithAssetContext(
        issueSessionTransferBundleUrl({
          transferId: input.transferId,
          operation: "upload",
          ...(input.manifest.workspace.bundleSha256 !== null
            ? { expectedSha256: input.manifest.workspace.bundleSha256 }
            : {}),
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId: input.transferId,
              message: cause.message,
              cause,
            }),
        ),
      );
      bundleUploadRelativeUrl = TrimmedNonEmptyString.make(issuedUpload.relativeUrl);
      bundleUploadExpiresAt = issuedUpload.expiresAt;
    }

    const warnings = [...modelWarnings];
    const attachmentUploads: SessionTransferAttachmentUploadTarget[] = [];
    for (const attachment of input.manifest.attachments) {
      const uploadInput = buildAttachmentUploadInput(attachment);
      if (uploadInput === null || attachment.downloadRelativeUrl === undefined) {
        warnings.push(
          `Attachment '${attachment.name}' has no downloadable payload; destination will preserve a metadata stub.`,
        );
        continue;
      }

      const uploadTarget = yield* runWithAssetContext(issueAttachmentUploadUrl(uploadInput)).pipe(
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "attachment_error",
              transferId: input.transferId,
              message: `Failed to mint attachment upload URL for '${attachment.name}': ${cause.message}`,
              cause,
            }),
        ),
      );

      attachmentUploads.push({
        sourceAttachmentId: attachment.attachmentId,
        destinationAttachmentId: ChatAttachmentId.make(uploadTarget.attachmentId),
        uploadRelativeUrl: TrimmedNonEmptyString.make(uploadTarget.relativeUrl),
        expiresAt: IsoDateTime.make(
          DateTime.formatIso(DateTime.makeUnsafe(uploadTarget.expiresAt)),
        ),
      });
    }

    yield* Ref.update(stagedImports, (map) => {
      const next = new Map(map);
      next.set(input.transferId, {
        transferId: input.transferId,
        destinationProjectId: project.id,
        projectWorkspaceRoot: project.workspaceRoot,
        destinationThreadId,
        resolvedModelSelection,
        attachmentUploads,
        warnings,
        worktreePath: existingStaged?.worktreePath ?? null,
        branch: existingStaged?.branch ?? null,
        committed: existingStaged?.committed ?? false,
        committedResult: existingStaged?.committedResult ?? null,
      });
      return next;
    });

    return {
      destinationProjectId: project.id,
      destinationThreadId,
      destinationBranch: existingStaged?.branch ?? null,
      destinationWorktreePath:
        existingStaged?.worktreePath !== null && existingStaged?.worktreePath !== undefined
          ? TrimmedNonEmptyString.make(existingStaged.worktreePath)
          : null,
      resolvedModelSelection,
      bundleUploadRelativeUrl,
      bundleUploadExpiresAt,
      attachmentUploads,
      warnings,
    } satisfies SessionTransferStageImportResult;
  });

  const commitImport: SessionTransferEndpointServiceShape["commitImport"] = Effect.fn(
    "SessionTransferEndpointService.commitImport",
  )(function* (input) {
    // 1. In-memory idempotency check.
    const existingStaged = (yield* Ref.get(stagedImports)).get(input.transferId);
    if (existingStaged?.committed && existingStaged.committedResult !== null) {
      return existingStaged.committedResult;
    }

    // 2. Durable SQLite idempotency check (survives destination server restart).
    const existingThread = yield* Effect.option(
      projectionStore.getThreadRecords(input.destinationThreadId, []),
    );
    if (
      Option.isSome(existingThread) &&
      existingThread.value.thread.transferOrigin?.transferId === input.transferId
    ) {
      return {
        destinationProjectId: existingThread.value.thread.projectId,
        destinationThreadId: existingThread.value.thread.id,
        destinationBranch: existingThread.value.thread.branch,
        destinationWorktreePath: existingThread.value.thread.worktreePath,
        resumed: false,
        warnings: [],
      } satisfies SessionTransferCommitImportResult;
    }

    const projectOption = yield* projectService.getById(input.destinationProjectId).pipe(
      Effect.mapError(
        (cause) =>
          new SessionTransferError({
            code: "internal",
            transferId: input.transferId,
            message: `Failed to read destination project '${input.destinationProjectId}'.`,
            cause,
          }),
      ),
    );
    if (Option.isNone(projectOption)) {
      return yield* new SessionTransferError({
        code: "not_found",
        transferId: input.transferId,
        message: `Destination project '${input.destinationProjectId}' was not found.`,
      });
    }
    const project = projectOption.value;

    const { resolvedModelSelection, warnings: modelWarnings } =
      yield* resolveDestinationModelSelection({
        transferId: input.transferId,
        manifest: input.manifest,
        ...(input.modelSelectionOverride !== undefined
          ? { override: input.modelSelectionOverride }
          : existingStaged !== undefined
            ? { override: existingStaged.resolvedModelSelection }
            : {}),
      });

    const warnings: string[] = [...modelWarnings];
    let destinationBranch: GitRefNameValue | null = null;
    let destinationWorktreePath: TrimmedNonEmptyStringValue | null = null;

    // 3. Apply uploaded git workspace bundle into a fresh isolated worktree.
    if (input.manifest.workspace.mode === "git_bundle") {
      const importBundlePath = resolveImportBundlePath(
        serverConfig.stateDir,
        input.transferId,
        path,
      );
      if (
        importBundlePath === null ||
        !(yield* fileSystem.exists(importBundlePath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* new SessionTransferError({
          code: "workspace_error",
          transferId: input.transferId,
          message: `Uploaded workspace bundle for transfer '${input.transferId}' was not found on destination.`,
        });
      }

      const targetLabel = input.manifest.direction === "local_to_boat" ? "boat" : "local";
      const setupWarnings: string[] = [];

      const beforeApplyDirtyLayers = Option.match(setupScriptRunnerOption, {
        onNone: () => undefined,
        onSome: (runner) => (worktreePath: string) =>
          runner
            .runForThread({
              threadId: input.destinationThreadId,
              projectId: project.id,
              worktreePath,
              project: {
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                scripts: project.scripts,
              },
            })
            .pipe(
              Effect.flatMap((result) =>
                result.status === "started" && result.completion !== undefined && !result.async
                  ? result.completion.pipe(
                      Effect.timeoutOption(Duration.millis(SETUP_HOOK_TIMEOUT_MS)),
                      Effect.asVoid,
                    )
                  : Effect.void,
              ),
              Effect.catch((cause) =>
                Effect.sync(() => {
                  setupWarnings.push(
                    `Destination project setup script skipped or failed before restoring dirty edits: ${String(cause)}`,
                  );
                }),
              ),
            ),
      });

      const importedWorkspace = yield* workspaceBundle
        .importWorkspaceBundle({
          transferId: input.transferId,
          repoCwd: project.workspaceRoot,
          bundlePath: importBundlePath,
          sourceBranch: input.manifest.workspace.branch,
          targetLabel,
          ...(beforeApplyDirtyLayers !== undefined ? { beforeApplyDirtyLayers } : {}),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SessionTransferError({
                code: "workspace_error",
                transferId: input.transferId,
                message: cause.message,
                cause,
              }),
          ),
        );

      destinationBranch = GitRefName.make(importedWorkspace.branch);
      destinationWorktreePath = TrimmedNonEmptyString.make(importedWorkspace.worktreePath);
      warnings.push(...importedWorkspace.warnings, ...setupWarnings);

      // Record created worktree immediately so abort can clean it up if commit fails later.
      yield* Ref.update(stagedImports, (map) => {
        const next = new Map(map);
        const prev = next.get(input.transferId);
        next.set(input.transferId, {
          transferId: input.transferId,
          destinationProjectId: project.id,
          projectWorkspaceRoot: project.workspaceRoot,
          destinationThreadId: input.destinationThreadId,
          resolvedModelSelection,
          attachmentUploads: prev?.attachmentUploads ?? [],
          warnings: prev?.warnings ?? [],
          worktreePath: importedWorkspace.worktreePath,
          branch: destinationBranch,
          committed: false,
          committedResult: null,
        });
        return next;
      });
    }

    // 4. Claim uploaded pending attachments onto destinationThreadId & build oldId -> newId map.
    const pendingIdBySourceId = new Map<ChatAttachmentId, ChatAttachmentId>();
    for (const upload of existingStaged?.attachmentUploads ?? []) {
      pendingIdBySourceId.set(upload.sourceAttachmentId, upload.destinationAttachmentId);
    }
    if (input.attachmentIdMap !== undefined) {
      for (const [sourceId, pendingDestId] of Object.entries(input.attachmentIdMap)) {
        pendingIdBySourceId.set(
          ChatAttachmentId.make(sourceId),
          ChatAttachmentId.make(pendingDestId),
        );
      }
    }

    const claimedIdMap = new Map<ChatAttachmentId, ChatAttachmentId>();
    for (const ref of input.manifest.attachments) {
      const pendingId = pendingIdBySourceId.get(ref.attachmentId);
      if (pendingId === undefined || (ref.type !== "image" && ref.type !== "file")) {
        warnings.push(
          `Attachment '${ref.name}' (${ref.attachmentId}) was not uploaded; preserved metadata stub.`,
        );
        continue;
      }

      const candidateAttachment: ChatAttachment =
        ref.type === "image"
          ? {
              type: "image",
              id: pendingId,
              name: ref.name,
              mimeType: ref.mimeType,
              sizeBytes: ref.sizeBytes,
            }
          : {
              type: "file",
              id: pendingId,
              name: ref.name,
              mimeType: ref.mimeType,
              sizeBytes: ref.sizeBytes,
            };

      const claimed = yield* Effect.result(
        runWithAssetContext(
          claimPendingAttachments({
            threadId: input.destinationThreadId,
            attachments: [candidateAttachment],
          }),
        ),
      );
      if (Result.isSuccess(claimed) && claimed.success.attachments[0] !== undefined) {
        claimedIdMap.set(ref.attachmentId, claimed.success.attachments[0].id);
      } else {
        warnings.push(
          `Attachment '${ref.name}' could not be claimed on destination; preserved metadata stub.`,
        );
      }
    }

    // 5. Write full imported thread history via EventSinkV2 with transferOrigin & deterministic event IDs.
    const now = yield* DateTime.now;
    const safeId = sanitizeTransferSegment(input.transferId) ?? "transfer";
    const transferOrigin: SessionTransferThreadOrigin = {
      transferId: input.transferId,
      environmentId: input.manifest.sourceEnvironmentId,
      environmentName: input.manifest.sourceEnvironmentName,
      machineId: input.manifest.sourceMachineId,
      projectId: input.manifest.sourceProjectId,
      threadId: input.manifest.sourceThreadId,
      transferredAt: toIsoDateTime(now),
    };

    const importedThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: input.destinationThreadId,
      projectId: project.id,
      title: input.manifest.title,
      ...(input.manifest.titleRenamed !== undefined
        ? { titleRenamed: input.manifest.titleRenamed }
        : {}),
      providerInstanceId: resolvedModelSelection.instanceId,
      modelSelection: resolvedModelSelection,
      runtimeMode: input.manifest.runtimeMode,
      interactionMode: input.manifest.interactionMode,
      branch: destinationBranch,
      worktreePath: destinationWorktreePath,
      ...(input.manifest.linkedPullRequest !== undefined
        ? { linkedPullRequest: input.manifest.linkedPullRequest }
        : {}),
      ...(input.manifest.pullRequests !== undefined
        ? { pullRequests: input.manifest.pullRequests }
        : {}),
      ...(input.manifest.issues !== undefined ? { issues: input.manifest.issues } : {}),
      ...(input.manifest.tags !== undefined ? { tags: input.manifest.tags } : {}),
      activeProviderThreadId: null,
      historyOrigin: "v1_import",
      lineage: {
        rootThreadId: input.destinationThreadId,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdAt: DateTime.makeUnsafe(input.manifest.createdAt),
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      transferOrigin,
      transferredTo: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    const events: OrchestrationV2DomainEvent[] = [
      {
        id: EventId.make(`xfer:${safeId}:thread.created`),
        type: "thread.created",
        threadId: input.destinationThreadId,
        occurredAt: now,
        payload: importedThread,
      },
    ];

    // Imported conversation messages (excluding held queued run user messages which are re-enqueued below).
    // Assign deterministic transfer-scoped IDs so round-trips back to the origin environment never
    // collide with or steal rows belonging to the archived original thread.
    const heldQueuedRunIds = new Set(input.manifest.heldQueuedRuns.map((r) => r.runId));
    const messageIdMap = new Map<MessageId, MessageId>();
    for (let i = 0; i < input.manifest.messages.length; i += 1) {
      const sourceMessage = input.manifest.messages[i]!;
      if (sourceMessage.runId !== null && heldQueuedRunIds.has(sourceMessage.runId)) {
        continue;
      }
      const importedMessageId = MessageId.make(`xfer-msg:${safeId}:${i}`);
      messageIdMap.set(sourceMessage.id, importedMessageId);
      const rewrittenMessage: OrchestrationV2ConversationMessage = {
        ...sourceMessage,
        id: importedMessageId,
        threadId: input.destinationThreadId,
        runId: null,
        attachments: rewriteAttachments(sourceMessage.attachments, claimedIdMap),
      };
      events.push({
        id: EventId.make(`xfer:${safeId}:message:${i}`),
        type: "message.updated",
        threadId: input.destinationThreadId,
        occurredAt: rewrittenMessage.createdAt,
        payload: rewrittenMessage,
      });
    }

    // Imported turn items re-scoped onto destinationThreadId with runId: null so legacy-import handoff picks them up.
    for (let i = 0; i < input.manifest.turnItems.length; i += 1) {
      const sourceItem = input.manifest.turnItems[i]!;
      if (sourceItem.runId !== null && heldQueuedRunIds.has(sourceItem.runId)) {
        continue;
      }
      const importedItemId = TurnItemId.make(`xfer-item:${safeId}:${i}`);
      const rewrittenItem: OrchestrationV2TurnItem = (
        sourceItem.type === "user_message"
          ? {
              ...sourceItem,
              id: importedItemId,
              messageId: messageIdMap.get(sourceItem.messageId) ?? sourceItem.messageId,
              threadId: input.destinationThreadId,
              runId: null,
              providerThreadId: null,
              providerTurnId: null,
              attachments: rewriteAttachments(sourceItem.attachments, claimedIdMap),
            }
          : sourceItem.type === "assistant_message"
            ? {
                ...sourceItem,
                id: importedItemId,
                messageId: messageIdMap.get(sourceItem.messageId) ?? sourceItem.messageId,
                threadId: input.destinationThreadId,
                runId: null,
                providerThreadId: null,
                providerTurnId: null,
                ...(sourceItem.attachments !== undefined
                  ? { attachments: rewriteAttachments(sourceItem.attachments, claimedIdMap) }
                  : {}),
              }
            : {
                ...sourceItem,
                id: importedItemId,
                threadId: input.destinationThreadId,
                runId: null,
                providerThreadId: null,
                providerTurnId: null,
              }
      ) as OrchestrationV2TurnItem;
      events.push({
        id: EventId.make(`xfer:${safeId}:turn-item:${i}`),
        type: "turn-item.updated",
        threadId: input.destinationThreadId,
        occurredAt: rewrittenItem.updatedAt,
        payload: rewrittenItem,
      });
    }

    // Imported plans with deterministic transfer-scoped IDs.
    for (let i = 0; i < input.manifest.plans.length; i += 1) {
      const plan = input.manifest.plans[i]!;
      events.push({
        id: EventId.make(`xfer:${safeId}:plan:${i}`),
        type: "plan.updated",
        threadId: input.destinationThreadId,
        occurredAt: now,
        payload: {
          ...plan,
          id: PlanId.make(`xfer-plan:${safeId}:${i}`),
          threadId: input.destinationThreadId,
        },
      });
    }

    // Context handoff artifact carrying full_thread_summary + transfer context note.
    const transferContextSummary = buildTransferContextNote({
      manifest: input.manifest,
      destinationBranch,
    });
    const contextHandoff: OrchestrationV2ContextHandoff = {
      id: ContextHandoffId.make(`xfer-handoff:${safeId}`),
      transferId: null,
      threadId: input.destinationThreadId,
      targetRunId: RunId.make(`xfer-target-run:${safeId}`),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make(`xfer-provider-thread:${safeId}`),
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "full_thread_summary",
      status: "ready",
      summaryMessageId: null,
      summaryText: transferContextSummary,
      createdByProviderInstanceId: resolvedModelSelection.instanceId,
      createdAt: now,
      updatedAt: now,
    };
    events.push({
      id: EventId.make(`xfer:${safeId}:context-handoff`),
      type: "context-handoff.updated",
      threadId: input.destinationThreadId,
      occurredAt: now,
      payload: contextHandoff,
    });

    const shouldAutoResume =
      input.manifest.sourceState.wasRunning &&
      !input.manifest.sourceState.hadPendingRuntimeRequest &&
      input.autoResume;

    // When NOT auto-resuming, persist held queued runs directly in queued+held state so
    // the destination thread stays paused/idle with its queued prompts preserved in order.
    if (!shouldAutoResume && input.manifest.heldQueuedRuns.length > 0) {
      for (let i = 0; i < input.manifest.heldQueuedRuns.length; i += 1) {
        const queued = input.manifest.heldQueuedRuns[i]!;
        const queuedMessageId = MessageId.make(`xfer-qmsg:${safeId}:${i}`);
        const queuedRunId = RunId.make(`xfer-qrun:${safeId}:${i}`);
        const requestedAt = DateTime.makeUnsafe(queued.requestedAt);
        const queuedAttachments = rewriteAttachments(queued.attachments, claimedIdMap);
        const queuedSelection = queued.modelSelection ?? resolvedModelSelection;

        events.push(
          {
            id: EventId.make(`xfer:${safeId}:queued-message:${i}`),
            type: "message.updated",
            threadId: input.destinationThreadId,
            runId: queuedRunId,
            occurredAt: requestedAt,
            payload: {
              createdBy: "user",
              creationSource: "server",
              id: queuedMessageId,
              threadId: input.destinationThreadId,
              runId: queuedRunId,
              nodeId: null,
              role: "user",
              text: queued.text,
              attachments: queuedAttachments,
              streaming: false,
              createdAt: requestedAt,
              updatedAt: requestedAt,
            },
          },
          {
            id: EventId.make(`xfer:${safeId}:queued-run:${i}`),
            type: "run.created",
            threadId: input.destinationThreadId,
            runId: queuedRunId,
            providerInstanceId: queuedSelection.instanceId,
            occurredAt: requestedAt,
            payload: {
              id: queuedRunId,
              threadId: input.destinationThreadId,
              ordinal: i + 1,
              providerInstanceId: queuedSelection.instanceId,
              modelSelection: queuedSelection,
              providerThreadId: null,
              userMessageId: queuedMessageId,
              rootNodeId: null,
              activeAttemptId: null,
              status: "queued",
              queuePosition: i + 1,
              queueHeld: true,
              requestedAt,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        );
      }
    }

    yield* eventSink.write({ events }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionTransferError({
            code: "internal",
            transferId: input.transferId,
            message: `Failed to commit imported thread '${input.destinationThreadId}': ${cause.message}`,
            cause,
          }),
      ),
    );

    // 6. Auto-resume with a single continuation turn ONLY when source was running,
    //    had no pending runtime requests, and autoResume is enabled.
    let resumed = false;
    if (shouldAutoResume) {
      const resumeResult = yield* Effect.result(
        threadManagement.sendToThread({
          projectId: project.id,
          commandId: CommandId.make(`xfer-resume:${safeId}`),
          threadId: input.destinationThreadId,
          messageId: MessageId.make(`xfer-resume-msg:${safeId}`),
          text: buildAutoResumePrompt(input.manifest),
          attachments: [],
          modelSelection: resolvedModelSelection,
          mode: "auto",
          createdBy: "system",
          creationSource: "server",
        }),
      );
      if (Result.isSuccess(resumeResult)) {
        resumed = true;
      } else {
        warnings.push(
          `Imported thread was committed, but automatic continuation turn could not start: ${resumeResult.failure.message}`,
        );
      }

      // Re-enqueue held queued runs in order behind the active continuation turn.
      for (let i = 0; i < input.manifest.heldQueuedRuns.length; i += 1) {
        const queued = input.manifest.heldQueuedRuns[i]!;
        const queuedAttachments = rewriteAttachments(queued.attachments, claimedIdMap);
        yield* threadManagement
          .sendToThread({
            projectId: project.id,
            commandId: CommandId.make(`xfer-requeue:${safeId}:${i}`),
            threadId: input.destinationThreadId,
            messageId: MessageId.make(`xfer-requeue-msg:${safeId}:${i}`),
            text: queued.text,
            attachments: queuedAttachments,
            modelSelection: queued.modelSelection ?? resolvedModelSelection,
            mode: "queue",
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                warnings.push(`Failed to re-enqueue held message #${i + 1}: ${cause.message}`);
              }),
            ),
          );
      }
    }

    // Clean up temporary imported bundle staging file after successful commit.
    yield* runWithAssetContext(cleanupTransferStagingDir(input.transferId)).pipe(Effect.ignore);

    const committedResult: SessionTransferCommitImportResult = {
      destinationProjectId: project.id,
      destinationThreadId: input.destinationThreadId,
      destinationBranch,
      destinationWorktreePath,
      resumed,
      warnings,
    };

    yield* Ref.update(stagedImports, (map) => {
      const next = new Map(map);
      const prev = next.get(input.transferId);
      next.set(input.transferId, {
        transferId: input.transferId,
        destinationProjectId: project.id,
        projectWorkspaceRoot: project.workspaceRoot,
        destinationThreadId: input.destinationThreadId,
        resolvedModelSelection,
        attachmentUploads: prev?.attachmentUploads ?? [],
        warnings,
        worktreePath: destinationWorktreePath,
        branch: destinationBranch,
        committed: true,
        committedResult,
      });
      return next;
    });

    return committedResult;
  });

  const finalizeSource: SessionTransferEndpointServiceShape["finalizeSource"] = Effect.fn(
    "SessionTransferEndpointService.finalizeSource",
  )(function* (input) {
    const records = yield* projectionStore.getThreadRecords(input.threadId, []).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProjectionStoreThreadNotFoundError"
          ? new SessionTransferError({
              code: "not_found",
              transferId: input.transferId,
              message: `Source thread '${input.threadId}' was not found.`,
              cause,
            })
          : new SessionTransferError({
              code: "internal",
              transferId: input.transferId,
              message: `Failed to read source thread '${input.threadId}': ${cause.message}`,
              cause,
            }),
      ),
    );

    const now = yield* DateTime.now;
    const safeId = sanitizeTransferSegment(input.transferId) ?? "transfer";
    if (records.thread.transferredTo?.transferId !== input.transferId) {
      yield* eventSink
        .write({
          events: [
            {
              id: EventId.make(`xfer-finalize:${safeId}`),
              type: "thread.transfer-state-updated",
              threadId: input.threadId,
              occurredAt: now,
              payload: {
                ...records.thread,
                transferredTo: input.destination,
                updatedAt: now,
              },
            },
          ],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SessionTransferError({
                code: "internal",
                transferId: input.transferId,
                message: `Failed to record transfer state on source thread '${input.threadId}': ${cause.message}`,
                cause,
              }),
          ),
        );
    }

    let archived = records.thread.archivedAt !== null;
    if (!archived) {
      yield* threadManagement
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`xfer-archive:${safeId}`),
          threadId: input.threadId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SessionTransferError({
                code: "internal",
                transferId: input.transferId,
                message: `Failed to archive source thread '${input.threadId}': ${cause.message}`,
                cause,
              }),
          ),
        );
      archived = true;
    }

    // Release source transfer lock and delete temporary export bundle files.
    yield* Ref.update(sourceLocks, (current) => {
      if (current.get(input.threadId) !== input.transferId) return current;
      const next = new Map(current);
      next.delete(input.threadId);
      return next;
    });
    yield* Ref.update(preparedSources, (current) => {
      if (!current.has(input.transferId)) return current;
      const next = new Map(current);
      next.delete(input.transferId);
      return next;
    });
    yield* runWithAssetContext(cleanupTransferStagingDir(input.transferId)).pipe(Effect.ignore);

    return { archived } satisfies SessionTransferFinalizeSourceResult;
  });

  const abort: SessionTransferEndpointServiceShape["abort"] = Effect.fn(
    "SessionTransferEndpointService.abort",
  )(function* (input) {
    if (input.role === "source") {
      const releasedLock = yield* Ref.modify(sourceLocks, (current) => {
        let removed = false;
        const next = new Map(current);
        if (input.threadId !== undefined && next.get(input.threadId) === input.transferId) {
          next.delete(input.threadId);
          removed = true;
        }
        for (const [threadId, holder] of next) {
          if (holder === input.transferId) {
            next.delete(threadId);
            removed = true;
          }
        }
        return [removed, next] as const;
      });

      const removedCache = yield* Ref.modify(preparedSources, (current) => {
        if (!current.has(input.transferId)) return [false, current] as const;
        const next = new Map(current);
        next.delete(input.transferId);
        return [true, next] as const;
      });

      const deletedStaging = yield* runWithAssetContext(
        cleanupTransferStagingDir(input.transferId),
      ).pipe(Effect.orElseSucceed(() => false));

      return {
        cleanedUp: releasedLock || removedCache || deletedStaging,
      } satisfies SessionTransferAbortResult;
    }

    // Destination abort: never delete an already-committed thread/worktree.
    const staged = (yield* Ref.get(stagedImports)).get(input.transferId);
    const candidateThreadId =
      staged?.destinationThreadId ?? deterministicDestinationThreadId(input.transferId);
    const alreadyCommitted =
      staged?.committed === true ||
      Option.isSome(
        yield* Effect.option(projectionStore.getThreadRecords(candidateThreadId, [])).pipe(
          Effect.map(
            Option.filter((rec) => rec.thread.transferOrigin?.transferId === input.transferId),
          ),
        ),
      );

    const deletedStaging = yield* runWithAssetContext(
      cleanupTransferStagingDir(input.transferId),
    ).pipe(Effect.orElseSucceed(() => false));

    if (alreadyCommitted) {
      return { cleanedUp: false } satisfies SessionTransferAbortResult;
    }

    let cleanedWorktree = false;
    if (staged?.worktreePath !== null && staged?.worktreePath !== undefined) {
      yield* workspaceBundle.removeWorktree({
        repoCwd: staged.projectWorkspaceRoot,
        worktreePath: staged.worktreePath,
        branch: staged.branch,
      });
      cleanedWorktree = true;
    }

    for (const upload of staged?.attachmentUploads ?? []) {
      yield* runWithAssetContext(deletePendingAttachment(upload.destinationAttachmentId)).pipe(
        Effect.ignore,
      );
    }

    const removedStaged = yield* Ref.modify(stagedImports, (current) => {
      if (!current.has(input.transferId)) return [false, current] as const;
      const next = new Map(current);
      next.delete(input.transferId);
      return [true, next] as const;
    });

    return {
      cleanedUp: cleanedWorktree || removedStaged || deletedStaging,
    } satisfies SessionTransferAbortResult;
  });

  return SessionTransferEndpointService.of({
    prepareSource,
    stageImport,
    commitImport,
    finalizeSource,
    abort,
  });
});

export const layer: Layer.Layer<
  SessionTransferEndpointService,
  never,
  | ServerConfig.ServerConfig
  | ServerEnvironment.ServerEnvironmentIdentity
  | FileSystem.FileSystem
  | Path.Path
  | EventSink.EventSinkV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectService.ProjectService
  | ThreadManagementService.ThreadManagementService
  | ProviderSessionManager.ProviderSessionManagerV2
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | WorkspaceBundle.WorkspaceBundle
  | AssetSigner.AssetSigner
  | DocumentText.DocumentText
  | SecureRandom.SecureRandom
> = Layer.effect(SessionTransferEndpointService, make);

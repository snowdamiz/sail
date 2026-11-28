// @effect-diagnostics nodeBuiltinImport:off -- streaming sha256 checksum for exported attachments and deterministic ID hashing avoid loading whole files in memory.
import * as NodeCrypto from "node:crypto";
import {
  type AttachmentCreateUploadUrlInput,
  type ChatAttachment,
  ChatAttachmentId,
  type ChatFileAttachment,
  type ChatImageAttachment,
  CommandId,
  ContextHandoffId,
  EventId,
  GitRefName,
  IsoDateTime,
  latestProviderTurnForAttempt,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationMessageContext,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  type SessionTransferAbortInput,
  type SessionTransferAbortResult,
  type SessionTransferAttachmentRef,
  type SessionTransferAttachmentUploadTarget,
  type SessionTransferCommitImportInput,
  type SessionTransferCommitImportResult,
  SessionTransferError,
  type SessionTransferFinalizeSourceInput,
  type SessionTransferFinalizeSourceResult,
  SessionTransferId,
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
  TrimmedNonEmptyString,
  TurnItemId,
  type UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as AssetSigner from "../assets/AssetSigner.ts";
import {
  deletePendingAttachmentStrict,
  issueAttachmentUploadUrl,
} from "../assets/AttachmentUpload.ts";
import {
  cleanupTransferStagingDir,
  issueSessionTransferAttachmentDownloadUrl,
  issueSessionTransferBundleUrl,
  resolveExportBundlePath,
  resolveImportBundlePath,
  resolveTransferStagingDir,
  resolveWorktreeOwnershipDir,
  resolveWorktreeOwnershipPath,
  uniqueTransferSegment,
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

const STOPPED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "interrupted",
  "cancelled",
]);

const ACTIVE_SUBAGENT_STATUSES = new Set(["pending", "running", "waiting"]);

type SourceLockEntry =
  | {
      readonly transferId: SessionTransferId;
      readonly attemptId: string;
      readonly phase: "preparing" | "prepared";
    }
  | {
      readonly transferId: SessionTransferId;
      readonly attemptId: string;
      readonly phase: "cleaning";
      readonly cleanupDeferred: Deferred.Deferred<void, SessionTransferError>;
    };

const PersistedWorktreeOwnership = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  transferId: SessionTransferId,
  destinationProjectId: ProjectId,
  projectWorkspaceRoot: Schema.String,
  repoRoot: Schema.optionalKey(Schema.String),
  gitCommonDir: Schema.optionalKey(Schema.NullOr(Schema.String)),
  destinationThreadId: ThreadId,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(GitRefName),
  createdBranch: Schema.Boolean,
  worktreeCreated: Schema.optionalKey(Schema.Boolean),
  importCompleted: Schema.Boolean,
});
type PersistedWorktreeOwnership = typeof PersistedWorktreeOwnership.Type;

const PersistedWorktreeOwnershipJson = Schema.fromJsonString(PersistedWorktreeOwnership);

function persistedOwnershipRepoRoot(ownership: PersistedWorktreeOwnership): string {
  return ownership.repoRoot !== undefined && ownership.repoRoot.length > 0
    ? ownership.repoRoot
    : ownership.projectWorkspaceRoot;
}

function persistedOwnershipWorktreeCreated(ownership: PersistedWorktreeOwnership): boolean {
  return ownership.worktreeCreated !== undefined
    ? ownership.worktreeCreated
    : ownership.importCompleted;
}

interface StagedWorktreeAllocation {
  readonly repoRoot: string;
  readonly gitCommonDir: string | null;
  readonly worktreePath: string | null;
  readonly branch: GitRefNameValue | null;
  readonly createdBranch: boolean;
  readonly worktreeCreated: boolean;
  readonly importCompleted: boolean;
}

interface StagedImportState {
  readonly transferId: SessionTransferId;
  readonly destinationProjectId: SessionTransferStageImportResult["destinationProjectId"];
  readonly projectWorkspaceRoot: string;
  readonly destinationThreadId: ThreadId;
  readonly resolvedModelSelection: ModelSelection;
  readonly attachmentUploads: ReadonlyArray<SessionTransferAttachmentUploadTarget>;
  readonly claimedAttachmentIds: Readonly<Record<string, ChatAttachmentId>>;
  readonly warnings: ReadonlyArray<string>;
  readonly worktreeAllocation: StagedWorktreeAllocation | null;
  readonly committed: boolean;
  readonly handoffComplete: boolean;
  readonly committedResult: SessionTransferCommitImportResult | null;
}

function resolveExistingAllocation(
  persistedOwnership: PersistedWorktreeOwnership | null,
  staged: StagedImportState | undefined,
): StagedWorktreeAllocation | null {
  if (persistedOwnership !== null) {
    return {
      repoRoot: persistedOwnershipRepoRoot(persistedOwnership),
      gitCommonDir: persistedOwnership.gitCommonDir ?? null,
      worktreePath: persistedOwnership.worktreePath,
      branch: persistedOwnership.branch,
      createdBranch: persistedOwnership.createdBranch,
      worktreeCreated: persistedOwnershipWorktreeCreated(persistedOwnership),
      importCompleted: persistedOwnership.importCompleted,
    };
  }
  return staged?.worktreeAllocation ?? null;
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

function transferIdKey(transferId: SessionTransferId): string {
  return uniqueTransferSegment(transferId) ?? "transfer";
}

function deterministicDestinationThreadId(transferId: SessionTransferId): ThreadId {
  return ThreadId.make(`xfer-${transferIdKey(transferId)}`);
}

function deterministicScopedId(
  prefix: string,
  destinationThreadId: ThreadId,
  sourceId: string,
): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`${destinationThreadId}\0${sourceId}`)
    .digest("hex")
    .slice(0, 24);
  return `${prefix}:${hash}`;
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
  const addAttachment = (attachment: ChatAttachment) => {
    if (!byId.has(attachment.id)) {
      byId.set(attachment.id, attachment);
    }
  };
  const addContextAttachments = (context: OrchestrationMessageContext | undefined) => {
    if (context === undefined) return;
    for (const record of context.records) {
      if (record.kind === "image" && "attachmentId" in record) {
        addAttachment({
          type: "image",
          id: ChatAttachmentId.make(record.attachmentId),
          name: record.name,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          ...(record.source !== undefined ? { source: record.source } : {}),
        });
      } else if (record.kind === "file" && "attachmentId" in record) {
        addAttachment({
          type: "file",
          id: ChatAttachmentId.make(record.attachmentId),
          name: record.name,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
        });
      }
    }
  };
  for (const message of input.messages) {
    for (const attachment of message.attachments) {
      addAttachment(attachment);
    }
    addContextAttachments(message.context);
  }
  for (const item of input.turnItems) {
    if (item.type === "user_message") {
      for (const attachment of item.attachments) {
        addAttachment(attachment);
      }
      addContextAttachments(item.context);
    } else if (item.type === "assistant_message" && item.attachments !== undefined) {
      for (const attachment of item.attachments) {
        addAttachment(attachment);
      }
    } else if (item.type === "user_input_request" && item.questionAnswer !== undefined) {
      for (const attachments of Object.values(item.questionAnswer.attachmentsByQuestionId)) {
        for (const attachment of attachments) {
          addAttachment(attachment);
        }
      }
    }
  }
  for (const run of input.heldQueuedRuns) {
    for (const attachment of run.attachments) {
      addAttachment(attachment);
    }
    addContextAttachments(run.context);
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

function rewriteMessageContext(
  context: OrchestrationMessageContext | undefined,
  idMap: ReadonlyMap<ChatAttachmentId, ChatAttachmentId>,
): OrchestrationMessageContext | undefined {
  if (context === undefined || idMap.size === 0) return context;
  const before: Array<{ readonly id: string }> = [];
  const after: Array<{ readonly id: string }> = [];
  for (const [sourceId, destinationId] of idMap) {
    before.push({ id: sourceId });
    after.push({ id: destinationId });
  }
  return remapComposerContextAttachments(context, before, after);
}

function rewriteQuestionAnswerAttachments(
  questionAnswer: UserInputAttachmentAnswerPayload,
  idMap: ReadonlyMap<ChatAttachmentId, ChatAttachmentId>,
): UserInputAttachmentAnswerPayload {
  if (idMap.size === 0) return questionAnswer;
  let changed = false;
  const nextByQuestionId: Record<
    string,
    ReadonlyArray<ChatImageAttachment | ChatFileAttachment>
  > = {};
  for (const [questionId, attachments] of Object.entries(questionAnswer.attachmentsByQuestionId)) {
    nextByQuestionId[questionId] = attachments.map((attachment) => {
      const mappedId = idMap.get(attachment.id);
      if (mappedId === undefined) return attachment;
      changed = true;
      return { ...attachment, id: mappedId };
    });
  }
  return changed
    ? { ...questionAnswer, attachmentsByQuestionId: nextByQuestionId }
    : questionAnswer;
}

function isProjectionLive(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
): boolean {
  const queuedRunIds = new Set(
    projection.runs.filter((run) => run.status === "queued").map((run) => run.id),
  );
  return (
    projection.runs.some((run) => ThreadManagementService.isActiveRun(run)) ||
    projection.attempts.some(
      (attempt) =>
        !queuedRunIds.has(attempt.runId) &&
        (attempt.status === "pending" || attempt.status === "running"),
    ) ||
    projection.providerTurns.some((turn) => turn.status === "running")
  );
}

function summarizeRuntimeRequest(
  request: OrchestrationV2ThreadProjection["runtimeRequests"][number],
): string | null {
  if (request.feedback && request.feedback.trim().length > 0) {
    return request.feedback.trim();
  }
  return `${request.kind} request`;
}

/**
 * Collect unresolved approvals, user-input requests, and secret requests from a thread projection,
 * matching RestartContinuation's pause guard semantics so auto-resume never fires past an open
 * user decision (including requests cancelled specifically by the transfer stop/interrupt).
 */
function collectPendingRequestsFromProjection(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "nodes" | "providerTurns" | "runtimeRequests" | "turnItems"
  >,
  stoppedRunIds: ReadonlySet<RunId>,
): ReadonlyArray<SessionTransferPendingRuntimeRequest> {
  const stoppedRuns = projection.runs.filter((run) => stoppedRunIds.has(run.id));
  const stoppedRunsById = new Map(stoppedRuns.map((run) => [run.id, run]));
  const nodeRunIdByNodeId = new Map(projection.nodes.map((node) => [node.id, node.runId]));
  const stoppedTurnIds = new Set<string>();
  for (const run of stoppedRuns) {
    const turn = latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
    if (turn !== undefined) {
      stoppedTurnIds.add(turn.id);
    }
  }

  const pending: SessionTransferPendingRuntimeRequest[] = [];
  const seenIds = new Set<string>();

  for (const req of projection.runtimeRequests) {
    if (req.kind === "dynamic_tool_call" || req.kind === "auth_refresh") {
      continue;
    }

    const isPending = req.status === "pending";
    let isCancelledByStop = false;
    if (
      !isPending &&
      (req.status === "expired" || req.status === "cancelled") &&
      req.responseCapability.type === "not_resumable"
    ) {
      const nodeRunId = nodeRunIdByNodeId.get(req.nodeId);
      const matchesTurn = req.providerTurnId !== null && stoppedTurnIds.has(req.providerTurnId);
      const matchesNodeRun =
        nodeRunId !== undefined && nodeRunId !== null && stoppedRunsById.has(nodeRunId);
      const matchesCompletedAt =
        req.resolvedAt !== null &&
        stoppedRuns.some(
          (run) =>
            run.completedAt !== null && DateTime.Equivalence(req.resolvedAt!, run.completedAt),
        );
      isCancelledByStop = matchesTurn || matchesNodeRun || matchesCompletedAt;
    }

    if (!isPending && !isCancelledByStop) {
      continue;
    }

    if (seenIds.has(req.id)) continue;
    seenIds.add(req.id);
    pending.push({
      id: req.id,
      kind: req.kind,
      createdAt: toIsoDateTime(req.createdAt),
      summary: summarizeRuntimeRequest(req),
      blocking: req.responseCapability.type !== "message",
    });
  }

  for (const item of projection.turnItems) {
    if (item.type !== "secret_request") continue;

    const isPendingSecret = item.secretStatus === "pending";
    let isCancelledByStop = false;
    if (!isPendingSecret && item.secretStatus === "cancelled" && item.completedAt !== null) {
      const associatedRun = item.runId !== null ? stoppedRunsById.get(item.runId) : undefined;
      if (
        associatedRun !== undefined &&
        associatedRun.completedAt !== null &&
        DateTime.Equivalence(item.completedAt, associatedRun.completedAt)
      ) {
        isCancelledByStop = true;
      }
    }

    if (!isPendingSecret && !isCancelledByStop) {
      continue;
    }

    const reqId = RuntimeRequestId.make(item.id);
    if (seenIds.has(reqId)) continue;
    seenIds.add(reqId);
    const trimmedReason = item.reason.trim();
    pending.push({
      id: reqId,
      kind: "user_input",
      createdAt: toIsoDateTime(item.startedAt ?? item.updatedAt),
      summary:
        trimmedReason.length > 0
          ? `Secret request (${item.label}): ${trimmedReason}`
          : `Secret request: ${item.label}`,
      blocking: true,
      userOnly: true,
    });
  }

  return pending;
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

  const sourceLocks = yield* Ref.make(new Map<ThreadId, SourceLockEntry>());

  const cleanupSourceStagingDir = (transferId: SessionTransferId) =>
    runWithAssetContext(cleanupTransferStagingDir(transferId)).pipe(
      Effect.mapError(
        (cause) =>
          new SessionTransferError({
            code: "internal",
            transferId,
            message: `Failed to remove session transfer staging directory for '${transferId}': ${String(cause)}`,
            cause,
          }),
      ),
    );

  const runSourceCleanupUninterruptible = <A>(args: {
    readonly transferId: SessionTransferId;
    readonly releaseLock: Effect.Effect<void>;
    readonly cleanupDeferred: Deferred.Deferred<void, SessionTransferError>;
    readonly runCleanup: Effect.Effect<A, SessionTransferError>;
  }): Effect.Effect<A, SessionTransferError> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(args.runCleanup);
        if (Exit.isSuccess(exit)) {
          yield* args.releaseLock;
          yield* Deferred.succeed(args.cleanupDeferred, undefined);
          return exit.value;
        }
        const failureOption = Cause.findErrorOption(exit.cause);
        const error = Option.isSome(failureOption)
          ? failureOption.value
          : new SessionTransferError({
              code: "internal",
              transferId: args.transferId,
              message: `Unexpected failure cleaning up session transfer staging for '${args.transferId}': ${Cause.pretty(exit.cause)}`,
              cause: Cause.squash(exit.cause),
            });
        yield* Effect.logWarning("Failed to clean up session transfer source staging directory.", {
          transferId: args.transferId,
          cause: error,
        });
        yield* args.releaseLock;
        yield* Deferred.fail(args.cleanupDeferred, error);
        return yield* Effect.failCause(exit.cause);
      }),
    );
  const encodeWorktreeOwnership = Schema.encodeEffect(PersistedWorktreeOwnershipJson);
  const decodeWorktreeOwnership = Schema.decodeUnknownEffect(PersistedWorktreeOwnershipJson);

  const writeWorktreeOwnership = Effect.fn("SessionTransferEndpointService.writeWorktreeOwnership")(
    function* (ownership: PersistedWorktreeOwnership) {
      const ownershipPath = resolveWorktreeOwnershipPath(
        serverConfig.stateDir,
        ownership.transferId,
        path,
      );
      if (ownershipPath === null) {
        return yield* new SessionTransferError({
          code: "invalid_phase",
          transferId: ownership.transferId,
          message: `Invalid session transfer identifier '${ownership.transferId}' for worktree ownership persistence.`,
        });
      }

      const encoded = yield* encodeWorktreeOwnership(ownership).pipe(
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId: ownership.transferId,
              message: `Failed to encode worktree ownership metadata for transfer '${ownership.transferId}': ${String(cause)}`,
              cause,
            }),
        ),
      );

      yield* fileSystem.makeDirectory(path.dirname(ownershipPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId: ownership.transferId,
              message: `Failed to create worktree ownership directory for transfer '${ownership.transferId}': ${cause.message}`,
              cause,
            }),
        ),
      );

      const tempPath = `${ownershipPath}.${yield* secureRandom.uuidV4()}.tmp`;
      yield* fileSystem.writeFileString(tempPath, encoded).pipe(
        Effect.andThen(fileSystem.rename(tempPath, ownershipPath)),
        Effect.tapError(() => fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId: ownership.transferId,
              message: `Failed to persist worktree ownership metadata for transfer '${ownership.transferId}': ${cause.message}`,
              cause,
            }),
        ),
      );
    },
  );

  const readWorktreeOwnership = Effect.fn("SessionTransferEndpointService.readWorktreeOwnership")(
    function* (
      transferId: SessionTransferId,
    ): Effect.fn.Return<PersistedWorktreeOwnership | null, SessionTransferError> {
      const ownershipPath = resolveWorktreeOwnershipPath(serverConfig.stateDir, transferId, path);
      if (ownershipPath === null) {
        return null;
      }

      const raw = yield* fileSystem.readFileString(ownershipPath).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId,
              message: `Failed to read persisted worktree ownership for transfer '${transferId}': ${cause.message}`,
              cause,
            }),
        ),
      );
      if (Option.isNone(raw)) {
        return null;
      }

      const decoded = yield* decodeWorktreeOwnership(raw.value).pipe(
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId,
              message: `Failed to decode persisted worktree ownership for transfer '${transferId}': ${String(cause)}`,
              cause,
            }),
        ),
      );
      if (decoded.transferId !== transferId) {
        return yield* new SessionTransferError({
          code: "internal",
          transferId,
          message: `Persisted worktree ownership transferId mismatch for transfer '${transferId}'.`,
        });
      }
      return decoded;
    },
  );

  const normalizePathForComparison = Effect.fn(
    "SessionTransferEndpointService.normalizePathForComparison",
  )(function* (targetPath: string) {
    let current = path.resolve(targetPath);
    const trailingSegments: Array<string> = [];
    while (true) {
      const realResult = yield* Effect.result(fileSystem.realPath(current));
      if (Result.isSuccess(realResult)) {
        const base = path.normalize(realResult.success);
        return trailingSegments.length === 0
          ? base
          : path.normalize(path.join(base, ...trailingSegments.reverse()));
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.normalize(path.resolve(targetPath));
      }
      trailingSegments.push(path.basename(current));
      current = parent;
    }
  });

  const removeWorktreeOwnership = Effect.fn(
    "SessionTransferEndpointService.removeWorktreeOwnership",
  )(function* (transferId: SessionTransferId): Effect.fn.Return<boolean, SessionTransferError> {
    const ownershipPath = resolveWorktreeOwnershipPath(serverConfig.stateDir, transferId, path);
    if (ownershipPath === null) {
      return false;
    }
    return yield* fileSystem.remove(ownershipPath).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(false),
      ),
      Effect.mapError(
        (cause) =>
          new SessionTransferError({
            code: "internal",
            transferId,
            message: `Failed to remove persisted worktree ownership for transfer '${transferId}': ${cause.message}`,
            cause,
          }),
      ),
    );
  });

  const removeWorktreeOwnershipBestEffort = (transferId: SessionTransferId) =>
    removeWorktreeOwnership(transferId).pipe(
      Effect.asVoid,
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to remove persisted session transfer worktree ownership file.", {
          transferId,
          cause,
        }),
      ),
      Effect.ignore,
    );

  // Must be called while holding `withRepoLock` so allocation observes all outstanding ownership
  // records written by concurrent or previously crashed transfers. Fails closed on non-ENOENT I/O
  // or corrupt JSON errors so a transfer can never blindly claim another transfer's path/branch.
  const readReservedWorktreeAllocations = Effect.fn(
    "SessionTransferEndpointService.readReservedWorktreeAllocations",
  )(function* (input: {
    readonly excludeTransferId: SessionTransferId;
    readonly gitCommonDir: string;
  }): Effect.fn.Return<WorkspaceBundle.ReservedWorktreeAllocations, SessionTransferError> {
    const ownershipDir = resolveWorktreeOwnershipDir(serverConfig.stateDir, path);
    const ownOwnershipPath = resolveWorktreeOwnershipPath(
      serverConfig.stateDir,
      input.excludeTransferId,
      path,
    );
    const normalizedTargetGitCommonDir = yield* normalizePathForComparison(input.gitCommonDir);

    const entriesOption = yield* fileSystem.readDirectory(ownershipDir).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
      Effect.mapError(
        (cause) =>
          new SessionTransferError({
            code: "internal",
            transferId: input.excludeTransferId,
            message: `Failed to scan worktree ownership ledger directory '${ownershipDir}': ${cause.message}`,
            cause,
          }),
      ),
    );
    if (Option.isNone(entriesOption)) {
      return {
        reservedWorktreePaths: new Set<string>(),
        reservedBranchNames: new Set<string>(),
      };
    }

    const reservedWorktreePaths = new Set<string>();
    const reservedBranchNames = new Set<string>();

    for (const entry of entriesOption.value) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const entryPath = path.resolve(ownershipDir, entry);
      if (ownOwnershipPath !== null && entryPath === ownOwnershipPath) {
        continue;
      }

      const rawOption = yield* fileSystem.readFileString(entryPath).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId: input.excludeTransferId,
              message: `Failed to read persisted worktree ownership record '${entryPath}': ${cause.message}`,
              cause,
            }),
        ),
      );
      if (Option.isNone(rawOption)) {
        continue;
      }

      const decoded = yield* decodeWorktreeOwnership(rawOption.value).pipe(
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId: input.excludeTransferId,
              message: `Failed to decode persisted worktree ownership record '${entryPath}': ${String(cause)}`,
              cause,
            }),
        ),
      );
      if (decoded.transferId === input.excludeTransferId) {
        continue;
      }

      if (decoded.worktreePath !== null && decoded.worktreePath.length > 0) {
        reservedWorktreePaths.add(yield* normalizePathForComparison(decoded.worktreePath));
      }

      if (decoded.branch !== null && decoded.branch.length > 0) {
        let sameRepo = false;
        if (
          decoded.gitCommonDir !== undefined &&
          decoded.gitCommonDir !== null &&
          decoded.gitCommonDir.length > 0
        ) {
          sameRepo =
            (yield* normalizePathForComparison(decoded.gitCommonDir)) ===
            normalizedTargetGitCommonDir;
        } else {
          const resolvedOtherCommonDir = yield* workspaceBundle
            .resolveGitCommonDir(persistedOwnershipRepoRoot(decoded))
            .pipe(Effect.orElseSucceed(() => null));
          // Conservatively reserve the branch if an older record omits gitCommonDir and its repo
          // cannot be resolved to prove it belongs to a different repository.
          sameRepo =
            resolvedOtherCommonDir === null ||
            resolvedOtherCommonDir === normalizedTargetGitCommonDir;
        }
        if (sameRepo) {
          reservedBranchNames.add(decoded.branch);
        }
      }
    }

    return {
      reservedWorktreePaths,
      reservedBranchNames,
    };
  });

  // Defense-in-depth: never remove a worktree/branch referenced by ANY non-deleted committed
  // thread in SQLite, and propagate DB read failures without deleting anything.
  const findCommittedThreadOwningWorktree = Effect.fn(
    "SessionTransferEndpointService.findCommittedThreadOwningWorktree",
  )(function* (
    worktreePath: string,
    transferId: SessionTransferId,
  ): Effect.fn.Return<ThreadId | null, SessionTransferError> {
    const normalizedTarget = yield* normalizePathForComparison(worktreePath);
    const threadWorktrees = yield* projectionStore
      .getThreadWorktreePaths({ includeArchived: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "internal",
              transferId,
              message: `Failed to verify committed thread worktrees before removing '${worktreePath}' for transfer '${transferId}': ${cause.message}`,
              cause,
            }),
        ),
      );
    for (const row of threadWorktrees) {
      if ((yield* normalizePathForComparison(row.worktreePath)) === normalizedTarget) {
        return row.threadId;
      }
    }
    return null;
  });

  const preparedSources = yield* Ref.make(
    new Map<SessionTransferId, SessionTransferPrepareSourceResult>(),
  );
  const stagedImports = yield* Ref.make(new Map<SessionTransferId, StagedImportState>());

  // Canonical-order keyed serialization locks for destination stageImport / commitImport / abort.
  const destinationLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; activeCount: number }
  >();

  // Per-repository mutex serializing worktree/branch allocation, creation, and removal across
  // concurrent transfers targeting the same Git common directory (covering both main checkouts and
  // linked Git worktrees). Always acquired strictly inside `withKeyedLocks` (transfer/thread locks)
  // to maintain a total lock order with zero deadlocks.
  const repoLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; activeCount: number }
  >();

  const canonicalRepoLockKey = Effect.fn("SessionTransferEndpointService.canonicalRepoLockKey")(
    function* (repoCwd: string, persistedGitCommonDir?: string | null) {
      const resolvedGitCommonDir = yield* workspaceBundle
        .resolveGitCommonDir(repoCwd)
        .pipe(Effect.orElseSucceed(() => null));
      if (resolvedGitCommonDir !== null) {
        return `git:${resolvedGitCommonDir}`;
      }
      if (
        persistedGitCommonDir !== undefined &&
        persistedGitCommonDir !== null &&
        persistedGitCommonDir.length > 0
      ) {
        return `git:${yield* normalizePathForComparison(persistedGitCommonDir)}`;
      }
      return `dir:${yield* normalizePathForComparison(repoCwd)}`;
    },
  );

  const withRepoLock = <A, E, R>(
    repoCwd: string,
    effect: Effect.Effect<A, E, R>,
    options?: { readonly gitCommonDir?: string | null },
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(canonicalRepoLockKey(repoCwd, options?.gitCommonDir), (repoKey) =>
      Effect.suspend(() => {
        let entry = repoLocks.get(repoKey);
        if (entry === undefined) {
          entry = { semaphore: Semaphore.makeUnsafe(1), activeCount: 0 };
          repoLocks.set(repoKey, entry);
        }
        entry.activeCount += 1;
        const lockedEntry = entry;
        return lockedEntry.semaphore
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                lockedEntry.activeCount -= 1;
                if (lockedEntry.activeCount === 0 && repoLocks.get(repoKey) === lockedEntry) {
                  repoLocks.delete(repoKey);
                }
              }),
            ),
          );
      }),
    );

  // Never swallow projection-read errors as "uncommitted": a transient DB/storage error must fail
  // so we never delete an already-committed thread's worktree or branch.
  const isTransferAlreadyCommitted = Effect.fn(
    "SessionTransferEndpointService.isTransferAlreadyCommitted",
  )(function* (
    transferId: SessionTransferId,
    staged: StagedImportState | undefined,
    persistedOwnership: PersistedWorktreeOwnership | null,
  ): Effect.fn.Return<boolean, SessionTransferError> {
    if (staged?.committed === true) {
      return true;
    }
    const candidateThreadIds = [
      ...new Set(
        [
          staged?.destinationThreadId,
          persistedOwnership?.destinationThreadId,
          deterministicDestinationThreadId(transferId),
        ].filter((id): id is ThreadId => id !== undefined),
      ),
    ];
    for (const candidateThreadId of candidateThreadIds) {
      const existingThreadOption = yield* projectionStore
        .getThreadRecords(candidateThreadId, [])
        .pipe(
          Effect.asSome,
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeedNone,
          }),
          Effect.mapError(
            (cause) =>
              new SessionTransferError({
                code: "internal",
                transferId,
                message: `Failed to verify whether destination thread '${candidateThreadId}' was committed for transfer '${transferId}': ${cause.message}`,
                cause,
              }),
          ),
        );
      if (
        Option.isSome(existingThreadOption) &&
        existingThreadOption.value.thread.transferOrigin?.transferId === transferId
      ) {
        return true;
      }
    }
    return false;
  });

  const isSameGitRepository = Effect.fn("SessionTransferEndpointService.isSameGitRepository")(
    function* (
      allocation: StagedWorktreeAllocation,
      targetGitCommonDir: string | null,
    ): Effect.fn.Return<boolean> {
      if (targetGitCommonDir === null || targetGitCommonDir.length === 0) {
        return false;
      }
      const normalizedTarget = yield* normalizePathForComparison(targetGitCommonDir);
      const allocationCommonDir =
        allocation.gitCommonDir !== null && allocation.gitCommonDir.length > 0
          ? yield* normalizePathForComparison(allocation.gitCommonDir)
          : yield* workspaceBundle
              .resolveGitCommonDir(allocation.repoRoot)
              .pipe(Effect.orElseSucceed(() => null));
      return allocationCommonDir !== null && allocationCommonDir === normalizedTarget;
    },
  );

  interface CleanupUncommittedAllocationResult {
    readonly cleanedWorktree: boolean;
    readonly removedOwnership: boolean;
    readonly worktreeOrBranchFailed: boolean;
    readonly remainingAllocation: StagedWorktreeAllocation | null;
    readonly failures: ReadonlyArray<SessionTransferError>;
  }

  const syncStagedWorktreeAllocation = (
    transferId: SessionTransferId,
    nextAllocation: StagedWorktreeAllocation | null,
  ) =>
    Ref.update(stagedImports, (map) => {
      const latest = map.get(transferId);
      if (latest === undefined) return map;
      if (latest.worktreeAllocation === nextAllocation) return map;
      const next = new Map(map);
      next.set(transferId, {
        ...latest,
        worktreeAllocation: nextAllocation,
      });
      return next;
    });

  // Cleans up an uncommitted worktree/branch allocation strictly against its own repoRoot and
  // gitCommonDir (never substituting staged.projectWorkspaceRoot), strictly verifies repository
  // identity (failing closed on lookup failure), strictly obeys the worktreeCreated and branch
  // match invariants, and synchronously clears/updates in-memory stagedImports before returning.
  const cleanupUncommittedAllocation = Effect.fn(
    "SessionTransferEndpointService.cleanupUncommittedAllocation",
  )(function* (input: {
    readonly transferId: SessionTransferId;
    readonly allocation: StagedWorktreeAllocation;
    readonly persistedOwnership: PersistedWorktreeOwnership | null;
    readonly contextLabel: string;
  }): Effect.fn.Return<CleanupUncommittedAllocationResult, SessionTransferError> {
    const { transferId, allocation, persistedOwnership, contextLabel } = input;
    return yield* withRepoLock(
      allocation.repoRoot,
      Effect.gen(function* () {
        const failures: Array<SessionTransferError> = [];
        let cleanedWorktree = false;
        let removedOwnership = false;
        let worktreeOrBranchFailed = false;
        let skipRepoDeletion = false;
        let nextWorktreePath = allocation.worktreePath;
        let nextBranch = allocation.branch;
        let nextCreatedBranch = allocation.createdBranch;
        let nextWorktreeCreated = allocation.worktreeCreated;

        // Defense-in-depth (fail-closed): NEVER run worktree/branch deletion against
        // allocation.repoRoot unless resolveGitCommonDir(allocation.repoRoot) succeeds with a
        // non-null git common dir that matches allocation.gitCommonDir (when recorded).
        const expectedGitCommonDir =
          allocation.gitCommonDir !== null && allocation.gitCommonDir.length > 0
            ? yield* normalizePathForComparison(allocation.gitCommonDir)
            : null;
        const resolvedGitCommonDirResult = yield* Effect.result(
          workspaceBundle.resolveGitCommonDir(allocation.repoRoot),
        );
        const resolvedGitCommonDir = Result.isSuccess(resolvedGitCommonDirResult)
          ? resolvedGitCommonDirResult.success
          : null;

        if (Result.isFailure(resolvedGitCommonDirResult) || resolvedGitCommonDir === null) {
          const repoRootExistsResult = yield* Effect.result(
            fileSystem.exists(allocation.repoRoot).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(false),
              ),
            ),
          );
          const repoRootGone =
            Result.isSuccess(repoRootExistsResult) && !repoRootExistsResult.success;

          if (!repoRootGone) {
            const detail = Result.isFailure(resolvedGitCommonDirResult)
              ? resolvedGitCommonDirResult.failure.message
              : "git rev-parse --git-common-dir returned no repository";
            const verifyError = new SessionTransferError({
              code: "internal",
              transferId,
              message: `Failed to verify destination repository identity for '${allocation.repoRoot}' during ${contextLabel} for transfer '${transferId}': ${detail}`,
              ...(Result.isFailure(resolvedGitCommonDirResult)
                ? { cause: resolvedGitCommonDirResult.failure }
                : {}),
            });
            return {
              cleanedWorktree: false,
              removedOwnership: false,
              worktreeOrBranchFailed: true,
              remainingAllocation: allocation,
              failures: [verifyError],
            } satisfies CleanupUncommittedAllocationResult;
          }

          // allocation.repoRoot does NOT exist on disk (ENOENT): NEVER run git delete commands
          // against allocation.repoRoot. Only clear ownership if expectedGitCommonDir is also gone
          // (or not recorded); if expectedGitCommonDir still exists, fail closed.
          if (expectedGitCommonDir !== null) {
            const commonDirExistsResult = yield* Effect.result(
              fileSystem.exists(expectedGitCommonDir).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound",
                  () => Effect.succeed(false),
                ),
              ),
            );
            const commonDirGone =
              Result.isSuccess(commonDirExistsResult) && !commonDirExistsResult.success;
            if (!commonDirGone) {
              const missingRootError = new SessionTransferError({
                code: "internal",
                transferId,
                message: `Refusing to drop destination worktree ownership during ${contextLabel} for transfer '${transferId}' because '${allocation.repoRoot}' does not exist while git common dir '${expectedGitCommonDir}' still exists.`,
              });
              return {
                cleanedWorktree: false,
                removedOwnership: false,
                worktreeOrBranchFailed: true,
                remainingAllocation: allocation,
                failures: [missingRootError],
              } satisfies CleanupUncommittedAllocationResult;
            }
          }

          yield* Effect.logWarning(
            `Skipping git worktree/branch deletion during ${contextLabel} because destination repository '${allocation.repoRoot}' no longer exists on disk.`,
            {
              transferId,
              repoRoot: allocation.repoRoot,
              expectedGitCommonDir,
            },
          );
          skipRepoDeletion = true;
          nextWorktreePath = null;
          nextBranch = null;
          nextCreatedBranch = false;
        } else if (expectedGitCommonDir !== null && resolvedGitCommonDir !== expectedGitCommonDir) {
          yield* Effect.logWarning(
            `Refusing to clean up destination worktree/branch during ${contextLabel} because '${allocation.repoRoot}' resolved to a different Git repository.`,
            {
              transferId,
              repoRoot: allocation.repoRoot,
              resolvedGitCommonDir,
              expectedGitCommonDir,
            },
          );
          const commonDirExistsResult = yield* Effect.result(
            fileSystem.exists(expectedGitCommonDir).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(false),
              ),
            ),
          );
          const commonDirGone =
            Result.isSuccess(commonDirExistsResult) && !commonDirExistsResult.success;
          if (!commonDirGone) {
            const mismatchError = new SessionTransferError({
              code: "workspace_error",
              transferId,
              message: `Refusing to clean up destination worktree/branch during ${contextLabel} for transfer '${transferId}' because '${allocation.repoRoot}' resolved to git common dir '${resolvedGitCommonDir}' instead of expected '${expectedGitCommonDir}'.`,
            });
            return {
              cleanedWorktree: false,
              removedOwnership: false,
              worktreeOrBranchFailed: true,
              remainingAllocation: allocation,
              failures: [mismatchError],
            } satisfies CleanupUncommittedAllocationResult;
          }

          // Original gitCommonDir is gone and repoRoot now points to a different repository:
          // never run any deletion against allocation.repoRoot; safely clear stale ownership.
          skipRepoDeletion = true;
          nextWorktreePath = null;
          nextBranch = null;
          nextCreatedBranch = false;
        }

        if (!skipRepoDeletion) {
          // Defense-in-depth: refuse to remove a worktree or branch if ANY non-deleted committed
          // thread in SQLite references this worktreePath (propagating DB errors).
          const owningCommittedThreadId =
            allocation.worktreePath !== null
              ? yield* findCommittedThreadOwningWorktree(allocation.worktreePath, transferId)
              : null;

          if (owningCommittedThreadId !== null) {
            yield* Effect.logWarning(
              `Refusing to remove destination worktree/branch during ${contextLabel} because worktree is owned by a committed thread.`,
              {
                transferId,
                worktreePath: allocation.worktreePath,
                branch: allocation.branch,
                owningCommittedThreadId,
              },
            );
            nextWorktreePath = null;
            nextBranch = null;
            nextCreatedBranch = false;
          } else {
            let worktreeToRemove: string | null = null;
            let branchToDelete: GitRefNameValue | null = null;
            const expectedBranch = allocation.branch;

            if (allocation.worktreeCreated) {
              if (allocation.worktreePath !== null) {
                const registeredResult = yield* Effect.result(
                  workspaceBundle
                    .findRegisteredWorktree(allocation.repoRoot, allocation.worktreePath)
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new SessionTransferError({
                            code: "workspace_error",
                            transferId,
                            message: `Failed to inspect registered destination worktrees during ${contextLabel} for transfer '${transferId}': ${cause.message}`,
                            cause,
                          }),
                      ),
                    ),
                );
                if (Result.isFailure(registeredResult)) {
                  worktreeOrBranchFailed = true;
                  failures.push(registeredResult.failure);
                } else {
                  const registeredEntry = registeredResult.success;
                  if (registeredEntry !== null && registeredEntry.isMain) {
                    worktreeOrBranchFailed = true;
                    failures.push(
                      new SessionTransferError({
                        code: "workspace_error",
                        transferId,
                        message: `Refusing to remove main worktree '${allocation.worktreePath}' during ${contextLabel} for transfer '${transferId}'.`,
                      }),
                    );
                  } else if (
                    registeredEntry !== null &&
                    expectedBranch !== null &&
                    registeredEntry.branch !== expectedBranch
                  ) {
                    worktreeOrBranchFailed = true;
                    failures.push(
                      new SessionTransferError({
                        code: "workspace_error",
                        transferId,
                        message: `Refusing to remove destination worktree '${allocation.worktreePath}' during ${contextLabel} for transfer '${transferId}' because it is checked out on branch '${registeredEntry.branch ?? "(detached)"}' instead of expected '${expectedBranch}'.`,
                      }),
                    );
                  } else {
                    worktreeToRemove = allocation.worktreePath;
                    branchToDelete =
                      allocation.createdBranch && allocation.branch !== null
                        ? allocation.branch
                        : null;
                  }
                }
              } else {
                branchToDelete =
                  allocation.createdBranch && allocation.branch !== null ? allocation.branch : null;
              }
            } else if (allocation.worktreePath !== null) {
              // worktreeCreated !== true: require !isMain AND exact branch match in git worktree
              // registration before removing EITHER the worktree OR the branch; otherwise treat
              // both as not owned by this transfer and only clear this transfer's ownership record.
              const registeredResult = yield* Effect.result(
                workspaceBundle
                  .findRegisteredWorktree(allocation.repoRoot, allocation.worktreePath)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new SessionTransferError({
                          code: "workspace_error",
                          transferId,
                          message: `Failed to inspect registered destination worktrees during ${contextLabel} for transfer '${transferId}': ${cause.message}`,
                          cause,
                        }),
                    ),
                  ),
              );
              if (Result.isFailure(registeredResult)) {
                worktreeOrBranchFailed = true;
                failures.push(registeredResult.failure);
              } else {
                const registeredEntry = registeredResult.success;
                const matchesOwnedWorktree =
                  registeredEntry !== null &&
                  !registeredEntry.isMain &&
                  expectedBranch !== null &&
                  registeredEntry.branch === expectedBranch;
                if (matchesOwnedWorktree) {
                  worktreeToRemove = allocation.worktreePath;
                  if (allocation.createdBranch && allocation.branch !== null) {
                    branchToDelete = allocation.branch;
                    // Positively verified that this transfer bound createdBranch to worktreePath.
                    nextWorktreeCreated = true;
                  } else {
                    nextBranch = null;
                    nextCreatedBranch = false;
                  }
                } else {
                  if (registeredEntry !== null) {
                    yield* Effect.logWarning(
                      `Skipping removal of destination worktree/branch during ${contextLabel} because registered worktree does not match this uncreated transfer allocation.`,
                      {
                        transferId,
                        worktreePath: allocation.worktreePath,
                        expectedBranch,
                        registeredBranch: registeredEntry.branch,
                        registeredIsMain: registeredEntry.isMain,
                      },
                    );
                  }
                  // Neither worktreePath nor createdBranch was created/bound by this transfer.
                  nextWorktreePath = null;
                  nextBranch = null;
                  nextCreatedBranch = false;
                }
              }
            } else {
              // worktreeCreated !== true and no worktreePath to verify: never touch branch.
              nextBranch = null;
              nextCreatedBranch = false;
            }

            if (!worktreeOrBranchFailed && worktreeToRemove !== null) {
              const worktreeResult = yield* Effect.result(
                workspaceBundle
                  .removeWorktree({
                    repoCwd: allocation.repoRoot,
                    worktreePath: worktreeToRemove,
                    expectedBranch,
                    allowUnregisteredGitWorktreeFallback: allocation.worktreeCreated,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new SessionTransferError({
                          code: "workspace_error",
                          transferId,
                          message: `Failed to remove destination worktree during ${contextLabel} for transfer '${transferId}': ${cause.message}`,
                          cause,
                        }),
                    ),
                  ),
              );
              if (Result.isSuccess(worktreeResult)) {
                cleanedWorktree = true;
                nextWorktreePath = null;
                if (branchToDelete === null) {
                  nextBranch = null;
                }
              } else {
                worktreeOrBranchFailed = true;
                failures.push(worktreeResult.failure);
              }
            }

            if (!worktreeOrBranchFailed && branchToDelete !== null) {
              const branchResult = yield* Effect.result(
                workspaceBundle
                  .removeWorktree({
                    repoCwd: allocation.repoRoot,
                    branch: branchToDelete,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new SessionTransferError({
                          code: "workspace_error",
                          transferId,
                          message: `Failed to delete destination branch '${branchToDelete}' during ${contextLabel} for transfer '${transferId}': ${cause.message}`,
                          cause,
                        }),
                    ),
                  ),
              );
              if (Result.isSuccess(branchResult)) {
                cleanedWorktree = true;
                nextBranch = null;
                nextCreatedBranch = false;
              } else {
                worktreeOrBranchFailed = true;
                failures.push(branchResult.failure);
              }
            }
          }
        }

        if (!worktreeOrBranchFailed) {
          const ownershipResult = yield* Effect.result(removeWorktreeOwnership(transferId));
          if (Result.isSuccess(ownershipResult)) {
            removedOwnership = ownershipResult.success;
          } else {
            failures.push(ownershipResult.failure);
          }
        } else if (
          persistedOwnership !== null &&
          (nextWorktreePath !== persistedOwnership.worktreePath ||
            nextBranch !== persistedOwnership.branch ||
            nextCreatedBranch !== persistedOwnership.createdBranch ||
            nextWorktreeCreated !== persistedOwnershipWorktreeCreated(persistedOwnership))
        ) {
          yield* writeWorktreeOwnership({
            ...persistedOwnership,
            repoRoot: allocation.repoRoot,
            gitCommonDir: allocation.gitCommonDir,
            worktreePath: nextWorktreePath,
            branch: nextBranch,
            createdBranch: nextCreatedBranch,
            worktreeCreated: nextWorktreeCreated,
            importCompleted: nextWorktreePath === null ? false : persistedOwnership.importCompleted,
          }).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning(
                `Failed to update persisted worktree ownership after partial ${contextLabel} cleanup.`,
                { transferId, cause },
              ),
            ),
            Effect.ignore,
          );
        }

        const remainingAllocation: StagedWorktreeAllocation | null =
          !worktreeOrBranchFailed && failures.length === 0
            ? null
            : {
                repoRoot: allocation.repoRoot,
                gitCommonDir: allocation.gitCommonDir,
                worktreePath: nextWorktreePath,
                branch: nextBranch,
                createdBranch: nextCreatedBranch,
                worktreeCreated: nextWorktreeCreated,
                importCompleted: nextWorktreePath === null ? false : allocation.importCompleted,
              };

        // Synchronously update in-memory stagedImports immediately upon cleanup (both success and
        // partial failure) so a stale in-memory allocation can NEVER outlive on-disk cleanup if a
        // subsequent fallible operation (e.g. URL signing or attachment cleanup) fails or interrupts.
        yield* syncStagedWorktreeAllocation(transferId, remainingAllocation);

        return {
          cleanedWorktree,
          removedOwnership,
          worktreeOrBranchFailed,
          remainingAllocation,
          failures,
        } satisfies CleanupUncommittedAllocationResult;
      }),
      { gitCommonDir: allocation.gitCommonDir },
    );
  });

  const transferLockKey = (transferId: SessionTransferId): string => `transfer:${transferId}`;
  const threadLockKey = (threadId: ThreadId): string => `thread:${threadId}`;

  const withKeyedLocks = <A, E, R>(
    rawKeys: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    const sortedKeys = [...new Set(rawKeys)].toSorted();
    return sortedKeys.reduceRight(
      (inner, lockKey) =>
        Effect.suspend(() => {
          let entry = destinationLocks.get(lockKey);
          if (entry === undefined) {
            entry = { semaphore: Semaphore.makeUnsafe(1), activeCount: 0 };
            destinationLocks.set(lockKey, entry);
          }
          entry.activeCount += 1;
          const lockedEntry = entry;
          return lockedEntry.semaphore
            .withPermits(1)(inner)
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  lockedEntry.activeCount -= 1;
                  if (
                    lockedEntry.activeCount === 0 &&
                    destinationLocks.get(lockKey) === lockedEntry
                  ) {
                    destinationLocks.delete(lockKey);
                  }
                }),
              ),
            );
        }),
      effect,
    );
  };

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

  // Never swallow projection-read errors as "settled"; propagate them so live execution is never exported.
  const isThreadSettled = (threadId: ThreadId) =>
    projectionStore
      .getThreadRecords(threadId, ["runs", "attempts", "providerTurns"])
      .pipe(Effect.map((records) => !isProjectionLive(records)));

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

  const refreshPreparedSourceDownloadUrls = Effect.fn(
    "SessionTransferEndpointService.refreshPreparedSourceDownloadUrls",
  )(function* (
    transferId: SessionTransferId,
    existingPrepared: SessionTransferPrepareSourceResult,
  ) {
    let bundleDownloadRelativeUrl = existingPrepared.bundleDownloadRelativeUrl;
    let bundleExpiresAt = existingPrepared.bundleExpiresAt;

    if (existingPrepared.manifest.workspace.mode === "git_bundle") {
      const freshBundleUrl = yield* runWithAssetContext(
        issueSessionTransferBundleUrl({
          transferId,
          operation: "download",
          ...(existingPrepared.manifest.workspace.bundleSizeBytes !== null
            ? {
                maxBytes: existingPrepared.manifest.workspace.bundleSizeBytes,
                expectedSizeBytes: existingPrepared.manifest.workspace.bundleSizeBytes,
              }
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
              transferId,
              message: cause.message,
              cause,
            }),
        ),
      );
      bundleDownloadRelativeUrl = TrimmedNonEmptyString.make(freshBundleUrl.relativeUrl);
      bundleExpiresAt = freshBundleUrl.expiresAt;
    }

    const refreshedAttachments: SessionTransferAttachmentRef[] = [];
    for (const attachment of existingPrepared.manifest.attachments) {
      const hasAttachmentFile =
        attachment.downloadRelativeUrl !== undefined ||
        resolveAttachmentPathById({
          attachmentsDir: serverConfig.attachmentsDir,
          attachmentId: attachment.attachmentId,
        }) !== null;
      if (!hasAttachmentFile) {
        refreshedAttachments.push(attachment);
        continue;
      }

      const freshAsset = yield* runWithAssetContext(
        issueSessionTransferAttachmentDownloadUrl({
          attachmentId: attachment.attachmentId,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SessionTransferError({
              code: "attachment_error",
              transferId,
              message: `Failed to refresh download URL for attachment '${attachment.name}': ${cause.message}`,
              cause,
            }),
        ),
      );

      refreshedAttachments.push({
        ...attachment,
        downloadRelativeUrl: TrimmedNonEmptyString.make(freshAsset.relativeUrl),
      });
    }

    const refreshed: SessionTransferPrepareSourceResult = {
      manifest: {
        ...existingPrepared.manifest,
        attachments: refreshedAttachments,
      },
      bundleDownloadRelativeUrl,
      bundleExpiresAt,
    };
    yield* Ref.update(preparedSources, (map) => {
      const next = new Map(map);
      next.set(transferId, refreshed);
      return next;
    });
    return refreshed;
  });

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
    const attemptId = yield* secureRandom.uuidV4();

    // Atomically inspect and acquire/check source lock guarding BOTH threadId AND transferId.
    type SourceLockOutcome =
      | "conflict_other"
      | "conflict_transfer_id"
      | "conflict_preparing"
      | "prepared"
      | "acquired";
    const lockOutcome: SourceLockOutcome = yield* Ref.modify(
      sourceLocks,
      (current): readonly [SourceLockOutcome, Map<ThreadId, SourceLockEntry>] => {
        for (const [lockedThreadId, entry] of current) {
          if (lockedThreadId !== input.threadId && entry.transferId === input.transferId) {
            return ["conflict_transfer_id", current];
          }
        }
        const holder = current.get(input.threadId);
        if (holder !== undefined) {
          if (holder.transferId !== input.transferId) {
            return ["conflict_other", current];
          }
          if (holder.phase === "preparing" || holder.phase === "cleaning") {
            return ["conflict_preparing", current];
          }
          return ["prepared", current];
        }
        const next = new Map(current);
        next.set(input.threadId, {
          transferId: input.transferId,
          attemptId,
          phase: "preparing",
        });
        return ["acquired", next];
      },
    );

    if (lockOutcome === "conflict_transfer_id") {
      return yield* new SessionTransferError({
        code: "already_in_flight",
        transferId: input.transferId,
        message: `Session transfer '${input.transferId}' is already in flight for another source thread.`,
      });
    }

    if (lockOutcome === "conflict_other") {
      return yield* new SessionTransferError({
        code: "already_in_flight",
        transferId: input.transferId,
        message: `Thread '${input.threadId}' already has an in-flight session transfer.`,
      });
    }

    if (lockOutcome === "conflict_preparing") {
      return yield* new SessionTransferError({
        code: "already_in_flight",
        transferId: input.transferId,
        message: `Session transfer '${input.transferId}' for thread '${input.threadId}' is already being prepared.`,
      });
    }

    if (lockOutcome === "prepared") {
      const existingPrepared = (yield* Ref.get(preparedSources)).get(input.transferId);
      if (
        existingPrepared !== undefined &&
        existingPrepared.manifest.sourceThreadId === input.threadId
      ) {
        let bundleStillPresent = true;
        if (existingPrepared.manifest.workspace.mode === "git_bundle") {
          const exportPath = resolveExportBundlePath(serverConfig.stateDir, input.transferId, path);
          bundleStillPresent =
            exportPath !== null &&
            (yield* fileSystem.exists(exportPath).pipe(Effect.orElseSucceed(() => false)));
        }
        if (bundleStillPresent) {
          return yield* refreshPreparedSourceDownloadUrls(input.transferId, existingPrepared);
        }
      }

      // Prepared staging bundle disappeared externally: atomically re-claim preparing phase.
      const reclaimed = yield* Ref.modify(sourceLocks, (current) => {
        for (const [lockedThreadId, entry] of current) {
          if (lockedThreadId !== input.threadId && entry.transferId === input.transferId) {
            return [false, current] as const;
          }
        }
        const holder = current.get(input.threadId);
        if (
          holder !== undefined &&
          (holder.transferId !== input.transferId || holder.phase !== "prepared")
        ) {
          return [false, current] as const;
        }
        const next = new Map(current);
        next.set(input.threadId, {
          transferId: input.transferId,
          attemptId,
          phase: "preparing",
        });
        return [true, next] as const;
      });
      if (!reclaimed) {
        return yield* new SessionTransferError({
          code: "already_in_flight",
          transferId: input.transferId,
          message: `Session transfer '${input.transferId}' for thread '${input.threadId}' is already being prepared.`,
        });
      }
    }

    // Remove staging files and cache entries BEFORE releasing the source lock so an immediate
    // retry cannot race with cleanup deleting files underneath it. Run the entire cleaning
    // sequence uninterruptibly so staging deletion always finishes before releasing the lock
    // and resolving cleanupDeferred.
    const cleanupOnOwnError = Effect.uninterruptible(
      Effect.gen(function* () {
        const cleanupDeferred = yield* Deferred.make<void, SessionTransferError>();
        const owned = yield* Ref.modify(sourceLocks, (current) => {
          const holder = current.get(input.threadId);
          if (
            holder === undefined ||
            holder.attemptId !== attemptId ||
            holder.phase === "cleaning"
          ) {
            return [false, current] as const;
          }
          const next = new Map(current);
          next.set(input.threadId, {
            transferId: holder.transferId,
            attemptId: holder.attemptId,
            phase: "cleaning",
            cleanupDeferred,
          });
          return [true, next] as const;
        });
        if (!owned) return;

        yield* runSourceCleanupUninterruptible({
          transferId: input.transferId,
          cleanupDeferred,
          releaseLock: Ref.update(sourceLocks, (current) => {
            const holder = current.get(input.threadId);
            if (holder === undefined || holder.attemptId !== attemptId) {
              return current;
            }
            const next = new Map(current);
            next.delete(input.threadId);
            return next;
          }),
          runCleanup: Effect.gen(function* () {
            yield* Ref.update(preparedSources, (current) => {
              const existing = current.get(input.transferId);
              if (existing === undefined || existing.manifest.sourceThreadId !== input.threadId) {
                return current;
              }
              const next = new Map(current);
              next.delete(input.transferId);
              return next;
            });
            yield* cleanupSourceStagingDir(input.transferId);
          }),
        }).pipe(
          // Preserve prepareSource's original error cause; any staging deletion failure has
          // already been logged and propagated to cleanupDeferred waiters.
          Effect.ignore,
        );
      }),
    );

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

      const alreadyEndedBeforeStopRunIds = new Set<RunId>(
        projection.runs
          .filter((run) => ThreadManagementService.isTerminalRunStatus(run.status))
          .map((run) => run.id),
      );
      const wasRunning = isProjectionLive(projection);
      const initialPendingRequests = collectPendingRequestsFromProjection(
        projection,
        new Set<RunId>(),
      );
      const activeSubagentCount = projection.subagents.filter((sub) =>
        ACTIVE_SUBAGENT_STATUSES.has(sub.status),
      ).length;

      const key = transferIdKey(input.transferId);

      // Pause active execution and hold queued runs before snapshotting state.
      if (wasRunning || initialPendingRequests.length > 0 || activeSubagentCount > 0) {
        yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`xfer-stop:${key}`),
            threadId: input.threadId,
            reason: "Paused for session transfer.",
          })
          .pipe(Effect.ignore);

        const settled = yield* awaitThreadSettled(input.threadId, SOURCE_SETTLE_TIMEOUT_MS).pipe(
          Effect.mapError(
            (cause) =>
              new SessionTransferError({
                code: "internal",
                transferId: input.transferId,
                message: `Failed to verify settlement of source thread '${input.threadId}': ${cause.message}`,
                cause,
              }),
          ),
        );
        if (!settled) {
          yield* threadManagement
            .forceStopThread({
              threadId: input.threadId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SessionTransferError({
                    code: "internal",
                    transferId: input.transferId,
                    message: `Failed to force-stop active source thread '${input.threadId}': ${cause.message}`,
                    cause,
                  }),
              ),
            );
        }

        // Re-read fresh projection after settling so exported history includes everything up to pause.
        projection = yield* projectionStore.getThreadProjection(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new SessionTransferError({
                code: "internal",
                transferId: input.transferId,
                message: `Failed to reload settled source thread '${input.threadId}': ${cause.message}`,
                cause,
              }),
          ),
        );

        // Never export while live execution continues.
        if (isProjectionLive(projection)) {
          return yield* new SessionTransferError({
            code: "internal",
            transferId: input.transferId,
            message: `Source thread '${input.threadId}' is still running after stop and force-stop; refusing to export live execution.`,
          });
        }
      }

      // Count any run that was not already terminal before stop and ended up interrupted/cancelled
      // (including queued -> running -> stopped) as stopped by this transfer, ignoring historical
      // cancelled secrets from already-terminal runs.
      const stoppedRunIds = new Set<RunId>();
      for (const run of projection.runs) {
        if (!alreadyEndedBeforeStopRunIds.has(run.id) && STOPPED_RUN_STATUSES.has(run.status)) {
          stoppedRunIds.add(run.id);
        }
      }
      const pendingRuntimeRequests = collectPendingRequestsFromProjection(
        projection,
        stoppedRunIds,
      );
      const hadPendingRuntimeRequest = pendingRuntimeRequests.length > 0;

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
            ...(message?.context !== undefined ? { context: message.context } : {}),
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
              expectedSizeBytes: exported.bundleSizeBytes,
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
      yield* Ref.update(sourceLocks, (current) => {
        const holder = current.get(input.threadId);
        if (
          holder === undefined ||
          holder.attemptId !== attemptId ||
          holder.phase !== "preparing"
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(input.threadId, {
          transferId: holder.transferId,
          attemptId: holder.attemptId,
          phase: "prepared",
        });
        return next;
      });
      return result;
    }).pipe(Effect.onError(() => cleanupOnOwnError));
  });

  const stageImport: SessionTransferEndpointServiceShape["stageImport"] = Effect.fn(
    "SessionTransferEndpointService.stageImport",
  )(function* (input) {
    return yield* withKeyedLocks(
      [transferLockKey(input.transferId)],
      Effect.gen(function* () {
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

        let targetGitCommonDir: string | null = null;
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
          targetGitCommonDir = yield* workspaceBundle
            .resolveGitCommonDir(project.workspaceRoot)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SessionTransferError({
                    code: "workspace_error",
                    transferId: input.transferId,
                    message: `Failed to inspect Git repository for destination project '${project.title}' at '${project.workspaceRoot}': ${cause.message}`,
                    cause,
                  }),
              ),
            );
          if (targetGitCommonDir === null) {
            return yield* new SessionTransferError({
              code: "workspace_error",
              transferId: input.transferId,
              message: `Destination project '${project.title}' at '${project.workspaceRoot}' is not a Git repository.`,
            });
          }
        }

        // Reconcile any existing in-memory or persisted allocation for this transferId.
        // If restaging against a DIFFERENT repository, clean up the old allocation strictly
        // against its own repoRoot/gitCommonDir first and fail stageImport if cleanup fails so a
        // cross-repo ownership record is never silently orphaned or mixed with the new project.
        const persistedOwnership = yield* readWorktreeOwnership(input.transferId);
        const existingAllocation = resolveExistingAllocation(persistedOwnership, existingStaged);
        let nextWorktreeAllocation: StagedWorktreeAllocation | null = null;
        if (existingAllocation !== null) {
          const sameRepo =
            input.manifest.workspace.mode === "git_bundle" &&
            (yield* isSameGitRepository(existingAllocation, targetGitCommonDir));
          if (sameRepo) {
            nextWorktreeAllocation = existingAllocation;
          } else {
            const alreadyCommitted = yield* isTransferAlreadyCommitted(
              input.transferId,
              existingStaged,
              persistedOwnership,
            );
            if (alreadyCommitted) {
              nextWorktreeAllocation = existingAllocation;
            } else {
              const cleanupResult = yield* cleanupUncommittedAllocation({
                transferId: input.transferId,
                allocation: existingAllocation,
                persistedOwnership,
                contextLabel: "cross-repository restaging",
              });
              if (cleanupResult.failures.length > 0) {
                const [firstFailure, ...restFailures] = cleanupResult.failures;
                for (const extraFailure of restFailures) {
                  yield* Effect.logWarning(
                    "Additional cleanup failure while cleaning previous repository allocation during restaging.",
                    { transferId: input.transferId, cause: extraFailure },
                  );
                }
                return yield* firstFailure!;
              }
              nextWorktreeAllocation = null;
            }
          }
        }

        let bundleUploadRelativeUrl: TrimmedNonEmptyStringValue | null = null;
        let bundleUploadExpiresAt: IsoDateTime | null = null;
        if (input.manifest.workspace.mode === "git_bundle") {
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

          const uploadTarget = yield* runWithAssetContext(
            issueAttachmentUploadUrl(uploadInput),
          ).pipe(
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

        const updatedStaged = yield* Ref.modify(stagedImports, (map) => {
          const prev = map.get(input.transferId);
          const nextState: StagedImportState = {
            transferId: input.transferId,
            destinationProjectId: project.id,
            projectWorkspaceRoot: project.workspaceRoot,
            destinationThreadId: prev?.destinationThreadId ?? destinationThreadId,
            resolvedModelSelection,
            attachmentUploads,
            claimedAttachmentIds: prev?.claimedAttachmentIds ?? {},
            warnings,
            worktreeAllocation: nextWorktreeAllocation,
            committed: prev?.committed ?? false,
            handoffComplete: prev?.handoffComplete ?? false,
            committedResult: prev?.committedResult ?? null,
          };
          const next = new Map(map);
          next.set(input.transferId, nextState);
          return [nextState, next] as const;
        });

        const stagedWorktreePath = updatedStaged.worktreeAllocation?.worktreePath ?? null;
        return {
          destinationProjectId: project.id,
          destinationThreadId: updatedStaged.destinationThreadId,
          destinationBranch: updatedStaged.worktreeAllocation?.branch ?? null,
          destinationWorktreePath:
            stagedWorktreePath !== null ? TrimmedNonEmptyString.make(stagedWorktreePath) : null,
          resolvedModelSelection,
          bundleUploadRelativeUrl,
          bundleUploadExpiresAt,
          attachmentUploads,
          warnings,
        } satisfies SessionTransferStageImportResult;
      }),
    );
  });

  const completePostCommitHandoff = Effect.fn(
    "SessionTransferEndpointService.completePostCommitHandoff",
  )(function* (input: {
    readonly transferId: SessionTransferId;
    readonly manifest: SessionTransferManifest;
    readonly projectId: SessionTransferCommitImportInput["destinationProjectId"];
    readonly destinationThreadId: ThreadId;
    readonly resolvedModelSelection: ModelSelection;
    readonly shouldAutoResume: boolean;
    readonly warnings: Array<string>;
  }) {
    const key = transferIdKey(input.transferId);
    const resumeMessageId = MessageId.make(`xfer-resume-msg:${key}`);
    const resumeCommandId = CommandId.make(`xfer-resume:${key}`);
    const queuedRunPrefix = `xfer-qrun:${key}:`;

    let resumed = false;
    let releasedAllQueued = true;
    if (input.shouldAutoResume) {
      const records = yield* projectionStore
        .getThreadRecords(input.destinationThreadId, ["runs", "messages"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new SessionTransferError({
                code: "internal",
                transferId: input.transferId,
                message: `Failed to inspect committed thread '${input.destinationThreadId}' for post-commit handoff: ${cause.message}`,
                cause,
              }),
          ),
        );

      const continuationAlreadyStarted =
        records.messages.some((message) => message.id === resumeMessageId) ||
        records.runs.some((run) => run.userMessageId === resumeMessageId);

      if (continuationAlreadyStarted) {
        resumed = true;
      } else {
        const resumeResult = yield* Effect.result(
          threadManagement.sendToThread({
            projectId: input.projectId,
            commandId: resumeCommandId,
            threadId: input.destinationThreadId,
            messageId: resumeMessageId,
            text: buildAutoResumePrompt(input.manifest),
            attachments: [],
            modelSelection: input.resolvedModelSelection,
            mode: "auto",
            createdBy: "system",
            creationSource: "server",
          }),
        );
        if (Result.isSuccess(resumeResult)) {
          resumed = true;
        } else {
          input.warnings.push(
            `Imported thread was committed, but automatic continuation turn could not start: ${resumeResult.failure.message}`,
          );
        }
      }

      // Release persisted transfer queued runs (queueHeld: true -> false) once the continuation
      // run is started, so they execute cleanly in order right behind it without duplicating runs.
      if (resumed) {
        const latestRecords = continuationAlreadyStarted
          ? records
          : yield* projectionStore
              .getThreadRecords(input.destinationThreadId, ["runs"])
              .pipe(Effect.orElseSucceed(() => records));
        const heldTransferRuns = latestRecords.runs.filter(
          (run) =>
            run.status === "queued" && run.queueHeld === true && run.id.startsWith(queuedRunPrefix),
        );
        if (heldTransferRuns.length > 0) {
          const releasedAt = yield* DateTime.now;
          const releaseEvents: OrchestrationV2DomainEvent[] = heldTransferRuns.map((run) => ({
            id: EventId.make(`xfer:${key}:release-queued-run:${run.id}`),
            type: "run.updated",
            threadId: input.destinationThreadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: releasedAt,
            payload: {
              ...run,
              queueHeld: false,
            },
          }));
          yield* eventSink.write({ events: releaseEvents }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                releasedAllQueued = false;
                input.warnings.push(
                  `Failed to release held queued prompts after continuation: ${cause.message}`,
                );
              }),
            ),
          );
        }
      }
    }

    // Clean up temporary imported bundle staging file after commit.
    yield* runWithAssetContext(cleanupTransferStagingDir(input.transferId)).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning(
          "Failed to clean up session transfer staging directory after commitImport.",
          { transferId: input.transferId, cause },
        ),
      ),
      Effect.ignore,
    );

    return {
      resumed,
      handoffComplete: !input.shouldAutoResume || (resumed && releasedAllQueued),
    };
  });

  const commitImport: SessionTransferEndpointServiceShape["commitImport"] = Effect.fn(
    "SessionTransferEndpointService.commitImport",
  )(function* (input) {
    return yield* withKeyedLocks(
      [transferLockKey(input.transferId), threadLockKey(input.destinationThreadId)],
      Effect.gen(function* () {
        const hasPendingSecretInManifest = input.manifest.turnItems.some(
          (item) => item.type === "secret_request" && item.secretStatus === "pending",
        );
        const hadPendingRequest =
          input.manifest.sourceState.hadPendingRuntimeRequest ||
          input.manifest.sourceState.pendingRuntimeRequests.length > 0 ||
          hasPendingSecretInManifest;
        const shouldAutoResume =
          input.manifest.sourceState.wasRunning && !hadPendingRequest && input.autoResume;

        // 1. In-memory idempotency check (short-circuit only when post-commit handoff already succeeded).
        const existingStaged = (yield* Ref.get(stagedImports)).get(input.transferId);
        if (
          existingStaged?.committed &&
          existingStaged.committedResult !== null &&
          (!shouldAutoResume ||
            (existingStaged.committedResult.resumed && existingStaged.handoffComplete))
        ) {
          return existingStaged.committedResult;
        }

        // 2. Durable SQLite check: detect conflict vs idempotent replay (including crash recovery).
        const existingThread = yield* projectionStore
          .getThreadRecords(input.destinationThreadId, [])
          .pipe(
            Effect.asSome,
            Effect.catchTags({
              ProjectionStoreThreadNotFoundError: () => Effect.succeedNone,
            }),
            Effect.mapError(
              (cause) =>
                new SessionTransferError({
                  code: "internal",
                  transferId: input.transferId,
                  message: `Failed to inspect destination thread '${input.destinationThreadId}': ${cause.message}`,
                  cause,
                }),
            ),
          );

        if (Option.isSome(existingThread)) {
          const thread = existingThread.value.thread;
          if (thread.transferOrigin?.transferId !== input.transferId) {
            return yield* new SessionTransferError({
              code: "invalid_phase",
              transferId: input.transferId,
              message: `Destination thread '${input.destinationThreadId}' already exists and belongs to a different transfer or thread.`,
            });
          }

          const replayWarnings: string[] = [];
          yield* removeWorktreeOwnershipBestEffort(input.transferId);

          const { resumed, handoffComplete } = yield* completePostCommitHandoff({
            transferId: input.transferId,
            manifest: input.manifest,
            projectId: thread.projectId,
            destinationThreadId: thread.id,
            resolvedModelSelection: thread.modelSelection,
            shouldAutoResume,
            warnings: replayWarnings,
          });

          const replayedResult: SessionTransferCommitImportResult = {
            destinationProjectId: thread.projectId,
            destinationThreadId: thread.id,
            destinationBranch: thread.branch,
            destinationWorktreePath: thread.worktreePath,
            resumed,
            warnings: replayWarnings,
          };

          yield* Ref.update(stagedImports, (map) => {
            const next = new Map(map);
            const prev = next.get(input.transferId);
            next.set(input.transferId, {
              transferId: input.transferId,
              destinationProjectId: thread.projectId,
              projectWorkspaceRoot: prev?.projectWorkspaceRoot ?? "",
              destinationThreadId: thread.id,
              resolvedModelSelection: thread.modelSelection,
              attachmentUploads: prev?.attachmentUploads ?? [],
              claimedAttachmentIds: prev?.claimedAttachmentIds ?? {},
              warnings: replayWarnings,
              worktreeAllocation:
                prev?.worktreeAllocation ??
                (thread.worktreePath !== null
                  ? {
                      repoRoot: prev?.projectWorkspaceRoot ?? "",
                      gitCommonDir: null,
                      worktreePath: thread.worktreePath,
                      branch: thread.branch,
                      createdBranch: false,
                      worktreeCreated: true,
                      importCompleted: true,
                    }
                  : null),
              committed: true,
              handoffComplete,
              committedResult: replayedResult,
            });
            return next;
          });

          return replayedResult;
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
        let createdBranch = existingStaged?.worktreeAllocation?.createdBranch ?? false;

        // 3. Apply uploaded git workspace bundle into a fresh isolated worktree,
        //    reusing an already-created worktree ONLY when importCompleted === true AND it belongs
        //    to the same destination repository.
        if (input.manifest.workspace.mode === "git_bundle") {
          const persistedOwnership = yield* readWorktreeOwnership(input.transferId);
          const existingAllocation = resolveExistingAllocation(persistedOwnership, existingStaged);
          const targetGitCommonDir = yield* workspaceBundle
            .resolveGitCommonDir(project.workspaceRoot)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SessionTransferError({
                    code: "workspace_error",
                    transferId: input.transferId,
                    message: `Failed to resolve Git repository for destination project '${project.title}': ${cause.message}`,
                    cause,
                  }),
              ),
            );
          const sameRepoAllocation =
            existingAllocation !== null &&
            (yield* isSameGitRepository(existingAllocation, targetGitCommonDir));

          const canReuseWorktree =
            sameRepoAllocation &&
            existingAllocation.importCompleted &&
            existingAllocation.worktreePath !== null &&
            existingAllocation.branch !== null &&
            (yield* fileSystem
              .exists(existingAllocation.worktreePath)
              .pipe(Effect.orElseSucceed(() => false)));

          if (canReuseWorktree) {
            destinationBranch = existingAllocation.branch;
            destinationWorktreePath = TrimmedNonEmptyString.make(existingAllocation.worktreePath);
            createdBranch = existingAllocation.createdBranch;
          } else {
            // If an earlier interrupted/crashed/incomplete or cross-repo attempt left worktree or
            // branch ownership in memory or on disk, clean it up strictly against its OWN repoRoot
            // and gitCommonDir BEFORE allocating a fresh worktree. Never commit a partial worktree
            // if cleanup fails.
            if (existingAllocation !== null && existingAllocation.repoRoot.length > 0) {
              const cleanupResult = yield* cleanupUncommittedAllocation({
                transferId: input.transferId,
                allocation: existingAllocation,
                persistedOwnership,
                contextLabel: "pre-retry cleanup",
              });
              if (cleanupResult.failures.length > 0) {
                const [firstFailure, ...restFailures] = cleanupResult.failures;
                for (const extraFailure of restFailures) {
                  yield* Effect.logWarning(
                    "Additional cleanup failure during pre-retry destination worktree cleanup.",
                    { transferId: input.transferId, cause: extraFailure },
                  );
                }
                return yield* firstFailure!;
              }
            } else if (persistedOwnership !== null) {
              yield* removeWorktreeOwnership(input.transferId);
              yield* syncStagedWorktreeAllocation(input.transferId, null);
            }
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
                      result.status === "started" &&
                      result.completion !== undefined &&
                      !result.async
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

            const persistAllocationState = (
              allocation: {
                readonly repoCwd: string;
                readonly gitCommonDir: string;
                readonly worktreePath: string;
                readonly branch: string;
                readonly createdBranch: boolean;
              },
              worktreeCreated: boolean,
            ) => {
              const allocatedBranch = GitRefName.make(allocation.branch);
              const stagedAllocation: StagedWorktreeAllocation = {
                repoRoot: allocation.repoCwd,
                gitCommonDir: allocation.gitCommonDir,
                worktreePath: allocation.worktreePath,
                branch: allocatedBranch,
                createdBranch: allocation.createdBranch,
                worktreeCreated,
                importCompleted: false,
              };
              return writeWorktreeOwnership({
                schemaVersion: 1,
                transferId: input.transferId,
                destinationProjectId: project.id,
                projectWorkspaceRoot: allocation.repoCwd,
                repoRoot: allocation.repoCwd,
                gitCommonDir: allocation.gitCommonDir,
                destinationThreadId: input.destinationThreadId,
                worktreePath: allocation.worktreePath,
                branch: allocatedBranch,
                createdBranch: allocation.createdBranch,
                worktreeCreated,
                importCompleted: false,
              }).pipe(
                Effect.andThen(
                  Ref.update(stagedImports, (map) => {
                    const next = new Map(map);
                    const prev = next.get(input.transferId);
                    next.set(input.transferId, {
                      transferId: input.transferId,
                      destinationProjectId: project.id,
                      projectWorkspaceRoot: allocation.repoCwd,
                      destinationThreadId: input.destinationThreadId,
                      resolvedModelSelection,
                      attachmentUploads: prev?.attachmentUploads ?? [],
                      claimedAttachmentIds: prev?.claimedAttachmentIds ?? {},
                      warnings: prev?.warnings ?? [],
                      worktreeAllocation: stagedAllocation,
                      committed: false,
                      handoffComplete: false,
                      committedResult: null,
                    });
                    return next;
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new WorkspaceBundle.WorkspaceBundleError({
                      code: "io_error",
                      message: cause.message,
                      cause,
                    }),
                ),
              );
            };

            const importedWorkspace = yield* workspaceBundle
              .importWorkspaceBundle({
                transferId: input.transferId,
                repoCwd: project.workspaceRoot,
                bundlePath: importBundlePath,
                sourceBranch: input.manifest.workspace.branch,
                targetLabel,
                withWorktreeAllocationLock: (effect, lockCtx) =>
                  withRepoLock(project.workspaceRoot, effect, {
                    gitCommonDir: lockCtx?.gitCommonDir ?? null,
                  }),
                resolveReservedAllocations: ({ gitCommonDir }) =>
                  readReservedWorktreeAllocations({
                    excludeTransferId: input.transferId,
                    gitCommonDir,
                  }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new WorkspaceBundle.WorkspaceBundleError({
                          code: "io_error",
                          message: cause.message,
                          cause,
                        }),
                    ),
                  ),
                onWorktreeAllocated: (allocation) => persistAllocationState(allocation, false),
                onWorktreeCreated: (allocation) => persistAllocationState(allocation, true),
                onWorktreeAllocationCleared: (allocation) =>
                  Effect.result(removeWorktreeOwnership(input.transferId)).pipe(
                    Effect.flatMap((removeRes) => {
                      if (Result.isFailure(removeRes)) {
                        return Effect.logWarning(
                          "Failed to remove worktree ownership record while clearing incomplete allocation.",
                          {
                            transferId: input.transferId,
                            cause: removeRes.failure,
                          },
                        );
                      }
                      return Ref.update(stagedImports, (map) => {
                        const prev = map.get(input.transferId);
                        if (
                          prev === undefined ||
                          prev.worktreeAllocation === null ||
                          prev.worktreeAllocation.worktreePath !== allocation.worktreePath ||
                          prev.worktreeAllocation.importCompleted
                        ) {
                          return map;
                        }
                        const next = new Map(map);
                        next.set(input.transferId, {
                          ...prev,
                          worktreeAllocation: null,
                        });
                        return next;
                      });
                    }),
                  ),
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
            createdBranch = importedWorkspace.createdBranch;
            warnings.push(...importedWorkspace.warnings, ...setupWarnings);

            // Persist completed worktree & branch ownership durably so restarts can reuse or clean up safely.
            yield* writeWorktreeOwnership({
              schemaVersion: 1,
              transferId: input.transferId,
              destinationProjectId: project.id,
              projectWorkspaceRoot: project.workspaceRoot,
              repoRoot: project.workspaceRoot,
              gitCommonDir: importedWorkspace.gitCommonDir,
              destinationThreadId: input.destinationThreadId,
              worktreePath: importedWorkspace.worktreePath,
              branch: destinationBranch,
              createdBranch,
              worktreeCreated: true,
              importCompleted: true,
            });

            // Record completed worktree & branch ownership immediately so retry reuses it and abort cleans safely.
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
                claimedAttachmentIds: prev?.claimedAttachmentIds ?? {},
                warnings: prev?.warnings ?? [],
                worktreeAllocation: {
                  repoRoot: project.workspaceRoot,
                  gitCommonDir: importedWorkspace.gitCommonDir,
                  worktreePath: importedWorkspace.worktreePath,
                  branch: destinationBranch,
                  createdBranch,
                  worktreeCreated: true,
                  importCompleted: true,
                },
                committed: false,
                handoffComplete: false,
                committedResult: null,
              });
              return next;
            });
          }
        }

        // 4. Claim uploaded pending attachments onto destinationThreadId & build oldId -> newId map,
        //    reusing any already-claimed IDs from an earlier attempt that failed during event write.
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
        for (const [sourceId, claimedId] of Object.entries(
          existingStaged?.claimedAttachmentIds ?? {},
        )) {
          claimedIdMap.set(ChatAttachmentId.make(sourceId), claimedId);
        }

        for (const ref of input.manifest.attachments) {
          if (claimedIdMap.has(ref.attachmentId)) {
            continue;
          }
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

        const claimedAttachmentIdsRecord: Record<string, ChatAttachmentId> = Object.fromEntries(
          claimedIdMap.entries(),
        );
        yield* Ref.update(stagedImports, (map) => {
          const prev = map.get(input.transferId);
          if (prev === undefined) return map;
          const next = new Map(map);
          next.set(input.transferId, {
            ...prev,
            claimedAttachmentIds: claimedAttachmentIdsRecord,
          });
          return next;
        });

        // 5. Write full imported thread history + queued runs atomically via EventSinkV2 with
        //    deterministically remapped IDs scoped to destinationThreadId.
        const now = yield* DateTime.now;
        const key = transferIdKey(input.transferId);
        const remapMessageId = (sourceId: MessageId): MessageId =>
          MessageId.make(deterministicScopedId("xfer-msg", input.destinationThreadId, sourceId));
        const remapTurnItemId = (sourceId: TurnItemId): TurnItemId =>
          TurnItemId.make(deterministicScopedId("xfer-ti", input.destinationThreadId, sourceId));
        const remapPlanId = (sourceId: PlanId): PlanId =>
          PlanId.make(deterministicScopedId("xfer-plan", input.destinationThreadId, sourceId));
        const remapNodeId = (sourceId: NodeId): NodeId =>
          NodeId.make(deterministicScopedId("xfer-node", input.destinationThreadId, sourceId));

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
            id: EventId.make(`xfer:${key}:thread.created`),
            type: "thread.created",
            threadId: input.destinationThreadId,
            occurredAt: now,
            payload: importedThread,
          },
        ];

        // Imported conversation messages (excluding held queued run user messages which are persisted below).
        const heldQueuedRunIds = new Set(input.manifest.heldQueuedRuns.map((r) => r.runId));
        for (let i = 0; i < input.manifest.messages.length; i += 1) {
          const sourceMessage = input.manifest.messages[i]!;
          if (sourceMessage.runId !== null && heldQueuedRunIds.has(sourceMessage.runId)) {
            continue;
          }
          const rewrittenContext = rewriteMessageContext(sourceMessage.context, claimedIdMap);
          const rewrittenMessage: OrchestrationV2ConversationMessage = {
            ...sourceMessage,
            id: remapMessageId(sourceMessage.id),
            threadId: input.destinationThreadId,
            runId: null,
            nodeId: sourceMessage.nodeId !== null ? remapNodeId(sourceMessage.nodeId) : null,
            ...(rewrittenContext !== undefined ? { context: rewrittenContext } : {}),
            attachments: rewriteAttachments(sourceMessage.attachments, claimedIdMap),
          };
          events.push({
            id: EventId.make(`xfer:${key}:message:${i}`),
            type: "message.updated",
            threadId: input.destinationThreadId,
            occurredAt: rewrittenMessage.createdAt,
            payload: rewrittenMessage,
          });
        }

        // Imported turn items re-scoped onto destinationThreadId with deterministic remapped IDs
        // and cross-references (messageId, planId, parentItemId, attachments, questionAnswer).
        for (let i = 0; i < input.manifest.turnItems.length; i += 1) {
          const sourceItem = input.manifest.turnItems[i]!;
          if (sourceItem.runId !== null && heldQueuedRunIds.has(sourceItem.runId)) {
            continue;
          }
          const baseRewritten = {
            ...sourceItem,
            id: remapTurnItemId(sourceItem.id),
            threadId: input.destinationThreadId,
            runId: null,
            nodeId: sourceItem.nodeId !== null ? remapNodeId(sourceItem.nodeId) : null,
            providerThreadId: null,
            providerTurnId: null,
            parentItemId:
              sourceItem.parentItemId !== null ? remapTurnItemId(sourceItem.parentItemId) : null,
          };

          let rewrittenItem: OrchestrationV2TurnItem;
          if (sourceItem.type === "user_message") {
            const rewrittenContext = rewriteMessageContext(sourceItem.context, claimedIdMap);
            rewrittenItem = {
              ...baseRewritten,
              messageId: remapMessageId(sourceItem.messageId),
              ...(rewrittenContext !== undefined ? { context: rewrittenContext } : {}),
              attachments: rewriteAttachments(sourceItem.attachments, claimedIdMap),
            } as OrchestrationV2TurnItem;
          } else if (sourceItem.type === "assistant_message") {
            rewrittenItem = {
              ...baseRewritten,
              messageId: remapMessageId(sourceItem.messageId),
              ...(sourceItem.attachments !== undefined
                ? { attachments: rewriteAttachments(sourceItem.attachments, claimedIdMap) }
                : {}),
            } as OrchestrationV2TurnItem;
          } else if (sourceItem.type === "proposed_plan" || sourceItem.type === "todo_list") {
            rewrittenItem = {
              ...baseRewritten,
              planId: remapPlanId(sourceItem.planId),
            } as OrchestrationV2TurnItem;
          } else if (
            sourceItem.type === "user_input_request" &&
            sourceItem.questionAnswer !== undefined
          ) {
            rewrittenItem = {
              ...baseRewritten,
              questionAnswer: rewriteQuestionAnswerAttachments(
                sourceItem.questionAnswer,
                claimedIdMap,
              ),
            } as OrchestrationV2TurnItem;
          } else {
            rewrittenItem = baseRewritten as OrchestrationV2TurnItem;
          }

          events.push({
            id: EventId.make(`xfer:${key}:turn-item:${i}`),
            type: "turn-item.updated",
            threadId: input.destinationThreadId,
            occurredAt: rewrittenItem.updatedAt,
            payload: rewrittenItem,
          });
        }

        // Imported plans with deterministic remapped IDs.
        for (let i = 0; i < input.manifest.plans.length; i += 1) {
          const plan = input.manifest.plans[i]!;
          events.push({
            id: EventId.make(`xfer:${key}:plan:${i}`),
            type: "plan.updated",
            threadId: input.destinationThreadId,
            occurredAt: now,
            payload: {
              ...plan,
              id: remapPlanId(plan.id),
              threadId: input.destinationThreadId,
              runId: null,
              nodeId: remapNodeId(plan.nodeId),
            },
          });
        }

        // Context handoff artifact carrying full_thread_summary + transfer context note.
        const transferContextSummary = buildTransferContextNote({
          manifest: input.manifest,
          destinationBranch,
        });
        const contextHandoff: OrchestrationV2ContextHandoff = {
          id: ContextHandoffId.make(`xfer-handoff:${key}`),
          transferId: null,
          threadId: input.destinationThreadId,
          targetRunId: RunId.make(`xfer-target-run:${key}`),
          fromProviderThreadIds: [],
          toProviderThreadId: ProviderThreadId.make(`xfer-provider-thread:${key}`),
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
          id: EventId.make(`xfer:${key}:context-handoff`),
          type: "context-handoff.updated",
          threadId: input.destinationThreadId,
          occurredAt: now,
          payload: contextHandoff,
        });

        // Always persist held queued runs atomically in the SAME event batch (with queueHeld: true)
        // so queued prompts are never lost if a crash occurs before post-commit handoff completes.
        if (input.manifest.heldQueuedRuns.length > 0) {
          const placeholderProviderThreads = new Map<string, ProviderThreadId>();
          for (let i = 0; i < input.manifest.heldQueuedRuns.length; i += 1) {
            const queued = input.manifest.heldQueuedRuns[i]!;
            const queuedMessageId = MessageId.make(`xfer-qmsg:${key}:${i}`);
            const queuedRunId = RunId.make(`xfer-qrun:${key}:${i}`);
            const queuedNodeId = NodeId.make(`xfer-qnode:${key}:${i}`);
            const queuedAttemptId = RunAttemptId.make(`xfer-qatt:${key}:${i}`);
            const requestedAt = DateTime.makeUnsafe(queued.requestedAt);
            const queuedAttachments = rewriteAttachments(queued.attachments, claimedIdMap);
            const queuedContext = rewriteMessageContext(queued.context, claimedIdMap);
            const queuedSelection: ModelSelection =
              queued.modelSelection === null || queued.modelSelection === undefined
                ? resolvedModelSelection
                : queued.modelSelection.instanceId === input.manifest.modelSelection.instanceId
                  ? {
                      ...resolvedModelSelection,
                      ...(input.modelSelectionOverride === undefined
                        ? {
                            model: queued.modelSelection.model,
                            ...(queued.modelSelection.options !== undefined
                              ? { options: queued.modelSelection.options }
                              : {}),
                          }
                        : {}),
                    }
                  : queued.modelSelection;

            let queuedProviderThreadId = placeholderProviderThreads.get(queuedSelection.instanceId);
            if (queuedProviderThreadId === undefined) {
              queuedProviderThreadId = ProviderThreadId.make(
                `xfer-qpt:${key}:${placeholderProviderThreads.size}`,
              );
              placeholderProviderThreads.set(queuedSelection.instanceId, queuedProviderThreadId);
              const queuedProviderMeta =
                providerAdapterRegistry.getMetadata !== undefined
                  ? yield* providerAdapterRegistry
                      .getMetadata(queuedSelection.instanceId)
                      .pipe(Effect.orElseSucceed(() => null))
                  : null;
              const queuedDriver =
                queuedProviderMeta?.driver ??
                input.manifest.providerDriverKind ??
                ProviderDriverKind.make("codex");
              const placeholderProviderThread: OrchestrationV2ProviderThread = {
                id: queuedProviderThreadId,
                driver: queuedDriver,
                providerInstanceId: queuedSelection.instanceId,
                providerSessionId: null,
                appThreadId: input.destinationThreadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "not_loaded",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: requestedAt,
                updatedAt: requestedAt,
              };
              events.push({
                id: EventId.make(`xfer:${key}:queued-provider-thread:${queuedProviderThreadId}`),
                type: "provider-thread.updated",
                threadId: input.destinationThreadId,
                providerInstanceId: queuedSelection.instanceId,
                occurredAt: requestedAt,
                payload: placeholderProviderThread,
              });
            }

            const queuedAttempt: OrchestrationV2RunAttempt = {
              id: queuedAttemptId,
              runId: queuedRunId,
              attemptOrdinal: 1,
              rootNodeId: queuedNodeId,
              providerInstanceId: queuedSelection.instanceId,
              providerThreadId: queuedProviderThreadId,
              providerTurnId: null,
              reason: "initial",
              status: "pending",
              startedAt: null,
              completedAt: null,
            };
            const queuedRootNode: OrchestrationV2ExecutionNode = {
              id: queuedNodeId,
              threadId: input.destinationThreadId,
              runId: queuedRunId,
              parentNodeId: null,
              rootNodeId: queuedNodeId,
              kind: "root_turn",
              status: "pending",
              countsForRun: true,
              providerThreadId: queuedProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: null,
              completedAt: null,
            };

            events.push(
              {
                id: EventId.make(`xfer:${key}:queued-message:${i}`),
                type: "message.updated",
                threadId: input.destinationThreadId,
                runId: queuedRunId,
                nodeId: queuedNodeId,
                occurredAt: requestedAt,
                payload: {
                  createdBy: "user",
                  creationSource: "server",
                  id: queuedMessageId,
                  threadId: input.destinationThreadId,
                  runId: queuedRunId,
                  nodeId: queuedNodeId,
                  role: "user",
                  text: queued.text,
                  ...(queuedContext !== undefined ? { context: queuedContext } : {}),
                  attachments: queuedAttachments,
                  streaming: false,
                  createdAt: requestedAt,
                  updatedAt: requestedAt,
                },
              },
              {
                id: EventId.make(`xfer:${key}:queued-run:${i}`),
                type: "run.created",
                threadId: input.destinationThreadId,
                runId: queuedRunId,
                nodeId: queuedNodeId,
                providerInstanceId: queuedSelection.instanceId,
                occurredAt: requestedAt,
                payload: {
                  id: queuedRunId,
                  threadId: input.destinationThreadId,
                  ordinal: i + 1,
                  providerInstanceId: queuedSelection.instanceId,
                  modelSelection: queuedSelection,
                  providerThreadId: queuedProviderThreadId,
                  userMessageId: queuedMessageId,
                  rootNodeId: queuedNodeId,
                  activeAttemptId: queuedAttemptId,
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
              {
                id: EventId.make(`xfer:${key}:queued-attempt:${i}`),
                type: "run-attempt.created",
                threadId: input.destinationThreadId,
                runId: queuedRunId,
                nodeId: queuedNodeId,
                providerInstanceId: queuedSelection.instanceId,
                occurredAt: requestedAt,
                payload: queuedAttempt,
              },
              {
                id: EventId.make(`xfer:${key}:queued-node:${i}`),
                type: "node.updated",
                threadId: input.destinationThreadId,
                runId: queuedRunId,
                nodeId: queuedNodeId,
                providerInstanceId: queuedSelection.instanceId,
                occurredAt: requestedAt,
                payload: queuedRootNode,
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

        // Thread is now durably committed: remove durable worktree ownership file and mark staged
        // state committed immediately before post-commit handoff so a late abort can never treat
        // this committed thread worktree as uncommitted staging state.
        yield* removeWorktreeOwnershipBestEffort(input.transferId);
        yield* Ref.update(stagedImports, (map) => {
          const prev = map.get(input.transferId);
          if (prev === undefined || prev.committed) return map;
          const next = new Map(map);
          next.set(input.transferId, {
            ...prev,
            committed: true,
          });
          return next;
        });

        // 6. Auto-resume with a single continuation turn & release queued runs idempotently
        //    ONLY when source was running, had no pending runtime/secret requests, and autoResume is enabled.
        const { resumed, handoffComplete } = yield* completePostCommitHandoff({
          transferId: input.transferId,
          manifest: input.manifest,
          projectId: project.id,
          destinationThreadId: input.destinationThreadId,
          resolvedModelSelection,
          shouldAutoResume,
          warnings,
        });

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
            claimedAttachmentIds: claimedAttachmentIdsRecord,
            warnings,
            worktreeAllocation:
              destinationWorktreePath !== null
                ? {
                    repoRoot: prev?.worktreeAllocation?.repoRoot ?? project.workspaceRoot,
                    gitCommonDir: prev?.worktreeAllocation?.gitCommonDir ?? null,
                    worktreePath: destinationWorktreePath,
                    branch: destinationBranch,
                    createdBranch,
                    worktreeCreated: true,
                    importCompleted: true,
                  }
                : null,
            committed: true,
            handoffComplete,
            committedResult,
          });
          return next;
        });

        return committedResult;
      }),
    );
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
    const key = transferIdKey(input.transferId);
    if (records.thread.transferredTo?.transferId !== input.transferId) {
      yield* eventSink
        .write({
          events: [
            {
              id: EventId.make(`xfer-finalize:${key}`),
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
          commandId: CommandId.make(`xfer-archive:${key}`),
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

    // Delete staging & cache uninterruptibly before releasing the source lock and resolving
    // cleanupDeferred; await any cleanup owner already in `cleaning`.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const finalizeAttemptId = yield* secureRandom.uuidV4();
        const finalizeCleanupDeferred = yield* Deferred.make<void, SessionTransferError>();
        const finalizeLockState = yield* Ref.modify(
          sourceLocks,
          (
            current,
          ): readonly [
            (
              | { readonly kind: "claimed" }
              | {
                  readonly kind: "await";
                  readonly deferred: Deferred.Deferred<void, SessionTransferError>;
                }
              | { readonly kind: "unclaimed" }
            ),
            Map<ThreadId, SourceLockEntry>,
          ] => {
            const holder = current.get(input.threadId);
            if (holder?.transferId !== input.transferId) {
              return [{ kind: "unclaimed" }, current];
            }
            if (holder.phase === "cleaning") {
              return [{ kind: "await", deferred: holder.cleanupDeferred }, current];
            }
            const next = new Map(current);
            next.set(input.threadId, {
              transferId: holder.transferId,
              attemptId: finalizeAttemptId,
              phase: "cleaning",
              cleanupDeferred: finalizeCleanupDeferred,
            });
            return [{ kind: "claimed" }, next];
          },
        );

        if (finalizeLockState.kind === "await") {
          yield* restore(Deferred.await(finalizeLockState.deferred)).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Awaited source staging cleanup failed during finalizeSource.", {
                transferId: input.transferId,
                cause,
              }),
            ),
            Effect.ignore,
          );
          return;
        }

        const cleanupBody = Effect.gen(function* () {
          yield* Ref.update(preparedSources, (current) => {
            if (!current.has(input.transferId)) return current;
            const next = new Map(current);
            next.delete(input.transferId);
            return next;
          });
          yield* cleanupSourceStagingDir(input.transferId);
        });

        if (finalizeLockState.kind === "claimed") {
          yield* runSourceCleanupUninterruptible({
            transferId: input.transferId,
            cleanupDeferred: finalizeCleanupDeferred,
            releaseLock: Ref.update(sourceLocks, (current) => {
              if (current.get(input.threadId)?.attemptId !== finalizeAttemptId) return current;
              const next = new Map(current);
              next.delete(input.threadId);
              return next;
            }),
            runCleanup: cleanupBody,
          }).pipe(
            // Source thread is already marked transferred and archived; any staging deletion error
            // has already been logged and propagated to cleanupDeferred waiters.
            Effect.ignore,
          );
        } else {
          yield* cleanupBody.pipe(
            Effect.tapError((cause) =>
              Effect.logWarning(
                "Failed to clean up unclaimed source staging directory during finalizeSource.",
                { transferId: input.transferId, cause },
              ),
            ),
            Effect.ignore,
          );
        }
      }),
    );

    return { archived } satisfies SessionTransferFinalizeSourceResult;
  });

  const abort: SessionTransferEndpointServiceShape["abort"] = Effect.fn(
    "SessionTransferEndpointService.abort",
  )(function* (input) {
    if (input.role === "source") {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const abortAttemptId = yield* secureRandom.uuidV4();
          const abortCleanupDeferred = yield* Deferred.make<void, SessionTransferError>();
          const abortLockState = yield* Ref.modify(
            sourceLocks,
            (
              current,
            ): readonly [
              (
                | { readonly kind: "claimed" }
                | {
                    readonly kind: "await";
                    readonly deferreds: ReadonlyArray<
                      Deferred.Deferred<void, SessionTransferError>
                    >;
                  }
                | { readonly kind: "unclaimed" }
              ),
              Map<ThreadId, SourceLockEntry>,
            ] => {
              const existingCleaning: Array<Deferred.Deferred<void, SessionTransferError>> = [];
              const claimableThreadIds: Array<ThreadId> = [];
              for (const [threadId, holder] of current) {
                if (holder.transferId !== input.transferId) continue;
                if (holder.phase === "cleaning") {
                  existingCleaning.push(holder.cleanupDeferred);
                } else {
                  claimableThreadIds.push(threadId);
                }
              }
              if (existingCleaning.length > 0 && claimableThreadIds.length === 0) {
                return [{ kind: "await", deferreds: existingCleaning }, current];
              }
              if (claimableThreadIds.length === 0) {
                return [{ kind: "unclaimed" }, current];
              }
              const next = new Map(current);
              for (const threadId of claimableThreadIds) {
                const holder = next.get(threadId)!;
                next.set(threadId, {
                  transferId: holder.transferId,
                  attemptId: abortAttemptId,
                  phase: "cleaning",
                  cleanupDeferred: abortCleanupDeferred,
                });
              }
              return [{ kind: "claimed" }, next];
            },
          );

          if (abortLockState.kind === "await") {
            for (const deferred of abortLockState.deferreds) {
              yield* restore(Deferred.await(deferred));
            }
            return { cleanedUp: true } satisfies SessionTransferAbortResult;
          }

          const cleanupBody = Effect.gen(function* () {
            const removedCache = yield* Ref.modify(preparedSources, (current) => {
              if (!current.has(input.transferId)) return [false, current] as const;
              const next = new Map(current);
              next.delete(input.transferId);
              return [true, next] as const;
            });
            const deletedStaging = yield* cleanupSourceStagingDir(input.transferId);
            return { removedCache, deletedStaging };
          });

          const { removedCache, deletedStaging } =
            abortLockState.kind === "claimed"
              ? yield* runSourceCleanupUninterruptible({
                  transferId: input.transferId,
                  cleanupDeferred: abortCleanupDeferred,
                  releaseLock: Ref.update(sourceLocks, (current) => {
                    let changed = false;
                    const next = new Map(current);
                    for (const [threadId, holder] of next) {
                      if (holder.attemptId === abortAttemptId) {
                        next.delete(threadId);
                        changed = true;
                      }
                    }
                    return changed ? next : current;
                  }),
                  runCleanup: cleanupBody,
                })
              : yield* cleanupBody;

          return {
            cleanedUp: abortLockState.kind === "claimed" || removedCache || deletedStaging,
          } satisfies SessionTransferAbortResult;
        }),
      );
    }

    // Destination abort: serialized with stageImport and commitImport per transferId, never deletes
    // an already-committed thread/worktree or a pre-existing branch not created by the transfer.
    return yield* withKeyedLocks(
      [transferLockKey(input.transferId)],
      Effect.gen(function* () {
        const staged = (yield* Ref.get(stagedImports)).get(input.transferId);
        const persistedOwnershipResult = yield* Effect.result(
          readWorktreeOwnership(input.transferId),
        );
        const persistedOwnership = Result.isSuccess(persistedOwnershipResult)
          ? persistedOwnershipResult.success
          : null;
        const alreadyCommitted = yield* isTransferAlreadyCommitted(
          input.transferId,
          staged,
          persistedOwnership,
        );

        if (alreadyCommitted) {
          yield* removeWorktreeOwnershipBestEffort(input.transferId);
          yield* runWithAssetContext(cleanupTransferStagingDir(input.transferId)).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning(
                "Failed to clean up committed destination staging directory during abort.",
                { transferId: input.transferId, cause },
              ),
            ),
            Effect.ignore,
          );
          return { cleanedUp: false } satisfies SessionTransferAbortResult;
        }

        if (Result.isFailure(persistedOwnershipResult)) {
          return yield* persistedOwnershipResult.failure;
        }

        const cleanupFailures: Array<SessionTransferError> = [];

        // Always clean up strictly against the allocation's own repoRoot and gitCommonDir —
        // never substitute staged.projectWorkspaceRoot for an allocation's repository.
        const allocation = resolveExistingAllocation(persistedOwnership, staged);

        let cleanedWorktree = false;
        let removedOwnership = false;
        let worktreeOrBranchFailed = false;
        let remainingAllocation: StagedWorktreeAllocation | null = allocation;

        // Perform worktree & branch removal under the allocation's per-repo mutex BEFORE deleting
        // the ownership file / staging directory so concurrent imports into that repo are
        // serialized and any failure preserves durable ownership across retries and restarts.
        const needsRepoCleanup =
          allocation !== null &&
          allocation.repoRoot.length > 0 &&
          (allocation.worktreePath !== null ||
            (allocation.createdBranch && allocation.branch !== null) ||
            persistedOwnership !== null);

        if (needsRepoCleanup) {
          const cleanupResult = yield* cleanupUncommittedAllocation({
            transferId: input.transferId,
            allocation,
            persistedOwnership,
            contextLabel: "abort",
          });
          cleanedWorktree = cleanupResult.cleanedWorktree;
          removedOwnership = cleanupResult.removedOwnership;
          worktreeOrBranchFailed = cleanupResult.worktreeOrBranchFailed;
          remainingAllocation = cleanupResult.remainingAllocation;
          cleanupFailures.push(...cleanupResult.failures);
        }

        // Only delete the ownership file & staging directory once worktree and created-branch
        // cleanup have succeeded (independent of pending attachments stored in attachmentsDir).
        let deletedStaging = false;
        if (!worktreeOrBranchFailed) {
          if (!needsRepoCleanup) {
            const ownershipResult = yield* Effect.result(removeWorktreeOwnership(input.transferId));
            if (Result.isSuccess(ownershipResult)) {
              removedOwnership = ownershipResult.success;
              remainingAllocation = null;
              yield* syncStagedWorktreeAllocation(input.transferId, null);
            } else {
              cleanupFailures.push(ownershipResult.failure);
            }
          }
          const stagingResult = yield* Effect.result(cleanupSourceStagingDir(input.transferId));
          if (Result.isSuccess(stagingResult)) {
            deletedStaging = stagingResult.success;
          } else {
            cleanupFailures.push(stagingResult.failure);
          }
        }

        const remainingAttachmentUploads: Array<SessionTransferAttachmentUploadTarget> = [];
        for (const upload of staged?.attachmentUploads ?? []) {
          const attachmentResult = yield* Effect.result(
            runWithAssetContext(deletePendingAttachmentStrict(upload.destinationAttachmentId)).pipe(
              Effect.mapError(
                (cause) =>
                  new SessionTransferError({
                    code: "internal",
                    transferId: input.transferId,
                    message: `Failed to delete pending session transfer attachment '${upload.destinationAttachmentId}': ${String(cause)}`,
                    cause,
                  }),
              ),
            ),
          );
          if (Result.isFailure(attachmentResult)) {
            remainingAttachmentUploads.push(upload);
            cleanupFailures.push(attachmentResult.failure);
          }
        }

        if (cleanupFailures.length > 0) {
          if (staged !== undefined) {
            yield* Ref.update(stagedImports, (current) => {
              const latest = current.get(input.transferId);
              if (latest === undefined) return current;
              const next = new Map(current);
              next.set(input.transferId, {
                ...latest,
                worktreeAllocation: remainingAllocation,
                attachmentUploads: remainingAttachmentUploads,
              });
              return next;
            });
          }

          const [firstFailure, ...restFailures] = cleanupFailures;
          for (const extraFailure of restFailures) {
            yield* Effect.logWarning(
              "Additional destination cleanup failure during session transfer abort.",
              { transferId: input.transferId, cause: extraFailure },
            );
          }
          return yield* firstFailure!;
        }

        const removedStaged = yield* Ref.modify(stagedImports, (current) => {
          if (!current.has(input.transferId)) return [false, current] as const;
          const next = new Map(current);
          next.delete(input.transferId);
          return [true, next] as const;
        });

        return {
          cleanedUp: cleanedWorktree || removedOwnership || removedStaged || deletedStaging,
        } satisfies SessionTransferAbortResult;
      }),
    );
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

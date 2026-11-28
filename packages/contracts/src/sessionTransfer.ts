import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  GitRefName,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  SessionTransferId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment, ChatAttachmentId } from "./chatAttachment.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { RepositoryIdentity } from "./environment.ts";
import { ThreadIssueLink } from "./issue.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2PlanArtifact,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItemJson,
  SessionTransferThreadDestination,
  SessionTransferThreadOrigin,
} from "./orchestrationV2.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ThreadLinkedPullRequest, ThreadPullRequestLink } from "./threadPullRequest.ts";
import { StoredThreadTags } from "./threadTags.ts";

export { SessionTransferId, SessionTransferThreadDestination, SessionTransferThreadOrigin };

export const SessionTransferDirection = Schema.Literals(["local_to_boat", "boat_to_local"]);
export type SessionTransferDirection = typeof SessionTransferDirection.Type;

export const SESSION_TRANSFER_PHASES = [
  "queued",
  "waking_target",
  "pausing_source",
  "exporting_source",
  "preparing_target_project",
  "transferring_workspace",
  "transferring_attachments",
  "committing_target",
  "resuming_target",
  "finalizing_source",
  "completed",
  "failed",
  "cancelled",
] as const;

export const SessionTransferPhase = Schema.Literals(SESSION_TRANSFER_PHASES);
export type SessionTransferPhase = typeof SessionTransferPhase.Type;

export const TERMINAL_SESSION_TRANSFER_PHASES = ["completed", "failed", "cancelled"] as const;
export type TerminalSessionTransferPhase = (typeof TERMINAL_SESSION_TRANSFER_PHASES)[number];

export function isTerminalSessionTransferPhase(
  phase: SessionTransferPhase,
): phase is TerminalSessionTransferPhase {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

export const SessionTransferTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("boat"),
    machineId: TrimmedNonEmptyString,
    machineName: Schema.optional(TrimmedNonEmptyString),
    environmentId: Schema.optional(EnvironmentId),
  }),
  Schema.Struct({
    kind: Schema.Literal("local"),
    environmentId: Schema.optional(EnvironmentId),
  }),
]);
export type SessionTransferTarget = typeof SessionTransferTarget.Type;

export const SessionTransferPendingRuntimeRequest = Schema.Struct({
  id: RuntimeRequestId,
  kind: OrchestrationV2RuntimeRequest.fields.kind,
  createdAt: IsoDateTime,
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  blocking: Schema.optional(Schema.Boolean),
  userOnly: Schema.optional(Schema.Boolean),
});
export type SessionTransferPendingRuntimeRequest = typeof SessionTransferPendingRuntimeRequest.Type;

export const SessionTransferSourceState = Schema.Struct({
  wasRunning: Schema.Boolean,
  hadPendingRuntimeRequest: Schema.Boolean,
  pendingRuntimeRequests: Schema.Array(SessionTransferPendingRuntimeRequest),
  heldQueuedRunCount: NonNegativeInt,
  activeSubagentCount: NonNegativeInt,
  branch: Schema.NullOr(GitRefName),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  isDirty: Schema.Boolean,
  isGitRepo: Schema.Boolean,
});
export type SessionTransferSourceState = typeof SessionTransferSourceState.Type;

export const SessionTransferWorkspaceSpec = Schema.Struct({
  mode: Schema.Literals(["git_bundle", "none"]),
  isGitRepo: Schema.Boolean,
  branch: Schema.NullOr(GitRefName),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  isDetachedHead: Schema.Boolean,
  hasStagedChanges: Schema.Boolean,
  hasUnstagedChanges: Schema.Boolean,
  hasUntrackedFiles: Schema.Boolean,
  bundleSizeBytes: Schema.NullOr(NonNegativeInt),
  bundleSha256: Schema.NullOr(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  warnings: Schema.Array(Schema.String),
});
export type SessionTransferWorkspaceSpec = typeof SessionTransferWorkspaceSpec.Type;

export const SessionTransferAttachmentRef = Schema.Struct({
  attachmentId: ChatAttachmentId,
  type: Schema.Literals(["image", "file", "unknown"]),
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
  sha256: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  downloadRelativeUrl: Schema.optional(TrimmedNonEmptyString),
});
export type SessionTransferAttachmentRef = typeof SessionTransferAttachmentRef.Type;

export const SessionTransferQueuedRun = Schema.Struct({
  runId: RunId,
  text: Schema.String,
  context: Schema.optional(OrchestrationMessageContext),
  attachments: Schema.Array(ChatAttachment),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  requestedAt: IsoDateTime,
});
export type SessionTransferQueuedRun = typeof SessionTransferQueuedRun.Type;

export const SessionTransferManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  transferId: SessionTransferId,
  direction: SessionTransferDirection,
  exportedAt: IsoDateTime,
  sourceEnvironmentId: EnvironmentId,
  sourceEnvironmentName: Schema.NullOr(TrimmedNonEmptyString),
  sourceMachineId: Schema.NullOr(TrimmedNonEmptyString),
  sourceProjectId: ProjectId,
  sourceProjectName: Schema.NullOr(TrimmedNonEmptyString),
  sourceWorkspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  sourceThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  titleRenamed: Schema.optional(Schema.Boolean),
  providerInstanceId: ProviderInstanceId,
  providerDriverKind: Schema.optional(ProviderDriverKind),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceState: SessionTransferSourceState,
  workspace: SessionTransferWorkspaceSpec,
  attachments: Schema.Array(SessionTransferAttachmentRef),
  messages: Schema.Array(OrchestrationV2ConversationMessageJson),
  turnItems: Schema.Array(OrchestrationV2TurnItemJson),
  plans: Schema.Array(OrchestrationV2PlanArtifact),
  heldQueuedRuns: Schema.Array(SessionTransferQueuedRun),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.optional(Schema.Array(ThreadPullRequestLink)),
  issues: Schema.optional(Schema.Array(ThreadIssueLink)),
  tags: Schema.optional(StoredThreadTags),
  handoffSummary: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SessionTransferManifest = typeof SessionTransferManifest.Type;

export const SessionTransferRecord = Schema.Struct({
  transferId: SessionTransferId,
  direction: SessionTransferDirection,
  sourceEnvironmentId: EnvironmentId,
  sourceEnvironmentName: Schema.NullOr(TrimmedNonEmptyString),
  sourceMachineId: Schema.NullOr(TrimmedNonEmptyString),
  sourceProjectId: ProjectId,
  sourceThreadId: ThreadId,
  destinationEnvironmentId: Schema.NullOr(EnvironmentId),
  destinationEnvironmentName: Schema.NullOr(TrimmedNonEmptyString),
  destinationMachineId: Schema.NullOr(TrimmedNonEmptyString),
  destinationProjectId: Schema.NullOr(ProjectId),
  destinationThreadId: Schema.NullOr(ThreadId),
  phase: SessionTransferPhase,
  phaseDetail: Schema.NullOr(Schema.String),
  sourceWasRunning: Schema.Boolean,
  autoResume: Schema.Boolean,
  hadPendingRuntimeRequest: Schema.Boolean,
  destinationBranch: Schema.NullOr(GitRefName),
  destinationWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  modelSelectionOverride: Schema.optional(Schema.NullOr(ModelSelection)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  cloneDestinationPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  warnings: Schema.Array(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type SessionTransferRecord = typeof SessionTransferRecord.Type;

export const SessionTransferCandidateProject = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  matchReason: Schema.optional(
    Schema.Literals(["origin_project_id", "repository_identity", "manual"]),
  ),
});
export type SessionTransferCandidateProject = typeof SessionTransferCandidateProject.Type;

export const SessionTransferAvailableModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  model: TrimmedNonEmptyString,
  modelName: Schema.optional(TrimmedNonEmptyString),
});
export type SessionTransferAvailableModel = typeof SessionTransferAvailableModel.Type;

export const SessionTransferPreflightInput = Schema.Struct({
  direction: SessionTransferDirection,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  target: SessionTransferTarget,
  targetProjectId: Schema.optional(ProjectId),
  modelSelectionOverride: Schema.optional(ModelSelection),
});
export type SessionTransferPreflightInput = typeof SessionTransferPreflightInput.Type;

export const SessionTransferPreflightResult = Schema.Struct({
  ready: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
  needsProjectSelection: Schema.Boolean,
  candidateProjects: Schema.Array(SessionTransferCandidateProject),
  needsCloneDestination: Schema.Boolean,
  needsModelSelection: Schema.Boolean,
  availableModels: Schema.Array(SessionTransferAvailableModel),
  needsRunningConfirmation: Schema.Boolean,
  unsupportedReason: Schema.NullOr(Schema.String),
  sourceState: Schema.optional(SessionTransferSourceState),
  resolvedTargetProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  resolvedModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  willAutoCloneProject: Schema.optional(Schema.Boolean),
});
export type SessionTransferPreflightResult = typeof SessionTransferPreflightResult.Type;

export const SessionTransferStartInput = Schema.Struct({
  transferId: Schema.optional(SessionTransferId),
  direction: SessionTransferDirection,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  target: SessionTransferTarget,
  targetProjectId: Schema.optional(ProjectId),
  cloneDestinationPath: Schema.optional(TrimmedNonEmptyString),
  modelSelectionOverride: Schema.optional(ModelSelection),
  autoResume: Schema.optional(Schema.Boolean),
  confirmedRunningPause: Schema.optional(Schema.Boolean),
});
export type SessionTransferStartInput = typeof SessionTransferStartInput.Type;

export const SessionTransferCancelInput = Schema.Struct({
  transferId: SessionTransferId,
});
export type SessionTransferCancelInput = typeof SessionTransferCancelInput.Type;

export const SessionTransferRetryInput = Schema.Struct({
  transferId: SessionTransferId,
  targetProjectId: Schema.optional(ProjectId),
  cloneDestinationPath: Schema.optional(TrimmedNonEmptyString),
  modelSelectionOverride: Schema.optional(ModelSelection),
  autoResume: Schema.optional(Schema.Boolean),
});
export type SessionTransferRetryInput = typeof SessionTransferRetryInput.Type;

export const SessionTransferListInput = Schema.Struct({
  activeOnly: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
});
export type SessionTransferListInput = typeof SessionTransferListInput.Type;

export const SessionTransferListResult = Schema.Struct({
  transfers: Schema.Array(SessionTransferRecord),
});
export type SessionTransferListResult = typeof SessionTransferListResult.Type;

export const SessionTransferProgressEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    transfers: Schema.Array(SessionTransferRecord),
  }),
  Schema.TaggedStruct("updated", {
    transfer: SessionTransferRecord,
  }),
]);
export type SessionTransferProgressEvent = typeof SessionTransferProgressEvent.Type;

export const SessionTransferPrepareSourceInput = Schema.Struct({
  transferId: SessionTransferId,
  direction: SessionTransferDirection,
  threadId: ThreadId,
  targetEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
  targetMachineId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  targetMachineName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  sharedRemoteRefs: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SessionTransferPrepareSourceInput = typeof SessionTransferPrepareSourceInput.Type;

export const SessionTransferPrepareSourceResult = Schema.Struct({
  manifest: SessionTransferManifest,
  bundleDownloadRelativeUrl: Schema.NullOr(TrimmedNonEmptyString),
  bundleExpiresAt: Schema.NullOr(IsoDateTime),
});
export type SessionTransferPrepareSourceResult = typeof SessionTransferPrepareSourceResult.Type;

export const SessionTransferAttachmentUploadTarget = Schema.Struct({
  sourceAttachmentId: ChatAttachmentId,
  destinationAttachmentId: ChatAttachmentId,
  uploadRelativeUrl: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type SessionTransferAttachmentUploadTarget =
  typeof SessionTransferAttachmentUploadTarget.Type;

export const SessionTransferStageImportInput = Schema.Struct({
  transferId: SessionTransferId,
  manifest: SessionTransferManifest,
  targetProjectId: Schema.optional(ProjectId),
  modelSelectionOverride: Schema.optional(ModelSelection),
});
export type SessionTransferStageImportInput = typeof SessionTransferStageImportInput.Type;

export const SessionTransferStageImportResult = Schema.Struct({
  destinationProjectId: ProjectId,
  destinationThreadId: ThreadId,
  destinationBranch: Schema.NullOr(GitRefName),
  destinationWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  resolvedModelSelection: ModelSelection,
  bundleUploadRelativeUrl: Schema.NullOr(TrimmedNonEmptyString),
  bundleUploadExpiresAt: Schema.NullOr(IsoDateTime),
  attachmentUploads: Schema.Array(SessionTransferAttachmentUploadTarget),
  warnings: Schema.Array(Schema.String),
});
export type SessionTransferStageImportResult = typeof SessionTransferStageImportResult.Type;

export const SessionTransferCommitImportInput = Schema.Struct({
  transferId: SessionTransferId,
  manifest: SessionTransferManifest,
  destinationProjectId: ProjectId,
  destinationThreadId: ThreadId,
  modelSelectionOverride: Schema.optional(ModelSelection),
  autoResume: Schema.Boolean,
  attachmentIdMap: Schema.optional(Schema.Record(ChatAttachmentId, ChatAttachmentId)),
});
export type SessionTransferCommitImportInput = typeof SessionTransferCommitImportInput.Type;

export const SessionTransferCommitImportResult = Schema.Struct({
  destinationProjectId: ProjectId,
  destinationThreadId: ThreadId,
  destinationBranch: Schema.NullOr(GitRefName),
  destinationWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  resumed: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
});
export type SessionTransferCommitImportResult = typeof SessionTransferCommitImportResult.Type;

export const SessionTransferFinalizeSourceInput = Schema.Struct({
  transferId: SessionTransferId,
  threadId: ThreadId,
  destination: SessionTransferThreadDestination,
});
export type SessionTransferFinalizeSourceInput = typeof SessionTransferFinalizeSourceInput.Type;

export const SessionTransferFinalizeSourceResult = Schema.Struct({
  archived: Schema.Boolean,
});
export type SessionTransferFinalizeSourceResult = typeof SessionTransferFinalizeSourceResult.Type;

export const SessionTransferAbortInput = Schema.Struct({
  transferId: SessionTransferId,
  role: Schema.Literals(["source", "destination"]),
  threadId: Schema.optional(ThreadId),
  reason: Schema.optional(Schema.String),
});
export type SessionTransferAbortInput = typeof SessionTransferAbortInput.Type;

export const SessionTransferAbortResult = Schema.Struct({
  cleanedUp: Schema.Boolean,
});
export type SessionTransferAbortResult = typeof SessionTransferAbortResult.Type;

export const SessionTransferErrorCode = Schema.Literals([
  "not_found",
  "already_in_flight",
  "invalid_phase",
  "unsupported",
  "preflight_required",
  "workspace_error",
  "bundle_too_large",
  "attachment_error",
  "target_unavailable",
  "cancelled",
  "not_implemented",
  "internal",
]);
export type SessionTransferErrorCode = typeof SessionTransferErrorCode.Type;

export class SessionTransferError extends Schema.TaggedError<SessionTransferError>()(
  "SessionTransferError",
  {
    code: SessionTransferErrorCode,
    message: Schema.String,
    transferId: Schema.optional(SessionTransferId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

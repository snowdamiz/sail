import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ChatAttachmentId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  SESSION_TRANSFER_PHASES,
  SessionTransferAbortInput,
  SessionTransferAbortResult,
  SessionTransferCancelInput,
  SessionTransferCommitImportInput,
  SessionTransferCommitImportResult,
  SessionTransferDirection,
  SessionTransferError,
  SessionTransferFinalizeSourceInput,
  SessionTransferFinalizeSourceResult,
  SessionTransferId,
  SessionTransferListInput,
  SessionTransferListResult,
  SessionTransferManifest,
  SessionTransferPhase,
  SessionTransferPreflightInput,
  SessionTransferPreflightResult,
  SessionTransferPrepareSourceInput,
  SessionTransferPrepareSourceResult,
  SessionTransferProgressEvent,
  SessionTransferRecord,
  SessionTransferRetryInput,
  SessionTransferStageImportInput,
  SessionTransferStageImportResult,
  SessionTransferStartInput,
  SessionTransferTarget,
  TERMINAL_SESSION_TRANSFER_PHASES,
  ThreadId,
  TurnItemId,
  isTerminalSessionTransferPhase,
} from "./index.ts";

const NOW = "2026-11-28T05:00:00.000Z";
const EXPIRES_AT = "2026-11-28T05:30:00.000Z";

const manifestJsonCodec = Schema.toCodecJson(SessionTransferManifest);
const recordJsonCodec = Schema.toCodecJson(SessionTransferRecord);

const decodeId = Schema.decodeUnknownSync(SessionTransferId);
const decodeDirection = Schema.decodeUnknownSync(SessionTransferDirection);
const decodePhase = Schema.decodeUnknownSync(SessionTransferPhase);
const decodeTarget = Schema.decodeUnknownSync(SessionTransferTarget);
const decodeManifest = Schema.decodeUnknownSync(manifestJsonCodec);
const encodeManifest = Schema.encodeSync(manifestJsonCodec);
const decodeRecord = Schema.decodeUnknownSync(recordJsonCodec);
const encodeRecord = Schema.encodeSync(recordJsonCodec);
const decodeListInput = Schema.decodeUnknownSync(SessionTransferListInput);
const decodeListResult = Schema.decodeUnknownSync(SessionTransferListResult);
const decodeProgressEvent = Schema.decodeUnknownSync(SessionTransferProgressEvent);
const decodePreflightInput = Schema.decodeUnknownSync(SessionTransferPreflightInput);
const decodePreflightResult = Schema.decodeUnknownSync(SessionTransferPreflightResult);
const decodeStartInput = Schema.decodeUnknownSync(SessionTransferStartInput);
const decodeCancelInput = Schema.decodeUnknownSync(SessionTransferCancelInput);
const decodeRetryInput = Schema.decodeUnknownSync(SessionTransferRetryInput);
const decodePrepareSourceInput = Schema.decodeUnknownSync(SessionTransferPrepareSourceInput);
const decodePrepareSourceResult = Schema.decodeUnknownSync(SessionTransferPrepareSourceResult);
const decodeStageImportInput = Schema.decodeUnknownSync(SessionTransferStageImportInput);
const decodeStageImportResult = Schema.decodeUnknownSync(SessionTransferStageImportResult);
const decodeCommitImportInput = Schema.decodeUnknownSync(SessionTransferCommitImportInput);
const decodeCommitImportResult = Schema.decodeUnknownSync(SessionTransferCommitImportResult);
const decodeFinalizeSourceInput = Schema.decodeUnknownSync(SessionTransferFinalizeSourceInput);
const decodeFinalizeSourceResult = Schema.decodeUnknownSync(SessionTransferFinalizeSourceResult);
const decodeAbortInput = Schema.decodeUnknownSync(SessionTransferAbortInput);
const decodeAbortResult = Schema.decodeUnknownSync(SessionTransferAbortResult);
const encodeError = Schema.encodeSync(SessionTransferError);
const decodeError = Schema.decodeUnknownSync(SessionTransferError);

function makeSampleRecord() {
  return {
    transferId: "transfer-1",
    direction: "local_to_boat" as const,
    sourceEnvironmentId: "env-local",
    sourceEnvironmentName: "MacBook Pro",
    sourceMachineId: null,
    sourceProjectId: "project-local",
    sourceThreadId: "thread-local",
    destinationEnvironmentId: "env-boat",
    destinationEnvironmentName: "dev-boat",
    destinationMachineId: "machine-1",
    destinationProjectId: "project-boat",
    destinationThreadId: "thread-boat",
    phase: "transferring_workspace" as const,
    phaseDetail: "Uploading git bundle",
    sourceWasRunning: true,
    autoResume: true,
    hadPendingRuntimeRequest: false,
    destinationBranch: "feat/session-transfer",
    destinationWorktreePath: "/workspace/repo",
    warnings: ["Untracked ignored files were skipped."],
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  };
}

function makeSampleManifest() {
  return {
    schemaVersion: 1 as const,
    transferId: "transfer-1",
    direction: "local_to_boat" as const,
    exportedAt: NOW,
    sourceEnvironmentId: "env-local",
    sourceEnvironmentName: "MacBook Pro",
    sourceMachineId: null,
    sourceProjectId: "project-local",
    sourceProjectName: "sail",
    sourceWorkspaceRoot: "/Users/dev/sail",
    sourceThreadId: "thread-local",
    title: "Session transfer architecture",
    titleRenamed: true,
    providerInstanceId: "codex",
    providerDriverKind: "codex" as const,
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    sourceState: {
      wasRunning: true,
      hadPendingRuntimeRequest: true,
      pendingRuntimeRequests: [
        {
          id: "req-1",
          kind: "command" as const,
          createdAt: NOW,
          summary: "Approve shell command",
          blocking: true,
          userOnly: true,
        },
      ],
      heldQueuedRunCount: 1,
      activeSubagentCount: 0,
      branch: "feat/session-transfer",
      headSha: "386d27b4",
      isDirty: true,
      isGitRepo: true,
    },
    workspace: {
      mode: "git_bundle" as const,
      isGitRepo: true,
      branch: "feat/session-transfer",
      headSha: "386d27b4",
      baseRef: "refs/remotes/origin/main",
      isDetachedHead: false,
      hasStagedChanges: true,
      hasUnstagedChanges: true,
      hasUntrackedFiles: false,
      bundleSizeBytes: 4096,
      bundleSha256: "abc123def456",
      warnings: [],
    },
    attachments: [
      {
        attachmentId: "att-1",
        type: "image" as const,
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        sha256: "deadbeef",
        downloadRelativeUrl: "/api/session-transfer/transfer-1/attachments/att-1",
      },
    ],
    messages: [
      {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: "msg-1",
        threadId: "thread-local",
        runId: "run-1",
        nodeId: null,
        role: "user" as const,
        text: "Continue the migration",
        attachments: [],
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    turnItems: [
      {
        id: "item-1",
        type: "system_notice" as const,
        threadId: "thread-local",
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed" as const,
        title: null,
        startedAt: null,
        completedAt: NOW,
        updatedAt: NOW,
        message: "Paused before transfer.",
      },
    ],
    plans: [],
    heldQueuedRuns: [
      {
        runId: "run-2",
        text: "Run full verification after resume.",
        attachments: [],
        requestedAt: NOW,
      },
    ],
    handoffSummary: "Moved mid-task from local checkout to boat.",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("session transfer contracts", () => {
  it("validates SessionTransferId and direction literals", () => {
    expect(decodeId("transfer-abc")).toBe(SessionTransferId.make("transfer-abc"));
    expect(() => decodeId("   ")).toThrow();

    expect(decodeDirection("local_to_boat")).toBe("local_to_boat");
    expect(decodeDirection("boat_to_local")).toBe("boat_to_local");
    expect(() => decodeDirection("boat_to_boat")).toThrow();
  });

  it("validates phases, rejects illegal phases, and classifies terminal phases", () => {
    for (const phase of SESSION_TRANSFER_PHASES) {
      expect(decodePhase(phase)).toBe(phase);
      expect(isTerminalSessionTransferPhase(phase)).toBe(
        (TERMINAL_SESSION_TRANSFER_PHASES as ReadonlyArray<string>).includes(phase),
      );
    }

    expect(TERMINAL_SESSION_TRANSFER_PHASES).toEqual(["completed", "failed", "cancelled"]);
    expect(() => decodePhase("restarting")).toThrow();
    expect(() => decodePhase("")).toThrow();
  });

  it("decodes boat and local transfer targets", () => {
    expect(
      decodeTarget({
        kind: "boat",
        machineId: "machine-1",
        machineName: "dev-boat",
        environmentId: "env-boat",
      }),
    ).toEqual({
      kind: "boat",
      machineId: "machine-1",
      machineName: "dev-boat",
      environmentId: EnvironmentId.make("env-boat"),
    });
    expect(decodeTarget({ kind: "local" })).toEqual({ kind: "local" });
    expect(() => decodeTarget({ kind: "boat" })).toThrow();
  });

  it("round-trips SessionTransferManifest and rejects unsupported schema versions", () => {
    const decoded = decodeManifest(makeSampleManifest());
    expect(decoded.transferId).toBe(SessionTransferId.make("transfer-1"));
    expect(decoded.sourceState.pendingRuntimeRequests[0]?.id).toBe(RuntimeRequestId.make("req-1"));
    expect(decoded.attachments[0]?.attachmentId).toBe(ChatAttachmentId.make("att-1"));
    expect(decoded.messages[0]?.id).toBe(MessageId.make("msg-1"));
    expect(decoded.turnItems[0]?.id).toBe(TurnItemId.make("item-1"));
    expect(decoded.heldQueuedRuns[0]?.runId).toBe(RunId.make("run-2"));

    const encoded = encodeManifest(decoded);
    expect(decodeManifest(encoded)).toEqual(decoded);

    expect(() =>
      decodeManifest({
        ...makeSampleManifest(),
        schemaVersion: 2,
      }),
    ).toThrow();
  });

  it("round-trips SessionTransferRecord, list, and progress stream schemas", () => {
    const decodedRecord = decodeRecord(makeSampleRecord());
    expect(decodedRecord.phase).toBe("transferring_workspace");
    expect(decodedRecord.modelSelectionOverride).toBeNull();
    expect(decodedRecord.cloneDestinationPath).toBeNull();
    expect(decodeRecord(encodeRecord(decodedRecord))).toEqual(decodedRecord);

    const recordWithOverrides = decodeRecord({
      ...makeSampleRecord(),
      modelSelectionOverride: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      cloneDestinationPath: "/Users/dev/repos/sail",
    });
    expect(recordWithOverrides.modelSelectionOverride).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    });
    expect(recordWithOverrides.cloneDestinationPath).toBe("/Users/dev/repos/sail");
    expect(decodeRecord(encodeRecord(recordWithOverrides))).toEqual(recordWithOverrides);
    expect(() =>
      decodeRecord({
        ...makeSampleRecord(),
        cloneDestinationPath: "   ",
      }),
    ).toThrow();

    const listInput = decodeListInput({
      activeOnly: true,
      limit: 20,
    });
    expect(listInput).toEqual({ activeOnly: true, limit: 20 });

    const listResult = decodeListResult({
      transfers: [makeSampleRecord()],
    });
    expect(listResult.transfers).toHaveLength(1);

    expect(decodeProgressEvent({ _tag: "snapshot", transfers: [makeSampleRecord()] })._tag).toBe(
      "snapshot",
    );
    expect(decodeProgressEvent({ _tag: "updated", transfer: makeSampleRecord() })._tag).toBe(
      "updated",
    );
  });

  it("round-trips preflight, lifecycle, and symmetric endpoint RPC schemas", () => {
    const preflightInput = decodePreflightInput({
      direction: "local_to_boat",
      sourceEnvironmentId: "env-local",
      sourceThreadId: "thread-local",
      target: { kind: "boat", machineId: "machine-1" },
    });
    expect(preflightInput.sourceThreadId).toBe(ThreadId.make("thread-local"));

    const preflightResult = decodePreflightResult({
      ready: false,
      warnings: ["Running turn will be paused."],
      needsProjectSelection: true,
      candidateProjects: [
        {
          projectId: "project-boat",
          name: "sail",
          workspaceRoot: "/workspace/sail",
          matchReason: "repository_identity",
        },
      ],
      needsCloneDestination: false,
      needsModelSelection: true,
      availableModels: [
        {
          instanceId: "codex",
          driverKind: "codex",
          model: "gpt-5.4",
        },
      ],
      needsRunningConfirmation: true,
      unsupportedReason: null,
    });
    expect(preflightResult.candidateProjects[0]?.projectId).toBe(ProjectId.make("project-boat"));
    expect(preflightResult.availableModels[0]?.instanceId).toBe(ProviderInstanceId.make("codex"));

    expect(
      decodeStartInput({
        direction: "boat_to_local",
        sourceEnvironmentId: "env-boat",
        sourceThreadId: "thread-boat",
        target: { kind: "local", environmentId: "env-local" },
        autoResume: true,
        confirmedRunningPause: true,
      }).autoResume,
    ).toBe(true);

    expect(decodeCancelInput({ transferId: "transfer-1" }).transferId).toBe(
      SessionTransferId.make("transfer-1"),
    );
    expect(
      decodeRetryInput({
        transferId: "transfer-1",
        autoResume: false,
      }).autoResume,
    ).toBe(false);

    expect(
      decodePrepareSourceInput({
        transferId: "transfer-1",
        direction: "local_to_boat",
        threadId: "thread-local",
      }).threadId,
    ).toBe(ThreadId.make("thread-local"));
    expect(
      decodePrepareSourceResult({
        manifest: makeSampleManifest(),
        bundleDownloadRelativeUrl: "/api/session-transfer/transfer-1/bundle",
        bundleExpiresAt: EXPIRES_AT,
      }).bundleExpiresAt,
    ).toBe(IsoDateTime.make(EXPIRES_AT));

    expect(
      decodeStageImportInput({
        transferId: "transfer-1",
        manifest: makeSampleManifest(),
        targetProjectId: "project-boat",
      }).targetProjectId,
    ).toBe(ProjectId.make("project-boat"));
    expect(
      decodeStageImportResult({
        destinationProjectId: "project-boat",
        destinationThreadId: "thread-boat",
        destinationBranch: "feat/session-transfer",
        destinationWorktreePath: "/workspace/sail",
        resolvedModelSelection: { instanceId: "codex", model: "gpt-5.4" },
        bundleUploadRelativeUrl: "/api/session-transfer/transfer-1/bundle",
        bundleUploadExpiresAt: EXPIRES_AT,
        attachmentUploads: [
          {
            sourceAttachmentId: "att-1",
            destinationAttachmentId: "att-dest-1",
            uploadRelativeUrl: "/api/session-transfer/transfer-1/attachments/att-dest-1",
            expiresAt: EXPIRES_AT,
          },
        ],
        warnings: [],
      }).attachmentUploads,
    ).toHaveLength(1);

    expect(
      decodeCommitImportInput({
        transferId: "transfer-1",
        manifest: makeSampleManifest(),
        destinationProjectId: "project-boat",
        destinationThreadId: "thread-boat",
        autoResume: true,
        attachmentIdMap: { "att-1": "att-dest-1" },
      }).destinationThreadId,
    ).toBe(ThreadId.make("thread-boat"));
    expect(
      decodeCommitImportResult({
        destinationProjectId: "project-boat",
        destinationThreadId: "thread-boat",
        destinationBranch: "feat/session-transfer",
        destinationWorktreePath: "/workspace/sail",
        resumed: true,
        warnings: [],
      }).resumed,
    ).toBe(true);

    expect(
      decodeFinalizeSourceInput({
        transferId: "transfer-1",
        threadId: "thread-local",
        destination: {
          transferId: "transfer-1",
          environmentId: "env-boat",
          environmentName: "dev-boat",
          machineId: "machine-1",
          projectId: "project-boat",
          threadId: "thread-boat",
          transferredAt: NOW,
        },
      }).destination.threadId,
    ).toBe(ThreadId.make("thread-boat"));
    expect(decodeFinalizeSourceResult({ archived: true }).archived).toBe(true);

    expect(
      decodeAbortInput({
        transferId: "transfer-1",
        role: "destination",
        reason: "Cancelled by user",
      }).role,
    ).toBe("destination");
    expect(decodeAbortResult({ cleanedUp: true }).cleanedUp).toBe(true);
  });

  it("round-trips SessionTransferError and rejects unknown codes", () => {
    const error = new SessionTransferError({
      code: "already_in_flight",
      transferId: SessionTransferId.make("transfer-1"),
      message: "Transfer already active.",
    });
    const encoded = encodeError(error);
    const decoded = decodeError(encoded);
    expect(decoded._tag).toBe("SessionTransferError");
    expect(decoded.code).toBe("already_in_flight");
    expect(decoded.transferId).toBe(SessionTransferId.make("transfer-1"));

    expect(() =>
      decodeError({
        _tag: "SessionTransferError",
        code: "not_a_real_code",
        message: "bad",
      }),
    ).toThrow();
  });
});

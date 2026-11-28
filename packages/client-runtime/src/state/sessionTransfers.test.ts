import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  SessionTransferId,
  ThreadId,
  TrimmedNonEmptyString,
  type SessionTransferProgressEvent,
  type SessionTransferRecord,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  EMPTY_SESSION_TRANSFERS_STATE,
  applySessionTransferEvent,
  findActiveTransferForThread,
  foldSessionTransferEvents,
} from "./sessionTransfers.ts";

function makeRecord(overrides: Partial<SessionTransferRecord> = {}): SessionTransferRecord {
  return {
    transferId: SessionTransferId.make("tx-1"),
    direction: "local_to_boat",
    sourceEnvironmentId: EnvironmentId.make("env-local"),
    sourceEnvironmentName: TrimmedNonEmptyString.make("Local"),
    sourceMachineId: null,
    sourceProjectId: ProjectId.make("proj-local"),
    sourceThreadId: ThreadId.make("thread-1"),
    destinationEnvironmentId: EnvironmentId.make("env-boat"),
    destinationEnvironmentName: TrimmedNonEmptyString.make("skiff"),
    destinationMachineId: TrimmedNonEmptyString.make("machine-1"),
    destinationProjectId: ProjectId.make("proj-boat"),
    destinationThreadId: ThreadId.make("thread-boat-1"),
    phase: "queued",
    phaseDetail: null,
    sourceWasRunning: false,
    autoResume: true,
    hadPendingRuntimeRequest: false,
    destinationBranch: null,
    destinationWorktreePath: null,
    modelSelectionOverride: null,
    cloneDestinationPath: null,
    warnings: [],
    errorMessage: null,
    createdAt: IsoDateTime.make("2026-05-01T10:00:00.000Z"),
    updatedAt: IsoDateTime.make("2026-05-01T10:00:00.000Z"),
    completedAt: null,
    ...overrides,
  };
}

it.effect("folds snapshots and incremental updates into reactive transfer state", () =>
  Effect.gen(function* () {
    const initial = makeRecord({
      transferId: SessionTransferId.make("tx-1"),
      phase: "queued",
      updatedAt: IsoDateTime.make("2026-05-01T10:00:00.000Z"),
    });
    const olderCompleted = makeRecord({
      transferId: SessionTransferId.make("tx-0"),
      sourceThreadId: ThreadId.make("thread-old"),
      destinationThreadId: ThreadId.make("thread-old-boat"),
      phase: "completed",
      updatedAt: IsoDateTime.make("2026-05-01T09:00:00.000Z"),
      completedAt: IsoDateTime.make("2026-05-01T09:01:00.000Z"),
    });
    const progressing = makeRecord({
      transferId: SessionTransferId.make("tx-1"),
      phase: "transferring_workspace",
      updatedAt: IsoDateTime.make("2026-05-01T10:00:05.000Z"),
    });
    const completed = makeRecord({
      transferId: SessionTransferId.make("tx-1"),
      phase: "completed",
      updatedAt: IsoDateTime.make("2026-05-01T10:00:10.000Z"),
      completedAt: IsoDateTime.make("2026-05-01T10:00:10.000Z"),
    });

    const events: SessionTransferProgressEvent[] = [
      { _tag: "snapshot", transfers: [olderCompleted, initial] },
      { _tag: "updated", transfer: progressing },
      { _tag: "updated", transfer: completed },
    ];

    const states = yield* Stream.fromIterable(events).pipe(
      foldSessionTransferEvents,
      Stream.runCollect,
    );

    expect(states).toHaveLength(4);
    expect(states[0]).toEqual(EMPTY_SESSION_TRANSFERS_STATE);

    // Snapshot sorts newest first and marks active thread keys for non-terminal transfers only.
    const afterSnapshot = states[1]!;
    expect(afterSnapshot.receivedSnapshot).toBe(true);
    expect(afterSnapshot.transfers.map((item) => item.transferId)).toEqual(["tx-1", "tx-0"]);
    expect(
      findActiveTransferForThread(afterSnapshot, {
        environmentId: EnvironmentId.make("env-local"),
        threadId: ThreadId.make("thread-1"),
      })?.phase,
    ).toBe("queued");
    expect(
      findActiveTransferForThread(afterSnapshot, {
        environmentId: EnvironmentId.make("env-boat"),
        threadId: ThreadId.make("thread-boat-1"),
      })?.phase,
    ).toBe("queued");
    expect(
      findActiveTransferForThread(afterSnapshot, {
        environmentId: EnvironmentId.make("env-local"),
        threadId: ThreadId.make("thread-old"),
      }),
    ).toBeNull();

    // Update transitions phase in-place.
    const afterProgress = states[2]!;
    expect(afterProgress.byId.get(SessionTransferId.make("tx-1"))?.phase).toBe(
      "transferring_workspace",
    );
    expect(
      findActiveTransferForThread(afterProgress, {
        environmentId: EnvironmentId.make("env-local"),
        threadId: ThreadId.make("thread-1"),
      })?.phase,
    ).toBe("transferring_workspace");

    // Terminal update clears the active thread mapping.
    const afterComplete = states[3]!;
    expect(afterComplete.byId.get(SessionTransferId.make("tx-1"))?.phase).toBe("completed");
    expect(
      findActiveTransferForThread(afterComplete, {
        environmentId: EnvironmentId.make("env-local"),
        threadId: ThreadId.make("thread-1"),
      }),
    ).toBeNull();
    expect(
      findActiveTransferForThread(afterComplete, {
        environmentId: EnvironmentId.make("env-boat"),
        threadId: ThreadId.make("thread-boat-1"),
      }),
    ).toBeNull();
  }),
);

it.effect("inserts brand-new updates and replaces state cleanly on reconnect snapshot", () =>
  Effect.gen(function* () {
    const created = makeRecord({
      transferId: SessionTransferId.make("tx-new"),
      phase: "waking_target",
      destinationEnvironmentId: null,
      destinationThreadId: null,
    });

    const afterUpdate = applySessionTransferEvent(EMPTY_SESSION_TRANSFERS_STATE, {
      _tag: "updated",
      transfer: created,
    });
    expect(afterUpdate.transfers).toHaveLength(1);
    expect(
      findActiveTransferForThread(afterUpdate, {
        environmentId: EnvironmentId.make("env-local"),
        threadId: ThreadId.make("thread-1"),
      })?.transferId,
    ).toBe("tx-new");

    const afterReconnectSnapshot = applySessionTransferEvent(afterUpdate, {
      _tag: "snapshot",
      transfers: [],
    });
    expect(afterReconnectSnapshot.transfers).toEqual([]);
    expect(afterReconnectSnapshot.activeByThreadKey.size).toBe(0);
    expect(afterReconnectSnapshot.receivedSnapshot).toBe(true);
  }),
);

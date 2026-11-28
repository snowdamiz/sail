// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  SessionTransferId,
  type SessionTransferRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionTransferRepository from "./SessionTransferRepository.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const memoryLayer = SessionTransferRepository.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

function makeRecord(overrides: Partial<SessionTransferRecord> = {}): SessionTransferRecord {
  const createdAt = IsoDateTime.make("2026-11-28T05:00:00.000Z");
  return {
    transferId: SessionTransferId.make("transfer-1"),
    direction: "local_to_boat",
    sourceEnvironmentId: EnvironmentId.make("env-local"),
    sourceEnvironmentName: "MacBook Pro",
    sourceMachineId: null,
    sourceProjectId: ProjectId.make("project-local"),
    sourceThreadId: ThreadId.make("thread-1"),
    destinationEnvironmentId: EnvironmentId.make("env-boat"),
    destinationEnvironmentName: "dev-boat",
    destinationMachineId: "machine-1",
    destinationProjectId: null,
    destinationThreadId: null,
    phase: "queued",
    phaseDetail: "Waiting to start",
    sourceWasRunning: false,
    autoResume: false,
    hadPendingRuntimeRequest: false,
    destinationBranch: null,
    destinationWorktreePath: null,
    modelSelectionOverride: null,
    cloneDestinationPath: null,
    warnings: [],
    errorMessage: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...overrides,
  };
}

describe("SessionTransferRepository", () => {
  it.effect(
    "applies migration 119 with boat_session_transfers and active partial unique index",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const indexes = yield* sql<{ readonly name: string; readonly sql: string | null }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'boat_session_transfers'
      `;
        const activeIndex = indexes.find(
          (row) => row.name === "idx_boat_session_transfers_active_source",
        );
        expect(activeIndex).toBeDefined();
        expect(activeIndex?.sql).toContain("UNIQUE INDEX");
        expect(activeIndex?.sql).toContain(
          "WHERE phase NOT IN ('completed', 'failed', 'cancelled')",
        );
      }).pipe(Effect.provide(memoryLayer)),
  );

  it.effect(
    "inserts if absent by transferId and never overwrites advanced or completed transfers",
    () =>
      Effect.gen(function* () {
        const repo = yield* SessionTransferRepository.SessionTransferRepository;
        const initial = makeRecord();

        expect(yield* repo.getById(initial.transferId)).toEqual(Option.none());
        expect(yield* repo.upsert(initial)).toEqual(initial);
        expect(yield* repo.getById(initial.transferId)).toEqual(Option.some(initial));

        const exporting = yield* repo.transitionPhase({
          transferId: initial.transferId,
          phase: "exporting_source",
          expectedPhases: ["queued"],
          phaseDetail: "Exporting source session",
          updatedAt: IsoDateTime.make("2026-11-28T05:01:00.000Z"),
        });

        const staleQueuedReplay = makeRecord({
          phase: "queued",
          phaseDetail: "Stale replay",
          sourceThreadId: ThreadId.make("thread-tampered"),
          updatedAt: IsoDateTime.make("2026-11-28T05:01:30.000Z"),
        });
        expect(yield* repo.upsert(staleQueuedReplay)).toEqual(exporting);
        expect(yield* repo.getById(initial.transferId)).toEqual(Option.some(exporting));

        const completed = yield* repo.transitionPhase({
          transferId: initial.transferId,
          phase: "completed",
          expectedPhases: ["exporting_source"],
          destinationProjectId: ProjectId.make("project-boat"),
          destinationThreadId: ThreadId.make("thread-boat"),
          phaseDetail: null,
          updatedAt: IsoDateTime.make("2026-11-28T05:02:00.000Z"),
        });
        expect(yield* repo.listActive()).toEqual([]);

        expect(yield* repo.upsert(initial)).toEqual(completed);
        expect(yield* repo.getById(initial.transferId)).toEqual(Option.some(completed));
        expect(yield* repo.listActive()).toEqual([]);
      }).pipe(Effect.provide(memoryLayer)),
  );

  it.effect("rejects a second active transfer for the same source thread with conflict error", () =>
    Effect.gen(function* () {
      const repo = yield* SessionTransferRepository.SessionTransferRepository;
      const first = makeRecord({ transferId: SessionTransferId.make("transfer-active-1") });
      const second = makeRecord({ transferId: SessionTransferId.make("transfer-active-2") });

      yield* repo.upsert(first);
      const failure = yield* repo.upsert(second).pipe(Effect.flip);
      expect(failure._tag).toBe("SessionTransferConflictError");
      if (failure._tag === "SessionTransferConflictError") {
        expect(failure.transferId).toBe(second.transferId);
        expect(failure.sourceEnvironmentId).toBe(second.sourceEnvironmentId);
        expect(failure.sourceThreadId).toBe(second.sourceThreadId);
      }

      const differentThread = makeRecord({
        transferId: SessionTransferId.make("transfer-other-thread"),
        sourceThreadId: ThreadId.make("thread-2"),
      });
      expect(yield* repo.upsert(differentThread)).toEqual(differentThread);
    }).pipe(Effect.provide(memoryLayer)),
  );

  it.effect(
    "enforces active uniqueness under concurrent upserts on a file-backed WAL database",
    () => {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-transfer-"));
      const dbPath = NodePath.join(tempDir, "state.sqlite");
      const layer = SessionTransferRepository.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
        Layer.provide(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const repo = yield* SessionTransferRepository.SessionTransferRepository;
        const first = makeRecord({ transferId: SessionTransferId.make("transfer-race-1") });
        const second = makeRecord({ transferId: SessionTransferId.make("transfer-race-2") });

        const exits = yield* Effect.all(
          [Effect.exit(repo.upsert(first)), Effect.exit(repo.upsert(second))],
          { concurrency: "unbounded" },
        );

        const successes = exits.filter(Exit.isSuccess);
        const failures = exits.filter(Exit.isFailure);
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        const active = yield* repo.listActive();
        expect(active).toHaveLength(1);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("allows a new active transfer after a prior attempt ends in failed or cancelled", () =>
    Effect.gen(function* () {
      const repo = yield* SessionTransferRepository.SessionTransferRepository;
      const attempt1 = makeRecord({
        transferId: SessionTransferId.make("transfer-attempt-1"),
        createdAt: IsoDateTime.make("2026-11-28T05:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-11-28T05:00:00.000Z"),
      });
      yield* repo.upsert(attempt1);

      const failed = yield* repo.transitionPhase({
        transferId: attempt1.transferId,
        phase: "failed",
        expectedPhases: ["queued"],
        errorMessage: "Boat unreachable",
        updatedAt: IsoDateTime.make("2026-11-28T05:01:00.000Z"),
      });
      expect(failed.phase).toBe("failed");
      expect(failed.completedAt).toBe(IsoDateTime.make("2026-11-28T05:01:00.000Z"));
      expect(
        yield* repo.findInFlightForThread({
          sourceEnvironmentId: attempt1.sourceEnvironmentId,
          sourceThreadId: attempt1.sourceThreadId,
        }),
      ).toEqual(Option.none());

      const attempt2 = makeRecord({
        transferId: SessionTransferId.make("transfer-attempt-2"),
        createdAt: IsoDateTime.make("2026-11-28T05:02:00.000Z"),
        updatedAt: IsoDateTime.make("2026-11-28T05:02:00.000Z"),
      });
      yield* repo.upsert(attempt2);

      const cancelled = yield* repo.transitionPhase({
        transferId: attempt2.transferId,
        phase: "cancelled",
        updatedAt: IsoDateTime.make("2026-11-28T05:03:00.000Z"),
      });
      expect(cancelled.phase).toBe("cancelled");

      const attempt3 = makeRecord({
        transferId: SessionTransferId.make("transfer-attempt-3"),
        createdAt: IsoDateTime.make("2026-11-28T05:04:00.000Z"),
        updatedAt: IsoDateTime.make("2026-11-28T05:04:00.000Z"),
      });
      yield* repo.upsert(attempt3);

      expect(yield* repo.getById(attempt1.transferId)).toEqual(Option.some(failed));
      expect(yield* repo.getById(attempt2.transferId)).toEqual(Option.some(cancelled));
      expect(
        yield* repo.findInFlightForThread({
          sourceEnvironmentId: attempt1.sourceEnvironmentId,
          sourceThreadId: attempt1.sourceThreadId,
        }),
      ).toEqual(Option.some(attempt3));
      expect((yield* repo.listActive()).map((row) => row.transferId)).toEqual([
        attempt3.transferId,
      ]);
      expect((yield* repo.listRecent(10)).map((row) => row.transferId)).toEqual([
        attempt3.transferId,
        attempt2.transferId,
        attempt1.transferId,
      ]);
    }).pipe(Effect.provide(memoryLayer)),
  );

  it.effect("validates transitionPhase guards, terminal transitions, and missing records", () =>
    Effect.gen(function* () {
      const repo = yield* SessionTransferRepository.SessionTransferRepository;

      const missing = yield* repo
        .transitionPhase({
          transferId: SessionTransferId.make("transfer-missing"),
          phase: "waking_target",
          updatedAt: IsoDateTime.make("2026-11-28T05:00:00.000Z"),
        })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("SessionTransferNotFoundError");

      const record = makeRecord({ transferId: SessionTransferId.make("transfer-phase-1") });
      yield* repo.upsert(record);

      const badExpected = yield* repo
        .transitionPhase({
          transferId: record.transferId,
          phase: "committing_target",
          expectedPhases: ["transferring_workspace"],
          updatedAt: IsoDateTime.make("2026-11-28T05:01:00.000Z"),
        })
        .pipe(Effect.flip);
      expect(badExpected._tag).toBe("SessionTransferInvalidPhaseError");
      if (badExpected._tag === "SessionTransferInvalidPhaseError") {
        expect(badExpected.currentPhase).toBe("queued");
        expect(badExpected.nextPhase).toBe("committing_target");
      }

      const completed = yield* repo.transitionPhase({
        transferId: record.transferId,
        phase: "completed",
        destinationProjectId: ProjectId.make("project-boat"),
        destinationThreadId: ThreadId.make("thread-boat"),
        destinationBranch: "feat/session-transfer",
        destinationWorktreePath: "/workspace/sail",
        phaseDetail: null,
        warnings: ["Ignored build artifacts skipped."],
        updatedAt: IsoDateTime.make("2026-11-28T05:02:00.000Z"),
      });
      expect(completed.phase).toBe("completed");
      expect(completed.destinationThreadId).toBe(ThreadId.make("thread-boat"));
      expect(completed.destinationBranch).toBe("feat/session-transfer");
      expect(completed.completedAt).toBe(IsoDateTime.make("2026-11-28T05:02:00.000Z"));
      expect(completed.warnings).toEqual(["Ignored build artifacts skipped."]);

      const reopenCompleted = yield* repo
        .transitionPhase({
          transferId: record.transferId,
          phase: "queued",
          updatedAt: IsoDateTime.make("2026-11-28T05:03:00.000Z"),
        })
        .pipe(Effect.flip);
      expect(reopenCompleted._tag).toBe("SessionTransferInvalidPhaseError");
    }).pipe(Effect.provide(memoryLayer)),
  );

  it.effect("orders listActive and listRecent by updatedAt descending and respects limit", () =>
    Effect.gen(function* () {
      const repo = yield* SessionTransferRepository.SessionTransferRepository;
      const t1 = makeRecord({
        transferId: SessionTransferId.make("transfer-t1"),
        sourceThreadId: ThreadId.make("thread-1"),
        createdAt: IsoDateTime.make("2026-11-28T05:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-11-28T05:00:00.000Z"),
      });
      const t2 = makeRecord({
        transferId: SessionTransferId.make("transfer-t2"),
        sourceThreadId: ThreadId.make("thread-2"),
        createdAt: IsoDateTime.make("2026-11-28T05:01:00.000Z"),
        updatedAt: IsoDateTime.make("2026-11-28T05:05:00.000Z"),
      });
      const t3 = makeRecord({
        transferId: SessionTransferId.make("transfer-t3"),
        sourceThreadId: ThreadId.make("thread-3"),
        phase: "completed",
        createdAt: IsoDateTime.make("2026-11-28T05:02:00.000Z"),
        updatedAt: IsoDateTime.make("2026-11-28T05:03:00.000Z"),
        completedAt: IsoDateTime.make("2026-11-28T05:03:00.000Z"),
      });

      yield* repo.upsert(t1);
      yield* repo.upsert(t2);
      yield* repo.upsert(t3);

      expect((yield* repo.listActive()).map((row) => row.transferId)).toEqual([
        t2.transferId,
        t1.transferId,
      ]);
      expect((yield* repo.listActive(1)).map((row) => row.transferId)).toEqual([t2.transferId]);
      expect((yield* repo.listRecent(2)).map((row) => row.transferId)).toEqual([
        t2.transferId,
        t3.transferId,
      ]);
    }).pipe(Effect.provide(memoryLayer)),
  );
});

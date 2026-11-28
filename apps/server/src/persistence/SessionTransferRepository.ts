import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  SessionTransferId,
  SessionTransferPhase,
  SessionTransferRecord,
  ThreadId,
  isTerminalSessionTransferPhase,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

export class SessionTransferConflictError extends Schema.TaggedError<SessionTransferConflictError>()(
  "SessionTransferConflictError",
  {
    transferId: SessionTransferId,
    sourceEnvironmentId: EnvironmentId,
    sourceThreadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class SessionTransferNotFoundError extends Schema.TaggedError<SessionTransferNotFoundError>()(
  "SessionTransferNotFoundError",
  {
    transferId: SessionTransferId,
    message: Schema.String,
  },
) {}

export class SessionTransferInvalidPhaseError extends Schema.TaggedError<SessionTransferInvalidPhaseError>()(
  "SessionTransferInvalidPhaseError",
  {
    transferId: SessionTransferId,
    currentPhase: SessionTransferPhase,
    nextPhase: SessionTransferPhase,
    message: Schema.String,
  },
) {}

export type SessionTransferRepositoryError =
  | SessionTransferConflictError
  | SessionTransferNotFoundError
  | SessionTransferInvalidPhaseError
  | PersistenceSqlError
  | PersistenceDecodeError;

export interface SessionTransferInsertIfAbsentResult {
  readonly record: SessionTransferRecord;
  readonly created: boolean;
}

export interface SessionTransferTransitionPhaseInput {
  readonly transferId: SessionTransferId;
  readonly phase: SessionTransferPhase;
  readonly expectedPhases?: ReadonlyArray<SessionTransferPhase>;
  readonly phaseDetail?: string | null;
  readonly errorMessage?: string | null;
  readonly destinationEnvironmentId?: EnvironmentId | null;
  readonly destinationEnvironmentName?: SessionTransferRecord["destinationEnvironmentName"];
  readonly destinationMachineId?: SessionTransferRecord["destinationMachineId"];
  readonly destinationProjectId?: ProjectId | null;
  readonly destinationThreadId?: ThreadId | null;
  readonly sourceWasRunning?: boolean;
  readonly autoResume?: boolean;
  readonly hadPendingRuntimeRequest?: boolean;
  readonly destinationBranch?: SessionTransferRecord["destinationBranch"];
  readonly destinationWorktreePath?: SessionTransferRecord["destinationWorktreePath"];
  readonly modelSelectionOverride?: SessionTransferRecord["modelSelectionOverride"];
  readonly cloneDestinationPath?: SessionTransferRecord["cloneDestinationPath"];
  readonly warnings?: ReadonlyArray<string>;
  readonly updatedAt: IsoDateTime;
  readonly completedAt?: IsoDateTime | null;
}

export interface SessionTransferThreadLookupInput {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
}

const RecordRow = Schema.Struct({
  record: Schema.fromJsonString(SessionTransferRecord),
});

const ThreadLookupSchema = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
});

const SQLITE_CONSTRAINT_PRIMARY_CODE = 19;
const SQLITE_CONSTRAINT_UNIQUE_CODE = 2067;

function isSqliteUniqueConstraintError(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (Predicate.isObject(current) && !seen.has(current)) {
    seen.add(current);
    if ("errcode" in current && typeof current.errcode === "number") {
      if (
        current.errcode === SQLITE_CONSTRAINT_UNIQUE_CODE ||
        (current.errcode & 0xff) === SQLITE_CONSTRAINT_PRIMARY_CODE
      ) {
        const errstr =
          "errstr" in current && typeof current.errstr === "string" ? current.errstr : "";
        const message =
          "message" in current && typeof current.message === "string" ? current.message : "";
        if (
          current.errcode === SQLITE_CONSTRAINT_UNIQUE_CODE ||
          errstr.includes("UNIQUE") ||
          message.includes("UNIQUE constraint failed")
        ) {
          return true;
        }
      }
    }
    if (
      "message" in current &&
      typeof current.message === "string" &&
      current.message.includes("UNIQUE constraint failed")
    ) {
      return true;
    }
    if ("reason" in current && Predicate.isObject(current.reason) && !seen.has(current.reason)) {
      current = current.reason;
      continue;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

export class SessionTransferRepository extends Context.Service<
  SessionTransferRepository,
  {
    readonly upsert: (
      record: SessionTransferRecord,
    ) => Effect.Effect<
      SessionTransferRecord,
      SessionTransferConflictError | PersistenceSqlError | PersistenceDecodeError
    >;
    readonly insertIfAbsent: (
      record: SessionTransferRecord,
    ) => Effect.Effect<
      SessionTransferInsertIfAbsentResult,
      SessionTransferConflictError | PersistenceSqlError | PersistenceDecodeError
    >;
    readonly transitionPhase: (
      input: SessionTransferTransitionPhaseInput,
    ) => Effect.Effect<SessionTransferRecord, SessionTransferRepositoryError>;
    readonly getById: (
      transferId: SessionTransferId,
    ) => Effect.Effect<
      Option.Option<SessionTransferRecord>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly listActive: (
      limit?: number,
    ) => Effect.Effect<
      ReadonlyArray<SessionTransferRecord>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly listRecent: (
      limit?: number,
    ) => Effect.Effect<
      ReadonlyArray<SessionTransferRecord>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly findInFlightForThread: (
      input: SessionTransferThreadLookupInput,
    ) => Effect.Effect<
      Option.Option<SessionTransferRecord>,
      PersistenceSqlError | PersistenceDecodeError
    >;
  }
>()("t3/persistence/SessionTransferRepository") {}

const DEFAULT_RECENT_LIMIT = 50;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(SessionTransferRecord));

  const findByIdRow = SqlSchema.findOneOption({
    Request: SessionTransferId,
    Result: RecordRow,
    execute: (transferId) =>
      sql`
        SELECT record_json AS "record"
        FROM boat_session_transfers
        WHERE transfer_id = ${transferId}
      `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RecordRow,
    execute: () =>
      sql`
        SELECT record_json AS "record"
        FROM boat_session_transfers
        WHERE phase NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY updated_at DESC, created_at DESC, transfer_id DESC
      `,
  });

  const listActiveRowsWithLimit = SqlSchema.findAll({
    Request: Schema.Int,
    Result: RecordRow,
    execute: (limit) =>
      sql`
        SELECT record_json AS "record"
        FROM boat_session_transfers
        WHERE phase NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY updated_at DESC, created_at DESC, transfer_id DESC
        LIMIT ${limit}
      `,
  });

  const listRecentRows = SqlSchema.findAll({
    Request: Schema.Int,
    Result: RecordRow,
    execute: (limit) =>
      sql`
        SELECT record_json AS "record"
        FROM boat_session_transfers
        ORDER BY updated_at DESC, created_at DESC, transfer_id DESC
        LIMIT ${limit}
      `,
  });

  const findInFlightRow = SqlSchema.findOneOption({
    Request: ThreadLookupSchema,
    Result: RecordRow,
    execute: ({ sourceEnvironmentId, sourceThreadId }) =>
      sql`
        SELECT record_json AS "record"
        FROM boat_session_transfers
        WHERE source_environment_id = ${sourceEnvironmentId}
          AND source_thread_id = ${sourceThreadId}
          AND phase NOT IN ('completed', 'failed', 'cancelled')
        LIMIT 1
      `,
  });

  const toConflictOrSqlError =
    (record: SessionTransferRecord, operation: string) => (cause: unknown) =>
      isSqliteUniqueConstraintError(cause)
        ? new SessionTransferConflictError({
            transferId: record.transferId,
            sourceEnvironmentId: record.sourceEnvironmentId,
            sourceThreadId: record.sourceThreadId,
            message: `An active session transfer already exists for thread ${record.sourceThreadId} in environment ${record.sourceEnvironmentId}.`,
            cause,
          })
        : toPersistenceSqlError(operation)(cause);

  const insertRecordIfAbsent = (record: SessionTransferRecord, operation: string) =>
    encodeRecord(record).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError("SessionTransferRecord", cause),
      ),
      Effect.flatMap((recordJson) =>
        sql<{ readonly transferId: string }>`
          INSERT INTO boat_session_transfers (
            transfer_id,
            direction,
            source_environment_id,
            source_machine_id,
            source_project_id,
            source_thread_id,
            destination_environment_id,
            destination_machine_id,
            destination_project_id,
            destination_thread_id,
            phase,
            phase_detail,
            source_was_running,
            auto_resume,
            record_json,
            error_message,
            created_at,
            updated_at,
            completed_at
          )
          VALUES (
            ${record.transferId},
            ${record.direction},
            ${record.sourceEnvironmentId},
            ${record.sourceMachineId},
            ${record.sourceProjectId},
            ${record.sourceThreadId},
            ${record.destinationEnvironmentId},
            ${record.destinationMachineId},
            ${record.destinationProjectId},
            ${record.destinationThreadId},
            ${record.phase},
            ${record.phaseDetail},
            ${record.sourceWasRunning ? 1 : 0},
            ${record.autoResume ? 1 : 0},
            ${recordJson},
            ${record.errorMessage},
            ${record.createdAt},
            ${record.updatedAt},
            ${record.completedAt}
          )
          ON CONFLICT (transfer_id) DO NOTHING
          RETURNING transfer_id AS "transferId"
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(toConflictOrSqlError(record, operation)),
        ),
      ),
    );

  const updateRecord = (record: SessionTransferRecord, operation: string) =>
    encodeRecord(record).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError("SessionTransferRecord", cause),
      ),
      Effect.flatMap((recordJson) =>
        sql`
          UPDATE boat_session_transfers
          SET
            direction = ${record.direction},
            source_environment_id = ${record.sourceEnvironmentId},
            source_machine_id = ${record.sourceMachineId},
            source_project_id = ${record.sourceProjectId},
            source_thread_id = ${record.sourceThreadId},
            destination_environment_id = ${record.destinationEnvironmentId},
            destination_machine_id = ${record.destinationMachineId},
            destination_project_id = ${record.destinationProjectId},
            destination_thread_id = ${record.destinationThreadId},
            phase = ${record.phase},
            phase_detail = ${record.phaseDetail},
            source_was_running = ${record.sourceWasRunning ? 1 : 0},
            auto_resume = ${record.autoResume ? 1 : 0},
            record_json = ${recordJson},
            error_message = ${record.errorMessage},
            created_at = ${record.createdAt},
            updated_at = ${record.updatedAt},
            completed_at = ${record.completedAt}
          WHERE transfer_id = ${record.transferId}
        `.pipe(Effect.mapError(toConflictOrSqlError(record, operation))),
      ),
      Effect.as(record),
    );

  const insertIfAbsentImpl = Effect.fn("SessionTransferRepository.insertIfAbsent")(function* (
    record: SessionTransferRecord,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Check transfer_id before inserting so replaying a stale queued record
          // cannot trip the active-source unique index when another transfer is active.
          const existingOption = yield* findByIdRow(record.transferId).pipe(
            Effect.mapError(
              toSqlOrDecodeError("upsertSessionTransfer.read", "SessionTransferRecord"),
            ),
          );
          if (Option.isSome(existingOption)) {
            return { record: existingOption.value.record, created: false };
          }
          const insertOutcome = yield* insertRecordIfAbsent(
            record,
            "upsertSessionTransfer.write",
          ).pipe(
            Effect.map((inserted) => ({
              inserted,
              racedExisting: Option.none<SessionTransferRecord>(),
            })),
            Effect.catchTags({
              SessionTransferConflictError: (conflictError) =>
                findByIdRow(record.transferId).pipe(
                  Effect.mapError(
                    toSqlOrDecodeError(
                      "upsertSessionTransfer.readAfterConflict",
                      "SessionTransferRecord",
                    ),
                  ),
                  Effect.flatMap((rowOption) =>
                    Option.isSome(rowOption)
                      ? Effect.succeed({
                          inserted: false,
                          racedExisting: Option.some(rowOption.value.record),
                        })
                      : Effect.fail(conflictError),
                  ),
                ),
            }),
          );
          if (Option.isSome(insertOutcome.racedExisting)) {
            return { record: insertOutcome.racedExisting.value, created: false };
          }
          const persistedOption = yield* findByIdRow(record.transferId).pipe(
            Effect.mapError(
              toSqlOrDecodeError("upsertSessionTransfer.readAfterWrite", "SessionTransferRecord"),
            ),
          );
          return {
            record: Option.isSome(persistedOption) ? persistedOption.value.record : record,
            created: insertOutcome.inserted,
          };
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(toPersistenceSqlError("upsertSessionTransfer")(cause)),
        }),
      );
  });

  return SessionTransferRepository.of({
    upsert: Effect.fn("SessionTransferRepository.upsert")(function* (record) {
      const result = yield* insertIfAbsentImpl(record);
      return result.record;
    }),
    insertIfAbsent: insertIfAbsentImpl,
    transitionPhase: Effect.fn("SessionTransferRepository.transitionPhase")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existingOption = yield* findByIdRow(input.transferId).pipe(
              Effect.mapError(
                toSqlOrDecodeError("transitionSessionTransferPhase.read", "SessionTransferRecord"),
              ),
            );
            if (Option.isNone(existingOption)) {
              return yield* new SessionTransferNotFoundError({
                transferId: input.transferId,
                message: `Session transfer ${input.transferId} does not exist.`,
              });
            }
            const existing = existingOption.value.record;
            const expectedPhases = input.expectedPhases;
            if (expectedPhases !== undefined && !expectedPhases.includes(existing.phase)) {
              return yield* new SessionTransferInvalidPhaseError({
                transferId: input.transferId,
                currentPhase: existing.phase,
                nextPhase: input.phase,
                message: `Cannot transition session transfer ${input.transferId} from ${existing.phase} to ${input.phase}; expected one of: ${expectedPhases.join(", ")}.`,
              });
            }
            if (existing.phase === "completed" && input.phase !== "completed") {
              return yield* new SessionTransferInvalidPhaseError({
                transferId: input.transferId,
                currentPhase: existing.phase,
                nextPhase: input.phase,
                message: `Cannot transition completed session transfer ${input.transferId} to ${input.phase}.`,
              });
            }
            if (
              expectedPhases === undefined &&
              isTerminalSessionTransferPhase(existing.phase) &&
              input.phase !== existing.phase
            ) {
              return yield* new SessionTransferInvalidPhaseError({
                transferId: input.transferId,
                currentPhase: existing.phase,
                nextPhase: input.phase,
                message: `Cannot transition terminal session transfer ${input.transferId} from ${existing.phase} to ${input.phase}.`,
              });
            }

            const nextTerminal = isTerminalSessionTransferPhase(input.phase);
            const nextCompletedAt =
              input.completedAt !== undefined
                ? input.completedAt
                : nextTerminal
                  ? (existing.completedAt ?? input.updatedAt)
                  : null;

            const updated: SessionTransferRecord = {
              ...existing,
              phase: input.phase,
              phaseDetail:
                input.phaseDetail !== undefined ? input.phaseDetail : existing.phaseDetail,
              errorMessage:
                input.errorMessage !== undefined ? input.errorMessage : existing.errorMessage,
              destinationEnvironmentId:
                input.destinationEnvironmentId !== undefined
                  ? input.destinationEnvironmentId
                  : existing.destinationEnvironmentId,
              destinationEnvironmentName:
                input.destinationEnvironmentName !== undefined
                  ? input.destinationEnvironmentName
                  : existing.destinationEnvironmentName,
              destinationMachineId:
                input.destinationMachineId !== undefined
                  ? input.destinationMachineId
                  : existing.destinationMachineId,
              destinationProjectId:
                input.destinationProjectId !== undefined
                  ? input.destinationProjectId
                  : existing.destinationProjectId,
              destinationThreadId:
                input.destinationThreadId !== undefined
                  ? input.destinationThreadId
                  : existing.destinationThreadId,
              destinationBranch:
                input.destinationBranch !== undefined
                  ? input.destinationBranch
                  : existing.destinationBranch,
              sourceWasRunning:
                input.sourceWasRunning !== undefined
                  ? input.sourceWasRunning
                  : existing.sourceWasRunning,
              autoResume: input.autoResume !== undefined ? input.autoResume : existing.autoResume,
              hadPendingRuntimeRequest:
                input.hadPendingRuntimeRequest !== undefined
                  ? input.hadPendingRuntimeRequest
                  : existing.hadPendingRuntimeRequest,
              destinationWorktreePath:
                input.destinationWorktreePath !== undefined
                  ? input.destinationWorktreePath
                  : existing.destinationWorktreePath,
              modelSelectionOverride:
                input.modelSelectionOverride !== undefined
                  ? input.modelSelectionOverride
                  : existing.modelSelectionOverride,
              cloneDestinationPath:
                input.cloneDestinationPath !== undefined
                  ? input.cloneDestinationPath
                  : existing.cloneDestinationPath,
              warnings: input.warnings !== undefined ? input.warnings : existing.warnings,
              updatedAt: input.updatedAt,
              completedAt: nextCompletedAt,
            };

            return yield* updateRecord(updated, "transitionSessionTransferPhase.write");
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(toPersistenceSqlError("transitionSessionTransferPhase")(cause)),
          }),
        );
    }),
    getById: Effect.fn("SessionTransferRepository.getById")(function (transferId) {
      return findByIdRow(transferId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.record)),
        Effect.mapError(toSqlOrDecodeError("getSessionTransferById", "SessionTransferRecord")),
      );
    }),
    listActive: Effect.fn("SessionTransferRepository.listActive")(function (limit) {
      const query =
        limit === undefined
          ? listActiveRows(undefined)
          : listActiveRowsWithLimit(Math.max(1, Math.trunc(limit)));
      return query.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows.map((row) => row.record)),
        Effect.mapError(toSqlOrDecodeError("listActiveSessionTransfers", "SessionTransferRecord")),
      );
    }),
    listRecent: Effect.fn("SessionTransferRepository.listRecent")(function (
      limit = DEFAULT_RECENT_LIMIT,
    ) {
      return listRecentRows(Math.max(1, Math.trunc(limit))).pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows.map((row) => row.record)),
        Effect.mapError(toSqlOrDecodeError("listRecentSessionTransfers", "SessionTransferRecord")),
      );
    }),
    findInFlightForThread: Effect.fn("SessionTransferRepository.findInFlightForThread")(
      function (input) {
        return findInFlightRow(input).pipe(
          NodeSqliteClient.readOnly,
          Effect.map(Option.map((row) => row.record)),
          Effect.mapError(
            toSqlOrDecodeError("findInFlightSessionTransferForThread", "SessionTransferRecord"),
          ),
        );
      },
    ),
  });
});

export const layer = Layer.effect(SessionTransferRepository, make);

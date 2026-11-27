import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const observeDurableObligations = Effect.fn("ServerAdmission.observeDurableObligations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    // A single statement on the writer sees commits across all three domains at one point.
    const [row] = yield* sql<{
      orchestration: number;
      scheduled_delivery: number;
      remote_delegation: number;
      delegated_work: number;
      native_work: number;
      workflow: number;
      workflow_settlement: number;
      peer_link_request: number;
      peer_mutation: number;
    }>`
      SELECT (
        EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
                WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_run_attempts
                   WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'superseded'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests
                   WHERE status NOT IN ('resolved', 'expired', 'cancelled'))
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items item
          JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
          WHERE item.type = 'user_message' AND item.status = 'pending'
            AND run.status IN ('completed', 'interrupted', 'failed', 'cancelled')
            AND json_extract(item.payload_json, '$.inputIntent') IN ('steer', 'promoted_queued_to_steer')
        )
        OR EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox
                   WHERE status NOT IN ('succeeded', 'failed', 'cancelled'))
      ) AS orchestration,
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_subagents
        WHERE origin = 'app_owned' AND child_thread_id IS NULL
          AND NOT (
            json_type(payload_json, '$.remoteChild') IS 'object'
            AND json_type(payload_json, '$.result') IS 'text'
            AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
            AND json_type(payload_json, '$.remoteChild.stoppedThere') IS 'true'
            AND json_type(payload_json, '$.remoteChild.settlementVerified') IS 'true'
          )
      ) AS remote_delegation,
      (
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents
          WHERE origin = 'app_owned' AND (
            (child_thread_id IS NOT NULL AND (
              json_type(payload_json, '$.result') IS NOT 'text'
              OR status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
            ))
            OR completion_delivery_state IN ('pending', 'claimed')
          )
        )
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs
          WHERE CASE WHEN json_valid(payload_json)
            THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
            ELSE 0 END
        )
      ) AS delegated_work,
      (
        EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents
                WHERE origin = 'provider_native' AND status IN ('pending', 'starting', 'running', 'waiting'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads
                   WHERE json_array_length(payload_json, '$.pendingBackgroundTasks') > 0)
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items
                   WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
                     AND status NOT IN ('completed', 'interrupted', 'failed', 'cancelled'))
      ) AS native_work,
      (
        EXISTS (SELECT 1 FROM scheduled_tasks WHERE last_run_status = 'running')
        OR EXISTS (SELECT 1 FROM scheduled_task_webhook_pending)
      ) AS scheduled_delivery,
      EXISTS (SELECT 1 FROM workflow_runs WHERE ended_at IS NULL) AS workflow,
      (
        EXISTS (
          SELECT 1 FROM workflow_runs run
          WHERE run.status = 'cancelled'
            AND (
              NOT EXISTS (SELECT 1 FROM workflow_steps step
                          WHERE step.run_id = run.run_id AND step.name = 'onEnd'
                            AND step.status = 'completed')
              OR EXISTS (SELECT 1 FROM workflow_steps step
                         WHERE step.run_id = run.run_id AND step.name != 'onEnd'
                           AND step.status = 'running')
            )
        )
        OR EXISTS (
          SELECT 1 FROM workflow_waits wait
          JOIN workflow_runs child ON child.parent_run_id = wait.run_id
                                  AND child.parent_wait = wait.name
          WHERE wait.signalled_at IS NULL AND child.ended_at IS NOT NULL
        )
      ) AS workflow_settlement,
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items
        WHERE type = 'link_request' AND (
          status = 'waiting' OR json_extract(payload_json, '$.linkStatus') = 'pending'
        )
      ) AS peer_link_request,
      EXISTS (SELECT 1 FROM peer_mutation_intents) AS peer_mutation
    `;
    if (row === undefined) return ["quiescence-unknown"] as const;
    return [
      ...(row.orchestration ? ["orchestration" as const] : []),
      ...(row.remote_delegation ? ["remote-delegation" as const] : []),
      ...(row.delegated_work ? ["delegated-work" as const] : []),
      ...(row.native_work ? ["native-work" as const] : []),
      ...(row.scheduled_delivery ? ["scheduled-delivery" as const] : []),
      ...(row.workflow ? ["workflow" as const] : []),
      ...(row.workflow_settlement ? ["workflow-settlement" as const] : []),
      ...(row.peer_link_request ? ["peer-link-request" as const] : []),
      ...(row.peer_mutation ? ["peer-mutation-unresolved" as const] : []),
    ];
  },
);

export function makeProviderLifetimeLedger(sql: SqlClient.SqlClient) {
  // Only live, resumable sessions with an attached event pump can account for a receipt.
  const owned = new Set<number>();
  return {
    observe: sql<{ id: number }>`SELECT id FROM maintenance_provider_lifetimes`.pipe(
      Effect.map((rows) => [
        ...(rows.some(({ id }) => id >= 0 && !owned.has(id))
          ? ["provider-lifetime-unqualified" as const]
          : []),
        ...(rows.some(({ id }) => id === -1) ? ["provider-auth-unqualified" as const] : []),
      ]),
    ),
    recordUnsupported:
      sql`INSERT OR IGNORE INTO maintenance_provider_lifetimes (id) VALUES (0)`.pipe(Effect.asVoid),
    recordAuth: sql`INSERT OR IGNORE INTO maintenance_provider_lifetimes (id) VALUES (-1)`.pipe(
      Effect.asVoid,
    ),
    start: Effect.gen(function* () {
      const [row] = yield* sql<{ id: number }>`
        INSERT INTO maintenance_provider_lifetimes DEFAULT VALUES RETURNING id
      `;
      if (row === undefined) return yield* Effect.die("Provider lifetime was not recorded.");
      const unverify = Effect.sync(() => {
        owned.delete(row.id);
      });
      const settle = sql`DELETE FROM maintenance_provider_lifetimes WHERE id = ${row.id}`.pipe(
        Effect.asVoid,
      );
      let closed = false;
      let drained = false;
      return {
        qualify: Effect.sync(() => {
          owned.add(row.id);
        }),
        unverify,
        markClosed: Effect.suspend(() => {
          closed = true;
          return drained ? settle : Effect.void;
        }),
        markEventsDrained: Effect.suspend(() => {
          drained = true;
          return closed ? settle : Effect.void;
        }),
      };
    }),
  };
}

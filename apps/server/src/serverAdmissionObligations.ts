import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const observeDurableObligations = Effect.fn("ServerAdmission.observeDurableObligations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    // A single statement on the writer sees commits across all three domains at one point.
    const [row] = yield* sql<{
      orchestration: number;
      scheduled_delivery: number;
      workflow: number;
    }>`
      SELECT (
        EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
                WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_run_attempts
                   WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'superseded'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests
                   WHERE status NOT IN ('resolved', 'expired', 'cancelled'))
        OR EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox
                   WHERE status NOT IN ('succeeded', 'failed', 'cancelled'))
      ) AS orchestration,
      (
        EXISTS (SELECT 1 FROM scheduled_tasks WHERE last_run_status = 'running')
        OR EXISTS (SELECT 1 FROM scheduled_task_webhook_pending)
      ) AS scheduled_delivery,
      EXISTS (SELECT 1 FROM workflow_runs WHERE ended_at IS NULL) AS workflow
    `;
    if (row === undefined) return ["quiescence-unknown"] as const;
    return [
      ...(row.orchestration ? ["orchestration" as const] : []),
      ...(row.scheduled_delivery ? ["scheduled-delivery" as const] : []),
      ...(row.workflow ? ["workflow" as const] : []),
    ];
  },
);

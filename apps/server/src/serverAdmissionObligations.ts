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
      peer_link: number;
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
          AND json_type(payload_json, '$.remoteChild') = 'object'
          AND (
            json_extract(payload_json, '$.result') IS NULL
            OR (status IN ('cancelled', 'interrupted')
                AND json_type(payload_json, '$.remoteChild.stoppedThere') IS NOT 'true')
            OR json_type(payload_json, '$.remoteChild.stoppedThere') = 'false'
          )
      ) AS remote_delegation,
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_subagents task
        LEFT JOIN orchestration_v2_projection_runs owner ON owner.run_id = task.run_id
        WHERE task.origin = 'app_owned'
          AND ((task.child_thread_id IS NOT NULL AND json_extract(task.payload_json, '$.result') IS NULL)
            OR (task.completion_delivery_state = 'claimed'
                AND json_extract(owner.payload_json, '$.delegatedCompletion.disposition') = 'open'
                AND json_type(owner.payload_json, '$.delegatedCompletion.delivery') = 'object'))
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
      EXISTS (SELECT 1 FROM peer_environment_links) AS peer_link
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
      ...(row.peer_link ? ["peer-link-retained" as const] : []),
    ];
  },
);

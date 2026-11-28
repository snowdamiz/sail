import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE boat_session_transfers (
      transfer_id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      source_environment_id TEXT NOT NULL,
      source_machine_id TEXT,
      source_project_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      destination_environment_id TEXT,
      destination_machine_id TEXT,
      destination_project_id TEXT,
      destination_thread_id TEXT,
      phase TEXT NOT NULL,
      phase_detail TEXT,
      source_was_running INTEGER NOT NULL DEFAULT 0,
      auto_resume INTEGER NOT NULL DEFAULT 1,
      record_json TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_boat_session_transfers_active_source
    ON boat_session_transfers (source_environment_id, source_thread_id)
    WHERE phase NOT IN ('completed', 'failed', 'cancelled')
  `;
  yield* sql`
    CREATE INDEX idx_boat_session_transfers_updated_at
    ON boat_session_transfers (updated_at DESC, created_at DESC)
  `;
});

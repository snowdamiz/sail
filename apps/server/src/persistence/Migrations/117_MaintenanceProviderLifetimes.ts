import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE maintenance_provider_lifetimes (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    )
  `;
  // Older builds could start providers without leaving a lifetime receipt.
  yield* sql`
    INSERT INTO maintenance_provider_lifetimes (id)
    SELECT 0 WHERE EXISTS (
      SELECT 1 FROM orchestration_v2_projection_provider_sessions
      WHERE driver IS NOT 'acpRegistry' OR status <> 'stopped'
    )
  `;
});

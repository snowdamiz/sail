import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE peer_mutation_intents (
      environment_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_key TEXT NOT NULL,
      PRIMARY KEY (environment_id, operation, request_key)
    )
  `;
});

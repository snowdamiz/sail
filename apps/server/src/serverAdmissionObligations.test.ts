import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./persistence/Migrations.ts";
import { makeProviderLifetimeLedger } from "./serverAdmissionObligations.ts";

it.effect("keeps unresolved provider starts across database reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const filename = path.join(directory, "statev2.sqlite");
    const blocker = ["provider-lifetime-unqualified"];
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const ledger = makeProviderLifetimeLedger(yield* SqlClient.SqlClient);
      const unsupported = yield* ledger.start;
      assert.deepEqual(yield* ledger.observe, blocker);
      yield* unsupported.markEventsDrained;
      yield* unsupported.markClosed;

      const clean = yield* ledger.start;
      yield* clean.qualify;
      assert.deepEqual(yield* ledger.observe, []);
      yield* clean.markClosed;
      yield* clean.unverify;
      assert.deepEqual(yield* ledger.observe, blocker);
      yield* clean.markEventsDrained;
      assert.deepEqual(yield* ledger.observe, []);

      const lostProcess = yield* ledger.start;
      yield* lostProcess.qualify;
      assert.deepEqual(yield* ledger.observe, []);
      yield* ledger.recordAuth;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ledger = makeProviderLifetimeLedger(sql);
      assert.deepEqual(yield* ledger.observe, [...blocker, "provider-auth-unqualified"]);
      yield* ledger.recordUnsupported;
      yield* ledger.recordUnsupported;
      const rows = yield* sql<{
        id: number;
      }>`SELECT id FROM maintenance_provider_lifetimes ORDER BY id`;
      assert.deepEqual(rows, [{ id: -1 }, { id: 0 }, { id: 3 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// @effect-diagnostics nodeBuiltinImport:off - Distinct Node processes open the same fixture database in sequence.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class DelegatedDeliveryFixtureError extends Schema.TaggedError<DelegatedDeliveryFixtureError>()(
  "DelegatedDeliveryFixtureError",
  { cause: Schema.Defect() },
) {}

const runNode = NodeUtil.promisify(NodeChildProcess.execFile);
const fixture = NodeURL.fileURLToPath(
  new URL("./testkit/fixtures/delegated-delivery-restart.ts", import.meta.url),
);

it.live("recovers accepted delegated question and completion delivery across Node processes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-delegated-delivery-" });
    const database = path.join(directory, "state.sqlite");
    const run = (phase: "accept" | "recover") =>
      Effect.tryPromise({
        try: (signal) => runNode(process.execPath, [fixture, phase, database], { signal }),
        catch: (cause) => new DelegatedDeliveryFixtureError({ cause }),
      });
    const before = yield* run("accept");
    const after = yield* run("recover");
    expect(before.stdout).toMatch(/"phase":"accept","pid":\d+/);
    expect(after.stdout).toMatch(/"phase":"recover","pid":\d+/);
    expect(after.stdout.match(/"pid":\d+/)?.[0]).not.toBe(before.stdout.match(/"pid":\d+/)?.[0]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

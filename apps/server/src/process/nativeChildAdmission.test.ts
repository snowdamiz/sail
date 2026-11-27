import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAdmission, ServerAdmission } from "../serverAdmission.ts";
import { observeNativeChild } from "./nativeChildAdmission.ts";

it.live("waits for the owned native child exit after its submitting effect returns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scanned = yield* Deferred.make<void>();
      const admission = makeAdmission(Deferred.succeed(scanned, undefined).pipe(Effect.as([])));
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* admission.run(
        "root",
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(process.execPath, ["-e", "process.stdin.resume()"], {
              stdin: "pipe",
            }),
          );
          yield* observeNativeChild(child).pipe(Effect.provideService(ServerAdmission, admission));
          return child;
        }),
      );

      assert.isTrue(yield* child.isRunning);
      const token = Symbol();
      const draining = yield* admission.drain(token, "10 seconds").pipe(Effect.forkScoped);
      yield* Deferred.await(scanned);
      assert.equal(
        (yield* admission.run("root", Effect.void).pipe(Effect.flip))._tag,
        "ServerMaintenanceBusy",
      );
      assert.isUndefined(draining.pollUnsafe());
      yield* child.kill();
      assert.deepEqual(yield* Fiber.join(draining), { kind: "sealed" });
      assert.isFalse(yield* child.isRunning);
      yield* admission.abort(token);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

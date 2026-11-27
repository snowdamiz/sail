import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeAdmission } from "./serverAdmission.ts";

it.effect("holds accepted handoffs through a deadline and reopens for the same request", () =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const admission = makeAdmission(Effect.succeed([]));
    const child = yield* admission.run(
      "root",
      admission.fork(
        scope,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("finished"),
        ),
      ),
    );
    yield* Deferred.await(entered);
    const token = Symbol();
    const draining = yield* admission
      .drain(token, "1 second")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    const refused = yield* admission
      .run("root", Effect.die("closure should win"))
      .pipe(Effect.flip);
    assert.equal(refused._tag, "ServerMaintenanceBusy");
    assert.isTrue(refused.retryable);
    assert.deepEqual(yield* admission.drain(Symbol(), "1 second"), {
      kind: "busy",
      retryable: true,
      reason: "drain-in-progress",
    });
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Fiber.join(draining), {
      kind: "aborted",
      reason: "deadline",
      retryable: true,
      blockers: ["in-flight"],
    });
    assert.isUndefined(child.pollUnsafe());
    assert.equal(yield* admission.run("root", Effect.succeed(42)), 42);
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Fiber.join(child), "finished");
  }),
);

it.effect("rechecks obligations behind the seal and fences mismatched abort requests", () =>
  Effect.gen(function* () {
    const firstScan = yield* Deferred.make<void>();
    const allowFirstScan = yield* Deferred.make<void>();
    const secondScan = yield* Deferred.make<void>();
    const allowSecondScan = yield* Deferred.make<void>();
    const readWithObligation = yield* Deferred.make<void>();
    let reads = 0;
    let pending = false;
    const admission = makeAdmission(
      Effect.gen(function* () {
        switch (++reads) {
          case 1:
            yield* Deferred.succeed(firstScan, undefined);
            yield* Deferred.await(allowFirstScan);
            return [];
          case 2:
            yield* Deferred.succeed(secondScan, undefined);
            yield* Deferred.await(allowSecondScan);
            return pending ? (["orchestration"] as const) : [];
          default:
            if (pending) yield* Deferred.succeed(readWithObligation, undefined);
            return pending ? (["orchestration"] as const) : [];
        }
      }),
    );
    const token = Symbol();
    const draining = yield* admission.drain(token, "10 seconds").pipe(Effect.forkScoped);
    yield* Deferred.await(firstScan);
    yield* admission.run(
      "continuation",
      Effect.sync(() => {
        pending = true;
      }),
    );
    yield* Deferred.succeed(allowFirstScan, undefined);
    yield* Deferred.await(secondScan);
    const refused = yield* admission.run("continuation", Effect.void).pipe(Effect.flip);
    assert.equal(refused._tag, "ServerMaintenanceBusy");
    assert.isFalse(yield* admission.abort(Symbol()));
    yield* Deferred.succeed(allowSecondScan, undefined);
    yield* Deferred.await(readWithObligation);
    yield* admission.run(
      "continuation",
      Effect.sync(() => {
        pending = false;
      }),
    );
    assert.deepEqual(yield* Fiber.join(draining), { kind: "sealed" });
    assert.equal(
      (yield* admission.run("root", Effect.void).pipe(Effect.flip))._tag,
      "ServerMaintenanceBusy",
    );
    assert.isTrue(yield* admission.abort(token));
    yield* admission.run("root", Effect.void);
  }),
);

it.effect("a stalled observer cannot hold admission closed past the deadline", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const admission = makeAdmission(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as([]),
        Effect.ensuring(Deferred.succeed(finished, undefined)),
        Effect.uninterruptible,
      ),
    );
    yield* Effect.gen(function* () {
      const draining = yield* admission.drain(Symbol(), "1 second").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* Fiber.join(draining), {
        kind: "aborted",
        reason: "deadline",
        retryable: true,
        blockers: ["quiescence-unknown"],
      });
      yield* admission.run("root", Effect.void);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    yield* Deferred.await(finished);
    yield* admission.run("root", Effect.void);
  }),
);

it.effect("an empty census cannot seal on a zero budget", () =>
  Effect.gen(function* () {
    const admission = makeAdmission(Effect.succeed([]));
    assert.deepEqual(yield* admission.drain(Symbol(), 0), {
      kind: "aborted",
      reason: "deadline",
      retryable: true,
      blockers: [],
    });
    yield* admission.run("root", Effect.void);
  }),
);

it.effect("keeps the production inventory blocker even if the durable census is empty", () =>
  Effect.gen(function* () {
    const admission = makeAdmission(Effect.succeed([]), "incomplete");
    assert.isFalse(admission.producerInventoryComplete);
    const draining = yield* admission
      .drain(Symbol(), "1 second")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Fiber.join(draining), {
      kind: "aborted",
      reason: "deadline",
      retryable: true,
      blockers: ["producer-inventory-incomplete"],
    });
    assert.isTrue(makeAdmission(Effect.succeed([]), "complete").producerInventoryComplete);
  }),
);

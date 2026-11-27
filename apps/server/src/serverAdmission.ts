import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class ServerMaintenanceBusy extends Schema.TaggedError<ServerMaintenanceBusy>()(
  "ServerMaintenanceBusy",
  { retryable: Schema.Literal(true) },
) {
  override get message() {
    return "Server maintenance is in progress. Retry the same request.";
  }
}

export const isServerMaintenanceBusy = Schema.is(ServerMaintenanceBusy);

type LiveProducer =
  | "native-child"
  | "provider-continuation"
  | "provider-session"
  | "terminal-process"
  | "terminal-settlement";

type DrainBlocker =
  | LiveProducer
  | "in-flight"
  | "orchestration"
  | "remote-delegation"
  | "delegated-work"
  | "native-work"
  | "scheduled-delivery"
  | "workflow"
  | "quiescence-unknown"
  | "producer-inventory-incomplete";

type Drain = {
  readonly token: symbol;
  readonly aborted: Deferred.Deferred<void>;
};

type Phase =
  | { readonly kind: "open" }
  | { readonly kind: "draining" | "sealing" | "sealed"; readonly drain: Drain };

type DrainResult =
  | { readonly kind: "sealed" }
  | { readonly kind: "busy"; readonly retryable: true; readonly reason: "drain-in-progress" }
  | {
      readonly kind: "aborted";
      readonly retryable: true;
      readonly reason: "deadline" | "requested" | "observation-changed";
      readonly blockers: ReadonlyArray<DrainBlocker>;
    };

class CurrentPermit extends Context.Reference<symbol | undefined>("t3/serverAdmission/permit", {
  defaultValue: () => undefined,
}) {}

export const makeAdmission = <E>(
  observe: Effect.Effect<ReadonlyArray<DrainBlocker>, E>,
  producerInventory?: "complete" | "incomplete",
) => {
  // Gate changes and permit registration run in synchronous sections on the server's JS thread.
  let phase: Phase = { kind: "open" };
  const permits = new Set<symbol>();
  const observers = new Set<Effect.Effect<ReadonlyArray<DrainBlocker>>>();
  const liveProducers = new Map<LiveProducer, number>();
  let observerRevision = 0;
  let changed = Deferred.makeUnsafe<void>();

  const signalChange = () => {
    const previous = changed;
    changed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  };

  const registerObserver = (observer: Effect.Effect<ReadonlyArray<DrainBlocker>>) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        observers.add(observer);
        observerRevision++;
        signalChange();
      }),
      () =>
        Effect.sync(() => {
          observers.delete(observer);
          observerRevision++;
          signalChange();
        }),
    );

  // Called by an admitted owner before handing a lifetime to a scope or native callback.
  const trackLifetime = (producer: LiveProducer) => {
    liveProducers.set(producer, (liveProducers.get(producer) ?? 0) + 1);
    observerRevision++;
    if (phase.kind !== "open") signalChange();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (liveProducers.get(producer) ?? 1) - 1;
      if (remaining === 0) liveProducers.delete(producer);
      else liveProducers.set(producer, remaining);
      observerRevision++;
      if (phase.kind !== "open") signalChange();
    };
  };

  const acquirePermit = (lane: "root" | "continuation", parent: symbol | undefined) =>
    Effect.suspend(() => {
      const inherited = parent !== undefined && permits.has(parent);
      if (
        !inherited &&
        phase.kind !== "open" &&
        !(phase.kind === "draining" && lane === "continuation")
      ) {
        return Effect.fail(new ServerMaintenanceBusy({ retryable: true }));
      }
      const permit = Symbol();
      permits.add(permit);
      return Effect.succeed(permit);
    });

  const releasePermit = (permit: symbol) => {
    permits.delete(permit);
    if (phase.kind !== "open") signalChange();
  };

  const run = Effect.fnUntraced(function* <A, E, R>(
    lane: "root" | "continuation",
    work: Effect.Effect<A, E, R>,
  ) {
    const parent = yield* CurrentPermit;
    return yield* Effect.acquireUseRelease(
      acquirePermit(lane, parent),
      (permit) => Effect.provideService(work, CurrentPermit, permit),
      (permit) => Effect.sync(() => releasePermit(permit)),
    );
  });

  const fork = <A, E, R>(scope: Scope.Scope | undefined, work: Effect.Effect<A, E, R>) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const parent = yield* CurrentPermit;
        const permit = yield* acquirePermit("continuation", parent);
        const fiber = yield* work.pipe(
          Effect.provideService(CurrentPermit, permit),
          scope === undefined ? Effect.forkDetach : Effect.forkIn(scope),
          Effect.onError(() => Effect.sync(() => releasePermit(permit))),
        );
        fiber.addObserver(() => releasePermit(permit));
        return fiber;
      }),
    );

  const abort = Effect.fn("ServerAdmission.abort")(function* (token: symbol) {
    if (phase.kind === "open" || phase.drain.token !== token) return false;
    const { aborted } = phase.drain;
    phase = { kind: "open" };
    yield* Deferred.succeed(aborted, undefined);
    return true;
  }, Effect.uninterruptible);

  const drain = Effect.fn("ServerAdmission.drain")(function* (
    token: symbol,
    budget: Duration.Input,
  ): Effect.fn.Return<DrainResult> {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const clock = yield* Clock.clockWith(Effect.succeed);
        if (phase.kind !== "open") {
          return { kind: "busy", retryable: true, reason: "drain-in-progress" } as const;
        }
        const duration = Duration.toNanos(budget);
        if (Option.isNone(duration) || duration.value <= 0n) {
          return { kind: "aborted", retryable: true, reason: "deadline", blockers: [] } as const;
        }
        const deadline = clock.monotonicTimeNanosUnsafe() + duration.value;
        const attempt = { token, aborted: Deferred.makeUnsafe<void>() };
        phase = { kind: "draining", drain: attempt };
        let blockers: ReadonlyArray<DrainBlocker> = ["quiescence-unknown"];
        let finalRevision = observerRevision;
        const stillDraining = () => phase.kind !== "open" && phase.drain === attempt;
        const waitForSettlement = Effect.gen(function* () {
          // A read-only observer can finish after a deadline without holding admission closed.
          const read = Effect.gen(function* () {
            const census = Effect.all([observe, ...observers]).pipe(
              Effect.map((reports) => [
                ...new Set([
                  ...reports.flat(),
                  ...liveProducers.keys(),
                  ...(producerInventory === "incomplete"
                    ? ["producer-inventory-incomplete" as const]
                    : []),
                ]),
              ]),
            );
            const result = yield* Effect.acquireUseRelease(
              Effect.forkDetach(Effect.exit(census), { startImmediately: true }),
              Fiber.join,
              (scan) => Effect.sync(() => scan.interruptUnsafe()),
            );
            return Exit.isSuccess(result) ? result.value : (["quiescence-unknown"] as const);
          });
          while (stillDraining()) {
            const notification = changed;
            blockers = permits.size > 0 ? ["in-flight"] : yield* read;
            if (!stillDraining()) return "requested";
            if (blockers.length === 0) {
              phase = { kind: "sealing", drain: attempt };
              while (permits.size > 0) yield* Deferred.await(changed);
              if (!stillDraining()) return "requested";
              finalRevision = observerRevision;
              blockers = yield* read;
              if (!stillDraining()) return "requested";
              if (blockers.length === 0 && finalRevision === observerRevision) return "settled";
              phase = { kind: "draining", drain: attempt };
            }
            // Durable owners can settle independently of admission permit changes.
            yield* Deferred.await(notification).pipe(Effect.timeoutOption("100 millis"));
          }
          return "requested";
        });
        const result = yield* restore(
          Effect.raceAllFirst([
            Effect.sleep(budget).pipe(Effect.as("deadline" as const)),
            Deferred.await(attempt.aborted).pipe(Effect.as("requested" as const)),
            waitForSettlement,
          ]),
        ).pipe(Effect.onInterrupt(() => (stillDraining() ? abort(token) : Effect.void)));
        const expired = result === "deadline" || clock.monotonicTimeNanosUnsafe() >= deadline;
        const settled = stillDraining() && result === "settled";
        if (!expired && settled && finalRevision === observerRevision) {
          phase = { kind: "sealed", drain: attempt };
          return { kind: "sealed" } as const;
        }
        if (stillDraining()) yield* abort(token);
        return {
          kind: "aborted",
          retryable: true,
          reason: expired ? "deadline" : settled ? "observation-changed" : "requested",
          blockers,
        } as const;
      }),
    );
  });

  return {
    run,
    fork,
    drain,
    abort,
    registerObserver,
    trackLifetime,
    producerInventoryComplete: producerInventory === "complete",
  };
};

export class ServerAdmission extends Context.Reference<
  ReturnType<typeof makeAdmission> | undefined
>("t3/serverAdmission", { defaultValue: () => undefined }) {}

export const withAdmission =
  (lane: "root" | "continuation") =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | ServerMaintenanceBusy, R> =>
    Effect.flatMap(ServerAdmission, (admission) => admission?.run(lane, work) ?? work);

export const forkAccepted =
  (scope?: Scope.Scope) =>
  <A, E, R>(
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<Fiber.Fiber<A, E>, ServerMaintenanceBusy, R> =>
    Effect.flatMap(ServerAdmission, (admission) =>
      admission !== undefined
        ? admission.fork(scope, work)
        : scope === undefined
          ? Effect.forkDetach(work)
          : Effect.forkIn(work, scope),
    );

import type { BoatEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { foldBoatEvents } from "./boats.ts";

it.effect("keeps the latest status and state", () =>
  Effect.gen(function* () {
    const events: BoatEvent[] = [
      { _tag: "status", status: { phase: "starting", error: null } },
      { _tag: "state", state: { setup: "signInBoat" } },
      { _tag: "status", status: { phase: "ready", error: null } },
      { _tag: "state", state: { setup: "ready" } },
    ];

    const views = yield* Stream.fromIterable(events).pipe(foldBoatEvents, Stream.runCollect);

    expect(views).toEqual([
      { status: null, state: null },
      { status: { phase: "starting", error: null }, state: null },
      { status: { phase: "starting", error: null }, state: { setup: "signInBoat" } },
      { status: { phase: "ready", error: null }, state: { setup: "signInBoat" } },
      { status: { phase: "ready", error: null }, state: { setup: "ready" } },
    ]);
  }),
);

it.effect("forgets a stopped daemon's state until the restarted one sends its own", () =>
  Effect.gen(function* () {
    const events: BoatEvent[] = [
      { _tag: "status", status: { phase: "ready", error: null } },
      { _tag: "state", state: { setup: "ready", machines: ["old"] } },
      { _tag: "status", status: { phase: "error", error: "sail-boatd exited" } },
      { _tag: "status", status: { phase: "starting", error: null } },
      { _tag: "status", status: { phase: "ready", error: null } },
      { _tag: "state", state: { setup: "ready", machines: ["new"] } },
    ];

    const views = yield* Stream.fromIterable(events).pipe(foldBoatEvents, Stream.runCollect);

    expect(views.slice(3).map((view) => view.state)).toEqual([
      null,
      null,
      null,
      { setup: "ready", machines: ["new"] },
    ]);
  }),
);

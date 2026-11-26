import type { BoatEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { type BoatNotice, foldBoatEvents } from "./boats.ts";

it.effect("keeps the latest status and state, and hands notices to onNotify", () =>
  Effect.gen(function* () {
    const notices: BoatNotice[] = [];
    const events: BoatEvent[] = [
      { _tag: "status", status: { phase: "starting", error: null } },
      { _tag: "state", state: { setup: "signInBoat" } },
      { _tag: "notify", title: "Sail Boat", body: "Machine ready" },
      { _tag: "status", status: { phase: "ready", error: null } },
      { _tag: "state", state: { setup: "ready" } },
    ];

    const views = yield* Stream.fromIterable(events).pipe(
      foldBoatEvents((notice) => notices.push(notice)),
      Stream.runCollect,
    );

    expect(views).toEqual([
      { status: null, state: null },
      { status: { phase: "starting", error: null }, state: null },
      { status: { phase: "starting", error: null }, state: { setup: "signInBoat" } },
      { status: { phase: "ready", error: null }, state: { setup: "signInBoat" } },
      { status: { phase: "ready", error: null }, state: { setup: "ready" } },
    ]);
    expect(notices).toEqual([{ _tag: "notify", title: "Sail Boat", body: "Machine ready" }]);
  }),
);

import { type BoatDaemonStatus, type BoatEvent, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** One server's Boats as its `subscribeBoats` stream last told them. `state` is the daemon's UiState JSON. */
export interface BoatsView {
  readonly status: BoatDaemonStatus | null;
  readonly state: unknown;
}

export interface BoatNotice {
  readonly title: string;
  readonly body: string;
}

const EMPTY_BOATS_VIEW: BoatsView = { status: null, state: null };

type BoatViewEvent = Exclude<BoatEvent, { readonly _tag: "notify" }>;

export const foldBoatEvents =
  (onNotify: (notice: BoatNotice) => void) =>
  <E, R>(events: Stream.Stream<BoatEvent, E, R>): Stream.Stream<BoatsView, E, R> =>
    events.pipe(
      Stream.tap((event) =>
        event._tag === "notify" ? Effect.sync(() => onNotify(event)) : Effect.void,
      ),
      Stream.filter((event): event is BoatViewEvent => event._tag !== "notify"),
      Stream.scan(
        () => EMPTY_BOATS_VIEW,
        (view, event) =>
          event._tag === "status"
            ? { ...view, status: event.status }
            : { ...view, state: event.state },
      ),
    );

export function createBoatsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: { readonly onNotify: (notice: BoatNotice) => void },
) {
  return {
    view: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:boats:view",
      tag: WS_METHODS.subscribeBoats,
      idleTtlMs: 0,
      transform: foldBoatEvents(options.onNotify),
    }),
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:boats:invoke",
      tag: WS_METHODS.boatsInvoke,
    }),
  };
}

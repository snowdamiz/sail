import {
  type BoatDaemonStatus,
  type BoatEvent,
  type BoatNotice,
  WS_METHODS,
} from "@t3tools/contracts";
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

const EMPTY_BOATS_VIEW: BoatsView = { status: null, state: null };

export const foldBoatEvents = <E, R>(
  events: Stream.Stream<BoatEvent, E, R>,
): Stream.Stream<BoatsView, E, R> =>
  events.pipe(
    Stream.scan(
      () => EMPTY_BOATS_VIEW,
      (view, event) =>
        event._tag === "status"
          ? {
              status: event.status,
              state: event.status.phase === "ready" ? view.state : null,
            }
          : { ...view, state: event.state },
    ),
  );

export function createBoatsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: { readonly onNotice: (notice: BoatNotice) => void },
) {
  return {
    view: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:boats:view",
      tag: WS_METHODS.subscribeBoats,
      idleTtlMs: 0,
      transform: foldBoatEvents,
    }),
    notices: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:boats:notices",
      tag: WS_METHODS.subscribeBoatNotices,
      idleTtlMs: 0,
      transform: Stream.tap((notice) => Effect.sync(() => options.onNotice(notice))),
    }),
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:boats:invoke",
      tag: WS_METHODS.boatsInvoke,
    }),
  };
}

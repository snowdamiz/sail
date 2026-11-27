import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationReadScope, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { boatServerIdAtom } from "~/state/boats";
import { useEnvironmentScope } from "~/state/session";
import { toastManager } from "../ui/toast";

const toastBoatNotices = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:boats:notice-toasts",
  tag: WS_METHODS.subscribeBoatNotices,
  idleTtlMs: 0,
  transform: Stream.tap(({ title, body }) =>
    Effect.sync(() => toastManager.add({ type: "info", title, description: body })),
  ),
});

const NO_BOAT_NOTICES = Atom.make(AsyncResult.initial()).pipe(
  Atom.withLabel("environment-data:boats:notice-toasts:none"),
);

export function BoatNoticeToasts() {
  const environmentId = useAtomValue(boatServerIdAtom);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  useAtomMount(
    environmentId !== null && canRead
      ? toastBoatNotices({ environmentId, input: {} })
      : NO_BOAT_NOTICES,
  );
  return null;
}

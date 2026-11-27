import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { ServerAdmission } from "../serverAdmission.ts";

export const layer = Layer.effect(
  ProviderContinuationRequests.ProviderContinuationRequests,
  Effect.gen(function* () {
    const admission = yield* ServerAdmission;
    const queue =
      yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
    const pending = new WeakMap<
      ProviderContinuationRequests.ProviderContinuationRequest,
      () => void
    >();
    return {
      offer: Effect.fn("ProviderContinuationInbox.offer")(
        (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
          Effect.sync(() => {
            // Retries can enqueue the same request while its previous delivery is retiring.
            const entry = { ...request };
            const release = admission?.trackLifetime("provider-continuation");
            if (release !== undefined) pending.set(entry, release);
            if (!Queue.offerUnsafe(queue, entry)) release?.();
          }),
      ),
      take: Queue.take(queue),
      settled: (entry: ProviderContinuationRequests.ProviderContinuationRequest) => {
        const release = pending.get(entry);
        pending.delete(entry);
        release?.();
      },
    };
  }),
);

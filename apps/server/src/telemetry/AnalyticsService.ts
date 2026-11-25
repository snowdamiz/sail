import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Whether the event was queued to send; always false because Sail disables T3 telemetry. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
      options?: { readonly anonymous?: boolean },
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(() =>
  Effect.succeed(false),
);

const recordOwners: AnalyticsService["Service"]["recordOwners"] = Effect.fn(
  "AnalyticsService.recordOwners",
)(() => Effect.void);

/**
 * Sail does not transmit analytics or usage telemetry to external T3/PostHog servers.
 * @public
 */
export const make = Effect.succeed(
  AnalyticsService.of({
    record,
    flush: Effect.void,
    recordOwners,
  }),
);

export const layer = Layer.effect(AnalyticsService, make);

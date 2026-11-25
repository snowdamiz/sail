import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("never sends telemetry to T3 or PostHog servers even when env vars are set", () =>
  Effect.gen(function* () {
    let requestCount = 0;
    const mockClient = HttpClient.make((request) => {
      requestCount += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
      );
    });

    const analytics = yield* AnalyticsService.AnalyticsService.pipe(
      Effect.provide(
        AnalyticsService.layer.pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, mockClient)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_TELEMETRY_ENABLED: "true",
                  T3CODE_POSTHOG_HOST: "https://ingest.t3.codes",
                  T3CODE_POSTHOG_KEY: "phc_test_key",
                },
              }),
            ),
          ),
        ),
      ),
    );

    const recorded = yield* analytics.record("app.started", { foo: "bar" });
    const recordedAnonymous = yield* analytics.record(
      "agent.feedback",
      { kind: "bug" },
      { anonymous: true },
    );
    yield* analytics.recordOwners([{ source: "device", ownerId: "user-1" }], "server");
    yield* analytics.flush;

    assert.isFalse(recorded);
    assert.isFalse(recordedAnonymous);
    assert.equal(requestCount, 0);
  }),
);

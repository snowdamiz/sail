import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
// Load the runtime's module graph once at collection, outside the per-test timeout;
// each case re-evaluates it from that cache after vi.resetModules().
import "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("web runtime tracing privacy", () => {
  it("records spans locally without making outbound fetch requests even when legacy relay OTLP env vars are set", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.example.test");
    vi.stubGlobal("window", { location: new URL("https://app.example.test/") });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchFn);

    const { runtime: freshRuntime } = await import("./runtime");
    const { setDelegate } = await import("../observability/clientTracer");
    const recordedSpans: Array<string> = [];

    try {
      setDelegate(
        Tracer.make({
          span(options) {
            recordedSpans.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        }),
      );
      expect(
        await freshRuntime.runPromise(
          Effect.succeed("operation completed").pipe(Effect.withSpan("relay.first-operation")),
        ),
      ).toBe("operation completed");
      await freshRuntime.runPromise(Effect.void.pipe(Effect.withSpan("user.work")));
      expect(recordedSpans).toEqual(["relay.first-operation", "user.work"]);
    } finally {
      setDelegate(null);
      await freshRuntime.dispose();
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "./config.ts";
import * as Observability from "./observability/Observability.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";

const SHIPPED_ROOTS = ["apps", "packages", "scripts"] as const;

const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".turbo",
  ".vite",
  "coverage",
  "__tests__",
  "testUtils",
  "testkit",
  "fixtures",
  "target",
]);

const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const BANNED_DEPENDENCY_PATTERNS = [
  "posthog",
  "@sentry/",
  "mixpanel",
  "amplitude",
  "@segment/",
  "datadog",
  "@axiomhq/",
  "@alchemy.run/axiom",
] as const;

const BANNED_SOURCE_TOKENS = [
  "google.com/s2/favicons",
  "api.axiom.co",
  "t3code:analytics-device-id",
  "AnalyticsService",
  "ProviderTurnAnalytics",
  "DelegatedTaskAnalytics",
  "RelayClientTracer",
  "withRelayClientTracing",
  "VITE_RELAY_OTLP_TRACES",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES",
  "T3CODE_POSTHOG",
  "t3_feedback",
  "anonymousIdPath",
  "navigator.sendBeacon",
  "crashReporter.start",
] as const;

const TEST_FILE_PATTERN = /\.(test|spec)\.[^./]+$/u;

const isShippedSourceFile = (fileName: string): boolean => {
  if (TEST_FILE_PATTERN.test(fileName)) return false;
  const dot = fileName.lastIndexOf(".");
  return dot !== -1 && SOURCE_FILE_EXTENSIONS.has(fileName.slice(dot));
};

const walkFiles = Effect.fn("noAnalytics.walkFiles")(function* (
  dir: string,
  predicate: (fileName: string) => boolean,
): Effect.fn.Return<Array<string>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const results: Array<string> = [];
  const stack: Array<string> = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      if (IGNORED_DIRECTORY_NAMES.has(entry)) continue;
      const fullPath = path.join(current, entry);
      const info = yield* fs.stat(fullPath).pipe(Effect.orElseSucceed(() => null));
      if (info === null) continue;
      if (info.type === "Directory") {
        stack.push(fullPath);
      } else if (info.type === "File" && predicate(entry)) {
        results.push(fullPath);
      }
    }
  }

  return results;
});

const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, "../../..");
});

const decodeLegacyServerSettings = Schema.decodeUnknownEffect(fromLenientJson(ServerSettings));

it.layer(NodeServices.layer)("no-analytics privacy guardrails", (it) => {
  describe("structural source and dependency scan", () => {
    it.effect("ships zero analytics or telemetry SDK dependencies in package.json files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repoRoot;

        const packageJsonFiles: Array<string> = [path.join(root, "package.json")];
        for (const shippedRoot of SHIPPED_ROOTS) {
          const found = yield* walkFiles(
            path.join(root, shippedRoot),
            (name) => name === "package.json",
          );
          packageJsonFiles.push(...found);
        }

        const violations: Array<string> = [];
        for (const filePath of packageJsonFiles) {
          const raw = yield* fs.readFileString(filePath);
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          for (const field of [
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
          ] as const) {
            const deps = parsed[field];
            if (typeof deps !== "object" || deps === null) continue;
            for (const depName of Object.keys(deps as Record<string, unknown>)) {
              for (const banned of BANNED_DEPENDENCY_PATTERNS) {
                if (depName.toLowerCase().includes(banned)) {
                  violations.push(`${path.relative(root, filePath)} (${field}): ${depName}`);
                }
              }
            }
          }
        }

        assert.deepEqual(violations, []);
      }),
    );

    it.effect("ships zero banned analytics identifiers or third-party proxy URLs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repoRoot;

        const violations: Array<string> = [];
        for (const shippedRoot of SHIPPED_ROOTS) {
          const files = yield* walkFiles(path.join(root, shippedRoot), isShippedSourceFile);
          for (const filePath of files) {
            const contents = yield* fs.readFileString(filePath);
            for (const token of BANNED_SOURCE_TOKENS) {
              if (contents.includes(token)) {
                violations.push(`${path.relative(root, filePath)}: ${token}`);
              }
            }
          }
        }

        assert.deepEqual(violations, []);
      }),
    );
  });

  describe("runtime observability privacy", () => {
    const runWithObservability = (options: {
      readonly env: Readonly<Record<string, string>>;
      readonly explicitOtlpTracesUrl?: string;
    }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-no-analytics-otel-" }),
        );
        const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
        yield* ServerConfig.ensureServerDirectories(derivedPaths);

        const otel = yield* OtelEnvironment.load.pipe(
          Effect.provideService(HostProcess.Environment, options.env),
        );
        const signalExport = {
          protocol: "http/json" as const,
          headers: {},
          exportIntervalMs: 1_000,
        };
        const traces = OtelEnvironment.resolveSignalEndpoint(
          otel,
          "traces",
          { url: options.explicitOtlpTracesUrl, export: signalExport },
          { bootstrapUrl: undefined, settingsUrl: undefined },
        );
        const metrics = OtelEnvironment.resolveSignalEndpoint(
          otel,
          "metrics",
          { url: undefined, export: signalExport },
          { bootstrapUrl: undefined, settingsUrl: undefined },
        );
        const logs = OtelEnvironment.resolveSignalEndpoint(
          otel,
          "logs",
          { url: undefined, export: signalExport },
          { bootstrapUrl: undefined, settingsUrl: undefined },
        );

        const config: ServerConfig.ServerConfig["Service"] = {
          logLevel: "Error",
          traceMinLevel: "Info",
          traceTimingEnabled: true,
          traceBatchWindowMs: 50,
          traceMaxBytes: 10 * 1024 * 1024,
          traceMaxFiles: 5,
          otlpTracesUrl: traces?.url,
          otlpMetricsUrl: metrics?.url,
          otlpLogsUrl: logs?.url,
          otlpTracesExport: traces?.export ?? signalExport,
          otlpMetricsExport: metrics?.export ?? signalExport,
          otlpLogsExport: logs?.export ?? signalExport,
          otelEnvironment: otel,
          cwd: baseDir,
          baseDir,
          ...derivedPaths,
          builtinSkillsEnabled: false,
          mode: "web",
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          port: 0,
          host: undefined,
          desktopBootstrapToken: undefined,
          desktopTelemetryFd: undefined,
          desktopTelemetryControlFd: undefined,
          desktopBrowserFd: undefined,
          desktopBrowserControlFd: undefined,
          resourceMonitorPath: undefined,
          staticDir: undefined,
          devUrl: undefined,
          devAllowedOrigins: [],
          noBrowser: false,
          startupPresentation: "browser",
        };

        const fetchedUrls: Array<string> = [];
        const fetchSpy = vi.fn<typeof fetch>(async (input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          fetchedUrls.push(url);
          return new Response(null, { status: 202 });
        });
        vi.stubGlobal("fetch", fetchSpy);

        try {
          const layer = Observability.layer.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(ResourceAttribution.layer),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(HostProcess.Hostname, "privacy-test-host")),
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.logInfo("privacy probe log");
              yield* Effect.void.pipe(Effect.withSpan("privacy.probe"));
            }).pipe(Effect.provide(layer)),
          );
        } finally {
          vi.unstubAllGlobals();
        }

        return {
          fetchedUrls,
          tracesUrl: traces?.url,
          metricsUrl: metrics?.url,
          logsUrl: logs?.url,
        };
      }).pipe(Effect.scoped);

    it.effect(
      "emits zero outbound fetch requests by default even when legacy telemetry env vars are set, while user-configured OTLP export still works",
      () =>
        Effect.gen(function* () {
          const legacyEnv = {
            T3CODE_TELEMETRY_ENABLED: "true",
            T3CODE_POSTHOG_HOST: "https://us.i.posthog.com",
            T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          };

          const defaultRun = yield* runWithObservability({ env: legacyEnv });
          assert.isUndefined(defaultRun.tracesUrl);
          assert.isUndefined(defaultRun.metricsUrl);
          assert.isUndefined(defaultRun.logsUrl);
          assert.deepEqual(defaultRun.fetchedUrls, []);

          // Positive control proves the fetch spy captures user-configured OTLP exports.
          const explicitUrl = "https://otlp.example.test/v1/traces";
          const explicitRun = yield* runWithObservability({
            env: legacyEnv,
            explicitOtlpTracesUrl: explicitUrl,
          });
          assert.equal(explicitRun.tracesUrl, explicitUrl);
          assert.include(explicitRun.fetchedUrls, explicitUrl);
        }),
    );
  });

  describe("legacy settings and enterprise policy compatibility", () => {
    it.effect("decodes legacy settings.json containing agentFeedback without error", () =>
      Effect.gen(function* () {
        const decoded = yield* decodeLegacyServerSettings(
          JSON.stringify({
            agentFeedback: { mode: "auto" },
            storageCleanup: { logsAfterDays: 30 },
          }),
        );
        assert.equal(decoded.storageCleanup.logsAfterDays, 30);
        assert.isFalse("agentFeedback" in decoded);
      }),
    );

    it.effect(
      "validates legacy managed policy containing limits.telemetry and agentFeedback.mode without error",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-no-analytics-policy-" });
          const policyPath = path.join(dir, "policy.json");
          yield* fs.writeFileString(
            policyPath,
            JSON.stringify({
              schemaVersion: 1,
              organization: "Example Corp",
              limits: { telemetry: false },
              settings: {
                "agentFeedback.mode": { value: "off", locked: true },
              },
            }),
          );
          const policy = yield* ManagedPolicy.load(policyPath);
          assert.equal(policy.summary?.organization, "Example Corp");
          assert.deepEqual(policy.summary?.limits, { telemetry: false });
          assert.deepEqual(policy.summary?.lockedSettings, []);
        }).pipe(Effect.scoped),
    );
  });
});

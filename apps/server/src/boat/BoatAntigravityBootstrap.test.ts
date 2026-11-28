import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as ProviderInstallation from "../provider/providerInstallation.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeLayer } from "./BoatAntigravityBootstrap.ts";

const ANTIGRAVITY_ID = ProviderInstanceId.make("antigravity");
const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");

const idleState: ProviderInstallState = {
  driver: ANTIGRAVITY_DRIVER,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  canRemove: false,
  message: null,
};

interface HarnessOptions {
  readonly isBoat: boolean;
  readonly providerInstances?: ServerSettings["providerInstances"];
  readonly installed?: boolean;
  readonly installState?: ProviderInstallState;
}

const buildHarness = (options: HarnessOptions) =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<ProviderInstanceId>();
    const settingsChanges = yield* Queue.unbounded<ServerSettings>();
    const startedCount = { value: 0 };
    const resolveCalls = { value: 0 };
    const resolveCompleted = yield* Deferred.make<void>();

    const antigravityLayer = Layer.mock(AntigravityInstallation.AntigravityInstallation)({
      managedDirectory: "/tmp/antigravity",
      resolve: () =>
        Effect.suspend(() => {
          resolveCalls.value += 1;
          return Deferred.succeed(resolveCompleted, undefined).pipe(
            Effect.andThen(
              options.installed
                ? Effect.succeed({
                    executablePath: "/opt/agy/agy",
                    source: "managed" as const,
                    version: "1.0.0",
                    managedVersionDirectory: "/opt/agy",
                  })
                : Effect.fail(
                    new AntigravityInstallation.AntigravityInstallationError({
                      operation: "resolve",
                      detail: "not installed",
                    }),
                  ),
            ),
          );
        }),
      state: Effect.succeed(options.installState ?? idleState),
      changes: Stream.empty,
    });

    const installationLayer = Layer.mock(ProviderInstallation.ProviderInstallation)({
      start: (input) =>
        Effect.sync(() => {
          startedCount.value += 1;
        }).pipe(
          Effect.andThen(Queue.offer(started, input.instanceId)),
          Effect.as({
            ...idleState,
            phase: "downloading" as const,
            operationId: "op-1",
          }),
        ),
    });

    const instanceRegistryLayer = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (instanceId) =>
        Effect.succeed(
          instanceId === ANTIGRAVITY_ID
            ? ({
                instanceId: ANTIGRAVITY_ID,
                driverKind: ANTIGRAVITY_DRIVER,
                enabled: true,
              } as never)
            : undefined,
        ),
      listInstances: Effect.succeed([]),
    });

    const settingsLayer = Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const inner = yield* ServerSettingsService;
        return ServerSettingsService.of({
          ...inner,
          subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
          updateProviderInstance: (input) =>
            inner
              .updateProviderInstance(input)
              .pipe(Effect.tap((next) => Queue.offer(settingsChanges, next))),
        });
      }),
    ).pipe(
      Layer.provide(
        ServerSettingsService.layerTest({
          providerInstances: options.providerInstances ?? {},
        }),
      ),
    );

    const deps = Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-boat-agy-bootstrap-" }),
      settingsLayer,
      antigravityLayer,
      installationLayer,
      instanceRegistryLayer,
    ).pipe(Layer.provideMerge(NodeServices.layer));

    const ctx = yield* Layer.build(
      makeLayer({ isBoatServer: () => options.isBoat }).pipe(Layer.provideMerge(deps)),
    );

    return {
      started,
      startedCount,
      resolveCalls,
      resolveCompleted,
      settings: yield* Effect.service(ServerSettingsService).pipe(Effect.provide(ctx)),
    };
  });

describe("BoatAntigravityBootstrap", () => {
  effectIt.effect("auto-installs Antigravity on Boat when enabled and missing", () =>
    Effect.gen(function* () {
      const harness = yield* buildHarness({
        isBoat: true,
        installed: false,
        providerInstances: {
          [ANTIGRAVITY_ID]: { driver: ANTIGRAVITY_DRIVER, enabled: true },
        },
      });

      const installedId = yield* Queue.take(harness.started);
      expect(installedId).toBe(ANTIGRAVITY_ID);
      expect(harness.startedCount.value).toBe(1);
    }),
  );

  effectIt.effect("skips install on Boat when runtime is already installed", () =>
    Effect.gen(function* () {
      const harness = yield* buildHarness({
        isBoat: true,
        installed: true,
        providerInstances: {
          [ANTIGRAVITY_ID]: { driver: ANTIGRAVITY_DRIVER, enabled: true },
        },
      });

      yield* Deferred.await(harness.resolveCompleted);
      yield* Effect.yieldNow;
      expect(harness.resolveCalls.value).toBe(1);
      expect(harness.startedCount.value).toBe(0);
    }),
  );

  effectIt.effect("skips install on Boat while an install is already in progress", () =>
    Effect.gen(function* () {
      const harness = yield* buildHarness({
        isBoat: true,
        installed: false,
        installState: { ...idleState, phase: "downloading", operationId: "op-running" },
        providerInstances: {
          [ANTIGRAVITY_ID]: { driver: ANTIGRAVITY_DRIVER, enabled: true },
        },
      });

      yield* Deferred.await(harness.resolveCompleted);
      yield* Effect.yieldNow;
      expect(harness.startedCount.value).toBe(0);
    }),
  );

  effectIt.effect("skips install on Boat when Antigravity uses a custom binaryPath", () =>
    Effect.gen(function* () {
      const harness = yield* buildHarness({
        isBoat: true,
        installed: false,
        providerInstances: {
          [ANTIGRAVITY_ID]: {
            driver: ANTIGRAVITY_DRIVER,
            enabled: true,
            config: { binaryPath: "/usr/local/bin/agy" },
          },
        },
      });

      yield* Effect.yieldNow;
      expect(harness.resolveCalls.value).toBe(0);
      expect(harness.startedCount.value).toBe(0);
    }),
  );

  effectIt.effect("waits while disabled on Boat and installs once re-enabled", () =>
    Effect.gen(function* () {
      const harness = yield* buildHarness({
        isBoat: true,
        installed: false,
        providerInstances: {
          [ANTIGRAVITY_ID]: { driver: ANTIGRAVITY_DRIVER, enabled: false },
        },
      });

      yield* Effect.yieldNow;
      expect(harness.startedCount.value).toBe(0);

      yield* harness.settings.updateProviderInstance({
        operation: "upsert",
        instanceId: ANTIGRAVITY_ID,
        instance: { driver: ANTIGRAVITY_DRIVER, enabled: true },
      });

      const installedId = yield* Queue.take(harness.started);
      expect(installedId).toBe(ANTIGRAVITY_ID);
      expect(harness.startedCount.value).toBe(1);
    }),
  );

  effectIt.effect("does nothing outside Boat", () =>
    Effect.gen(function* () {
      const harness = yield* buildHarness({
        isBoat: false,
        installed: false,
        providerInstances: {
          [ANTIGRAVITY_ID]: { driver: ANTIGRAVITY_DRIVER, enabled: true },
        },
      });

      yield* Effect.yieldNow;
      expect(harness.resolveCalls.value).toBe(0);
      expect(harness.startedCount.value).toBe(0);
    }),
  );
});

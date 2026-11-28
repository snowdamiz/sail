import {
  AntigravitySettings,
  ProviderDriverKind,
  type ProviderInstallState,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { boatRuntime } from "../cloud/boatLifecycle.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedProviders from "../policy/managedProviders.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as ProviderInstallation from "../provider/providerInstallation.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import { forkParked } from "../serverActivation.ts";
import { afterAdmissionReopens } from "../serverAdmission.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");
const decodeAntigravitySettings = Schema.decodeUnknownOption(AntigravitySettings);

const ACTIVE_INSTALL_PHASES: ReadonlySet<ProviderInstallState["phase"]> = new Set([
  "downloading",
  "extracting",
  "verifying",
]);

const isBoatHost = (baseDir: string): boolean => {
  try {
    return boatRuntime(baseDir) !== undefined;
  } catch {
    return false;
  }
};

function findEnabledManagedAntigravityInstance(
  settings: ServerSettings,
): ProviderInstanceId | undefined {
  const entries = deriveProviderInstanceConfigMap(settings);
  for (const [rawId, entry] of Object.entries(entries)) {
    if (entry.driver !== ANTIGRAVITY_DRIVER) continue;
    if (!resolveProviderInstanceEnabled(entry)) continue;
    const config = decodeAntigravitySettings(entry.config ?? {});
    if (Option.isNone(config) || config.value.binaryPath) continue;
    return rawId as ProviderInstanceId;
  }
  return undefined;
}

export interface BoatAntigravityBootstrapOptions {
  readonly isBoatServer?: (baseDir: string) => boolean;
}

export const makeLayer = (options?: BoatAntigravityBootstrapOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const isBoat = options?.isBoatServer ?? isBoatHost;
      if (!isBoat(config.baseDir)) return;

      const settingsService = yield* ServerSettingsService;
      if (
        ManagedProviders.disallowedDriverReason(
          settingsService.managedPolicy,
          ANTIGRAVITY_DRIVER,
        ) !== undefined
      ) {
        return;
      }

      const antigravityInstallation = yield* AntigravityInstallation.AntigravityInstallation;
      const providerInstallation = yield* ProviderInstallation.ProviderInstallation;
      const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const mutatorOption = yield* Effect.serviceOption(
        ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
      );

      const ensureInstalled = Effect.fn("BoatAntigravityBootstrap.ensureInstalled")(function* (
        settings: ServerSettings,
        instanceId: ProviderInstanceId,
      ) {
        const resolved = yield* antigravityInstallation.resolve().pipe(Effect.option);
        if (Option.isSome(resolved)) return;

        const currentState = yield* antigravityInstallation.state;
        if (ACTIVE_INSTALL_PHASES.has(currentState.phase)) return;

        if (
          (yield* instances.getInstance(instanceId)) === undefined &&
          Option.isSome(mutatorOption)
        ) {
          yield* mutatorOption.value
            .reconcile(deriveProviderInstanceConfigMap(settings))
            .pipe(Effect.ignore({ log: true }));
        }

        yield* providerInstallation.start({ instanceId }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Boat Antigravity auto-install failed", {
              instanceId,
              detail: cause.detail,
            }),
          ),
        );
      });

      const settingsChanges = yield* settingsService.subscribeChanges;

      yield* forkParked(
        Effect.gen(function* () {
          const initialSettings = yield* settingsService.getSettings.pipe(Effect.option);
          let previousTarget = Option.isSome(initialSettings)
            ? findEnabledManagedAntigravityInstance(initialSettings.value)
            : undefined;

          if (Option.isSome(initialSettings) && previousTarget !== undefined) {
            yield* afterAdmissionReopens(ensureInstalled(initialSettings.value, previousTarget));
          }

          yield* settingsChanges.pipe(
            Stream.runForEach((nextSettings) => {
              const nextTarget = findEnabledManagedAntigravityInstance(nextSettings);
              const becameEnabled = previousTarget === undefined && nextTarget !== undefined;
              previousTarget = nextTarget;
              if (!becameEnabled) return Effect.void;
              return afterAdmissionReopens(ensureInstalled(nextSettings, nextTarget));
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Boat Antigravity bootstrap failed", cause),
          ),
        ),
      );
    }),
  );

export const layer = makeLayer();

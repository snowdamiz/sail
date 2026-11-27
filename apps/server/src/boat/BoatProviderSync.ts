import type { ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProviderAuthSync from "../provider/ProviderAuthSync.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { BoatSupervisor } from "./BoatSupervisor.ts";

const BoatMachineState = Schema.Struct({
  id: Schema.String,
  state: Schema.optional(Schema.String),
});

const BoatDaemonState = Schema.Struct({
  machines: Schema.optional(Schema.Array(BoatMachineState)),
});

const decodeBoatDaemonState = Schema.decodeUnknownOption(BoatDaemonState);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const RUNNING_STATES = new Set(["working", "idle"]);

function summarizeProviderAuthStates(providers: ReadonlyArray<ServerProvider>): string {
  return JSON.stringify(
    [...providers]
      .toSorted((left, right) => left.instanceId.localeCompare(right.instanceId))
      .map((provider) => ({
        instanceId: provider.instanceId,
        driver: provider.driver,
        status: provider.auth.status,
        type: provider.auth.type ?? null,
        label: provider.auth.label ?? null,
      })),
  );
}

export class BoatProviderSync extends Context.Service<
  BoatProviderSync,
  {
    readonly syncAllRunning: Effect.Effect<void>;
  }
>()("t3/boat/BoatProviderSync") {}

const make = Effect.gen(function* () {
  const boatSupervisor = yield* BoatSupervisor;
  const serverSettings = yield* ServerSettingsService;
  const providerAuthSync = yield* ProviderAuthSync.ProviderAuthSync;
  const providerRegistryOption = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);

  const syncedFingerprints = new Map<string, string>();
  const lastStateRef = yield* Ref.make<Option.Option<unknown>>(Option.none());
  const syncLock = yield* Semaphore.make(1);

  const syncFromState = Effect.fn("BoatProviderSync.syncFromState")(function* (rawState: unknown) {
    const syncRpc = boatSupervisor.syncProviderAuth;
    if (syncRpc === undefined) {
      return;
    }
    const parsed = decodeBoatDaemonState(rawState);
    if (Option.isNone(parsed)) {
      return;
    }
    const machines = parsed.value.machines ?? [];

    // Clear fingerprints for stopped/removed machines so next start/wake always re-syncs.
    const runningMachineIds: Array<string> = [];
    const runningSet = new Set<string>();
    for (const machine of machines) {
      if (machine.state !== undefined && RUNNING_STATES.has(machine.state)) {
        runningMachineIds.push(machine.id);
        runningSet.add(machine.id);
      }
    }
    for (const machineId of Array.from(syncedFingerprints.keys())) {
      if (!runningSet.has(machineId)) {
        syncedFingerprints.delete(machineId);
      }
    }

    if (runningMachineIds.length === 0) {
      return;
    }

    const exported = yield* providerAuthSync.exportBundle({ resolveSecretReferences: true }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to export provider auth bundle for Boat sync", {
          cause: cause.message,
        }),
      ),
      Effect.option,
    );
    if (Option.isNone(exported) || exported.value.fingerprint.length === 0) {
      return;
    }

    const { bundle, fingerprint } = exported.value;
    for (const machineId of runningMachineIds) {
      if (syncedFingerprints.get(machineId) === fingerprint) {
        continue;
      }
      const result = yield* syncRpc({ machineId, bundle }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to push provider auth bundle to Boat", {
            machineId,
            cause: cause.message,
          }),
        ),
        Effect.option,
      );
      if (Option.isSome(result) && result.value.synced) {
        syncedFingerprints.set(machineId, fingerprint);
      }
    }
  });

  const syncAllRunning: Effect.Effect<void> = syncLock.withPermits(1)(
    Effect.gen(function* () {
      const currentState =
        boatSupervisor.currentState === undefined
          ? yield* Ref.get(lastStateRef)
          : yield* boatSupervisor.currentState;
      const effectiveState = Option.isSome(currentState)
        ? currentState
        : yield* Ref.get(lastStateRef);
      if (Option.isNone(effectiveState)) {
        return;
      }
      yield* syncFromState(effectiveState.value);
    }),
  );

  if (boatSupervisor.passiveEvents !== undefined) {
    yield* boatSupervisor.passiveEvents.pipe(
      Stream.runForEach((event) => {
        if (event._tag !== "state") {
          return Effect.void;
        }
        return Ref.set(lastStateRef, Option.some(event.state)).pipe(
          Effect.andThen(syncLock.withPermits(1)(syncFromState(event.state))),
        );
      }),
      Effect.ignore,
      Effect.forkScoped,
    );
  }

  const initialSettings = yield* serverSettings.getSettings;
  let lastProviderInstances = encodeUnknownJson(initialSettings.providerInstances);
  let lastSecretProviders = encodeUnknownJson(initialSettings.secretProviders);
  yield* serverSettings.streamChanges.pipe(
    Stream.runForEach((settings) => {
      const nextProviderInstances = encodeUnknownJson(settings.providerInstances);
      const nextSecretProviders = encodeUnknownJson(settings.secretProviders);
      const changed =
        nextProviderInstances !== lastProviderInstances ||
        nextSecretProviders !== lastSecretProviders;
      lastProviderInstances = nextProviderInstances;
      lastSecretProviders = nextSecretProviders;
      return changed ? syncAllRunning : Effect.void;
    }),
    Effect.ignore,
    Effect.forkScoped,
  );

  if (Option.isSome(providerRegistryOption)) {
    const initialProviders = yield* providerRegistryOption.value.getProviders.pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProvider>),
    );
    let lastProviderAuthSummary = summarizeProviderAuthStates(initialProviders);
    yield* providerRegistryOption.value.streamChanges.pipe(
      Stream.runForEach((providers) => {
        const nextSummary = summarizeProviderAuthStates(providers);
        if (nextSummary === lastProviderAuthSummary) {
          return Effect.void;
        }
        lastProviderAuthSummary = nextSummary;
        return syncAllRunning;
      }),
      Effect.ignore,
      Effect.forkScoped,
    );
  }

  return BoatProviderSync.of({
    syncAllRunning,
  });
});

export const layer = Layer.effect(BoatProviderSync, make);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type BoatEvent,
  type ProviderAuthSyncBundle,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderAuthSync from "../provider/ProviderAuthSync.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as BoatProviderSync from "./BoatProviderSync.ts";
import { BoatSupervisor } from "./BoatSupervisor.ts";

function makeBundle(tag: string): {
  readonly bundle: ProviderAuthSyncBundle;
  readonly fingerprint: string;
} {
  return {
    bundle: {
      version: 1,
      instances: [
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [{ name: "ANTHROPIC_API_KEY", value: `key-${tag}`, sensitive: true }],
        },
      ],
      storeBlobs: [],
      antigravityFiles: [],
      cliAuth: [],
    },
    fingerprint: `fp-${tag}`,
  };
}

function makeHarness() {
  const pushed: Array<{ readonly machineId: string; readonly bundle: ProviderAuthSyncBundle }> = [];

  return Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<BoatEvent>();
    const currentStateRef = yield* Ref.make<Option.Option<unknown>>(Option.none());
    const currentExportRef = yield* Ref.make(makeBundle("v1"));

    const boatLayer = Layer.succeed(
      BoatSupervisor,
      BoatSupervisor.of({
        invoke: () => Effect.succeed({ data: null }),
        syncProviderAuth: (input) =>
          Effect.sync(() => {
            pushed.push(input);
            return { synced: true };
          }),
        currentState: Ref.get(currentStateRef),
        passiveEvents: Stream.fromPubSub(hub),
        events: Stream.empty,
        notices: Stream.empty,
      }),
    );

    const authSyncLayer = Layer.succeed(
      ProviderAuthSync.ProviderAuthSync,
      ProviderAuthSync.ProviderAuthSync.of({
        exportBundle: () => Ref.get(currentExportRef),
        importBundle: () =>
          Effect.succeed({ changed: false, importedInstances: 0, importedCredentials: 0 }),
      }),
    );

    const settingsLayer = ServerSettingsService.layerTest({});

    const baseLayer = Layer.mergeAll(boatLayer, authSyncLayer, settingsLayer).pipe(
      Layer.provideMerge(Layer.merge(NodeCrypto.layer, NodeServices.layer)),
    );

    const fullLayer = BoatProviderSync.layer.pipe(Layer.provideMerge(baseLayer));

    const emitState = (state: unknown) =>
      Ref.set(currentStateRef, Option.some(state)).pipe(
        Effect.andThen(PubSub.publish(hub, { _tag: "state", state })),
      );

    return { fullLayer, pushed, emitState, currentExportRef };
  });
}

describe("BoatProviderSync", () => {
  it.effect(
    "pushes provider auth to running Boats, skips asleep Boats, dedupes, and re-syncs on wake or credential updates",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const sync = yield* BoatProviderSync.BoatProviderSync;
          const settings = yield* ServerSettingsService;

          // 1. Sleeping Boat should not be synced.
          yield* harness.emitState({
            machines: [{ id: "boat-asleep", state: "asleep" }],
          });
          yield* sync.syncAllRunning;
          assert.strictEqual(harness.pushed.length, 0);

          // 2. Running Boat receives the bundle once.
          yield* harness.emitState({
            machines: [
              { id: "boat-asleep", state: "asleep" },
              { id: "boat-1", state: "idle" },
            ],
          });
          yield* sync.syncAllRunning;
          assert.strictEqual(harness.pushed.length, 1);
          assert.strictEqual(harness.pushed[0]?.machineId, "boat-1");

          // 3. Repeated sync with identical fingerprint is deduped.
          yield* sync.syncAllRunning;
          assert.strictEqual(harness.pushed.length, 1);

          // 4. Updated provider credentials re-sync immediately.
          yield* Ref.set(harness.currentExportRef, makeBundle("v2"));
          yield* settings.updateSettings({
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [{ name: "ANTHROPIC_API_KEY", value: "key-v2", sensitive: true }],
              },
            },
          });
          yield* sync.syncAllRunning;
          assert.strictEqual(harness.pushed.length, 2);
          assert.strictEqual(
            harness.pushed[1]?.bundle.instances[0]?.environment?.[0]?.value,
            "key-v2",
          );

          // 5. Machine goes asleep then wakes up -> fingerprint cleared, re-syncs on wake.
          yield* harness.emitState({
            machines: [{ id: "boat-1", state: "asleep" }],
          });
          yield* sync.syncAllRunning;
          yield* harness.emitState({
            machines: [{ id: "boat-1", state: "working" }],
          });
          yield* sync.syncAllRunning;
          assert.strictEqual(harness.pushed.length, 3);
          assert.strictEqual(harness.pushed[2]?.machineId, "boat-1");
        }).pipe(Effect.provide(harness.fullLayer));
      }),
  );
});

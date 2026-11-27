import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type BoatEvent,
  ProjectCredentialEnvVar,
  ProjectId,
  SecretProviderId,
  SecretProviderKind,
  type SyncedProjectCredentialEntry,
} from "@t3tools/contracts";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectCredentials from "../secrets/ProjectCredentials.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as BoatCredentialSync from "./BoatCredentialSync.ts";
import { BoatSupervisor } from "./BoatSupervisor.ts";

const FAKE_KIND = SecretProviderKind.make("fake");
const vaultId = SecretProviderId.make("vault");
const originProject = ProjectId.make("local-proj-1");
const destProject = "boat-proj-1";

function makeSyncHarness() {
  const pushed: Array<{
    readonly machineId: string;
    readonly projectId: string;
    readonly credentials: ReadonlyArray<SyncedProjectCredentialEntry>;
  }> = [];

  const vaultValues = new Map<string, string>([
    ["fake://vault/aws/key", "AKIA_BOAT_1"],
    ["fake://vault/aws/secret", "SECRET_BOAT_1"],
  ]);

  const driver = defineSecretProviderDriver({
    kind: FAKE_KIND,
    definition: defineSecretProvider({
      kind: FAKE_KIND,
      label: "Fake 1Password",
      configSchema: Schema.Struct({}),
      isReference: (ref) => ref.startsWith("fake://"),
      referencePlaceholder: "fake://vault/item/field",
      invalidReferenceMessage: "Use fake:// reference.",
    }),
    read: (_config, references) => Effect.sync(() => references.map((ref) => vaultValues.get(ref))),
  });

  return Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<BoatEvent>();
    const currentStateRef = yield* Ref.make<Option.Option<unknown>>(Option.none());

    const boatLayer = Layer.succeed(
      BoatSupervisor,
      BoatSupervisor.of({
        invoke: () => Effect.succeed({ data: null }),
        syncProjectCredentials: (input) =>
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

    const secretStoreLayer = Layer.succeed(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: () => Effect.succeed(true),
        getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
        remove: () => Effect.void,
      }),
    );

    const settingsLayer = ServerSettingsService.layerTest({
      secretProviders: {
        [vaultId]: { kind: FAKE_KIND, label: "Vault", config: {} },
      },
      projectCredentialBookmarks: {
        [originProject]: {
          awsKey: {
            label: "AWS Access Key ID",
            reference: { provider: vaultId, reference: "fake://vault/aws/key" },
            envVar: ProjectCredentialEnvVar.make("AWS_ACCESS_KEY_ID"),
            autoGrant: true,
          },
        },
      },
    });

    const resolverLayer = SecretResolver.layer({
      drivers: [driver],
      secretProviders: Effect.succeed({
        [vaultId]: { kind: FAKE_KIND, label: "Vault", config: {} },
      }),
    });

    const baseLayer = Layer.mergeAll(
      secretStoreLayer,
      settingsLayer,
      resolverLayer,
      boatLayer,
    ).pipe(Layer.provideMerge(Layer.merge(NodeCrypto.layer, NodeServices.layer)));

    const projectCredentialsLayer = ProjectCredentials.layer.pipe(Layer.provideMerge(baseLayer));
    const fullLayer = BoatCredentialSync.layer.pipe(Layer.provideMerge(projectCredentialsLayer));

    const emitState = (state: unknown) =>
      Ref.set(currentStateRef, Option.some(state)).pipe(
        Effect.andThen(PubSub.publish(hub, { _tag: "state", state })),
      );

    return { fullLayer, pushed, emitState };
  });
}

describe("BoatCredentialSync", () => {
  it.effect(
    "syncs authorized project credentials to running Boats, skips cloning/asleep Boats, dedupes, and revokes on removal",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSyncHarness();
        yield* Effect.gen(function* () {
          const sync = yield* BoatCredentialSync.BoatCredentialSync;
          const settings = yield* ServerSettingsService;

          // 1. Sleeping Boat and in-progress clone should be skipped
          yield* harness.emitState({
            machines: [
              {
                id: "boat-asleep",
                state: "asleep",
                projects: [{ id: destProject, originProjectId: originProject, status: null }],
              },
              {
                id: "boat-cloning",
                state: "working",
                projects: [
                  { id: originProject, originProjectId: originProject, status: "Cloning…" },
                ],
              },
            ],
          });
          yield* sync.syncAllRunning;
          assert.equal(harness.pushed.length, 0);

          // 2. Running Boat with completed project receives scoped credentials
          const runningState = {
            machines: [
              {
                id: "boat-live",
                state: "idle",
                projects: [{ id: destProject, originProjectId: originProject, status: null }],
              },
            ],
          };
          yield* harness.emitState(runningState);
          yield* sync.syncAllRunning;
          assert.equal(harness.pushed.length, 1);
          assert.equal(harness.pushed[0]?.machineId, "boat-live");
          assert.equal(harness.pushed[0]?.projectId, destProject);
          assert.equal(harness.pushed[0]?.credentials.length, 1);
          assert.equal(harness.pushed[0]?.credentials[0]?.value, "AKIA_BOAT_1");

          // 3. Repeated state snapshot with same credentials is deduped
          yield* sync.syncAllRunning;
          assert.equal(harness.pushed.length, 1);

          // 4. Boat sleeps then wakes again -> re-syncs automatically
          yield* harness.emitState({
            machines: [
              {
                id: "boat-live",
                state: "asleep",
                projects: [{ id: destProject, originProjectId: originProject, status: null }],
              },
            ],
          });
          yield* sync.syncAllRunning;
          yield* harness.emitState(runningState);
          yield* sync.syncAllRunning;
          assert.equal(harness.pushed.length, 2);

          // 5. Revoking bookmark pushes empty credentials array to clear Boat store
          yield* settings.updateSettings({
            projectCredentialBookmarks: {
              [originProject]: { awsKey: null },
            },
          });
          yield* sync.syncProject(originProject);
          assert.equal(harness.pushed.length, 3);
          assert.deepStrictEqual(harness.pushed[2]?.credentials, []);
        }).pipe(Effect.provide(harness.fullLayer));
      }),
  );
});

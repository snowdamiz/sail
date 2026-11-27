import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectCredentialEnvVar,
  ProjectId,
  SecretProviderId,
  SecretProviderKind,
  SecretProviderSlug,
} from "@t3tools/contracts";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProjectCredentials from "./ProjectCredentials.ts";

const FAKE_KIND = SecretProviderKind.make("fake");
const vaultId = SecretProviderId.make("vault");
const projectId = ProjectId.make("project-alpha");
const otherProjectId = ProjectId.make("project-beta");

function makeHarness(options?: {
  readonly initialBookmarks?: Record<
    string,
    Record<
      string,
      {
        readonly label: string;
        readonly reference: { readonly provider: SecretProviderId; readonly reference: string };
        readonly envVar?: ProjectCredentialEnvVar;
        readonly autoGrant?: boolean;
      }
    >
  >;
  readonly vaultValues?: ReadonlyArray<readonly [string, string]>;
}) {
  const secretStoreData = new Map<string, Uint8Array>();
  const vaultValues = new Map<string, string>(options?.vaultValues ?? []);
  let createdItems = 0;

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
    saveItem: (_config, input) =>
      Effect.sync(() => {
        createdItems += 1;
        const ref = `fake://${input.vault}/${createdItems}/password`;
        vaultValues.set(ref, input.value);
        return ref;
      }),
    saveFields: (_config, input) =>
      Effect.sync(() => {
        createdItems += 1;
        return Object.fromEntries(
          input.fields.map((field) => {
            const ref = `fake://${input.vault}/${createdItems}/${field.id}`;
            vaultValues.set(ref, field.value);
            return [field.id, ref] as const;
          }),
        );
      }),
    read: (_config, references) => Effect.sync(() => references.map((ref) => vaultValues.get(ref))),
  });

  const secretStoreLayer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(secretStoreData.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          secretStoreData.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          if (secretStoreData.has(name)) return false;
          secretStoreData.set(name, value);
          return true;
        }),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const existing = secretStoreData.get(name);
          if (existing !== undefined) return existing;
          const next = new Uint8Array(bytes);
          secretStoreData.set(name, next);
          return next;
        }),
      remove: (name) =>
        Effect.sync(() => {
          secretStoreData.delete(name);
        }),
    }),
  );

  const settingsLayer = ServerSettingsService.layerTest({
    secretProviders: {
      [vaultId]: { kind: FAKE_KIND, label: "Vault", config: {} },
    },
    projectCredentialBookmarks: options?.initialBookmarks ?? {},
  });

  const resolverLayer = SecretResolver.layer({
    drivers: [driver],
    secretProviders: Effect.succeed({
      [vaultId]: { kind: FAKE_KIND, label: "Vault", config: {} },
    }),
  });

  const baseLayer = Layer.mergeAll(secretStoreLayer, settingsLayer, resolverLayer).pipe(
    Layer.provideMerge(Layer.merge(NodeCrypto.layer, NodeServices.layer)),
  );
  const layer = ProjectCredentials.layer.pipe(Layer.provideMerge(baseLayer));

  return { layer, secretStoreData, vaultValues };
}

describe("ProjectCredentials", () => {
  it.effect(
    "resolves auto-granted local bookmarks to env vars, skips autoGrant=false, and blocks unsafe env vars",
    () => {
      const harness = makeHarness({
        initialBookmarks: {
          [projectId]: {
            awsKey: {
              label: "AWS Access Key ID",
              reference: { provider: vaultId, reference: "fake://dev/aws/key" },
              envVar: ProjectCredentialEnvVar.make("AWS_ACCESS_KEY_ID"),
              autoGrant: true,
            },
            awsSecret: {
              label: "AWS Secret Access Key",
              reference: { provider: vaultId, reference: "fake://dev/aws/secret" },
              envVar: ProjectCredentialEnvVar.make("AWS_SECRET_ACCESS_KEY"),
            },
            manualOnly: {
              label: "Manual Token",
              reference: { provider: vaultId, reference: "fake://dev/manual/token" },
              envVar: ProjectCredentialEnvVar.make("MANUAL_TOKEN"),
              autoGrant: false,
            },
            unsafePath: {
              label: "Unsafe PATH override",
              reference: { provider: vaultId, reference: "fake://dev/unsafe/path" },
              envVar: ProjectCredentialEnvVar.make("PATH"),
              autoGrant: true,
            },
            unsafeSail: {
              label: "Unsafe SAIL override",
              reference: { provider: vaultId, reference: "fake://dev/unsafe/sail" },
              envVar: ProjectCredentialEnvVar.make("SAIL_HOME"),
              autoGrant: true,
            },
          },
        },
        vaultValues: [
          ["fake://dev/aws/key", "AKIAEXAMPLE123"],
          ["fake://dev/aws/secret", "secret-key-xyz"],
          ["fake://dev/manual/token", "should-not-auto-inject"],
          ["fake://dev/unsafe/path", "/evil/bin"],
          ["fake://dev/unsafe/sail", "/evil/home"],
        ],
      });

      return Effect.gen(function* () {
        const service = yield* ProjectCredentials.ProjectCredentials;
        const env = yield* service.resolveEnvForProject(projectId);
        assert.deepStrictEqual(env, {
          AWS_ACCESS_KEY_ID: "AKIAEXAMPLE123",
          AWS_SECRET_ACCESS_KEY: "secret-key-xyz",
        });

        const otherEnv = yield* service.resolveEnvForProject(otherProjectId);
        assert.deepStrictEqual(otherEnv, {});
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "matches single-value and multi-field secret requests unambiguously and rejects ambiguous or partial matches",
    () => {
      const harness = makeHarness({
        initialBookmarks: {
          [projectId]: {
            awsKey: {
              label: "AWS Access Key ID",
              reference: { provider: vaultId, reference: "fake://dev/aws/key" },
              envVar: ProjectCredentialEnvVar.make("AWS_ACCESS_KEY_ID"),
            },
            awsSecret: {
              label: "AWS Secret Access Key",
              reference: { provider: vaultId, reference: "fake://dev/aws/secret" },
              envVar: ProjectCredentialEnvVar.make("AWS_SECRET_ACCESS_KEY"),
            },
            dup1: {
              label: "Stripe Key",
              reference: { provider: vaultId, reference: "fake://dev/stripe/1" },
            },
            dup2: {
              label: "Stripe Key",
              reference: { provider: vaultId, reference: "fake://dev/stripe/2" },
            },
          },
        },
        vaultValues: [
          ["fake://dev/aws/key", "AKIA111"],
          ["fake://dev/aws/secret", "SECRET222"],
          ["fake://dev/stripe/1", "sk_1"],
          ["fake://dev/stripe/2", "sk_2"],
        ],
      });

      return Effect.gen(function* () {
        const service = yield* ProjectCredentials.ProjectCredentials;

        // Multi-field AWS match
        const multi = yield* service.matchSecretRequest(projectId, {
          label: "AWS credentials",
          fields: [
            { name: "AWS_ACCESS_KEY_ID", label: "Access Key ID" },
            { name: "AWS_SECRET_ACCESS_KEY", label: "Secret Access Key" },
          ],
        });
        assert.isDefined(multi);
        if (multi !== undefined) {
          assert.equal(multi.kind, "fields");
          if (multi.kind === "fields") {
            assert.deepStrictEqual(multi.values, {
              AWS_ACCESS_KEY_ID: "AKIA111",
              AWS_SECRET_ACCESS_KEY: "SECRET222",
            });
          }
        }

        // Partial multi-field match returns undefined
        const partial = yield* service.matchSecretRequest(projectId, {
          label: "AWS + region",
          fields: [
            { name: "AWS_ACCESS_KEY_ID", label: "Access Key ID" },
            { name: "AWS_SESSION_TOKEN", label: "Session Token" },
          ],
        });
        assert.isUndefined(partial);

        // Single-value exact envVar match
        const single = yield* service.matchSecretRequest(projectId, {
          label: "AWS_ACCESS_KEY_ID",
        });
        assert.isDefined(single);
        if (single !== undefined && single.kind === "single") {
          assert.equal(single.value, "AKIA111");
        }

        // Ambiguous label match returns undefined
        const ambiguous = yield* service.matchSecretRequest(projectId, {
          label: "Stripe Key",
        });
        assert.isUndefined(ambiguous);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "stores synced Boat credentials scoped per project, exposes metadata only via listForProject, and revokes cleanly on empty sync",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const service = yield* ProjectCredentials.ProjectCredentials;
        const synced = yield* service.syncForProject({
          projectId,
          credentials: [
            {
              id: SecretProviderSlug.make("cred-aws-key"),
              label: "AWS Access Key ID",
              value: "AKIA_SYNCED",
              envVar: ProjectCredentialEnvVar.make("AWS_ACCESS_KEY_ID"),
              autoGrant: true,
            },
            {
              id: SecretProviderSlug.make("cred-aws-secret"),
              label: "AWS Secret Access Key",
              value: "SECRET_SYNCED",
              envVar: ProjectCredentialEnvVar.make("AWS_SECRET_ACCESS_KEY"),
              autoGrant: true,
            },
          ],
        });
        assert.equal(synced.syncedCount, 2);
        assert.equal(harness.secretStoreData.size, 1);

        // Metadata listing never exposes secret values
        const listed = yield* service.listForProject(projectId);
        assert.equal(listed.credentials.length, 2);
        assert.isFalse(JSON.stringify(listed).includes("AKIA_SYNCED"));
        assert.isFalse(JSON.stringify(listed).includes("SECRET_SYNCED"));
        assert.equal(listed.credentials[0]?.source, "synced");

        // Synced credentials inject env vars on the Boat without local 1Password
        const env = yield* service.resolveEnvForProject(projectId);
        assert.deepStrictEqual(env, {
          AWS_ACCESS_KEY_ID: "AKIA_SYNCED",
          AWS_SECRET_ACCESS_KEY: "SECRET_SYNCED",
        });

        // Other projects on the same Boat cannot see project-alpha's credentials
        assert.deepStrictEqual(yield* service.resolveEnvForProject(otherProjectId), {});

        // Empty sync revokes and removes the secret store entry completely
        const revoked = yield* service.syncForProject({ projectId, credentials: [] });
        assert.equal(revoked.syncedCount, 0);
        assert.equal(harness.secretStoreData.size, 0);
        assert.deepStrictEqual(yield* service.resolveEnvForProject(projectId), {});
        assert.deepStrictEqual((yield* service.listForProject(projectId)).credentials, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "saveToProject saves multi-field secrets to 1Password and authorizes them on the project",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const service = yield* ProjectCredentials.ProjectCredentials;
        const result = yield* service.saveToProject({
          projectId,
          provider: vaultId,
          vault: "Engineering",
          label: "AWS Prod",
          fields: [
            {
              name: "AWS_ACCESS_KEY_ID",
              label: "Access Key ID",
              value: "AKIA_NEW",
              envVar: ProjectCredentialEnvVar.make("AWS_ACCESS_KEY_ID"),
            },
            {
              name: "AWS_SECRET_ACCESS_KEY",
              label: "Secret Access Key",
              value: "SECRET_NEW",
              envVar: ProjectCredentialEnvVar.make("AWS_SECRET_ACCESS_KEY"),
            },
          ],
          autoGrant: true,
        });
        assert.equal(result.savedIds.length, 2);

        const env = yield* service.resolveEnvForProject(projectId);
        assert.deepStrictEqual(env, {
          AWS_ACCESS_KEY_ID: "AKIA_NEW",
          AWS_SECRET_ACCESS_KEY: "SECRET_NEW",
        });

        const boatPayload = yield* service.resolveForBoatSync(projectId);
        assert.isTrue(boatPayload.hasConfiguredBookmarks);
        assert.equal(boatPayload.credentials.length, 2);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

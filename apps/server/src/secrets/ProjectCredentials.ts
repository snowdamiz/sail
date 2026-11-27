import {
  type ProjectCredentialBookmark,
  type ProjectCredentialEnvVar,
  type ProjectCredentialSaveInput,
  type ProjectCredentialSaveResult,
  type ProjectCredentialsListResult,
  type ProjectCredentialsSyncInput,
  type ProjectCredentialsSyncResult,
  type ProjectCredentialSummary,
  type ProjectId,
  SecretProviderSlug,
  type SecretReference,
  SecretRequestError,
  type SyncedProjectCredentialEntry,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BLOCKED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "IFS",
  "ENV",
  "BASH_ENV",
  "ZDOTDIR",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "SSLKEYLOGFILE",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
]);

function isAllowedCredentialEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (BLOCKED_ENV_VARS.has(upper)) return false;
  if (
    upper.startsWith("SAIL_") ||
    upper.startsWith("T3CODE_") ||
    upper.startsWith("DYLD_") ||
    upper.startsWith("LD_")
  ) {
    return false;
  }
  return ENV_VAR_PATTERN.test(name);
}

const StoredSyncedCredential = Schema.Struct({
  id: SecretProviderSlug,
  label: Schema.String,
  value: Schema.String,
  envVar: Schema.optionalKey(Schema.String),
  autoGrant: Schema.Boolean,
  syncedAt: Schema.Number,
});

const StoredSyncedProjectCredentials = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.String,
    credentials: Schema.Array(StoredSyncedCredential),
  }),
);
const encodeStoredSynced = Schema.encodeEffect(StoredSyncedProjectCredentials);
const decodeStoredSynced = Schema.decodeUnknownOption(StoredSyncedProjectCredentials);

export interface ResolvedProjectCredential {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly envVar?: ProjectCredentialEnvVar;
  readonly source: "local" | "synced";
}

export type MatchedProjectSecret =
  | {
      readonly kind: "single";
      readonly value: string;
      readonly credentialLabels: ReadonlyArray<string>;
    }
  | {
      readonly kind: "fields";
      readonly values: Readonly<Record<string, string>>;
      readonly credentialLabels: ReadonlyArray<string>;
    };

export interface BoatSyncProjectCredentials {
  readonly hasConfiguredBookmarks: boolean;
  readonly credentials: ReadonlyArray<SyncedProjectCredentialEntry>;
}

const normalizeKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "");

function matchSingleCredential(
  credentials: ReadonlyArray<ResolvedProjectCredential>,
  candidates: ReadonlyArray<string>,
): ResolvedProjectCredential | undefined {
  const trimmed = candidates.map((value) => value.trim()).filter((value) => value.length > 0);
  if (trimmed.length === 0 || credentials.length === 0) return undefined;
  const lowered = new Set(trimmed.map((value) => value.toLowerCase()));
  const normalized = new Set(trimmed.map(normalizeKey).filter((value) => value.length > 0));

  const tiers: ReadonlyArray<(credential: ResolvedProjectCredential) => boolean> = [
    (credential) => credential.envVar !== undefined && lowered.has(credential.envVar.toLowerCase()),
    (credential) => lowered.has(credential.label.trim().toLowerCase()),
    (credential) =>
      (credential.envVar !== undefined && normalized.has(normalizeKey(credential.envVar))) ||
      normalized.has(normalizeKey(credential.label)),
  ];

  for (const matches of tiers) {
    const found = credentials.filter(matches);
    if (found.length === 1) return found[0];
    if (found.length > 1) return undefined;
  }
  return undefined;
}

export class ProjectCredentials extends Context.Service<
  ProjectCredentials,
  {
    readonly syncForProject: (
      input: ProjectCredentialsSyncInput,
    ) => Effect.Effect<ProjectCredentialsSyncResult, SecretRequestError>;
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectCredentialsListResult, SecretRequestError>;
    readonly resolveForProject: (
      projectId: ProjectId,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ReadonlyArray<ResolvedProjectCredential>>;
    readonly resolveEnvForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<Readonly<Record<string, string>>>;
    readonly resolveForBoatSync: (
      projectId: ProjectId,
    ) => Effect.Effect<BoatSyncProjectCredentials>;
    readonly matchSecretRequest: (
      projectId: ProjectId,
      request: {
        readonly label: string;
        readonly fields?: ReadonlyArray<{ readonly name: string; readonly label: string }>;
      },
    ) => Effect.Effect<MatchedProjectSecret | undefined>;
    readonly saveToProject: (
      input: ProjectCredentialSaveInput,
    ) => Effect.Effect<ProjectCredentialSaveResult, SecretRequestError>;
  }
>()("t3/secrets/ProjectCredentials") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;

  const storeKeyFor = (projectId: ProjectId) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(projectId)).pipe(
      Effect.orDie,
      Effect.map((hash) => `project-credentials-${Hex.encode(hash).slice(0, 32)}`),
    );

  const readSyncedRaw = Effect.fn("ProjectCredentials.readSyncedRaw")(function* (
    projectId: ProjectId,
  ) {
    const key = yield* storeKeyFor(projectId);
    const stored = yield* store
      .get(key)
      .pipe(Effect.orElseSucceed((): Option.Option<Uint8Array> => Option.none()));
    if (Option.isNone(stored)) return [] as ReadonlyArray<typeof StoredSyncedCredential.Type>;
    const decoded = decodeStoredSynced(new TextDecoder().decode(stored.value));
    if (Option.isNone(decoded) || decoded.value.projectId !== projectId) {
      return [] as ReadonlyArray<typeof StoredSyncedCredential.Type>;
    }
    return decoded.value.credentials;
  });

  const syncForProject: ProjectCredentials["Service"]["syncForProject"] = Effect.fn(
    "ProjectCredentials.syncForProject",
  )(function* (input) {
    const key = yield* storeKeyFor(input.projectId);
    if (input.credentials.length === 0) {
      yield* store
        .remove(key)
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
        );
      return { syncedCount: 0 };
    }
    const syncedAt = yield* Clock.currentTimeMillis;
    const encoded = yield* encodeStoredSynced({
      projectId: input.projectId,
      credentials: input.credentials.map((entry) => ({
        id: entry.id,
        label: entry.label,
        value: entry.value,
        ...(entry.envVar === undefined ? {} : { envVar: entry.envVar }),
        autoGrant: entry.autoGrant !== false,
        syncedAt,
      })),
    }).pipe(Effect.orDie);
    yield* store
      .set(key, new TextEncoder().encode(encoded))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })));
    return { syncedCount: input.credentials.length };
  });

  const listForProject: ProjectCredentials["Service"]["listForProject"] = Effect.fn(
    "ProjectCredentials.listForProject",
  )(function* (projectId) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })),
    );
    const localEntries = current.projectCredentialBookmarks[projectId] ?? {};
    const syncedEntries = yield* readSyncedRaw(projectId);
    const merged = new Map<string, ProjectCredentialSummary>();

    for (const entry of syncedEntries) {
      const envVar =
        entry.envVar !== undefined && ENV_VAR_PATTERN.test(entry.envVar)
          ? (entry.envVar as ProjectCredentialEnvVar)
          : undefined;
      merged.set(entry.id, {
        id: entry.id,
        label: entry.label,
        ...(envVar === undefined ? {} : { envVar }),
        autoGrant: entry.autoGrant,
        source: "synced",
      });
    }

    for (const [id, bookmark] of Object.entries(localEntries)) {
      merged.set(id, {
        id: SecretProviderSlug.make(id),
        label: bookmark.label,
        ...(bookmark.envVar === undefined ? {} : { envVar: bookmark.envVar }),
        autoGrant: bookmark.autoGrant !== false,
        source: "local",
        reference: bookmark.reference,
      });
    }

    return { credentials: [...merged.values()] };
  });

  const resolveLocalAuthorized = Effect.fn("ProjectCredentials.resolveLocalAuthorized")(function* (
    projectId: ProjectId,
    options?: { readonly fresh?: boolean },
  ) {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    if (current === undefined) {
      return {
        hasConfiguredBookmarks: false,
        resolved: [] as ReadonlyArray<ResolvedProjectCredential>,
      };
    }
    const bookmarks = current.projectCredentialBookmarks[projectId] ?? {};
    const authorized = Object.entries(bookmarks).filter(
      ([, bookmark]) =>
        bookmark.autoGrant !== false &&
        Object.hasOwn(current.secretProviders, bookmark.reference.provider),
    );
    if (authorized.length === 0) {
      return {
        hasConfiguredBookmarks: Object.keys(bookmarks).length > 0,
        resolved: [] as ReadonlyArray<ResolvedProjectCredential>,
      };
    }
    const references = authorized.map(([, bookmark]) => bookmark.reference);
    const values = yield* resolver
      .read(references, options)
      .pipe(Effect.orElseSucceed(() => references.map(() => undefined)));
    const resolved: Array<ResolvedProjectCredential> = [];
    authorized.forEach(([id, bookmark], index) => {
      const value = values[index];
      if (value === undefined || value.trim().length === 0) return;
      resolved.push({
        id,
        label: bookmark.label,
        value,
        ...(bookmark.envVar === undefined ? {} : { envVar: bookmark.envVar }),
        source: "local",
      });
    });
    return {
      hasConfiguredBookmarks: true,
      resolved,
    };
  });

  const resolveForProject: ProjectCredentials["Service"]["resolveForProject"] = Effect.fn(
    "ProjectCredentials.resolveForProject",
  )(function* (projectId, options) {
    const [{ resolved: local }, syncedRaw] = yield* Effect.all([
      resolveLocalAuthorized(projectId, options),
      readSyncedRaw(projectId),
    ]);
    const byId = new Map<string, ResolvedProjectCredential>();
    for (const entry of syncedRaw) {
      if (!entry.autoGrant || entry.value.trim().length === 0) continue;
      const envVar =
        entry.envVar !== undefined && ENV_VAR_PATTERN.test(entry.envVar)
          ? (entry.envVar as ProjectCredentialEnvVar)
          : undefined;
      byId.set(entry.id, {
        id: entry.id,
        label: entry.label,
        value: entry.value,
        ...(envVar === undefined ? {} : { envVar }),
        source: "synced",
      });
    }
    for (const entry of local) {
      byId.set(entry.id, entry);
    }
    return [...byId.values()];
  });

  const resolveEnvForProject: ProjectCredentials["Service"]["resolveEnvForProject"] = Effect.fn(
    "ProjectCredentials.resolveEnvForProject",
  )(function* (projectId) {
    const resolved = yield* resolveForProject(projectId);
    const env: Record<string, string> = {};
    for (const credential of resolved) {
      if (credential.envVar === undefined || !isAllowedCredentialEnvVar(credential.envVar)) {
        continue;
      }
      env[credential.envVar] = credential.value;
    }
    return env;
  });

  const resolveForBoatSync: ProjectCredentials["Service"]["resolveForBoatSync"] = Effect.fn(
    "ProjectCredentials.resolveForBoatSync",
  )(function* (projectId) {
    const { hasConfiguredBookmarks, resolved } = yield* resolveLocalAuthorized(projectId);
    const credentials: ReadonlyArray<SyncedProjectCredentialEntry> = resolved.map((entry) => ({
      id: SecretProviderSlug.make(entry.id),
      label: entry.label,
      value: entry.value,
      ...(entry.envVar === undefined ? {} : { envVar: entry.envVar }),
      autoGrant: true,
    }));
    return { hasConfiguredBookmarks, credentials };
  });

  const matchSecretRequest: ProjectCredentials["Service"]["matchSecretRequest"] = Effect.fn(
    "ProjectCredentials.matchSecretRequest",
  )(function* (projectId, request) {
    const resolved = yield* resolveForProject(projectId);
    if (resolved.length === 0) return undefined;
    if (request.fields === undefined) {
      const matched = matchSingleCredential(resolved, [request.label]);
      return matched === undefined
        ? undefined
        : {
            kind: "single" as const,
            value: matched.value,
            credentialLabels: [matched.label],
          };
    }
    const values: Record<string, string> = {};
    const labels: Array<string> = [];
    for (const field of request.fields) {
      const matched = matchSingleCredential(resolved, [field.name, field.label]);
      if (matched === undefined) return undefined;
      values[field.name] = matched.value;
      labels.push(matched.label);
    }
    return {
      kind: "fields" as const,
      values,
      credentialLabels: labels,
    };
  });

  const saveToProject: ProjectCredentials["Service"]["saveToProject"] = Effect.fn(
    "ProjectCredentials.saveToProject",
  )(function* (input) {
    const autoGrant = input.autoGrant !== false;
    const bookmarksPatch: Record<string, ProjectCredentialBookmark> = {};
    const savedIds: Array<typeof SecretProviderSlug.Type> = [];

    if ("secret" in input) {
      if (resolver.saveItem === undefined) {
        return yield* new SecretRequestError({ reason: "vault_save_unconfirmed" });
      }
      const reference = yield* resolver.saveItem(input.provider, {
        vault: input.vault,
        label: input.label,
        value: input.secret,
      });
      if (reference === undefined) {
        return yield* new SecretRequestError({ reason: "vault_save_unconfirmed" });
      }
      const id = SecretProviderSlug.make(
        (yield* random.uuidV4().pipe(Effect.orDie)).replaceAll("-", ""),
      );
      bookmarksPatch[id] = {
        label: input.label,
        reference,
        ...(input.envVar === undefined ? {} : { envVar: input.envVar }),
        autoGrant,
      };
      savedIds.push(id);
    } else {
      let references: Readonly<Record<string, SecretReference>> | undefined;
      if (resolver.saveFields !== undefined) {
        references = yield* resolver.saveFields(input.provider, {
          vault: input.vault,
          label: input.label,
          fields: input.fields.map((field) => ({
            id: field.name,
            label: field.label,
            value: field.value,
          })),
        });
      } else if (resolver.saveItem !== undefined) {
        const built: Record<string, SecretReference> = {};
        for (const field of input.fields) {
          const title =
            input.fields.length === 1
              ? input.label
              : `${input.label} (${field.label})`.slice(0, 100);
          const ref = yield* resolver.saveItem(input.provider, {
            vault: input.vault,
            label: title,
            value: field.value,
          });
          if (ref === undefined) {
            return yield* new SecretRequestError({ reason: "vault_save_unconfirmed" });
          }
          built[field.name] = ref;
        }
        references = built;
      }
      if (references === undefined) {
        return yield* new SecretRequestError({ reason: "vault_save_unconfirmed" });
      }
      for (const field of input.fields) {
        const reference = references[field.name];
        if (reference === undefined) {
          return yield* new SecretRequestError({ reason: "vault_save_unconfirmed" });
        }
        const id = SecretProviderSlug.make(
          (yield* random.uuidV4().pipe(Effect.orDie)).replaceAll("-", ""),
        );
        const entryLabel =
          input.fields.length === 1 ? input.label : field.label.trim() || field.name.trim();
        bookmarksPatch[id] = {
          label: entryLabel.slice(0, 100),
          reference,
          ...(field.envVar === undefined ? {} : { envVar: field.envVar }),
          autoGrant,
        };
        savedIds.push(id);
      }
    }

    yield* settings
      .updateSettings({
        projectCredentialBookmarks: {
          [input.projectId]: bookmarksPatch,
        },
      })
      .pipe(
        Effect.mapError(() => new SecretRequestError({ reason: "vault_saved_reference_failed" })),
      );
    return { savedIds };
  });

  return ProjectCredentials.of({
    syncForProject,
    listForProject,
    resolveForProject,
    resolveEnvForProject,
    resolveForBoatSync,
    matchSecretRequest,
    saveToProject,
  });
});

export const layer = Layer.effect(ProjectCredentials, make);

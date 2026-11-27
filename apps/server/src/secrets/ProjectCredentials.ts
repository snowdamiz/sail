import {
  type PortableProjectCredentialsEntry,
  type PortableSecretProviderEntry,
  type ProjectCredentialBookmark,
  type ProjectCredentialEnvVar,
  type ProjectCredentialSaveInput,
  type ProjectCredentialSaveResult,
  type ProjectCredentialsListResult,
  type ProjectCredentialsSyncInput,
  type ProjectCredentialsSyncResult,
  type ProjectCredentialSummary,
  ProjectId,
  SecretProviderId,
  SecretProviderKind,
  SecretProviderSlug,
  type SecretReference,
  SecretRequestError,
  type SecretsExportPortableProvidersResult,
  type SecretsImportPortableProvidersInput,
  type SecretsImportPortableProvidersResult,
  type ServerSettingsPatch,
  type SyncedProjectCredentialEntry,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";

const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO_KEY_CACHE_TTL_MS = 60_000;
const GIT_REMOTE_TIMEOUT = Duration.seconds(2);

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

function normalizeGitRemoteRepoKey(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;
  const scpMatch = /^[^@\s]+@([^:\s/]+):(.+)$/.exec(trimmed);
  let host: string;
  let path: string;
  if (scpMatch !== null) {
    host = scpMatch[1]!.toLowerCase();
    path = scpMatch[2]!;
  } else if (URL.canParse(trimmed)) {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return null;
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } else {
    return null;
  }
  const cleanPath = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (cleanPath.length === 0 || !cleanPath.includes("/")) return null;
  const key = `${host}/${cleanPath}`;
  return key.length <= 256 ? key : null;
}

function extractPortableOnePasswordToken(config: unknown): string | null {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return null;
  const raw = Object.getOwnPropertyDescriptor(config, "serviceAccountToken")?.value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === SECRET_REDACTED || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
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
    readonly exportPortableProviders: Effect.Effect<
      SecretsExportPortableProvidersResult,
      SecretRequestError
    >;
    readonly importPortableProviders: (
      input: SecretsImportPortableProvidersInput,
    ) => Effect.Effect<SecretsImportPortableProvidersResult, SecretRequestError>;
  }
>()("t3/secrets/ProjectCredentials") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const spawnerOption = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);

  const repoKeyCache = new Map<
    string,
    { readonly key: string | null; readonly expiresAt: number }
  >();

  const readGitRemoteKey = Effect.fn("ProjectCredentials.readGitRemoteKey")(function* (
    workspaceRoot: string,
  ) {
    if (Option.isNone(spawnerOption)) return null;
    const spawner = spawnerOption.value;
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", ["-C", workspaceRoot, "remote", "get-url", "origin"], {
            stdin: "ignore",
          }),
        );
        const [chunks, exitCode] = yield* Effect.all(
          [
            Stream.runCollect(handle.stdout).pipe(
              Effect.map((items) => items.map((chunk) => new TextDecoder().decode(chunk)).join("")),
            ),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) return null;
        return normalizeGitRemoteRepoKey(chunks);
      }),
    ).pipe(
      Effect.timeoutOption(GIT_REMOTE_TIMEOUT),
      Effect.orElseSucceed((): Option.Option<string | null> => Option.none()),
    );
    return Option.isSome(outcome) ? outcome.value : null;
  });

  const listActiveProjects = Effect.fn("ProjectCredentials.listActiveProjects")(function* () {
    if (Option.isNone(sqlOption)) {
      return [] as ReadonlyArray<{ readonly projectId: ProjectId; readonly workspaceRoot: string }>;
    }
    const sql = sqlOption.value;
    const rows = yield* sql<{
      readonly projectId: string;
      readonly workspaceRoot: string;
    }>`
      SELECT project_id AS "projectId", workspace_root AS "workspaceRoot"
      FROM projection_projects
      WHERE deleted_at IS NULL
    `.pipe(Effect.orElseSucceed(() => []));
    return rows.map((row) => ({
      projectId: ProjectId.make(row.projectId),
      workspaceRoot: row.workspaceRoot,
    }));
  });

  const resolveProjectRepoKey = Effect.fn("ProjectCredentials.resolveProjectRepoKey")(function* (
    projectId: ProjectId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = repoKeyCache.get(projectId);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.key;
    }
    if (Option.isNone(sqlOption)) {
      return null;
    }
    const sql = sqlOption.value;
    const rows = yield* sql<{ readonly workspaceRoot: string }>`
      SELECT workspace_root AS "workspaceRoot"
      FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => []));
    const workspaceRoot = rows[0]?.workspaceRoot;
    const key =
      workspaceRoot !== undefined && workspaceRoot.length > 0
        ? yield* readGitRemoteKey(workspaceRoot)
        : null;
    repoKeyCache.set(projectId, { key, expiresAt: now + REPO_KEY_CACHE_TTL_MS });
    return key;
  });

  const effectiveLocalBookmarks = Effect.fn("ProjectCredentials.effectiveLocalBookmarks")(
    function* (
      current: {
        readonly projectCredentialBookmarks: Readonly<
          Record<string, Readonly<Record<string, ProjectCredentialBookmark>>>
        >;
        readonly repoCredentialBookmarks: Readonly<
          Record<string, Readonly<Record<string, ProjectCredentialBookmark>>>
        >;
      },
      projectId: ProjectId,
    ) {
      const direct = current.projectCredentialBookmarks[projectId] ?? {};
      const repoKey = yield* resolveProjectRepoKey(projectId);
      const repoEntries = repoKey !== null ? (current.repoCredentialBookmarks[repoKey] ?? {}) : {};
      if (Object.keys(repoEntries).length === 0) return direct;
      return { ...repoEntries, ...direct };
    },
  );

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
    const localEntries = yield* effectiveLocalBookmarks(current, projectId);
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
    const bookmarks = yield* effectiveLocalBookmarks(current, projectId);
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

    const repoKey = yield* resolveProjectRepoKey(input.projectId);
    yield* settings
      .updateSettings({
        projectCredentialBookmarks: {
          [input.projectId]: bookmarksPatch,
        },
        ...(repoKey !== null ? { repoCredentialBookmarks: { [repoKey]: bookmarksPatch } } : {}),
      })
      .pipe(
        Effect.mapError(() => new SecretRequestError({ reason: "vault_saved_reference_failed" })),
      );
    return { savedIds };
  });

  const exportPortableProviders: ProjectCredentials["Service"]["exportPortableProviders"] =
    Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })),
      );
      const providers: Array<PortableSecretProviderEntry> = [];
      const portableIds = new Set<string>();
      for (const [id, entry] of Object.entries(current.secretProviders)) {
        if (entry.kind !== "one_password") continue;
        const token = extractPortableOnePasswordToken(entry.config);
        if (token === null) continue;
        portableIds.add(id);
        providers.push({
          id: SecretProviderId.make(id),
          kind: "one_password",
          label: entry.label,
          serviceAccountToken: token,
        });
      }

      const repoCredentials: Record<string, Record<string, ProjectCredentialBookmark>> = {};
      for (const [repoKey, entries] of Object.entries(current.repoCredentialBookmarks)) {
        const filtered = Object.fromEntries(
          Object.entries(entries).filter(([, bookmark]) =>
            portableIds.has(bookmark.reference.provider),
          ),
        );
        if (Object.keys(filtered).length > 0) {
          repoCredentials[repoKey] = filtered;
        }
      }

      const projectCredentials: Array<PortableProjectCredentialsEntry> = [];
      for (const [rawProjectId, entries] of Object.entries(current.projectCredentialBookmarks)) {
        const filtered = Object.fromEntries(
          Object.entries(entries).filter(([, bookmark]) =>
            portableIds.has(bookmark.reference.provider),
          ),
        );
        if (Object.keys(filtered).length === 0) continue;
        const projectId = ProjectId.make(rawProjectId);
        const repoKey = yield* resolveProjectRepoKey(projectId);
        projectCredentials.push({
          projectId,
          ...(repoKey !== null ? { repoKey } : {}),
          bookmarks: filtered,
        });
        if (repoKey !== null) {
          repoCredentials[repoKey] = {
            ...repoCredentials[repoKey],
            ...filtered,
          };
        }
      }

      return {
        providers,
        projectCredentials,
        repoCredentials,
      };
    });

  const importPortableProviders: ProjectCredentials["Service"]["importPortableProviders"] =
    Effect.fn("ProjectCredentials.importPortableProviders")(function* (input) {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })),
      );

      const secretProvidersPatch: Record<
        string,
        {
          readonly kind: SecretProviderKind;
          readonly label: string;
          readonly config: { readonly serviceAccountToken: string };
        } | null
      > = {};

      let importedProviders = 0;
      for (const provider of input.providers) {
        secretProvidersPatch[provider.id] = {
          kind: SecretProviderKind.make(provider.kind),
          label: provider.label,
          config: { serviceAccountToken: provider.serviceAccountToken },
        };
        importedProviders += 1;
      }

      for (const removeId of input.removeProviderIds ?? []) {
        if (Object.hasOwn(secretProvidersPatch, removeId)) continue;
        const existing = current.secretProviders[removeId];
        // Only remove a provider if it is also a portable service-account provider.
        if (
          existing !== undefined &&
          existing.kind === "one_password" &&
          extractPortableOnePasswordToken(existing.config) !== null
        ) {
          secretProvidersPatch[removeId] = null;
        }
      }

      const activeProjects = yield* listActiveProjects();
      const projectIdsByRepoKey = new Map<string, Array<ProjectId>>();
      const activeProjectIdSet = new Set<string>();
      for (const project of activeProjects) {
        activeProjectIdSet.add(project.projectId);
        const repoKey = yield* resolveProjectRepoKey(project.projectId);
        if (repoKey !== null) {
          const list = projectIdsByRepoKey.get(repoKey) ?? [];
          list.push(project.projectId);
          projectIdsByRepoKey.set(repoKey, list);
        }
      }

      const projectBookmarksPatch: Record<string, Record<string, ProjectCredentialBookmark>> = {};
      const repoBookmarksPatch: Record<string, Record<string, ProjectCredentialBookmark>> = {};
      let importedBookmarks = 0;

      for (const [repoKey, bookmarks] of Object.entries(input.repoCredentials)) {
        if (Object.keys(bookmarks).length === 0) continue;
        repoBookmarksPatch[repoKey] = {
          ...repoBookmarksPatch[repoKey],
          ...bookmarks,
        };
        for (const matchedProjectId of projectIdsByRepoKey.get(repoKey) ?? []) {
          projectBookmarksPatch[matchedProjectId] = {
            ...projectBookmarksPatch[matchedProjectId],
            ...bookmarks,
          };
        }
        importedBookmarks += Object.keys(bookmarks).length;
      }

      for (const entry of input.projectCredentials) {
        if (Object.keys(entry.bookmarks).length === 0) continue;
        if (entry.repoKey !== undefined) {
          repoBookmarksPatch[entry.repoKey] = {
            ...repoBookmarksPatch[entry.repoKey],
            ...entry.bookmarks,
          };
        }
        const matchedTargets = new Set<ProjectId>();
        if (activeProjectIdSet.has(entry.projectId)) {
          matchedTargets.add(entry.projectId);
        }
        if (entry.repoKey !== undefined) {
          for (const matchedId of projectIdsByRepoKey.get(entry.repoKey) ?? []) {
            matchedTargets.add(matchedId);
          }
        }
        for (const targetProjectId of matchedTargets) {
          projectBookmarksPatch[targetProjectId] = {
            ...projectBookmarksPatch[targetProjectId],
            ...entry.bookmarks,
          };
        }
        importedBookmarks += Object.keys(entry.bookmarks).length;
      }

      const patch: ServerSettingsPatch = {
        ...(Object.keys(secretProvidersPatch).length > 0
          ? { secretProviders: secretProvidersPatch }
          : {}),
        ...(Object.keys(projectBookmarksPatch).length > 0
          ? { projectCredentialBookmarks: projectBookmarksPatch }
          : {}),
        ...(Object.keys(repoBookmarksPatch).length > 0
          ? { repoCredentialBookmarks: repoBookmarksPatch }
          : {}),
      };

      if (
        patch.secretProviders !== undefined ||
        patch.projectCredentialBookmarks !== undefined ||
        patch.repoCredentialBookmarks !== undefined
      ) {
        yield* settings
          .updateSettings(patch)
          .pipe(
            Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
          );
      }

      return { importedProviders, importedBookmarks };
    });

  return ProjectCredentials.of({
    syncForProject,
    listForProject,
    resolveForProject,
    resolveEnvForProject,
    resolveForBoatSync,
    matchSecretRequest,
    saveToProject,
    exportPortableProviders,
    importPortableProviders,
  });
});

export const layer = Layer.effect(ProjectCredentials, make);

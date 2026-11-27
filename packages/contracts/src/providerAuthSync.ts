import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { SecretReference } from "./secretReference.ts";

export const SyncedProviderEnvVar = Schema.Struct({
  name: TrimmedNonEmptyString,
  value: Schema.Union([Schema.String, SecretReference]),
  sensitive: Schema.Boolean,
});
export type SyncedProviderEnvVar = typeof SyncedProviderEnvVar.Type;

export const SyncedProviderInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  accentColor: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
  /** Portable config fields (excluding host-local binaryPath, homePath, shadowHomePath, commandPath). */
  portableConfig: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  environment: Schema.optionalKey(Schema.Array(SyncedProviderEnvVar)),
});
export type SyncedProviderInstance = typeof SyncedProviderInstance.Type;

export const SyncedProviderStoreDriver = Schema.Literals([
  "codex-chatgpt",
  "codex-chatgpt-registration",
  "cursor",
]);
export type SyncedProviderStoreDriver = typeof SyncedProviderStoreDriver.Type;

export const SyncedProviderStoreBlob = Schema.Struct({
  driver: SyncedProviderStoreDriver,
  instanceId: ProviderInstanceId,
  payload: Schema.String,
});
export type SyncedProviderStoreBlob = typeof SyncedProviderStoreBlob.Type;

export const SyncedAntigravityProfileFileName = Schema.Literals([
  "acp_token.json",
  "antigravity-oauth-token",
]);
export type SyncedAntigravityProfileFileName = typeof SyncedAntigravityProfileFileName.Type;

export const SyncedAntigravityProfileFile = Schema.Struct({
  instanceId: ProviderInstanceId,
  fileName: SyncedAntigravityProfileFileName,
  content: Schema.String,
});
export type SyncedAntigravityProfileFile = typeof SyncedAntigravityProfileFile.Type;

export const SyncedCliAuthEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("claude"),
    instanceId: ProviderInstanceId,
    credentialsJson: Schema.String,
    oauthAccount: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  Schema.Struct({
    kind: Schema.Literal("codex"),
    instanceId: ProviderInstanceId,
    authJson: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("opencode"),
    instanceId: ProviderInstanceId,
    authJson: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("grok"),
    instanceId: ProviderInstanceId,
    authJson: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("pi"),
    instanceId: ProviderInstanceId,
    authJson: Schema.String,
  }),
]);
export type SyncedCliAuthEntry = typeof SyncedCliAuthEntry.Type;

export const ProviderAuthSyncBundle = Schema.Struct({
  version: Schema.Literal(1),
  instances: Schema.Array(SyncedProviderInstance),
  storeBlobs: Schema.Array(SyncedProviderStoreBlob),
  antigravityFiles: Schema.Array(SyncedAntigravityProfileFile),
  cliAuth: Schema.Array(SyncedCliAuthEntry),
});
export type ProviderAuthSyncBundle = typeof ProviderAuthSyncBundle.Type;

export const ProviderAuthExportBundleInput = Schema.Struct({
  resolveSecretReferences: Schema.optionalKey(Schema.Boolean),
});
export type ProviderAuthExportBundleInput = typeof ProviderAuthExportBundleInput.Type;

export const ProviderAuthExportBundleResult = Schema.Struct({
  bundle: ProviderAuthSyncBundle,
  fingerprint: Schema.String,
});
export type ProviderAuthExportBundleResult = typeof ProviderAuthExportBundleResult.Type;

export const ProviderAuthImportBundleInput = Schema.Struct({
  bundle: ProviderAuthSyncBundle,
  /** When true (initial Desktop <-> Web reconciliation), keep target's strictly newer unexpired OAuth tokens. */
  preferExistingNewer: Schema.optionalKey(Schema.Boolean),
});
export type ProviderAuthImportBundleInput = typeof ProviderAuthImportBundleInput.Type;

export const ProviderAuthImportBundleResult = Schema.Struct({
  changed: Schema.Boolean,
  importedInstances: Schema.Int,
  importedCredentials: Schema.Int,
});
export type ProviderAuthImportBundleResult = typeof ProviderAuthImportBundleResult.Type;

export const ProviderAuthSyncErrorReason = Schema.Literals([
  "sync_not_supported",
  "export_failed",
  "import_failed",
]);
export type ProviderAuthSyncErrorReason = typeof ProviderAuthSyncErrorReason.Type;

export class ProviderAuthSyncError extends Schema.TaggedError<ProviderAuthSyncError>()(
  "ProviderAuthSyncError",
  {
    reason: ProviderAuthSyncErrorReason,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? `Provider auth sync failed (${this.reason}).`;
  }
}

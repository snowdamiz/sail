import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import {
  ProjectCredentialEnvVar,
  SecretProviderId,
  SecretProviderSlug,
  SecretReference,
} from "./secretReference.ts";

/** The http(s) page a secret card may open, or null for anything else. */
export function secretRequestPageUrl(value: string): URL | null {
  // React Native's URL has no `canParse`.
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "" ? url : null;
  } catch {
    return null;
  }
}

const VaultName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[^\r\n]+$/),
);
const CredentialLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(100));

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("save"), secret: TrimmedNonEmptyString }),
    Schema.Struct({
      type: Schema.Literal("save-to-vault"),
      secret: TrimmedNonEmptyString,
      provider: SecretProviderId,
      vault: VaultName,
      label: CredentialLabel,
      envVar: Schema.optionalKey(ProjectCredentialEnvVar),
      autoGrant: Schema.optionalKey(Schema.Boolean),
    }),
    /** Multi-field vault save: stores each field in the vault and authorizes them for the project. */
    Schema.Struct({
      type: Schema.Literal("save-to-vault"),
      values: Schema.Record(Schema.String, TrimmedNonEmptyString),
      provider: SecretProviderId,
      vault: VaultName,
      label: CredentialLabel,
      envVars: Schema.optionalKey(Schema.Record(Schema.String, ProjectCredentialEnvVar)),
      autoGrant: Schema.optionalKey(Schema.Boolean),
    }),
    /** A request with `fields`: one value per field name. */
    Schema.Struct({
      type: Schema.Literal("save"),
      values: Schema.Record(Schema.String, TrimmedNonEmptyString),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
    /** Read once through a configured secret provider; only servers advertising `secretRequestReferences` accept it. */
    Schema.Struct({ type: Schema.Literal("reference"), reference: SecretReference }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

export const SyncedProjectCredentialEntry = Schema.Struct({
  id: SecretProviderSlug,
  label: CredentialLabel,
  value: TrimmedNonEmptyString,
  envVar: Schema.optionalKey(ProjectCredentialEnvVar),
  autoGrant: Schema.optionalKey(Schema.Boolean),
});
export type SyncedProjectCredentialEntry = typeof SyncedProjectCredentialEntry.Type;

export const ProjectCredentialsSyncInput = Schema.Struct({
  projectId: ProjectId,
  credentials: Schema.Array(SyncedProjectCredentialEntry),
});
export type ProjectCredentialsSyncInput = typeof ProjectCredentialsSyncInput.Type;

export const ProjectCredentialsSyncResult = Schema.Struct({
  syncedCount: Schema.Number,
});
export type ProjectCredentialsSyncResult = typeof ProjectCredentialsSyncResult.Type;

export const ProjectCredentialsListInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectCredentialsListInput = typeof ProjectCredentialsListInput.Type;

export const ProjectCredentialSummary = Schema.Struct({
  id: SecretProviderSlug,
  label: CredentialLabel,
  envVar: Schema.optionalKey(ProjectCredentialEnvVar),
  autoGrant: Schema.Boolean,
  source: Schema.Literals(["local", "synced"]),
  reference: Schema.optionalKey(SecretReference),
});
export type ProjectCredentialSummary = typeof ProjectCredentialSummary.Type;

export const ProjectCredentialsListResult = Schema.Struct({
  credentials: Schema.Array(ProjectCredentialSummary),
});
export type ProjectCredentialsListResult = typeof ProjectCredentialsListResult.Type;

export const ProjectCredentialSaveField = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  label: CredentialLabel,
  value: TrimmedNonEmptyString,
  envVar: Schema.optionalKey(ProjectCredentialEnvVar),
});
export type ProjectCredentialSaveField = typeof ProjectCredentialSaveField.Type;

export const ProjectCredentialSaveInput = Schema.Union([
  Schema.Struct({
    projectId: ProjectId,
    provider: SecretProviderId,
    vault: VaultName,
    label: CredentialLabel,
    secret: TrimmedNonEmptyString,
    envVar: Schema.optionalKey(ProjectCredentialEnvVar),
    autoGrant: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    projectId: ProjectId,
    provider: SecretProviderId,
    vault: VaultName,
    label: CredentialLabel,
    fields: Schema.Array(ProjectCredentialSaveField).check(Schema.isMinLength(1)),
    autoGrant: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type ProjectCredentialSaveInput = typeof ProjectCredentialSaveInput.Type;

export const ProjectCredentialSaveResult = Schema.Struct({
  savedIds: Schema.Array(SecretProviderSlug),
});
export type ProjectCredentialSaveResult = typeof ProjectCredentialSaveResult.Type;

export const PortableSecretProviderEntry = Schema.Struct({
  id: SecretProviderId,
  kind: Schema.Literal("one_password"),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  serviceAccountToken: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type PortableSecretProviderEntry = typeof PortableSecretProviderEntry.Type;

const PortableCredentialBookmark = Schema.Struct({
  label: CredentialLabel,
  reference: SecretReference,
  envVar: Schema.optionalKey(ProjectCredentialEnvVar),
  autoGrant: Schema.optionalKey(Schema.Boolean),
});

export const PortableProjectCredentialsEntry = Schema.Struct({
  projectId: ProjectId,
  repoKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  bookmarks: Schema.Record(SecretProviderSlug, PortableCredentialBookmark),
});
export type PortableProjectCredentialsEntry = typeof PortableProjectCredentialsEntry.Type;

export const SecretsExportPortableProvidersInput = Schema.Struct({});
export type SecretsExportPortableProvidersInput = typeof SecretsExportPortableProvidersInput.Type;

export const SecretsExportPortableProvidersResult = Schema.Struct({
  providers: Schema.Array(PortableSecretProviderEntry),
  projectCredentials: Schema.Array(PortableProjectCredentialsEntry),
  repoCredentials: Schema.Record(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    Schema.Record(SecretProviderSlug, PortableCredentialBookmark),
  ),
});
export type SecretsExportPortableProvidersResult = typeof SecretsExportPortableProvidersResult.Type;

export const SecretsImportPortableProvidersInput = Schema.Struct({
  providers: Schema.Array(PortableSecretProviderEntry),
  projectCredentials: Schema.Array(PortableProjectCredentialsEntry),
  repoCredentials: Schema.Record(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    Schema.Record(SecretProviderSlug, PortableCredentialBookmark),
  ),
  removeProviderIds: Schema.optionalKey(Schema.Array(SecretProviderId)),
});
export type SecretsImportPortableProvidersInput = typeof SecretsImportPortableProvidersInput.Type;

export const SecretsImportPortableProvidersResult = Schema.Struct({
  importedProviders: Schema.Number,
  importedBookmarks: Schema.Number,
});
export type SecretsImportPortableProvidersResult = typeof SecretsImportPortableProvidersResult.Type;

/** What the agent reads when its card ends without a secret. */
export const SECRET_REQUEST_UNSAVED_NOTE = {
  declined:
    "The user declined. Don't ask for it in chat or another way; say what's blocked and go on without it.",
  cancelled:
    "The card closed with the run. Ask again with a new clientRequestId only if the secret is still needed.",
  timed_out:
    "No answer in time. Don't ask in chat; ask again with a new clientRequestId only if it is still needed.",
} as const;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  fields_mismatch: "This request asks for different values. Update the app and try again.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  reference_unreadable: "Could not read the secret from the secret provider.",
  vault_save_unconfirmed:
    "Could not confirm the vault save. Check your password manager and add the reference in Settings if the item exists. Answer without saving to the vault.",
  vault_save_pending_answer:
    "An earlier answer is still pending. Complete the request without saving to the vault. To keep the new value, add it to your password manager and save its reference in Settings.",
  vault_saved_reference_failed:
    "The item was saved to your vault, but its project reference could not be saved. Add that reference in Settings before answering again.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  not_a_file_request:
    'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
  sync_not_supported: "Secret provider sync is not supported on this environment.",
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    /** The secret provider a `reference_unreadable` answer named. */
    provider: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "reference_unreadable" && this.provider !== undefined) {
      return `Could not read the secret from the secret provider "${this.provider}". Unlock it and try again, or enter the value.`;
    }
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}

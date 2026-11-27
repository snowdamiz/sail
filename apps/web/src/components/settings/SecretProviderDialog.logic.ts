import {
  SECRET_REDACTED,
  SecretProviderId,
  SecretProviderKind,
  SecretProviderLabel,
  type SecretProviderConfig,
} from "@t3tools/contracts";
import {
  OnePasswordAccount,
  OnePasswordSecretProviderConfig,
  OnePasswordServiceAccountToken,
} from "@t3tools/secret-provider-onepassword/shared/definition";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

const decodeSecretProviderId = Schema.decodeOption(SecretProviderId);
const decodeOnePasswordConfig = Schema.decodeUnknownOption(OnePasswordSecretProviderConfig);

export type OnePasswordAuthMode = "service_account" | "cli_account";

export type ClassifiedSecretProvider =
  | {
      readonly kind: "one_password";
      readonly mode: "service_account";
      readonly hasToken: boolean;
    }
  | {
      readonly kind: "one_password";
      readonly mode: "cli_account";
      readonly account: OnePasswordAccount;
    }
  | { readonly kind: "unsupported" };

/** Unknown kinds and configs that no longer decode are shown read-only; removal stays available. */
export function classifySecretProvider(provider: SecretProviderConfig): ClassifiedSecretProvider {
  if (provider.kind !== "one_password") return { kind: "unsupported" };
  const decoded = decodeOnePasswordConfig(provider.config);
  if (decoded._tag !== "Some") return { kind: "unsupported" };
  if (decoded.value.serviceAccountToken !== undefined) {
    return {
      kind: "one_password",
      mode: "service_account",
      hasToken: decoded.value.serviceAccountToken.trim().length > 0,
    };
  }
  if (decoded.value.account !== undefined) {
    return { kind: "one_password", mode: "cli_account", account: decoded.value.account };
  }
  return { kind: "unsupported" };
}

/** Stable and readable in settings.json, so re-adding a provider under the same name restores its variables. */
function secretProviderIdFromName(name: string): SecretProviderId | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  return Option.getOrNull(decodeSecretProviderId(slug));
}

export interface SecretProviderDraft {
  readonly name: string;
  readonly mode: OnePasswordAuthMode;
  readonly serviceAccountToken: string;
  readonly account: string;
  readonly hasExistingToken?: boolean;
}

export function emptySecretProviderDraft(): SecretProviderDraft {
  return {
    name: "",
    mode: "service_account",
    serviceAccountToken: "",
    account: "",
  };
}

export function draftFromSecretProvider(provider: SecretProviderConfig): SecretProviderDraft {
  const classified = classifySecretProvider(provider);
  if (classified.kind === "one_password" && classified.mode === "service_account") {
    return {
      name: provider.label,
      mode: "service_account",
      serviceAccountToken: "",
      account: "",
      hasExistingToken: classified.hasToken,
    };
  }
  if (classified.kind === "one_password" && classified.mode === "cli_account") {
    return {
      name: provider.label,
      mode: "cli_account",
      serviceAccountToken: "",
      account: classified.account,
    };
  }
  return {
    name: provider.label,
    mode: "service_account",
    serviceAccountToken: "",
    account: "",
  };
}

export type SecretProviderTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: SecretProviderId };

export type SecretProviderDraftIssues = {
  readonly name?: string;
  readonly serviceAccountToken?: string;
  readonly account?: string;
};

function decodeField<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: string,
  emptyMessage: string,
): Result.Result<S["Type"], string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Result.fail(emptyMessage);
  return Result.mapError(Schema.decodeResult(schema)(trimmed), (error) => error.message);
}

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function secretProviderFromDraft(
  draft: SecretProviderDraft,
  existingIds: ReadonlySet<string>,
  target: SecretProviderTarget,
  resolve: MessageResolver = m,
): Result.Result<
  { readonly id: SecretProviderId; readonly config: SecretProviderConfig },
  SecretProviderDraftIssues
> {
  const label = decodeField(SecretProviderLabel, draft.name, resolve(msg("Enter a name.")));

  let id: SecretProviderId | null = null;
  let nameIssue: string | undefined;
  if (Result.isFailure(label)) {
    nameIssue = label.failure;
  } else {
    id = target.mode === "edit" ? target.id : secretProviderIdFromName(label.success);
    if (id === null) nameIssue = resolve(msg("The name needs at least one letter or digit."));
    else if (target.mode === "add" && existingIds.has(id))
      nameIssue = resolve(msg("A secret provider with this name exists."));
  }

  if (draft.mode === "service_account") {
    const trimmedToken = draft.serviceAccountToken.trim();
    const tokenResult: Result.Result<string, string> =
      trimmedToken.length === 0 && target.mode === "edit" && draft.hasExistingToken === true
        ? Result.succeed(SECRET_REDACTED)
        : decodeField(
            OnePasswordServiceAccountToken,
            draft.serviceAccountToken,
            resolve(msg("Enter a 1Password Service Account token.")),
          );

    if (
      id === null ||
      nameIssue !== undefined ||
      Result.isFailure(label) ||
      Result.isFailure(tokenResult)
    ) {
      return Result.fail({
        ...(nameIssue === undefined ? {} : { name: nameIssue }),
        ...(Result.isFailure(tokenResult) ? { serviceAccountToken: tokenResult.failure } : {}),
      });
    }
    return Result.succeed({
      id,
      config: {
        kind: SecretProviderKind.make("one_password"),
        label: label.success,
        config: { serviceAccountToken: tokenResult.success },
      },
    });
  }

  const account = decodeField(
    OnePasswordAccount,
    draft.account,
    resolve(msg("Enter the 1Password account.")),
  );

  if (
    id === null ||
    nameIssue !== undefined ||
    Result.isFailure(label) ||
    Result.isFailure(account)
  ) {
    return Result.fail({
      ...(nameIssue === undefined ? {} : { name: nameIssue }),
      ...(Result.isFailure(account) ? { account: account.failure } : {}),
    });
  }
  return Result.succeed({
    id,
    config: {
      kind: SecretProviderKind.make("one_password"),
      label: label.success,
      config: { account: account.success },
    },
  });
}

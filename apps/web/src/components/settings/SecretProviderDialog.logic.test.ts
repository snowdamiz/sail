import { SECRET_REDACTED, SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  classifySecretProvider,
  draftFromSecretProvider,
  secretProviderFromDraft,
} from "./SecretProviderDialog.logic";

describe("secretProviderFromDraft", () => {
  it("adds a 1Password Service Account provider keyed by its name", () => {
    expect(
      secretProviderFromDraft(
        {
          name: "  1Password!  ",
          mode: "service_account",
          serviceAccountToken: "  ops_example_token_123  ",
          account: "",
        },
        new Set(),
        { mode: "add" },
      ),
    ).toEqual(
      Result.succeed({
        id: "1password",
        config: {
          kind: "one_password",
          label: "1Password!",
          config: { serviceAccountToken: "ops_example_token_123" },
        },
      }),
    );

    const missingToken = secretProviderFromDraft(
      {
        name: "1Password",
        mode: "service_account",
        serviceAccountToken: "   ",
        account: "",
      },
      new Set(["1password"]),
      { mode: "add" },
    );
    expect(Result.isFailure(missingToken) && Object.keys(missingToken.failure).toSorted()).toEqual([
      "name",
      "serviceAccountToken",
    ]);
  });

  it("preserves an existing redacted service account token when editing with a blank token field", () => {
    const id = SecretProviderId.make("personal");
    const existing = {
      kind: SecretProviderKind.make("one_password"),
      label: "Personal",
      config: { serviceAccountToken: SECRET_REDACTED },
    };
    const draft = draftFromSecretProvider(existing);
    expect(draft).toEqual({
      name: "Personal",
      mode: "service_account",
      serviceAccountToken: "",
      account: "",
      hasExistingToken: true,
    });
    expect(classifySecretProvider(existing)).toEqual({
      kind: "one_password",
      mode: "service_account",
      hasToken: true,
    });

    const renamed = secretProviderFromDraft(
      { ...draft, name: "Personal (shared)" },
      new Set(["personal"]),
      { mode: "edit", id },
    );
    expect(Result.isSuccess(renamed) && renamed.success).toEqual({
      id,
      config: {
        kind: "one_password",
        label: "Personal (shared)",
        config: { serviceAccountToken: SECRET_REDACTED },
      },
    });
  });

  it("adds a local CLI account provider and reports every field that blocks it", () => {
    expect(
      secretProviderFromDraft(
        {
          name: "  1Password!  ",
          mode: "cli_account",
          serviceAccountToken: "",
          account: "my.1password.com",
        },
        new Set(),
        { mode: "add" },
      ),
    ).toEqual(
      Result.succeed({
        id: "1password",
        config: {
          kind: "one_password",
          label: "1Password!",
          config: { account: "my.1password.com" },
        },
      }),
    );

    const blocked = secretProviderFromDraft(
      {
        name: "1Password",
        mode: "cli_account",
        serviceAccountToken: "",
        account: "--help",
      },
      new Set(["1password"]),
      { mode: "add" },
    );
    expect(Result.isFailure(blocked) && Object.keys(blocked.failure).toSorted()).toEqual([
      "account",
      "name",
    ]);
  });

  it("keeps the id when an edit renames a local CLI provider", () => {
    const id = SecretProviderId.make("personal");
    const result = secretProviderFromDraft(
      {
        name: "Personal (team)",
        mode: "cli_account",
        serviceAccountToken: "",
        account: "team.1password.com",
      },
      new Set(["personal"]),
      { mode: "edit", id },
    );
    expect(Result.isSuccess(result) && result.success).toEqual({
      id,
      config: {
        kind: "one_password",
        label: "Personal (team)",
        config: { account: "team.1password.com" },
      },
    });
  });
});

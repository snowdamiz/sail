import type { EnvironmentId, SecretProviderConfig, SecretProviderId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { notifyPortableSecretProviderEdited } from "../../state/secretProviderSync";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  draftFromSecretProvider,
  emptySecretProviderDraft,
  secretProviderFromDraft,
  type SecretProviderDraft,
} from "./SecretProviderDialog.logic";

/** Mounted per open, so each open starts from a fresh draft. */
export function SecretProviderDialog({
  onClose,
  environmentId,
  environmentLabel,
  existingIds,
  existing,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
  readonly existing?: { readonly id: SecretProviderId; readonly config: SecretProviderConfig };
}) {
  const messages = useMessages();
  const gt = useGT();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [draft, setDraft] = useState<SecretProviderDraft>(
    existing ? draftFromSecretProvider(existing.config) : emptySecretProviderDraft(),
  );
  const [submitted, setSubmitted] = useState(false);
  const result = secretProviderFromDraft(
    draft,
    existingIds,
    existing ? { mode: "edit", id: existing.id } : { mode: "add" },
    messages,
  );
  const issues = Result.isFailure(result) ? result.failure : {};
  const nameError = submitted ? issues.name : undefined;
  const tokenError = submitted ? issues.serviceAccountToken : undefined;
  const accountError = submitted ? issues.account : undefined;

  const update = (patch: Partial<SecretProviderDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    setSubmitted(true);
    if (Result.isFailure(result)) return;
    const isServiceAccount = draft.mode === "service_account";
    updateSettings(
      { secretProviders: { [result.success.id]: result.success.config } },
      {
        onSaved: () => {
          if (isServiceAccount) {
            notifyPortableSecretProviderEdited(environmentId);
          }
        },
      },
    );
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? gt("Edit {label}", { label: existing.config.label })
              : gt("Add a 1Password provider")}
          </DialogTitle>
          <DialogDescription>
            <T>
              Connect with a Service Account token to share 1Password across Desktop, Web, and
              Boats. Local CLI accounts stay on <Var>{environmentLabel}</Var>.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="secret-provider-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-name">
                <T>Name</T>
              </Label>
              <Input
                id="secret-provider-name"
                placeholder={gt("Personal")}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={64}
                aria-invalid={nameError !== undefined}
                aria-describedby={
                  nameError !== undefined ? "secret-provider-name-error" : undefined
                }
                autoFocus
              />
              {nameError !== undefined ? (
                <p
                  id="secret-provider-name-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {nameError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label>
                <T>Connection</T>
              </Label>
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={draft.mode === "service_account" ? "secondary" : "outline"}
                  aria-pressed={draft.mode === "service_account"}
                  onClick={() => update({ mode: "service_account" })}
                >
                  <T>Service account</T>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={draft.mode === "cli_account" ? "secondary" : "outline"}
                  aria-pressed={draft.mode === "cli_account"}
                  onClick={() => update({ mode: "cli_account" })}
                >
                  <T>Local CLI account</T>
                </Button>
              </div>
            </div>
            {draft.mode === "service_account" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="secret-provider-token">
                  <T>Service account token</T>
                </Label>
                <Input
                  id="secret-provider-token"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    draft.hasExistingToken ? gt("Saved (leave blank to keep)") : "ops_..."
                  }
                  value={draft.serviceAccountToken}
                  onChange={(event) => update({ serviceAccountToken: event.target.value })}
                  maxLength={4096}
                  spellCheck={false}
                  aria-invalid={tokenError !== undefined}
                  aria-describedby={
                    tokenError !== undefined ? "secret-provider-token-error" : undefined
                  }
                />
                {tokenError !== undefined ? (
                  <p
                    id="secret-provider-token-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {tokenError}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  <T>
                    Create a Service Account in 1Password and grant it access to the vaults Sail
                    should read and save to. Syncs automatically between Desktop and Web.
                  </T>
                </p>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="secret-provider-account">
                  <T>Account</T>
                </Label>
                <Input
                  id="secret-provider-account"
                  placeholder="my.1password.com"
                  value={draft.account}
                  onChange={(event) => update({ account: event.target.value })}
                  maxLength={253}
                  spellCheck={false}
                  aria-invalid={accountError !== undefined}
                  aria-describedby={
                    accountError !== undefined ? "secret-provider-account-error" : undefined
                  }
                />
                {accountError !== undefined ? (
                  <p
                    id="secret-provider-account-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {accountError}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  <T>
                    The account shorthand, sign-in address without https://, or ID that op account
                    list shows.
                  </T>
                </p>
              </div>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            type="submit"
            form="secret-provider-form"
            disabled={submitted && Result.isFailure(result)}
          >
            {existing ? gt("Save changes") : gt("Add provider")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

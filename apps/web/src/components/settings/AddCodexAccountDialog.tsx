import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { T, useGT } from "gt-react";
import { useState, type ReactNode } from "react";

import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { m as resolveMessage } from "../../i18n/messages";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { SettingsRow } from "./settingsLayout";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

export function AddCodexAccountDialog({
  environmentId,
  onClose,
  renderSetup,
  onAccountCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  // Told when the account is created; the dialog then runs its own sign-in.
  readonly onAccountCreated?:
    | ((instanceId: ProviderInstanceId, displayName: string) => void)
    | undefined;
  readonly renderSetup: (instanceId: ProviderInstanceId, provider: ServerProvider) => ReactNode;
}) {
  const gt = useGT();
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [name, setName] = useState(() =>
    gt("Personal", { $context: "default name for a ChatGPT account" }),
  );
  const displayName = `ChatGPT - ${name.trim()}`;
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [pending, setPending] = useState(false);
  const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
  // Closes itself once the new account connects; the owner unmounts it after
  // the close animation.
  const connected = usesChatGptSharing(provider);

  const createAccount = async () => {
    if (pending || !name.trim() || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    setPending(true);
    const id = ProviderInstanceId.make(`codex_${randomUUID()}`);
    const result = await persistProviderInstance({
      operation: "create",
      instanceId: id,
      instance: {
        driver: CODEX_DRIVER_KIND,
        displayName,
        enabled: true,
        config: { enabled: true, setupMode: "managed" },
      },
    });
    if (result._tag === "Success") {
      onAccountCreated?.(id, displayName);
      setInstanceId(id);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not add ChatGPT account"),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
            : gt("The settings update failed."),
      });
    }
    setPending(false);
  };

  return (
    <Dialog
      open={!connected}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open && connected) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={instanceId ? displayName : gt("Add ChatGPT account")}
          description={gt(
            "Each account has its own Codex instance and sign-in. Choose the other account on the sign-in page.",
          )}
        />
        <WizardPanel>
          {instanceId ? (
            provider?.setup ? (
              renderSetup(instanceId, provider)
            ) : (
              <SettingsRow
                title={gt("Codex runtime")}
                description={gt("Preparing managed setup.")}
              />
            )
          ) : (
            <form
              id="add-codex-account"
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void createAccount();
              }}
            >
              <SettingsRow
                title={gt("Account name")}
                description={gt("Shown in the provider list and model picker.")}
                control={
                  <Input
                    aria-label={gt("Account name")}
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={gt("e.g. Personal or Work")}
                  />
                }
              />
            </form>
          )}
        </WizardPanel>
        <WizardFooter>
          {instanceId ? (
            <Button variant="outline" onClick={onClose}>
              <T>Finish later</T>
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                <T>Cancel</T>
              </Button>
              <Button
                type="submit"
                form="add-codex-account"
                disabled={pending || !name.trim() || !canManageProviders}
              >
                {pending ? gt("Adding account…") : gt("Continue")}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

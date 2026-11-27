import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, AuthStandardClientScopes } from "@t3tools/contracts";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import * as Option from "effect/Option";
import { useGT, useMessages } from "gt-react";

import { authEnvironment } from "~/state/auth";
import type { EnvironmentPresentation } from "~/state/environments";
import { readEnvironmentScope, useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { resolvePairingShareBaseUrl } from "./ConnectionsSettings.logic";
import { resolveDesktopPairingUrl } from "./pairingUrls";

export function useConnectSailDesktopAction(environment: EnvironmentPresentation | undefined) {
  const gt = useGT();
  const messages = useMessages();
  const browserEnvironmentId = window.desktopBridge ? null : (environment?.environmentId ?? null);
  const prepared = usePreparedConnection(browserEnvironmentId);
  const canCreate = useEnvironmentScope(browserEnvironmentId, AuthAccessWriteScope);
  const createCredential = useAtomCommand(authEnvironment.createPairingCredential, {
    reportFailure: false,
  });
  if (
    browserEnvironmentId === null ||
    environment?.connection.phase !== "connected" ||
    !canCreate ||
    managedCapabilityDenial(environment.serverConfig?.managedPolicy, "remoteClients", messages)
  ) {
    return null;
  }
  const baseUrl = resolvePairingShareBaseUrl({
    entry: environment.entry,
    prepared: Option.getOrNull(prepared),
  });
  if (baseUrl === null) return null;

  return async () => {
    if (!readEnvironmentScope(browserEnvironmentId, AuthAccessWriteScope)) return;
    const scopes = AuthStandardClientScopes.filter((scope) =>
      readEnvironmentScope(browserEnvironmentId, scope),
    );
    if (scopes.length === 0) return;

    const result = await createCredential({
      environmentId: browserEnvironmentId,
      input: { scopes },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) throw squashAtomCommandFailure(result);
      return;
    }

    const appLink = buildPairingAppLink(resolveDesktopPairingUrl(baseUrl, result.value.credential));
    const openDesktop = () => window.location.assign(appLink);
    // Some browsers require a fresh click to open an app after the credential request.
    toastManager.add({
      title: gt("Pairing link"),
      actionProps: { children: gt("Open in Sail desktop"), onClick: openDesktop },
    });
    openDesktop();
  };
}

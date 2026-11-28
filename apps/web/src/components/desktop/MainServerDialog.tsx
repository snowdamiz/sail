import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { environmentSupportsLocalSessions, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState, useSyncExternalStore } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { m } from "../../i18n/messages";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { pinClientPreferencesServer } from "../../state/clientPreferences";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export interface MainServerOffer {
  readonly environmentId: EnvironmentId;
  readonly host: string;
}

let pendingOffer: MainServerOffer | null = null;
const hostListeners = new Set<() => void>();

function publishMainServerOffer(next: MainServerOffer | null): void {
  pendingOffer = next;
  for (const listener of hostListeners) {
    listener();
  }
}

function readMainServerOffer(): MainServerOffer | null {
  return pendingOffer;
}

function subscribeMainServerOfferHost(listener: () => void): () => void {
  hostListeners.add(listener);
  return () => {
    if (!hostListeners.delete(listener) || hostListeners.size > 0) return;
    pendingOffer = null;
  };
}

function clearMainServerOffer(): void {
  publishMainServerOffer(null);
}

export function resetMainServerOfferForTests(): void {
  hostListeners.clear();
  pendingOffer = null;
}

/**
 * Offers to switch Sail Desktop into remote-only mode with a newly added remote server as its
 * main server. Returns true when a root-mounted prompt was queued and false when ineligible.
 */
export function useOfferMainServer(): (server: MainServerOffer) => boolean {
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  return (server: MainServerOffer) => {
    if (
      hostListeners.size === 0 ||
      window.desktopBridge?.setLocalEnvironmentEnabled === undefined ||
      isLocalEnvironmentDisabled() ||
      server.environmentId === primaryEnvironmentId
    ) {
      return false;
    }
    publishMainServerOffer(server);
    return true;
  };
}

export function MainServerDialog({
  server,
  setLocalEnvironmentEnabled,
  onClose,
}: {
  readonly server: MainServerOffer;
  readonly setLocalEnvironmentEnabled: (enabled: boolean) => Promise<void>;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const environment = useEnvironment(server.environmentId);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isControlPlane =
    environment?.serverConfig != null &&
    !environmentSupportsLocalSessions(environment.serverConfig);
  const canRestart =
    environment?.connection.phase === "connected" &&
    environment.serverConfig != null &&
    !isDesktopLocalConnectionTarget(environment.entry.target);

  const restart = async () => {
    if (!canRestart || restarting) return;
    setRestarting(true);
    setError(null);
    try {
      await pinClientPreferencesServer(server.environmentId);
      await setLocalEnvironmentEnabled(false);
    } catch (cause) {
      setError(thrownErrorMessage(cause, m) ?? gt("Couldn't change this setting."));
      setRestarting(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && !restarting && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{gt("Backend added")}</AlertDialogTitle>
          <AlertDialogDescription>
            {isControlPlane
              ? gt(
                  "Sail will restart with Local environment turned off. Local agents and terminals will stop. {host} manages Boats and synced settings; coding sessions will run only on Boat machines. You can turn Local environment back on in Settings \u2192 Environments.",
                  { host: server.host },
                )
              : gt(
                  "Sail will restart with Local environment turned off. Local agents and terminals will stop. You can turn Local environment back on in Settings \u2192 Environments.",
                )}
          </AlertDialogDescription>
          {!canRestart ? (
            <p role="status" className="text-sm text-muted-foreground">
              {gt("Wait for the server to connect before restarting.")}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose disabled={restarting} render={<Button variant="outline" />}>
            {gt("Keep local environment")}
          </AlertDialogClose>
          <Button
            size="sm-multiline"
            variant="destructive"
            disabled={!canRestart || restarting}
            onClick={() => void restart()}
          >
            {restarting
              ? gt("Restarting\u2026")
              : gt("Use {host} as your main server", { host: server.host })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Mounted once at the app root so the prompt survives modal closes and route transitions. */
export function MainServerOfferHost() {
  const offer = useSyncExternalStore(
    subscribeMainServerOfferHost,
    readMainServerOffer,
    readMainServerOffer,
  );
  const setLocalEnvironmentEnabled = window.desktopBridge?.setLocalEnvironmentEnabled;
  return offer && setLocalEnvironmentEnabled ? (
    <MainServerDialog
      key={offer.environmentId}
      server={offer}
      setLocalEnvironmentEnabled={setLocalEnvironmentEnabled}
      onClose={clearMainServerOffer}
    />
  ) : null;
}

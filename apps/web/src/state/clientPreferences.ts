import type { EnvironmentId } from "@t3tools/contracts";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import type { ClientPreferencesWrite } from "@t3tools/contracts/settings";
import { selectClientPreferencesServer } from "@t3tools/client-runtime/state/shared-settings";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";

import { environmentCatalog } from "../connection/catalog";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { isElectron } from "../env";
import { isHostedStaticApp } from "../hostedPairing";
import {
  getClientSettings,
  getClientSettingsHydratedSnapshot,
  observeClientPreferences,
  persistClientSettingsUpdate,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "../hooks/useSettings";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";
import { environmentSession, sessionHasScope } from "./session";

const preferenceBindingAtom = Atom.make<{
  readonly hydrated: boolean;
  readonly pinned: EnvironmentId | null | undefined;
}>({ hydrated: false, pinned: undefined }).pipe(Atom.keepAlive);

const savedPreferenceServersAtom = Atom.make((get) =>
  Array.from(get(environmentCatalog.catalogValueAtom).entries).flatMap(([environmentId, entry]) =>
    isDesktopLocalConnectionTarget(entry.target)
      ? []
      : [{ environmentId, label: entry.target.label }],
  ),
);

const canChooseMainServer = () => (isElectron ? isLocalEnvironmentDisabled() : isHostedStaticApp());

export const clientPreferencesServerChoicesAtom = Atom.make((get) =>
  canChooseMainServer() ? get(savedPreferenceServersAtom) : [],
);

const observedPreferencePinAtom = Atom.make((get) => {
  const { pinned } = get(preferenceBindingAtom);
  const observed = Option.getOrUndefined(get.self<EnvironmentId | undefined>());
  if (pinned == null) return undefined;
  return observed === pinned ||
    get(savedPreferenceServersAtom).some(({ environmentId }) => environmentId === pinned)
    ? pinned
    : undefined;
}).pipe(Atom.keepAlive);

export const clientPreferencesServerAtom = Atom.make((get) => {
  if (isElectron && !canChooseMainServer()) return null;
  const binding = get(preferenceBindingAtom);
  if (!binding.hydrated) return undefined;
  const catalog = get(environmentCatalog.catalogValueAtom);
  const primary = get(primaryEnvironmentIdAtom);
  if (!isElectron && !isHostedStaticApp() && primary === null) return undefined;

  return selectClientPreferencesServer({
    ready: catalog.isReady,
    primary,
    pinned: binding.pinned,
    pinWasRegistered: get(observedPreferencePinAtom) !== undefined,
    inferSingle: isHostedStaticApp() && !isElectron,
    candidates: get(savedPreferenceServersAtom).map(({ environmentId }) => environmentId),
  });
});

const preferencesSourceAtom = Atom.make((get) => {
  const environmentId = get(clientPreferencesServerAtom);
  if (environmentId === undefined) return undefined;
  if (environmentId === null) {
    return {
      source: { environmentId, snapshot: undefined, access: "unknown" },
      connected: false,
      sessionGeneration: 0,
      pinServer: canChooseMainServer(),
      removedMainServerId: canChooseMainServer() ? get(observedPreferencePinAtom) : undefined,
    } as const;
  }
  const session = get(environmentSession.sessionStateAtom(environmentId));
  const snapshot = get(serverEnvironment.settingsValueAtom(environmentId))?.clientPreferences;
  const connection = AsyncResult.getOrElse(
    get(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const connected = connection.phase === "connected";
  return {
    source: {
      environmentId,
      snapshot,
      access: sessionHasScope(session, AuthSettingsWriteScope)
        ? "writable"
        : session._tag === "Success" && session.value.authenticated
          ? "read-only"
          : "unknown",
    },
    connected,
    sessionGeneration: get(environmentCatalog.sessionGenerationAtom(environmentId)),
    pinServer: canChooseMainServer(),
    removedMainServerId: undefined,
  } as const;
});

async function writeClientPreferences(environmentId: EnvironmentId, write: ClientPreferencesWrite) {
  const input = { patch: { writeClientPreferences: write } };
  const command = serverEnvironment.updateSettings;
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId, input },
    {
      reportFailure: false,
      signal: AbortSignal.timeout(15_000),
    },
  );
  return result._tag === "Success" ? result.value.clientPreferences : undefined;
}

export async function pinClientPreferencesServer(environmentId: EnvironmentId): Promise<void> {
  await persistClientSettingsUpdate((settings) => ({
    ...settings,
    clientPreferencesMainServerId: environmentId,
  }));
}

export function startClientPreferencesSync(): void {
  const updateBinding = () => {
    const pinned = getClientSettings().clientPreferencesMainServerId;
    const hydrated = getClientSettingsHydratedSnapshot();
    const current = appAtomRegistry.get(preferenceBindingAtom);
    if (current.pinned !== pinned || current.hydrated !== hydrated) {
      appAtomRegistry.set(preferenceBindingAtom, { pinned, hydrated });
    }
  };
  subscribeClientSettings(updateBinding);
  subscribeClientSettingsHydration(updateBinding);
  updateBinding();
  appAtomRegistry.subscribe(
    preferencesSourceAtom,
    (value) =>
      observeClientPreferences(
        value === undefined ? undefined : { ...value, write: writeClientPreferences },
      ),
    { immediate: true },
  );
}

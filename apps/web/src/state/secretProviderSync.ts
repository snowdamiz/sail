import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";
import { environmentSession, sessionHasScope } from "./session";
import {
  clearPortableSyncAttemptOnFailure,
  createPortableSyncTracker,
  markPortableSyncAttempted,
  planPortableSecretSync,
  summarizePortableEnvironment,
  type PortableEnvironmentSummary,
  type PortableSyncAction,
} from "./secretProviderSync.logic";

const manualEditRevisionsAtom = Atom.make<Readonly<Record<string, number>>>({}).pipe(
  Atom.keepAlive,
);

/**
 * Signals that a portable 1Password provider on `environmentId` was explicitly saved (including
 * a service account token rotation whose redacted settings view looks unchanged).
 */
export function notifyPortableSecretProviderEdited(environmentId: EnvironmentId): void {
  const current = appAtomRegistry.get(manualEditRevisionsAtom);
  appAtomRegistry.set(manualEditRevisionsAtom, {
    ...current,
    [environmentId]: (current[environmentId] ?? 0) + 1,
  });
}

const eligiblePortableEnvironmentsAtom = Atom.make(
  (get): ReadonlyArray<PortableEnvironmentSummary> => {
    const catalog = get(environmentCatalog.catalogValueAtom);
    const revisions = get(manualEditRevisionsAtom);
    const summaries: Array<PortableEnvironmentSummary> = [];

    for (const [environmentId] of catalog.entries) {
      const connection = AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      );
      if (connection.phase !== "connected") continue;

      const config = get(serverEnvironment.configValueAtom(environmentId));
      if (config?.portableSecretProviderSync !== true) continue;

      const session = get(environmentSession.sessionStateAtom(environmentId));
      if (
        !sessionHasScope(session, AuthProvidersManageScope) ||
        !sessionHasScope(session, AuthSettingsWriteScope)
      ) {
        continue;
      }

      const settings = get(serverEnvironment.settingsValueAtom(environmentId)) ?? config.settings;
      summaries.push(
        summarizePortableEnvironment(environmentId, settings, revisions[environmentId] ?? 0),
      );
    }

    return summaries;
  },
).pipe(Atom.withLabel("web-portable-secret-sync-environments"));

export function startSecretProviderSync(): void {
  const tracker = createPortableSyncTracker();
  let queue: Promise<void> = Promise.resolve();

  const executeAction = async (action: PortableSyncAction): Promise<void> => {
    const exported = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.exportPortableProviders,
      { environmentId: action.sourceId, input: {} },
      {
        reportFailure: false,
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (exported._tag !== "Success") {
      clearPortableSyncAttemptOnFailure(tracker, action);
      return;
    }

    const payload = exported.value;
    if (
      payload.providers.length === 0 &&
      payload.projectCredentials.length === 0 &&
      Object.keys(payload.repoCredentials).length === 0 &&
      action.removeProviderIds.length === 0
    ) {
      return;
    }

    const imported = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.importPortableProviders,
      {
        environmentId: action.targetId,
        input: {
          providers: payload.providers,
          projectCredentials: payload.projectCredentials,
          repoCredentials: payload.repoCredentials,
          ...(action.removeProviderIds.length > 0
            ? { removeProviderIds: action.removeProviderIds }
            : {}),
        },
      },
      {
        reportFailure: false,
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (imported._tag !== "Success") {
      clearPortableSyncAttemptOnFailure(tracker, action);
    }
  };

  appAtomRegistry.subscribe(
    eligiblePortableEnvironmentsAtom,
    (summaries) => {
      const actions = planPortableSecretSync(summaries, tracker);
      if (actions.length === 0) return;
      for (const action of actions) {
        markPortableSyncAttempted(tracker, action);
        queue = queue.then(() => executeAction(action)).catch(() => {});
      }
    },
    { immediate: true },
  );
}

import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";
import { environmentSession, sessionHasScope } from "./session";
import {
  clearProviderAuthSyncAttemptOnFailure,
  createProviderAuthSyncTracker,
  markProviderAuthSyncAttempted,
  planProviderAuthSync,
  summarizeProviderAuthEnvironment,
  type ProviderAuthEnvironmentSummary,
  type ProviderAuthSyncAction,
} from "./providerAuthSync.logic";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

const manualEditRevisionsAtom = Atom.make<Readonly<Record<string, number>>>({}).pipe(
  Atom.keepAlive,
);

/**
 * Signals that a provider instance's credentials or settings on `environmentId` were explicitly
 * saved (including API key rotations whose redacted settings view looks unchanged).
 */
export function notifyProviderAuthEdited(environmentId: EnvironmentId): void {
  const current = appAtomRegistry.get(manualEditRevisionsAtom);
  appAtomRegistry.set(manualEditRevisionsAtom, {
    ...current,
    [environmentId]: (current[environmentId] ?? 0) + 1,
  });
}

const eligibleProviderAuthEnvironmentsAtom = Atom.make(
  (get): ReadonlyArray<ProviderAuthEnvironmentSummary> => {
    const catalog = get(environmentCatalog.catalogValueAtom);
    const revisions = get(manualEditRevisionsAtom);
    const summaries: Array<ProviderAuthEnvironmentSummary> = [];

    for (const [environmentId] of catalog.entries) {
      const connection = AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      );
      if (connection.phase !== "connected") continue;

      const config = get(serverEnvironment.configValueAtom(environmentId));
      if (config?.portableProviderAuthSync !== true) continue;

      const session = get(environmentSession.sessionStateAtom(environmentId));
      if (
        !sessionHasScope(session, AuthProvidersManageScope) ||
        !sessionHasScope(session, AuthSettingsWriteScope)
      ) {
        continue;
      }

      const settings = get(serverEnvironment.settingsValueAtom(environmentId)) ?? config.settings;
      const providers = get(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS;
      summaries.push(
        summarizeProviderAuthEnvironment(
          environmentId,
          settings,
          providers,
          revisions[environmentId] ?? 0,
        ),
      );
    }

    return summaries;
  },
).pipe(Atom.withLabel("web-provider-auth-sync-environments"));

export function startProviderAuthSync(): void {
  const tracker = createProviderAuthSyncTracker();
  const lastPushedFingerprintByPair = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();

  const executeAction = async (action: ProviderAuthSyncAction): Promise<void> => {
    const exported = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.exportProviderAuthBundle,
      { environmentId: action.sourceId, input: {} },
      {
        reportFailure: false,
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (exported._tag !== "Success") {
      clearProviderAuthSyncAttemptOnFailure(tracker, action);
      return;
    }

    const { bundle, fingerprint } = exported.value;
    if (fingerprint.length === 0) {
      return;
    }

    const pair = `${action.sourceId}\0${action.targetId}`;
    if (lastPushedFingerprintByPair.get(pair) === fingerprint) {
      return;
    }

    const imported = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.importProviderAuthBundle,
      {
        environmentId: action.targetId,
        input: {
          bundle,
          ...(action.preferExistingNewer ? { preferExistingNewer: true } : {}),
        },
      },
      {
        reportFailure: false,
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (imported._tag !== "Success") {
      clearProviderAuthSyncAttemptOnFailure(tracker, action);
      return;
    }

    lastPushedFingerprintByPair.set(pair, fingerprint);
  };

  appAtomRegistry.subscribe(
    eligibleProviderAuthEnvironmentsAtom,
    (summaries) => {
      const connectedIds = new Set(summaries.map((summary) => summary.environmentId));
      for (const pair of Array.from(lastPushedFingerprintByPair.keys())) {
        const separator = pair.indexOf("\0");
        const sourceId = pair.slice(0, separator) as EnvironmentId;
        const targetId = pair.slice(separator + 1) as EnvironmentId;
        if (!connectedIds.has(sourceId) || !connectedIds.has(targetId)) {
          lastPushedFingerprintByPair.delete(pair);
        }
      }

      const actions = planProviderAuthSync(summaries, tracker);
      if (actions.length === 0) return;
      for (const action of actions) {
        markProviderAuthSyncAttempted(tracker, action);
        queue = queue.then(() => executeAction(action)).catch(() => {});
      }
    },
    { immediate: true },
  );
}

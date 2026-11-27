import {
  isSecretReference,
  type EnvironmentId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

const HOST_ONLY_CONFIG_FIELDS = new Set([
  "binaryPath",
  "homePath",
  "shadowHomePath",
  "commandPath",
]);

export interface ProviderAuthEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly authenticatedEntries: ReadonlyMap<string, string>;
  readonly configuredEntries: ReadonlyMap<string, string>;
  readonly authStateSignature: string;
  readonly localSignature: string;
  readonly manualRevision: number;
  readonly hasSyncableData: boolean;
}

export interface ProviderAuthSyncAction {
  readonly sourceId: EnvironmentId;
  readonly targetId: EnvironmentId;
  readonly preferExistingNewer: boolean;
  readonly sourceLocalSignature: string;
  readonly sourceAuthStateSignature: string;
}

export interface ProviderAuthSyncTracker {
  readonly previousByEnv: Map<EnvironmentId, ProviderAuthEnvironmentSummary>;
  readonly pushedSourceSigByPair: Map<string, string>;
  readonly recentImportTargets: Map<EnvironmentId, string>;
}

export function createProviderAuthSyncTracker(): ProviderAuthSyncTracker {
  return {
    previousByEnv: new Map(),
    pushedSourceSigByPair: new Map(),
    recentImportTargets: new Map(),
  };
}

function pairKey(sourceId: EnvironmentId, targetId: EnvironmentId): string {
  return `${sourceId}\0${targetId}`;
}

function serializePortableConfig(config: unknown): ReadonlyArray<readonly [string, unknown]> {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, value] of Object.entries(config).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (HOST_ONLY_CONFIG_FIELDS.has(key) || value === undefined) continue;
    entries.push([key, value]);
  }
  return entries;
}

export function summarizeProviderAuthEnvironment(
  environmentId: EnvironmentId,
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  manualRevision: number,
): ProviderAuthEnvironmentSummary {
  const authenticatedEntries = new Map<string, string>();
  const authenticatedPairs: Array<readonly [string, string]> = [];

  for (const provider of [...providers].toSorted((left, right) =>
    left.instanceId.localeCompare(right.instanceId),
  )) {
    if (provider.auth.status !== "authenticated") continue;
    const serialized = JSON.stringify({
      driver: provider.driver,
      type: provider.auth.type ?? null,
      label: provider.auth.label ?? null,
    });
    authenticatedEntries.set(provider.instanceId, serialized);
    authenticatedPairs.push([provider.instanceId, serialized]);
  }

  const configuredEntries = new Map<string, string>();
  const configuredPairs: Array<readonly [string, string]> = [];

  for (const [instanceId, instance] of Object.entries(settings.providerInstances).toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (
      instance.driver === "acpRegistry" &&
      instance.config !== null &&
      typeof instance.config === "object" &&
      !Array.isArray(instance.config) &&
      (instance.config as { readonly source?: unknown }).source === "local"
    ) {
      continue;
    }
    const portableConfig = serializePortableConfig(instance.config);
    const environment = (instance.environment ?? [])
      .filter(
        (variable) =>
          isSecretReference(variable.value) ||
          variable.valueRedacted === true ||
          (typeof variable.value === "string" && variable.value.length > 0),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((variable) => ({
        name: variable.name,
        sensitive: variable.sensitive,
        hasValue: true,
        reference: isSecretReference(variable.value) ? variable.value : null,
      }));
    if (
      portableConfig.length === 0 &&
      environment.length === 0 &&
      instance.displayName === undefined &&
      instance.accentColor === undefined
    ) {
      continue;
    }
    const serialized = JSON.stringify({
      driver: instance.driver,
      displayName: instance.displayName ?? null,
      accentColor: instance.accentColor ?? null,
      enabled: instance.enabled ?? null,
      portableConfig,
      environment,
    });
    configuredEntries.set(instanceId, serialized);
    configuredPairs.push([instanceId, serialized]);
  }

  const authStateSignature = JSON.stringify({
    authenticated: authenticatedPairs,
    configured: configuredPairs,
  });
  const localSignature = JSON.stringify({
    authStateSignature,
    manualRevision,
  });

  return {
    environmentId,
    authenticatedEntries,
    configuredEntries,
    authStateSignature,
    localSignature,
    manualRevision,
    hasSyncableData: authenticatedPairs.length > 0 || configuredPairs.length > 0,
  };
}

function hasEntriesMissingInTarget(
  source: ProviderAuthEnvironmentSummary,
  target: ProviderAuthEnvironmentSummary,
): boolean {
  for (const [instanceId] of source.authenticatedEntries) {
    if (!target.authenticatedEntries.has(instanceId)) {
      return true;
    }
  }
  for (const [instanceId, value] of source.configuredEntries) {
    if (target.configuredEntries.get(instanceId) !== value) {
      return true;
    }
  }
  return false;
}

/**
 * Computes provider auth sync transfers between connected non-Boat environments without echoing
 * imports back to their origin.
 */
export function planProviderAuthSync(
  summaries: ReadonlyArray<ProviderAuthEnvironmentSummary>,
  tracker: ProviderAuthSyncTracker,
): ReadonlyArray<ProviderAuthSyncAction> {
  const connectedIds = new Set(summaries.map((summary) => summary.environmentId));

  // Clear state for disconnected environments so reconnecting reconciles cleanly.
  for (const id of Array.from(tracker.previousByEnv.keys())) {
    if (!connectedIds.has(id)) {
      tracker.previousByEnv.delete(id);
      tracker.recentImportTargets.delete(id);
    }
  }
  for (const key of Array.from(tracker.pushedSourceSigByPair.keys())) {
    const separator = key.indexOf("\0");
    const sourceId = key.slice(0, separator) as EnvironmentId;
    const targetId = key.slice(separator + 1) as EnvironmentId;
    if (!connectedIds.has(sourceId) || !connectedIds.has(targetId)) {
      tracker.pushedSourceSigByPair.delete(key);
    }
  }

  if (summaries.length < 2) {
    for (const summary of summaries) {
      tracker.previousByEnv.set(summary.environmentId, summary);
    }
    return [];
  }

  const actions: Array<ProviderAuthSyncAction> = [];
  const plannedPairs = new Set<string>();

  // Phase 1: Propagate live logins, key rotations, and provider settings edits.
  for (const source of summaries) {
    const previous = tracker.previousByEnv.get(source.environmentId);
    if (previous === undefined || previous.localSignature === source.localSignature) {
      continue;
    }

    const manualRevisionBumped = source.manualRevision !== previous.manualRevision;

    // Suppress echoes caused by an import we just triggered on this environment.
    const recentImportOriginSig = tracker.recentImportTargets.get(source.environmentId);
    if (recentImportOriginSig !== undefined && !manualRevisionBumped) {
      tracker.recentImportTargets.delete(source.environmentId);
      if (recentImportOriginSig === source.authStateSignature) {
        continue;
      }
    }

    if (!source.hasSyncableData) {
      continue;
    }

    for (const target of summaries) {
      if (target.environmentId === source.environmentId) continue;
      if (!manualRevisionBumped && target.authStateSignature === source.authStateSignature) {
        continue;
      }
      const key = pairKey(source.environmentId, target.environmentId);
      if (tracker.pushedSourceSigByPair.get(key) === source.localSignature) {
        continue;
      }
      plannedPairs.add(key);
      actions.push({
        sourceId: source.environmentId,
        targetId: target.environmentId,
        preferExistingNewer: false,
        sourceLocalSignature: source.localSignature,
        sourceAuthStateSignature: source.authStateSignature,
      });
    }
  }

  // Phase 2: Initial connect / reconnect reconciliation (additive, preserving strictly newer tokens).
  for (const source of summaries) {
    if (!source.hasSyncableData) continue;
    for (const target of summaries) {
      if (target.environmentId === source.environmentId) continue;
      const key = pairKey(source.environmentId, target.environmentId);
      if (plannedPairs.has(key)) continue;
      if (tracker.pushedSourceSigByPair.get(key) === source.localSignature) continue;
      if (!hasEntriesMissingInTarget(source, target)) continue;
      plannedPairs.add(key);
      actions.push({
        sourceId: source.environmentId,
        targetId: target.environmentId,
        preferExistingNewer: true,
        sourceLocalSignature: source.localSignature,
        sourceAuthStateSignature: source.authStateSignature,
      });
    }
  }

  for (const summary of summaries) {
    tracker.previousByEnv.set(summary.environmentId, summary);
  }

  return actions;
}

export function markProviderAuthSyncAttempted(
  tracker: ProviderAuthSyncTracker,
  action: ProviderAuthSyncAction,
): void {
  tracker.pushedSourceSigByPair.set(
    pairKey(action.sourceId, action.targetId),
    action.sourceLocalSignature,
  );
  tracker.recentImportTargets.set(action.targetId, action.sourceAuthStateSignature);
}

export function clearProviderAuthSyncAttemptOnFailure(
  tracker: ProviderAuthSyncTracker,
  action: ProviderAuthSyncAction,
): void {
  const key = pairKey(action.sourceId, action.targetId);
  if (tracker.pushedSourceSigByPair.get(key) === action.sourceLocalSignature) {
    tracker.pushedSourceSigByPair.delete(key);
  }
  if (tracker.recentImportTargets.get(action.targetId) === action.sourceAuthStateSignature) {
    tracker.recentImportTargets.delete(action.targetId);
  }
}

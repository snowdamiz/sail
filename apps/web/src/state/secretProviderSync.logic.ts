import type {
  EnvironmentId,
  ProjectCredentialBookmark,
  SecretProviderId,
  ServerSettings,
} from "@t3tools/contracts";

import { classifySecretProvider } from "../components/settings/SecretProviderDialog.logic";

export interface PortableEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly portableProviderIds: ReadonlyArray<SecretProviderId>;
  readonly portableEntries: ReadonlyMap<string, string>;
  readonly portableSignature: string;
  readonly localSignature: string;
  readonly hasPortableData: boolean;
}

export interface PortableSyncAction {
  readonly sourceId: EnvironmentId;
  readonly targetId: EnvironmentId;
  readonly removeProviderIds: ReadonlyArray<SecretProviderId>;
  readonly sourceLocalSignature: string;
  readonly sourcePortableSignature: string;
}

export interface PortableSyncTracker {
  readonly previousByEnv: Map<EnvironmentId, PortableEnvironmentSummary>;
  readonly pushedSourceSigByPair: Map<string, string>;
  readonly recentImportTargets: Map<EnvironmentId, string>;
}

export function createPortableSyncTracker(): PortableSyncTracker {
  return {
    previousByEnv: new Map(),
    pushedSourceSigByPair: new Map(),
    recentImportTargets: new Map(),
  };
}

function pairKey(sourceId: EnvironmentId, targetId: EnvironmentId): string {
  return `${sourceId}\0${targetId}`;
}

function serializeBookmark(bookmark: ProjectCredentialBookmark): string {
  return JSON.stringify({
    label: bookmark.label,
    provider: bookmark.reference.provider,
    reference: bookmark.reference.reference,
    envVar: bookmark.envVar ?? null,
    autoGrant: bookmark.autoGrant !== false,
  });
}

export function summarizePortableEnvironment(
  environmentId: EnvironmentId,
  settings: ServerSettings,
  manualRevision: number,
): PortableEnvironmentSummary {
  const portableEntries = new Map<string, string>();
  const portableProviders: Array<readonly [SecretProviderId, string]> = [];
  const portableIdSet = new Set<string>();

  const sortedProviders = Object.entries(settings.secretProviders).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [rawId, config] of sortedProviders) {
    const classified = classifySecretProvider(config);
    if (classified.kind !== "one_password" || classified.mode !== "service_account") {
      continue;
    }
    const id = rawId as SecretProviderId;
    portableIdSet.add(id);
    portableProviders.push([id, config.label]);
    portableEntries.set(`provider:${id}`, config.label);
  }

  const repoEntries: Array<readonly [string, ReadonlyArray<readonly [string, string]>]> = [];
  for (const [repoKey, bookmarks] of Object.entries(settings.repoCredentialBookmarks).toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const filtered = Object.entries(bookmarks)
      .filter(([, bookmark]) => portableIdSet.has(bookmark.reference.provider))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([bookmarkId, bookmark]) => {
        const serialized = serializeBookmark(bookmark);
        portableEntries.set(`repo:${repoKey}\0${bookmarkId}`, serialized);
        return [bookmarkId, serialized] as const;
      });
    if (filtered.length > 0) {
      repoEntries.push([repoKey, filtered]);
    }
  }

  const projectEntries: Array<readonly [string, ReadonlyArray<readonly [string, string]>]> = [];
  for (const [projectId, bookmarks] of Object.entries(settings.projectCredentialBookmarks).toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const filtered = Object.entries(bookmarks)
      .filter(([, bookmark]) => portableIdSet.has(bookmark.reference.provider))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([bookmarkId, bookmark]) => [bookmarkId, serializeBookmark(bookmark)] as const);
    if (filtered.length > 0) {
      projectEntries.push([projectId, filtered]);
    }
  }

  const portableSignature = JSON.stringify({
    providers: portableProviders,
    repo: repoEntries,
  });
  const localSignature = JSON.stringify({
    portableSignature,
    projects: projectEntries,
    manualRevision,
  });

  return {
    environmentId,
    portableProviderIds: portableProviders.map(([id]) => id),
    portableEntries,
    portableSignature,
    localSignature,
    hasPortableData: portableProviders.length > 0,
  };
}

function hasEntriesMissingInTarget(
  source: PortableEnvironmentSummary,
  target: PortableEnvironmentSummary,
): boolean {
  for (const [key, value] of source.portableEntries) {
    if (target.portableEntries.get(key) !== value) {
      return true;
    }
  }
  return false;
}

/**
 * Computes the next set of portable 1Password provider/credential sync transfers between
 * connected non-Boat environments without echoing imports back to their origin.
 */
export function planPortableSecretSync(
  summaries: ReadonlyArray<PortableEnvironmentSummary>,
  tracker: PortableSyncTracker,
): ReadonlyArray<PortableSyncAction> {
  const connectedIds = new Set(summaries.map((summary) => summary.environmentId));

  // Drop state for environments that disconnected so reconnecting reconciles cleanly.
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

  const actions: Array<PortableSyncAction> = [];
  const plannedPairs = new Set<string>();
  const deletingPairs = new Set<string>();

  // Phase 1: Propagate live edits (additions, renames, token rotations, removals, bookmarks).
  for (const source of summaries) {
    const previous = tracker.previousByEnv.get(source.environmentId);
    if (previous === undefined || previous.localSignature === source.localSignature) {
      continue;
    }
    // If this environment just settled from an import we triggered, do not echo it back.
    const expectedImportSig = tracker.recentImportTargets.get(source.environmentId);
    if (expectedImportSig !== undefined) {
      tracker.recentImportTargets.delete(source.environmentId);
      if (expectedImportSig === source.portableSignature) {
        continue;
      }
    }

    const removedProviderIds = previous.portableProviderIds.filter(
      (id) => !source.portableProviderIds.includes(id),
    );
    if (!source.hasPortableData && removedProviderIds.length === 0) {
      continue;
    }

    for (const target of summaries) {
      if (target.environmentId === source.environmentId) continue;
      const key = pairKey(source.environmentId, target.environmentId);
      if (tracker.pushedSourceSigByPair.get(key) === source.localSignature) continue;
      plannedPairs.add(key);
      if (removedProviderIds.length > 0) {
        deletingPairs.add(pairKey(target.environmentId, source.environmentId));
      }
      actions.push({
        sourceId: source.environmentId,
        targetId: target.environmentId,
        removeProviderIds: removedProviderIds,
        sourceLocalSignature: source.localSignature,
        sourcePortableSignature: source.portableSignature,
      });
    }
  }

  // Phase 2: Initial / reconnect reconciliation for any pair where one side has portable
  // providers or repo credentials missing on the other side.
  for (const source of summaries) {
    if (!source.hasPortableData) continue;
    for (const target of summaries) {
      if (target.environmentId === source.environmentId) continue;
      const key = pairKey(source.environmentId, target.environmentId);
      if (plannedPairs.has(key) || deletingPairs.has(key)) continue;
      if (tracker.pushedSourceSigByPair.get(key) === source.localSignature) continue;
      if (!hasEntriesMissingInTarget(source, target)) continue;
      plannedPairs.add(key);
      actions.push({
        sourceId: source.environmentId,
        targetId: target.environmentId,
        removeProviderIds: [],
        sourceLocalSignature: source.localSignature,
        sourcePortableSignature: source.portableSignature,
      });
    }
  }

  for (const summary of summaries) {
    tracker.previousByEnv.set(summary.environmentId, summary);
  }

  return actions;
}

export function markPortableSyncAttempted(
  tracker: PortableSyncTracker,
  action: PortableSyncAction,
): void {
  tracker.pushedSourceSigByPair.set(
    pairKey(action.sourceId, action.targetId),
    action.sourceLocalSignature,
  );
  tracker.recentImportTargets.set(action.targetId, action.sourcePortableSignature);
}

export function clearPortableSyncAttemptOnFailure(
  tracker: PortableSyncTracker,
  action: PortableSyncAction,
): void {
  const key = pairKey(action.sourceId, action.targetId);
  if (tracker.pushedSourceSigByPair.get(key) === action.sourceLocalSignature) {
    tracker.pushedSourceSigByPair.delete(key);
  }
  if (tracker.recentImportTargets.get(action.targetId) === action.sourcePortableSignature) {
    tracker.recentImportTargets.delete(action.targetId);
  }
}

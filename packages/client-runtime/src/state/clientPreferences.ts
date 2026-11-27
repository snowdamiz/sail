import type { EnvironmentId } from "@t3tools/contracts";
import {
  DEFAULT_CLIENT_SETTINGS,
  SHARED_CLIENT_PREFERENCE_KEYS,
  type ClientPreferencesCache,
  type ClientPreferencesSnapshot,
  type ClientSettings,
} from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";
import * as Struct from "effect/Struct";

const pickSharedPreferences = (settings: ClientSettings) =>
  Struct.pick(settings, SHARED_CLIENT_PREFERENCE_KEYS);
const defaultPreferences = pickSharedPreferences(DEFAULT_CLIENT_SETTINGS);

export interface ClientPreferencesSource {
  readonly environmentId: EnvironmentId | null;
  readonly snapshot: ClientPreferencesSnapshot | undefined;
  readonly access: "writable" | "read-only" | "unknown";
}

export function selectClientPreferencesServer(input: {
  readonly pinned: EnvironmentId | null | undefined;
  readonly pinWasRegistered: boolean;
  readonly primary: EnvironmentId | null;
  readonly candidates: ReadonlyArray<EnvironmentId>;
  readonly ready: boolean;
  readonly inferSingle: boolean;
}): EnvironmentId | null | undefined {
  if (!input.ready) return undefined;
  if (input.pinned === null) return null;
  if (input.pinned !== undefined) {
    if (input.candidates.includes(input.pinned)) return input.pinned;
    return input.pinWasRegistered ? null : undefined;
  }
  if (input.primary !== null) return input.primary;
  return input.inferSingle && input.candidates.length === 1 ? (input.candidates[0] ?? null) : null;
}

function withCache(settings: ClientSettings, cache: ClientPreferencesCache): ClientSettings {
  return restoreClientPreferences({ ...settings, clientPreferencesCache: cache });
}

export function restoreClientPreferences(settings: ClientSettings): ClientSettings {
  const cache = settings.clientPreferencesCache;
  if (cache === undefined) return settings;
  return {
    ...settings,
    ...defaultPreferences,
    ...cache.snapshot.values,
    ...cache.overrides,
    ...cache.sending?.changes,
    ...cache.pending,
  };
}

export function reconcileClientPreferences(
  settings: ClientSettings,
  source: ClientPreferencesSource,
): ClientSettings {
  const cache = settings.clientPreferencesCache;
  if (settings.syncClientPreferences === false || cache?.environmentId !== source.environmentId) {
    if (cache !== undefined) {
      const { clientPreferencesCache: _cache, ...local } = restoreClientPreferences(settings);
      settings = local;
    }
  }
  if (
    settings.syncClientPreferences === false ||
    source.environmentId === null ||
    (source.snapshot === undefined && settings.clientPreferencesCache === undefined)
  ) {
    return settings;
  }
  let next: ClientPreferencesCache = settings.clientPreferencesCache ?? {
    environmentId: source.environmentId,
    snapshot:
      source.snapshot === undefined || source.snapshot.revision === 0
        ? { revision: 0, values: pickSharedPreferences(settings) }
        : source.snapshot,
    pending: {},
    overrides: {},
  };
  if (
    source.snapshot !== undefined &&
    source.snapshot.revision > 0 &&
    source.snapshot.revision >= next.snapshot.revision
  ) {
    next = { ...next, snapshot: source.snapshot };
  }
  if (source.access === "read-only" && (next.sending || Object.keys(next.pending).length > 0)) {
    const { sending, ...rest } = next;
    next = {
      ...rest,
      overrides: { ...next.overrides, ...sending?.changes, ...next.pending },
      pending: {},
    };
  }
  return Equal.equals(next, settings.clientPreferencesCache) ? settings : withCache(settings, next);
}

export function editClientPreferences(
  previous: ClientSettings,
  next: ClientSettings,
  source: ClientPreferencesSource | undefined,
): ClientSettings {
  const existing = previous.clientPreferencesCache;
  if (
    existing === undefined &&
    (source?.environmentId == null || next.syncClientPreferences === false)
  ) {
    return next;
  }
  if (next.syncClientPreferences === false) {
    const { clientPreferencesCache: _cache, ...local } = next;
    return local;
  }
  const shared = pickSharedPreferences(next);
  const changes = Struct.pick(
    shared,
    SHARED_CLIENT_PREFERENCE_KEYS.filter((key) => !Equal.equals(previous[key], shared[key])),
  );
  if (Object.keys(changes).length === 0) return next;

  const environmentId = source === undefined ? existing?.environmentId : source.environmentId;
  if (environmentId == null) return next;
  const cache =
    existing?.environmentId === environmentId
      ? existing
      : {
          environmentId,
          snapshot: { revision: 0, values: pickSharedPreferences(previous) },
          pending: {},
          overrides: {},
        };

  if (source?.access === "read-only") {
    return withCache(next, { ...cache, overrides: { ...cache.overrides, ...changes } });
  }
  const overrides = Struct.omit(
    cache.overrides,
    SHARED_CLIENT_PREFERENCE_KEYS.filter((key) => Object.hasOwn(changes, key)),
  );
  // The omitted keys are selected at runtime. The remaining overrides are still sparse preferences.
  return withCache(next, { ...cache, overrides, pending: { ...cache.pending, ...changes } });
}

export function prepareClientPreferencesWrite(
  settings: ClientSettings,
  makeId: () => string,
): ClientSettings {
  const cache = settings.clientPreferencesCache;
  if (cache === undefined || cache.sending !== undefined) return settings;
  const initialize = cache.snapshot.revision === 0 ? cache.snapshot.values : undefined;
  if (
    Object.keys(cache.pending).length === 0 &&
    (initialize === undefined || Equal.equals(initialize, defaultPreferences))
  ) {
    return settings;
  }
  const writer = { id: cache.writer?.id ?? makeId(), sequence: (cache.writer?.sequence ?? 0) + 1 };
  return withCache(settings, {
    ...cache,
    writer,
    pending: {},
    sending: {
      writerId: writer.id,
      sequence: writer.sequence,
      changes: cache.pending,
      ...(initialize === undefined ? {} : { initialize }),
    },
  });
}

export function acknowledgeClientPreferences(
  settings: ClientSettings,
  environmentId: EnvironmentId,
  write: { readonly writerId: string; readonly sequence: number },
  snapshot: ClientPreferencesSnapshot,
): ClientSettings {
  const cache = settings.clientPreferencesCache;
  if (
    cache?.environmentId !== environmentId ||
    cache.sending?.writerId !== write.writerId ||
    cache.sending.sequence !== write.sequence
  )
    return settings;
  const { sending: _sending, ...rest } = cache;
  return withCache(settings, {
    ...rest,
    snapshot: snapshot.revision >= cache.snapshot.revision ? snapshot : cache.snapshot,
  });
}

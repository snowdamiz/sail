import {
  ConnectionTransientError,
  DpopConnectionCredential,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ConnectionCatalogDocument, Persistence } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

import * as ConnectionStorage from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectionStorage.makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

const fixedHandle = (database: IDBDatabase) => ({
  get: Effect.succeed(database),
  invalidate: () => Effect.void,
});

describe("ConnectionStorage.makeCatalogBackend", () => {
  it.effect("fails IndexedDB writes whose commit aborts", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event("abort"));
            });
          },
        }),
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => transaction } as unknown as IDBDatabase),
      );

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error.message).toContain("QuotaExceededError");
    }),
  );
});

describe("IndexedDB connection recovery", () => {
  it.effect("reopens after a forced close and finalizes the current connection", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const makeDatabase = () =>
        Object.assign(new EventTarget(), {
          close: vi.fn(),
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const request = Object.assign(new EventTarget(), {
                  result: undefined,
                  error: null,
                });
                queueMicrotask(() => request.dispatchEvent(new Event("success")));
                return request;
              },
            }),
          }),
        }) as unknown as IDBDatabase;
      const first = makeDatabase();
      const second = makeDatabase();
      const databases = [first, second];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const environmentId = EnvironmentId.make("env");
        const threadId = ThreadId.make("thread");
        expect(Option.isNone(yield* cache.loadThread(environmentId, threadId))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);

        first.dispatchEvent(new Event("close"));
        const recovered = yield* Effect.all(
          [cache.loadThread(environmentId, threadId), cache.loadThread(environmentId, threadId)],
          { concurrency: 2 },
        );
        expect(recovered.every(Option.isNone)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection closed without a close event", () => {
  it.effect("reopens and retries the failing operation once", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const closing = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => {
          // Chromium force-closed this connection; this tab never saw "close".
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      }) as unknown as IDBDatabase;
      const fresh = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const request = Object.assign(new EventTarget(), { result: undefined, error: null });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
          }),
        }),
      }) as unknown as IDBDatabase;
      const databases = [closing, fresh];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const loaded = yield* cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread"));
        expect(Option.isNone(loaded)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = ConnectionStorage.makeBrowserPullRequestRoutingPermissions(firstBrowser);
      const second = ConnectionStorage.makeBrowserPullRequestRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      const staleCatalog = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.void,
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(
        yield* ConnectionStorage.makeBrowserPullRequestRoutingPermissions(firstBrowser).get(entry),
      ).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }),
  );
});

describe("ConnectionStorage.makeCatalogCredentialStore", () => {
  it.effect(
    "replaces a renewed credential only when the stored credential still matches expectedPrevious",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const catalog = yield* ConnectionStorage.makeCatalogStore({
          read: Effect.succeed(null),
          write: (raw) => Effect.sync(() => void writes.push(raw)),
        });
        const store = ConnectionStorage.makeCatalogCredentialStore(catalog);

        const initial = new DpopConnectionCredential({
          accessToken: "token-v1",
          expiresAtEpochMs: 1_000,
        });
        const renewed = new DpopConnectionCredential({
          accessToken: "token-v2",
          expiresAtEpochMs: 2_000,
        });
        const reauthenticated = new DpopConnectionCredential({
          accessToken: "token-reauth",
          expiresAtEpochMs: 9_000,
        });
        const delayedRenewal = new DpopConnectionCredential({
          accessToken: "token-stale-renewal",
          expiresAtEpochMs: 3_000,
        });

        yield* store.put("direct-1", initial);
        expect(writes).toHaveLength(1);

        expect(yield* store.replaceRenewedCredential("direct-1", initial, renewed)).toBe(true);
        expect(writes).toHaveLength(2);
        expect(Option.getOrThrow(yield* store.get("direct-1"))).toEqual(renewed);

        yield* store.put("direct-1", reauthenticated);
        expect(writes).toHaveLength(3);

        // Stale renewal targeting the pre-reauth credential must miss and skip disk writes.
        expect(yield* store.replaceRenewedCredential("direct-1", renewed, delayedRenewal)).toBe(
          false,
        );
        expect(writes).toHaveLength(3);
        expect(Option.getOrThrow(yield* store.get("direct-1"))).toEqual(reauthenticated);

        // Removing the credential and settling a delayed renewal must not revive it or write.
        yield* store.remove("direct-1");
        expect(writes).toHaveLength(4);
        expect(
          yield* store.replaceRenewedCredential("direct-1", reauthenticated, delayedRenewal),
        ).toBe(false);
        expect(writes).toHaveLength(4);
        expect(Option.isNone(yield* store.get("direct-1"))).toBe(true);
      }),
  );

  it.effect(
    "checks live IndexedDB state atomically across tabs so stale cached renewals cannot clobber another tab",
    () =>
      Effect.gen(function* () {
        vi.stubGlobal("window", {});
        const persisted = new Map<string, unknown>();
        const transactions: Array<{ readonly mode: string; readonly ops: Array<string> }> = [];
        const sharedDatabase = {
          transaction: (_storeName: string, mode: string) => {
            const ops: Array<string> = [];
            transactions.push({ mode, ops });
            let aborted = false;
            const tx = Object.assign(new EventTarget(), {
              error: null as DOMException | null,
              abort: () => {
                aborted = true;
                queueMicrotask(() => tx.dispatchEvent(new Event("abort")));
              },
              objectStore: () => ({
                get: (key: string) => {
                  ops.push(`get:${key}`);
                  const request = Object.assign(new EventTarget(), {
                    result: persisted.get(key),
                    error: null,
                  });
                  queueMicrotask(() => {
                    request.dispatchEvent(new Event("success"));
                    if (!aborted) {
                      tx.dispatchEvent(new Event("complete"));
                    }
                  });
                  return request;
                },
                put: (value: unknown, key: string) => {
                  ops.push(`put:${key}`);
                  persisted.set(key, value);
                  if (ops.length === 1) {
                    queueMicrotask(() => {
                      if (!aborted) {
                        tx.dispatchEvent(new Event("complete"));
                      }
                    });
                  }
                },
              }),
            });
            return tx;
          },
        } as unknown as IDBDatabase;

        const catalogA = yield* ConnectionStorage.makeCatalogStore(
          ConnectionStorage.makeCatalogBackend(fixedHandle(sharedDatabase)),
        );
        const catalogB = yield* ConnectionStorage.makeCatalogStore(
          ConnectionStorage.makeCatalogBackend(fixedHandle(sharedDatabase)),
        );
        const storeA = ConnectionStorage.makeCatalogCredentialStore(catalogA);
        const storeB = ConnectionStorage.makeCatalogCredentialStore(catalogB);

        const initial = new DpopConnectionCredential({
          accessToken: "token-v1",
          expiresAtEpochMs: 1_000,
        });
        const reauthenticated = new DpopConnectionCredential({
          accessToken: "token-reauth",
          expiresAtEpochMs: 9_000,
        });
        const delayedRenewal = new DpopConnectionCredential({
          accessToken: "token-stale-renewal",
          expiresAtEpochMs: 2_000,
        });
        const nextRenewal = new DpopConnectionCredential({
          accessToken: "token-reauth-renewed",
          expiresAtEpochMs: 12_000,
        });

        yield* storeA.put("direct-1", initial);
        // Prime both tabs' in-memory caches with the initial credential.
        expect(Option.getOrThrow(yield* storeA.get("direct-1"))).toEqual(initial);
        expect(Option.getOrThrow(yield* storeB.get("direct-1"))).toEqual(initial);

        // Tab B re-authenticates while Tab A still holds `initial` in its cached Ref.
        yield* storeB.put("direct-1", reauthenticated);
        transactions.length = 0;

        // Tab A tries to commit a delayed renewal against `initial`; it must read live IDB state
        // in one readwrite transaction, see `reauthenticated`, return false, and skip put().
        expect(yield* storeA.replaceRenewedCredential("direct-1", initial, delayedRenewal)).toBe(
          false,
        );
        expect(transactions).toEqual([{ mode: "readwrite", ops: ["get:document"] }]);
        expect(
          decodeCatalog(persisted.get("document") as string).credentials.find(
            (entry) => entry.connectionId === "direct-1",
          )?.credential,
        ).toEqual(reauthenticated);

        // Matching renewal commits get+put in a single readwrite transaction.
        transactions.length = 0;
        expect(
          yield* storeA.replaceRenewedCredential("direct-1", reauthenticated, nextRenewal),
        ).toBe(true);
        expect(transactions).toEqual([
          { mode: "readwrite", ops: ["get:document", "put:document"] },
        ]);

        // Tab B removes the credential while Tab A caches `nextRenewal`; Tab A must not revive it.
        yield* storeB.remove("direct-1");
        transactions.length = 0;
        expect(
          yield* storeA.replaceRenewedCredential("direct-1", nextRenewal, delayedRenewal),
        ).toBe(false);
        expect(transactions).toEqual([{ mode: "readwrite", ops: ["get:document"] }]);
        expect(decodeCatalog(persisted.get("document") as string).credentials).toEqual([]);
      }),
  );
});

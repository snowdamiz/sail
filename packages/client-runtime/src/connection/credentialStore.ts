import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ConnectionCredential } from "./catalog.ts";
import type { ConnectionAttemptError } from "./model.ts";

export function connectionCredentialsEqual(
  left: ConnectionCredential,
  right: ConnectionCredential,
): boolean {
  if (left._tag !== right._tag) return false;
  switch (left._tag) {
    case "BearerConnectionCredential":
      return right._tag === "BearerConnectionCredential" && left.token === right.token;
    case "DpopConnectionCredential":
      return (
        right._tag === "DpopConnectionCredential" &&
        left.accessToken === right.accessToken &&
        left.expiresAtEpochMs === right.expiresAtEpochMs
      );
  }
}

export class ConnectionCredentialStore extends Context.Service<
  ConnectionCredentialStore,
  {
    readonly get: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<ConnectionCredential>, ConnectionAttemptError>;
    readonly put: (
      connectionId: string,
      credential: ConnectionCredential,
    ) => Effect.Effect<void, ConnectionAttemptError>;
    /**
     * Atomically replaces the stored credential only if it still matches `expectedPrevious`.
     * Prevents a delayed renewal from overwriting a fresh re-authentication or reviving a removed route.
     */
    readonly replaceRenewedCredential: (
      connectionId: string,
      expectedPrevious: ConnectionCredential,
      nextCredential: ConnectionCredential,
    ) => Effect.Effect<boolean, ConnectionAttemptError>;
    readonly remove: (connectionId: string) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/credentialStore/ConnectionCredentialStore") {}

export const make = (service: ConnectionCredentialStore["Service"]) =>
  ConnectionCredentialStore.of(service);

/** A store that lives only as long as its layer, for tests and other throwaway runtimes. */
export const layerMemory = (initial: Iterable<readonly [string, ConnectionCredential]> = []) =>
  Layer.sync(ConnectionCredentialStore, () => {
    const stored = new Map(initial);
    return make({
      get: (connectionId) => Effect.sync(() => Option.fromNullishOr(stored.get(connectionId))),
      put: (connectionId, credential) =>
        Effect.sync(() => void stored.set(connectionId, credential)),
      replaceRenewedCredential: (connectionId, expectedPrevious, nextCredential) =>
        Effect.sync(() => {
          const current = stored.get(connectionId);
          if (current === undefined || !connectionCredentialsEqual(current, expectedPrevious)) {
            return false;
          }
          stored.set(connectionId, nextCredential);
          return true;
        }),
      remove: (connectionId) => Effect.sync(() => void stored.delete(connectionId)),
    });
  });

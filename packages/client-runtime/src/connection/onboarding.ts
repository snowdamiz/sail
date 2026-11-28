import { msg } from "gt-i18n";
import {
  detailFromError,
  MarkedText,
  translatableDetail,
  translatableMessage,
} from "../errors/translatable.ts";
import { EnvironmentId, type DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import {
  exchangeOwnerPasswordForAccessToken,
  fetchAnonymousRemoteSessionState,
  fetchOwnerPasswordDescriptor,
  normalizeOwnerPasswordOrigin,
} from "../authorization/ownerPassword.ts";
import {
  bootstrapRemoteBearerSession,
  exchangeRemoteDpopAccessToken,
} from "../authorization/remote.ts";
import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  DpopConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { connectionRoutes, routeEntry, sshTargetKey } from "./routes.ts";

export type PairingConnectionInput =
  | {
      readonly pairingUrl?: string;
      readonly host?: string;
      readonly pairingCode?: string;
      readonly expectedEnvironmentId?: EnvironmentId;
      readonly replaceConnectionId?: undefined;
    }
  | {
      readonly pairingUrl?: string;
      readonly host?: string;
      readonly pairingCode?: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly replaceConnectionId?: string;
    };

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export type OwnerPasswordDestination =
  | {
      readonly kind: "add";
      readonly host: string;
      readonly expectedEnvironmentId?: EnvironmentId | undefined;
    }
  | { readonly kind: "add-route"; readonly host: string; readonly environmentId: EnvironmentId }
  | {
      readonly kind: "reauthenticate";
      readonly environmentId: EnvironmentId;
      readonly connectionId: string;
    };

export class SavedConnectionActivationError extends Schema.TaggedError<SavedConnectionActivationError>()(
  "SavedConnectionActivationError",
  {
    environmentId: EnvironmentId,
    message: Schema.String,
    i18nMessage: Schema.optionalKey(MarkedText),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export type OwnerPasswordHost = {
  readonly environmentId: EnvironmentId;
  readonly origin: string;
  readonly label: string;
} & (
  | {
      readonly kind: "unavailable";
      readonly reason: "older-server" | "disabled" | "unset";
    }
  | {
      readonly kind: "ready";
      readonly signIn: (
        password: Redacted.Redacted<string>,
      ) => Effect.Effect<
        EnvironmentId,
        | ConnectionAttemptError
        | Persistence.ConnectionPersistenceError
        | SavedConnectionActivationError
      >;
    }
);

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly probeOwnerPasswordHost: (
      to: OwnerPasswordDestination,
    ) => Effect.Effect<OwnerPasswordHost, ConnectionAttemptError>;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
    /** Whether `host` answers this device as `environmentId`. Nothing is sent but the question. */
    readonly reaches: (input: {
      readonly host: string;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<boolean>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          ...(cause instanceof Error
            ? detailFromError(cause)
            : translatableDetail(msg("The pairing details are invalid."))),
        }),
    });
  },
);

function bearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg(
        "That address reaches {host}, a different machine. Add it as its own environment instead.",
        { host: label },
      ),
    ),
  });
}

function makeDirectBearerRoute(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly origin: string;
  readonly connectionId?: string | undefined;
}) {
  const httpBaseUrl = normalizeHttpBaseUrl(input.origin);
  const wsBaseUrl = deriveWsBaseUrl(httpBaseUrl);
  const connectionId = input.connectionId ?? bearerConnectionId(input.environmentId, httpBaseUrl);
  return {
    target: new BearerConnectionTarget({
      environmentId: input.environmentId,
      label: input.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: input.environmentId,
      label: input.label,
      httpBaseUrl,
      wsBaseUrl,
    }),
  };
}

const isBearerProfile = Schema.is(BearerConnectionProfile);

const resolveSavedDirectRouteOrigin = Effect.fn(
  "clientRuntime.connection.onboarding.resolveSavedDirectRouteOrigin",
)(function* (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  connectionId: string,
) {
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
  if (saved === undefined) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("That saved environment is no longer available.")),
    });
  }
  const route = connectionRoutes(saved).find(
    (candidate) =>
      candidate.target._tag === "BearerConnectionTarget" &&
      candidate.target.connectionId === connectionId,
  );
  if (route === undefined) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("That saved direct route is no longer available.")),
    });
  }
  const profile = Option.getOrNull(route.profile);
  if (profile === null || !isBearerProfile(profile) || profile.learned === true) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(
        msg("Owner-password sign-in is only available for saved direct HTTPS routes."),
      ),
    });
  }
  return yield* normalizeOwnerPasswordOrigin(profile.httpBaseUrl);
});

const resolveOwnerPasswordDestination = Effect.fn(
  "clientRuntime.connection.onboarding.resolveOwnerPasswordDestination",
)(function* (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  to: OwnerPasswordDestination,
) {
  switch (to.kind) {
    case "add":
      return {
        origin: yield* normalizeOwnerPasswordOrigin(to.host),
        expectedEnvironmentId: to.expectedEnvironmentId,
        replaceConnectionId: undefined,
      };
    case "add-route":
      return {
        origin: yield* normalizeOwnerPasswordOrigin(to.host),
        expectedEnvironmentId: to.environmentId,
        replaceConnectionId: undefined,
      };
    case "reauthenticate":
      return {
        origin: yield* resolveSavedDirectRouteOrigin(registry, to.environmentId, to.connectionId),
        expectedEnvironmentId: to.environmentId,
        replaceConnectionId: to.connectionId,
      };
  }
});

const probeOwnerPasswordHostConnection = Effect.fn(
  "clientRuntime.connection.onboarding.probeOwnerPasswordHost",
)(function* (
  to: OwnerPasswordDestination,
  deps: {
    readonly registry: EnvironmentRegistry.EnvironmentRegistry["Service"];
    readonly presentation: ClientCapabilities.ClientPresentation["Service"];
    readonly httpClient: HttpClient.HttpClient;
    readonly capturedDpopSigner: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  },
): Effect.fn.Return<OwnerPasswordHost, ConnectionAttemptError> {
  const resolved = yield* resolveOwnerPasswordDestination(deps.registry, to);
  const [descriptor, sessionState] = yield* Effect.all(
    [
      fetchOwnerPasswordDescriptor({
        httpBaseUrl: resolved.origin,
        httpClient: deps.httpClient,
      }),
      fetchAnonymousRemoteSessionState({
        httpBaseUrl: resolved.origin,
        httpClient: deps.httpClient,
      }),
    ],
    { concurrency: "unbounded" },
  );

  if (
    resolved.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== resolved.expectedEnvironmentId
  ) {
    return yield* differentMachineError(descriptor.label);
  }

  const probedRoute = makeDirectBearerRoute({
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    origin: resolved.origin,
    connectionId: resolved.replaceConnectionId,
  });
  if (to.kind === "add") {
    yield* deps.registry.assertKnownAddress({
      ...probedRoute,
      profile: Option.some(probedRoute.profile),
    });
  }

  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }

  const hostIdentity = {
    environmentId: descriptor.environmentId,
    origin: resolved.origin,
    label: descriptor.label,
  } as const;

  // Check capability before session state so older servers are never reported as disabled.
  if (descriptor.capabilities.ownerPasswordToken !== true) {
    return {
      ...hostIdentity,
      kind: "unavailable",
      reason: "older-server",
    };
  }

  if (sessionState.auth.ownerPassword === "unset") {
    return {
      ...hostIdentity,
      kind: "unavailable",
      reason: "unset",
    };
  }

  if (sessionState.auth.ownerPassword !== "configured") {
    return {
      ...hostIdentity,
      kind: "unavailable",
      reason: "disabled",
    };
  }

  const signIn = Effect.fn("clientRuntime.connection.onboarding.signInWithOwnerPassword")(
    function* (password: Redacted.Redacted<string>) {
      if (to.kind === "reauthenticate") {
        const currentOrigin = yield* resolveSavedDirectRouteOrigin(
          deps.registry,
          to.environmentId,
          to.connectionId,
        );
        if (currentOrigin !== resolved.origin) {
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            ...translatableDetail(
              msg("That saved route's address changed before sign-in completed. Try again."),
            ),
          });
        }
      } else if (to.kind === "add") {
        yield* deps.registry.assertKnownAddress({
          ...probedRoute,
          profile: Option.some(probedRoute.profile),
        });
      }

      // Re-verify the server identity and capability at the pinned HTTPS origin before
      // sending the password so a host swap between probe and submit cannot capture it.
      const freshDescriptor = yield* fetchOwnerPasswordDescriptor({
        httpBaseUrl: resolved.origin,
        httpClient: deps.httpClient,
      });
      if (freshDescriptor.environmentId !== descriptor.environmentId) {
        return yield* differentMachineError(freshDescriptor.label);
      }
      const freshCompatibilityError = orchestrationProtocolCompatibilityError(freshDescriptor);
      if (
        freshCompatibilityError !== null &&
        freshCompatibilityError.serverUpdateRequired !== true
      ) {
        return yield* freshCompatibilityError;
      }
      if (freshDescriptor.capabilities.ownerPasswordToken !== true) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          ...translatableDetail(msg("This server does not support owner-password sign-in.")),
          hop: "server",
          via: "direct",
        });
      }

      const dpopSigner = Option.orElse(
        yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
        () => deps.capturedDpopSigner,
      );
      const credential = yield* exchangeOwnerPasswordForAccessToken({
        httpBaseUrl: resolved.origin,
        password,
        clientMetadata: deps.presentation.metadata,
        dpopSigner: Option.getOrUndefined(dpopSigner),
        supportsAccessTokenRenewal: freshDescriptor.capabilities.accessTokenRenewal === true,
        httpClient: deps.httpClient,
      });

      const route = makeDirectBearerRoute({
        environmentId: freshDescriptor.environmentId,
        label: freshDescriptor.label,
        origin: resolved.origin,
        connectionId: resolved.replaceConnectionId,
      });
      const registration = new BearerConnectionRegistration({
        ...route,
        credential,
      });

      const registered = yield* deps.registry.register(registration, {
        knownAddressOnly: to.kind === "add",
        ...(resolved.replaceConnectionId !== undefined
          ? { replaceConnectionId: resolved.replaceConnectionId }
          : {}),
      });
      if (!registered) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          ...translatableDetail(
            msg("This environment is managed by the app and cannot be modified by sign-in."),
          ),
        });
      }

      // Registration already committed durably; report any post-commit activation failure
      // distinctly so callers can retry activation without prompting for the password again.
      yield* Effect.gen(function* () {
        yield* deps.registry.setCompatibility(freshDescriptor.environmentId, null);
        yield* deps.registry.setEnabled(freshDescriptor.environmentId, true);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SavedConnectionActivationError({
              environmentId: freshDescriptor.environmentId,
              ...translatableMessage(
                msg(
                  "Sign-in succeeded and the connection was saved, but it could not be enabled automatically.",
                ),
              ),
              cause,
            }),
        ),
      );

      return freshDescriptor.environmentId;
    },
  );

  return {
    ...hostIdentity,
    kind: "ready",
    signIn,
  };
});

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Checked before redeeming the one-time code, so a wrong link is not spent.
  if (
    input.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(descriptor.label);
  }
  const connectionId = bearerConnectionId(descriptor.environmentId, target.httpBaseUrl);
  const route = {
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
  };
  // The registry checks again under its lease; this early check keeps a refused code unspent.
  if (input.expectedEnvironmentId === undefined) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.assertKnownAddress({ ...route, profile: Option.some(route.profile) });
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  // An outdated server is still saved so it can be updated from this client.
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  // A key-bound session renews itself, but only on a host that can renew it. The proof is made
  // before the one-time code is sent, so a device that cannot sign keeps the code for bearer.
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const dpopProof =
    descriptor.capabilities.accessTokenRenewal === true && Option.isSome(signer)
      ? yield* signer.value
          .createProof({
            method: "POST",
            url: environmentEndpointUrl(target.httpBaseUrl, "/oauth/token"),
          })
          .pipe(Effect.option)
      : Option.none<string>();
  if (Option.isSome(dpopProof)) {
    const access = yield* exchangeRemoteDpopAccessToken({
      httpBaseUrl: target.httpBaseUrl,
      credential: target.credential,
      clientMetadata: presentation.metadata,
      dpopProof: dpopProof.value,
    }).pipe(Effect.mapError(mapRemoteEnvironmentError));
    return new BearerConnectionRegistration({
      ...route,
      credential: new DpopConnectionCredential({
        accessToken: access.access_token,
        expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1_000,
      }),
    });
  }
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));

  return new BearerConnectionRegistration({
    ...route,
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const knownAddressOnly = input.expectedEnvironmentId === undefined;
  const replaceConnectionId =
    input.expectedEnvironmentId !== undefined ? input.replaceConnectionId : undefined;
  if (
    !(yield* registry.register(registration, {
      knownAddressOnly,
      ...(replaceConnectionId !== undefined ? { replaceConnectionId } : {}),
    }))
  ) {
    return registration.target.environmentId;
  }
  yield* registry.setCompatibility(registration.target.environmentId, null);
  yield* registry
    .setEnabled(registration.target.environmentId, true)
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  return registration.target.environmentId;
});

const REACHABILITY_TIMEOUT_MS = 6_000;

const reachesEnvironment = Effect.fn("clientRuntime.connection.onboarding.reachesEnvironment")(
  function* (input: { readonly host: string; readonly environmentId: EnvironmentId }) {
    const httpBaseUrl = yield* Effect.try({
      try: () => normalizeHttpBaseUrl(input.host),
      catch: () =>
        new ConnectionBlockedError({
          reason: "configuration",
          ...translatableDetail(msg("The environment URL is invalid.")),
        }),
    });
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: REACHABILITY_TIMEOUT_MS,
    });
    return descriptor.environmentId === input.environmentId;
  },
  Effect.orElseSucceed(() => false),
);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const route =
    saved === undefined
      ? undefined
      : connectionRoutes(saved).find(
          (candidate) => candidate.target._tag === "BearerConnectionTarget",
        );
  const entry = saved === undefined || route === undefined ? saved : routeEntry(saved, route);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("Only saved bearer environments can be edited.")),
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      ...translatableDetail(msg("The saved bearer credential is unavailable.")),
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("Environment label cannot be empty.")),
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        ...(cause instanceof Error
          ? detailFromError(cause)
          : translatableDetail(msg("The environment URL is invalid."))),
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target, input.expectedEnvironmentId);
  const connectionId = `ssh:${provisioned.environmentId}:${sshTargetKey(provisioned.bootstrap.target)}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
    credential: new BearerConnectionCredential({ token: provisioned.bearerToken }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  if (
    input.expectedEnvironmentId !== undefined &&
    registration.target.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(registration.target.label);
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration, {
    knownAddressOnly: input.expectedEnvironmentId === undefined,
  });
  return registration.target.environmentId;
});

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const capturedDpopSigner = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);

  // Provisioning retains the delegated onboarding operation spans.
  return ConnectionOnboarding.of({
    registerPairing: Effect.fnUntraced(
      function* (input) {
        return yield* registerPairingConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    probeOwnerPasswordHost: Effect.fnUntraced(function* (to) {
      return yield* probeOwnerPasswordHostConnection(to, {
        registry,
        presentation,
        httpClient,
        capturedDpopSigner,
      });
    }),
    registerSsh: Effect.fnUntraced(
      function* (input) {
        return yield* registerSshConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
    ),
    updateBearer: Effect.fnUntraced(
      function* (input) {
        return yield* updateBearerConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
    ),
    reaches: Effect.fnUntraced(
      function* (input) {
        return yield* reachesEnvironment(input);
      },
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);

import {
  AUTH_OWNER_PASSWORD_TOKEN_PATH,
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as Persistence from "../platform/persistence.ts";
import { fetchRemoteSessionState } from "../authorization/remote.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionRegistration,
  PrimaryConnectionRegistration,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
} from "./model.ts";
import * as Onboarding from "./onboarding.ts";
import {
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./routes.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const layerClientPresentation = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "T3 Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
  }),
);

function layerPairingHttp(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly failExchange?: boolean;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
    readonly grantScopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly exchangeGate?: { readonly reached: () => void; readonly release: Promise<void> };
    readonly accessTokenRenewal?: boolean;
  },
) {
  const grantScopes = options?.grantScopes ?? AuthStandardClientScopes;
  let sessionScopes: ReadonlyArray<string> = [];
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/.well-known/t3/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: options?.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: {
            repositoryIdentity: true,
            ...(options?.selfUpdate === true ? { serverSelfUpdate: "boot-service" } : {}),
            ...(options?.accessTokenRenewal === true ? { accessTokenRenewal: true } : {}),
          },
        }),
      );
    }

    if (url.endsWith("/oauth/token")) {
      if (options?.failExchange === true) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "trace-pairing-test",
            },
            { status: 401 },
          ),
        );
      }
      const body =
        init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body);
      const requestedScope = new URLSearchParams(body).get("scope");
      sessionScopes = requestedScope === null ? grantScopes : requestedScope.split(" ");
      if (!sessionScopes.every((scope) => grantScopes.some((granted) => granted === scope))) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentRequestInvalidError",
              code: "invalid_request",
              reason: "scope_not_granted",
              traceId: "pairing-scope-test",
            },
            { status: 400 },
          ),
        );
      }
      const dpop = new Headers(init.headers).has("dpop");
      const granted = Response.json({
        access_token: dpop ? "dpop-token" : "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: dpop ? "DPoP" : "Bearer",
        expires_in: 3600,
        scope: sessionScopes.join(" "),
      });
      const gate = options?.exchangeGate;
      if (gate === undefined) return Promise.resolve(granted);
      gate.reached();
      return gate.release.then(() => granted);
    }

    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          scopes: sessionScopes,
          sessionMethod: "bearer-access-token",
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return RpcHttp.layerRemoteHttpClient(fetchFn);
}

function layerPairingOnboarding(
  options?: Parameters<typeof layerPairingHttp>[1],
  calls: Array<{ readonly url: string; readonly init: RequestInit }> = [],
  provision?: ClientCapabilities.SshEnvironmentGateway["Service"]["provision"],
) {
  const dependencies = Layer.mergeAll(
    layerClientPresentation,
    layerPairingHttp(calls, options),
    Layer.mock(Persistence.ConnectionTargetStore)({
      list: Effect.succeed([]),
      listDisabled: Effect.succeed([]),
    }),
    Layer.mock(Persistence.ConnectionRegistrationStore)({
      register: () => Effect.void,
      setRoutes: () => Effect.void,
      setEnabled: () => Effect.void,
    }),
    Layer.mock(Persistence.EnvironmentCacheStore)({}),
    Layer.mock(ConnectionProfileStore.ConnectionProfileStore)({}),
    Layer.mock(ConnectionCredentialStore.ConnectionCredentialStore)({
      get: () => Effect.succeedNone,
      put: () => Effect.void,
    }),
    Layer.mock(ClientCapabilities.SshEnvironmentGateway)(provision ? { provision } : {}),
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({ status: Effect.succeed("online"), changes: Stream.never }),
    ),
    Layer.mock(ConnectionDriver.ConnectionDriver)({ connect: () => Effect.never }),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
    ),
  );
  return Onboarding.layer.pipe(
    Layer.provideMerge(EnvironmentRegistry.layer.pipe(Layer.provideMerge(dependencies))),
  );
}

const PAIRED_ENVIRONMENT_ID = EnvironmentId.make("environment-paired");
const PAIRING_INPUT = { host: "remote.example.test", pairingCode: "pairing-token" };
const PAIRED_PROFILE = new BearerConnectionProfile({
  connectionId: "bearer:environment-paired:https://remote.example.test",
  environmentId: PAIRED_ENVIRONMENT_ID,
  label: "Paired environment",
  httpBaseUrl: "https://remote.example.test/",
  wsBaseUrl: "wss://remote.example.test/",
});
const UNSUPPORTED_ERROR = new ConnectionBlockedError({
  reason: "unsupported",
  detail: "The saved server used an incompatible orchestration protocol.",
});

const registerSwitchedOffEnvironment = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const registration = new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: PAIRED_ENVIRONMENT_ID,
      connectionId: PAIRED_PROFILE.connectionId,
      label: "Old label",
    }),
    profile: new BearerConnectionProfile({ ...PAIRED_PROFILE, label: "Old label" }),
    credential: new BearerConnectionCredential({ token: "old-token" }),
  });
  yield* registry.register(registration);
  yield* registry.setEnabled(PAIRED_ENVIRONMENT_ID, false);
  yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
  const entries = yield* SubscriptionRef.get(registry.entries);
  expect(entries.get(PAIRED_ENVIRONMENT_ID)).toEqual({
    target: registration.target,
    profile: Option.some(registration.profile),
    enabled: false,
    unsupportedReason: UNSUPPORTED_ERROR.message,
  });
  return entries;
});

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.has("scope")).toBe(false);
      expect(tokenParams.get("client_label")).toBe("T3 Code Test");
      expect(tokenParams.get("client_device_type")).toBe("desktop");
      expect(tokenParams.get("client_os")).toBe("Test OS");
    }),
  );

  it.effect("turns a switched-off environment back on when it is paired again", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSwitchedOffEnvironment;

      const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

      expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
      const entries = yield* SubscriptionRef.get(registry.entries);
      const entry = entries.get(environmentId);
      expect(entries.size).toBe(1);
      expect(entry?.enabled).toBe(true);
      expect(entry?.unsupportedReason).toBeUndefined();
      expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
      expect(entry?.target).toEqual(
        new BearerConnectionTarget({
          environmentId,
          connectionId: PAIRED_PROFILE.connectionId,
          label: PAIRED_PROFILE.label,
        }),
      );
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("refuses a pairing link that claims a saved environment from a new address", () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = yield* registerSwitchedOffEnvironment;

      const error = yield* onboarding
        .registerPairing({ host: "attacker.example.test", pairingCode: "pairing-token" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      expect(calls.map((call) => call.url)).toEqual([
        "https://attacker.example.test/.well-known/t3/environment",
      ]);
    }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));
  });

  it.effect(
    "refuses to add an SSH route to a saved environment during untargeted onboarding",
    () => {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const before = yield* registerSwitchedOffEnvironment;

        const result = yield* onboarding.registerSsh({ target }).pipe(Effect.result);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
        });
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(undefined, [], () =>
            Effect.succeed({
              environmentId: PAIRED_ENVIRONMENT_ID,
              label: "Remote development box",
              bootstrap: {
                target,
                httpBaseUrl: "http://127.0.0.1:3201",
                wsBaseUrl: "ws://127.0.0.1:3201",
                pairingToken: "pairing-token",
              },
              bearerToken: "bearer-token",
            }),
          ),
        ),
      );
    },
  );

  it.effect("refuses a new address when the environment is saved during the exchange", () => {
    let reached!: () => void;
    let release!: () => void;
    const exchangeReached = new Promise<void>((resolve) => (reached = resolve));
    const exchangeGate = {
      reached: () => reached(),
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const pairing = yield* onboarding
        .registerPairing({ host: "attacker.example.test", pairingCode: "pairing-token" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => exchangeReached);
      const before = yield* registerSwitchedOffEnvironment;
      release();

      const outcome = yield* Fiber.join(pairing);

      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
      });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
    }).pipe(Effect.provide(layerPairingOnboarding({ exchangeGate })));
  });

  it.effect("adds a new address as a route when pairing targets that environment", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSwitchedOffEnvironment;

      yield* onboarding.registerPairing({
        host: "lan.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
      });

      const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
      expect(entry === undefined ? [] : connectionRoutes(entry).map(routeHttpBaseUrl)).toEqual(
        expect.arrayContaining(["https://remote.example.test/", "https://lan.example.test/"]),
      );
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect(
    "re-pairs an outdated self-updatable environment so its connection can be rechecked",
    () =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registerSwitchedOffEnvironment;
        yield* registry.setCompatibility(
          PAIRED_ENVIRONMENT_ID,
          new ConnectionBlockedError({
            reason: "unsupported",
            detail: "The saved server needs an update.",
            serverUpdateRequired: true,
          }),
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID),
        ).toMatchObject({
          enabled: false,
          serverUpdateRequired: true,
        });

        const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        expect(entry?.enabled).toBe(true);
        expect(entry?.unsupportedReason).toBeUndefined();
        expect(entry?.serverUpdateRequired).toBeUndefined();
        expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({
            protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
            selfUpdate: true,
          }),
        ),
      ),
  );

  it.effect.each([
    {
      kind: "primary",
      registration: new PrimaryConnectionRegistration({
        target: new PrimaryConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Host environment",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      }),
    },
    {
      kind: "bearer",
      registration: new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          connectionId: "platform:wsl",
          label: "WSL",
        }),
        profile: new BearerConnectionProfile({
          ...PAIRED_PROFILE,
          connectionId: "platform:wsl",
          label: "WSL",
          httpBaseUrl: "http://127.0.0.1:4000",
          wsBaseUrl: "ws://127.0.0.1:4000",
        }),
        credential: new BearerConnectionCredential({ token: "platform-token" }),
      }),
    },
  ] as const)(
    "leaves a platform-managed $kind environment untouched when its id is paired",
    ({ registration }) =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registry.reconcilePlatform([registration]);
        yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
        const before = yield* SubscriptionRef.get(registry.entries);
        expect(before.get(PAIRED_ENVIRONMENT_ID)).toMatchObject({
          enabled: true,
          unsupportedReason: UNSUPPORTED_ERROR.message,
        });

        const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("leaves a switched-off environment unchanged when the pairing exchange fails", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = yield* registerSwitchedOffEnvironment;

      const error = yield* onboarding.registerPairing(PAIRING_INPUT).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        traceId: "trace-pairing-test",
      });
      const after = yield* SubscriptionRef.get(registry.entries);
      expect(after).toEqual(before);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.enabled).toBe(false);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.unsupportedReason).toBe(UNSUPPORTED_ERROR.message);
    }).pipe(Effect.provide(layerPairingOnboarding({ failExchange: true }))),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }, calls),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );
  it.effect.each([
    { label: "read-only", scopes: ["orchestration:read"] },
    { label: "default", scopes: AuthStandardClientScopes },
  ] as const)("preserves the $label grant when pairing a remote environment", ({ scopes }) =>
    Effect.gen(function* () {
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      });

      assert(registration.credential._tag === "BearerConnectionCredential");
      const session = yield* fetchRemoteSessionState({
        httpBaseUrl: registration.profile.httpBaseUrl,
        bearerToken: registration.credential.token,
      });

      expect(session.authenticated).toBe(true);
      expect(session.scopes).toEqual(scopes);
    }).pipe(Effect.provide(layerPairingOnboarding({ grantScopes: scopes }))),
  );

  it.effect.each([
    { name: "a host that renews, with a device key", renews: true, signer: true, dpop: true },
    { name: "a host that renews, without a device key", renews: true, signer: false, dpop: false },
    { name: "an older host, with a device key", renews: false, signer: true, dpop: false },
  ])("pairs with $name as DPoP: $dpop", ({ renews, signer, dpop }) =>
    Effect.gen(function* () {
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      });
      expect(registration.credential).toMatchObject(
        dpop
          ? { _tag: "DpopConnectionCredential", accessToken: "dpop-token" }
          : { _tag: "BearerConnectionCredential", token: "bearer-token" },
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingOnboarding({ accessTokenRenewal: renews }),
          signer
            ? Layer.succeed(
                ManagedRelay.ManagedRelayDpopSigner,
                ManagedRelay.ManagedRelayDpopSigner.of({
                  thumbprint: Effect.succeed("device-key"),
                  createProof: (proof) => Effect.succeed(`proof:${proof.url}`),
                }),
              )
            : Layer.empty,
        ),
      ),
    ),
  );

  it.effect("refuses to add a route that reaches a different machine, keeping the code", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)), Effect.flip);
      expect(error).toMatchObject({ reason: "configuration" });
      expect(error.message).toContain("different machine");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("refuses an outdated server that cannot update itself", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }, calls),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error).not.toHaveProperty("serverUpdateRequired");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(layerPairingOnboarding({ failDescriptor: true }, calls)), Effect.flip);

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          ClientCapabilities.SshEnvironmentGateway,
          ClientCapabilities.SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("environment-ssh"),
                label: "Remote development box",
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
          target,
        },
        // Saved so the first connect reuses this pairing instead of adding another.
        credential: { token: "bearer-token" },
      });
    }),
  );
});

describe("owner-password onboarding", () => {
  function expectReadyHost(
    host: Onboarding.OwnerPasswordHost,
  ): Extract<Onboarding.OwnerPasswordHost, { readonly kind: "ready" }> {
    if (host.kind !== "ready") {
      assert.fail(`Expected ready owner-password host, got ${host.kind} (${host.reason})`);
    }
    return host;
  }

  interface OwnerPasswordTestOptions {
    readonly environmentId?: string;
    readonly label?: string;
    readonly ownerPasswordToken?: boolean | undefined;
    readonly accessTokenRenewal?: boolean;
    readonly ownerPasswordState?: "configured" | "unset" | undefined;
    readonly redirectDescriptor?: boolean;
    readonly redirectSession?: boolean;
    readonly redirectToken?: boolean;
    readonly descriptorSequence?: ReadonlyArray<{
      readonly environmentId?: string;
      readonly label?: string;
      readonly ownerPasswordToken?: boolean | undefined;
      readonly accessTokenRenewal?: boolean;
      readonly redirect?: boolean;
    }>;
    readonly tokenResponse?: (input: {
      readonly url: string;
      readonly init: RequestInit;
      readonly hasDpop: boolean;
    }) => Response;
    readonly signer?: {
      readonly proofs: Array<{
        readonly method: string;
        readonly url: string;
        readonly accessToken?: string;
      }>;
    };
    readonly failSetEnabled?: boolean;
    readonly savedRegistrations?: Array<ConnectionRegistration>;
    readonly enabledCalls?: Array<{
      readonly environmentId: EnvironmentId;
      readonly enabled: boolean;
    }>;
  }

  function layerOwnerPasswordOnboarding(
    calls: Array<{ readonly url: string; readonly init: RequestInit }>,
    options: OwnerPasswordTestOptions = {},
  ) {
    let descriptorIndex = 0;
    const fetchFn = ((input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.endsWith("/.well-known/t3/environment")) {
        const step = options.descriptorSequence?.[descriptorIndex];
        descriptorIndex += 1;
        if (step?.redirect === true || options.redirectDescriptor === true) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://redirected.example.test/.well-known/t3/environment" },
            }),
          );
        }
        const capabilityToken =
          step !== undefined
            ? "ownerPasswordToken" in step
              ? step.ownerPasswordToken
              : true
            : "ownerPasswordToken" in options
              ? options.ownerPasswordToken
              : true;
        const accessTokenRenewal = step?.accessTokenRenewal ?? options.accessTokenRenewal ?? true;
        return Promise.resolve(
          Response.json({
            environmentId: step?.environmentId ?? options.environmentId ?? "environment-owner",
            label: step?.label ?? options.label ?? "Sail Host",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            capabilities: {
              repositoryIdentity: true,
              ...(capabilityToken !== undefined ? { ownerPasswordToken: capabilityToken } : {}),
              ...(accessTokenRenewal ? { accessTokenRenewal: true } : {}),
            },
          }),
        );
      }

      if (url.endsWith("/api/auth/session")) {
        if (options.redirectSession === true) {
          return Promise.resolve(
            new Response(null, {
              status: 307,
              headers: { location: "https://redirected.example.test/api/auth/session" },
            }),
          );
        }
        const ownerPasswordState =
          "ownerPasswordState" in options ? options.ownerPasswordState : "configured";
        return Promise.resolve(
          Response.json({
            authenticated: false,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["bearer-access-token"],
              sessionCookieName: "t3_session",
              ...(ownerPasswordState !== undefined ? { ownerPassword: ownerPasswordState } : {}),
            },
            scopes: [],
          }),
        );
      }

      if (url.endsWith(AUTH_OWNER_PASSWORD_TOKEN_PATH)) {
        if (options.redirectToken === true) {
          return Promise.resolve(
            new Response(null, {
              status: 308,
              headers: {
                location: "https://redirected.example.test/api/auth/owner-password/token",
              },
            }),
          );
        }
        const hasDpop = new Headers(init.headers).has("dpop");
        if (options.tokenResponse !== undefined) {
          return Promise.resolve(options.tokenResponse({ url, init, hasDpop }));
        }
        return Promise.resolve(
          Response.json({
            access_token: hasDpop ? "owner-dpop-token" : "owner-bearer-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: hasDpop ? "DPoP" : "Bearer",
            expires_in: 3600,
            scope: AuthStandardClientScopes.join(" "),
          }),
        );
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }) satisfies typeof fetch;

    const dependencies = Layer.mergeAll(
      layerClientPresentation,
      RpcHttp.layerRemoteHttpClient(fetchFn),
      Layer.mock(Persistence.ConnectionTargetStore)({
        list: Effect.succeed([]),
        listDisabled: Effect.succeed([]),
      }),
      Layer.mock(Persistence.ConnectionRegistrationStore)({
        register: (registration) =>
          Effect.sync(() => {
            options.savedRegistrations?.push(registration);
          }),
        setRoutes: () => Effect.void,
        setEnabled: (environmentId, enabled) =>
          options.failSetEnabled === true && enabled
            ? Effect.fail(
                new Persistence.ConnectionPersistenceError({
                  operation: "set-connection-enabled",
                  message: "disk full",
                }),
              )
            : Effect.sync(() => {
                options.enabledCalls?.push({ environmentId, enabled });
              }),
      }),
      Layer.mock(Persistence.EnvironmentCacheStore)({}),
      Layer.mock(ConnectionProfileStore.ConnectionProfileStore)({}),
      Layer.mock(ConnectionCredentialStore.ConnectionCredentialStore)({
        get: () => Effect.succeedNone,
        put: () => Effect.void,
        replaceRenewedCredential: () => Effect.succeed(false),
      }),
      Layer.mock(ClientCapabilities.SshEnvironmentGateway)({}),
      Layer.succeed(
        Connectivity.Connectivity,
        Connectivity.Connectivity.of({ status: Effect.succeed("online"), changes: Stream.never }),
      ),
      Layer.mock(ConnectionDriver.ConnectionDriver)({ connect: () => Effect.never }),
      Layer.succeed(
        ConnectionWakeups.ConnectionWakeups,
        ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
      ),
      options.signer !== undefined
        ? Layer.succeed(
            ManagedRelay.ManagedRelayDpopSigner,
            ManagedRelay.ManagedRelayDpopSigner.of({
              thumbprint: Effect.succeed("device-key-thumbprint"),
              createProof: (proof) =>
                Effect.sync(() => {
                  options.signer!.proofs.push(proof);
                  return `dpop-proof:${proof.method}:${proof.url}`;
                }),
            }),
          )
        : Layer.empty,
    );

    return Onboarding.layer.pipe(
      Layer.provideMerge(EnvironmentRegistry.layer.pipe(Layer.provideMerge(dependencies))),
    );
  }

  it.effect(
    "probes a ready HTTPS host from bare hostname or URL with path using non-redirecting anonymous requests",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const [bare, withPath] = yield* Effect.gen(function* () {
          const onboarding = yield* Onboarding.ConnectionOnboarding;
          return [
            yield* onboarding.probeOwnerPasswordHost({ kind: "add", host: "my-sail.fly.dev" }),
            yield* onboarding.probeOwnerPasswordHost({
              kind: "add",
              host: "https://my-sail.fly.dev/foo?bar=1#baz",
            }),
          ] as const;
        }).pipe(Effect.provide(layerOwnerPasswordOnboarding(calls)));

        expect(bare).toMatchObject({
          kind: "ready",
          environmentId: "environment-owner",
          origin: "https://my-sail.fly.dev",
          label: "Sail Host",
        });
        expect(withPath).toMatchObject({
          kind: "ready",
          environmentId: "environment-owner",
          origin: "https://my-sail.fly.dev",
          label: "Sail Host",
        });
        expect(calls).toHaveLength(4);
        for (const call of calls) {
          expect(call.init.credentials).toBe("omit");
          expect(call.init.redirect).toBe("manual");
          expect(new Headers(call.init.headers).has("authorization")).toBe(false);
        }
      }),
  );

  it.effect("classifies older servers before checking auth.ownerPassword", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const host = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        return yield* onboarding.probeOwnerPasswordHost({ kind: "add", host: "older.fly.dev" });
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding(calls, {
            ownerPasswordToken: undefined,
            ownerPasswordState: undefined,
          }),
        ),
      );

      expect(host).toEqual({
        kind: "unavailable",
        reason: "older-server",
        environmentId: "environment-owner",
        origin: "https://older.fly.dev",
        label: "Sail Host",
      });
    }),
  );

  it.effect("classifies unset and disabled owner-password states on capable servers", () =>
    Effect.gen(function* () {
      const unsetHost = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        return yield* onboarding.probeOwnerPasswordHost({ kind: "add", host: "unset.fly.dev" });
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding([], {
            ownerPasswordToken: true,
            ownerPasswordState: "unset",
          }),
        ),
      );
      expect(unsetHost).toMatchObject({ kind: "unavailable", reason: "unset" });

      const disabledHost = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        return yield* onboarding.probeOwnerPasswordHost({ kind: "add", host: "disabled.fly.dev" });
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding([], {
            ownerPasswordToken: true,
            ownerPasswordState: undefined,
          }),
        ),
      );
      expect(disabledHost).toMatchObject({ kind: "unavailable", reason: "disabled" });
    }),
  );

  it.effect("rejects plain http:// hosts without making network requests", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        return yield* onboarding.probeOwnerPasswordHost({
          kind: "add",
          host: "http://my-sail.fly.dev",
        });
      }).pipe(Effect.provide(layerOwnerPasswordOnboarding(calls)), Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
      expect(error.message).toContain("HTTPS");
      expect(calls).toHaveLength(0);

      const envId = EnvironmentId.make("environment-http");
      const httpConnectionId = `bearer:${envId}:http://lan.example.test:3773`;
      const reauthError = yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              environmentId: envId,
              label: "LAN Host",
              connectionId: httpConnectionId,
            }),
            profile: new BearerConnectionProfile({
              connectionId: httpConnectionId,
              environmentId: envId,
              label: "LAN Host",
              httpBaseUrl: "http://lan.example.test:3773/",
              wsBaseUrl: "ws://lan.example.test:3773/",
            }),
            credential: new BearerConnectionCredential({ token: "lan-token" }),
          }),
        );
        return yield* onboarding.probeOwnerPasswordHost({
          kind: "reauthenticate",
          environmentId: envId,
          connectionId: httpConnectionId,
        });
      }).pipe(Effect.provide(layerOwnerPasswordOnboarding(calls)), Effect.flip);
      expect(reauthError).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
      expect(reauthError.message).toContain("HTTPS");
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("rejects 3xx redirects on probe and sign-in with zero password POSTs", () =>
    Effect.gen(function* () {
      const probeCalls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const probeError = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        return yield* onboarding.probeOwnerPasswordHost({
          kind: "add",
          host: "redirect.fly.dev",
        });
      }).pipe(
        Effect.provide(layerOwnerPasswordOnboarding(probeCalls, { redirectDescriptor: true })),
        Effect.flip,
      );
      expect(probeError).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(probeCalls.some((c) => c.url.endsWith(AUTH_OWNER_PASSWORD_TOKEN_PATH))).toBe(false);

      const submitCalls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const submitError = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "redirect-later.fly.dev",
          }),
        );
        return yield* host.signIn(Redacted.make("correct horse battery staple"));
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding(submitCalls, {
            descriptorSequence: [{}, { redirect: true }],
          }),
        ),
        Effect.flip,
      );
      expect(submitError).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
      expect(submitCalls.some((c) => c.url.endsWith(AUTH_OWNER_PASSWORD_TOKEN_PATH))).toBe(false);
    }),
  );

  it.effect("rejects mismatched expectedEnvironmentId and known-address conflicts on probe", () =>
    Effect.gen(function* () {
      const mismatch = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        return yield* onboarding.probeOwnerPasswordHost({
          kind: "add-route",
          host: "my-sail.fly.dev",
          environmentId: EnvironmentId.make("environment-other"),
        });
      }).pipe(Effect.provide(layerOwnerPasswordOnboarding([])), Effect.flip);
      expect(mismatch).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });

      const conflict = yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const envId = EnvironmentId.make("environment-owner");
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              environmentId: envId,
              label: "Saved Sail",
              connectionId: `bearer:${envId}:https://first.fly.dev`,
            }),
            profile: new BearerConnectionProfile({
              connectionId: `bearer:${envId}:https://first.fly.dev`,
              environmentId: envId,
              label: "Saved Sail",
              httpBaseUrl: "https://first.fly.dev/",
              wsBaseUrl: "wss://first.fly.dev/",
            }),
            credential: new BearerConnectionCredential({ token: "existing-token" }),
          }),
        );
        return yield* onboarding.probeOwnerPasswordHost({
          kind: "add",
          host: "second.fly.dev",
        });
      }).pipe(Effect.provide(layerOwnerPasswordOnboarding([])), Effect.flip);
      expect(conflict).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
    }),
  );

  it.effect("signs in with DPoP when accessTokenRenewal and signer are available", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const proofs: Array<{
        readonly method: string;
        readonly url: string;
        readonly accessToken?: string;
      }> = [];
      const savedRegistrations: Array<ConnectionRegistration> = [];
      const enabledCalls: Array<{
        readonly environmentId: EnvironmentId;
        readonly enabled: boolean;
      }> = [];

      const [environmentId, entry] = yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "my-sail.fly.dev",
          }),
        );
        const id = yield* host.signIn(Redacted.make("correct horse battery staple"));
        return [id, (yield* SubscriptionRef.get(registry.entries)).get(id)] as const;
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding(calls, {
            accessTokenRenewal: true,
            signer: { proofs },
            savedRegistrations,
            enabledCalls,
          }),
        ),
      );

      expect(environmentId).toBe("environment-owner");
      expect(entry?.enabled).toBe(true);
      expect(proofs).toEqual([
        {
          method: "POST",
          url: `https://my-sail.fly.dev${AUTH_OWNER_PASSWORD_TOKEN_PATH}`,
        },
      ]);
      const tokenCall = calls.find((call) => call.url.endsWith(AUTH_OWNER_PASSWORD_TOKEN_PATH));
      assert.isDefined(tokenCall);
      expect(tokenCall.init.credentials).toBe("omit");
      expect(tokenCall.init.redirect).toBe("manual");
      expect(new Headers(tokenCall.init.headers).get("dpop")).toBe(
        `dpop-proof:POST:https://my-sail.fly.dev${AUTH_OWNER_PASSWORD_TOKEN_PATH}`,
      );
      expect(savedRegistrations).toHaveLength(1);
      expect(savedRegistrations[0]).toMatchObject({
        _tag: "BearerConnectionRegistration",
        credential: {
          _tag: "DpopConnectionCredential",
          accessToken: "owner-dpop-token",
        },
      });
      expect(enabledCalls).toEqual([]);
    }),
  );

  it.effect("falls back to Bearer when DPoP signer or accessTokenRenewal is absent", () =>
    Effect.gen(function* () {
      const noSignerCalls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const noSignerSaved: Array<ConnectionRegistration> = [];
      yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "my-sail.fly.dev",
          }),
        );
        yield* host.signIn(Redacted.make("correct horse battery staple"));
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding(noSignerCalls, {
            accessTokenRenewal: true,
            savedRegistrations: noSignerSaved,
          }),
        ),
      );
      const noSignerTokenCall = noSignerCalls.find((c) =>
        c.url.endsWith(AUTH_OWNER_PASSWORD_TOKEN_PATH),
      );
      expect(new Headers(noSignerTokenCall?.init.headers).has("dpop")).toBe(false);
      expect(noSignerSaved[0]).toMatchObject({
        credential: { _tag: "BearerConnectionCredential", token: "owner-bearer-token" },
      });

      const noRenewalCalls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const noRenewalProofs: Array<{ readonly method: string; readonly url: string }> = [];
      const noRenewalSaved: Array<ConnectionRegistration> = [];
      yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "my-sail.fly.dev",
          }),
        );
        yield* host.signIn(Redacted.make("correct horse battery staple"));
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding(noRenewalCalls, {
            accessTokenRenewal: false,
            signer: { proofs: noRenewalProofs },
            savedRegistrations: noRenewalSaved,
          }),
        ),
      );
      expect(noRenewalProofs).toHaveLength(0);
      const noRenewalTokenCall = noRenewalCalls.find((c) =>
        c.url.endsWith(AUTH_OWNER_PASSWORD_TOKEN_PATH),
      );
      expect(new Headers(noRenewalTokenCall?.init.headers).has("dpop")).toBe(false);
      expect(noRenewalSaved[0]).toMatchObject({
        credential: { _tag: "BearerConnectionCredential", token: "owner-bearer-token" },
      });
    }),
  );

  it.effect("rejects token_type mismatches for both DPoP and Bearer exchanges", () =>
    Effect.gen(function* () {
      const savedOnDpopMismatch: Array<ConnectionRegistration> = [];
      const dpopMismatch = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "my-sail.fly.dev",
          }),
        );
        return yield* host.signIn(Redacted.make("correct horse battery staple"));
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding([], {
            accessTokenRenewal: true,
            signer: { proofs: [] },
            savedRegistrations: savedOnDpopMismatch,
            tokenResponse: () =>
              Response.json({
                access_token: "unexpected-bearer",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "Bearer",
                expires_in: 3600,
                scope: AuthStandardClientScopes.join(" "),
              }),
          }),
        ),
        Effect.flip,
      );
      expect(dpopMismatch).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
      });
      expect(savedOnDpopMismatch).toHaveLength(0);

      const savedOnBearerMismatch: Array<ConnectionRegistration> = [];
      const bearerMismatch = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "my-sail.fly.dev",
          }),
        );
        return yield* host.signIn(Redacted.make("correct horse battery staple"));
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding([], {
            accessTokenRenewal: false,
            savedRegistrations: savedOnBearerMismatch,
            tokenResponse: () =>
              Response.json({
                access_token: "unexpected-dpop",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 3600,
                scope: AuthStandardClientScopes.join(" "),
              }),
          }),
        ),
        Effect.flip,
      );
      expect(bearerMismatch).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
      });
      expect(savedOnBearerMismatch).toHaveLength(0);
    }),
  );

  it.effect(
    "aborts with zero password POSTs if server identity changes between probe and submit",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const error = yield* Effect.gen(function* () {
          const onboarding = yield* Onboarding.ConnectionOnboarding;
          const host = expectReadyHost(
            yield* onboarding.probeOwnerPasswordHost({
              kind: "add",
              host: "my-sail.fly.dev",
            }),
          );
          return yield* host.signIn(Redacted.make("correct horse battery staple"));
        }).pipe(
          Effect.provide(
            layerOwnerPasswordOnboarding(calls, {
              descriptorSequence: [
                { environmentId: "environment-owner", label: "Original Host" },
                { environmentId: "environment-impostor", label: "Swapped Host" },
              ],
            }),
          ),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "configuration",
        });
        expect(calls.some((call) => call.url.endsWith(AUTH_OWNER_PASSWORD_TOKEN_PATH))).toBe(false);
      }),
  );

  it.effect("maps 401 clock skew and wrong-password failures distinctly", () =>
    Effect.gen(function* () {
      const clockSkewError = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "my-sail.fly.dev",
          }),
        );
        return yield* host.signIn(Redacted.make("correct horse battery staple"));
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding([], {
            accessTokenRenewal: true,
            signer: { proofs: [] },
            tokenResponse: () =>
              Response.json(
                {
                  _tag: "EnvironmentAuthInvalidError",
                  code: "auth_invalid",
                  reason: "invalid_credential",
                  dpopFailureReason: "time_window",
                  traceId: "trace-clock-skew",
                },
                { status: 401 },
              ),
          }),
        ),
        Effect.flip,
      );
      expect(clockSkewError).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        failureCause: "clock_skew",
        traceId: "trace-clock-skew",
      });

      const badPasswordError = yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "my-sail.fly.dev",
          }),
        );
        return yield* host.signIn(Redacted.make("wrong password value"));
      }).pipe(
        Effect.provide(
          layerOwnerPasswordOnboarding([], {
            tokenResponse: () =>
              Response.json(
                {
                  _tag: "EnvironmentAuthInvalidError",
                  code: "auth_invalid",
                  reason: "invalid_credential",
                  traceId: "trace-bad-password",
                },
                { status: 401 },
              ),
          }),
        ),
        Effect.flip,
      );
      expect(badPasswordError).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        traceId: "trace-bad-password",
      });
      expect(badPasswordError).not.toHaveProperty("failureCause", "clock_skew");
    }),
  );

  it.effect(
    "preserves an exact non-first legacy connectionId during owner-password reauthentication",
    () =>
      Effect.gen(function* () {
        const envId = EnvironmentId.make("environment-owner");
        const firstRouteId = `bearer:${envId}:https://primary-direct.example.test`;
        const legacyRouteId = "legacy-sail-https";
        const savedRegistrations: Array<ConnectionRegistration> = [];

        const routes = yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const onboarding = yield* Onboarding.ConnectionOnboarding;
          yield* registry.register(
            new BearerConnectionRegistration({
              target: new BearerConnectionTarget({
                environmentId: envId,
                label: "Sail Host",
                connectionId: firstRouteId,
              }),
              profile: new BearerConnectionProfile({
                connectionId: firstRouteId,
                environmentId: envId,
                label: "Sail Host",
                httpBaseUrl: "https://primary-direct.example.test/",
                wsBaseUrl: "wss://primary-direct.example.test/",
              }),
              credential: new BearerConnectionCredential({ token: "first-route-token" }),
            }),
          );
          yield* registry.register(
            new BearerConnectionRegistration({
              target: new BearerConnectionTarget({
                environmentId: envId,
                label: "Sail Host",
                connectionId: legacyRouteId,
              }),
              profile: new BearerConnectionProfile({
                connectionId: legacyRouteId,
                environmentId: envId,
                label: "Sail Host",
                httpBaseUrl: "https://my-sail.fly.dev/",
                wsBaseUrl: "wss://my-sail.fly.dev/",
              }),
              credential: new BearerConnectionCredential({ token: "expired-legacy-token" }),
            }),
          );
          yield* registry.reorderRoutes(envId, [firstRouteId, legacyRouteId]);
          savedRegistrations.length = 0;

          const host = expectReadyHost(
            yield* onboarding.probeOwnerPasswordHost({
              kind: "reauthenticate",
              environmentId: envId,
              connectionId: legacyRouteId,
            }),
          );
          expect(host.origin).toBe("https://my-sail.fly.dev");
          yield* host.signIn(Redacted.make("correct horse battery staple"));

          const entry = (yield* SubscriptionRef.get(registry.entries)).get(envId);
          assert.isDefined(entry);
          return connectionRoutes(entry);
        }).pipe(
          Effect.provide(
            layerOwnerPasswordOnboarding([], {
              accessTokenRenewal: true,
              signer: { proofs: [] },
              savedRegistrations,
            }),
          ),
        );

        expect(
          routes.map((route) =>
            route.target._tag === "BearerConnectionTarget" ? route.target.connectionId : null,
          ),
        ).toEqual([firstRouteId, legacyRouteId]);
        expect(savedRegistrations).toHaveLength(1);
        expect(savedRegistrations[0]).toMatchObject({
          target: { connectionId: legacyRouteId },
          profile: { connectionId: legacyRouteId, httpBaseUrl: "https://my-sail.fly.dev/" },
          credential: { _tag: "DpopConnectionCredential", accessToken: "owner-dpop-token" },
        });
      }),
  );

  it.effect(
    "returns SavedConnectionActivationError when setEnabled fails after durable registration",
    () =>
      Effect.gen(function* () {
        const envId = EnvironmentId.make("environment-owner");
        const connectionId = `bearer:${envId}:https://my-sail.fly.dev`;
        const savedRegistrations: Array<ConnectionRegistration> = [];
        const [error, entry] = yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const onboarding = yield* Onboarding.ConnectionOnboarding;
          yield* registry.register(
            new BearerConnectionRegistration({
              target: new BearerConnectionTarget({
                environmentId: envId,
                label: "Sail Host",
                connectionId,
              }),
              profile: new BearerConnectionProfile({
                connectionId,
                environmentId: envId,
                label: "Sail Host",
                httpBaseUrl: "https://my-sail.fly.dev/",
                wsBaseUrl: "wss://my-sail.fly.dev/",
              }),
              credential: new BearerConnectionCredential({ token: "old-token" }),
            }),
          );
          yield* registry.setEnabled(envId, false);
          savedRegistrations.length = 0;

          const host = expectReadyHost(
            yield* onboarding.probeOwnerPasswordHost({
              kind: "reauthenticate",
              environmentId: envId,
              connectionId,
            }),
          );
          const signInError = yield* host
            .signIn(Redacted.make("correct horse battery staple"))
            .pipe(Effect.flip);
          return [signInError, (yield* SubscriptionRef.get(registry.entries)).get(envId)] as const;
        }).pipe(
          Effect.provide(
            layerOwnerPasswordOnboarding([], {
              failSetEnabled: true,
              savedRegistrations,
            }),
          ),
        );

        expect(error).toBeInstanceOf(Onboarding.SavedConnectionActivationError);
        expect(error).toMatchObject({
          _tag: "SavedConnectionActivationError",
          environmentId: "environment-owner",
        });
        expect(savedRegistrations).toHaveLength(1);
        expect(entry?.target.environmentId).toBe("environment-owner");
      }),
  );

  it.effect("fails cleanly when register returns false for a platform-owned environment", () =>
    Effect.gen(function* () {
      const envId = EnvironmentId.make("environment-owner");
      const error = yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registry.reconcilePlatform([
          new PrimaryConnectionRegistration({
            target: new PrimaryConnectionTarget({
              environmentId: envId,
              label: "Local Primary",
              httpBaseUrl: "https://my-sail.fly.dev/",
              wsBaseUrl: "wss://my-sail.fly.dev/",
            }),
          }),
        ]);
        const host = expectReadyHost(
          yield* onboarding.probeOwnerPasswordHost({
            kind: "add-route",
            host: "my-sail.fly.dev",
            environmentId: envId,
          }),
        );
        return yield* host.signIn(Redacted.make("correct horse battery staple"));
      }).pipe(Effect.provide(layerOwnerPasswordOnboarding([])), Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
    }),
  );

  it.effect("preserves replaceConnectionId during pairing-code reauthentication", () =>
    Effect.gen(function* () {
      const envId = EnvironmentId.make("environment-paired");
      const firstRouteId = `bearer:${envId}:https://primary-direct.example.test`;
      const legacyRouteId = "legacy-pairing-route";

      const routes = yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              environmentId: envId,
              label: "Paired environment",
              connectionId: firstRouteId,
            }),
            profile: new BearerConnectionProfile({
              connectionId: firstRouteId,
              environmentId: envId,
              label: "Paired environment",
              httpBaseUrl: "https://primary-direct.example.test/",
              wsBaseUrl: "wss://primary-direct.example.test/",
            }),
            credential: new BearerConnectionCredential({ token: "first-token" }),
          }),
        );
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              environmentId: envId,
              label: "Paired environment",
              connectionId: legacyRouteId,
            }),
            profile: new BearerConnectionProfile({
              connectionId: legacyRouteId,
              environmentId: envId,
              label: "Paired environment",
              httpBaseUrl: "https://remote.example.test/",
              wsBaseUrl: "wss://remote.example.test/",
            }),
            credential: new BearerConnectionCredential({ token: "old-token" }),
          }),
        );
        yield* registry.reorderRoutes(envId, [firstRouteId, legacyRouteId]);

        yield* onboarding.registerPairing({
          host: "remote.example.test",
          pairingCode: "pairing-token",
          expectedEnvironmentId: envId,
          replaceConnectionId: legacyRouteId,
        });

        const entry = (yield* SubscriptionRef.get(registry.entries)).get(envId);
        assert.isDefined(entry);
        return connectionRoutes(entry);
      }).pipe(Effect.provide(layerPairingOnboarding()));

      expect(
        routes.map((route) =>
          route.target._tag === "BearerConnectionTarget" ? route.target.connectionId : null,
        ),
      ).toEqual([firstRouteId, legacyRouteId]);
    }),
  );

  it.effect(
    "rejects a mismatched machine during add probe when expectedEnvironmentId is supplied",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const mismatchError = yield* Effect.gen(function* () {
          const onboarding = yield* Onboarding.ConnectionOnboarding;
          return yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "https://linked.fly.dev",
            expectedEnvironmentId: EnvironmentId.make("expected-linked-env"),
          });
        }).pipe(
          Effect.provide(
            layerOwnerPasswordOnboarding(calls, {
              environmentId: "different-env",
              label: "Other Machine",
            }),
          ),
          Effect.flip,
        );

        expect(mismatchError).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "configuration",
        });
        expect(mismatchError.message).toContain("Other Machine");
        expect(calls.some((call) => call.url.endsWith(AUTH_OWNER_PASSWORD_TOKEN_PATH))).toBe(false);

        const matchedHost = yield* Effect.gen(function* () {
          const onboarding = yield* Onboarding.ConnectionOnboarding;
          return yield* onboarding.probeOwnerPasswordHost({
            kind: "add",
            host: "https://linked.fly.dev",
            expectedEnvironmentId: EnvironmentId.make("expected-linked-env"),
          });
        }).pipe(
          Effect.provide(
            layerOwnerPasswordOnboarding([], {
              environmentId: "expected-linked-env",
              label: "Linked Machine",
            }),
          ),
        );

        expect(matchedHost).toMatchObject({
          kind: "ready",
          environmentId: "expected-linked-env",
          origin: "https://linked.fly.dev",
        });
      }),
  );
});

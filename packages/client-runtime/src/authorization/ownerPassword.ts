import {
  AUTH_OWNER_PASSWORD_TOKEN_PATH,
  type AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpClient } from "effect/http";
import { msg } from "gt-i18n";

import {
  BearerConnectionCredential,
  DpopConnectionCredential,
  type ConnectionCredential,
} from "../connection/catalog.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { translatableDetail } from "../errors/translatable.ts";
import { dpopFailureText } from "../relay/errorPresentation.ts";
import type * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

// Never send ambient cookies or follow 3xx redirects during owner-password
// probes or token exchange so credentials cannot be forwarded across origins.
const OWNER_PASSWORD_FETCH_INIT: RequestInit = {
  credentials: "omit",
  redirect: "manual",
  cache: "no-store",
};

const EXPLICIT_SCHEME_WITH_AUTHORITY = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const EXPLICIT_NON_PORT_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:(?!\d+(?:[/?#]|$))/;

const httpsRequiredError = () =>
  new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(msg("Owner-password sign-in requires an HTTPS server address.")),
  });

const invalidHostError = () =>
  new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(msg("Enter a valid HTTPS server address.")),
  });

const clientMetadataFields = (clientMetadata: AuthClientPresentationMetadata | undefined) => {
  const displayOs = clientMetadata?.os;
  return {
    ...(clientMetadata?.label ? { client_label: clientMetadata.label } : {}),
    ...(clientMetadata?.deviceType ? { client_device_type: clientMetadata.deviceType } : {}),
    ...(displayOs && displayOs !== "unknown" && displayOs !== "other"
      ? { client_os: displayOs }
      : {}),
  };
};

const isRedirectStatus = (status: number): boolean =>
  // Browsers report manual-mode redirects as opaque responses with status 0.
  status === 0 || (status >= 300 && status < 400);

const redirectRejectedError = () =>
  new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg("The server redirected the request. Enter its final HTTPS address directly."),
    ),
    hop: "server",
    via: "direct",
  });

function mapOwnerPasswordProbeError(error: RemoteEnvironmentRequestError): ConnectionAttemptError {
  if (
    error._tag === "RemoteEnvironmentAuthUndeclaredStatusError" &&
    isRedirectStatus(error.status)
  ) {
    return redirectRejectedError();
  }
  return mapRemoteEnvironmentError(error, "direct");
}

function mapOwnerPasswordTokenError(error: RemoteEnvironmentRequestError): ConnectionAttemptError {
  if (error._tag === "RemoteEnvironmentAuthUndeclaredStatusError") {
    if (isRedirectStatus(error.status)) {
      return redirectRejectedError();
    }
    if (error.status === 429) {
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        ...translatableDetail(msg("Too many sign-in attempts. Wait a moment and try again.")),
        hop: "server",
        via: "direct",
        httpStatus: 429,
      });
    }
  }
  if (error._tag === "EnvironmentAuthInvalidError") {
    if (error.dpopFailureReason === "time_window") {
      return new ConnectionBlockedError({
        reason: "authentication",
        ...translatableDetail(
          ...dpopFailureText(msg("The environment credential is invalid."), "time_window"),
        ),
        traceId: error.traceId,
        hop: "server",
        via: "direct",
        failureCause: "clock_skew",
      });
    }
    if (error.dpopFailureReason !== undefined) {
      return new ConnectionBlockedError({
        reason: "authentication",
        ...translatableDetail(
          ...dpopFailureText(
            msg("The server rejected this device's sign-in proof."),
            error.dpopFailureReason,
          ),
        ),
        traceId: error.traceId,
        hop: "server",
        via: "direct",
      });
    }
    return new ConnectionBlockedError({
      reason: "authentication",
      ...translatableDetail(msg("That password didn't work. Try again.")),
      traceId: error.traceId,
      hop: "server",
      via: "direct",
    });
  }
  return mapRemoteEnvironmentError(error, "direct");
}

export const normalizeOwnerPasswordOrigin = Effect.fn(
  "clientRuntime.authorization.normalizeOwnerPasswordOrigin",
)(function* (host: string): Effect.fn.Return<string, ConnectionBlockedError> {
  const trimmed = host.trim();
  if (trimmed === "") {
    return yield* invalidHostError();
  }
  if (trimmed.startsWith("/")) {
    return yield* invalidHostError();
  }

  let candidate: string;
  if (EXPLICIT_SCHEME_WITH_AUTHORITY.test(trimmed)) {
    candidate = trimmed;
  } else if (EXPLICIT_NON_PORT_SCHEME.test(trimmed)) {
    return yield* httpsRequiredError();
  } else {
    candidate = `https://${trimmed}`;
  }

  const parsed = yield* Effect.try({
    try: () => new URL(candidate),
    catch: () => invalidHostError(),
  });

  if (parsed.protocol !== "https:") {
    return yield* httpsRequiredError();
  }
  if (
    parsed.hostname === "" ||
    parsed.origin === "null" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return yield* invalidHostError();
  }
  return parsed.origin;
});

export const fetchOwnerPasswordDescriptor = Effect.fn(
  "clientRuntime.authorization.fetchOwnerPasswordDescriptor",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly timeoutMs?: number;
}) {
  return yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: input.httpBaseUrl,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.provideService(FetchHttpClient.RequestInit, OWNER_PASSWORD_FETCH_INIT),
    Effect.mapError(mapOwnerPasswordProbeError),
  );
});

export const fetchAnonymousRemoteSessionState = Effect.fn(
  "clientRuntime.authorization.fetchAnonymousRemoteSessionState",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth").pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
  );
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/session"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.session({ headers: {} }),
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.provideService(FetchHttpClient.RequestInit, OWNER_PASSWORD_FETCH_INIT),
    Effect.mapError(mapOwnerPasswordProbeError),
  );
});

export const exchangeOwnerPasswordForAccessToken = Effect.fn(
  "clientRuntime.authorization.exchangeOwnerPasswordForAccessToken",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly password: Redacted.Redacted<string>;
  readonly clientMetadata?: AuthClientPresentationMetadata | undefined;
  readonly dpopSigner?: ManagedRelay.ManagedRelayDpopSigner["Service"] | undefined;
  readonly supportsAccessTokenRenewal: boolean;
  readonly httpClient: HttpClient.HttpClient;
  readonly timeoutMs?: number;
}): Effect.fn.Return<ConnectionCredential, ConnectionAttemptError> {
  const tokenUrl = environmentEndpointUrl(input.httpBaseUrl, AUTH_OWNER_PASSWORD_TOKEN_PATH);
  const dpopProof =
    input.supportsAccessTokenRenewal && input.dpopSigner !== undefined
      ? yield* input.dpopSigner
          .createProof({
            method: "POST",
            url: tokenUrl,
          })
          .pipe(
            Effect.mapError(
              () =>
                new ConnectionBlockedError({
                  reason: "configuration",
                  ...translatableDetail(msg("Could not create the sign-in authorization proof.")),
                }),
            ),
          )
      : undefined;

  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth").pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
  );
  const response = yield* executeEnvironmentHttpRequest(
    tokenUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.ownerPasswordToken({
      headers: dpopProof !== undefined ? { dpop: dpopProof } : {},
      payload: {
        password: input.password,
        ...clientMetadataFields(input.clientMetadata),
      },
    }),
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.provideService(FetchHttpClient.RequestInit, OWNER_PASSWORD_FETCH_INIT),
    Effect.mapError(mapOwnerPasswordTokenError),
  );

  if (dpopProof !== undefined) {
    if (response.token_type !== "DPoP") {
      return yield* new ConnectionBlockedError({
        reason: "authentication",
        ...translatableDetail(
          msg("The server returned an unexpected token type for DPoP sign-in."),
        ),
        hop: "server",
        via: "direct",
      });
    }
    return new DpopConnectionCredential({
      accessToken: response.access_token,
      expiresAtEpochMs: (yield* Clock.currentTimeMillis) + response.expires_in * 1_000,
    });
  }

  if (response.token_type !== "Bearer") {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      ...translatableDetail(
        msg("The server returned an unexpected token type for bearer sign-in."),
      ),
      hop: "server",
      via: "direct",
    });
  }
  return new BearerConnectionCredential({
    token: response.access_token,
  });
});

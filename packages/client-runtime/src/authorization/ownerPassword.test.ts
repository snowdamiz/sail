import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";

import { ManagedRelayDpopProofCreationError } from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import { exchangeOwnerPasswordForAccessToken } from "./ownerPassword.ts";

describe("owner-password access token exchange", () => {
  it.effect("aborts sign-in without sending a Bearer POST when DPoP proof creation fails", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((input, init) => {
        calls.push([input, init ?? {}]);
        return Promise.resolve(
          Response.json({
            access_token: "unexpected-bearer-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "orchestration:read",
          }),
        );
      }) satisfies typeof fetch;

      const error = yield* Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        return yield* exchangeOwnerPasswordForAccessToken({
          httpBaseUrl: "https://my-sail.fly.dev",
          password: Redacted.make("correct horse battery staple"),
          supportsAccessTokenRenewal: true,
          dpopSigner: {
            thumbprint: Effect.succeed("device-key-thumbprint"),
            createProof: ({ method, url }) =>
              Effect.fail(
                new ManagedRelayDpopProofCreationError({
                  method,
                  url,
                  cause: new Error("keychain locked"),
                }),
              ),
          },
          httpClient,
        });
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)), Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        detail: "Could not create the sign-in authorization proof.",
      });
      expect(calls).toHaveLength(0);
    }),
  );
});

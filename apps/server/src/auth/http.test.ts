import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AUTH_OWNER_PASSWORD_TOKEN_PATH,
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  AuthAccessTokenResult,
  AuthOwnerPasswordV1Scopes,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import * as ServerHttp from "../http.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { makeAdmission, ServerAdmission } from "../serverAdmission.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.metadata) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      ownerPasswordEnabled: true,
      publicUrl: new URL("https://sail.example"),
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
  Layer.provide(ServerEnvironment.layer),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeAccessToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.promise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          expect(devCookies.filter((cookie) => /;\s*Secure/i.test(cookie))).toEqual([]);
          const httpsResponse = await environmentA.handler(
            postJson(
              "/api/auth/browser-session",
              { credential: DEV_TOKEN },
              { "x-forwarded-proto": "https" },
            ),
            requestContext,
          );
          const httpsCookies = httpsResponse.headers.getSetCookie();
          expect(httpsCookies).toHaveLength(2);
          for (const cookie of httpsCookies) expect(cookie).toMatch(/;\s*Secure/i);
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const withDevSessionRoutes = (
  run: (
    request: (
      path: string,
      body: unknown,
      headers?: Readonly<Record<string, string>>,
    ) => Promise<Response>,
    devCookie: string,
  ) => Promise<void>,
) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const request = (
            path: string,
            body: unknown,
            headers?: Readonly<Record<string, string>>,
          ) => environment.handler(postJson(path, body, headers), requestContext);
          const dev = await request("/api/auth/browser-session", { credential: DEV_TOKEN });
          const devCookie = dev.headers
            .getSetCookie()
            .find((cookie) => cookie.startsWith("t3_dev_session_"))
            ?.split(";", 1)[0];
          await run(request, devCookie ?? "");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.effect(
  "sets a password after pairing and issues a standard browser cookie for password sign-in",
  () =>
    withDevSessionRoutes(async (request, devCookie) => {
      const minted = await request("/api/auth/pairing-token", {}, { cookie: devCookie });
      const { credential } = (await minted.json()) as { credential: string };
      const paired = await request("/api/auth/browser-session", { credential });
      expect(paired.status).toBe(200);
      const ownerCookie = paired.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
      const password = "sample-browser-password";
      const publicOrigin = {
        host: "sail.example",
        origin: "https://sail.example",
        "x-forwarded-proto": "https",
      };
      const enrolled = await request(
        "/api/auth/owner-password",
        { password },
        { cookie: ownerCookie, ...publicOrigin },
      );
      expect(enrolled.status).toBe(200);
      expect(await enrolled.json()).toMatchObject({ ownerPassword: "configured" });
      const signedIn = await request(
        "/api/auth/owner-password/session",
        { password },
        publicOrigin,
      );
      expect(signedIn.status).toBe(200);
      expect(await signedIn.json()).toMatchObject({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
      });
      expect(signedIn.headers.getSetCookie()).toEqual([
        expect.stringMatching(/^t3_session_.*HttpOnly.*Secure/i),
      ]);
    }),
);

it.effect("tells a browser that a pairing link was already used", () =>
  withDevSessionRoutes(async (request, devCookie) => {
    const exchange = (credential: string) => request("/api/auth/browser-session", { credential });
    const minted = await request("/api/auth/pairing-token", {}, { cookie: devCookie });
    const { credential } = (await minted.json()) as { credential: string };
    expect((await exchange(credential)).status).toBe(200);

    const reused = await exchange(credential);
    expect(reused.status).toBe(401);
    expect(await reused.json()).toMatchObject({
      reason: "invalid_credential",
      pairingFailureReason: "used_or_expired",
    });
    const unknown = await exchange("ZZZZZZZZZZZZ");
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).not.toHaveProperty("pairingFailureReason");
  }),
);

it.effect("gives every pairing code minted over HTTP the default lifetime", () =>
  withDevSessionRoutes(async (request, devCookie) => {
    const expiresAt = async (body: unknown) => {
      const minted = await request("/api/auth/pairing-token", body, { cookie: devCookie });
      expect(minted.status).toBe(200);
      return Date.parse(((await minted.json()) as { expiresAt: string }).expiresAt);
    };
    const year = 365 * 24 * 60 * 60 * 1000;
    const standard = await expiresAt({});

    for (const body of [
      { ttlMs: year },
      { access: "full-access", ttlMs: year },
      { access: "full-access", purpose: "peer-link", ttlMs: year },
    ]) {
      expect(Math.abs((await expiresAt(body)) - standard)).toBeLessThan(60_000);
    }
  }),
);

it.effect.each(["DPoP", "dpop"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const refused = await environment.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { authorization: `${scheme} not-a-valid-token` },
            ),
            requestContext,
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

// The web handler runs on its own runtime, so proofs need wall-clock time.
it.live("checks token-endpoint DPoP proofs without writing replay state", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const written: Array<string> = [];
    const recordingSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: (name) => Effect.sync(() => void written.push(name)),
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const admission = makeAdmission(Effect.succeed([]));
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, recordingSecretStore),
      Context.add(ServerAdmission, admission),
    );
    const url = "http://127.0.0.1/oauth/token";
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const tokenRequest = (subjectToken: string, proof: string) =>
      new Request(url, {
        method: "POST",
        headers: { host: "127.0.0.1", dpop: proof },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: subjectToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.gen(function* () {
          const request = (input: Request) =>
            Effect.promise(() => environment.handler(input, requestContext));
          const unknownToken = yield* request(
            tokenRequest("not-a-pairing-token", key.sign({ method: "POST", url, token: "", iat })),
          );
          expect(unknownToken.status).toBe(401);
          expect(yield* Effect.promise(() => unknownToken.json())).not.toHaveProperty(
            "dpopFailureReason",
          );

          const accepted = yield* request(
            tokenRequest(DEV_TOKEN, key.sign({ method: "POST", url, token: "", iat })),
          );
          expect(accepted.status).toBe(200);
          const issued = yield* decodeAccessToken(yield* Effect.promise(() => accepted.json()));
          expect(issued.token_type).toBe("DPoP");

          const badProof = yield* request(tokenRequest(DEV_TOKEN, "not-a-proof"));
          expect(badProof.status).toBe(401);
          expect(badProof.headers.get("www-authenticate")).toBe("DPoP");
          expect(written).toEqual([]);

          const token = issued.access_token;
          const sessionUrl = "http://127.0.0.1/api/auth/session";
          const proof = key.sign({ method: "GET", url: sessionUrl, token, iat });
          const sessionRequest = () =>
            new Request(sessionUrl, {
              headers: { authorization: `DPoP ${token}`, dpop: proof, host: "127.0.0.1" },
            });
          const seal = Symbol();
          expect(yield* admission.drain(seal, "10 seconds")).toEqual({
            kind: "sealed",
          });
          const deferred = yield* request(sessionRequest());
          expect(deferred.status).toBe(503);
          expect(deferred.headers.get("retry-after")).toBe("1");
          expect(yield* Effect.promise(() => deferred.json())).toMatchObject({
            code: "maintenance",
            retryable: true,
          });
          expect(written).toEqual([]);
          expect(yield* admission.abort(seal)).toBe(true);
          const resumed = yield* request(sessionRequest());
          expect(resumed.status).toBe(200);
          expect(yield* Effect.promise(() => resumed.json())).toMatchObject({
            authenticated: true,
          });
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "exposes ownerPasswordToken capability and enforces HTTP token, DPoP, CORS, and rotation flows",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);
      const clock = yield* Clock.Clock;
      const random = yield* SecureRandom.SecureRandom;
      const initialPassword = "http-owner-password-value";
      const rotatedPassword = "http-rotated-owner-password-value";
      const origin = "https://sail.example";
      const tokenUrl = `${origin}${AUTH_OWNER_PASSWORD_TOKEN_PATH}`;
      const layerProdConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            mode: "web",
            ownerPasswordEnabled: true,
            initialOwnerPassword: Redacted.make(initialPassword),
            publicUrl: new URL(origin),
            devUrl: undefined,
          } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-pw-test-" })),
      );
      const layerProdSecrets = ServerSecretStore.layer.pipe(
        Layer.provide(layerProdConfig),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const layerProdAuth = EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(layerProdSecrets),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerProdConfig),
      );
      const layerProdRoutes = Layer.merge(
        HttpApiBuilder.layer(AuthTestApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
          Layer.provide(ServerEnvironment.layer),
          Layer.provideMerge(layerProdAuth),
          Layer.provideMerge(layerProdSecrets),
          Layer.provide(layerProdConfig),
        ),
        ServerHttp.layerBrowserApiCors.pipe(Layer.provide(layerProdConfig)),
      ).pipe(
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
        Context.add(Clock.Clock, clock),
      );
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layerProdRoutes, { disableLogger: true })),
        (environment) =>
          Effect.gen(function* () {
            const send = (input: Request) =>
              Effect.promise(() => environment.handler(input, requestContext));
            const postToken = (body: unknown, headers?: Readonly<Record<string, string>>) =>
              send(
                new Request(tokenUrl, {
                  method: "POST",
                  headers: {
                    host: "sail.example",
                    "content-type": "application/json",
                    ...headers,
                  },
                  body: encodeJson(body),
                }),
              );

            const metadataResponse = yield* send(
              new Request(`${origin}/.well-known/t3/environment`, {
                headers: { host: "sail.example" },
              }),
            );
            expect(metadataResponse.status).toBe(200);
            expect(yield* Effect.promise(() => metadataResponse.json())).toMatchObject({
              capabilities: { ownerPasswordToken: true },
            });

            const evilPreflight = yield* send(
              new Request(tokenUrl, {
                method: "OPTIONS",
                headers: { host: "sail.example", origin: "https://evil.example" },
              }),
            );
            expect(evilPreflight.headers.get("access-control-allow-origin")).toBeNull();
            const evilPost = yield* postToken(
              { password: initialPassword },
              { origin: "https://evil.example" },
            );
            expect(evilPost.status).toBe(401);
            expect(evilPost.headers.get("access-control-allow-origin")).toBeNull();
            expect(evilPost.headers.get("www-authenticate")).toBeNull();
            expect(evilPost.headers.get("cache-control")).toBe("no-store");
            expect(yield* Effect.promise(() => evilPost.json())).toMatchObject({
              reason: "invalid_credential",
            });

            const emptyDpop = yield* postToken({ password: initialPassword }, { dpop: "" });
            expect(emptyDpop.status).toBe(401);
            expect(emptyDpop.headers.get("www-authenticate")).toBe('DPoP algs="ES256"');
            expect(yield* Effect.promise(() => emptyDpop.json())).toMatchObject({
              reason: "invalid_credential",
              dpopFailureReason: "invalid_proof",
            });

            const desktopKey = makeDpopKey();
            const nowSec = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
            const skewedProof = desktopKey.sign({
              method: "POST",
              url: tokenUrl,
              token: "",
              iat: nowSec - 600,
            });
            const skewed = yield* postToken({ password: initialPassword }, { dpop: skewedProof });
            expect(skewed.status).toBe(401);
            expect(skewed.headers.get("www-authenticate")).toBe('DPoP algs="ES256"');
            expect(yield* Effect.promise(() => skewed.json())).toMatchObject({
              reason: "invalid_credential",
              dpopFailureReason: "time_window",
            });

            const validProof = desktopKey.sign({
              method: "POST",
              url: tokenUrl,
              token: "",
              iat: nowSec,
            });
            const dpopResponse = yield* postToken(
              {
                password: initialPassword,
                client_label: "Work MacBook",
                client_device_type: "desktop",
                client_os: "macOS",
              },
              { dpop: validProof },
            );
            expect(dpopResponse.status).toBe(200);
            expect(dpopResponse.headers.get("cache-control")).toBe("no-store");
            expect(dpopResponse.headers.get("pragma")).toBe("no-cache");
            expect(dpopResponse.headers.getSetCookie()).toEqual([]);
            expect(dpopResponse.headers.get("access-control-allow-origin")).toBe("*");
            expect(dpopResponse.headers.get("vary")).toContain("Origin");
            const dpopToken = yield* decodeAccessToken(
              yield* Effect.promise(() => dpopResponse.json()),
            );
            expect(dpopToken.token_type).toBe("DPoP");
            expect(dpopToken.scope).toBe(encodeOAuthScope(AuthOwnerPasswordV1Scopes));

            yield* TestClock.adjust("1 second");
            const replayed = yield* postToken({ password: initialPassword }, { dpop: validProof });
            expect(replayed.status).toBe(401);
            expect(replayed.headers.get("www-authenticate")).toBe('DPoP algs="ES256"');
            expect(yield* Effect.promise(() => replayed.json())).toMatchObject({
              reason: "invalid_credential",
              dpopFailureReason: "replay",
            });

            yield* TestClock.adjust("1 second");
            const bearerResponse = yield* postToken({ password: initialPassword });
            expect(bearerResponse.status).toBe(200);
            expect(bearerResponse.headers.get("cache-control")).toBe("no-store");
            expect(bearerResponse.headers.getSetCookie()).toEqual([]);
            const bearerToken = yield* decodeAccessToken(
              yield* Effect.promise(() => bearerResponse.json()),
            );
            expect(bearerToken.token_type).toBe("Bearer");

            const oauthUrl = `${origin}/oauth/token`;
            const renewNowSec = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
            const renewResponse = yield* send(
              new Request(oauthUrl, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  dpop: desktopKey.sign({
                    method: "POST",
                    url: oauthUrl,
                    token: "",
                    iat: renewNowSec,
                  }),
                },
                body: new URLSearchParams({
                  grant_type: AuthTokenExchangeGrantType,
                  subject_token: dpopToken.access_token,
                  subject_token_type: AuthAccessTokenType,
                  requested_token_type: AuthAccessTokenType,
                }),
              }),
            );
            expect(renewResponse.status).toBe(200);
            const renewedToken = yield* decodeAccessToken(
              yield* Effect.promise(() => renewResponse.json()),
            );
            expect(renewedToken.token_type).toBe("DPoP");
            expect(renewedToken.scope).toBe(encodeOAuthScope(AuthOwnerPasswordV1Scopes));

            const rotateUrl = `${origin}/api/auth/owner-password`;
            const dpopRotate = yield* send(
              new Request(rotateUrl, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  origin,
                  "content-type": "application/json",
                  authorization: `DPoP ${renewedToken.access_token}`,
                  dpop: desktopKey.sign({
                    method: "POST",
                    url: rotateUrl,
                    token: renewedToken.access_token,
                    iat: renewNowSec,
                  }),
                },
                body: encodeJson({ password: rotatedPassword }),
              }),
            );
            expect(dpopRotate.status).toBe(401);
            const bearerRotate = yield* send(
              new Request(rotateUrl, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  origin,
                  "content-type": "application/json",
                  authorization: `Bearer ${bearerToken.access_token}`,
                },
                body: encodeJson({ password: rotatedPassword }),
              }),
            );
            expect(bearerRotate.status).toBe(401);

            const pairForBrowser = yield* send(
              new Request(`${origin}/api/auth/pairing-token`, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  "content-type": "application/json",
                  authorization: `Bearer ${bearerToken.access_token}`,
                },
                body: encodeJson({}),
              }),
            );
            expect(pairForBrowser.status).toBe(200);
            const browserPair = (yield* Effect.promise(() => pairForBrowser.json())) as {
              credential: string;
            };
            const pairedBrowser = yield* send(
              new Request(`${origin}/api/auth/browser-session`, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  "content-type": "application/json",
                },
                body: encodeJson({ credential: browserPair.credential }),
              }),
            );
            expect(pairedBrowser.status).toBe(200);
            const pairedCookie = pairedBrowser.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";

            const pairForClient = yield* send(
              new Request(`${origin}/api/auth/pairing-token`, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  "content-type": "application/json",
                  cookie: pairedCookie,
                },
                body: encodeJson({}),
              }),
            );
            const clientPair = (yield* Effect.promise(() => pairForClient.json())) as {
              credential: string;
            };
            const pairedTokenResp = yield* send(
              new Request(oauthUrl, {
                method: "POST",
                headers: { host: "sail.example" },
                body: new URLSearchParams({
                  grant_type: AuthTokenExchangeGrantType,
                  subject_token: clientPair.credential,
                  subject_token_type: AuthEnvironmentBootstrapTokenType,
                  requested_token_type: AuthAccessTokenType,
                }),
              }),
            );
            expect(pairedTokenResp.status).toBe(200);
            const pairedAccessToken = yield* decodeAccessToken(
              yield* Effect.promise(() => pairedTokenResp.json()),
            );

            yield* TestClock.adjust("1 second");
            const browserPwResp = yield* send(
              new Request(`${origin}/api/auth/owner-password/session`, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  origin,
                  "content-type": "application/json",
                },
                body: encodeJson({ password: initialPassword }),
              }),
            );
            expect(browserPwResp.status).toBe(200);
            const pwCookie = browserPwResp.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";

            const rotated = yield* send(
              new Request(rotateUrl, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  origin,
                  "content-type": "application/json",
                  cookie: pairedCookie,
                },
                body: encodeJson({ password: rotatedPassword }),
              }),
            );
            expect(rotated.status).toBe(200);

            const sessionUrl = `${origin}/api/auth/session`;
            const pwCookieState = yield* send(
              new Request(sessionUrl, { headers: { host: "sail.example", cookie: pwCookie } }),
            );
            expect(yield* Effect.promise(() => pwCookieState.json())).toMatchObject({
              authenticated: false,
            });
            const bearerState = yield* send(
              new Request(sessionUrl, {
                headers: {
                  host: "sail.example",
                  authorization: `Bearer ${bearerToken.access_token}`,
                },
              }),
            );
            expect(yield* Effect.promise(() => bearerState.json())).toMatchObject({
              authenticated: false,
            });
            const afterRotateSec = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
            const dpopState = yield* send(
              new Request(sessionUrl, {
                headers: {
                  host: "sail.example",
                  authorization: `DPoP ${renewedToken.access_token}`,
                  dpop: desktopKey.sign({
                    method: "GET",
                    url: sessionUrl,
                    token: renewedToken.access_token,
                    iat: afterRotateSec,
                  }),
                },
              }),
            );
            expect(yield* Effect.promise(() => dpopState.json())).toMatchObject({
              authenticated: false,
            });
            const revokedRenew = yield* send(
              new Request(oauthUrl, {
                method: "POST",
                headers: {
                  host: "sail.example",
                  dpop: desktopKey.sign({
                    method: "POST",
                    url: oauthUrl,
                    token: "",
                    iat: afterRotateSec,
                  }),
                },
                body: new URLSearchParams({
                  grant_type: AuthTokenExchangeGrantType,
                  subject_token: renewedToken.access_token,
                  subject_token_type: AuthAccessTokenType,
                  requested_token_type: AuthAccessTokenType,
                }),
              }),
            );
            expect(revokedRenew.status).toBe(401);

            const pairedCookieState = yield* send(
              new Request(sessionUrl, { headers: { host: "sail.example", cookie: pairedCookie } }),
            );
            expect(yield* Effect.promise(() => pairedCookieState.json())).toMatchObject({
              authenticated: true,
            });
            const pairedTokenState = yield* send(
              new Request(sessionUrl, {
                headers: {
                  host: "sail.example",
                  authorization: `Bearer ${pairedAccessToken.access_token}`,
                },
              }),
            );
            expect(yield* Effect.promise(() => pairedTokenState.json())).toMatchObject({
              authenticated: true,
            });
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "allows desktop renderer Origin on *.localhost HTTPS hosts without devUrl for owner-password token requests",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);
      const clock = yield* Clock.Clock;
      const random = yield* SecureRandom.SecureRandom;
      const initialPassword = "localhost-subdomain-owner-password";
      const origin = "https://sail.localhost";
      const tokenUrl = `${origin}${AUTH_OWNER_PASSWORD_TOKEN_PATH}`;
      const layerLoopbackConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            mode: "web",
            ownerPasswordEnabled: true,
            initialOwnerPassword: Redacted.make(initialPassword),
            publicUrl: new URL(origin),
            devUrl: undefined,
          } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-localhost-test-" }),
        ),
      );
      const layerLoopbackSecrets = ServerSecretStore.layer.pipe(
        Layer.provide(layerLoopbackConfig),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const layerLoopbackAuth = EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(layerLoopbackSecrets),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerLoopbackConfig),
      );
      const layerLoopbackRoutes = Layer.merge(
        HttpApiBuilder.layer(AuthTestApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
          Layer.provide(ServerEnvironment.layer),
          Layer.provideMerge(layerLoopbackAuth),
          Layer.provideMerge(layerLoopbackSecrets),
          Layer.provide(layerLoopbackConfig),
        ),
        ServerHttp.layerBrowserApiCors.pipe(Layer.provide(layerLoopbackConfig)),
      ).pipe(
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
        Context.add(Clock.Clock, clock),
      );
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layerLoopbackRoutes, { disableLogger: true })),
        (environment) =>
          Effect.gen(function* () {
            const send = (input: Request) =>
              Effect.promise(() => environment.handler(input, requestContext));

            const preflight = yield* send(
              new Request(tokenUrl, {
                method: "OPTIONS",
                headers: { host: "sail.localhost", origin: "sail-dev://app" },
              }),
            );
            expect(preflight.status).toBe(204);
            expect(preflight.headers.get("access-control-allow-origin")).toBe("sail-dev://app");

            const tokenResponse = yield* send(
              new Request(tokenUrl, {
                method: "POST",
                headers: {
                  host: "sail.localhost",
                  origin: "sail-dev://app",
                  "content-type": "application/json",
                },
                body: encodeJson({ password: initialPassword }),
              }),
            );
            expect(tokenResponse.status).toBe(200);
            expect(tokenResponse.headers.get("access-control-allow-origin")).toBe("sail-dev://app");
            const issued = yield* decodeAccessToken(
              yield* Effect.promise(() => tokenResponse.json()),
            );
            expect(issued.token_type).toBe("Bearer");
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

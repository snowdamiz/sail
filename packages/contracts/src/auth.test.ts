import { describe, expect, it } from "vite-plus/test";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { EnvironmentAuthInvalidError, EnvironmentHttpApi } from "./environmentHttp.ts";
import {
  AUTH_OWNER_PASSWORD_TOKEN_PATH,
  AuthOwnerPasswordSubject,
  AuthOwnerPasswordTokenRequest,
  AuthEnvironmentScopes,
  AuthEnvironmentScope,
  authScopeRequiredResponse,
  AuthGrantScopes,
  AuthStandardClientScopes,
  authScopeResponse,
  AuthSessionState,
  sessionGrantsScope,
} from "./auth.ts";

describe("authorization grants", () => {
  it("decodes legacy review credentials without offering them in new grants", () => {
    const decodeAuthEnvironmentScopes = Schema.decodeSync(AuthEnvironmentScopes);

    expect(decodeAuthEnvironmentScopes(["review:write"])).toEqual(["review:write"]);
    const decodeAuthGrantScopes = Schema.decodeUnknownSync(AuthGrantScopes);

    expect(() => decodeAuthGrantScopes(["review:write"])).toThrow();
    expect(AuthStandardClientScopes).not.toContain("review:write");
  });

  // Keep the pre-granular vocabulary frozen to expose compatibility regressions.
  const oldScopes = Schema.Array(
    Schema.Literals([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "access:read",
      "access:write",
      "relay:read",
      "relay:write",
    ]),
  );

  const decodeOldScopes = Schema.decodeUnknownSync(oldScopes);

  it.each(AuthEnvironmentScope.literals)(
    "keeps %s permission errors decodable by old clients",
    (scope) => {
      const response = authScopeRequiredResponse(scope);
      expect(decodeOldScopes([response.requiredScope])).toEqual([response.requiredScope]);
      expect(response.requiredPermission).toBe(scope);
    },
  );

  it("keeps old clients able to decode grants with new permissions", () => {
    const response = authScopeResponse(AuthStandardClientScopes);
    expect(decodeOldScopes(response.scopes)).toEqual(response.scopes);
    expect(response.permissions).toEqual(AuthStandardClientScopes);
    expect(response.scopes).not.toContain("filesystem:read");
  });

  it("ignores unknown response permissions without falling back to broader scopes", () => {
    const decodeAuthSessionState = Schema.decodeUnknownSync(AuthSessionState);

    const session = decodeAuthSessionState({
      authenticated: true,
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: ["orchestration:operate"],
      permissions: ["future:permission"],
    });
    expect(session.permissions).toEqual([]);
    expect(sessionGrantsScope(session, "orchestration:operate")).toBe(false);
    expect(sessionGrantsScope(session, "settings:write")).toBe(false);
  });

  it.each([
    {
      label: "exact permissions over the legacy presentation",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        permissions: ["filesystem:read"],
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "a permission absent from the legacy presentation",
      session: { authenticated: true, scopes: [], permissions: ["filesystem:read"] },
      scope: "filesystem:read",
      expected: true,
    },

    {
      label: "the parent on a server that predates the split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "only the exact scope on a server that knows the split",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: { serverUpdateScope: "environment:maintain" },
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "the exact scope regardless of server version",
      session: { authenticated: true, scopes: ["settings:write"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "nothing for an unauthenticated session",
      session: { authenticated: false, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "no parent for scopes that were never split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "access:write",
      expected: false,
    },
  ] as const)("sessionGrantsScope accepts $label", ({ session, scope, expected }) => {
    expect(sessionGrantsScope(session, scope)).toBe(expected);
  });
});

describe("pairing link failures", () => {
  it("decodes a rejection whose pairing failure reason this client does not know", () => {
    const decode = Schema.decodeUnknownSync(EnvironmentAuthInvalidError);
    const rejection = {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace",
    };

    expect(decode({ ...rejection, pairingFailureReason: "used_or_expired" })).toMatchObject({
      pairingFailureReason: "used_or_expired",
    });
    expect(decode({ ...rejection, pairingFailureReason: "revoked" })).not.toHaveProperty(
      "pairingFailureReason",
    );
  });
});

describe("owner password token request", () => {
  const decodeRequest = Schema.decodeUnknownSync(AuthOwnerPasswordTokenRequest);

  it("preserves whitespace and Unicode in a redacted password", () => {
    const rawPassword = "  pässwörd 🚀 \t ";
    const decoded = decodeRequest({ password: rawPassword });

    expect(Redacted.isRedacted(decoded.password)).toBe(true);
    expect(Redacted.value(decoded.password)).toBe(rawPassword);
    expect(decoded.client_label).toBeUndefined();
    expect(decoded.client_device_type).toBeUndefined();
    expect(decoded.client_os).toBeUndefined();
  });

  it("accepts optional client metadata and rejects invalid client_device_type", () => {
    const decoded = decodeRequest({
      password: "correct horse battery staple",
      client_label: "  Work MacBook  ",
      client_device_type: "desktop",
      client_os: "  macOS  ",
    });

    expect(decoded.client_label).toBe("Work MacBook");
    expect(decoded.client_device_type).toBe("desktop");
    expect(decoded.client_os).toBe("macOS");
    expect(() =>
      decodeRequest({
        password: "correct horse battery staple",
        client_device_type: "watch",
      }),
    ).toThrow();
  });

  it("registers ownerPasswordToken with raw optional DPoP headers", () => {
    const endpoint = EnvironmentHttpApi.groups.auth.endpoints.ownerPasswordToken;
    expect(AUTH_OWNER_PASSWORD_TOKEN_PATH).toBe("/api/auth/owner-password/token");
    expect(AuthOwnerPasswordSubject).toBe("owner-password");
    expect(endpoint.path).toBe(AUTH_OWNER_PASSWORD_TOKEN_PATH);
    expect(endpoint.headers).toBeDefined();

    const decodeHeaders = Schema.decodeUnknownSync(endpoint.headers as Schema.Codec<unknown>);
    expect(decodeHeaders({})).toEqual({});
    expect(decodeHeaders({ dpop: "" })).toEqual({ dpop: "" });
    expect(decodeHeaders({ dpop: " proof " })).toEqual({ dpop: " proof " });
  });
});

import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { oauthCallbackUrl } from "./oauthCallback.ts";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";
import { parseUrl } from "./url.ts";

export const CodexAuthHandoff = Schema.Struct({
  authorizationUrl: Schema.String.check(Schema.isMaxLength(16_384)),
  returnUrl: Schema.String.check(Schema.isMaxLength(4_096)),
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  flowId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type CodexAuthHandoff = typeof CodexAuthHandoff.Type;
const Delivery = Schema.Struct({
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  flowId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  callbackUrl: Schema.String.check(Schema.isMaxLength(16_384)),
  returnHash: Schema.String.check(Schema.isMaxLength(128)),
});

const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(CodexAuthHandoff));
const decodeHandoff = Schema.decodeUnknownSync(Schema.fromJsonString(CodexAuthHandoff));
const encodeDelivery = Schema.encodeSync(Schema.fromJsonString(Delivery));
const decodeDelivery = Schema.decodeUnknownSync(Schema.fromJsonString(Delivery));

export function codexAuthorizationRequest(value: string) {
  const url = new URL(value);
  if (
    value.length > 16_384 ||
    url.origin !== "https://auth.openai.com" ||
    url.pathname !== "/api/accounts/authorize" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Invalid ChatGPT sign-in request.");
  const single = (key: string) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) throw new Error("Invalid ChatGPT sign-in request.");
    return values[0];
  };
  const redirectUri = single("redirect_uri");
  const redirect = new URL(redirectUri);
  const state = single("state");
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/auth\/callback$/u.test(redirectUri) ||
    Number(redirect.port) > 65_535 ||
    !/^[\w-]{16,128}$/u.test(state) ||
    single("response_type") !== "code" ||
    single("code_challenge_method") !== "S256" ||
    !/^[\w-]{43}$/u.test(single("code_challenge")) ||
    !/^(dynamic_agent_client|oaiapp_[\w-]+)$/u.test(single("client_id"))
  )
    throw new Error("Invalid ChatGPT sign-in request.");
  return { authorizationUrl: url.toString(), redirectUri, state };
}

export function codexCallbackUrl(value: string, redirectUri: string, state: string) {
  const callback = oauthCallbackUrl(value, redirectUri, state);
  const clients = callback.searchParams.getAll("client_id");
  if (clients.length > 1 || (clients.length === 1 && !/^oaiapp_[\w-]+$/u.test(clients[0]!)))
    throw new Error("This redirect URL does not belong to the current sign-in.");
  return callback;
}

export function codexAuthHandoffUrl(input: CodexAuthHandoff, development = false) {
  const url = new URL(`${development ? "sail-dev" : "sail"}://auth/codex`);
  url.searchParams.set("request", encodeHandoff(input));
  return url.toString();
}

function handoffLink(value: string, development: boolean) {
  const url = parseUrl(value);
  return url !== null &&
    value.length <= 32_768 &&
    (development ? ["sail-dev:", "t3code-dev:"] : ["sail:", "t3code:"]).includes(url.protocol) &&
    url.host === "auth" &&
    url.pathname === "/codex"
    ? url
    : null;
}

// Any app on this computer can register an app scheme, so a code goes only to a web page.
export function codexAuthReturnUrl(
  value: string,
  trustedOrigins: ReadonlyArray<string | undefined>,
) {
  const destination = providerAuthReturnUrl(value, trustedOrigins);
  return destination !== undefined && /^https?:/u.test(destination) ? destination : undefined;
}

/** Whether a launch link asks for a handoff, before anything in it is checked or trusted. */
export function isCodexAuthHandoffLink(value: string, development: boolean): boolean {
  return handoffLink(value, development) !== null;
}

/** `trustedOrigins` are the HTTPS web apps the reader uses; the link's own claim earns no trust. */
export function readCodexAuthHandoff(
  value: string,
  development: boolean,
  trustedOrigins: ReadonlyArray<string | undefined> = [],
) {
  try {
    const url = handoffLink(value, development);
    if (
      url === null ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("request").length !== 1
    )
      return undefined;
    const input = decodeHandoff(url.searchParams.get("request"));
    codexAuthorizationRequest(input.authorizationUrl);
    if (!codexAuthReturnUrl(input.returnUrl, trustedOrigins)) return undefined;
    return input;
  } catch {
    return undefined;
  }
}

/** Codes travel in a fragment, never in hosted web requests or a token store on the helper. */
export function codexAuthDeliveryUrl(
  input: CodexAuthHandoff,
  callbackUrl: string,
  trustedOrigins: ReadonlyArray<string | undefined> = [],
) {
  const request = codexAuthorizationRequest(input.authorizationUrl);
  codexCallbackUrl(callbackUrl, request.redirectUri, request.state);
  const destination = codexAuthReturnUrl(input.returnUrl, trustedOrigins);
  if (!destination) throw new Error("Invalid T3 Code return address.");
  const url = new URL(destination);
  const delivery = {
    environmentId: input.environmentId,
    instanceId: input.instanceId,
    flowId: input.flowId,
    callbackUrl,
    returnHash: url.hash,
  };
  url.hash = `codex-auth=${encodeURIComponent(encodeDelivery(delivery))}`;
  return url.toString();
}

export function readCodexAuthDelivery(
  value: string,
  trustedOrigins: ReadonlyArray<string | undefined> = [],
) {
  try {
    const url = new URL(value);
    if (!url.hash.startsWith("#codex-auth=") || url.hash.length > 32_768) return undefined;
    const input = decodeDelivery(decodeURIComponent(url.hash.slice("#codex-auth=".length)));
    const destination = codexAuthReturnUrl(value, trustedOrigins);
    if (!destination) return undefined;
    const returnUrl = new URL(destination);
    returnUrl.hash = input.returnHash;
    const sanitized = codexAuthReturnUrl(returnUrl.toString(), trustedOrigins);
    if (!sanitized) return undefined;
    return { ...input, returnUrl: sanitized };
  } catch {
    return undefined;
  }
}

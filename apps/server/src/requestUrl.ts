import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https`. Effect 4.1
 * stopped reading it, but TLS-terminating proxies in front of the server
 * (Tailscale Serve, tunnels) rely on it for OAuth, DPoP and pairing URLs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(
    request.headers["x-forwarded-proto"] === "https" && request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  );

const firstHost = (value: string | undefined) => value?.split(",")[0]?.trim().toLowerCase();

/**
 * The web page that sent this request, when this server served it: the browser's `Origin`
 * names the host the request reached, directly or through a proxy that kept or forwarded it.
 */
export const requestPageOrigin = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined => {
  const origin = request.headers.origin;
  const url = origin ? URL.parse(origin) : null;
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  const host = url.host.toLowerCase();
  return host === firstHost(request.headers.host) ||
    host === firstHost(request.headers["x-forwarded-host"])
    ? url.origin
    : undefined;
};

import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { isLocalLoopbackHost, normalizeHostname } from "@t3tools/shared/hostClassification";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  "sail://app",
  "sail-dev://app",
  "t3code://app",
  "t3code-dev://app",
] as const;

/** MCP refuses every browser Origin with 403, so the browser CORS layer must not answer for it. */
export const MCP_HTTP_PATH = "/mcp";

export function isDesktopLoopbackOriginAllowed(input: {
  readonly devUrl: URL | undefined;
  readonly publicUrl: URL | undefined;
}): boolean {
  if (input.devUrl !== undefined) return true;
  if (input.publicUrl === undefined) return false;
  const hostname = input.publicUrl.hostname;
  return isLocalLoopbackHost(hostname) || normalizeHostname(hostname).endsWith(".localhost");
}

export function isAllowedOwnerPasswordTokenOrigin(input: {
  readonly requestOrigin: string | undefined;
  readonly publicUrl: URL | undefined;
  readonly devUrl: URL | undefined;
}): boolean {
  if (input.publicUrl === undefined || input.publicUrl.protocol !== "https:") return false;
  if (input.requestOrigin === undefined) return true;
  if (input.requestOrigin === input.publicUrl.origin) return true;
  return (
    isDesktopLoopbackOriginAllowed(input) &&
    (DESKTOP_RENDERER_ORIGINS as ReadonlyArray<string>).includes(input.requestOrigin)
  );
}

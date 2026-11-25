import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "@t3tools/shared/remote";
import { webOrigin } from "@t3tools/shared/url";

import { readPrimaryEnvironmentTarget } from "./environments/primary/target";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "nightly";

function configuredHostedAppUrl(): string | undefined {
  return import.meta.env.VITE_HOSTED_APP_URL?.trim() || undefined;
}

// The desktop window's own origin is an app scheme, so it links to its local server instead. That
// read is synchronous IPC, and a restarted backend can move, so one read serves a few seconds.
// A server that is not ready yet is read again on the next call.
const DESKTOP_SERVER_READ_MS = 2_000;
let desktopServer: { readonly origin: string; readonly readAt: number } | undefined;

/** Without one, as on a desktop with no local server, links stay `t3-thread://` links. */
export function linkOrigin(): string | undefined {
  return (
    webOrigin(configuredHostedAppUrl()) ??
    webOrigin(typeof window === "undefined" ? undefined : window.location?.origin) ??
    desktopServerOrigin()
  );
}

/** A provider sign-in returns only to a page the user is on: the hosted app or this page's server. */
export function providerAuthReturnOrigins(): ReadonlyArray<string | undefined> {
  return [
    configuredHostedAppUrl(),
    typeof window === "undefined" ? undefined : window.location?.origin,
  ];
}

function desktopServerOrigin(): string | undefined {
  const now = performance.now();
  if (desktopServer !== undefined && now - desktopServer.readAt <= DESKTOP_SERVER_READ_MS) {
    return desktopServer.origin;
  }
  const origin = readDesktopServerOrigin();
  desktopServer = origin === undefined ? undefined : { origin, readAt: now };
  return origin;
}

function readDesktopServerOrigin(): string | undefined {
  try {
    return webOrigin(readPrimaryEnvironmentTarget()?.target.httpBaseUrl);
  } catch {
    return undefined;
  }
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

export function isHostedStaticApp(url?: URL): boolean {
  if (configuredBackendUrl()) {
    return false;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  if (url === undefined && (typeof window === "undefined" || window.location === undefined)) {
    return false;
  }

  const hostedOrigin = webOrigin(configuredHostedAppUrl());
  return (
    hostedOrigin !== undefined && (url ?? new URL(window.location.href)).origin === hostedOrigin
  );
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string | null {
  const hostedOrigin = webOrigin(configuredHostedAppUrl());
  if (hostedOrigin === undefined) return null;
  const url = new URL("/pair", hostedOrigin);
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string {
  const url = new URL(
    "/__t3code/channel",
    webOrigin(configuredHostedAppUrl()) ?? window.location.origin,
  );
  url.searchParams.set("channel", input.channel);
  return url.toString();
}

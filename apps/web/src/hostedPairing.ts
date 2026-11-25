import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "@t3tools/shared/remote";

import { readPrimaryEnvironmentTarget } from "./environments/primary/target";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "nightly";

/** Unset unless this build names a hosted app with `VITE_HOSTED_APP_URL`. */
function configuredHostedAppUrl(): string | undefined {
  return import.meta.env.VITE_HOSTED_APP_URL?.trim() || undefined;
}

/** Where copied links open: the hosted app this build names, else this app's own server. */
export function linkOrigin(): string {
  const hostedAppUrl = configuredHostedAppUrl();
  if (hostedAppUrl) return hostedAppUrl;
  try {
    const primary = readPrimaryEnvironmentTarget();
    if (primary) return new URL(primary.target.httpBaseUrl).origin;
  } catch {}
  return window.location.origin;
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

function originFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
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

  const hostedOrigin = originFromUrl(configuredHostedAppUrl());
  return hostedOrigin !== null && (url ?? new URL(window.location.href)).origin === hostedOrigin;
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

/** Null without a hosted app, so callers share the server's own pairing link. */
export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string | null {
  const hostedAppUrl = configuredHostedAppUrl();
  if (!hostedAppUrl) return null;
  const url = new URL("/pair", hostedAppUrl);
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
  const url = new URL("/__t3code/channel", configuredHostedAppUrl() ?? window.location.origin);
  url.searchParams.set("channel", input.channel);
  return url.toString();
}

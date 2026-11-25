import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";

import {
  buildHostedChannelSelectionUrl,
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  linkOrigin,
  providerAuthReturnOrigins,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.t3.codes/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      })!,
    );

    expect(url.origin).toBe("https://preview.t3.codes");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("builds no hosted pairing link and links to this server with an %s hosted app", (_, url) => {
    if (url !== undefined) vi.stubEnv("VITE_HOSTED_APP_URL", url);
    vi.stubGlobal("window", { location: new URL("https://sail.example.test/settings/access") });

    expect(buildHostedPairingUrl({ host: "https://backend.example.com", token: "t" })).toBeNull();
    expect(linkOrigin()).toBe("https://sail.example.test");
  });

  it.each(["not a url", "sail://app"])(
    "builds no hosted pairing link and selects channels here with a hosted app of %s",
    (hostedAppUrl) => {
      vi.stubEnv("VITE_HOSTED_APP_URL", hostedAppUrl);
      vi.stubGlobal("window", { location: new URL("https://sail.example.test/settings") });

      expect(buildHostedPairingUrl({ host: "https://backend.example.com", token: "t" })).toBeNull();
      expect(buildHostedChannelSelectionUrl({ channel: "nightly" })).toBe(
        "https://sail.example.test/__t3code/channel?channel=nightly",
      );
    },
  );

  it("returns provider sign-in to the hosted app the build names and to this page", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    vi.stubGlobal("window", { location: new URL("https://sail.example.test/settings/providers") });

    expect(
      providerAuthReturnUrl("https://hosted.example.test/welcome", providerAuthReturnOrigins()),
    ).toBe("https://hosted.example.test/welcome");
    expect(
      providerAuthReturnUrl(
        "https://sail.example.test/settings/providers",
        providerAuthReturnOrigins(),
      ),
    ).toBe("https://sail.example.test/settings/providers");
    expect(
      providerAuthReturnUrl("https://other.example.test/welcome", providerAuthReturnOrigins()),
    ).toBeUndefined();
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("returns provider sign-in to no hosted app with an %s hosted app", (_, hostedAppUrl) => {
    if (hostedAppUrl !== undefined) vi.stubEnv("VITE_HOSTED_APP_URL", hostedAppUrl);
    vi.stubGlobal("window", { location: new URL("http://192.168.1.42:3773/settings/providers") });

    expect(
      providerAuthReturnUrl("https://hosted.example.test/welcome", providerAuthReturnOrigins()),
    ).toBeUndefined();
    expect(
      providerAuthReturnUrl(
        "http://192.168.1.42:3773/settings/providers",
        providerAuthReturnOrigins(),
      ),
    ).toBeUndefined();
  });

  it("links to the hosted app the build names", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    vi.stubGlobal("window", { location: new URL("https://sail.example.test/") });

    expect(linkOrigin()).toBe("https://hosted.example.test");
  });

  it("links to the desktop's local server from the desktop window, read once", async () => {
    vi.resetModules();
    const getLocalEnvironmentBootstraps = vi.fn(() => [
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    ]);
    vi.stubGlobal("window", {
      // Electron gives the registered app scheme a real origin; Node's URL reports "null".
      location: { origin: "sail://app", href: "sail://app/settings" },
      desktopBridge: { getLocalEnvironmentEnabled: () => true, getLocalEnvironmentBootstraps },
    });
    const { linkOrigin: freshLinkOrigin } = await import("./hostedPairing");

    expect(freshLinkOrigin()).toBe("http://127.0.0.1:3773");
    expect(freshLinkOrigin()).toBe("http://127.0.0.1:3773");
    expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(1);
  });

  it("follows a desktop server that moved", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      let host = "172.20.0.2";
      vi.stubGlobal("window", {
        location: { origin: "sail://app", href: "sail://app/settings" },
        desktopBridge: {
          getLocalEnvironmentEnabled: () => true,
          getLocalEnvironmentBootstraps: () => [
            {
              id: PRIMARY_LOCAL_ENVIRONMENT_ID,
              httpBaseUrl: `http://${host}:3773/`,
              wsBaseUrl: `ws://${host}:3773/`,
            },
          ],
        },
      });
      const { linkOrigin: freshLinkOrigin } = await import("./hostedPairing");
      expect(freshLinkOrigin()).toBe("http://172.20.0.2:3773");

      host = "172.20.0.9";
      vi.advanceTimersByTime(60_000);
      expect(freshLinkOrigin()).toBe("http://172.20.0.9:3773");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a desktop server again when it was not ready yet", async () => {
    vi.resetModules();
    let bootstraps: Array<{ id: string; httpBaseUrl: string; wsBaseUrl: string }> = [];
    vi.stubGlobal("window", {
      location: { origin: "sail://app", href: "sail://app/settings" },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => true,
        getLocalEnvironmentBootstraps: () => bootstraps,
      },
    });
    const { linkOrigin: freshLinkOrigin } = await import("./hostedPairing");
    expect(freshLinkOrigin()).toBeUndefined();

    bootstraps = [
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    ];
    expect(freshLinkOrigin()).toBe("http://127.0.0.1:3773");
  });

  it("has no link origin on a desktop with no local server", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      location: { origin: "sail://app", href: "sail://app/settings" },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => false,
        getLocalEnvironmentBootstraps: () => [],
      },
    });
    const { linkOrigin: freshLinkOrigin } = await import("./hostedPairing");

    expect(freshLinkOrigin()).toBeUndefined();
  });
});

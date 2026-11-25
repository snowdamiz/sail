import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  linkOrigin,
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

  it("links to the hosted app the build names", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    vi.stubGlobal("window", { location: new URL("https://sail.example.test/") });

    expect(linkOrigin()).toBe("https://hosted.example.test");
  });
});

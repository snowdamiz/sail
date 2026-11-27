import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { type AdvertisedEndpoint, type DesktopWslState, EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  isServerNetworkAccessible,
  parseManualDesktopSshTarget,
  resolveAccessEnvironmentId,
  resolveAdvertisedEndpointPairingUrl,
  resolvePairingShareBaseUrl,
  resolveTailscaleServeBaseUrl,
  selectQrEndpointOption,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});

describe("parseManualDesktopSshTarget", () => {
  it.each(["22.5", "1e3", "2222garbage"])("rejects explicit port %j", (port) => {
    expect(() => parseManualDesktopSshTarget({ host: "devbox", username: "", port })).toThrow(
      "SSH port must be between 1 and 65535.",
    );
  });
});

describe("resolvePairingShareBaseUrl", () => {
  const identity = { environmentId: EnvironmentId.make("test-server"), label: "Test server" };
  const primary = new PrimaryConnectionTarget({
    ...identity,
    httpBaseUrl: "http://127.0.0.1:3773/",
    wsBaseUrl: "ws://127.0.0.1:3773/",
  });
  const bearer = new BearerConnectionTarget({ ...identity, connectionId: "direct" });
  const bearerProfile = new BearerConnectionProfile({
    ...identity,
    connectionId: bearer.connectionId,
    httpBaseUrl: "https://saved.example.test/",
    wsBaseUrl: "wss://saved.example.test/",
  });
  const relay = new RelayConnectionTarget(identity);
  const ssh = new SshConnectionTarget({ ...identity, connectionId: "ssh" });

  it.each([
    ["t3code://app/settings/connections", null],
    ["http://127.0.0.1:3774/settings", null],
    ["http://localhost:5173/", null],
    ["http://127.0.0.2:3774/", null],
    ["http://0.0.0.0:3774/", null],
    ["https://host.example.ts.net/settings", "https://host.example.ts.net"],
    ["http://192.168.1.20:3773/", "http://192.168.1.20:3773"],
  ])("shares the primary on its HTTP address %s", (httpBaseUrl, expected) => {
    expect(
      resolvePairingShareBaseUrl({
        entry: {
          target: new PrimaryConnectionTarget({ ...primary, httpBaseUrl }),
          profile: Option.none(),
          enabled: true,
        },
        prepared: null,
      }),
    ).toBe(expected);
  });

  it("shares the primary desktop server through its exposed address", () => {
    expect(
      resolvePairingShareBaseUrl({
        entry: { target: primary, profile: Option.none(), enabled: true },
        desktopEndpointUrl: "http://192.168.1.20:3773/",
        prepared: null,
      }),
    ).toBe("http://192.168.1.20:3773");
  });

  it("uses the saved remote server address when desktop has its own exposed address", () => {
    expect(
      resolvePairingShareBaseUrl({
        entry: { target: bearer, profile: Option.some(bearerProfile), enabled: true },
        desktopEndpointUrl: "http://192.168.1.20:3773/",
        prepared: null,
      }),
    ).toBe("https://saved.example.test");
  });

  it("uses the selected server's live relay address even when it has a saved direct route", () => {
    expect(
      resolvePairingShareBaseUrl({
        entry: {
          target: bearer,
          profile: Option.some(bearerProfile),
          alternateRoutes: [{ target: relay, profile: Option.none() }],
          enabled: true,
        },
        prepared: { target: relay, httpBaseUrl: "https://relay.example.test/" },
      }),
    ).toBe("https://relay.example.test");
  });

  it.each([
    { target: relay, prepared: null },
    { target: ssh, prepared: { target: ssh, httpBaseUrl: "http://127.0.0.1:40882/" } },
  ])("keeps a code when $target._tag has no shareable address", ({ target, prepared }) => {
    expect(
      resolvePairingShareBaseUrl({
        entry: { target, profile: Option.none(), enabled: true },
        prepared,
      }),
    ).toBeNull();
  });
});

describe("resolveAdvertisedEndpointPairingUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const tailnet: AdvertisedEndpoint = {
    id: "tailscale-magicdns:https://desktop.tailnet.ts.net",
    label: "Tailscale HTTPS",
    provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
    httpBaseUrl: "https://desktop.tailnet.ts.net/",
    wsBaseUrl: "wss://desktop.tailnet.ts.net/",
    reachability: "private-network",
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    source: "desktop-addon",
    status: "available",
  };

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("shares the server's own pairing link with an %s hosted app", (_, hostedAppUrl) => {
    if (hostedAppUrl !== undefined) vi.stubEnv("VITE_HOSTED_APP_URL", hostedAppUrl);
    expect(resolveAdvertisedEndpointPairingUrl(tailnet, "PAIRCODE")).toBe(
      "https://desktop.tailnet.ts.net/pair#token=PAIRCODE",
    );
  });

  it("shares a hosted pairing link when the build names a hosted app", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    expect(resolveAdvertisedEndpointPairingUrl(tailnet, "PAIRCODE")).toBe(
      "https://hosted.example.test/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=PAIRCODE",
    );
  });

  it("shares the server's own link for a plain HTTP endpoint either way", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    expect(
      resolveAdvertisedEndpointPairingUrl(
        {
          ...tailnet,
          id: "desktop-lan:http://192.168.1.42:4780",
          httpBaseUrl: "http://192.168.1.42:4780/",
          compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
        },
        "PAIRCODE",
      ),
    ).toBe("http://192.168.1.42:4780/pair#token=PAIRCODE");
  });
});

describe("resolveTailscaleServeBaseUrl", () => {
  it.each([
    ["https://host.tail.ts.net:441/", 443, "https://host.tail.ts.net"],
    ["https://host.tail.ts.net:441/", 444, "https://host.tail.ts.net:444"],
  ] as const)("previews %s on port %i", (httpBaseUrl, port, expected) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, true)).toBe(expected);
  });

  it("returns null without a pending endpoint", () => {
    expect(resolveTailscaleServeBaseUrl(null, 443, true)).toBeNull();
  });

  it.each([
    ["https://host.tail.ts.net:441/", 0, false],
    ["not a URL", 443, true],
  ] as const)("preserves %s when port %i cannot be previewed", (httpBaseUrl, port, isPortValid) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, isPortValid)).toBe(httpBaseUrl);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});

describe("resolveAccessEnvironmentId", () => {
  const primary = EnvironmentId.make("primary");
  const service = EnvironmentId.make("service");
  const laptop = EnvironmentId.make("laptop");
  it.each([
    {
      label: "defaults to the primary environment",
      primaryEnvironmentId: primary,
      environments: [
        { environmentId: primary, connected: true },
        { environmentId: service, connected: true },
      ],
      selected: null,
      expected: primary,
    },
    {
      label: "falls back to a connected saved environment without a primary",
      primaryEnvironmentId: null,
      environments: [
        { environmentId: laptop, connected: false },
        { environmentId: service, connected: true },
      ],
      selected: null,
      expected: service,
    },
    {
      label: "keeps an explicit choice",
      primaryEnvironmentId: primary,
      environments: [
        { environmentId: primary, connected: true },
        { environmentId: laptop, connected: false },
      ],
      selected: laptop,
      expected: laptop,
    },
    {
      label: "drops a choice that is no longer listed",
      primaryEnvironmentId: null,
      environments: [{ environmentId: service, connected: true }],
      selected: laptop,
      expected: service,
    },
    {
      label: "has nothing to show without environments",
      primaryEnvironmentId: null,
      environments: [],
      selected: null,
      expected: null,
    },
  ])("$label", ({ primaryEnvironmentId, environments, selected, expected }) => {
    expect(resolveAccessEnvironmentId({ primaryEnvironmentId, environments, selected })).toBe(
      expected,
    );
  });
});

describe("isServerNetworkAccessible", () => {
  const served = [{ kind: "tailnet", httpBaseUrl: "https://host.example.ts.net:8443/" }] as const;
  it.each([
    { authPolicy: "remote-reachable", directEndpoints: undefined, expected: true },
    { authPolicy: "loopback-browser", directEndpoints: undefined, expected: false },
    { authPolicy: "loopback-browser", directEndpoints: [], expected: false },
    { authPolicy: "loopback-browser", directEndpoints: served, expected: true },
    { authPolicy: null, directEndpoints: served, expected: false },
  ] as const)("$authPolicy with $directEndpoints.length endpoints", (row) => {
    expect(isServerNetworkAccessible(row)).toBe(row.expected);
  });
});

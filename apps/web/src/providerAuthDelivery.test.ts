import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { codexAuthDeliveryUrl } from "@t3tools/shared/codexAuthHandoff";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "./components/ui/toast";
import { rememberProviderAuthSignIn, startProviderAuthDelivery } from "./providerAuthDelivery";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentPresentations } from "./state/presentation";

type Presentation = { readonly connection: { readonly phase: string } } | undefined;

vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: vi.fn() }));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./state/server", () => ({
  serverEnvironment: { completeProviderAuth: "completeProviderAuth" },
}));
vi.mock("./rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("./state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  const atoms = new Map<string, Atom.Writable<Presentation>>();
  return {
    environmentPresentations: {
      presentationAtom: (environmentId: string) => {
        const atom = atoms.get(environmentId) ?? Atom.make<Presentation>(undefined);
        atoms.set(environmentId, atom);
        return atom;
      },
    },
  };
});

const relayOnly = EnvironmentId.make("relay-only");
const instanceId = ProviderInstanceId.make("work-codex");
const page = "https://hosted.example.test/settings/providers?instanceId=work-codex";
const authorizationUrl = new URL("https://auth.openai.com/api/accounts/authorize");
authorizationUrl.search = new URLSearchParams({
  client_id: "dynamic_agent_client",
  response_type: "code",
  redirect_uri: "http://127.0.0.1:1455/auth/callback",
  state: "a".repeat(43),
  code_challenge_method: "S256",
  code_challenge: "b".repeat(43),
}).toString();
const callbackUrl = `http://127.0.0.1:1455/auth/callback?state=${"a".repeat(43)}&code=one-time-code`;
const signIn = { environmentId: relayOnly, instanceId, flowId: "flow-one" };
const delivery = (flowId = signIn.flowId) =>
  codexAuthDeliveryUrl(
    { ...signIn, flowId, authorizationUrl: authorizationUrl.toString(), returnUrl: page },
    callbackUrl,
    [new URL(page).origin],
  );
const completed = (flowId = signIn.flowId) => [
  appAtomRegistry,
  "completeProviderAuth",
  { environmentId: relayOnly, input: { instanceId, flowId, callbackUrl } },
  { reportFailure: false },
];

const storage = new Map<string, string>();
function openTab(href: string) {
  const location = new URL(href);
  vi.stubGlobal("window", {
    location,
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: string) => {
        location.href = new URL(url, location).href;
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    dispatchEvent: () => true,
  });
  return location;
}
const connect = (phase: string) => {
  const atom = environmentPresentations.presentationAtom(relayOnly);
  if (!Atom.isWritable(atom)) throw new Error("Expected a writable test presentation");
  appAtomRegistry.set(atom, { connection: { phase } } as never);
};

describe("Codex sign-in delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00.000Z") });
    storage.clear();
    vi.mocked(runAtomCommand).mockReset().mockResolvedValue(AsyncResult.success(undefined));
    vi.mocked(toastManager.add).mockClear();
    connect("connected");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("finishes a sign-in this browser started when its code lands in a new tab", () => {
    openTab(page);
    rememberProviderAuthSignIn(signIn);
    const tab = openTab(delivery());
    startProviderAuthDelivery();

    expect(tab.href).toBe(page);
    expect(vi.mocked(runAtomCommand).mock.calls).toEqual([completed()]);
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("sends no code a relay-only environment asked for without this browser", () => {
    const tab = openTab(delivery());
    startProviderAuthDelivery();

    expect(tab.href).toBe(page);
    expect(runAtomCommand).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("sends no code to an environment for a sign-in this browser did not start", () => {
    openTab(page);
    rememberProviderAuthSignIn({ ...signIn, flowId: "another-flow" });
    rememberProviderAuthSignIn({ ...signIn, environmentId: EnvironmentId.make("other") });
    rememberProviderAuthSignIn({ ...signIn, instanceId: ProviderInstanceId.make("other") });
    const tab = openTab(delivery());
    startProviderAuthDelivery();

    expect(tab.href).toBe(page);
    expect(runAtomCommand).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("sends a code once, so another tab cannot replay the same sign-in", () => {
    openTab(page);
    rememberProviderAuthSignIn(signIn);
    openTab(delivery());
    startProviderAuthDelivery();
    openTab(delivery());
    startProviderAuthDelivery();

    expect(vi.mocked(runAtomCommand).mock.calls).toEqual([completed()]);
  });

  it("sends no code once the sign-in this browser started has expired", () => {
    openTab(page);
    rememberProviderAuthSignIn(signIn);
    vi.advanceTimersByTime(10 * 60_000);
    openTab(delivery());
    startProviderAuthDelivery();

    expect(runAtomCommand).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("sends the code when its environment connects before the sign-in expires", () => {
    connect("connecting");
    openTab(page);
    rememberProviderAuthSignIn(signIn);
    openTab(delivery());
    startProviderAuthDelivery();
    expect(runAtomCommand).not.toHaveBeenCalled();

    vi.advanceTimersByTime(9 * 60_000);
    connect("connected");
    expect(vi.mocked(runAtomCommand).mock.calls).toEqual([completed()]);
  });

  it("stops waiting for its environment when the sign-in expires", () => {
    connect("connecting");
    openTab(page);
    rememberProviderAuthSignIn(signIn);
    openTab(delivery());
    startProviderAuthDelivery();

    vi.advanceTimersByTime(10 * 60_000);
    expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    connect("connected");
    expect(runAtomCommand).not.toHaveBeenCalled();
  });
});

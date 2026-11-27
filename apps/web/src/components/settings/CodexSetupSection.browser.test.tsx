import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  startAuth: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providerAuthState: (() => "auth") as never,
      providerInstallState: (() => "installation") as never,
      startProviderAuth: setup.startAuth as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: string | null) => ({
    data: atom === "auth" ? setup.auth : atom === "installation" ? setup.installation : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));

import { forgetProviderAuthSignIn, rememberProviderAuthSignIn } from "../../providerAuthDelivery";
import { CodexSetupSection } from "./CodexSetupSection";

const environmentId = EnvironmentId.make("relay-only");
const instanceId = ProviderInstanceId.make("work-codex");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  installed: true,
  enabled: true,
  version: "test-version",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-11-26T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: true },
};
const started: ProviderAuthState = {
  instanceId,
  phase: "waiting",
  flowId: "flow-from-this-browser",
  authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=test-only",
  expiresAt: "2026-11-26T00:05:00.000Z",
  message: null,
};

const installed: ProviderInstallState = {
  driver: ProviderDriverKind.make("codex"),
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: "1.0.0",
  installedVersion: "1.0.0",
  canRemove: false,
  message: null,
};
const card = () => (
  <CodexSetupSection
    environmentId={environmentId}
    instanceId={instanceId}
    provider={provider}
    mode="managed"
    enabled
    onModeChange={vi.fn()}
  />
);
const handoffLink = (container: HTMLElement) => container.querySelector('a[href*="://auth/codex"]');

describe("Codex sign-in start", () => {
  it("offers the desktop's automatic return only for a sign-in this browser started", async () => {
    const page = window.location.href;
    window.history.replaceState(null, "", "/settings/providers");
    try {
      window.localStorage.clear();
      setup.auth = started;
      setup.installation = installed;
      await using screen = await render(card());
      expect(handoffLink(screen.container)).toBeNull();

      const flow = { environmentId, instanceId, flowId: started.flowId! };
      await act(async () => rememberProviderAuthSignIn(flow));
      expect(handoffLink(screen.container)).not.toBeNull();
      await act(async () => forgetProviderAuthSignIn(flow));
      expect(handoffLink(screen.container)).toBeNull();
    } finally {
      window.history.replaceState(null, "", page);
    }
  });

  it("records the sign-in this browser starts so its delivery can land in another tab", async () => {
    window.localStorage.clear();
    setup.auth = { ...started, phase: "idle", flowId: null, authorizationUrl: null };
    setup.installation = installed;
    setup.startAuth.mockReset().mockResolvedValue({ _tag: "Success", value: started });

    await using _ = await render(
      <CodexSetupSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={provider}
        mode="managed"
        enabled
        onModeChange={vi.fn()}
        autoStart
      />,
    );

    await vi.waitFor(() => expect(setup.startAuth).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem("t3code:codex-sign-ins:v1") ?? "[]")).toEqual([
        expect.objectContaining({ environmentId, instanceId, flowId: started.flowId }),
      ]),
    );
  });
});

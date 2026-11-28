import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { Atom, AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { EnvironmentPresentation } from "~/state/environments";
import type { AddEnvironmentPrefill } from "~/state/linkedThreadView";

const mocks = vi.hoisted(() => ({
  connectPairing: vi.fn<
    (input: {
      readonly pairingUrl: string;
      readonly label?: string;
      readonly expectedEnvironmentId?: EnvironmentId;
      readonly replaceConnectionId?: string;
    }) => Promise<AtomCommandResult<EnvironmentId, Error>>
  >(async () => AsyncResult.success("env-paired" as EnvironmentId)),
  probeOwnerPassword: vi.fn<
    (
      destination: ConnectionOnboarding.OwnerPasswordDestination,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<AtomCommandResult<ConnectionOnboarding.OwnerPasswordHost, Error>>
  >(async () =>
    AsyncResult.success({
      kind: "ready" as const,
      environmentId: "env-password" as EnvironmentId,
      origin: "https://my-sail.fly.dev",
      label: "my-sail.fly.dev",
      signIn: (() => undefined) as never,
    }),
  ),
  connectOwnerPassword: vi.fn<
    (input: {
      readonly server: Extract<ConnectionOnboarding.OwnerPasswordHost, { readonly kind: "ready" }>;
      readonly password: Redacted.Redacted<string>;
    }) => Promise<AtomCommandResult<EnvironmentId, Error>>
  >(async () => AsyncResult.success("env-password" as EnvironmentId)),
  connectSshEnvironment: vi.fn<() => Promise<AtomCommandResult<EnvironmentId, Error>>>(async () =>
    AsyncResult.success("env-ssh" as EnvironmentId),
  ),
  offerMainServer: vi.fn<
    (server: { readonly environmentId: EnvironmentId; readonly host: string }) => boolean
  >(() => false),
  setEnabled: vi.fn<
    (input: {
      readonly environmentId: EnvironmentId;
      readonly enabled: boolean;
    }) => Promise<AtomCommandResult<void, Error>>
  >(async () => AsyncResult.success(undefined)),
  refresh: () => {},
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: mocks.connectPairing as never,
  probeOwnerPassword: mocks.probeOwnerPassword as never,
  connectOwnerPassword: mocks.connectOwnerPassword as never,
  connectSshEnvironment: mocks.connectSshEnvironment as never,
}));
vi.mock(import("../desktop/MainServerDialog"), () => ({
  useOfferMainServer: () => mocks.offerMainServer,
}));
vi.mock(import("~/connection/catalog"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      setEnabled: mocks.setEnabled,
    } as never,
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: [],
    isPending: false,
    error: null,
    refresh: mocks.refresh,
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: (() => ({ environments: new Map() })) as never,
}));
vi.mock(import("~/state/server"), async (original) => ({
  ...(await original()),
  primaryServerKeybindingsAtom: Atom.make([]) as never,
}));

import { AddEnvironmentDialog, type ReauthenticateRouteTarget } from "./AddEnvironmentDialog";

function Owner({
  initialOpen = false,
  prefill = null,
  reauthTarget = null,
}: {
  readonly initialOpen?: boolean;
  readonly prefill?: AddEnvironmentPrefill | null;
  readonly reauthTarget?: ReauthenticateRouteTarget | null;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [error, setError] = useState<string | null>(null);
  return (
    <AppAtomRegistryProvider>
      <AddEnvironmentDialog
        open={open}
        prefill={prefill}
        routeTarget={null}
        reauthTarget={reauthTarget}
        error={error}
        savedEnvironments={[]}
        onOpenChange={setOpen}
        onErrorChange={setError}
      />
    </AppAtomRegistryProvider>
  );
}

function setupDesktop() {
  vi.clearAllMocks();
  return stubGlobal("desktopBridge", {});
}

const passwordCard = () => page.getByRole("button", { name: /^Password/ });
const pairingCard = () => page.getByRole("button", { name: /^Pairing code/ });
const sshCard = () => page.getByRole("button", { name: /^SSH/ });

async function openDialogOnSsh() {
  await userEvent.click(page.getByRole("button", { name: "Add environment" }));
  await userEvent.click(sshCard());
  await expect.element(sshCard()).toHaveAttribute("aria-pressed", "true");
}

async function expectDefaultDesktopModeAfterReopen() {
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Add environment" }));
  await expect.element(passwordCard()).toHaveAttribute("aria-pressed", "true");
  await expect.element(pairingCard()).toHaveAttribute("aria-pressed", "false");
  await expect.element(sshCard()).toHaveAttribute("aria-pressed", "false");
  await expect.element(page.getByPlaceholder("https://sail.example.com")).toBeInTheDocument();
}

describe("AddEnvironmentDialog", () => {
  it("reopens on Password after adding an SSH environment", async () => {
    using _bridge = setupDesktop();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Add environment" }),
    );
    expect(mocks.connectSshEnvironment).toHaveBeenCalledOnce();

    await expectDefaultDesktopModeAfterReopen();
  });

  it("drops an SSH error when switching to Pairing code", async () => {
    using _bridge = setupDesktop();
    await using _screen = await render(<Owner />);

    mocks.connectSshEnvironment.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("ssh: connection refused"))),
    );
    await openDialogOnSsh();
    await userEvent.type(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Add environment" }),
    );
    await expect.element(page.getByText(/connection refused/)).toBeInTheDocument();

    await userEvent.click(pairingCard());
    await expect.element(page.getByText(/connection refused/)).not.toBeInTheDocument();
  });

  it("clears the form after dismissing it on SSH", async () => {
    using _bridge = setupDesktop();
    await using _screen = await render(<Owner />);

    await openDialogOnSsh();
    await userEvent.click(pairingCard());
    await userEvent.fill(page.getByPlaceholder("backend.example.com"), "devbox.example.com");
    await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
    await userEvent.click(sshCard());
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.fill(page.getByPlaceholder("root"), "maria");
    await userEvent.fill(page.getByPlaceholder("22"), "2222");
    await userEvent.keyboard("{Escape}");

    await expectDefaultDesktopModeAfterReopen();
    await userEvent.click(pairingCard());
    await expect.element(page.getByPlaceholder("backend.example.com")).toHaveValue("");
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("");
    await userEvent.click(sshCard());
    await expect.element(page.getByPlaceholder("Search hosts or type devbox")).toHaveValue("");
    await expect.element(page.getByPlaceholder("root")).toHaveValue("");
    await expect.element(page.getByPlaceholder("22")).toHaveValue("");

    let finishConnection!: (result: AtomCommandResult<EnvironmentId, Error>) => void;
    const pending = new Promise<AtomCommandResult<EnvironmentId, Error>>((resolve) => {
      finishConnection = resolve;
    });
    mocks.connectSshEnvironment.mockImplementationOnce(() => pending);
    await userEvent.fill(page.getByPlaceholder("Search hosts or type devbox"), "devbox");
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Add environment" }),
    );
    await userEvent.keyboard("{Escape}");
    await expectDefaultDesktopModeAfterReopen();
    finishConnection(AsyncResult.failure(Cause.fail(new Error("dismissed SSH attempt"))));
    await userEvent.fill(page.getByPlaceholder("https://sail.example.com"), "my-sail.fly.dev");
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Continue" }))
      .toBeEnabled();
    await expect.element(page.getByText(/dismissed SSH attempt/)).not.toBeInTheDocument();
  });

  it("runs the Desktop 2-step Password flow, clears password immediately before awaiting, and offers main server", async () => {
    using _bridge = setupDesktop();
    const readyServer: Extract<ConnectionOnboarding.OwnerPasswordHost, { readonly kind: "ready" }> =
      {
        kind: "ready",
        environmentId: EnvironmentId.make("env-fly"),
        origin: "https://my-sail.fly.dev",
        label: "my-sail.fly.dev",
        signIn: (() => undefined) as never,
      };
    mocks.probeOwnerPassword.mockResolvedValueOnce(AsyncResult.success(readyServer));
    const pendingSignIn = Promise.withResolvers<AtomCommandResult<EnvironmentId, Error>>();
    mocks.connectOwnerPassword.mockImplementationOnce(() => pendingSignIn.promise);

    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await expect.element(passwordCard()).toHaveAttribute("aria-pressed", "true");
    await userEvent.fill(page.getByPlaceholder("https://sail.example.com"), "my-sail.fly.dev");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));

    expect(mocks.probeOwnerPassword).toHaveBeenCalledWith(
      { kind: "add", host: "my-sail.fly.dev" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect.element(page.getByText("https://my-sail.fly.dev")).toBeVisible();

    const passwordInput = page.getByLabelText("Owner password");
    await userEvent.fill(passwordInput, "correct horse battery staple");
    await userEvent.click(page.getByRole("button", { name: "Sign in" }));

    // Password input must clear immediately before connectOwnerPassword settles.
    await expect.element(passwordInput).toHaveValue("");
    expect(mocks.connectOwnerPassword).toHaveBeenCalledOnce();
    const call = mocks.connectOwnerPassword.mock.calls[0]![0];
    expect(call.server).toBe(readyServer);
    expect(Redacted.value(call.password)).toBe("correct horse battery staple");

    pendingSignIn.resolve(AsyncResult.success(EnvironmentId.make("env-fly")));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.offerMainServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("env-fly"),
      host: "my-sail.fly.dev",
    });
  });

  it("auto-switches to Pairing code when a pairing URL is pasted into the Password host input", async () => {
    using _bridge = setupDesktop();
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.fill(
      page.getByPlaceholder("https://sail.example.com"),
      "https://my-sail.fly.dev/pair#token=PAIR123",
    );

    await expect.element(pairingCard()).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByPlaceholder("backend.example.com"))
      .toHaveValue("https://my-sail.fly.dev");
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("PAIR123");
    expect(mocks.probeOwnerPassword).not.toHaveBeenCalled();
  });

  it("explains unavailable password sign-in and preserves the host when switching to Pairing code", async () => {
    using _bridge = setupDesktop();
    mocks.probeOwnerPassword.mockResolvedValueOnce(
      AsyncResult.success({
        kind: "unavailable",
        environmentId: EnvironmentId.make("env-no-pass"),
        origin: "https://no-pass.fly.dev",
        label: "no-pass.fly.dev",
        reason: "unset",
      }),
    );
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.fill(page.getByPlaceholder("https://sail.example.com"), "no-pass.fly.dev");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));

    await expect.element(page.getByText(/Settings .* Sharing & access/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Use a pairing code" }));

    await expect.element(pairingCard()).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByPlaceholder("backend.example.com"))
      .toHaveValue("https://no-pass.fly.dev");
  });

  it("recovers from SavedConnectionActivationError by enabling the environment without re-entering the password", async () => {
    using _bridge = setupDesktop();
    const savedId = EnvironmentId.make("env-saved-1");
    mocks.connectOwnerPassword.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new ConnectionOnboarding.SavedConnectionActivationError({
            environmentId: savedId,
            message: "Saved, but activation timed out.",
            cause: new Error("activation timed out"),
          }),
        ),
      ),
    );
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.fill(page.getByPlaceholder("https://sail.example.com"), "my-sail.fly.dev");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await userEvent.fill(page.getByLabelText("Owner password"), "correct horse battery staple");
    await userEvent.click(page.getByRole("button", { name: "Sign in" }));

    const enableButton = page.getByRole("button", { name: "Enable environment" });
    await expect.element(enableButton).toBeVisible();
    await userEvent.click(enableButton);

    expect(mocks.setEnabled).toHaveBeenCalledExactlyOnceWith({
      environmentId: savedId,
      enabled: true,
    });
    expect(mocks.connectOwnerPassword).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.offerMainServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: savedId,
      host: "my-sail.fly.dev",
    });
  });

  it("re-authenticates a saved HTTPS route read-only without offering main server, and preserves connectionId on pairing fallback", async () => {
    using _bridge = setupDesktop();
    const envId = EnvironmentId.make("env-reauth");
    const reauthTarget: ReauthenticateRouteTarget = {
      environment: {
        environmentId: envId,
        label: "Fly Control Plane",
        displayUrl: "https://my-sail.fly.dev",
        relayManaged: false,
      } as EnvironmentPresentation,
      connectionId: "conn-route-2",
      httpBaseUrl: "https://my-sail.fly.dev/",
    };
    await using _screen = await render(<Owner initialOpen reauthTarget={reauthTarget} />);

    await vi.waitFor(() => {
      expect(mocks.probeOwnerPassword).toHaveBeenCalledWith(
        {
          kind: "reauthenticate",
          environmentId: envId,
          connectionId: "conn-route-2",
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(sshCard().query()).toBeNull();
    await expect.element(page.getByText("https://my-sail.fly.dev")).toBeVisible();

    // Switch to pairing fallback and verify expectedEnvironmentId + replaceConnectionId
    await userEvent.click(pairingCard());
    await expect
      .element(page.getByPlaceholder("backend.example.com"))
      .toHaveValue("https://my-sail.fly.dev/");
    await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "NEWPAIR");
    await userEvent.click(page.getByRole("button", { name: "Sign in again" }));

    expect(mocks.connectPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedEnvironmentId: envId,
        replaceConnectionId: "conn-route-2",
      }),
    );
    expect(mocks.offerMainServer).not.toHaveBeenCalled();
  });

  it("keeps the password input blank on failed sign-in so the user enters a fresh password", async () => {
    using _bridge = setupDesktop();
    mocks.connectOwnerPassword.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Incorrect owner password."))),
    );
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.fill(page.getByPlaceholder("https://sail.example.com"), "my-sail.fly.dev");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));

    const passwordInput = page.getByLabelText("Owner password");
    await userEvent.fill(passwordInput, "wrong password value");
    await userEvent.click(page.getByRole("button", { name: "Sign in" }));

    await expect.element(page.getByRole("alert")).toHaveTextContent("Incorrect owner password.");
    await expect.element(passwordInput).toHaveValue("");
    expect(mocks.offerMainServer).not.toHaveBeenCalled();
  });

  it("offers main server after manual Pairing code connection on Desktop", async () => {
    using _bridge = setupDesktop();
    mocks.connectPairing.mockResolvedValueOnce(
      AsyncResult.success(EnvironmentId.make("env-paired-fly")),
    );
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.click(pairingCard());
    await userEvent.fill(page.getByPlaceholder("backend.example.com"), "https://pair.fly.dev");
    await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "PAIR999");
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Add environment" }),
    );

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.offerMainServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("env-paired-fly"),
      host: "pair.fly.dev",
    });
  });

  it("preserves prefill.environmentId in Password mode and blocks showing password input on machine mismatch", async () => {
    using _bridge = setupDesktop();
    const expectedEnvironmentId = EnvironmentId.make("env-linked-thread");
    const prefill: AddEnvironmentPrefill = {
      environmentId: expectedEnvironmentId,
      label: "Linked Host",
      host: "https://linked.fly.dev",
    };
    mocks.probeOwnerPassword.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new Error(
            "That address reaches Wrong Machine, a different machine. Add it as its own environment instead.",
          ),
        ),
      ),
    );

    await using _screen = await render(<Owner initialOpen prefill={prefill} />);
    await userEvent.click(passwordCard());
    await expect.element(passwordCard()).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByPlaceholder("https://sail.example.com"))
      .toHaveValue("https://linked.fly.dev");

    await userEvent.click(page.getByRole("button", { name: "Continue" }));

    expect(mocks.probeOwnerPassword).toHaveBeenCalledWith(
      {
        kind: "add",
        host: "https://linked.fly.dev",
        expectedEnvironmentId,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "That address reaches Wrong Machine, a different machine. Add it as its own environment instead.",
      );
    expect(page.getByLabelText("Owner password").query()).toBeNull();
  });

  it("hides Password mode completely on non-Desktop web", async () => {
    vi.clearAllMocks();
    using _bridge = stubGlobal("desktopBridge", undefined);
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(passwordCard().query()).toBeNull();
    expect(sshCard().query()).toBeNull();
    await expect.element(page.getByPlaceholder("backend.example.com")).toBeVisible();
    await expect.element(page.getByPlaceholder("PAIRCODE")).toBeVisible();
  });
});

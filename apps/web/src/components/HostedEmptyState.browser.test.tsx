import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  localEnvironmentDisabled: true,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ children, to, ...props }: { children?: React.ReactNode; to?: string }) => (
    <a href={to ?? "#"} {...props}>
      {children}
    </a>
  )) as never,
}));
vi.mock(import("../localEnvironment"), () => ({
  isLocalEnvironmentDisabled: () => state.localEnvironmentDisabled,
}));
vi.mock(import("~/cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => false,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: (() => ({ environments: new Map() })) as never,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("~/state/server"), async (original) => ({
  ...(await original()),
  primaryServerKeybindingsAtom: Atom.make([]) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: [],
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import { HostedEmptyState } from "./HostedEmptyState";

describe("HostedEmptyState", () => {
  it("shows an inline Sign in to a Sail server button on remote-only Desktop that opens Password sign-in", async () => {
    state.localEnvironmentDisabled = true;
    using _bridge = stubGlobal("desktopBridge", {});
    await using screen = await render(
      <AppAtomRegistryProvider>
        <HostedEmptyState />
      </AppAtomRegistryProvider>,
    );

    const signInButton = screen.getByRole("button", { name: "Sign in to a Sail server" });
    await expect.element(signInButton).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Open Environments" })).toBeVisible();

    await userEvent.click(signInButton);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Password/ }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("hides the inline Sign in to a Sail server button outside Desktop", async () => {
    state.localEnvironmentDisabled = true;
    using _bridge = stubGlobal("desktopBridge", undefined);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <HostedEmptyState />
      </AppAtomRegistryProvider>,
    );

    expect(screen.getByRole("button", { name: "Sign in to a Sail server" }).query()).toBeNull();
    await expect.element(screen.getByRole("link", { name: "Open Environments" })).toBeVisible();
  });
});

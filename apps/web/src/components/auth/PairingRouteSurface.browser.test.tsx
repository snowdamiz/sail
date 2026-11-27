import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ connect: vi.fn(), password: vi.fn(), pair: vi.fn() }));

vi.mock("../../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.connect }));
vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => null,
  stripPairingTokenFromUrl: () => undefined,
  submitServerAuthCredential: state.pair,
  submitOwnerPassword: state.password,
}));
vi.mock("../../hostedPairing", () => ({
  readHostedPairingRequest: () => ({ host: "backend.example.com", token: "one-time", label: "" }),
}));

import { HostedPairingRouteSurface, PairingRouteSurface } from "./PairingRouteSurface";

it("sends a link's pairing token only after the user confirms the backend", async () => {
  state.connect.mockReset();
  state.connect.mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(<HostedPairingRouteSurface />);

  await expect.element(screen.getByText("https://backend.example.com")).toBeVisible();
  expect(state.connect).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Add backend" }).click();
  await vi.waitFor(() =>
    expect(state.connect).toHaveBeenCalledExactlyOnceWith({
      host: "backend.example.com",
      pairingCode: "one-time",
    }),
  );
});

it("offers password sign-in first and keeps pairing available", async () => {
  state.password.mockReset();
  state.password.mockResolvedValue(undefined);
  state.pair.mockReset();
  const onAuthenticated = vi.fn();
  await using screen = await render(
    <PairingRouteSurface
      auth={{
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "test-session",
        ownerPassword: "configured",
      }}
      onAuthenticated={onAuthenticated}
    />,
  );
  await expect.element(screen.getByLabelText("Password", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Use a pairing link instead" }).click();
  await expect.element(screen.getByLabelText("Pairing token")).toBeVisible();
  await screen.getByRole("button", { name: "Use password instead" }).click();
  await screen.getByLabelText("Password", { exact: true }).fill("sample-browser-password");
  await screen.getByRole("button", { name: "Sign in", exact: true }).click();
  await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
  expect(state.password).toHaveBeenCalledExactlyOnceWith("sample-browser-password");
  expect(state.pair).not.toHaveBeenCalled();
});

it("passes the password setup decision on after an initial owner pairing", async () => {
  state.pair.mockReset();
  state.pair.mockResolvedValue(true);
  const onAuthenticated = vi.fn();
  await using screen = await render(
    <PairingRouteSurface
      auth={{
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "test-session",
        ownerPassword: "unset",
      }}
      onAuthenticated={onAuthenticated}
    />,
  );
  await screen.getByLabelText("Pairing token").fill("one-time-token");
  await screen.getByRole("button", { name: "Continue" }).click();
  await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledExactlyOnceWith(true));
});

import {
  EnvironmentId,
  managedCapabilityDenial,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import { readPairingAppLink, resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";

const localId = EnvironmentId.make("local");
const serviceId = EnvironmentId.make("service");

const state = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  policies: new Map<string, unknown>(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => state.primaryEnvironmentId) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...state.policies].map(([environmentId, managedPolicy]) => [
        environmentId,
        { managedPolicy },
      ]),
    )) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

const remoteClientsOff: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { clients: ["desktop"] },
};

function setup(policies: ReadonlyArray<readonly [EnvironmentId, ManagedPolicySummary]>) {
  state.primaryEnvironmentId = localId;
  state.policies = new Map(policies);
}

const renderHeader = (environmentId: EnvironmentId) =>
  render(
    <AuthorizedClientsHeaderAction
      environmentId={environmentId}
      onPairingLinkCreated={() => {}}
      clientSessions={null}
      isRevokingOtherClients={false}
      onRevokeOtherClients={() => {}}
      delegatableScopes={[]}
    />,
  );

describe("AuthorizedClientsHeaderAction", () => {
  const denial = managedCapabilityDenial(remoteClientsOff, "remoteClients")!;

  it("follows the selected service's policy, not the primary's", async () => {
    setup([[serviceId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("group", { name: denial })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("leaves pairing open on an unmanaged service when the primary is managed", async () => {
    setup([[localId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(screen.getByRole("group", { name: denial }).query()).toBeNull();
  });
});

it("offers the selected server's pairing link beside its QR code", async () => {
  using _bridge = stubGlobal("desktopBridge", undefined);
  const createdAt = "2026-01-01T00:00:00.000Z";
  const expiresAt = "2026-01-01T00:01:00.000Z";
  using _clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(createdAt));
  const credential = "local-test-pairing-code";
  await using screen = await render(
    <PairingClientsList
      shareBaseUrl="https://selected.example.test"
      endpoints={[]}
      defaultEndpointKey={null}
      isLoading={false}
      pairingLinks={[
        {
          id: "created",
          label: "New link",
          subject: "owner",
          scopes: [],
          createdAt,
          expiresAt,
        },
      ]}
      createdPairingCredentials={new Map([["created", credential]])}
      sharedPairingLinkId="created"
      clientSessions={[]}
      revokingPairingLinkId={null}
      revokingClientSessionId={null}
      onRevokePairingLink={() => {}}
      onRevokeClientSession={() => {}}
      canRevoke
    />,
  );

  await expect
    .element(screen.getByRole("img", { name: "Pairing link. Scan to open on another device" }))
    .toBeVisible();
  const desktopLink = screen.getByRole("link", { name: "Open in Sail desktop" });
  await expect.element(desktopLink).toBeVisible();
  const pairingUrl = readPairingAppLink(desktopLink.element().getAttribute("href") ?? "");
  expect(resolveRemotePairingTarget({ pairingUrl: pairingUrl ?? "" })).toMatchObject({
    httpBaseUrl: "https://selected.example.test/",
    credential,
  });
});

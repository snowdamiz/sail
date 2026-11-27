import { EnvironmentId, OrchestrationV2TurnItem, ServerSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  send: vi.fn(),
  config: null as unknown,
  settings: null as unknown,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: () => state.send,
}));
vi.mock("../../state/server", async (original) => {
  const actual = await original<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => state.config },
  };
});
vi.mock("../../state/threads", async (original) => {
  const actual = await original<typeof import("../../state/threads")>();
  return {
    ...actual,
    useEnvironmentThread: () => ({
      data: Option.some({ thread: { projectId: "fixture-project" } }),
    }),
  };
});
vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: (_id: unknown, selector: (settings: unknown) => unknown) =>
    selector(state.settings),
}));

import { SecretRequestCard } from "./SecretRequestCard";

const decodeSettings = Schema.decodeSync(ServerSettings);
const decodeItem = Schema.decodeSync(OrchestrationV2TurnItem);

function card() {
  state.send.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.settings = decodeSettings({
    secretProviders: {
      fixture: {
        kind: "one_password",
        label: "Fixture vault",
        config: { account: "fixture.example" },
      },
    },
    projectCredentialBookmarks: {
      "fixture-project": {
        key: {
          label: "Existing fixture credential",
          reference: { provider: "fixture", reference: "op://vault/item/field" },
        },
      },
    },
  });
  state.config = Atom.make({
    featureFlags: { secretProviders: true },
    secretRequestReferences: true,
    projectCredentialBookmarks: true,
    settings: state.settings,
  });
  const item = decodeItem({
    id: "item",
    threadId: "thread",
    runId: "run",
    nodeId: "node",
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "running",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-27T00:00:00.000Z"),
    type: "secret_request",
    label: "Fixture token",
    reason: "Ordinary test request",
    secretStatus: "pending",
  });
  if (item.type !== "secret_request") throw new Error("Expected a secret request");
  return (
    <SecretRequestCard
      environmentId={EnvironmentId.make("fixture-env")}
      item={item}
      visibility="local"
    />
  );
}

it("only saves a new vault item after the owner selects it and chooses a vault", async () => {
  await using screen = await render(card());
  const secret = screen.container.querySelector('input[type="password"]');
  if (!secret) throw new Error("Expected private input");
  await userEvent.type(secret, "synthetic-value");
  await expect.element(screen.getByRole("button", { name: "Save securely" })).toBeEnabled();
  const vaultToggle = screen.container.querySelector<HTMLElement>('[role="checkbox"]');
  if (!vaultToggle) throw new Error("Expected explicit vault save toggle");
  vaultToggle.focus();
  await userEvent.keyboard(" ");
  await expect
    .element(screen.getByRole("button", { name: "Save to vault and use" }))
    .toBeDisabled();
  await userEvent.click(screen.getByRole("combobox", { name: "Secret provider" }));
  await userEvent.click(screen.getByRole("option", { name: "Fixture vault" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Vault name or ID" }),
    "Fixture project",
  );
  await expect.element(screen.getByRole("button", { name: "Save to vault and use" })).toBeEnabled();
  expect(state.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Save to vault and use" }));
  expect(state.send).toHaveBeenCalledExactlyOnceWith({
    environmentId: "fixture-env",
    input: {
      threadId: "thread",
      turnItemId: "item",
      answer: {
        type: "save-to-vault",
        provider: "fixture",
        vault: "Fixture project",
        label: "Fixture token",
        secret: "synthetic-value",
      },
    },
  });
});

it("offers the project's saved reference but waits for explicit approval", async () => {
  await using screen = await render(card());
  await userEvent.click(screen.getByRole("button", { name: "Existing fixture credential" }));
  expect(state.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Save securely" }));
  expect(state.send).toHaveBeenCalledExactlyOnceWith({
    environmentId: "fixture-env",
    input: {
      threadId: "thread",
      turnItemId: "item",
      answer: {
        type: "reference",
        reference: { provider: "fixture", reference: "op://vault/item/field" },
      },
    },
  });
});

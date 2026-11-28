import { RegistryContext } from "@effect/atom-react";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import type { BoatsView } from "@t3tools/client-runtime/state/boats";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import {
  BOAT_COMMAND_SCOPES,
  EnvironmentId,
  type BoatCommand,
  type BoatInvokeInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { GTProvider } from "gt-react";
import { startTransition, useEffect, useLayoutEffect, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { environmentCatalog } from "../../connection/catalog";
import { BoatAccessContext } from "./access";
import { useMachineDetails } from "./api";
import { AgentNames } from "./components/AgentLogos";
import { useSecsLeft } from "./components/common";
import type { MachineView, UiState } from "./types";

class MockBoatInvokeError extends Schema.TaggedError<
  MockBoatInvokeError,
  { readonly brand: unique symbol }
>()("MockBoatInvokeError", {
  message: Schema.String,
}) {}

const state = vi.hoisted(() => ({
  registry: null as unknown as AtomRegistry.AtomRegistry,
  view: null as unknown as Atom.Writable<AsyncResult.AsyncResult<BoatsView>>,
  remoteViews: new Map<EnvironmentId, Atom.Atom<AsyncResult.AsyncResult<BoatsView>>>(),
  allowed: null as unknown as Atom.Writable<ReadonlySet<string>>,
  onHost: null as unknown as Atom.Atom<boolean>,
  replies: {} as Partial<Record<string, unknown>>,
  invoked: [] as BoatInvokeInput[],
  invokedOn: [] as EnvironmentId[],
  retryNow: vi.fn(),
  openExternal: vi.fn(async (_url: string) => undefined),
  pairFromLink: vi.fn(async (_url: string) => undefined),
}));

vi.mock(import("../../state/boats"), async (original) => ({
  ...(await original()),
  boatsEnvironment: {
    view: (({ environmentId }: { environmentId: EnvironmentId }) =>
      state.remoteViews.get(environmentId) ?? state.view) as never,
    invoke: {
      label: "boats:invoke",
      run: ((
        _registry: unknown,
        { environmentId, input }: { environmentId: EnvironmentId; input: BoatInvokeInput },
      ) =>
        Effect.suspend(() => {
          state.invokedOn.push(environmentId);
          state.invoked.push(input);
          const reply = state.replies[input.command];
          const resolved =
            typeof reply === "function"
              ? (reply as (input: BoatInvokeInput) => unknown)(input)
              : reply;
          if (resolved instanceof Error) return Effect.fail(resolved);
          if (resolved instanceof Promise) {
            return Effect.tryPromise({
              try: () => resolved,
              catch: (error) =>
                new MockBoatInvokeError({
                  message: error instanceof Error ? error.message : String(error),
                }),
            });
          }
          return Effect.succeed(resolved ?? { data: null });
        })) as never,
    } as never,
  },
  boatCommandsAllowedAtom: (() => state.allowed) as never,
}));
vi.mock(import("../../state/clientHostEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  const offHost = Atom.make(false);
  return {
    clientHostEnvironmentAtom: ((environmentId: EnvironmentId | null) =>
      environmentId !== null && environmentId === LOCAL_ENVIRONMENT
        ? state.onHost
        : offHost) as never,
  };
});
vi.mock(import("../../connection/catalog"), async (original) => {
  const { environmentCatalog } = await original();
  const { Atom } = await import("effect/reactivity");
  const catalogValueAtom = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map(),
  });
  return {
    environmentCatalog: {
      ...environmentCatalog,
      catalogValueAtom,
      retryNow: {
        ...environmentCatalog.retryNow,
        run: (_registry, environmentId) => Effect.sync(() => state.retryNow(environmentId)),
      },
      setEnabled: {
        ...environmentCatalog.setEnabled,
        run: (registry, { environmentId, enabled }) =>
          Effect.sync(() => {
            const catalog = registry.get(catalogValueAtom);
            const entry = catalog.entries.get(environmentId);
            if (entry === undefined)
              throw new Error("Environment not registered in the test catalog");
            const entries = new Map(catalog.entries).set(environmentId, { ...entry, enabled });
            registry.set(catalogValueAtom, { ...catalog, entries });
          }),
      },
    },
  };
});
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ shell: { openExternal: state.openExternal } })) as never,
}));

vi.mock(import("../desktop/DesktopWebLinkCoordinator"), async (original) => ({
  ...(await original()),
  usePairFromLink: () => state.pairFromLink,
}));

import { SailBoatsApp } from "./SailBoatsApp";

const ALL_COMMANDS = Object.keys(BOAT_COMMAND_SCOPES) as BoatCommand[];
const READ_COMMANDS = ALL_COMMANDS.filter(
  (command) => BOAT_COMMAND_SCOPES[command] === "orchestration:read",
);
const DORY_ENVIRONMENT = EnvironmentId.make("dory-env");
const LOCAL_ENVIRONMENT = EnvironmentId.make("env-1");
const FLY_ENVIRONMENT = EnvironmentId.make("fly-env");

function machine(overrides: Partial<MachineView>): MachineView {
  return {
    id: "m-1",
    environmentId: null,
    name: "skiff",
    size: "default",
    state: "idle",
    detail: "Idle",
    countdown: null,
    paired: false,
    signedOut: [],
    projects: [],
    keepAwakeUntil: null,
    keepAwakeForever: false,
    waiting: false,
    ...overrides,
  };
}

function uiState(overrides: Partial<UiState>): UiState {
  return {
    setup: "ready",
    setupBusy: false,
    account: { identifier: "me@example.com", plan: "Pro" },
    machines: [],
    costs: { today: 0, month: 0, startsToday: 0, startsLimit: 10 },
    settings: { startAtLogin: false },
    sizes: [{ id: "default", spec: "2 CPU · 4 GB", hourly: 0.05 }],
    mcp: { claudeCode: false, codex: false },
    ...overrides,
  };
}

function setup(input: {
  readonly state: UiState;
  readonly allowed?: readonly BoatCommand[];
  readonly onHost?: boolean;
  readonly machineEnvironment?: EnvironmentId;
  readonly machineEnabled?: boolean;
  readonly local?: boolean;
  readonly servers?: ReadonlyArray<{
    environmentId: EnvironmentId;
    label: string;
    state: UiState;
  }>;
}) {
  const entries = new Map<EnvironmentId, ConnectionCatalogEntry>();
  if (input.local !== false) {
    entries.set(LOCAL_ENVIRONMENT, {
      target: new PrimaryConnectionTarget({
        environmentId: LOCAL_ENVIRONMENT,
        label: "Local",
        httpBaseUrl: "http://localhost",
        wsBaseUrl: "ws://localhost",
      }),
      profile: Option.none(),
      enabled: true,
    });
  }
  if (input.machineEnvironment !== undefined) {
    entries.set(input.machineEnvironment, {
      target: new BearerConnectionTarget({
        environmentId: input.machineEnvironment,
        connectionId: "machine-connection",
        label: "Boat machine",
      }),
      profile: Option.none(),
      enabled: input.machineEnabled ?? true,
    });
  }
  state.remoteViews.clear();
  for (const { environmentId, label, state: serverState } of input.servers ?? []) {
    entries.set(environmentId, {
      target: new BearerConnectionTarget({ environmentId, label, connectionId: environmentId }),
      profile: Option.none(),
      enabled: true,
    });
    state.remoteViews.set(
      environmentId,
      Atom.make(
        AsyncResult.success<BoatsView>({
          status: { phase: "ready", error: null },
          state: serverState,
        }),
      ),
    );
  }
  state.registry = AtomRegistry.make({
    initialValues: [[environmentCatalog.catalogValueAtom, { isReady: true, entries }]],
  });
  const view: BoatsView = { status: { phase: "ready", error: null }, state: input.state };
  state.view = Atom.make<AsyncResult.AsyncResult<BoatsView>>(AsyncResult.success(view));
  state.allowed = Atom.make<ReadonlySet<string>>(new Set(input.allowed ?? ALL_COMMANDS));
  state.onHost = Atom.make(input.onHost ?? true);
  state.replies = {};
  state.invoked = [];
  state.invokedOn = [];
  state.openExternal.mockClear();
  state.pairFromLink.mockClear();
  state.retryNow.mockClear();
}

function mount() {
  return render(
    <RegistryContext.Provider value={state.registry}>
      <SailBoatsApp />
    </RegistryContext.Provider>,
    { router: "/boats" },
  );
}

const publish = (next: UiState) =>
  act(() =>
    state.registry.set(
      state.view,
      AsyncResult.success({ status: { phase: "ready", error: null }, state: next }),
    ),
  );

it("shows Boat setup in a plain browser tab from the subscribed state", async () => {
  setup({ state: uiState({ setup: "installBoat" }) });
  await using screen = await mount();

  expect(window.desktopBridge).toBeUndefined();
  await expect
    .element(screen.getByRole("heading", { name: "Set sail in two steps" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Install Boat CLI" })).toBeEnabled();
  await expect.element(screen.getByText("Desktop app required")).not.toBeInTheDocument();
});

it.each([true, false])(
  "shows the caller's Boat code and only auto-opens on the host (%s)",
  async (onHost) => {
    const url = "https://auth.localtest.me/boat/device";
    const signInState = uiState({ setup: "signInBoat" });
    const environmentId = onHost ? LOCAL_ENVIRONMENT : FLY_ENVIRONMENT;
    setup({
      state: signInState,
      onHost,
      local: onHost,
      servers: onHost ? [] : [{ environmentId, label: "Fly", state: signInState }],
    });
    state.replies.setup_action = {
      signIn: { attemptId: "boat-1", onHost, prompt: { kind: "device", url, code: "WXYZ-1234" } },
    };
    state.replies.manage_boat_sign_in = { data: "pending" };
    await using screen = await mount();

    await userEvent.click(screen.getByRole("button", { name: "Sign in to Boat" }));
    if (onHost) await publish(uiState({ setup: "signInBoat", setupBusy: true }));
    await expect
      .element(screen.getByRole("link", { name: "Open sign-in page" }))
      .toHaveAttribute("href", url);
    await expect.element(screen.getByText("WXYZ-1234")).toBeVisible();
    expect(state.openExternal).toHaveBeenCalledTimes(onHost ? 1 : 0);

    if (onHost) {
      await publish(uiState({ setup: "ready" }));
    } else {
      state.replies.manage_boat_sign_in = { data: "cancelled" };
      await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      expect(state.invoked).toContainEqual({
        command: "manage_boat_sign_in",
        args: { action: "cancel", attemptId: "boat-1" },
      });
    }
    await expect.element(screen.getByText("WXYZ-1234")).not.toBeInTheDocument();
    expect(new Set(state.invokedOn)).toEqual(new Set([environmentId]));
  },
);

it("shows another tab's Boat sign-in as busy without showing a link or code", async () => {
  setup({ state: uiState({ setup: "signInBoat", setupBusy: true }) });
  await using screen = await mount();

  await expect.element(screen.getByRole("link")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Waiting for sign-in…" })).toBeDisabled();
  expect(state.invoked).toEqual([]);
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("clears an expired Boat prompt and offers a fresh attempt", async () => {
  setup({ state: uiState({ setup: "signInBoat" }), onHost: false });
  state.replies.setup_action = {
    signIn: {
      attemptId: "expired",
      onHost: false,
      prompt: { kind: "device", url: "https://auth.localtest.me/boat/device", code: "OLD-CODE" },
    },
  };
  state.replies.manage_boat_sign_in = { data: "expired" };
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "Sign in to Boat" }));
  await expect
    .element(screen.getByText("The sign-in expired. Start again to get a new code."))
    .toBeVisible();
  await expect.element(screen.getByText("OLD-CODE")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Sign in to Boat" })).toBeEnabled();
});

it("sends a pasted Claude code and cancels from the machine details", async () => {
  setup({ state: uiState({ machines: [machine({ signedOut: ["Claude"] })] }), onHost: false });
  state.replies.sign_in_agent = {
    signIn: {
      attemptId: "agent-1",
      onHost: false,
      prompt: { kind: "paste", url: "https://auth.localtest.me/claude/authorize" },
    },
  };
  state.replies.manage_agent_sign_in = { data: "pending" };
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await expect.element(screen.getByRole("link", { name: "Open sign-in page" })).toBeVisible();
  await userEvent.fill(screen.getByLabelText("Paste the sign-in code"), "synthetic-code");
  await userEvent.click(screen.getByRole("button", { name: "Submit code" }));
  expect(state.invoked).toContainEqual({
    command: "manage_agent_sign_in",
    args: { action: "submit", attemptId: "agent-1", code: "synthetic-code" },
  });
  await expect.element(screen.getByLabelText("Paste the sign-in code")).toHaveValue("");

  state.replies.manage_agent_sign_in = { data: "cancelled" };
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(state.invoked).toContainEqual({
    command: "manage_agent_sign_in",
    args: { action: "cancel", attemptId: "agent-1" },
  });
  await expect
    .element(screen.getByRole("link", { name: "Open sign-in page" }))
    .not.toBeInTheDocument();
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("signs out from Boat settings and returns to setup", async () => {
  setup({ state: uiState({}) });
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "Boat settings" }));
  await userEvent.click(screen.getByRole("button", { name: "Sign out of Boat" }));
  expect(state.invoked).toContainEqual({ command: "sign_out_boat" });
  await publish(uiState({ setup: "signInBoat", account: null }));
  await expect.element(screen.getByRole("button", { name: "Sign in to Boat" })).toBeEnabled();
});

it("says Boats is not available here instead of starting forever", async () => {
  setup({ state: uiState({}), local: false });
  await using screen = await mount();

  await expect
    .element(screen.getByRole("heading", { name: "Boats isn't available here" }))
    .toBeVisible();
});

it("runs Boat sign-in and its follow-up commands on the saved server chosen in Boats", async () => {
  setup({
    state: uiState({}),
    servers: [
      { environmentId: FLY_ENVIRONMENT, label: "Fly", state: uiState({ setup: "signInBoat" }) },
    ],
  });
  const url = "https://auth.localtest.me/boat/device";
  state.replies.setup_action = {
    signIn: {
      attemptId: "fly-1",
      onHost: false,
      prompt: { kind: "device", url, code: "FLY-CODE" },
    },
  };
  state.replies.manage_boat_sign_in = { data: "pending" };
  await using screen = await mount();

  await expect.element(screen.getByRole("button", { name: "Boat settings" })).toBeVisible();
  const select = screen.getByRole("combobox", { name: "Boats server" });
  await expect.element(select).toHaveTextContent("Local");
  await userEvent.click(select);
  await userEvent.click(page.getByRole("option", { name: "Fly" }));
  await expect.element(select).toHaveTextContent("Fly");
  await userEvent.click(screen.getByRole("button", { name: "Sign in to Boat" }));
  await expect.element(screen.getByText("FLY-CODE")).toBeVisible();
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "manage_boat_sign_in",
      args: { action: "status", attemptId: "fly-1" },
    }),
  );
  expect(new Set(state.invokedOn)).toEqual(new Set([FLY_ENVIRONMENT]));
  expect(state.openExternal).not.toHaveBeenCalled();

  await userEvent.click(select);
  await userEvent.click(page.getByRole("option", { name: "Local" }));
  await expect.element(screen.getByText("FLY-CODE")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Boat settings" }));
  await userEvent.click(screen.getByRole("button", { name: "Sign out of Boat" }));
  expect(state.invoked.at(-1)).toEqual({ command: "sign_out_boat" });
  expect(state.invokedOn.at(-1)).toBe(LOCAL_ENVIRONMENT);
});

it("waits for a choice when several remote servers have no default", async () => {
  const signInState = uiState({ setup: "signInBoat" });
  setup({
    state: uiState({}),
    local: false,
    servers: [
      { environmentId: DORY_ENVIRONMENT, label: "Dory", state: uiState({}) },
      { environmentId: FLY_ENVIRONMENT, label: "Fly", state: signInState },
    ],
  });
  await using screen = await mount();

  const select = screen.getByRole("combobox", { name: "Boats server" });
  await expect.element(select).toHaveTextContent("Select a server");
  await expect
    .element(screen.getByRole("button", { name: "Boat settings" }))
    .not.toBeInTheDocument();
  await userEvent.click(select);
  await userEvent.click(page.getByRole("option", { name: "Fly" }));
  await expect.element(screen.getByRole("button", { name: "Sign in to Boat" })).toBeVisible();
});

it("renders state but disables every action for a client that can only read", async () => {
  setup({
    state: uiState({ machines: [machine({ name: "skiff", paired: false })] }),
    allowed: READ_COMMANDS,
  });
  await using screen = await mount();

  await expect.element(screen.getByRole("button", { name: "Details for skiff" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Add to Sail" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "New machine" })).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Boat settings" }));
  await expect
    .element(screen.getByRole("switch", { name: "Start background boats at login" }))
    .toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Add to Claude Code" })).toBeDisabled();
});

it("disables setup actions for a client without the maintain grant", async () => {
  setup({
    state: uiState({ setup: "installBoat" }),
    allowed: ALL_COMMANDS.filter((command) => command !== "setup_action" && command !== "add_mcp"),
  });
  await using screen = await mount();

  await expect.element(screen.getByRole("button", { name: "Install Boat CLI" })).toBeDisabled();
});

it("lets a remote client add, wake, and open Boat machines", async () => {
  const skiff = EnvironmentId.make("skiff-env");
  const remoteState = uiState({
    machines: [
      machine({ id: "m-1", name: "skiff", paired: false, environmentId: skiff }),
      machine({
        id: "m-2",
        name: "dory",
        state: "asleep",
        paired: true,
        environmentId: DORY_ENVIRONMENT,
      }),
    ],
  });
  setup({
    state: uiState({}),
    machineEnvironment: DORY_ENVIRONMENT,
    servers: [{ environmentId: FLY_ENVIRONMENT, label: "Fly", state: remoteState }],
  });
  const pairingUrl = "https://skiff.boat.example/pair#token=fixture";
  state.replies.pair_machine = { data: null, openUrl: pairingUrl };
  state.replies.latest_thread = { data: "thread-1" };
  state.replies.get_machine_details = {
    data: {
      id: "m-2",
      costToday: 0,
      costMonth: 0,
      awakeSecsToday: 0,
      agents: [],
      t3Version: "1.0.0",
      createdAt: 0,
      connect: false,
    },
  };
  await using screen = await mount();

  await userEvent.click(screen.getByRole("combobox", { name: "Boats server" }));
  await userEvent.click(page.getByRole("option", { name: "Fly" }));
  await expect.element(screen.getByRole("button", { name: "Details for skiff" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Add to Sail", exact: true }));
  await vi.waitFor(() => expect(state.pairFromLink).toHaveBeenCalledWith(pairingUrl, skiff));
  expect(state.openExternal).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Wake now" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({ command: "wake_machine", args: { id: "m-2" } }),
  );
  await vi.waitFor(() => expect(state.retryNow).toHaveBeenCalledWith(DORY_ENVIRONMENT));
  await userEvent.click(screen.getByRole("button", { name: "More for dory" }));
  await expect.element(page.getByRole("menuitem", { name: "Add to Sail again" })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await expect.element(screen.getByText("Sail 1.0.0")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open last thread in Sail" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "open_machine",
      args: { id: "m-2", thread: "thread-1" },
    }),
  );
  expect(new Set(state.invokedOn)).toEqual(new Set([FLY_ENVIRONMENT]));
});

it("restarts a failed daemon from Retry without reloading the page", async () => {
  setup({ state: uiState({}) });
  await using screen = await mount();
  await act(() =>
    state.registry.set(
      state.view,
      AsyncResult.success({
        status: { phase: "error", error: "sail-boatd exited unexpectedly" },
        state: uiState({}),
      }),
    ),
  );

  await expect.element(screen.getByText("sail-boatd exited unexpectedly")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(state.invoked).toEqual([{ command: "get_state" }]));
});

it("opens the newer thread even when the machine stays working", async () => {
  const working = machine({
    id: "m-2",
    name: "dory",
    paired: true,
    state: "working",
    detail: "Working",
    environmentId: DORY_ENVIRONMENT,
  });
  setup({ state: uiState({ machines: [working] }), machineEnvironment: DORY_ENVIRONMENT });
  state.replies.get_machine_details = {
    data: {
      id: "m-2",
      costToday: 0,
      costMonth: 0,
      awakeSecsToday: 0,
      agents: [],
      t3Version: "1.0.0",
      createdAt: 0,
      connect: false,
    },
  };
  state.replies.latest_thread = { data: "thread-1" };
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  const open = screen.getByRole("button", { name: "Open last thread in Sail" });
  await expect.element(open).toBeVisible();

  const count = (command: string) =>
    state.invoked.filter((input) => input.command === command).length;
  const detailsFetches = count("get_machine_details");
  state.replies.latest_thread = { data: "thread-2" };
  await publish(
    uiState({
      machines: [working],
      costs: { today: 1, month: 1, startsToday: 1, startsLimit: 10 },
    }),
  );
  await vi.waitFor(() => expect(count("get_machine_details")).toBe(detailsFetches + 1));
  expect(count("latest_thread")).toBe(0);
  await userEvent.click(open);
  await vi.waitFor(() => expect(count("open_machine")).toBe(1));
  expect(state.invoked).toContainEqual({
    command: "open_machine",
    args: { id: "m-2", thread: "thread-2" },
  });
  expect(count("latest_thread")).toBe(1);
});

it("explains when there is no thread to open on a paired machine", async () => {
  setup({
    state: uiState({
      machines: [machine({ name: "dory", environmentId: DORY_ENVIRONMENT })],
    }),
    machineEnvironment: DORY_ENVIRONMENT,
  });
  state.replies.latest_thread = { data: null };
  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));

  const open = screen.getByRole("button", { name: "Open last thread in Sail" });
  await userEvent.click(open);
  await expect.element(screen.getByText("No thread available to open.")).toBeVisible();
  await expect.element(open).toBeEnabled();
  expect(state.invoked.map((input) => input.command)).not.toContain("open_machine");
});

it("offers Add to Sail to an on-host client that has not paired this machine", async () => {
  const working = machine({
    id: "m-2",
    name: "dory",
    paired: true,
    state: "working",
    detail: "Working",
    environmentId: DORY_ENVIRONMENT,
  });
  setup({
    state: uiState({ machines: [working] }),
    machineEnvironment: EnvironmentId.make("other-machine"),
  });
  await using screen = await mount();

  const add = screen.getByRole("button", { name: "Add to Sail", exact: true });
  await expect.element(add).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await expect.element(screen.getByRole("heading", { name: "dory" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Open last thread in Sail" }))
    .not.toBeInTheDocument();
  await expect.element(add).toBeVisible();
  await userEvent.click(add);
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({ command: "pair_machine", args: { id: "m-2" } }),
  );
});

it("re-enables a saved machine from Add to Sail and then offers Open", async () => {
  setup({
    state: uiState({
      machines: [machine({ name: "dory", environmentId: DORY_ENVIRONMENT, paired: true })],
    }),
    machineEnvironment: DORY_ENVIRONMENT,
    machineEnabled: false,
  });
  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: "Add to Sail", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Open last thread in Sail" }))
    .toBeVisible();
  expect(state.invoked.map((input) => input.command)).not.toContain("pair_machine");
});

it("validates machine names, selects a size, and creates a machine from NewMachine", async () => {
  setup({
    state: uiState({
      machines: [machine({ name: "dory" })],
      sizes: [
        { id: "default", spec: "2 CPU · 4 GB", hourly: 0.05 },
        { id: "large", spec: "4 CPU · 8 GB", hourly: 0.1 },
      ],
    }),
  });
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "New machine" }));
  const nameInput = screen.getByLabelText("Name");
  const launch = screen.getByRole("button", { name: "Launch machine" });
  await expect.element(nameInput).toBeVisible();

  await userEvent.clear(nameInput);
  await expect.element(screen.getByText("Give it a name")).toBeVisible();
  await expect.element(launch).toBeDisabled();

  await userEvent.fill(nameInput, "dory");
  await expect.element(screen.getByText("You already have a machine with this name")).toBeVisible();
  await expect.element(launch).toBeDisabled();

  await userEvent.fill(nameInput, "-bad");
  await expect.element(screen.getByText("Start with a letter or number")).toBeVisible();
  await expect.element(launch).toBeDisabled();

  await userEvent.fill(nameInput, "ketch");
  await expect.element(launch).toBeEnabled();

  await userEvent.click(screen.getByText("large"));
  await userEvent.click(launch);

  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "create_machine",
      args: { name: "ketch", size: "large", projects: [] },
    }),
  );
  await expect.element(screen.getByRole("button", { name: "Details for dory" })).toBeVisible();
});

it("closes the Stay awake menu on first Escape before navigating back on second Escape", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle", detail: "Idle" })],
    }),
  });
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await expect.element(screen.getByRole("heading", { name: "dory" })).toBeVisible();

  const stayAwake = screen.getByRole("button", { name: "Stay awake for…" });
  await userEvent.click(stayAwake);
  const oneHour = page.getByRole("menuitem", { name: "1h" });
  await expect.element(oneHour).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(oneHour).not.toBeInTheDocument();
  await expect.element(screen.getByRole("heading", { name: "dory" })).toBeVisible();

  await userEvent.click(stayAwake);
  await userEvent.click(page.getByRole("menuitem", { name: "1h" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "keep_awake",
      args: { id: "m-1", minutes: 60 },
    }),
  );

  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Details for dory" })).toBeVisible();
});

it("arms delete confirmation in MachineDetails and handles refusal with Keep and Delete anyway", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle", detail: "Idle" })],
    }),
  });
  state.replies.delete_machine = (input: BoatInvokeInput) => {
    const args =
      input.command === "delete_machine"
        ? (input.args as { readonly discard?: boolean } | undefined)
        : undefined;
    if (args?.discard) return { data: null };
    return new Error("Machine has uncommitted changes");
  };
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));

  await userEvent.click(screen.getByRole("button", { name: "Delete machine…" }));
  expect(state.invoked.map((input) => input.command)).not.toContain("delete_machine");

  const confirmDelete = screen.getByRole("button", { name: "Click again to delete forever" });
  await expect.element(confirmDelete).toBeVisible();
  await userEvent.click(confirmDelete);

  await expect.element(screen.getByText("Machine has uncommitted changes")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Keep" }));
  await expect.element(screen.getByText("Machine has uncommitted changes")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Delete machine…" }));
  await userEvent.click(screen.getByRole("button", { name: "Click again to delete forever" }));
  await expect.element(screen.getByText("Machine has uncommitted changes")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "delete_machine",
      args: { id: "m-1", discard: true },
    }),
  );
});

it("applies computed light, dark, and custom theme tokens without legacy scope or canvas", async () => {
  setup({
    state: uiState({
      machines: [machine({ name: "dory", environmentId: DORY_ENVIRONMENT })],
    }),
    machineEnvironment: DORY_ENVIRONMENT,
  });
  state.replies.latest_thread = { data: null };
  await using screen = await mount();

  const root = document.documentElement;
  const workspace = document.querySelector("[data-testid='sail-boats-workspace']");
  const card = document.querySelector("[data-slot='settings-group']");
  expect(workspace).not.toBeNull();
  expect(card).not.toBeNull();

  try {
    expect(document.querySelector(".sail-boats-scope")).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();

    const lightWorkspaceBg = getComputedStyle(workspace!).backgroundColor;
    const lightWorkspaceFg = getComputedStyle(workspace!).color;
    const lightCardBg = getComputedStyle(card!).backgroundColor;
    expect(lightWorkspaceBg).not.toBe("rgb(0, 0, 0)");
    expect(lightWorkspaceBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(lightCardBg).not.toBe("rgb(0, 0, 0)");
    expect(lightCardBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(lightWorkspaceFg).not.toBe(lightWorkspaceBg);

    root.classList.add("dark");
    expect(document.querySelector(".sail-boats-scope")).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();

    const darkWorkspaceBg = getComputedStyle(workspace!).backgroundColor;
    const darkWorkspaceFg = getComputedStyle(workspace!).color;
    const darkCardBg = getComputedStyle(card!).backgroundColor;
    expect(darkWorkspaceBg).toBe("rgb(0, 0, 0)");
    expect(darkCardBg).not.toBe("rgb(0, 0, 0)");
    expect(darkCardBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(darkCardBg).not.toBe(lightCardBg);
    expect(darkWorkspaceFg).not.toBe(lightWorkspaceFg);

    root.setAttribute("data-theme-id", "custom-boats-test");
    root.style.setProperty("--app-theme-canvas", "rgb(18, 24, 38)");
    root.style.setProperty("--app-theme-surface", "rgb(32, 42, 64)");
    root.style.setProperty("--app-theme-text", "rgb(240, 244, 248)");

    expect(getComputedStyle(workspace!).backgroundColor).toBe("rgb(18, 24, 38)");
    const customCardBg = getComputedStyle(card!).backgroundColor;
    expect(customCardBg).not.toBe(darkCardBg);
    expect(customCardBg).not.toBe(lightCardBg);
    root.style.setProperty("--app-theme-surface", "rgb(64, 80, 112)");
    expect(getComputedStyle(card!).backgroundColor).not.toBe(customCardBg);
    const customLightFg = getComputedStyle(workspace!).color;
    expect(customLightFg).not.toBe(darkWorkspaceFg);
    expect(customLightFg).not.toBe(lightWorkspaceFg);
    root.style.setProperty("--app-theme-text", "rgb(12, 20, 32)");
    expect(getComputedStyle(workspace!).color).not.toBe(customLightFg);

    await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
    await userEvent.click(screen.getByRole("button", { name: "Open last thread in Sail" }));
    const notice = screen.getByText("No thread available to open.");
    await expect.element(notice).toBeVisible();
    const alert = notice.element().closest("[role='alert']");
    expect(alert?.getAttribute("data-variant")).toBe("info");
  } finally {
    root.classList.remove("dark");
    root.removeAttribute("data-theme-id");
    root.style.removeProperty("--app-theme-canvas");
    root.style.removeProperty("--app-theme-surface");
    root.style.removeProperty("--app-theme-text");
  }
});

it("does not resurrect a failed Auto sleep toggle when a subsequent unrelated action runs", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle", keepAwakeForever: false })],
    }),
  });
  state.replies.keep_awake = new Error("Failed to toggle auto sleep");
  const sleepDeferred = Promise.withResolvers<{ data: null }>();
  state.replies.sleep_machine = () => sleepDeferred.promise;

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));

  const autoSleep = screen.getByRole("switch", { name: "Auto sleep" });
  await expect.element(autoSleep).toHaveAttribute("aria-checked", "true");

  await userEvent.click(autoSleep);
  await expect.element(screen.getByText(/Failed to toggle auto sleep/)).toBeVisible();
  await expect.element(autoSleep).toHaveAttribute("aria-checked", "true");

  await userEvent.click(screen.getByRole("button", { name: "Sleep now" }));
  await expect.element(screen.getByRole("button", { name: "Sleeping…" })).toBeVisible();
  await expect.element(autoSleep).toHaveAttribute("aria-checked", "true");

  sleepDeferred.resolve({ data: null });
  await expect.element(screen.getByText("Sleeping…")).not.toBeInTheDocument();
  await expect.element(autoSleep).toHaveAttribute("aria-checked", "true");
});

it("still navigates back on Escape when a closed keepMounted dialog exists in the DOM", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  });
  await using screen = await mount();

  const closedSheet = document.createElement("div");
  closedSheet.setAttribute("role", "dialog");
  closedSheet.setAttribute("data-slot", "sheet-popup");
  document.body.append(closedSheet);

  try {
    await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
    await expect.element(screen.getByRole("heading", { name: "dory" })).toBeVisible();

    closedSheet.setAttribute("data-open", "");
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("heading", { name: "dory" })).toBeVisible();

    closedSheet.removeAttribute("data-open");
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("button", { name: "Details for dory" })).toBeVisible();
  } finally {
    closedSheet.remove();
  }
});

it("ignores an in-flight setup_action reply after switching servers", async () => {
  setup({
    state: uiState({ setup: "signInBoat" }),
    servers: [
      {
        environmentId: FLY_ENVIRONMENT,
        label: "Fly",
        state: uiState({ machines: [machine({ id: "m-fly", name: "yawl", state: "idle" })] }),
      },
    ],
  });
  const signInDeferred = Promise.withResolvers<unknown>();
  state.replies.setup_action = () => signInDeferred.promise;

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Sign in to Boat" }));

  const select = screen.getByRole("combobox", { name: "Boats server" });
  await userEvent.click(select);
  await userEvent.click(page.getByRole("option", { name: "Fly" }));
  await expect.element(screen.getByRole("button", { name: "Details for yawl" })).toBeVisible();

  signInDeferred.resolve({
    data: null,
    signIn: {
      attemptId: "stale-attempt",
      onHost: true,
      prompt: { kind: "device", url: "https://auth.example.com/stale", code: "STALE-1" },
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(state.openExternal).not.toHaveBeenCalled();
  await expect.element(screen.getByText("STALE-1")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Details for yawl" })).toBeVisible();
});

it("drops a chained open_machine flow after switching servers while wake_machine is in flight", async () => {
  setup({
    onHost: false,
    state: uiState({
      machines: [
        machine({
          id: "m-local",
          name: "dory",
          state: "asleep",
          detail: "Asleep",
          paired: true,
          environmentId: DORY_ENVIRONMENT,
        }),
      ],
    }),
    machineEnvironment: DORY_ENVIRONMENT,
    servers: [
      {
        environmentId: FLY_ENVIRONMENT,
        label: "Fly",
        state: uiState({ machines: [machine({ id: "m-fly", name: "yawl", state: "idle" })] }),
      },
    ],
  });
  const wakeDeferred = Promise.withResolvers<{ data: null }>();
  state.replies.wake_machine = () => wakeDeferred.promise;

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: "Open last thread in Sail" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "wake_machine",
      args: { id: "m-local" },
    }),
  );

  const select = screen.getByRole("combobox", { name: "Boats server" });
  await userEvent.click(select);
  await userEvent.click(page.getByRole("option", { name: "Fly" }));
  await expect.element(screen.getByRole("button", { name: "Details for yawl" })).toBeVisible();

  wakeDeferred.resolve({ data: null });
  await Promise.resolve();
  await Promise.resolve();

  expect(state.invoked.map((item) => item.command)).not.toContain("latest_thread");
  expect(state.invoked.map((item) => item.command)).not.toContain("open_machine");
  await expect.element(screen.getByRole("button", { name: "Details for yawl" })).toBeVisible();
});

it("marks only the signing-in agent as busy when multiple agents are signed out", async () => {
  setup({
    state: uiState({
      machines: [
        machine({
          id: "m-1",
          name: "dory",
          state: "idle",
          signedOut: ["Claude Code", "Codex"],
        }),
      ],
    }),
  });
  state.replies.get_machine_details = {
    data: {
      id: "m-1",
      costToday: 0.12,
      costMonth: 1.5,
      awakeSecsToday: 300,
      t3Version: "1.0.0",
      createdAt: 1767225600,
      agents: [
        { name: "Claude Code", signedIn: false },
        { name: "Codex", signedIn: false },
      ],
      connect: false,
    },
  };
  const signInDeferred = Promise.withResolvers<{ data: null }>();
  state.replies.sign_in_agent = () => signInDeferred.promise;

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));

  const signInButtons = screen.getByRole("button", { name: "Sign in" });
  await expect.element(signInButtons.nth(0)).toBeVisible();
  await expect.element(signInButtons.nth(1)).toBeVisible();

  await userEvent.click(signInButtons.nth(0));
  const agentsHeading = screen.getByRole("heading", { name: "Agents" }).element();
  const agentsSection = agentsHeading.closest("section");
  expect(agentsSection).not.toBeNull();
  const agentButtons = Array.from(agentsSection!.querySelectorAll("button"));
  expect(agentButtons).toHaveLength(2);
  expect(agentButtons[0]?.textContent).toContain("Signing in…");
  expect(agentButtons[0]?.getAttribute("aria-busy")).toBe("true");
  expect(agentButtons[1]?.textContent).toBe("Sign in");
  expect(agentButtons[1]?.getAttribute("aria-busy")).toBe("false");
  expect(agentButtons[1]?.disabled).toBe(true);

  signInDeferred.resolve({ data: null });
  await vi.waitFor(() => {
    const buttons = Array.from(agentsSection!.querySelectorAll("button"));
    expect(buttons.every((button) => button.textContent === "Sign in")).toBe(true);
  });
});

it("offers Remove without an overflow menu for missing machines and discards on MachineDetails", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-gone", name: "ghost", state: "missing", detail: "Missing" })],
    }),
  });
  await using screen = await mount();

  await expect.element(screen.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "More for ghost" }))
    .not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Details for ghost" }));
  await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));
  await userEvent.click(screen.getByRole("button", { name: "Remove machine…" }));
  await userEvent.click(screen.getByRole("button", { name: "Click again to remove" }));

  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "delete_machine",
      args: { id: "m-gone", discard: true },
    }),
  );
});

it("filters projects in ProjectPicker and closes the popover on Escape before navigating back", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  });
  state.replies.local_projects = {
    data: [
      {
        id: "p-1",
        title: "Alpha Repo",
        path: "/Users/me/alpha",
        repoKey: "org/alpha",
        icon: null,
      },
      {
        id: "p-2",
        title: "Beta Repo",
        path: "/Users/me/beta",
        repoKey: "org/beta",
        icon: null,
      },
    ],
  };

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: "Add a project…" }));

  const filterInput = page.getByRole("combobox", { name: "Filter projects" });
  await expect.element(filterInput).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Alpha Repo/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Beta Repo/ })).toBeVisible();

  await userEvent.fill(filterInput, "Beta");
  await expect.element(page.getByRole("option", { name: /Beta Repo/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Alpha Repo/ })).not.toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await expect.element(filterInput).not.toBeInTheDocument();
  await expect.element(screen.getByRole("heading", { name: "dory" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Add a project…" }));
  await userEvent.click(page.getByRole("option", { name: /Beta Repo/ }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "add_project",
      args: { id: "m-1", projectId: "p-2" },
    }),
  );
  await vi.waitFor(() => expect(document.querySelector("[data-slot='popover-popup']")).toBeNull());

  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Details for dory" })).toBeVisible();
});

it("keeps MachineMenu open on first delete click and deletes on the second click", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  });
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "More for dory" }));
  const firstDelete = page.getByRole("menuitem", { name: "Delete machine…" });
  await expect.element(firstDelete).toBeVisible();
  await userEvent.click(firstDelete);

  expect(state.invoked.map((item) => item.command)).not.toContain("delete_machine");
  const confirmDelete = page.getByRole("menuitem", { name: "Click again to delete forever" });
  await expect.element(confirmDelete).toBeVisible();

  await userEvent.click(confirmDelete);
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "delete_machine",
      args: { id: "m-1", discard: false },
    }),
  );
});

it("toggles start-at-login and adds an MCP client from SettingsView", async () => {
  setup({
    state: uiState({
      settings: { startAtLogin: false },
      mcp: { claudeCode: false, codex: true },
    }),
  });
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "Boat settings" }));
  const startAtLogin = screen.getByRole("switch", { name: "Start background boats at login" });
  await expect.element(startAtLogin).toHaveAttribute("aria-checked", "false");
  await userEvent.click(startAtLogin);

  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "update_settings",
      args: { settings: { startAtLogin: true } },
    }),
  );

  await expect.element(screen.getByText("Added")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Add to Claude Code" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "add_mcp",
      args: { client: "claudeCode" },
    }),
  );
});

it("renders the SignInPanel paste-code input as a styled Sail Input and submits the code", async () => {
  setup({
    state: uiState({
      setup: "signInBoat",
    }),
  });
  state.replies.setup_action = {
    data: null,
    signIn: {
      attemptId: "attempt-1",
      onHost: false,
      prompt: { kind: "paste", url: "https://example.com/auth" },
    },
  };
  state.replies.manage_boat_sign_in = { data: "pending" };
  await using screen = await mount();

  await userEvent.click(screen.getByRole("button", { name: "Sign in to Boat" }));
  const codeInput = screen.getByLabelText("Paste the sign-in code");
  await expect.element(codeInput).toBeVisible();
  expect(codeInput.element().getAttribute("data-slot")).toBe("input");
  expect(codeInput.element().closest("[data-slot='input-control']")).not.toBeNull();

  await userEvent.fill(codeInput, "boat-code-123");
  await userEvent.click(screen.getByRole("button", { name: "Submit code" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "manage_boat_sign_in",
      args: { action: "submit", attemptId: "attempt-1", code: "boat-code-123" },
    }),
  );
});

it("does not show a stale details error after unmounting MachineDetails with a pending failure", async () => {
  setup({
    state: uiState({
      machines: [
        machine({ id: "m-1", name: "dory", state: "idle" }),
        machine({ id: "m-2", name: "yawl", state: "idle" }),
      ],
    }),
  });
  const doryDetailsDeferred = Promise.withResolvers<unknown>();
  state.replies.get_machine_details = (input: BoatInvokeInput) => {
    const id =
      input.command === "get_machine_details"
        ? (input.args as { readonly id?: string } | undefined)?.id
        : undefined;
    if (id === "m-1") return doryDetailsDeferred.promise;
    return {
      data: {
        id: "m-2",
        costToday: 0,
        costMonth: 0,
        awakeSecsToday: 0,
        agents: [],
        t3Version: "2.0.0",
        createdAt: 1767225600,
        connect: false,
      },
    };
  };

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "get_machine_details",
      args: { id: "m-1" },
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await userEvent.click(screen.getByRole("button", { name: "Details for yawl" }));
  await expect.element(screen.getByText("Sail 2.0.0")).toBeVisible();

  await act(async () => {
    doryDetailsDeferred.reject(new Error("Stale details failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  await expect.element(screen.getByText(/Stale details failure/)).not.toBeInTheDocument();
  await expect.element(screen.getByText(/Couldn't load details/)).not.toBeInTheDocument();
});

it("disarms delete confirmation when an unrelated action disables and re-enables the button", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  });
  const sleepDeferred = Promise.withResolvers<{ data: null }>();
  state.replies.sleep_machine = () => sleepDeferred.promise;

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));

  await userEvent.click(screen.getByRole("button", { name: "Delete machine…" }));
  await expect
    .element(screen.getByRole("button", { name: "Click again to delete forever" }))
    .toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Sleep now" }));
  await expect.element(screen.getByRole("button", { name: "Sleeping…" })).toBeVisible();

  sleepDeferred.resolve({ data: null });
  await expect.element(screen.getByText("Sleeping…")).not.toBeInTheDocument();

  await expect
    .element(screen.getByRole("button", { name: "Click again to delete forever" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Delete machine…" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Delete machine…" }));
  expect(state.invoked.map((item) => item.command)).not.toContain("delete_machine");
  await expect
    .element(screen.getByRole("button", { name: "Click again to delete forever" }))
    .toBeVisible();
});

it("keeps keyboard focus on MachineDetails resize radios without firing resize until Resize is clicked", async () => {
  const sizes = [
    { id: "small", spec: "1 CPU · 2 GB", hourly: 0.025 },
    { id: "default", spec: "2 CPU · 4 GB", hourly: 0.05 },
    { id: "large", spec: "4 CPU · 8 GB", hourly: 0.1 },
  ];
  setup({
    state: uiState({
      sizes,
      machines: [machine({ id: "m-1", name: "dory", size: "small", state: "idle" })],
    }),
  });
  const resizeDeferred = Promise.withResolvers<{ data: null }>();
  state.replies.resize_machine = () => resizeDeferred.promise;

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));

  const smallRadio = screen.getByRole("radio", { name: /^small/ });
  const defaultRadio = screen.getByRole("radio", { name: /^default/ });
  const largeRadio = screen.getByRole("radio", { name: /^large/ });

  (smallRadio.element() as HTMLInputElement).focus();
  expect(document.activeElement).toBe(smallRadio.element());

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(defaultRadio).toBeChecked();
  expect(document.activeElement).toBe(defaultRadio.element());
  expect(state.invoked.map((item) => item.command)).not.toContain("resize_machine");

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(largeRadio).toBeChecked();
  expect(document.activeElement).toBe(largeRadio.element());
  expect(state.invoked.map((item) => item.command)).not.toContain("resize_machine");

  await expect.element(screen.getByRole("button", { name: "Resize to large" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await expect.element(smallRadio).toBeChecked();
  await expect
    .element(screen.getByRole("button", { name: "Resize to large" }))
    .not.toBeInTheDocument();

  await userEvent.click(screen.getByText("large"));
  await userEvent.click(screen.getByRole("button", { name: "Resize to large" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "resize_machine",
      args: { id: "m-1", size: "large" },
    }),
  );
  const resizingButtons = screen.getByRole("button", { name: "Resizing…" });
  await expect.element(resizingButtons.nth(0)).toBeDisabled();
  await expect.element(resizingButtons.nth(1)).toBeDisabled();
  await expect.element(smallRadio).toBeDisabled();
  await expect.element(defaultRadio).toBeDisabled();
  await expect.element(largeRadio).toBeDisabled();

  resizeDeferred.resolve({ data: null });
  await publish(
    uiState({
      sizes,
      machines: [machine({ id: "m-1", name: "dory", size: "large", state: "idle" })],
    }),
  );
  await expect.element(screen.getByRole("button", { name: "Resizing…" })).not.toBeInTheDocument();
  await expect.element(largeRadio).toBeChecked();
  await expect.element(largeRadio).toBeEnabled();
});

it("disables all MachineDetails size options including the current size when resize is not permitted", async () => {
  setup({
    state: uiState({
      sizes: [
        { id: "small", spec: "1 CPU · 2 GB", hourly: 0.025 },
        { id: "large", spec: "4 CPU · 8 GB", hourly: 0.1 },
      ],
      machines: [machine({ id: "m-1", name: "dory", size: "small", state: "idle" })],
    }),
    allowed: READ_COMMANDS,
  });

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));

  await expect.element(screen.getByRole("radio", { name: /^small/ })).toBeDisabled();
  await expect.element(screen.getByRole("radio", { name: /^large/ })).toBeDisabled();
});

it("disables Sign in and Connect on other machines while sign_in_agent is in flight", async () => {
  setup({
    state: uiState({
      machines: [
        machine({ id: "m-1", name: "dory", state: "idle", signedOut: ["Claude Code"] }),
        machine({ id: "m-2", name: "yawl", state: "idle", signedOut: ["Codex"] }),
      ],
    }),
  });
  const signInDeferred = Promise.withResolvers<unknown>();
  state.replies.sign_in_agent = () => signInDeferred.promise;
  state.replies.get_machine_details = (input: BoatInvokeInput) => {
    const id =
      input.command === "get_machine_details"
        ? (input.args as { readonly id?: string } | undefined)?.id
        : undefined;
    return {
      data: {
        id: id ?? "m-2",
        costToday: 0,
        costMonth: 0,
        awakeSecsToday: 0,
        t3Version: "1.0.0",
        createdAt: 1767225600,
        agents: [{ name: id === "m-1" ? "Claude Code" : "Codex", signedIn: false }],
        connect: false,
      },
    };
  };

  await using screen = await mount();
  const listSignInButtons = screen.getByRole("button", { name: "Sign in" });
  await userEvent.click(listSignInButtons.nth(0));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "sign_in_agent",
      args: { id: "m-1", agent: "Claude Code" },
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await expect.element(screen.getByRole("button", { name: "Sign in" }).nth(1)).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Details for yawl" }));
  await expect.element(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Turn on" })).toBeDisabled();

  signInDeferred.reject(new Error("Sign-in cancelled"));
  await expect.element(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "Turn on" })).toBeEnabled();
});

it("keeps ProjectPicker closed when re-enabled after being disabled while open", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  });
  state.replies.local_projects = {
    data: [
      {
        id: "p-1",
        title: "Alpha Repo",
        path: "/Users/me/alpha",
        repoKey: "org/alpha",
        icon: null,
      },
    ],
  };

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: "Add a project…" }));

  const filterInput = page.getByRole("combobox", { name: "Filter projects" });
  await expect.element(filterInput).toBeVisible();

  await act(() =>
    state.registry.set(
      state.allowed,
      new Set(ALL_COMMANDS.filter((command) => command !== "add_project")),
    ),
  );
  await expect.element(filterInput).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Add a project…" })).toBeDisabled();

  await act(() => state.registry.set(state.allowed, new Set(ALL_COMMANDS)));
  await expect.element(screen.getByRole("button", { name: "Add a project…" })).toBeEnabled();
  await expect.element(filterInput).not.toBeInTheDocument();
});

it("ignores modified Escape chords including Shift+Escape before navigating back on unmodified Escape", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  });

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "New machine" }));
  await expect.element(screen.getByRole("heading", { name: "New machine" })).toBeVisible();

  for (const modifiers of [
    { shiftKey: true },
    { metaKey: true },
    { ctrlKey: true },
    { altKey: true },
  ]) {
    await act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...modifiers }),
      );
    });
    await expect.element(screen.getByRole("heading", { name: "New machine" })).toBeVisible();
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Details for dory" })).toBeVisible();
});

it("updates useSecsLeft on minute boundaries above 60s and stops scheduling timers after expiry", async () => {
  using _timers = fakeTimers({ now: 10_000 });
  let renders = 0;

  function CountdownProbe({ endsAt }: { readonly endsAt: number | null }) {
    renders += 1;
    const secs = useSecsLeft(endsAt);
    return <output data-testid="countdown-secs">{secs}</output>;
  }

  await using screen = await render(<CountdownProbe endsAt={10_000 + 180_000} />, {
    router: false,
  });

  const output = screen.getByTestId("countdown-secs");
  expect(output.element().textContent).toBe("180");
  expect(renders).toBe(1);

  await act(() => vi.advanceTimersByTime(59_000));
  expect(output.element().textContent).toBe("180");
  expect(renders).toBe(1);

  await act(() => vi.advanceTimersByTime(1_000));
  expect(output.element().textContent).toBe("120");
  expect(renders).toBe(2);

  await act(() => vi.advanceTimersByTime(59_000));
  expect(output.element().textContent).toBe("120");
  expect(renders).toBe(2);

  await act(() => vi.advanceTimersByTime(1_000));
  expect(output.element().textContent).toBe("60");
  expect(renders).toBe(3);

  await act(() => vi.advanceTimersByTime(1_000));
  expect(output.element().textContent).toBe("59");
  expect(renders).toBe(4);

  await act(() => vi.advanceTimersByTime(59_000));
  expect(output.element().textContent).toBe("0");
  const rendersAtExpiry = renders;

  await act(() => vi.advanceTimersByTime(10_000));
  expect(renders).toBe(rendersAtExpiry);
  expect(vi.getTimerCount()).toBe(0);

  await screen.rerender(<CountdownProbe endsAt={200_250} />);
  expect(output.element().textContent).toBe("1");
  await act(() => vi.advanceTimersByTime(250));
  expect(output.element().textContent).toBe("0");
  expect(vi.getTimerCount()).toBe(0);
});

it("formats AgentNames conjunctions using the active GT locale", async () => {
  await using screen = await render(
    <GTProvider locale="en" translations={{}}>
      <AgentNames names={["Claude Code", "Codex"]} />
    </GTProvider>,
    { router: false },
  );
  expect(screen.container.textContent).toBe("Claude Code and Codex");

  await screen.rerender(
    <GTProvider locale="de" translations={{}}>
      <AgentNames names={["Claude Code", "Codex"]} />
    </GTProvider>,
  );
  expect(screen.container.textContent).toBe("Claude Code und Codex");
});

it("fences stale machine details rejections during the commit-to-passive-cleanup window", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  });
  const firstDeferred = Promise.withResolvers<unknown>();
  const secondDeferred = Promise.withResolvers<unknown>();
  let calls = 0;
  state.replies.get_machine_details = () => {
    calls += 1;
    return calls === 1 ? firstDeferred.promise : secondDeferred.promise;
  };

  const onError = vi.fn();
  const events: string[] = [];
  const passiveCleanups = new Set<number>();
  let onDepCommit: (() => void) | null = null;
  let onListLayoutMount: (() => void) | null = null;
  let updateHarness:
    | ((next: { readonly view: "details" | "list"; readonly version: number }) => void)
    | null = null;

  function DetailsProbe({ version }: { readonly version: number }) {
    const details = useMachineDetails("m-1", version, onError);
    useLayoutEffect(() => {
      onDepCommit?.();
      onDepCommit = null;
    }, [version]);
    useEffect(
      () => () => {
        passiveCleanups.add(version);
        events.push(`passive-cleanup:${version}`);
      },
      [version],
    );
    return <output data-testid="details-probe">{details?.t3Version ?? "loading"}</output>;
  }

  function ListProbe() {
    useLayoutEffect(() => {
      onListLayoutMount?.();
      onListLayoutMount = null;
    }, []);
    return <div data-testid="list-probe">list</div>;
  }

  function Harness() {
    const [harness, setHarness] = useState<{
      readonly view: "details" | "list";
      readonly version: number;
    }>({ view: "details", version: 1 });
    useLayoutEffect(() => {
      updateHarness = setHarness;
      return () => {
        updateHarness = null;
      };
    }, []);
    return harness.view === "details" ? <DetailsProbe version={harness.version} /> : <ListProbe />;
  }

  await using screen = await render(
    <RegistryContext.Provider value={state.registry}>
      <BoatAccessContext.Provider
        value={{
          environmentId: LOCAL_ENVIRONMENT,
          can: () => true,
          isPaired: () => false,
          onHost: true,
        }}
      >
        <Harness />
      </BoatAccessContext.Provider>
    </RegistryContext.Provider>,
    { router: false },
  );
  await vi.waitFor(() => expect(calls).toBe(1));

  onDepCommit = () => {
    expect(passiveCleanups.has(1)).toBe(false);
    events.push("layout-commit:2");
    firstDeferred.reject(new Error("Stale dep-change details failure"));
    void firstDeferred.promise.catch(() => {
      events.push("rejected-microtask:1");
    });
  };
  startTransition(() => updateHarness?.({ view: "details", version: 2 }));
  await vi.waitFor(() => expect(calls).toBe(2));
  await vi.waitFor(() => expect(passiveCleanups.has(1)).toBe(true));
  expect(events.indexOf("rejected-microtask:1")).toBeGreaterThan(-1);
  expect(events.indexOf("rejected-microtask:1")).toBeLessThan(events.indexOf("passive-cleanup:1"));
  expect(onError).not.toHaveBeenCalled();

  onListLayoutMount = () => {
    expect(passiveCleanups.has(2)).toBe(false);
    events.push("list-layout-mount");
    secondDeferred.reject(new Error("Stale unmount details failure"));
    void secondDeferred.promise.catch(() => {
      events.push("rejected-microtask:2");
    });
  };
  startTransition(() => updateHarness?.({ view: "list", version: 2 }));
  await expect.element(screen.getByTestId("list-probe")).toBeVisible();
  await vi.waitFor(() => expect(passiveCleanups.has(2)).toBe(true));
  expect(events.indexOf("rejected-microtask:2")).toBeGreaterThan(-1);
  expect(events.indexOf("rejected-microtask:2")).toBeLessThan(events.indexOf("passive-cleanup:2"));
  expect(onError).not.toHaveBeenCalled();
});

it("disarms delete confirmation when delete intent changes across idle -> missing -> idle within 3s", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  });
  state.replies.delete_machine = { data: null };

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));

  await userEvent.click(screen.getByRole("button", { name: "Delete machine…" }));
  await expect
    .element(screen.getByRole("button", { name: "Click again to delete forever" }))
    .toBeVisible();

  await publish(
    uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "missing" })],
    }),
  );
  await expect.element(screen.getByRole("button", { name: "Remove machine…" })).toBeVisible();

  await publish(
    uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "Click again to delete forever" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Delete machine…" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Delete machine…" }));
  expect(state.invoked.map((item) => item.command)).not.toContain("delete_machine");
  await expect
    .element(screen.getByRole("button", { name: "Click again to delete forever" }))
    .toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Click again to delete forever" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "delete_machine",
      args: { id: "m-1", discard: false },
    }),
  );
});

it("disarms row primary delete confirmation when an ordinary control replaces it within 3s", async () => {
  setup({
    state: uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "missing" })],
    }),
  });
  state.replies.delete_machine = { data: null };

  await using screen = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Remove" }));
  await expect.element(screen.getByRole("button", { name: "Confirm" })).toBeVisible();

  await publish(
    uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "idle" })],
    }),
  );
  await expect.element(screen.getByRole("button", { name: "Add to Sail" })).toBeVisible();

  await publish(
    uiState({
      machines: [machine({ id: "m-1", name: "dory", state: "missing" })],
    }),
  );
  await expect.element(screen.getByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Remove" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(state.invoked.map((item) => item.command)).not.toContain("delete_machine");
  await expect.element(screen.getByRole("button", { name: "Confirm" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await vi.waitFor(() =>
    expect(state.invoked).toContainEqual({
      command: "delete_machine",
      args: { id: "m-1", discard: true },
    }),
  );
});

it("never strands a nonzero useSecsLeft snapshot or slips a minute when Date.now crosses a boundary between reads", async () => {
  using _timers = fakeTimers({ now: 0 });
  let now = 0;
  let nextNowAfterRead: number | null = null;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
    const current = now;
    if (nextNowAfterRead !== null) {
      now = nextNowAfterRead;
      nextNowAfterRead = null;
    }
    return current;
  });

  let onAfterRender: (() => void) | null = null;
  function CountdownProbe({ endsAt }: { readonly endsAt: number | null }) {
    const secs = useSecsLeft(endsAt);
    onAfterRender?.();
    onAfterRender = null;
    return <output data-testid="countdown-boundary">{secs}</output>;
  }

  try {
    now = 999;
    onAfterRender = () => {
      now = 1_000;
    };
    await using screen = await render(<CountdownProbe endsAt={1_000} />, { router: false });
    const output = screen.getByTestId("countdown-boundary");
    expect(output.element().textContent).toBe("0");
    expect(vi.getTimerCount()).toBe(0);

    now = 1_999;
    onAfterRender = () => {
      nextNowAfterRead = 2_000;
    };
    await screen.rerender(<CountdownProbe endsAt={2_000} />);
    expect(output.element().textContent).toBe("1");
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTime(1));
    expect(output.element().textContent).toBe("0");
    expect(vi.getTimerCount()).toBe(0);

    now = 2_900;
    await screen.rerender(<CountdownProbe endsAt={3_000} />);
    expect(output.element().textContent).toBe("1");
    expect(vi.getTimerCount()).toBe(1);
    now = 2_999;
    nextNowAfterRead = 3_000;
    await act(() => vi.advanceTimersByTime(100));
    expect(output.element().textContent).toBe("1");
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTime(1));
    expect(output.element().textContent).toBe("0");
    expect(vi.getTimerCount()).toBe(0);

    now = 999;
    onAfterRender = () => {
      nextNowAfterRead = 1_000;
    };
    await screen.rerender(<CountdownProbe endsAt={121_000} />);
    expect(output.element().textContent).toBe("180");
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTime(1));
    expect(output.element().textContent).toBe("120");
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    nowSpy.mockRestore();
  }
});

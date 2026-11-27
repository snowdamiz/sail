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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { environmentCatalog } from "../../connection/catalog";
import type { MachineView, UiState } from "./types";

const state = vi.hoisted(() => ({
  registry: null as unknown as AtomRegistry.AtomRegistry,
  view: null as unknown as Atom.Writable<AsyncResult.AsyncResult<BoatsView>>,
  remoteViews: new Map<EnvironmentId, Atom.Atom<AsyncResult.AsyncResult<BoatsView>>>(),
  allowed: null as unknown as Atom.Atom<ReadonlySet<string>>,
  onHost: null as unknown as Atom.Atom<boolean>,
  replies: {} as Partial<Record<string, unknown>>,
  invoked: [] as BoatInvokeInput[],
  invokedOn: [] as EnvironmentId[],
  openExternal: vi.fn(async (_url: string) => undefined),
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
        Effect.sync(() => {
          state.invokedOn.push(environmentId);
          state.invoked.push(input);
          return state.replies[input.command] ?? { data: null };
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

it("hides Open and Add to Sail for a client that is not on the server's host", async () => {
  setup({
    state: uiState({
      machines: [
        machine({ id: "m-1", name: "skiff", paired: false }),
        machine({ id: "m-2", name: "dory", paired: true, environmentId: DORY_ENVIRONMENT }),
      ],
    }),
    onHost: false,
    machineEnvironment: DORY_ENVIRONMENT,
  });
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

  await expect.element(screen.getByRole("button", { name: "Details for skiff" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Add to Sail" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "More for dory" }));
  await expect.element(screen.getByRole("menuitem", { name: "Sleep now" })).toBeVisible();
  await expect
    .element(screen.getByRole("menuitem", { name: "Add to Sail again" }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  await userEvent.click(screen.getByRole("button", { name: "Details for dory" }));
  await expect.element(screen.getByText("Sail 1.0.0")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Open .*in Sail/ }))
    .not.toBeInTheDocument();
  expect(state.invoked.map((input) => input.command)).not.toContain("latest_thread");
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

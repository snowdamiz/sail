import { createMemoryHistory } from "@tanstack/react-router";
import {
  IsoDateTime,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SessionTransferId,
  ThreadId,
  TrimmedNonEmptyString,
  WS_METHODS,
  type SessionTransferCancelInput,
  type SessionTransferPreflightInput,
  type SessionTransferPreflightResult,
  type SessionTransferProgressEvent,
  type SessionTransferRecord,
  type SessionTransferRetryInput,
  type SessionTransferStartInput,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import stylesheet from "~/index.css?inline";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  answerRpc,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  PROJECT_ID,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const AT = IsoDateTime.make("2026-03-17T19:12:28.000Z");

function makeTransferRecord(
  overrides: Partial<SessionTransferRecord> & {
    readonly transferId: SessionTransferId;
    readonly sourceThreadId: ThreadId;
    readonly phase: SessionTransferRecord["phase"];
  },
): SessionTransferRecord {
  return {
    direction: "local_to_boat",
    sourceEnvironmentId: ENVIRONMENT_ID,
    sourceEnvironmentName: TrimmedNonEmptyString.make("Local"),
    sourceMachineId: null,
    sourceProjectId: PROJECT_ID,
    destinationEnvironmentId: ENVIRONMENT_ID,
    destinationEnvironmentName: TrimmedNonEmptyString.make("skiff"),
    destinationMachineId: TrimmedNonEmptyString.make("skiff"),
    destinationProjectId: PROJECT_ID,
    destinationThreadId: ThreadId.make("dest-thread"),
    phaseDetail: null,
    sourceWasRunning: false,
    autoResume: false,
    hadPendingRuntimeRequest: false,
    destinationBranch: null,
    destinationWorktreePath: null,
    modelSelectionOverride: null,
    cloneDestinationPath: null,
    warnings: [],
    errorMessage: null,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
    ...overrides,
  };
}

async function mountDesktopStage(): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  await page.viewport(1400, 900);
  return {
    async [Symbol.asyncDispose]() {
      style.remove();
      await page.viewport(previous.width, previous.height);
    },
  };
}

function setupSettings() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
}

it("hides Move to Boat and never touches sail-boatd when hasConfiguredBoats is false", async () => {
  const sourceThread = threadWithHistory("alpha", 1);
  using _environment = installFakeEnvironment([sourceThread], {
    serverConfigOverrides: { hasConfiguredBoats: false, sessionTransfer: true },
  });
  await using _stage = await mountDesktopStage();
  setupSettings();

  let boatsSubscribed = false;
  let boatsInvoked = false;
  using _boatsSub = answerRpc(WS_METHODS.subscribeBoats, () => {
    boatsSubscribed = true;
    return Stream.never;
  });
  using _boatsInvoke = answerRpc(WS_METHODS.boatsInvoke, () => {
    boatsInvoked = true;
    return Effect.succeed({ data: { machines: [] } });
  });
  using _transfersSub = answerRpc(WS_METHODS.subscribeSessionTransfers, () =>
    Stream.concat(Stream.make({ _tag: "snapshot" as const, transfers: [] }), Stream.never),
  );

  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/alpha`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  const row = page.getByText("Thread alpha").first();
  await expect.element(row).toBeVisible();
  await userEvent.click(row, { button: "right" });

  await expect.element(page.getByRole("menuitem", { name: "Archive thread" })).toBeVisible();
  expect(page.getByRole("menuitem", { name: /Move to Boat/i }).query()).toBeNull();
  expect(boatsSubscribed).toBe(false);
  expect(boatsInvoked).toBe(false);
});

it("opens the Move to Boat submenu lazily, resolves preflight dialog options, and starts transfer", async () => {
  const sourceThread = threadWithHistory("beta", 1);
  using _environment = installFakeEnvironment([sourceThread], {
    serverConfigOverrides: { hasConfiguredBoats: true, sessionTransfer: true },
  });
  await using _stage = await mountDesktopStage();
  setupSettings();

  let boatsSubscribed = false;
  const boatsCommands: unknown[] = [];
  const preflightCalls: SessionTransferPreflightInput[] = [];
  const startCalls: SessionTransferStartInput[] = [];

  using _boatsSub = answerRpc(WS_METHODS.subscribeBoats, () => {
    boatsSubscribed = true;
    return Stream.never;
  });
  using _boatsInvoke = answerRpc(WS_METHODS.boatsInvoke, (input: unknown) => {
    boatsCommands.push(input);
    return Effect.succeed({
      data: {
        machines: [
          {
            id: "skiff",
            environmentId: null,
            name: "skiff",
            size: "small",
            state: "idle",
            detail: "",
            countdown: null,
            paired: true,
            signedOut: [],
            projects: [],
            keepAwakeUntil: null,
            keepAwakeForever: false,
            waiting: false,
          },
          {
            id: "dinghy",
            environmentId: null,
            name: "dinghy",
            size: "small",
            state: "creating",
            detail: "",
            countdown: null,
            paired: false,
            signedOut: [],
            projects: [],
            keepAwakeUntil: null,
            keepAwakeForever: false,
            waiting: false,
          },
        ],
      },
    });
  });
  using _transfersSub = answerRpc(WS_METHODS.subscribeSessionTransfers, () =>
    Stream.concat(Stream.make({ _tag: "snapshot" as const, transfers: [] }), Stream.never),
  );
  using _preflight = answerRpc(
    WS_METHODS.sessionTransferPreflight,
    (input: SessionTransferPreflightInput) => {
      preflightCalls.push(input);
      const result: SessionTransferPreflightResult = {
        ready: false,
        warnings: ["Untracked build artifacts will not be transferred."],
        needsProjectSelection: true,
        candidateProjects: [
          {
            projectId: ProjectId.make("boat-proj-1"),
            name: "sail-main",
            workspaceRoot: TrimmedNonEmptyString.make("/home/dev/sail-main"),
            matchReason: "repository_identity",
          },
          {
            projectId: ProjectId.make("boat-proj-2"),
            name: "sail-alt",
            workspaceRoot: TrimmedNonEmptyString.make("/home/dev/sail-alt"),
            matchReason: "repository_identity",
          },
        ],
        needsCloneDestination: false,
        needsModelSelection: true,
        availableModels: [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driverKind: ProviderDriverKind.make("codex"),
            displayName: TrimmedNonEmptyString.make("Codex"),
            model: TrimmedNonEmptyString.make("gpt-5.4"),
            modelName: TrimmedNonEmptyString.make("GPT-5.4"),
          },
        ],
        needsRunningConfirmation: true,
        unsupportedReason: null,
        sourceState: {
          wasRunning: true,
          hadPendingRuntimeRequest: true,
          pendingRuntimeRequests: [],
          heldQueuedRunCount: 0,
          activeSubagentCount: 1,
          branch: null,
          headSha: null,
          isDirty: true,
          isGitRepo: true,
        },
      };
      return Effect.succeed(result);
    },
  );
  using _start = answerRpc(WS_METHODS.sessionTransferStart, (input: SessionTransferStartInput) => {
    startCalls.push(input);
    return Effect.succeed(
      makeTransferRecord({
        transferId: SessionTransferId.make("transfer-dialog-1"),
        sourceThreadId: sourceThread.id,
        phase: "queued",
      }),
    );
  });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/beta`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  // Initial mount must not spawn sail-boatd.
  await expect.element(page.getByText("Thread beta").first()).toBeVisible();
  expect(boatsSubscribed).toBe(false);
  expect(boatsCommands).toHaveLength(0);

  await userEvent.click(page.getByText("Thread beta").first(), { button: "right" });
  const moveToBoat = page.getByRole("menuitem", { name: "Move to Boat" });
  await expect.element(moveToBoat).toBeVisible();
  expect(boatsSubscribed).toBe(false);
  expect(boatsCommands).toEqual([{ command: "get_state" }]);

  await userEvent.click(moveToBoat);
  const skiffItem = page.getByRole("menuitem", { name: "skiff, Idle" });
  const dinghyItem = page.getByRole("menuitem", { name: "dinghy, Creating" });
  await expect.element(skiffItem).toBeVisible();
  await expect.element(dinghyItem).toHaveAttribute("aria-disabled", "true");

  await userEvent.click(skiffItem);

  await expect.element(page.getByRole("heading", { name: "Move session to skiff" })).toBeVisible();
  await expect.element(page.getByText("Active work will be paused")).toBeVisible();
  await expect
    .element(page.getByText(/1 active subagent will be paused without auto-executing/i))
    .toBeVisible();
  await expect
    .element(page.getByText(/Pending approval or secret requests will be paused/i))
    .toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Move to Boat" }));

  await vi.waitFor(() => expect(startCalls).toHaveLength(1));
  expect(preflightCalls[0]).toMatchObject({
    direction: "local_to_boat",
    sourceEnvironmentId: ENVIRONMENT_ID,
    sourceThreadId: sourceThread.id,
    target: { kind: "boat", machineId: "skiff", machineName: "skiff" },
  });
  expect(startCalls[0]).toMatchObject({
    direction: "local_to_boat",
    sourceThreadId: sourceThread.id,
    targetProjectId: ProjectId.make("boat-proj-1"),
    modelSelectionOverride: {
      provider: "codex",
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    confirmedRunningPause: true,
    autoResume: false,
  });
});

it("shows live progress toasts, sidebar transferring badge, cancel, retry, and completion navigation", async () => {
  const sourceThread = threadWithHistory("gamma", 1);
  const destThread = threadWithHistory("dest-gamma", 1);
  using _environment = installFakeEnvironment([sourceThread, destThread], {
    serverConfigOverrides: { hasConfiguredBoats: true, sessionTransfer: true },
  });
  await using _stage = await mountDesktopStage();
  setupSettings();

  let eventQueue: Queue.Queue<SessionTransferProgressEvent> | null = null;
  const cancelCalls: SessionTransferCancelInput[] = [];
  const retryCalls: SessionTransferRetryInput[] = [];

  using _transfersSub = answerRpc(WS_METHODS.subscribeSessionTransfers, () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<SessionTransferProgressEvent>();
        eventQueue = queue;
        yield* Queue.offer(queue, { _tag: "snapshot", transfers: [] });
        return Stream.fromQueue(queue);
      }),
    ),
  );
  using _cancel = answerRpc(
    WS_METHODS.sessionTransferCancel,
    (input: SessionTransferCancelInput) => {
      cancelCalls.push(input);
      return Effect.succeed(
        makeTransferRecord({
          transferId: input.transferId,
          sourceThreadId: sourceThread.id,
          phase: "cancelled",
        }),
      );
    },
  );
  using _retry = answerRpc(WS_METHODS.sessionTransferRetry, (input: SessionTransferRetryInput) => {
    retryCalls.push(input);
    return Effect.succeed(
      makeTransferRecord({
        transferId: input.transferId,
        sourceThreadId: sourceThread.id,
        phase: "queued",
      }),
    );
  });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/gamma`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  await vi.waitFor(() => expect(eventQueue).not.toBeNull());
  const transferId = SessionTransferId.make("transfer-live-1");

  const emit = (transfer: SessionTransferRecord) => {
    Queue.offerUnsafe(eventQueue!, { _tag: "updated", transfer });
  };

  emit(
    makeTransferRecord({
      transferId,
      sourceThreadId: sourceThread.id,
      destinationThreadId: destThread.id,
      phase: "exporting_source",
    }),
  );

  await expect.element(page.getByText("Moving session to skiff")).toBeVisible();
  await expect.element(page.getByText("Exporting session history\u2026")).toBeVisible();
  await expect.element(page.getByTestId("sidebar-transferring-badge-gamma")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(cancelCalls).toEqual([{ transferId }]));

  emit(
    makeTransferRecord({
      transferId,
      sourceThreadId: sourceThread.id,
      destinationThreadId: destThread.id,
      phase: "failed",
      errorMessage: "Network dropped while uploading bundle.",
      updatedAt: IsoDateTime.make("2026-03-17T19:13:00.000Z"),
    }),
  );

  await expect.element(page.getByText("Failed to move session to skiff")).toBeVisible();
  await expect.element(page.getByText("Network dropped while uploading bundle.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Resume here" })).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(retryCalls).toEqual([{ transferId }]));

  emit(
    makeTransferRecord({
      transferId,
      sourceThreadId: sourceThread.id,
      destinationThreadId: destThread.id,
      phase: "completed",
      completedAt: IsoDateTime.make("2026-03-17T19:14:00.000Z"),
      updatedAt: IsoDateTime.make("2026-03-17T19:14:00.000Z"),
    }),
  );

  await expect.element(page.getByText("Moved session to skiff")).toBeVisible();
  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/dest-gamma`),
  );
});

it("renders provenance banners on moved source and imported destination threads with working navigation", async () => {
  const transferId = SessionTransferId.make("transfer-banner-1");
  const sourceThread = {
    ...threadWithHistory("src-thread", 1),
    archived: true,
    transferredTo: {
      transferId,
      environmentId: ENVIRONMENT_ID,
      environmentName: TrimmedNonEmptyString.make("skiff"),
      machineId: TrimmedNonEmptyString.make("skiff"),
      projectId: PROJECT_ID,
      threadId: ThreadId.make("dst-thread"),
      transferredAt: AT,
    },
  };
  const destThread = {
    ...threadWithHistory("dst-thread", 1),
    transferOrigin: {
      transferId,
      environmentId: ENVIRONMENT_ID,
      environmentName: TrimmedNonEmptyString.make("Local"),
      machineId: null,
      projectId: PROJECT_ID,
      threadId: ThreadId.make("src-thread"),
      transferredAt: AT,
    },
  };

  using _environment = installFakeEnvironment([sourceThread, destThread], {
    serverConfigOverrides: { hasConfiguredBoats: true, sessionTransfer: true },
  });
  await using _stage = await mountDesktopStage();
  setupSettings();
  using _transfersSub = answerRpc(WS_METHODS.subscribeSessionTransfers, () =>
    Stream.concat(Stream.make({ _tag: "snapshot" as const, transfers: [] }), Stream.never),
  );

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/src-thread`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  await expect.element(page.getByTestId("session-transfer-banner-destination")).toBeVisible();
  await expect.element(page.getByText("Moved to skiff")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Open session" }));
  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/dst-thread`),
  );

  await expect.element(page.getByTestId("session-transfer-banner-origin")).toBeVisible();
  await expect.element(page.getByText("Moved from Local")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "View original" }));
  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/src-thread`),
  );
});

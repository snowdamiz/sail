import { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  primaryEnvironmentId: "local" as EnvironmentId | null,
  localEnvironmentDisabled: false,
  remoteConnected: true,
  serverConfigLoaded: true,
  localSessions: true,
  isLocalTarget: false,
  environmentRevision: 0,
  environmentListeners: new Set<() => void>(),
  pinClientPreferencesServer: vi.fn(async (_environmentId: EnvironmentId) => undefined),
  setLocalEnvironmentEnabled: vi.fn(async (_enabled: boolean) => undefined),
}));

vi.mock(import("../../localEnvironment"), () => ({
  isLocalEnvironmentDisabled: () => state.localEnvironmentDisabled,
}));
vi.mock(import("../../state/clientPreferences"), async (original) => ({
  ...(await original()),
  pinClientPreferencesServer: (environmentId: EnvironmentId) =>
    state.pinClientPreferencesServer(environmentId),
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => state.primaryEnvironmentId,
  useEnvironment: ((environmentId: EnvironmentId) => {
    useSyncExternalStore(
      (listener) => {
        state.environmentListeners.add(listener);
        return () => {
          state.environmentListeners.delete(listener);
        };
      },
      () => state.environmentRevision,
      () => state.environmentRevision,
    );
    return {
      environmentId,
      connection: { phase: state.remoteConnected ? "connected" : "connecting" },
      entry: {
        target: state.isLocalTarget
          ? { _tag: "DesktopLocalConnectionTarget", environmentId }
          : { _tag: "BearerConnectionTarget", connectionId: "remote" },
      },
      serverConfig: state.serverConfigLoaded
        ? {
            environment: {
              capabilities: {
                localSessions: state.localSessions,
              },
            },
          }
        : null,
    };
  }) as never,
}));

import {
  MainServerOfferHost,
  resetMainServerOfferForTests,
  useOfferMainServer,
} from "./MainServerDialog";

const remoteId = EnvironmentId.make("remote-1");

function OfferTrigger({
  environmentId = remoteId,
  host = "my-sail.fly.dev",
  onResult,
}: {
  readonly environmentId?: EnvironmentId;
  readonly host?: string;
  readonly onResult?: (accepted: boolean) => void;
}) {
  const offerMainServer = useOfferMainServer();
  return (
    <button type="button" onClick={() => onResult?.(offerMainServer({ environmentId, host }))}>
      Offer server
    </button>
  );
}

function setup() {
  vi.clearAllMocks();
  resetMainServerOfferForTests();
  state.primaryEnvironmentId = EnvironmentId.make("local");
  state.localEnvironmentDisabled = false;
  state.remoteConnected = true;
  state.serverConfigLoaded = true;
  state.localSessions = true;
  state.environmentRevision = 0;
  state.environmentListeners.clear();
  state.isLocalTarget = false;
  state.pinClientPreferencesServer.mockResolvedValue(undefined);
  state.setLocalEnvironmentEnabled.mockResolvedValue(undefined);
}

describe("MainServerOfferHost", () => {
  it("shows control-plane Boats copy and awaits pinning before disabling Local environment", async () => {
    setup();
    state.localSessions = false;
    const callOrder: string[] = [];
    const pinReady = Promise.withResolvers<void>();
    state.pinClientPreferencesServer.mockImplementationOnce(async () => {
      callOrder.push("pin:start");
      await pinReady.promise;
      callOrder.push("pin:done");
    });
    state.setLocalEnvironmentEnabled.mockImplementationOnce(async () => {
      callOrder.push("disable");
    });

    using _bridge = stubGlobal("desktopBridge", {
      setLocalEnvironmentEnabled: state.setLocalEnvironmentEnabled,
    });
    const onResult = vi.fn();
    await using _screen = await render(
      <>
        <OfferTrigger onResult={onResult} />
        <MainServerOfferHost />
      </>,
    );

    await userEvent.click(page.getByRole("button", { name: "Offer server" }));
    expect(onResult).toHaveBeenCalledExactlyOnceWith(true);
    await expect
      .element(
        page.getByText(
          /manages Boats and synced settings; coding sessions will run only on Boat machines/,
        ),
      )
      .toBeVisible();

    const confirmButton = page.getByRole("button", {
      name: "Use my-sail.fly.dev as your main server",
    });
    await expect.element(confirmButton).toBeEnabled();
    await userEvent.click(confirmButton);

    expect(state.pinClientPreferencesServer).toHaveBeenCalledExactlyOnceWith(remoteId);
    expect(state.setLocalEnvironmentEnabled).not.toHaveBeenCalled();

    pinReady.resolve();
    await vi.waitFor(() => {
      expect(state.setLocalEnvironmentEnabled).toHaveBeenCalledExactlyOnceWith(false);
    });
    expect(callOrder).toEqual(["pin:start", "pin:done", "disable"]);
  });

  it("keeps restart disabled with waiting status until serverConfig loads on a connected server", async () => {
    setup();
    state.remoteConnected = true;
    state.serverConfigLoaded = false;
    state.localSessions = false;

    using _bridge = stubGlobal("desktopBridge", {
      setLocalEnvironmentEnabled: state.setLocalEnvironmentEnabled,
    });
    const onResult = vi.fn();
    await using _screen = await render(
      <>
        <OfferTrigger onResult={onResult} />
        <MainServerOfferHost />
      </>,
    );
    await userEvent.click(page.getByRole("button", { name: "Offer server" }));
    expect(onResult).toHaveBeenCalledExactlyOnceWith(true);

    const confirmButton = page.getByRole("button", {
      name: "Use my-sail.fly.dev as your main server",
    });
    await expect.element(confirmButton).toBeDisabled();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Wait for the server to connect before restarting.");

    state.serverConfigLoaded = true;
    state.environmentRevision += 1;
    for (const listener of state.environmentListeners) {
      listener();
    }
    await expect.element(confirmButton).toBeEnabled();
    expect(page.getByRole("status").query()).toBeNull();
    await expect
      .element(
        page.getByText(
          /manages Boats and synced settings; coding sessions will run only on Boat machines/,
        ),
      )
      .toBeVisible();
  });

  it("keeps the dialog open with an error when disabling Local environment fails so the user can retry", async () => {
    setup();
    state.setLocalEnvironmentEnabled
      .mockRejectedValueOnce(new Error("Restart blocked"))
      .mockResolvedValueOnce(undefined);

    using _bridge = stubGlobal("desktopBridge", {
      setLocalEnvironmentEnabled: state.setLocalEnvironmentEnabled,
    });
    const onResult = vi.fn();
    await using _screen = await render(
      <>
        <OfferTrigger onResult={onResult} />
        <MainServerOfferHost />
      </>,
    );

    await userEvent.click(page.getByRole("button", { name: "Offer server" }));
    expect(onResult).toHaveBeenCalledExactlyOnceWith(true);
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    const confirmButton = page.getByRole("button", {
      name: "Use my-sail.fly.dev as your main server",
    });
    await userEvent.click(confirmButton);

    await expect.element(page.getByRole("alert")).toHaveTextContent("Restart blocked");
    await expect.element(confirmButton).toBeEnabled();

    await userEvent.click(confirmButton);
    await vi.waitFor(() => {
      expect(state.setLocalEnvironmentEnabled).toHaveBeenCalledTimes(2);
    });
  });

  it("declines to offer when Local environment is already disabled, target is primary, or bridge is absent", async () => {
    setup();
    const results: boolean[] = [];

    // 1. Local environment already disabled
    state.localEnvironmentDisabled = true;
    {
      using _bridge = stubGlobal("desktopBridge", {
        setLocalEnvironmentEnabled: state.setLocalEnvironmentEnabled,
      });
      await using _screen = await render(
        <>
          <OfferTrigger onResult={(accepted) => results.push(accepted)} />
          <MainServerOfferHost />
        </>,
      );
      await userEvent.click(page.getByRole("button", { name: "Offer server" }));
      expect(page.getByRole("alertdialog").query()).toBeNull();
    }

    // 2. Target equals primaryEnvironmentId
    setup();
    {
      using _bridge = stubGlobal("desktopBridge", {
        setLocalEnvironmentEnabled: state.setLocalEnvironmentEnabled,
      });
      await using _screen = await render(
        <>
          <OfferTrigger
            environmentId={EnvironmentId.make("local")}
            onResult={(accepted) => results.push(accepted)}
          />
          <MainServerOfferHost />
        </>,
      );
      await userEvent.click(page.getByRole("button", { name: "Offer server" }));
      expect(page.getByRole("alertdialog").query()).toBeNull();
    }

    // 3. Bridge absent (non-Desktop web)
    setup();
    {
      using _bridge = stubGlobal("desktopBridge", undefined);
      await using _screen = await render(
        <>
          <OfferTrigger onResult={(accepted) => results.push(accepted)} />
          <MainServerOfferHost />
        </>,
      );
      await userEvent.click(page.getByRole("button", { name: "Offer server" }));
      expect(page.getByRole("alertdialog").query()).toBeNull();
    }

    expect(results).toEqual([false, false, false]);
  });
});

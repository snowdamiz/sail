import { createMemoryHistory } from "@tanstack/react-router";
import { WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { answerRpc, installFakeEnvironment, type FakeDriver } from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("shows the server's Boat notices as toasts on a page that is not Boats", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  using _notices = answerRpc(WS_METHODS.subscribeBoatNotices, () =>
    Stream.concat(Stream.make({ title: "Machine ready", body: "skiff is awake." }), Stream.never),
  );
  let boatsViewSubscribed = false;
  using _view = answerRpc(WS_METHODS.subscribeBoats, () => {
    boatsViewSubscribed = true;
    return Stream.never;
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    router: false,
  });

  await expect.element(page.getByText("Machine ready")).toBeVisible();
  await expect.element(page.getByText("skiff is awake.")).toBeVisible();
  expect(
    boatsViewSubscribed,
    "notices alone must not open the Boats view or start sail-boatd",
  ).toBe(false);
});

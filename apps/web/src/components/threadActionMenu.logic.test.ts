import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasCompletedRun: true,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it.each([
    ["while the thread is running", { isRunning: true }],
    ["before any run has completed", { hasCompletedRun: false }],
  ])("omits mark unread %s", (_, overrides) => {
    const items = buildThreadActionMenuItems({ ...baseState, ...overrides });
    expect(items.map((item) => item.id)).not.toContain("mark-unread");
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });

  it("omits move items when sessionTransfer is absent or has no targets", () => {
    const withoutTransfer = buildThreadActionMenuItems(baseState);
    expect(withoutTransfer.map((item) => item.id)).not.toContain("move-session");
    expect(withoutTransfer.map((item) => item.id)).not.toContain("move-to-local");

    const emptyTargets = buildThreadActionMenuItems({
      ...baseState,
      sessionTransfer: {
        sourceIsBoat: false,
        isTransferring: false,
        canMoveToLocal: false,
        boatTargets: [],
      },
    });
    expect(emptyTargets.map((item) => item.id)).not.toContain("move-session");
    expect(emptyTargets.map((item) => item.id)).not.toContain("move-to-local");
  });

  it("renders Move to Boat submenu with status details and disabled unavailable boats for local sessions", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      sessionTransfer: {
        sourceIsBoat: false,
        isTransferring: false,
        canMoveToLocal: false,
        boatTargets: [
          { machineId: "skiff", name: "skiff", state: "idle" },
          { machineId: "cutter", name: "cutter", state: "working" },
          { machineId: "sloop", name: "sloop", state: "asleep" },
          { machineId: "dinghy", name: "dinghy", state: "creating" },
          { machineId: "ketch", name: "ketch", state: "error" },
          { machineId: "yawl", name: "yawl", state: "missing" },
        ],
      },
    });

    expect(items.find((item) => item.id === "move-to-local")).toBeUndefined();
    const moveToBoat = items.find((item) => item.id === "move-session");
    expect(moveToBoat).toMatchObject({
      id: "move-session",
      label: "Move to Boat",
      icon: "ship",
      disabled: false,
    });
    expect(moveToBoat?.children).toEqual([
      { id: "move-to-boat:skiff", label: "skiff", icon: "ship", detail: "Idle", disabled: false },
      {
        id: "move-to-boat:cutter",
        label: "cutter",
        icon: "ship",
        detail: "Working",
        disabled: false,
      },
      { id: "move-to-boat:sloop", label: "sloop", icon: "ship", detail: "Asleep", disabled: false },
      {
        id: "move-to-boat:dinghy",
        label: "dinghy",
        icon: "ship",
        detail: "Creating",
        disabled: true,
      },
      { id: "move-to-boat:ketch", label: "ketch", icon: "ship", detail: "Error", disabled: true },
      { id: "move-to-boat:yawl", label: "yawl", icon: "ship", detail: "Missing", disabled: true },
    ]);
  });

  it("renders Move to Local and other Boats for a Boat session", () => {
    const singleBoatItems = buildThreadActionMenuItems({
      ...baseState,
      sessionTransfer: {
        sourceIsBoat: true,
        isTransferring: false,
        canMoveToLocal: true,
        boatTargets: [],
      },
    });
    expect(singleBoatItems.find((item) => item.id === "move-to-local")).toMatchObject({
      id: "move-to-local",
      label: "Move to Local",
      icon: "laptop",
      disabled: false,
    });
    expect(singleBoatItems.find((item) => item.id === "move-session")).toBeUndefined();

    const multiBoatItems = buildThreadActionMenuItems({
      ...baseState,
      sessionTransfer: {
        sourceIsBoat: true,
        isTransferring: false,
        canMoveToLocal: true,
        boatTargets: [{ machineId: "cutter", name: "cutter", state: "idle" }],
      },
    });
    expect(multiBoatItems.find((item) => item.id === "move-to-local")?.separatorBefore).toBe(true);
    expect(multiBoatItems.find((item) => item.id === "move-session")?.separatorBefore).toBe(false);
    expect(multiBoatItems.find((item) => item.id === "move-session")?.children).toEqual([
      { id: "move-to-boat:cutter", label: "cutter", icon: "ship", detail: "Idle", disabled: false },
    ]);
  });

  it("keeps move actions enabled while running with Pauses and resumes detail while Archive stays disabled", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      sessionTransfer: {
        sourceIsBoat: true,
        isTransferring: false,
        canMoveToLocal: true,
        boatTargets: [{ machineId: "skiff", name: "skiff", state: "idle" }],
      },
    });

    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "move-to-local")).toMatchObject({
      disabled: false,
      detail: "Pauses and resumes",
    });
    expect(items.find((item) => item.id === "move-session")).toMatchObject({
      disabled: false,
      detail: "Pauses and resumes",
    });
    expect(items.find((item) => item.id === "move-session")?.children?.[0]?.disabled).toBe(false);
  });

  it("disables move items while a transfer is active or when operate scope is missing", () => {
    expect(threadActionRequiresOperate("move-session")).toBe(true);
    expect(threadActionRequiresOperate("move-to-local")).toBe(true);
    expect(threadActionRequiresOperate("move-to-boat:skiff")).toBe(true);

    const activeTransferItems = buildThreadActionMenuItems({
      ...baseState,
      sessionTransfer: {
        sourceIsBoat: true,
        isTransferring: true,
        canMoveToLocal: true,
        boatTargets: [{ machineId: "skiff", name: "skiff", state: "idle" }],
      },
    });
    expect(activeTransferItems.find((item) => item.id === "move-to-local")).toMatchObject({
      disabled: true,
      detail: "Moving\u2026",
    });
    expect(activeTransferItems.find((item) => item.id === "move-session")).toMatchObject({
      disabled: true,
      detail: "Moving\u2026",
    });
    expect(
      activeTransferItems.find((item) => item.id === "move-session")?.children?.[0]?.disabled,
    ).toBe(true);

    const readOnlyItems = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      canTriage: true,
      sessionTransfer: {
        sourceIsBoat: true,
        isTransferring: false,
        canMoveToLocal: true,
        boatTargets: [{ machineId: "skiff", name: "skiff", state: "idle" }],
      },
    });
    expect(readOnlyItems.find((item) => item.id === "move-to-local")?.disabled).toBe(true);
    expect(readOnlyItems.find((item) => item.id === "move-session")?.disabled).toBe(true);
    expect(readOnlyItems.find((item) => item.id === "move-session")?.children?.[0]?.disabled).toBe(
      true,
    );
  });
});

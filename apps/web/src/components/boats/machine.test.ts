import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { BoatAccess } from "./access";
import { deriveMachineControls } from "./components/MachineActions";
import { classifyBoatLink, errorText } from "./reply";
import {
  ACTIONS,
  MACHINE_STATUS,
  cleanName,
  duration,
  isMachineOpenable,
  machineKey,
  menuActions,
  primaryAction,
  suggestName,
} from "./machine";
import type { MachineState, MachineView, Size } from "./types";

function makeMachine(overrides: Partial<MachineView> = {}): MachineView {
  return {
    id: "m-1",
    environmentId: null,
    name: "harbor",
    state: "idle",
    detail: "",
    countdown: null,
    size: "small",
    paired: false,
    waiting: false,
    signedOut: [],
    projects: [],
    keepAwakeUntil: null,
    keepAwakeForever: false,
    ...overrides,
  };
}

const SIZES: Size[] = [
  { id: "small", spec: "2 CPU · 4 GB", hourly: 0.04 },
  { id: "large", spec: "4 CPU · 8 GB", hourly: 0.08 },
];

describe("Sail Boats helpers", () => {
  it("formats errorText from strings, Errors, and unknown values", () => {
    expect(errorText("boom")).toBe("boom");
    expect(errorText(new Error("failed"))).toBe("failed");
    expect(errorText({ message: "rpc error" })).toBe("Something went wrong");
  });

  it("derives Sail-branded actions, statuses, and names", () => {
    const unpaired = makeMachine({ state: "idle", paired: false });
    expect(machineKey(unpaired)).toBe("m-1");
    expect(MACHINE_STATUS[unpaired.state].badgeVariant).toBe("success");
    expect(primaryAction(unpaired, false)?.label).toBe("Add to Sail");
    expect(ACTIONS.open.label).toBe("Open last thread in Sail");

    const paired = makeMachine({
      state: "asleep",
      paired: true,
      projects: [
        {
          id: "remote-1",
          originProjectId: "local-1",
          title: "Cloned",
          repoKey: null,
          status: null,
        },
        { id: "remote-2", title: "Existing", repoKey: null, status: null },
      ],
    });
    expect(primaryAction(paired, true)).toBeNull();
    const menu = menuActions(paired, SIZES, true);
    expect(menu.some((item) => "cmd" in item && item.cmd === "wake_machine")).toBe(true);
    expect(menu.some((item) => "cmd" in item && item.label === "Add to Sail again")).toBe(true);
    expect(menu.some((item) => "cmd" in item && item.label === "Resize to large")).toBe(true);

    const creating = makeMachine({ id: "", state: "creating" });
    expect(machineKey(creating)).toBe("new:harbor");
    expect(MACHINE_STATUS[creating.state].badgeVariant).toBe("warning");
    expect(isMachineOpenable(creating)).toBe(false);
    expect(isMachineOpenable(unpaired)).toBe(true);

    expect(cleanName("My Boat_01!")).toBe("my-boat-01");
    expect(suggestName(["skiff"])).toBe("dinghy");
    expect(duration(7500)).toBe("2h 5m");
  });

  it("covers every machine state in MACHINE_STATUS", () => {
    const states: readonly MachineState[] = [
      "working",
      "idle",
      "sleeping",
      "asleep",
      "waking",
      "creating",
      "error",
      "missing",
      "unknown",
    ];
    for (const state of states) {
      expect(MACHINE_STATUS[state].label).toBeTruthy();
      expect(MACHINE_STATUS[state].dotClassName).toBeTruthy();
      expect(MACHINE_STATUS[state].badgeVariant).toBeTruthy();
    }
  });

  it("derives narrowed machine controls from access, local project support, and pending state", () => {
    const envId = EnvironmentId.make("boat-env");
    const access: BoatAccess = {
      environmentId: EnvironmentId.make("host-env"),
      can: () => true,
      isPaired: (id) => id === envId,
      onHost: false,
    };
    const asleep = makeMachine({
      id: "m-2",
      environmentId: envId,
      state: "asleep",
      paired: true,
    });
    const remoteControls = deriveMachineControls({
      machine: asleep,
      sizes: SIZES,
      access,
      supportsLocalProjects: false,
      pending: null,
      deleteRefusal: null,
      signingIn: false,
    });
    expect(remoteControls.canOpen).toBe(true);
    expect(remoteControls.rowPrimary).toMatchObject({
      kind: "ordinary",
      action: ACTIONS.wake,
      disabled: false,
    });
    expect(remoteControls.detailsPrimary).toMatchObject({
      kind: "ordinary",
      action: ACTIONS.open,
      disabled: false,
    });
    expect(remoteControls.menuItems.some((item) => item.kind === "pickProject")).toBe(false);
    expect(
      remoteControls.menuItems.some(
        (item) => item.kind === "ordinary" && item.action === ACTIONS.wake,
      ),
    ).toBe(false);
    expect(remoteControls.needsProject).toBe(false);

    const busyControls = deriveMachineControls({
      machine: asleep,
      sizes: SIZES,
      access: { ...access, onHost: true },
      supportsLocalProjects: true,
      pending: { action: ACTIONS.wake, label: "Waking…" },
      deleteRefusal: null,
      signingIn: false,
    });
    expect(busyControls.canAddProject).toBe(false);

    const missingControls = deriveMachineControls({
      machine: makeMachine({ id: "m-3", state: "missing" }),
      sizes: SIZES,
      access: { ...access, onHost: true },
      supportsLocalProjects: true,
      pending: null,
      deleteRefusal: null,
      signingIn: false,
    });
    expect(missingControls.rowPrimary).toMatchObject({
      kind: "armDelete",
      deletion: { kind: "removeMissing", action: ACTIONS.remove },
      disabled: false,
    });
    expect(missingControls.deleteControl).toMatchObject({
      kind: "armDelete",
      deletion: { kind: "removeMissing", action: ACTIONS.remove },
      disabled: false,
    });
    expect(missingControls.menuItems).toEqual([]);
    expect(missingControls.power).toBeNull();
  });

  it("sends a reply's link to pairing, an app route, or the browser", () => {
    const pairingUrl = "http://localhost:47732/pair#token=abc";
    const pairLink = `sail-dev://pair?pairingUrl=${encodeURIComponent(pairingUrl)}`;
    expect(classifyBoatLink(pairLink, true)).toEqual({ kind: "pairing", pairingUrl });
    expect(classifyBoatLink(pairLink, false)).toEqual({ kind: "ignored" });
    expect(classifyBoatLink("sail://threads/env-1/thread-1", false)).toEqual({
      kind: "app",
      href: "/env-1/thread-1",
    });
    const signIn = "https://auth.localtest.me/boat/device?code=ABCD";
    expect(classifyBoatLink(signIn, false)).toEqual({ kind: "browser", url: signIn });
    expect(classifyBoatLink("http://localhost:47732/", true)).toEqual({ kind: "ignored" });
    expect(classifyBoatLink("sail://", true)).toEqual({ kind: "ignored" });
    expect(classifyBoatLink(undefined, true)).toEqual({ kind: "ignored" });
  });
});

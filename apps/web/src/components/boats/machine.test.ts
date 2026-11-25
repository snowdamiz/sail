import { describe, expect, it } from "vite-plus/test";
import { errorText } from "./api";
import {
  cleanName,
  duration,
  machineKey,
  menuActions,
  openIn,
  primaryAction,
  stateTag,
  suggestName,
} from "./machine";
import type { MachineView, Size } from "./types";

function makeMachine(overrides: Partial<MachineView> = {}): MachineView {
  return {
    id: "m-1",
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

  it("derives Sail-branded actions, state tags, and names", () => {
    const unpaired = makeMachine({ state: "idle", paired: false });
    expect(machineKey(unpaired)).toBe("m-1");
    expect(stateTag(unpaired.state)).toBe("idle");
    expect(primaryAction(unpaired)?.label).toBe("Add to Sail");
    expect(openIn(null).label).toBe("Open in Sail");
    expect(openIn("t-1").label).toBe("Open last thread in Sail");

    const paired = makeMachine({ state: "asleep", paired: true });
    expect(primaryAction(paired)).toBeNull();
    const menu = menuActions(paired, SIZES);
    expect(menu.some((item) => "cmd" in item && item.cmd === "wake_machine")).toBe(true);
    expect(menu.some((item) => "cmd" in item && item.label === "Add to Sail again")).toBe(true);
    expect(menu.some((item) => "cmd" in item && item.label === "Resize to large")).toBe(true);

    const creating = makeMachine({ id: "", state: "creating" });
    expect(machineKey(creating)).toBe("new:harbor");
    expect(stateTag(creating.state)).toBe("building");

    expect(cleanName("My Boat_01!")).toBe("my-boat-01");
    expect(suggestName(["skiff"])).toBe("dinghy");
    expect(duration(7500)).toBe("2h 5m");
  });
});

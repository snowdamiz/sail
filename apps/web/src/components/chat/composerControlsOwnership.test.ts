import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

const base = {
  matchesDefault: true,
  collapsed: false,
  measuredHiddenBlockCount: 0,
};

describe("resolveComposerControlsOwnership", () => {
  it("hides the chip at the default and lets the model picker answer composer.mode", () => {
    const result = resolveComposerControlsOwnership(base);
    expect(result).toMatchObject({
      accessDisplay: "hidden",
      showModeBlock: false,
      hiddenBlockIds: [],
      overflowShowsPermissions: false,
      overflowShowsPotetoMode: false,
      pickerOwnsModeShortcut: true,
    });
  });

  it("shows a labelled chip that owns composer.mode when the mode differs", () => {
    const result = resolveComposerControlsOwnership({ ...base, matchesDefault: false });
    expect(result).toMatchObject({
      accessDisplay: "label",
      showModeBlock: true,
      pickerOwnsModeShortcut: false,
    });
  });

  it("gives an overflowed chip's Permissions to the overflow menu", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(true);
    expect(result.overflowShowsPotetoMode).toBe(false);
    expect(result.pickerOwnsModeShortcut).toBe(false);
  });

  it("shows the non-default chip as an icon in the compacted row", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      collapsed: true,
    });
    expect(result.accessDisplay).toBe("icon");
  });

  it("overflows permissions before poteto mode, then overflows both on ultra-narrow rows", () => {
    const onlyModeOverflow = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      showPotetoBlock: true,
      measuredHiddenBlockCount: 1,
    });
    expect(onlyModeOverflow.hiddenBlockIds).toEqual(["mode"]);
    expect(onlyModeOverflow.overflowShowsPermissions).toBe(true);
    expect(onlyModeOverflow.overflowShowsPotetoMode).toBe(false);

    const bothOverflow = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      showPotetoBlock: true,
      measuredHiddenBlockCount: 2,
    });
    expect(bothOverflow.hiddenBlockIds).toEqual(["poteto", "mode"]);
    expect(bothOverflow.overflowShowsPermissions).toBe(true);
    expect(bothOverflow.overflowShowsPotetoMode).toBe(true);

    const potetoOnlyOverflow = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: true,
      showPotetoBlock: true,
      measuredHiddenBlockCount: 1,
    });
    expect(potetoOnlyOverflow.hiddenBlockIds).toEqual(["poteto"]);
    expect(potetoOnlyOverflow.overflowShowsPermissions).toBe(false);
    expect(potetoOnlyOverflow.overflowShowsPotetoMode).toBe(true);
    expect(potetoOnlyOverflow.pickerOwnsModeShortcut).toBe(true);
  });
});

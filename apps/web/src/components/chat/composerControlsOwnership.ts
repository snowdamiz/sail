export type ComposerRestingBlockId = "poteto" | "mode";

/**
 * Where composer resting blocks show (Poteto mode toggle and non-default permissions chip),
 * which trailing blocks overflow into the menu, and which control answers the composer.mode
 * shortcut. The model picker's footer always holds Permissions, so the chip only shows while
 * the mode differs from the default. The rule: composer.mode has one target.
 */
export function resolveComposerControlsOwnership(input: {
  /** Permissions hide while the mode is the default, or while the new-thread strip names it. */
  readonly matchesDefault: boolean;
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
  /** Whether the dedicated Poteto mode toggle block is rendered in the resting row. */
  readonly showPotetoBlock?: boolean;
}) {
  const accessDisplay = input.matchesDefault
    ? ("hidden" as const)
    : input.collapsed
      ? ("icon" as const)
      : ("label" as const);
  const showModeBlock = accessDisplay !== "hidden";
  const showPotetoBlock = input.showPotetoBlock ?? false;
  const blockIds: ComposerRestingBlockId[] = [];
  if (showPotetoBlock) blockIds.push("poteto");
  if (showModeBlock) blockIds.push("mode");
  const clampedHiddenCount = Math.min(Math.max(0, input.measuredHiddenBlockCount), blockIds.length);
  const hiddenBlockIds = blockIds.slice(blockIds.length - clampedHiddenCount);
  const modeHidden = hiddenBlockIds.includes("mode");
  const potetoHidden = hiddenBlockIds.includes("poteto");
  const overflowShowsPermissions = modeHidden;
  const overflowShowsPotetoMode = potetoHidden;
  return {
    accessDisplay,
    showModeBlock,
    showPotetoBlock,
    hiddenBlockCount: hiddenBlockIds.length,
    hiddenBlockIds,
    overflowShowsPermissions,
    overflowShowsPotetoMode,
    /** Without a visible chip or an overflow menu holding it, the model picker answers composer.mode. */
    pickerOwnsModeShortcut: !overflowShowsPermissions && (accessDisplay === "hidden" || modeHidden),
  };
}

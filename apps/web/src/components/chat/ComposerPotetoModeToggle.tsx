import { useGT } from "gt-react";
import { CrownIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { MenuCheckboxItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import type { ComposerPotetoModeState } from "./potetoModeArms";

export const ComposerPotetoModeToggle = memo(function ComposerPotetoModeToggle(props: {
  state: ComposerPotetoModeState;
  size?: ComposerControlSize;
  disabled?: boolean | undefined;
  onToggle: () => void;
}) {
  const gt = useGT();
  const size = props.size ?? "sm";
  const isActive = props.state === "active";
  const isArmed = props.state === "armed";
  const isOn = isActive || isArmed;
  const label = gt("Poteto");
  const ariaLabel = isActive
    ? gt("Poteto mode active for this session")
    : isArmed
      ? gt("Poteto mode armed for next message")
      : gt("Enable Poteto mode for this session");
  const tooltip = isActive
    ? gt("Poteto mode is active for this session. Start a new session to turn it off.")
    : isArmed
      ? gt("Poteto mode will trigger on your next message. Click to turn off.")
      : gt("Poteto mode: trigger pstack poteto-mode once for this session.");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            type="button"
            size={size}
            disabled={props.disabled}
            aria-pressed={isOn}
            aria-disabled={isActive || undefined}
            aria-label={ariaLabel}
            data-poteto-mode-toggle="true"
            data-poteto-mode-state={props.state}
            className={cn(
              isArmed &&
                "border-warning/35 bg-warning/12 text-foreground hover:bg-warning/18 aria-pressed:bg-warning/12 aria-pressed:text-foreground aria-pressed:hover:bg-warning/18",
              isActive &&
                "cursor-default border-warning/40 bg-warning/14 text-foreground hover:bg-warning/14 aria-pressed:bg-warning/14 aria-pressed:text-foreground aria-pressed:hover:bg-warning/14 active:scale-100",
            )}
            onClick={() => {
              if (!isActive) props.onToggle();
            }}
          />
        }
      >
        <ComposerControlIcon
          icon={CrownIcon}
          size={size}
          className={cn(isArmed && "text-warning", isActive && "fill-warning/25 text-warning")}
        />
        <span data-composer-control-label>{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
});

export function ComposerPotetoModeMenuItem(props: {
  state: ComposerPotetoModeState;
  disabled?: boolean | undefined;
  onToggle: () => void;
}) {
  const gt = useGT();
  const isActive = props.state === "active";
  const isArmed = props.state === "armed";
  const isOn = isActive || isArmed;

  return (
    <MenuCheckboxItem
      variant="switch"
      checked={isOn}
      disabled={props.disabled || isActive}
      closeOnClick={false}
      onCheckedChange={() => {
        if (!isActive) props.onToggle();
      }}
      data-poteto-mode-menu-item="true"
      data-poteto-mode-state={props.state}
    >
      <span className="flex min-w-0 items-center gap-2">
        <CrownIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            isArmed
              ? "text-warning"
              : isActive
                ? "fill-warning/25 text-warning"
                : "text-muted-foreground",
          )}
        />
        <span className="min-w-0">
          <span className="block truncate">{gt("Poteto mode")}</span>
          <span className="block truncate text-muted-foreground text-xs">
            {isActive
              ? gt("Active for this session")
              : isArmed
                ? gt("Triggers on next message")
                : gt("Once per session")}
          </span>
        </span>
      </span>
    </MenuCheckboxItem>
  );
}

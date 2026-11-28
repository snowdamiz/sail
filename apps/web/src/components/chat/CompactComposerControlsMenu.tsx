import type { RuntimeMode } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { memo, useRef } from "react";
import { EllipsisIcon } from "lucide-react";
import { Menu, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { ComposerPotetoModeMenuItem } from "./ComposerPotetoModeToggle";
import type { ComposerPotetoModeState } from "./potetoModeArms";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showPermissions: boolean;
  showPotetoMode: boolean;
  potetoModeState: ComposerPotetoModeState;
  potetoModeDisabled?: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTogglePotetoMode: () => void;
}) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size={size}
            className="shrink-0"
            aria-label={gt("More composer controls")}
            data-composer-shortcut={props.showPermissions ? "composer.mode" : undefined}
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.showPotetoMode ? (
          <ComposerPotetoModeMenuItem
            state={props.potetoModeState}
            disabled={props.potetoModeDisabled}
            onToggle={props.onTogglePotetoMode}
          />
        ) : null}
        {props.showPotetoMode && props.showPermissions ? <MenuSeparator /> : null}
        {props.showPermissions ? (
          <ComposerPermissionsSection
            runtimeMode={props.runtimeMode}
            runtimeModeOptions={props.runtimeModeOptions}
            onRuntimeModeChange={props.onRuntimeModeChange}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

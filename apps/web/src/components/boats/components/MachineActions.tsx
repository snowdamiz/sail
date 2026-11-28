import { useGT } from "gt-react";
import { AlertTriangleIcon, ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../../ui/alert";
import { Button, type ButtonSize } from "../../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { Spinner } from "../../ui/spinner";
import type { BoatAccess } from "../access";
import {
  ACTIONS,
  STAY_AWAKE,
  autoSleep,
  isMachineOpenable,
  keepAwake,
  menuActions,
  needsProject,
  powerAction,
  primaryAction,
  resizeTo,
  signInTo,
  useMachineActionLabel,
  type Action,
} from "../machine";
import type { LocalProject, MachineView, Size } from "../types";

export type NonDeleteAction = Exclude<Action, { cmd: "delete_machine" }>;
export type DeleteAction = Extract<Action, { cmd: "delete_machine" }>;

export type DeleteIntent =
  | { readonly kind: "delete"; readonly action: DeleteAction & { readonly discard: false } }
  | { readonly kind: "removeMissing"; readonly action: DeleteAction & { readonly discard: true } };

export type ActionRequest =
  | { readonly kind: "run"; readonly action: NonDeleteAction }
  | { readonly kind: "confirmed"; readonly deletion: DeleteIntent }
  | { readonly kind: "discardRefused" };

export type ActionControl =
  | { readonly kind: "ordinary"; readonly action: NonDeleteAction; readonly disabled: boolean }
  | { readonly kind: "armDelete"; readonly deletion: DeleteIntent; readonly disabled: boolean };

export type MenuControl =
  | ActionControl
  | { readonly kind: "pickProject"; readonly label: string; readonly disabled: boolean };

export interface DeleteRefusal {
  readonly message: string;
}

export interface PowerControls {
  readonly autoSleep: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly actionFor: (on: boolean) => NonDeleteAction;
  };
  readonly power: ActionControl | null;
  readonly temporaryAwake: readonly ActionControl[];
  readonly stopStayingAwake: ActionControl;
}

export interface ResizeChoice {
  readonly size: Size;
  readonly current: boolean;
  readonly control: ActionControl;
}

export interface MachinePresentation {
  readonly canOpen: boolean;
  readonly paired: boolean;
  readonly busy: boolean;
  readonly pendingLabel: string | null;
  readonly deleteRefusal: DeleteRefusal | null;
  readonly rowPrimary: ActionControl | null;
  readonly detailsPrimary: ActionControl;
  readonly menuItems: readonly MenuControl[];
  readonly canAddProject: boolean;
  readonly needsProject: boolean;
  readonly power: PowerControls | null;
  readonly signInAgentControl: (agent: string) => ActionControl;
  readonly connectControl: ActionControl;
  readonly resizeChoices: readonly ResizeChoice[];
  readonly deleteControl: ActionControl;
}

export interface MachineControls extends MachinePresentation {
  readonly request: (request: ActionRequest) => void;
  readonly onDismissDeleteError: () => void;
  readonly onAddProject: (project: LocalProject) => void;
}

function toDeleteIntent(action: DeleteAction): DeleteIntent {
  return action.discard
    ? { kind: "removeMissing", action: action as DeleteAction & { readonly discard: true } }
    : { kind: "delete", action: action as DeleteAction & { readonly discard: false } };
}

export function deriveMachineControls(input: {
  readonly machine: MachineView;
  readonly sizes: readonly Size[];
  readonly access: BoatAccess;
  readonly supportsLocalProjects: boolean;
  readonly pendingLabel: string | null;
  readonly deleteRefusal: DeleteRefusal | null;
  readonly signingIn: boolean;
}): MachinePresentation {
  const { machine, sizes, access, supportsLocalProjects, pendingLabel, deleteRefusal, signingIn } =
    input;
  const canOpen = isMachineOpenable(machine);
  const paired = access.isPaired(machine.environmentId);
  const busy = pendingLabel !== null;
  const gone = machine.state === "missing";

  const toControl = (action: Action, extraDisabled = false): ActionControl => {
    const disabled = busy || extraDisabled || !access.can(action.cmd);
    if (action.cmd === "delete_machine") {
      return { kind: "armDelete", deletion: toDeleteIntent(action), disabled };
    }
    return { kind: "ordinary", action, disabled };
  };

  const rawRowPrimary =
    !access.onHost && paired && machine.state === "asleep"
      ? ACTIONS.wake
      : primaryAction(machine, paired);
  const rawDetailsPrimary =
    primaryAction(machine, paired) ?? (paired ? ACTIONS.open : ACTIONS.pair);

  const canAddProject = supportsLocalProjects && !gone && !!machine.id && access.can("add_project");

  const menuItems: MenuControl[] = [];
  for (const item of menuActions(machine, sizes, paired)) {
    if (item === rawRowPrimary) continue;
    if ("kind" in item) {
      if (!supportsLocalProjects) continue;
      menuItems.push({
        kind: "pickProject",
        label: item.label,
        disabled: busy || !access.can("add_project"),
      });
    } else {
      menuItems.push(toControl(item));
    }
  }

  const rawPower = powerAction(machine);
  const power: PowerControls | null = gone
    ? null
    : {
        autoSleep: {
          checked: !machine.keepAwakeForever,
          disabled: busy || !access.can("keep_awake"),
          actionFor: (on) => autoSleep(on) as NonDeleteAction,
        },
        power: rawPower ? toControl(rawPower) : null,
        temporaryAwake: STAY_AWAKE.map((minutes) => toControl(keepAwake(minutes))),
        stopStayingAwake: toControl(keepAwake(0)),
      };

  const signInAgentControl = (agent: string): ActionControl =>
    toControl(signInTo(agent), signingIn || gone || !machine.id);

  const connectControl = toControl(ACTIONS.connect, signingIn || gone || !machine.id);

  const resizeChoices: ResizeChoice[] = sizes.map((size) => {
    const current = size.id === machine.size;
    return {
      size,
      current,
      control: toControl(resizeTo(size.id), current || gone || !machine.id),
    };
  });

  const deleteControl = toControl(ACTIONS.del, !machine.id);

  return {
    canOpen,
    paired,
    busy,
    pendingLabel,
    deleteRefusal,
    rowPrimary: rawRowPrimary ? toControl(rawRowPrimary) : null,
    detailsPrimary: toControl(rawDetailsPrimary),
    menuItems,
    canAddProject,
    needsProject: supportsLocalProjects && canOpen && needsProject(machine, paired),
    power,
    signInAgentControl,
    connectControl,
    resizeChoices,
    deleteControl,
  };
}

const ARM_TIMEOUT_MS = 3000;

type ArmState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "armed";
      readonly targetKey: string;
      readonly actionKind: DeleteIntent["kind"];
      readonly expiresAt: number;
    };

export interface DeleteConfirmation {
  readonly isArmed: (deletion: DeleteIntent) => boolean;
  readonly activate: (deletion: DeleteIntent, request: (event: ActionRequest) => void) => boolean;
  readonly disarm: () => void;
}

function useDeleteConfirmation(targetKey: string, disabled = false): DeleteConfirmation {
  const [state, setState] = useState<ArmState>({ kind: "idle" });

  const disarm = useCallback(() => {
    setState((current) => (current.kind === "idle" ? current : { kind: "idle" }));
  }, []);

  useEffect(() => {
    if (disabled) disarm();
  }, [disabled, disarm]);

  useEffect(() => {
    if (state.kind === "armed" && state.targetKey !== targetKey) {
      setState({ kind: "idle" });
    }
  }, [state, targetKey]);

  useEffect(() => {
    if (state.kind !== "armed") return;
    const remaining = Math.max(0, state.expiresAt - Date.now());
    const timer = window.setTimeout(() => setState({ kind: "idle" }), remaining);
    return () => window.clearTimeout(timer);
  }, [state]);

  const isArmed = useCallback(
    (deletion: DeleteIntent) =>
      !disabled &&
      state.kind === "armed" &&
      state.targetKey === targetKey &&
      state.actionKind === deletion.kind &&
      state.expiresAt > Date.now(),
    [disabled, state, targetKey],
  );

  const activate = useCallback(
    (deletion: DeleteIntent, request: (event: ActionRequest) => void) => {
      if (disabled) {
        disarm();
        return false;
      }
      if (isArmed(deletion)) {
        disarm();
        request({ kind: "confirmed", deletion });
        return true;
      }
      setState({
        kind: "armed",
        targetKey,
        actionKind: deletion.kind,
        expiresAt: Date.now() + ARM_TIMEOUT_MS,
      });
      return false;
    },
    [disabled, disarm, isArmed, targetKey],
  );

  return { isArmed, activate, disarm };
}

export function MachineActionButton({
  targetKey,
  control,
  onRequest,
  size = "xs",
  surface = "primary",
  pendingLabel = null,
  className,
}: {
  readonly targetKey: string;
  readonly control: ActionControl;
  readonly onRequest: MachineControls["request"];
  readonly size?: ButtonSize;
  readonly surface?: "primary" | "danger";
  readonly pendingLabel?: string | null;
  readonly className?: string;
}) {
  const gt = useGT();
  const actionLabel = useMachineActionLabel();
  const confirmation = useDeleteConfirmation(targetKey, control.disabled);

  if (pendingLabel !== null) {
    return (
      <Button size={size} variant="outline" disabled aria-busy={true} className={className}>
        <Spinner aria-hidden="true" />
        {pendingLabel}
      </Button>
    );
  }

  if (control.kind === "armDelete") {
    const armed = confirmation.isArmed(control.deletion);
    const label =
      surface === "danger"
        ? armed
          ? gt("Click again to delete forever")
          : gt("Delete machine…")
        : armed
          ? gt("Confirm")
          : actionLabel(control.deletion.action);
    const variant = armed
      ? "destructive"
      : surface === "danger"
        ? "destructive-outline"
        : "outline";
    return (
      <Button
        size={size}
        variant={variant}
        disabled={control.disabled}
        className={className}
        onClick={() => confirmation.activate(control.deletion, onRequest)}
      >
        {label}
      </Button>
    );
  }

  const variant = control.action.solid ? "default" : "outline";
  return (
    <Button
      size={size}
      variant={variant}
      disabled={control.disabled}
      className={className}
      onClick={() => onRequest({ kind: "run", action: control.action })}
    >
      {actionLabel(control.action)}
      {control.action.cmd === "open_machine" ? (
        <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
      ) : null}
    </Button>
  );
}

export function MachineMenu({
  targetKey,
  machineName,
  controls,
  onPickProject,
}: {
  readonly targetKey: string;
  readonly machineName: string;
  readonly controls: MachineControls;
  readonly onPickProject: () => void;
}) {
  const gt = useGT();
  const actionLabel = useMachineActionLabel();
  const deleteControl = controls.deleteControl;
  const confirmation = useDeleteConfirmation(targetKey, deleteControl.disabled);

  const deleteArmed =
    deleteControl.kind === "armDelete" ? confirmation.isArmed(deleteControl.deletion) : false;

  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) confirmation.disarm();
      }}
    >
      <MenuTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={gt("More for {name}", { name: machineName })}
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>{machineName}</MenuGroupLabel>
          {controls.menuItems.map((item) => {
            if (item.kind === "pickProject") {
              return (
                <MenuItem key={item.label} disabled={item.disabled} onClick={onPickProject}>
                  {gt("Add a project…")}
                </MenuItem>
              );
            }
            if (item.kind === "ordinary") {
              return (
                <MenuItem
                  key={item.action.label}
                  disabled={item.disabled}
                  onClick={() => controls.request({ kind: "run", action: item.action })}
                >
                  {actionLabel(item.action)}
                </MenuItem>
              );
            }
            return null;
          })}
        </MenuGroup>
        {controls.menuItems.length > 0 ? <MenuSeparator /> : null}
        {deleteControl.kind === "armDelete" ? (
          <MenuItem
            variant="destructive"
            disabled={deleteControl.disabled}
            closeOnClick={deleteArmed}
            onClick={() => confirmation.activate(deleteControl.deletion, controls.request)}
          >
            {deleteArmed ? gt("Click again to delete forever") : gt("Delete machine…")}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function DeleteErrorAlert({
  controls,
  className,
}: {
  readonly controls: MachineControls;
  readonly className?: string;
}) {
  const gt = useGT();
  if (controls.deleteRefusal === null) return null;
  return (
    <Alert variant="error" className={className}>
      <AlertTriangleIcon aria-hidden="true" />
      <AlertDescription>{controls.deleteRefusal.message}</AlertDescription>
      <AlertAction>
        <Button
          size="xs"
          variant="destructive"
          disabled={controls.busy}
          onClick={() => controls.request({ kind: "discardRefused" })}
        >
          {gt("Delete anyway")}
        </Button>
        <Button size="xs" variant="ghost" onClick={controls.onDismissDeleteError}>
          {gt("Keep")}
        </Button>
      </AlertAction>
    </Alert>
  );
}

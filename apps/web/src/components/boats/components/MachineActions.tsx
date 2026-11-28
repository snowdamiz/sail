import { useGT } from "gt-react";
import { AlertTriangleIcon, ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
  type DeleteMachineAction,
  type KeepAwakeAction,
  type NonDeleteAction,
  type PendingAction,
  type ResizeMachineAction,
} from "../machine";
import type { LocalProject, MachineView, Size } from "../types";

type DeleteIntent =
  | {
      readonly kind: "delete";
      readonly action: Extract<DeleteMachineAction, { readonly discard: false }>;
    }
  | {
      readonly kind: "removeMissing";
      readonly action: Extract<DeleteMachineAction, { readonly discard: true }>;
    };

export type ActionRequest =
  | { readonly kind: "run"; readonly action: NonDeleteAction }
  | { readonly kind: "confirmed"; readonly deletion: DeleteIntent }
  | { readonly kind: "discardRefused" };

type OrdinaryControl<A extends NonDeleteAction = NonDeleteAction> = {
  readonly kind: "ordinary";
  readonly action: A;
  readonly disabled: boolean;
};

type DeleteControl = {
  readonly kind: "armDelete";
  readonly deletion: DeleteIntent;
  readonly disabled: boolean;
};

type ActionControl = OrdinaryControl | DeleteControl;

type MenuControl =
  | OrdinaryControl
  | { readonly kind: "pickProject"; readonly label: string; readonly disabled: boolean };

export interface DeleteRefusal {
  readonly message: string;
}

export interface PendingMachineOperation {
  readonly action: PendingAction;
  readonly label: string;
}

export interface PowerControls {
  readonly autoSleep: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly actionFor: (on: boolean) => KeepAwakeAction;
  };
  readonly power: OrdinaryControl | null;
  readonly temporaryAwake: readonly OrdinaryControl<KeepAwakeAction>[];
  readonly stopStayingAwake: OrdinaryControl<KeepAwakeAction>;
}

interface ResizeChoice {
  readonly size: Size;
  readonly current: boolean;
  readonly control: OrdinaryControl<ResizeMachineAction>;
}

interface MachinePresentation {
  readonly canOpen: boolean;
  readonly paired: boolean;
  readonly busy: boolean;
  readonly pending: PendingMachineOperation | null;
  readonly deleteRefusal: DeleteRefusal | null;
  readonly rowPrimary: ActionControl | null;
  readonly detailsPrimary: ActionControl;
  readonly menuItems: readonly MenuControl[];
  readonly canAddProject: boolean;
  readonly needsProject: boolean;
  readonly power: PowerControls | null;
  readonly signInAgentControl: (agent: string) => OrdinaryControl;
  readonly connectControl: OrdinaryControl;
  readonly resizeChoices: readonly ResizeChoice[];
  readonly deleteControl: DeleteControl;
}

export interface MachineControls extends MachinePresentation {
  readonly request: (request: ActionRequest) => void;
  readonly onDismissDeleteError: () => void;
  readonly onAddProject: (project: LocalProject) => void;
}

function toDeleteIntent(action: DeleteMachineAction): DeleteIntent {
  return action.discard ? { kind: "removeMissing", action } : { kind: "delete", action };
}

export function deriveMachineControls(input: {
  readonly machine: MachineView;
  readonly sizes: readonly Size[];
  readonly access: BoatAccess;
  readonly supportsLocalProjects: boolean;
  readonly pending: PendingMachineOperation | null;
  readonly deleteRefusal: DeleteRefusal | null;
  readonly signingIn: boolean;
}): MachinePresentation {
  const { machine, sizes, access, supportsLocalProjects, pending, deleteRefusal, signingIn } =
    input;
  const canOpen = isMachineOpenable(machine);
  const paired = access.isPaired(machine.environmentId);
  const busy = pending !== null;
  const gone = machine.state === "missing";

  const toOrdinaryControl = <A extends NonDeleteAction>(
    action: A,
    extraDisabled = false,
  ): OrdinaryControl<A> => ({
    kind: "ordinary",
    action,
    disabled: busy || extraDisabled || !access.can(action.cmd),
  });

  const toDeleteControl = (action: DeleteMachineAction, extraDisabled = false): DeleteControl => ({
    kind: "armDelete",
    deletion: toDeleteIntent(action),
    disabled: busy || extraDisabled || !access.can(action.cmd),
  });

  const toActionControl = (action: Action, extraDisabled = false): ActionControl =>
    action.cmd === "delete_machine"
      ? toDeleteControl(action, extraDisabled)
      : toOrdinaryControl(action, extraDisabled);

  const rawRowPrimary =
    !access.onHost && paired && machine.state === "asleep"
      ? ACTIONS.wake
      : primaryAction(machine, paired);
  const rawDetailsPrimary =
    primaryAction(machine, paired) ?? (paired ? ACTIONS.open : ACTIONS.pair);

  const canAddProject =
    supportsLocalProjects && !gone && !!machine.id && !busy && access.can("add_project");

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
      menuItems.push(toOrdinaryControl(item));
    }
  }

  const rawPower = powerAction(machine);
  const power: PowerControls | null = gone
    ? null
    : {
        autoSleep: {
          checked: !machine.keepAwakeForever,
          disabled: busy || !access.can("keep_awake"),
          actionFor: autoSleep,
        },
        power: rawPower ? toOrdinaryControl(rawPower) : null,
        temporaryAwake: STAY_AWAKE.map((minutes) => toOrdinaryControl(keepAwake(minutes))),
        stopStayingAwake: toOrdinaryControl(keepAwake(0)),
      };

  const signInAgentControl = (agent: string): OrdinaryControl =>
    toOrdinaryControl(signInTo(agent), signingIn || gone || !machine.id);

  const connectControl = toOrdinaryControl(ACTIONS.connect, signingIn || gone || !machine.id);

  const resizeChoices: ResizeChoice[] = sizes.map((size) => {
    const current = size.id === machine.size;
    return {
      size,
      current,
      control: toOrdinaryControl(resizeTo(size.id), current || gone || !machine.id),
    };
  });

  const deleteControl = toDeleteControl(gone ? ACTIONS.remove : ACTIONS.del, !machine.id);

  return {
    canOpen,
    paired,
    busy,
    pending,
    deleteRefusal,
    rowPrimary: rawRowPrimary ? toActionControl(rawRowPrimary) : null,
    detailsPrimary: toActionControl(rawDetailsPrimary),
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

interface DeleteConfirmation {
  readonly isArmed: (deletion: DeleteIntent) => boolean;
  readonly activate: (deletion: DeleteIntent, request: (event: ActionRequest) => void) => boolean;
  readonly disarm: () => void;
}

function useDeleteConfirmation(targetKey: string, disabled = false): DeleteConfirmation {
  const [state, setState] = useState<ArmState>({ kind: "idle" });

  const disarm = () => {
    setState((current) => (current.kind === "idle" ? current : { kind: "idle" }));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules timeout to disarm delete confirmation
  useEffect(() => {
    if (disabled || state.kind !== "armed" || state.targetKey !== targetKey) return;
    const remaining = Math.max(0, state.expiresAt - Date.now());
    const timer = window.setTimeout(() => setState({ kind: "idle" }), remaining);
    return () => window.clearTimeout(timer);
  }, [disabled, state, targetKey]);

  const isArmed = (deletion: DeleteIntent) =>
    !disabled &&
    state.kind === "armed" &&
    state.targetKey === targetKey &&
    state.actionKind === deletion.kind;

  const activate = (deletion: DeleteIntent, request: (event: ActionRequest) => void) => {
    if (disabled) {
      disarm();
      return false;
    }
    if (
      state.kind === "armed" &&
      state.targetKey === targetKey &&
      state.actionKind === deletion.kind &&
      state.expiresAt > Date.now()
    ) {
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
  };

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
  readonly control: ActionControl | null;
  readonly onRequest: MachineControls["request"];
  readonly size?: ButtonSize;
  readonly surface?: "primary" | "danger";
  readonly pendingLabel?: string | null;
  readonly className?: string;
}) {
  const gt = useGT();
  const actionLabel = useMachineActionLabel();
  const confirmation = useDeleteConfirmation(targetKey, control?.disabled ?? true);

  if (pendingLabel !== null) {
    return (
      <Button size={size} variant="outline" disabled aria-busy={true} className={className}>
        <Spinner aria-hidden="true" />
        {pendingLabel}
      </Button>
    );
  }

  if (control === null) return null;

  if (control.kind === "armDelete") {
    const armed = confirmation.isArmed(control.deletion);
    const removing = control.deletion.kind === "removeMissing";
    const label =
      surface === "danger"
        ? removing
          ? armed
            ? gt("Click again to remove")
            : gt("Remove machine…")
          : armed
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
  const deleteArmed = confirmation.isArmed(deleteControl.deletion);
  const removing = deleteControl.deletion.kind === "removeMissing";

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
        {controls.menuItems.length > 0 ? (
          <>
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
                return (
                  <MenuItem
                    key={item.action.label}
                    disabled={item.disabled}
                    onClick={() => controls.request({ kind: "run", action: item.action })}
                  >
                    {actionLabel(item.action)}
                  </MenuItem>
                );
              })}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem
          variant="destructive"
          disabled={deleteControl.disabled}
          closeOnClick={deleteArmed}
          onClick={() => confirmation.activate(deleteControl.deletion, controls.request)}
        >
          {removing
            ? deleteArmed
              ? gt("Click again to remove")
              : gt("Remove machine…")
            : deleteArmed
              ? gt("Click again to delete forever")
              : gt("Delete machine…")}
        </MenuItem>
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
          disabled={controls.deleteControl.disabled}
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

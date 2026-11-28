import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  TrimmedNonEmptyString,
  type ScopedThreadRef,
  type SessionTransferDirection,
  type SessionTransferPreflightResult,
  type SessionTransferTarget,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import type { MachineState, MachineView, UiState } from "../components/boats/types";
import { openSessionTransferDialog } from "../components/SessionTransferDialog";
import type {
  ThreadActionMenuBoatMachineState,
  ThreadActionMenuBoatTarget,
  ThreadActionMenuId,
  ThreadActionMenuSessionTransferState,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { boatsEnvironment } from "../state/boats";
import { environmentPresentations } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import {
  readActiveSessionTransfer,
  readSessionTransferCoordinatorId,
  sessionTransferEnvironment,
} from "../state/sessionTransfers";

export interface ResolvedSessionTransferMenuContext {
  readonly coordinatorId: EnvironmentId;
  readonly menuState: ThreadActionMenuSessionTransferState;
}

const VALID_MACHINE_STATES: ReadonlySet<string> = new Set<MachineState>([
  "idle",
  "working",
  "asleep",
  "sleeping",
  "waking",
  "creating",
  "error",
  "missing",
  "unknown",
]);

function normalizeMachineState(state: string | undefined): ThreadActionMenuBoatMachineState {
  if (state !== undefined && VALID_MACHINE_STATES.has(state)) {
    return state as ThreadActionMenuBoatMachineState;
  }
  return "unknown";
}

function isBoatEnvironmentConfig(
  environmentId: EnvironmentId,
  coordinatorId: EnvironmentId,
  portableProviderAuthSync: boolean | undefined,
): boolean {
  return environmentId !== coordinatorId && portableProviderAuthSync === false;
}

function extractMachinesFromUiState(data: unknown): ReadonlyArray<MachineView> {
  if (typeof data !== "object" || data === null || !("machines" in data)) {
    return [];
  }
  const machines = (data as Partial<UiState>).machines;
  return Array.isArray(machines) ? machines : [];
}

function buildMenuContextFromMachines(input: {
  readonly coordinatorId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly sourcePortableProviderAuthSync: boolean | undefined;
  readonly connectedBoatEnvs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly machines: ReadonlyArray<MachineView>;
}): ResolvedSessionTransferMenuContext | null {
  const sourceMatchesBoatMachine = input.machines.some(
    (machine) => machine.environmentId === input.threadRef.environmentId,
  );
  const sourceIsBoat =
    sourceMatchesBoatMachine ||
    isBoatEnvironmentConfig(
      input.threadRef.environmentId,
      input.coordinatorId,
      input.sourcePortableProviderAuthSync,
    );

  const boatTargetsByKey = new Map<string, ThreadActionMenuBoatTarget>();
  for (const machine of input.machines) {
    if (machine.environmentId === input.threadRef.environmentId) continue;
    boatTargetsByKey.set(machine.id, {
      machineId: machine.id,
      name: machine.name,
      state: normalizeMachineState(machine.state),
      environmentId: machine.environmentId,
    });
  }

  for (const boatEnv of input.connectedBoatEnvs) {
    if (boatEnv.environmentId === input.threadRef.environmentId) continue;
    const alreadyPresent = [...boatTargetsByKey.values()].some(
      (target) => target.environmentId === boatEnv.environmentId,
    );
    if (!alreadyPresent) {
      boatTargetsByKey.set(boatEnv.environmentId, {
        machineId: boatEnv.environmentId,
        name: boatEnv.label,
        state: "idle",
        environmentId: boatEnv.environmentId,
      });
    }
  }

  const boatTargets = [...boatTargetsByKey.values()];
  const canMoveToLocal = sourceIsBoat;

  if (!canMoveToLocal && boatTargets.length === 0) {
    return null;
  }

  return {
    coordinatorId: input.coordinatorId,
    menuState: {
      sourceIsBoat,
      isTransferring: readActiveSessionTransfer(input.threadRef) !== null,
      canMoveToLocal,
      boatTargets,
    },
  };
}

/**
 * Resolves Boat transfer targets lazily when a thread action menu opens.
 * Returns synchronously when no Boat RPC is needed, and never invokes any Boat daemon RPC
 * when `hasConfiguredBoats` is false and no Boat environment is connected.
 */
export function resolveSessionTransferMenuContext(
  threadRef: ScopedThreadRef,
): ResolvedSessionTransferMenuContext | null | Promise<ResolvedSessionTransferMenuContext | null> {
  const coordinatorId = readSessionTransferCoordinatorId();
  if (coordinatorId === null) return null;

  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const coordinatorConfig = configs.get(coordinatorId);
  if (coordinatorConfig?.sessionTransfer !== true) return null;

  const connectedBoatEnvs: Array<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }> = [];
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  for (const [envId, config] of configs) {
    if (isBoatEnvironmentConfig(envId, coordinatorId, config.portableProviderAuthSync)) {
      const label =
        presentations.get(envId)?.entry.target.label ?? config.environment.label ?? String(envId);
      connectedBoatEnvs.push({ environmentId: envId, label });
    }
  }

  const hasConfiguredBoats = coordinatorConfig.hasConfiguredBoats === true;
  if (!hasConfiguredBoats && connectedBoatEnvs.length === 0) {
    return null;
  }

  const sourcePortableProviderAuthSync = configs.get(
    threadRef.environmentId,
  )?.portableProviderAuthSync;

  if (!hasConfiguredBoats || !readEnvironmentScope(coordinatorId, AuthOrchestrationReadScope)) {
    return buildMenuContextFromMachines({
      coordinatorId,
      threadRef,
      sourcePortableProviderAuthSync,
      connectedBoatEnvs,
      machines: [],
    });
  }

  return runAtomCommand(
    appAtomRegistry,
    boatsEnvironment.invoke,
    { environmentId: coordinatorId, input: { command: "get_state" } },
    { reportFailure: false },
  ).then((stateResult) =>
    buildMenuContextFromMachines({
      coordinatorId,
      threadRef,
      sourcePortableProviderAuthSync,
      connectedBoatEnvs,
      machines:
        stateResult._tag === "Success" ? extractMachinesFromUiState(stateResult.value.data) : [],
    }),
  );
}

export function isSessionTransferMenuAction(action: ThreadActionMenuId): boolean {
  return action === "move-to-local" || action.startsWith("move-to-boat:");
}

function preflightNeedsDialog(preflight: SessionTransferPreflightResult): boolean {
  return (
    !preflight.ready ||
    preflight.unsupportedReason !== null ||
    preflight.needsProjectSelection ||
    preflight.needsCloneDestination ||
    preflight.needsModelSelection ||
    preflight.needsRunningConfirmation
  );
}

export async function dispatchSessionTransferMenuAction(input: {
  readonly action: ThreadActionMenuId;
  readonly context: ResolvedSessionTransferMenuContext | null;
  readonly threadRef: ScopedThreadRef;
  readonly threadTitle: string;
}): Promise<boolean> {
  if (!isSessionTransferMenuAction(input.action)) return false;
  const context = input.context;
  if (context === null) return true;

  let direction: SessionTransferDirection;
  let target: SessionTransferTarget;
  let targetLabel: string;

  if (input.action === "move-to-local") {
    direction = "boat_to_local";
    target = { kind: "local", environmentId: context.coordinatorId };
    targetLabel = m(msg("Local"));
  } else {
    const machineId = input.action.slice("move-to-boat:".length);
    const boat = context.menuState.boatTargets.find(
      (candidate) => candidate.machineId === machineId,
    );
    const trimmedMachineId = machineId.trim();
    if (trimmedMachineId.length === 0) return true;
    const trimmedName = boat?.name.trim();
    const envId =
      typeof boat?.environmentId === "string" && boat.environmentId.length > 0
        ? EnvironmentId.make(boat.environmentId)
        : undefined;
    direction = "local_to_boat";
    target = {
      kind: "boat",
      machineId: TrimmedNonEmptyString.make(trimmedMachineId),
      ...(trimmedName && trimmedName.length > 0
        ? { machineName: TrimmedNonEmptyString.make(trimmedName) }
        : {}),
      ...(envId !== undefined ? { environmentId: envId } : {}),
    };
    targetLabel = trimmedName && trimmedName.length > 0 ? trimmedName : trimmedMachineId;
  }

  const preflightResult = await runAtomCommand(
    appAtomRegistry,
    sessionTransferEnvironment.preflight,
    {
      environmentId: context.coordinatorId,
      input: {
        direction,
        sourceEnvironmentId: input.threadRef.environmentId,
        sourceThreadId: input.threadRef.threadId,
        target,
      },
    },
    { reportFailure: false },
  );

  if (preflightResult._tag === "Failure") {
    if (!isAtomCommandInterrupted(preflightResult)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not check session transfer")),
          description:
            thrownErrorMessage(squashAtomCommandFailure(preflightResult), m) ??
            m(msg("An error occurred.")),
        }),
      );
    }
    return true;
  }

  const preflight = preflightResult.value;
  if (preflightNeedsDialog(preflight)) {
    openSessionTransferDialog({
      coordinatorId: context.coordinatorId,
      direction,
      sourceThreadRef: input.threadRef,
      sourceThreadTitle: input.threadTitle,
      target,
      targetLabel,
      preflight,
    });
    return true;
  }

  const startResult = await runAtomCommand(
    appAtomRegistry,
    sessionTransferEnvironment.start,
    {
      environmentId: context.coordinatorId,
      input: {
        direction,
        sourceEnvironmentId: input.threadRef.environmentId,
        sourceThreadId: input.threadRef.threadId,
        target,
        ...(preflight.resolvedTargetProjectId
          ? { targetProjectId: preflight.resolvedTargetProjectId }
          : {}),
        ...(preflight.resolvedModelSelection
          ? { modelSelectionOverride: preflight.resolvedModelSelection }
          : {}),
        autoResume: preflight.sourceState?.wasRunning === true,
      },
    },
    { reportFailure: false },
  );

  if (startResult._tag === "Failure" && !isAtomCommandInterrupted(startResult)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Failed to start session transfer")),
        description:
          thrownErrorMessage(squashAtomCommandFailure(startResult), m) ??
          m(msg("An error occurred.")),
      }),
    );
  }
  return true;
}

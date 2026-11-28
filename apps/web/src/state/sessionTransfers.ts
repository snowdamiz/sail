import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createSessionTransferEnvironmentAtoms,
  EMPTY_SESSION_TRANSFERS_STATE,
  type SessionTransfersState,
} from "@t3tools/client-runtime/state/sessionTransfers";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type SessionTransferRecord,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { boatServerIdAtom } from "./boats";
import { localEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession, sessionHasScope } from "./session";

export const sessionTransferEnvironment =
  createSessionTransferEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_ACTIVE_TRANSFER_ATOM = Atom.make<SessionTransferRecord | null>(null).pipe(
  Atom.withLabel("web-session-transfer:empty"),
);

const sessionTransferCoordinatorIdAtom = Atom.make((get): EnvironmentId | null => {
  const configs = get(environmentServerConfigsAtom);
  const candidates: Array<EnvironmentId | null> = [
    get(boatServerIdAtom),
    get(localEnvironmentIdAtom),
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const config = configs.get(candidate);
    if (config?.sessionTransfer === true && config.portableProviderAuthSync !== false) {
      return candidate;
    }
  }
  for (const [environmentId, config] of configs) {
    if (config.sessionTransfer === true && config.portableProviderAuthSync !== false) {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-session-transfer-coordinator"));

const sessionTransfersAtom = Atom.make((get): SessionTransfersState => {
  const coordinatorId = get(sessionTransferCoordinatorIdAtom);
  if (coordinatorId === null) {
    return EMPTY_SESSION_TRANSFERS_STATE;
  }
  if (
    !sessionHasScope(
      get(environmentSession.sessionStateAtom(coordinatorId)),
      AuthOrchestrationReadScope,
    )
  ) {
    return EMPTY_SESSION_TRANSFERS_STATE;
  }
  const result = get(
    sessionTransferEnvironment.transfers({ environmentId: coordinatorId, input: {} }),
  );
  return AsyncResult.getOrElse(result, () => EMPTY_SESSION_TRANSFERS_STATE);
}).pipe(Atom.withLabel("web-session-transfers"));

const activeSessionTransferByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(
    (get): SessionTransferRecord | null =>
      get(sessionTransfersAtom).activeByThreadKey.get(threadKey) ?? null,
  ).pipe(Atom.withLabel(`web-session-transfer-active:${threadKey}`)),
);

export function useSessionTransferCoordinatorId(): EnvironmentId | null {
  return useAtomValue(sessionTransferCoordinatorIdAtom);
}

export function readSessionTransferCoordinatorId(): EnvironmentId | null {
  return appAtomRegistry.get(sessionTransferCoordinatorIdAtom);
}

export function useSessionTransfers(): SessionTransfersState {
  return useAtomValue(sessionTransfersAtom);
}

export function useActiveSessionTransfer(
  threadRef: ScopedThreadRef | null,
): SessionTransferRecord | null {
  return useAtomValue(
    threadRef === null
      ? EMPTY_ACTIVE_TRANSFER_ATOM
      : activeSessionTransferByThreadKeyAtom(scopedThreadKey(threadRef)),
  );
}

export function readActiveSessionTransfer(
  threadRef: ScopedThreadRef,
): SessionTransferRecord | null {
  return appAtomRegistry.get(activeSessionTransferByThreadKeyAtom(scopedThreadKey(threadRef)));
}

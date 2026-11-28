import {
  isTerminalSessionTransferPhase,
  type ScopedThreadRef,
  type SessionTransferId,
  type SessionTransferProgressEvent,
  type SessionTransferRecord,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { scopedThreadKey } from "../environment/index.ts";
import { sessionTransfer as sessionTransferRpc } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export interface SessionTransfersState {
  readonly transfers: ReadonlyArray<SessionTransferRecord>;
  readonly byId: ReadonlyMap<SessionTransferId, SessionTransferRecord>;
  readonly activeByThreadKey: ReadonlyMap<string, SessionTransferRecord>;
  readonly receivedSnapshot: boolean;
}

export const EMPTY_SESSION_TRANSFERS_STATE: SessionTransfersState = {
  transfers: [],
  byId: new Map(),
  activeByThreadKey: new Map(),
  receivedSnapshot: false,
};

function buildState(
  transfers: ReadonlyArray<SessionTransferRecord>,
  receivedSnapshot: boolean,
): SessionTransfersState {
  const byId = new Map<SessionTransferId, SessionTransferRecord>();
  const activeByThreadKey = new Map<string, SessionTransferRecord>();

  for (const transfer of transfers) {
    byId.set(transfer.transferId, transfer);
    if (!isTerminalSessionTransferPhase(transfer.phase)) {
      const sourceKey = scopedThreadKey({
        environmentId: transfer.sourceEnvironmentId,
        threadId: transfer.sourceThreadId,
      });
      if (!activeByThreadKey.has(sourceKey)) {
        activeByThreadKey.set(sourceKey, transfer);
      }
      if (transfer.destinationEnvironmentId !== null && transfer.destinationThreadId !== null) {
        const destinationKey = scopedThreadKey({
          environmentId: transfer.destinationEnvironmentId,
          threadId: transfer.destinationThreadId,
        });
        if (!activeByThreadKey.has(destinationKey)) {
          activeByThreadKey.set(destinationKey, transfer);
        }
      }
    }
  }

  return {
    transfers,
    byId,
    activeByThreadKey,
    receivedSnapshot,
  };
}

export function applySessionTransferEvent(
  state: SessionTransfersState,
  event: SessionTransferProgressEvent,
): SessionTransfersState {
  if (event._tag === "snapshot") {
    const sorted = [...event.transfers].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return buildState(sorted, true);
  }

  const next = event.transfer;
  const existingIndex = state.transfers.findIndex((item) => item.transferId === next.transferId);
  const transfers =
    existingIndex === -1
      ? [next, ...state.transfers]
      : [
          next,
          ...state.transfers.slice(0, existingIndex),
          ...state.transfers.slice(existingIndex + 1),
        ];
  return buildState(transfers, state.receivedSnapshot);
}

export const foldSessionTransferEvents = <E, R>(
  events: Stream.Stream<SessionTransferProgressEvent, E, R>,
): Stream.Stream<SessionTransfersState, E, R> =>
  events.pipe(Stream.scan(() => EMPTY_SESSION_TRANSFERS_STATE, applySessionTransferEvent));

export function findActiveTransferForThread(
  state: SessionTransfersState,
  threadRef: ScopedThreadRef,
): SessionTransferRecord | null {
  return state.activeByThreadKey.get(scopedThreadKey(threadRef)) ?? null;
}

export function createSessionTransferEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    transfers: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:session-transfers:stream",
      idleTtlMs: 0,
      subscribe: (_input: Record<string, never>) =>
        sessionTransferRpc.subscribe().pipe(foldSessionTransferEvents),
    }),
    preflight: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-transfers:preflight",
      tag: WS_METHODS.sessionTransferPreflight,
      execute: (input) => sessionTransferRpc.preflight(input),
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-transfers:start",
      tag: WS_METHODS.sessionTransferStart,
      execute: (input) => sessionTransferRpc.start(input),
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-transfers:cancel",
      tag: WS_METHODS.sessionTransferCancel,
      execute: (input) => sessionTransferRpc.cancel(input),
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-transfers:retry",
      tag: WS_METHODS.sessionTransferRetry,
      execute: (input) => sessionTransferRpc.retry(input),
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-transfers:list",
      tag: WS_METHODS.sessionTransferList,
      execute: (input) => sessionTransferRpc.list(input),
    }),
  };
}

import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isTerminalSessionTransferPhase,
  type EnvironmentId,
  type SessionTransferId,
  type SessionTransferPhase,
  type SessionTransferRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { m, type MessageResolver } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { boatsEnvironment } from "../state/boats";
import { clientHostEnvironmentAtom } from "../state/clientHostEnvironment";
import {
  sessionTransferEnvironment,
  useSessionTransferCoordinatorId,
  useSessionTransfers,
} from "../state/sessionTransfers";
import { buildThreadRouteParams } from "../threadRoutes";
import { useFollowBoatLink } from "./boats/api";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface TrackedTransferToast {
  readonly toastId: ReturnType<typeof toastManager.add>;
  readonly renderedKey: string;
  readonly phase: SessionTransferPhase;
  readonly updatedAt: string;
  readonly closed?: true;
}

function sessionTransferTargetLabel(
  transfer: Pick<
    SessionTransferRecord,
    "direction" | "destinationEnvironmentName" | "destinationMachineId"
  >,
  resolve: MessageResolver = m,
): string {
  if (transfer.direction === "boat_to_local") {
    return transfer.destinationEnvironmentName ?? resolve(msg("Local"));
  }
  return (
    transfer.destinationEnvironmentName ?? transfer.destinationMachineId ?? resolve(msg("Boat"))
  );
}

export function sessionTransferPhaseLabel(
  phase: SessionTransferPhase,
  resolve: MessageResolver = m,
): string {
  switch (phase) {
    case "queued":
      return resolve(msg("Queued transfer\u2026"));
    case "waking_target":
      return resolve(msg("Waking destination Boat\u2026"));
    case "pausing_source":
      return resolve(msg("Pausing source session\u2026"));
    case "exporting_source":
      return resolve(msg("Exporting session history\u2026"));
    case "preparing_target_project":
      return resolve(msg("Preparing destination project\u2026"));
    case "transferring_workspace":
      return resolve(msg("Transferring git workspace\u2026"));
    case "transferring_attachments":
      return resolve(msg("Transferring attachments\u2026"));
    case "committing_target":
      return resolve(msg("Importing session on destination\u2026"));
    case "resuming_target":
      return resolve(msg("Resuming session on destination\u2026"));
    case "finalizing_source":
      return resolve(msg("Finalizing source session\u2026"));
    case "completed":
      return resolve(msg("Session moved."));
    case "failed":
      return resolve(msg("Session move failed."));
    case "cancelled":
      return resolve(msg("Session move cancelled."));
  }
}

function transferRenderKey(transfer: SessionTransferRecord): string {
  return `${transfer.phase}:${transfer.phaseDetail ?? ""}:${transfer.errorMessage ?? ""}:${transfer.destinationEnvironmentId ?? ""}:${transfer.destinationThreadId ?? ""}`;
}

async function runTransferCommand(
  failureTitle: string,
  run: () => Promise<ReturnType<typeof runAtomCommand> extends Promise<infer R> ? R : never>,
) {
  const result = await run();
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred.")),
      }),
    );
  }
}

export function useOpenTransferredThread() {
  const router = useRouter();
  const coordinatorId = useSessionTransferCoordinatorId();
  const onHost = useAtomValue(clientHostEnvironmentAtom(coordinatorId));
  const followBoatLink = useFollowBoatLink(onHost);

  return async (target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly machineId?: string | null;
  }) => {
    const catalogEntry = appAtomRegistry
      .get(environmentCatalog.catalogValueAtom)
      .entries.get(target.environmentId);
    if (catalogEntry?.enabled === true) {
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
      });
      return;
    }

    if (coordinatorId !== null && target.machineId) {
      const openReply = await runAtomCommand(
        appAtomRegistry,
        boatsEnvironment.invoke,
        {
          environmentId: coordinatorId,
          input: {
            command: "open_machine",
            args: { id: target.machineId, thread: target.threadId },
          },
        },
        { reportFailure: false },
      );
      if (openReply._tag === "Success" && openReply.value.openUrl) {
        followBoatLink(openReply.value.openUrl, target.environmentId);
        return;
      }

      const pairReply = await runAtomCommand(
        appAtomRegistry,
        boatsEnvironment.invoke,
        {
          environmentId: coordinatorId,
          input: { command: "pair_machine", args: { id: target.machineId } },
        },
        { reportFailure: false },
      );
      if (pairReply._tag === "Success" && pairReply.value.openUrl) {
        followBoatLink(pairReply.value.openUrl, target.environmentId);
        return;
      }
    }

    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
    });
  };
}

export function SessionTransferToasts() {
  const router = useRouter();
  const coordinatorId = useSessionTransferCoordinatorId();
  const { transfers } = useSessionTransfers();
  const routeThreadRef = useThreadRouteRef();
  const openTransferredThread = useOpenTransferredThread();

  const toastsRef = useRef(new Map<SessionTransferId, TrackedTransferToast>());
  const initializedRef = useRef(false);
  const suppressedInitialTerminalIdsRef = useRef(new Set<SessionTransferId>());
  const autoNavigatedIdsRef = useRef(new Set<SessionTransferId>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles live session transfer records with imperative toastManager toasts and auto-navigation
  useEffect(() => {
    if (transfers.length === 0) return;

    // On the initial snapshot, suppress historical already-terminal records so reconnecting
    // does not replay old completion/error toasts.
    if (!initializedRef.current) {
      initializedRef.current = true;
      for (const transfer of transfers) {
        if (isTerminalSessionTransferPhase(transfer.phase)) {
          suppressedInitialTerminalIdsRef.current.add(transfer.transferId);
        }
      }
    }

    const seen = new Set<SessionTransferId>();
    for (const transfer of transfers) {
      seen.add(transfer.transferId);
      if (suppressedInitialTerminalIdsRef.current.has(transfer.transferId)) {
        if (!isTerminalSessionTransferPhase(transfer.phase)) {
          suppressedInitialTerminalIdsRef.current.delete(transfer.transferId);
        } else {
          continue;
        }
      }

      const key = transferRenderKey(transfer);
      const tracked = toastsRef.current.get(transfer.transferId);
      if (tracked && tracked.renderedKey === key) continue;
      if (
        tracked?.closed &&
        !(
          !isTerminalSessionTransferPhase(tracked.phase) &&
          isTerminalSessionTransferPhase(transfer.phase)
        )
      ) {
        continue;
      }

      const targetLabel = sessionTransferTargetLabel(transfer, m);
      const closeToast = () => {
        const current = toastsRef.current.get(transfer.transferId);
        if (!current) return;
        toastManager.close(current.toastId);
        toastsRef.current.delete(transfer.transferId);
      };

      const upsertToast = (options: ReturnType<typeof stackedThreadToast>) => {
        const rendered = {
          renderedKey: key,
          phase: transfer.phase,
          updatedAt: transfer.updatedAt,
        };
        if (tracked && !tracked.closed) {
          toastManager.update(tracked.toastId, options);
          toastsRef.current.set(transfer.transferId, { toastId: tracked.toastId, ...rendered });
          return;
        }
        const toastId = toastManager.add({
          ...options,
          onClose: () => {
            const current = toastsRef.current.get(transfer.transferId);
            if (current?.toastId === toastId) {
              toastsRef.current.set(transfer.transferId, { ...current, closed: true });
            }
          },
        });
        toastsRef.current.set(transfer.transferId, { toastId, ...rendered });
      };

      if (!isTerminalSessionTransferPhase(transfer.phase)) {
        upsertToast(
          stackedThreadToast({
            type: "loading",
            title: m(msg("Moving session to {target}", { target: targetLabel })),
            description: sessionTransferPhaseLabel(transfer.phase, m),
            timeout: 0,
            ...(coordinatorId !== null
              ? {
                  actionProps: {
                    children: m(msg("Cancel")),
                    onClick: () => {
                      void runTransferCommand(m(msg("Failed to cancel transfer")), () =>
                        runAtomCommand(
                          appAtomRegistry,
                          sessionTransferEnvironment.cancel,
                          {
                            environmentId: coordinatorId,
                            input: { transferId: transfer.transferId },
                          },
                          { reportFailure: false },
                        ),
                      );
                    },
                  },
                }
              : {}),
            data: { hideCopyButton: true },
          }),
        );
        continue;
      }

      if (transfer.phase === "completed") {
        const destinationEnvironmentId = transfer.destinationEnvironmentId;
        const destinationThreadId = transfer.destinationThreadId;
        const hasDestination = destinationEnvironmentId !== null && destinationThreadId !== null;

        upsertToast(
          stackedThreadToast({
            type: "success",
            title: m(msg("Moved session to {target}", { target: targetLabel })),
            description: transfer.autoResume
              ? m(msg("Resumed on destination."))
              : m(msg("Ready on destination.")),
            timeout: 8_000,
            ...(hasDestination
              ? {
                  actionProps: {
                    children: m(msg("Open session")),
                    onClick: () => {
                      closeToast();
                      void openTransferredThread({
                        environmentId: destinationEnvironmentId,
                        threadId: destinationThreadId,
                        machineId: transfer.destinationMachineId,
                      });
                    },
                  },
                }
              : {}),
            data: { hideCopyButton: true },
          }),
        );

        const isViewingSource =
          routeThreadRef !== null &&
          routeThreadRef.environmentId === transfer.sourceEnvironmentId &&
          routeThreadRef.threadId === transfer.sourceThreadId;
        if (
          hasDestination &&
          isViewingSource &&
          !autoNavigatedIdsRef.current.has(transfer.transferId)
        ) {
          autoNavigatedIdsRef.current.add(transfer.transferId);
          void openTransferredThread({
            environmentId: destinationEnvironmentId,
            threadId: destinationThreadId,
            machineId: transfer.destinationMachineId,
          });
        }
        continue;
      }

      if (transfer.phase === "cancelled") {
        upsertToast(
          stackedThreadToast({
            type: "info",
            title: m(msg("Cancelled move to {target}", { target: targetLabel })),
            description: m(msg("Your session remains on its original machine.")),
            timeout: 6_000,
            data: { hideCopyButton: true },
          }),
        );
        continue;
      }

      const sourceRef = scopeThreadRef(transfer.sourceEnvironmentId, transfer.sourceThreadId);
      upsertToast(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to move session to {target}", { target: targetLabel })),
          description: transfer.errorMessage ?? m(msg("The session transfer failed.")),
          timeout: 0,
          ...(coordinatorId !== null
            ? {
                actionProps: {
                  children: m(msg("Retry")),
                  onClick: () => {
                    void runTransferCommand(m(msg("Failed to retry transfer")), () =>
                      runAtomCommand(
                        appAtomRegistry,
                        sessionTransferEnvironment.retry,
                        {
                          environmentId: coordinatorId,
                          input: { transferId: transfer.transferId },
                        },
                        { reportFailure: false },
                      ),
                    );
                  },
                },
              }
            : {}),
          data: {
            secondaryActionProps: {
              children: m(msg("Resume here")),
              onClick: () => {
                closeToast();
                void router.navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(sourceRef),
                });
              },
            },
          },
        }),
      );
    }

    for (const [transferId, tracked] of toastsRef.current) {
      if (seen.has(transferId)) continue;
      if (tracked.phase !== "completed") toastManager.close(tracked.toastId);
      toastsRef.current.delete(transferId);
    }
  }, [coordinatorId, openTransferredThread, routeThreadRef, router, transfers]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cleans up active session transfer toasts on unmount
  useEffect(
    () => () => {
      for (const tracked of toastsRef.current.values()) toastManager.close(tracked.toastId);
      toastsRef.current.clear();
    },
    [],
  );

  return null;
}

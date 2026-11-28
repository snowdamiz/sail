import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type SessionTransferDirection,
  type SessionTransferError,
  SessionTransferId,
  type SessionTransferPreflightResult,
  type SessionTransferTarget,
  type ThreadId,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as BoatSupervisor from "../../../boat/BoatSupervisor.ts";
import * as SessionTransferCoordinator from "../../../boat/SessionTransferCoordinator.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { BoatsToolkit } from "./tools.ts";

function mapSessionTransferError(error: SessionTransferError): OrchestratorMcpFailure {
  switch (error.code) {
    case "not_found":
      return new OrchestratorMcpFailure({
        code: error.message.toLowerCase().includes("thread")
          ? "thread_not_found"
          : "invalid_request",
        message: error.message,
      });
    case "unsupported":
    case "preflight_required":
    case "invalid_phase":
    case "bundle_too_large":
    case "already_in_flight":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: error.message,
      });
    case "workspace_error":
    case "attachment_error":
    case "target_unavailable":
    case "cancelled":
    case "not_implemented":
    case "internal":
      return new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: error.message,
      });
  }
}

const deriveTransferIdFromRequestId = Effect.fn("mcp.sessionTransferIdFromRequestId")(function* (
  namespace: string,
  requestId: string,
) {
  const crypto = yield* Digest.Digest;
  // @effect-diagnostics-next-line globalJsonInEffect:off - JSON pair separates caller namespace from requestId.
  const bytes = new TextEncoder().encode(JSON.stringify([namespace, requestId]));
  const digest = yield* crypto.digest(Digest.sha256, bytes).pipe(Effect.mapError(unavailable));
  return SessionTransferId.make(`tx-mcp-${Hex.encode(digest).slice(0, 24)}`);
});

interface SessionTransferToolInput {
  readonly action?: "transfer" | "preflight" | "status" | "list" | "cancel" | undefined;
  readonly direction?: SessionTransferDirection | undefined;
  readonly sourceEnvironmentId?: EnvironmentId | undefined;
  readonly sourceThreadId?: ThreadId | undefined;
  readonly target?: SessionTransferTarget | undefined;
  readonly targetProjectId?: SessionTransferCoordinator.SessionTransferCoordinatorShape["preflight"] extends (
    input: infer P,
  ) => unknown
    ? P extends { readonly targetProjectId?: infer TP }
      ? TP
      : never
    : never | undefined;
  readonly cloneDestinationPath?: SessionTransferCoordinator.SessionTransferCoordinatorShape["start"] extends (
    input: infer S,
  ) => unknown
    ? S extends { readonly cloneDestinationPath?: infer CP }
      ? CP
      : never
    : never | undefined;
  readonly modelSelectionOverride?: SessionTransferCoordinator.SessionTransferCoordinatorShape["preflight"] extends (
    input: infer P,
  ) => unknown
    ? P extends { readonly modelSelectionOverride?: infer MS }
      ? MS
      : never
    : never | undefined;
  readonly autoResume?: boolean | undefined;
  readonly confirmedRunningPause?: boolean | undefined;
  readonly requestId?: string | undefined;
  readonly transferId?: SessionTransferId | undefined;
  readonly activeOnly?: boolean | undefined;
}

const resolveTransferCoordinates = Effect.fn("mcp.resolveSessionTransferCoordinates")(function* (
  input: SessionTransferToolInput,
) {
  const direction = input.direction;
  if (direction === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "direction ('local_to_boat' or 'boat_to_local') is required.",
    });
  }

  const scope = yield* McpInvocationContext.McpInvocationContext;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

  let sourceEnvironmentId = input.sourceEnvironmentId;
  if (sourceEnvironmentId === undefined) {
    if (direction === "local_to_boat") {
      const descriptor = yield* serverEnvironment.getDescriptor;
      sourceEnvironmentId = descriptor.environmentId;
    } else {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "sourceEnvironmentId is required for boat_to_local transfers.",
      });
    }
  }

  const sourceThreadId =
    input.sourceThreadId ?? (direction === "local_to_boat" ? scope.thread?.threadId : undefined);
  if (sourceThreadId === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "sourceThreadId is required.",
    });
  }

  const target: SessionTransferTarget | undefined =
    input.target ?? (direction === "boat_to_local" ? { kind: "local" as const } : undefined);
  if (target === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message:
        "target ({ kind: 'boat', machineId: '...' }) is required for local_to_boat transfers.",
    });
  }

  return { direction, sourceEnvironmentId, sourceThreadId, target };
});

function formatPreflightBlockerFailure(
  preflight: SessionTransferPreflightResult,
  input: SessionTransferToolInput,
): OrchestratorMcpFailure | null {
  if (preflight.unsupportedReason !== null) {
    return new OrchestratorMcpFailure({
      code: "invalid_request",
      message: preflight.unsupportedReason,
    });
  }

  const blockers: string[] = [];
  if (preflight.needsProjectSelection) {
    const candidates = preflight.candidateProjects
      .map((project) => `${project.projectId} (${project.name})`)
      .join(", ");
    blockers.push(
      candidates.length > 0
        ? `Target project selection is required; specify targetProjectId from: ${candidates}.`
        : "Target project selection is required; specify targetProjectId.",
    );
  }
  if (preflight.needsCloneDestination && input.cloneDestinationPath === undefined) {
    blockers.push(
      "No matching local project was found; specify targetProjectId or cloneDestinationPath.",
    );
  }
  if (preflight.needsModelSelection) {
    const models = preflight.availableModels
      .slice(0, 8)
      .map((model) => `${model.instanceId}/${model.model}`)
      .join(", ");
    blockers.push(
      models.length > 0
        ? `Model/provider override is required; pass modelSelectionOverride using an available model (${models}).`
        : "Model/provider override is required; pass modelSelectionOverride for a provider installed on the destination.",
    );
  }
  if (preflight.needsRunningConfirmation && input.confirmedRunningPause !== true) {
    blockers.push(
      "Source thread has an active running turn; pass confirmedRunningPause: true to pause and transfer it.",
    );
  }

  if (blockers.length === 0) {
    return null;
  }

  return new OrchestratorMcpFailure({
    code:
      preflight.needsModelSelection && blockers.length === 1
        ? "model_unavailable"
        : "invalid_request",
    message: `Session transfer blocked by preflight: ${blockers.join(" ")}`,
  });
}

const resolveExplicitTransferId = Effect.fn("mcp.resolveExplicitSessionTransferId")(function* (
  input: SessionTransferToolInput,
) {
  if (input.transferId !== undefined) {
    return input.transferId;
  }
  if (input.requestId !== undefined) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return yield* deriveTransferIdFromRequestId(scope.requestNamespace, input.requestId);
  }
  return undefined;
});

const handleSessionTransferRead = Effect.fn("mcp.sessionTransferRead")(function* (
  input: SessionTransferToolInput,
) {
  const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
  const action = input.action ?? "list";

  if (action === "list") {
    const { transfers } = yield* coordinator
      .list(input.activeOnly !== undefined ? { activeOnly: input.activeOnly } : {})
      .pipe(Effect.mapError(mapSessionTransferError));
    return { transfers };
  }

  if (action === "status") {
    const lookupId = yield* resolveExplicitTransferId(input);
    if (lookupId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "status requires transferId or requestId.",
      });
    }
    const { transfers } = yield* coordinator
      .list({ activeOnly: false })
      .pipe(Effect.mapError(mapSessionTransferError));
    const found = transfers.find((record) => record.transferId === lookupId);
    if (found === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Session transfer '${lookupId}' was not found.`,
      });
    }
    return {
      transferId: found.transferId,
      status: found.phase,
      transfer: found,
    };
  }

  // preflight
  const coords = yield* resolveTransferCoordinates(input);
  const preflight = yield* coordinator
    .preflight({
      ...coords,
      ...(input.targetProjectId !== undefined ? { targetProjectId: input.targetProjectId } : {}),
      ...(input.modelSelectionOverride !== undefined
        ? { modelSelectionOverride: input.modelSelectionOverride }
        : {}),
    })
    .pipe(Effect.mapError(mapSessionTransferError));
  return { preflight };
});

const handleSessionTransferWrite = Effect.fn("mcp.sessionTransferWrite")(function* (
  input: SessionTransferToolInput,
) {
  const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
  const action = input.action ?? "transfer";

  if (action === "cancel") {
    const lookupId = yield* resolveExplicitTransferId(input);
    if (lookupId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "cancel requires transferId or requestId.",
      });
    }
    const cancelled = yield* coordinator
      .cancel({ transferId: lookupId })
      .pipe(Effect.mapError(mapSessionTransferError));
    return {
      transferId: cancelled.transferId,
      status: cancelled.phase,
      transfer: cancelled,
    };
  }

  // Idempotent lookup by requestId or explicit transferId before running preflight/start.
  const effectiveTransferId = yield* resolveExplicitTransferId(input);
  if (effectiveTransferId !== undefined) {
    const { transfers } = yield* coordinator
      .list({ activeOnly: false })
      .pipe(Effect.mapError(mapSessionTransferError));
    const existing = transfers.find((record) => record.transferId === effectiveTransferId);
    if (existing !== undefined) {
      return {
        transferId: existing.transferId,
        status: existing.phase,
        transfer: existing,
        replayed: true,
      };
    }
  }

  const coords = yield* resolveTransferCoordinates(input);
  const preflight = yield* coordinator
    .preflight({
      ...coords,
      ...(input.targetProjectId !== undefined ? { targetProjectId: input.targetProjectId } : {}),
      ...(input.modelSelectionOverride !== undefined
        ? { modelSelectionOverride: input.modelSelectionOverride }
        : {}),
    })
    .pipe(Effect.mapError(mapSessionTransferError));

  const blockerFailure = formatPreflightBlockerFailure(preflight, input);
  if (blockerFailure !== null) {
    return yield* blockerFailure;
  }

  const resolvedTargetProjectId =
    input.targetProjectId ?? preflight.resolvedTargetProjectId ?? undefined;
  const resolvedModelSelection =
    input.modelSelectionOverride ?? preflight.resolvedModelSelection ?? undefined;

  const record = yield* coordinator
    .start({
      ...(effectiveTransferId !== undefined ? { transferId: effectiveTransferId } : {}),
      ...coords,
      ...(resolvedTargetProjectId !== undefined
        ? { targetProjectId: resolvedTargetProjectId }
        : {}),
      ...(input.cloneDestinationPath !== undefined
        ? { cloneDestinationPath: input.cloneDestinationPath }
        : {}),
      ...(resolvedModelSelection !== undefined
        ? { modelSelectionOverride: resolvedModelSelection }
        : {}),
      ...(input.autoResume !== undefined ? { autoResume: input.autoResume } : {}),
      ...(input.confirmedRunningPause !== undefined
        ? { confirmedRunningPause: input.confirmedRunningPause }
        : {}),
    })
    .pipe(Effect.mapError(mapSessionTransferError));

  return {
    transferId: record.transferId,
    status: record.phase,
    transfer: record,
    preflight,
    replayed: false,
  };
});

export const layer = McpToolAccess.toLayer(BoatsToolkit, {
  t3_boats_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const boats = yield* BoatSupervisor.BoatSupervisor;
      const { data } = yield* boats.invoke({ command: "get_state" }).pipe(
        Effect.catchTags({
          BoatError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
        }),
      );
      return { state: data };
    }),
  ),
  t3_session_transfer: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "status" || input.action === "preflight",
    McpToolAccess.reads((input) => handleSessionTransferRead(input)),
    McpToolAccess.writes((input) => handleSessionTransferWrite(input)),
  ),
});

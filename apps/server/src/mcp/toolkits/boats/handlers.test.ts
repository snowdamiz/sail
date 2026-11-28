import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  IsoDateTime,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SessionTransferError,
  SessionTransferId,
  type SessionTransferPreflightInput,
  type SessionTransferPreflightResult,
  type SessionTransferRecord,
  type SessionTransferStartInput,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BoatSupervisor from "../../../boat/BoatSupervisor.ts";
import * as SessionTransferCoordinator from "../../../boat/SessionTransferCoordinator.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BoatsHandlers from "./handlers.ts";
import { BoatsToolkit } from "./tools.ts";

const LOCAL_ENV_ID = EnvironmentId.make("env-local-mcp");
const BOAT_ENV_ID = EnvironmentId.make("env-boat-mcp");
const LOCAL_PROJECT_ID = ProjectId.make("proj-local-mcp");
const BOAT_PROJECT_ID = ProjectId.make("proj-boat-mcp");
const CALLER_THREAD_ID = ThreadId.make("thread-caller-mcp");
const BOAT_THREAD_ID = ThreadId.make("thread-boat-mcp");
const NOW_ISO = IsoDateTime.make("2026-11-28T05:00:00.000Z");

const CLAUDE_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: TrimmedNonEmptyString.make("claude-sonnet-4-6"),
};

const CODEX_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: TrimmedNonEmptyString.make("gpt-5.4"),
};

function makeReadyPreflight(
  overrides: Partial<SessionTransferPreflightResult> = {},
): SessionTransferPreflightResult {
  return {
    ready: true,
    warnings: [],
    needsProjectSelection: false,
    candidateProjects: [],
    needsCloneDestination: false,
    needsModelSelection: false,
    availableModels: [
      {
        instanceId: CLAUDE_MODEL.instanceId,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        model: CLAUDE_MODEL.model,
      },
      {
        instanceId: CODEX_MODEL.instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        model: CODEX_MODEL.model,
      },
    ],
    needsRunningConfirmation: false,
    unsupportedReason: null,
    resolvedTargetProjectId: BOAT_PROJECT_ID,
    resolvedModelSelection: CLAUDE_MODEL,
    willAutoCloneProject: false,
    ...overrides,
  };
}

function makeTransferRecord(input: SessionTransferStartInput, seq: number): SessionTransferRecord {
  const transferId = input.transferId ?? SessionTransferId.make(`tx-gen-${seq}`);
  return {
    transferId,
    direction: input.direction,
    sourceEnvironmentId: input.sourceEnvironmentId,
    sourceEnvironmentName: TrimmedNonEmptyString.make(
      input.direction === "local_to_boat" ? "Local Mac" : "dev-boat",
    ),
    sourceMachineId:
      input.direction === "boat_to_local" ? TrimmedNonEmptyString.make("machine-1") : null,
    sourceProjectId: input.direction === "local_to_boat" ? LOCAL_PROJECT_ID : BOAT_PROJECT_ID,
    sourceThreadId: input.sourceThreadId,
    destinationEnvironmentId:
      input.direction === "local_to_boat"
        ? input.target.kind === "boat"
          ? (input.target.environmentId ?? BOAT_ENV_ID)
          : BOAT_ENV_ID
        : LOCAL_ENV_ID,
    destinationEnvironmentName: TrimmedNonEmptyString.make(
      input.direction === "local_to_boat" ? "dev-boat" : "Local Mac",
    ),
    destinationMachineId:
      input.target.kind === "boat" ? TrimmedNonEmptyString.make(input.target.machineId) : null,
    destinationProjectId: input.targetProjectId ?? null,
    destinationThreadId: null,
    phase: "queued",
    phaseDetail: "Queued transfer...",
    sourceWasRunning: input.confirmedRunningPause === true,
    autoResume: input.autoResume ?? true,
    hadPendingRuntimeRequest: false,
    destinationBranch: null,
    destinationWorktreePath: null,
    modelSelectionOverride: input.modelSelectionOverride ?? null,
    cloneDestinationPath: input.cloneDestinationPath ?? null,
    warnings: [],
    errorMessage: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    completedAt: null,
  };
}

interface BoatsHarness {
  readonly preflightCalls: Array<SessionTransferPreflightInput>;
  readonly startCalls: Array<SessionTransferStartInput>;
  readonly cancelCalls: Array<SessionTransferId>;
  readonly records: Map<SessionTransferId, SessionTransferRecord>;
  readonly call: <A = unknown>(
    toolName: "t3_boats_read" | "t3_session_transfer",
    params: Record<string, unknown>,
  ) => Effect.Effect<{ readonly isFailure: boolean; readonly result: A }>;
}

function makeBoatsHarness(options?: {
  readonly preflightHandler?: (
    input: SessionTransferPreflightInput,
  ) => Effect.Effect<SessionTransferPreflightResult, SessionTransferError>;
  readonly clientAccess?: "read-only" | "full-access";
  readonly requestNamespace?: string;
}): Effect.Effect<BoatsHarness> {
  return Effect.gen(function* () {
    const preflightCalls: Array<SessionTransferPreflightInput> = [];
    const startCalls: Array<SessionTransferStartInput> = [];
    const cancelCalls: Array<SessionTransferId> = [];
    const records = new Map<SessionTransferId, SessionTransferRecord>();
    let seq = 0;

    const invocationScope: McpInvocationContext.McpInvocationScope = {
      environmentId: LOCAL_ENV_ID,
      requestNamespace: options?.requestNamespace ?? "provider:session-boats-test",
      thread:
        options?.clientAccess === undefined
          ? {
              threadId: CALLER_THREAD_ID,
              providerSessionId: "provider:session-boats-test",
              providerInstanceId: CODEX_MODEL.instanceId,
            }
          : undefined,
      client:
        options?.clientAccess !== undefined
          ? {
              sessionId: "client-session-1",
              label: "MCP Test Client",
              access: options.clientAccess,
            }
          : undefined,
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 1,
    };

    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(threadId === CALLER_THREAD_ID ? liveThreadShell(CALLER_THREAD_ID) : null),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: LOCAL_ENV_ID,
          label: "Local Mac",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
        } as never),
      }),
      Layer.mock(BoatSupervisor.BoatSupervisor)({
        invoke: () =>
          Effect.succeed({ data: { machines: [{ id: "machine-1", name: "dev-boat" }] } }),
      }),
      Layer.mock(SessionTransferCoordinator.SessionTransferCoordinator)({
        preflight: (input) => {
          preflightCalls.push(input);
          if (options?.preflightHandler !== undefined) {
            return options.preflightHandler(input);
          }
          return Effect.succeed(
            makeReadyPreflight({
              resolvedTargetProjectId:
                input.direction === "local_to_boat" ? BOAT_PROJECT_ID : LOCAL_PROJECT_ID,
            }),
          );
        },
        start: (input) => {
          startCalls.push(input);
          if (input.transferId !== undefined) {
            const existing = records.get(input.transferId);
            if (existing !== undefined) {
              return Effect.succeed(existing);
            }
          }
          seq += 1;
          const record = makeTransferRecord(input, seq);
          records.set(record.transferId, record);
          return Effect.succeed(record);
        },
        cancel: (input) => {
          cancelCalls.push(input.transferId);
          const existing = records.get(input.transferId);
          if (existing === undefined) {
            return Effect.fail(
              new SessionTransferError({
                code: "not_found",
                message: `Transfer ${input.transferId} was not found.`,
                transferId: input.transferId,
              }),
            );
          }
          const updated: SessionTransferRecord = {
            ...existing,
            phase: "cancelled",
            completedAt: NOW_ISO,
          };
          records.set(updated.transferId, updated);
          return Effect.succeed(updated);
        },
        list: (input) =>
          Effect.succeed({
            transfers: [...records.values()].filter((record) =>
              input.activeOnly
                ? record.phase !== "completed" &&
                  record.phase !== "failed" &&
                  record.phase !== "cancelled"
                : true,
            ),
          }),
      }),
      NodeServices.layer,
      NodeCrypto.layer,
    );

    const toolkit = yield* BoatsToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(BoatsHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    return {
      preflightCalls,
      startCalls,
      cancelCalls,
      records,
      call: <A = unknown>(
        toolName: "t3_boats_read" | "t3_session_transfer",
        params: Record<string, unknown>,
      ) =>
        toolkit.handle(toolName as never, params as never).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.orDie,
          Effect.provide(dependencies),
          Effect.map((results) => {
            const first = results[0];
            if (first === undefined) {
              throw new Error(`No handler result returned for ${toolName}`);
            }
            return {
              isFailure: first.isFailure,
              result: first.result as A,
            };
          }),
        ),
    };
  });
}

it.effect("transfers a local thread to a Boat machine via t3_session_transfer", () =>
  Effect.gen(function* () {
    const harness = yield* makeBoatsHarness();

    const response = yield* harness.call<{
      readonly transferId: SessionTransferId;
      readonly status: string;
      readonly transfer: SessionTransferRecord;
      readonly replayed: boolean;
    }>("t3_session_transfer", {
      direction: "local_to_boat",
      target: {
        kind: "boat",
        machineId: "machine-1",
        machineName: "dev-boat",
        environmentId: BOAT_ENV_ID,
      },
      autoResume: true,
    });

    expect(response.isFailure).toBe(false);
    expect(response.result.status).toBe("queued");
    expect(response.result.replayed).toBe(false);
    expect(response.result.transfer.direction).toBe("local_to_boat");
    expect(response.result.transfer.sourceEnvironmentId).toBe(LOCAL_ENV_ID);
    expect(response.result.transfer.sourceThreadId).toBe(CALLER_THREAD_ID);
    expect(response.result.transfer.destinationProjectId).toBe(BOAT_PROJECT_ID);

    expect(harness.preflightCalls).toHaveLength(1);
    expect(harness.startCalls).toHaveLength(1);
    expect(harness.startCalls[0]?.sourceEnvironmentId).toBe(LOCAL_ENV_ID);
    expect(harness.startCalls[0]?.sourceThreadId).toBe(CALLER_THREAD_ID);
    expect(harness.startCalls[0]?.targetProjectId).toBe(BOAT_PROJECT_ID);
  }),
);

it.effect("transfers a Boat thread back to Local via t3_session_transfer", () =>
  Effect.gen(function* () {
    const harness = yield* makeBoatsHarness();

    const response = yield* harness.call<{
      readonly transferId: SessionTransferId;
      readonly status: string;
      readonly transfer: SessionTransferRecord;
      readonly replayed: boolean;
    }>("t3_session_transfer", {
      direction: "boat_to_local",
      sourceEnvironmentId: BOAT_ENV_ID,
      sourceThreadId: BOAT_THREAD_ID,
    });

    expect(response.isFailure).toBe(false);
    expect(response.result.status).toBe("queued");
    expect(response.result.replayed).toBe(false);
    expect(response.result.transfer.direction).toBe("boat_to_local");
    expect(response.result.transfer.sourceEnvironmentId).toBe(BOAT_ENV_ID);
    expect(response.result.transfer.sourceThreadId).toBe(BOAT_THREAD_ID);
    expect(response.result.transfer.destinationProjectId).toBe(LOCAL_PROJECT_ID);

    expect(harness.startCalls).toHaveLength(1);
    expect(harness.startCalls[0]?.target).toEqual({ kind: "local" });
  }),
);

it.effect("replays repeated requestId idempotently without starting a duplicate transfer", () =>
  Effect.gen(function* () {
    const harness = yield* makeBoatsHarness();

    const first = yield* harness.call<{
      readonly transferId: SessionTransferId;
      readonly status: string;
      readonly transfer: SessionTransferRecord;
      readonly replayed: boolean;
    }>("t3_session_transfer", {
      direction: "local_to_boat",
      target: { kind: "boat", machineId: "machine-1" },
      requestId: "move-thread-42",
    });

    expect(first.isFailure).toBe(false);
    expect(first.result.replayed).toBe(false);
    expect(first.result.transferId).toMatch(/^tx-mcp-[0-9a-f]{24}$/);

    // Simulate transfer advancing to completed before retry arrives.
    const existing = harness.records.get(first.result.transferId)!;
    harness.records.set(first.result.transferId, {
      ...existing,
      phase: "completed",
      completedAt: NOW_ISO,
    });

    const second = yield* harness.call<{
      readonly transferId: SessionTransferId;
      readonly status: string;
      readonly transfer: SessionTransferRecord;
      readonly replayed: boolean;
    }>("t3_session_transfer", {
      direction: "local_to_boat",
      target: { kind: "boat", machineId: "machine-1" },
      requestId: "move-thread-42",
    });

    expect(second.isFailure).toBe(false);
    expect(second.result.replayed).toBe(true);
    expect(second.result.transferId).toBe(first.result.transferId);
    expect(second.result.status).toBe("completed");
    expect(harness.preflightCalls).toHaveLength(1);
    expect(harness.startCalls).toHaveLength(1);

    // Status lookup by the same requestId resolves the exact transfer.
    const status = yield* harness.call<{
      readonly transferId: SessionTransferId;
      readonly status: string;
    }>("t3_session_transfer", {
      action: "status",
      requestId: "move-thread-42",
    });
    expect(status.isFailure).toBe(false);
    expect(status.result.transferId).toBe(first.result.transferId);
    expect(status.result.status).toBe("completed");
  }),
);

it.effect("surfaces preflight model override blocker clearly and succeeds once supplied", () =>
  Effect.gen(function* () {
    const harness = yield* makeBoatsHarness({
      preflightHandler: (input) =>
        Effect.succeed(
          input.modelSelectionOverride === undefined
            ? makeReadyPreflight({
                ready: false,
                needsModelSelection: true,
                resolvedModelSelection: null,
                availableModels: [
                  {
                    instanceId: CODEX_MODEL.instanceId,
                    driverKind: ProviderDriverKind.make("codex"),
                    model: CODEX_MODEL.model,
                  },
                ],
              })
            : makeReadyPreflight({
                ready: true,
                needsModelSelection: false,
                resolvedModelSelection: input.modelSelectionOverride,
              }),
        ),
    });

    const blocked = yield* harness.call<{ readonly code: string; readonly message: string }>(
      "t3_session_transfer",
      {
        direction: "local_to_boat",
        target: { kind: "boat", machineId: "machine-1" },
      },
    );

    expect(blocked.isFailure).toBe(true);
    expect(blocked.result.code).toBe("model_unavailable");
    expect(blocked.result.message).toContain("modelSelectionOverride");
    expect(blocked.result.message).toContain("codex/gpt-5.4");
    expect(harness.startCalls).toHaveLength(0);

    const unblocked = yield* harness.call<{
      readonly transferId: SessionTransferId;
      readonly transfer: SessionTransferRecord;
    }>("t3_session_transfer", {
      direction: "local_to_boat",
      target: { kind: "boat", machineId: "machine-1" },
      modelSelectionOverride: CODEX_MODEL,
    });

    expect(unblocked.isFailure).toBe(false);
    expect(unblocked.result.transfer.modelSelectionOverride).toEqual(CODEX_MODEL);
    expect(harness.startCalls).toHaveLength(1);
  }),
);

it.effect(
  "surfaces running-turn confirmation, project selection, and unsupported blockers clearly",
  () =>
    Effect.gen(function* () {
      const runningHarness = yield* makeBoatsHarness({
        preflightHandler: () =>
          Effect.succeed(
            makeReadyPreflight({
              ready: false,
              needsRunningConfirmation: true,
            }),
          ),
      });

      const blockedRunning = yield* runningHarness.call<{
        readonly code: string;
        readonly message: string;
      }>("t3_session_transfer", {
        direction: "local_to_boat",
        target: { kind: "boat", machineId: "machine-1" },
      });
      expect(blockedRunning.isFailure).toBe(true);
      expect(blockedRunning.result.code).toBe("invalid_request");
      expect(blockedRunning.result.message).toContain("confirmedRunningPause");
      expect(runningHarness.startCalls).toHaveLength(0);

      const confirmedRunning = yield* runningHarness.call<{
        readonly transferId: SessionTransferId;
      }>("t3_session_transfer", {
        direction: "local_to_boat",
        target: { kind: "boat", machineId: "machine-1" },
        confirmedRunningPause: true,
      });
      expect(confirmedRunning.isFailure).toBe(false);
      expect(runningHarness.startCalls).toHaveLength(1);

      const multiProjectHarness = yield* makeBoatsHarness({
        preflightHandler: () =>
          Effect.succeed(
            makeReadyPreflight({
              ready: false,
              needsProjectSelection: true,
              resolvedTargetProjectId: null,
              candidateProjects: [
                {
                  projectId: ProjectId.make("proj-a"),
                  name: TrimmedNonEmptyString.make("Repo A"),
                  workspaceRoot: TrimmedNonEmptyString.make("/repos/a"),
                },
                {
                  projectId: ProjectId.make("proj-b"),
                  name: TrimmedNonEmptyString.make("Repo B"),
                  workspaceRoot: TrimmedNonEmptyString.make("/repos/b"),
                },
              ],
            }),
          ),
      });
      const blockedProject = yield* multiProjectHarness.call<{
        readonly code: string;
        readonly message: string;
      }>("t3_session_transfer", {
        direction: "boat_to_local",
        sourceEnvironmentId: BOAT_ENV_ID,
        sourceThreadId: BOAT_THREAD_ID,
      });
      expect(blockedProject.isFailure).toBe(true);
      expect(blockedProject.result.message).toContain("targetProjectId");
      expect(blockedProject.result.message).toContain("proj-a");
      expect(blockedProject.result.message).toContain("proj-b");

      const unsupportedHarness = yield* makeBoatsHarness({
        preflightHandler: () =>
          Effect.succeed(
            makeReadyPreflight({
              ready: false,
              unsupportedReason: "Boat server does not support session transfer.",
            }),
          ),
      });
      const unsupported = yield* unsupportedHarness.call<{
        readonly code: string;
        readonly message: string;
      }>("t3_session_transfer", {
        direction: "local_to_boat",
        target: { kind: "boat", machineId: "machine-1" },
      });
      expect(unsupported.isFailure).toBe(true);
      expect(unsupported.result.message).toContain("does not support session transfer");
    }),
);

it.effect("supports list, cancel, and read-only preflight actions cleanly", () =>
  Effect.gen(function* () {
    const harness = yield* makeBoatsHarness();

    const preflight = yield* harness.call<{
      readonly preflight: SessionTransferPreflightResult;
    }>("t3_session_transfer", {
      action: "preflight",
      direction: "local_to_boat",
      target: { kind: "boat", machineId: "machine-1" },
    });
    expect(preflight.isFailure).toBe(false);
    expect(preflight.result.preflight.ready).toBe(true);
    expect(harness.startCalls).toHaveLength(0);

    const started = yield* harness.call<{ readonly transferId: SessionTransferId }>(
      "t3_session_transfer",
      {
        direction: "local_to_boat",
        target: { kind: "boat", machineId: "machine-1" },
        requestId: "cancel-me",
      },
    );
    expect(started.isFailure).toBe(false);

    const listed = yield* harness.call<{
      readonly transfers: ReadonlyArray<SessionTransferRecord>;
    }>("t3_session_transfer", { action: "list", activeOnly: true });
    expect(listed.isFailure).toBe(false);
    expect(listed.result.transfers.map((t) => t.transferId)).toEqual([started.result.transferId]);

    const cancelled = yield* harness.call<{
      readonly transferId: SessionTransferId;
      readonly status: string;
    }>("t3_session_transfer", {
      action: "cancel",
      requestId: "cancel-me",
    });
    expect(cancelled.isFailure).toBe(false);
    expect(cancelled.result.transferId).toBe(started.result.transferId);
    expect(cancelled.result.status).toBe("cancelled");
    expect(harness.cancelCalls).toEqual([started.result.transferId]);

    // Read-only clients can list/preflight, but cannot start a transfer.
    const readOnlyHarness = yield* makeBoatsHarness({ clientAccess: "read-only" });
    const readOnlyList = yield* readOnlyHarness.call<{
      readonly transfers: ReadonlyArray<SessionTransferRecord>;
    }>("t3_session_transfer", { action: "list" });
    expect(readOnlyList.isFailure).toBe(false);

    const readOnlyTransfer = yield* readOnlyHarness.call<{
      readonly code: string;
      readonly message: string;
    }>("t3_session_transfer", {
      direction: "local_to_boat",
      sourceThreadId: CALLER_THREAD_ID,
      target: { kind: "boat", machineId: "machine-1" },
    });
    expect(readOnlyTransfer.isFailure).toBe(true);
    expect(readOnlyTransfer.result.code).toBe("capability_denied");
  }),
);

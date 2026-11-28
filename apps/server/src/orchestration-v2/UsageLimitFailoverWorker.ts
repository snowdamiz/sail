import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import {
  latestRootProviderFailure,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import {
  resolveUsageLimitFailoverTarget,
  type UsageLimitFailoverSettings,
} from "@t3tools/shared/usageFailover";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { withAdmission } from "../serverAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type UsageLimitFailoverPlan =
  | {
      readonly kind: "dispatch";
      readonly failedRunId: RunId;
      readonly command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
    }
  | {
      readonly kind: "none";
      readonly failedRunId?: RunId;
      readonly reason:
        | "ineligible_thread"
        | "active_or_queued_run"
        | "not_usage_limit"
        | "already_failed_over"
        | "disabled"
        | "unknown_provider"
        | "no_eligible_target";
    };

function isBusyRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "queued" ||
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

/**
 * True when the failed run emitted assistant output or tool/subagent/plan work, so continuation
 * should resume from context handoff rather than replaying the original user prompt verbatim.
 */
export function hasRunAssistantProgress(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
  run: OrchestrationV2Run,
): boolean {
  if (
    projection.messages.some(
      (message) =>
        message.runId === run.id && message.role === "assistant" && message.text.trim().length > 0,
    )
  ) {
    return true;
  }
  for (const item of projection.turnItems) {
    if (item.runId !== run.id) continue;
    switch (item.type) {
      case "assistant_message":
        if (item.text.trim().length > 0) return true;
        break;
      case "command_execution":
      case "file_change":
      case "file_search":
      case "web_search":
      case "dynamic_tool":
      case "subagent":
      case "proposed_plan":
        return true;
      default:
        break;
    }
  }
  return false;
}

function isPromptDroppedForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "attempts" | "providerTurns">,
  run: OrchestrationV2Run,
): boolean {
  const providerTurns = projection.providerTurns ?? [];
  if (providerTurns.length === 0) return false;
  const attemptIds = new Set(
    (projection.attempts ?? [])
      .filter((attempt) => attempt.runId === run.id)
      .map((attempt) => attempt.id),
  );
  if (run.activeAttemptId !== null) {
    attemptIds.add(run.activeAttemptId);
  }
  return providerTurns.some(
    (turn) =>
      turn.runAttemptId !== null &&
      attemptIds.has(turn.runAttemptId) &&
      turn.promptDropped === true,
  );
}

export function planUsageLimitFailoverCommand(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly providers: readonly ServerProvider[];
  readonly settings: UsageLimitFailoverSettings;
  readonly nowMs: number;
}): UsageLimitFailoverPlan {
  const { projection, providers, settings, nowMs } = input;
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    projection.runtimeRequests.some((request) => request.status === "pending")
  ) {
    return { kind: "none", reason: "ineligible_thread" };
  }
  if (projection.runs.some(isBusyRun)) {
    return { kind: "none", reason: "active_or_queued_run" };
  }

  const failedRun = usageLimitBlockedRun(projection.runs, projection.turnItems, null);
  if (failedRun === null) {
    return { kind: "none", reason: "not_usage_limit" };
  }
  const failure = latestRootProviderFailure(failedRun, projection.turnItems);
  if (failure?.class !== "usage_limit") {
    return { kind: "none", reason: "not_usage_limit" };
  }
  if (projection.runs.some((run) => run.usageLimitFailoverOfRunId === failedRun.id)) {
    return { kind: "none", failedRunId: failedRun.id, reason: "already_failed_over" };
  }

  const attemptedInstanceIds = new Set<ProviderInstanceId>([
    ...(failedRun.failoverAttemptedInstanceIds ?? []),
    failedRun.providerInstanceId,
  ]);
  const resolution = resolveUsageLimitFailoverTarget({
    currentSelection: failedRun.modelSelection,
    providers,
    settings,
    projectId: thread.projectId,
    now: nowMs,
    runtimeMode: thread.runtimeMode,
    attemptedInstanceIds,
  });
  if (resolution.kind === "none") {
    return { kind: "none", failedRunId: failedRun.id, reason: resolution.reason };
  }

  const madeProgress =
    !isPromptDroppedForRun(projection, failedRun) && hasRunAssistantProgress(projection, failedRun);
  const originalMessage = madeProgress
    ? undefined
    : projection.messages.find((message) => message.id === failedRun.userMessageId);

  const text = originalMessage?.text ?? "Continue where you left off.";
  const attachments = originalMessage?.attachments ?? [];
  const context = originalMessage?.context;
  const identity = `${thread.id}:${failedRun.id}`;

  return {
    kind: "dispatch",
    failedRunId: failedRun.id,
    command: {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-failover:${identity}`),
      messageId: MessageId.make(`limit-failover:${identity}`),
      threadId: thread.id,
      modelSelection: resolution.target,
      usageLimitFailoverOfRunId: failedRun.id,
      failoverAttemptedInstanceIds: [...attemptedInstanceIds],
      failoverNotice: {
        kind: resolution.kind,
        fromInstanceId: failedRun.providerInstanceId,
        fromModel: failedRun.modelSelection.model,
        toInstanceId: resolution.target.instanceId,
        toModel: resolution.target.model,
      },
      text,
      attachments,
      ...(context === undefined ? {} : { context }),
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    },
  };
}

function failoverTriggerThreadId(event: OrchestrationV2DomainEvent): ThreadId | null {
  if (event.type === "run.updated" && event.payload.status === "failed") {
    return event.threadId;
  }
  if (
    event.type === "turn-item.updated" &&
    event.payload.type === "error" &&
    event.payload.failure.class === "usage_limit" &&
    event.payload.runId !== null
  ) {
    return event.threadId;
  }
  return null;
}

export const makeFailoverProcessor = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const recoverDelegatedChild = (threadId: ThreadId, sourceRunId: RunId) =>
    orchestrator.recoverDelegatedTask(threadId, { sourceRunId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.limit-failover.child-recovery-failed", {
          threadId,
          sourceRunId,
          cause,
        }),
      ),
    );

  return Effect.fn("UsageLimitFailoverWorker.processThread")(function* (threadId: ThreadId) {
    const projectionOption = yield* projections.getThreadProjection(threadId).pipe(Effect.option);
    if (Option.isNone(projectionOption)) return;
    const projection = projectionOption.value;
    const isDelegatedChild = projection.thread.lineage.parentThreadId !== null;

    const settings = yield* settingsService.getSettings;
    const providers = yield* providerRegistry.getProviders;
    const now = yield* DateTime.now;
    const plan = planUsageLimitFailoverCommand({
      projection,
      providers,
      settings,
      nowMs: DateTime.toEpochMillis(now),
    });

    if (plan.kind === "none") {
      if (
        isDelegatedChild &&
        plan.failedRunId !== undefined &&
        (plan.reason === "disabled" ||
          plan.reason === "unknown_provider" ||
          plan.reason === "no_eligible_target")
      ) {
        yield* recoverDelegatedChild(threadId, plan.failedRunId);
      }
      return;
    }

    yield* threads.dispatch(plan.command).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.limit-failover.dispatch-failed", {
          threadId,
          failedRunId: plan.failedRunId,
          targetInstanceId: plan.command.modelSelection?.instanceId,
          cause,
        }).pipe(
          Effect.andThen(
            isDelegatedChild ? recoverDelegatedChild(threadId, plan.failedRunId) : Effect.void,
          ),
        ),
      ),
    );
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const processThread = yield* makeFailoverProcessor;
    const worker = yield* makeKeyedCoalescingWorker<ThreadId, true, never, never>({
      merge: () => true,
      process: (threadId) =>
        processThread(threadId).pipe(
          withAdmission("root"),
          Effect.catchTags({ ServerMaintenanceBusy: () => Effect.void }),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-failover.worker-error", {
              threadId,
              cause,
            }),
          ),
        ),
    });
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        const threadId = failoverTriggerThreadId(event);
        return threadId === null ? Effect.void : worker.enqueue(threadId, true);
      }),
    );
    yield* forkParked(
      projections.getUsageLimitFailoverCandidateThreadIds().pipe(
        withAdmission("root"),
        Effect.catchTags({
          ServerMaintenanceBusy: () => Effect.succeed([] as ReadonlyArray<ThreadId>),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-failover.startup-scan-failed", {
            cause,
          }).pipe(Effect.as([] as ReadonlyArray<ThreadId>)),
        ),
        Effect.flatMap((threadIds) =>
          Effect.forEach(threadIds, (threadId) => worker.enqueue(threadId, true), {
            discard: true,
          }),
        ),
      ),
    );
  }),
);

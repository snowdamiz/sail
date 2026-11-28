import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { hasPotetoModeTriggeredInSessionBeforeRun } from "./contextBoundary.ts";

const NOW = DateTime.makeUnsafe("2026-11-28T00:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-poteto-session");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const PROVIDER_THREAD_ID = ProviderThreadId.make("pt-poteto-session");

function makeRun(ordinal: number, overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId: THREAD_ID,
    ordinal,
    providerInstanceId: INSTANCE_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
    providerThreadId: PROVIDER_THREAD_ID,
    userMessageId: MessageId.make(`msg-${ordinal}`),
    rootNodeId: NodeId.make(`node-${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt-${ordinal}`),
    status: "completed",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function makeScheduledUserItem(
  run: OrchestrationV2Run,
): OrchestrationV2ThreadProjection["turnItems"][number] {
  return {
    type: "user_message",
    id: TurnItemId.make(`item-${run.ordinal}`),
    threadId: THREAD_ID,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: run.ordinal,
    status: "completed",
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    createdBy: "system",
    creationSource: "server",
    messageId: run.userMessageId,
    text: "scheduled check",
    inputIntent: "turn_start",
    attachments: [],
    scheduledTaskId: ScheduledTaskId.make("sched-1"),
  };
}

describe("hasPotetoModeTriggeredInSessionBeforeRun", () => {
  it("triggers on the first prompt or mid-session, then suppresses subsequent prompts in the same session", () => {
    const run1 = makeRun(1, { potetoMode: undefined });
    const run2 = makeRun(2, {
      potetoMode: true,
      status: "starting",
      startedAt: null,
      completedAt: null,
    });

    // Mid-session activation on run 2: run 1 did not trigger poteto-mode.
    assert.isFalse(
      hasPotetoModeTriggeredInSessionBeforeRun({ runs: [run1, run2], turnItems: [] }, run2),
    );

    // Once run 2 has started, run 3 in the same session must not re-trigger poteto-mode.
    const run2Started = { ...run2, status: "completed" as const, startedAt: NOW, completedAt: NOW };
    const run3 = makeRun(3, {
      potetoMode: true,
      status: "starting",
      startedAt: null,
      completedAt: null,
    });
    assert.isTrue(
      hasPotetoModeTriggeredInSessionBeforeRun(
        { runs: [run1, run2Started, run3], turnItems: [] },
        run3,
      ),
    );
  });

  it("resets when a freshContext run starts a new session", () => {
    const run1 = makeRun(1, { potetoMode: true });
    const run2Fresh = makeRun(2, {
      freshContext: true,
      potetoMode: true,
      status: "starting",
      startedAt: null,
      completedAt: null,
    });

    // Fresh-context run starts a brand-new session -> allowed to trigger poteto-mode.
    assert.isFalse(
      hasPotetoModeTriggeredInSessionBeforeRun(
        { runs: [run1, run2Fresh], turnItems: [] },
        run2Fresh,
      ),
    );

    // Run 3 after a fresh-context run without poteto-mode can still trigger mid-session.
    const run2FreshNoPoteto = makeRun(2, { freshContext: true });
    const run3 = makeRun(3, {
      potetoMode: true,
      status: "starting",
      startedAt: null,
      completedAt: null,
    });
    assert.isFalse(
      hasPotetoModeTriggeredInSessionBeforeRun(
        { runs: [run1, run2FreshNoPoteto, run3], turnItems: [] },
        run3,
      ),
    );
  });

  it("does not count pre-start cancellations, pre-start failures, or scheduled fresh side runs", () => {
    const cancelledBeforeStart = makeRun(1, {
      potetoMode: true,
      status: "cancelled",
      startedAt: null,
    });
    const failedBeforeStart = makeRun(2, {
      potetoMode: true,
      status: "failed",
      startedAt: null,
    });
    const scheduledFresh = makeRun(3, {
      freshContext: true,
      potetoMode: true,
    });
    const current = makeRun(4, {
      potetoMode: true,
      status: "starting",
      startedAt: null,
      completedAt: null,
    });

    assert.isFalse(
      hasPotetoModeTriggeredInSessionBeforeRun(
        {
          runs: [cancelledBeforeStart, failedBeforeStart, scheduledFresh, current],
          turnItems: [makeScheduledUserItem(scheduledFresh)],
        },
        current,
      ),
    );
  });
});

import {
  isCompactionCommandMessage,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type OrchestrationV2FailoverNotice,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@t3tools/contracts";
import { formatModelSlugName, modelSelectionsEqual } from "@t3tools/shared/model";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

/**
 * Clients hide pending queued messages, fold async answers into their question, and replace
 * `/compact` with a compaction row.
 */
export const isShownUserMessageItem = (item: OrchestrationV2TurnItem): boolean =>
  item.type === "user_message" &&
  !(item.inputIntent === "queued_turn" && item.status === "pending") &&
  !item.messageId.startsWith("async-answer:") &&
  !isCompactionCommandMessage({ role: "user", ...item });

type ModelSwitchRun = OrchestrationV2ThreadProjection["runs"][number];

/** A run that has not been undone and has started or can start. */
export const isModelSwitchCandidate = (run: ModelSwitchRun): boolean =>
  run.status !== "rolled_back" && run.status !== "queued";

/** A run `modelSwitchSince` can measure from: its prompt is shown, or its handoff row shows it. */
export const anchorsModelSwitch = (run: ModelSwitchRun, shownMessageIds: ReadonlySet<string>) =>
  isModelSwitchCandidate(run) &&
  (shownMessageIds.has(run.userMessageId) || run.contextHandoffId !== null);

/**
 * The model or effort change a new run brings, measured from the latest run the timeline shows
 * through its message or its handoff row, so consecutive dividers always chain. `baseline` stands
 * in when there is none, such as a fork's source run. Callers skip starts with a context handoff;
 * the handoff item already shows those.
 */
export function modelSwitchSince(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  to: ModelSelection,
  baseline?: ModelSelection,
): Pick<Extract<OrchestrationV2TurnItem, { type: "user_message" }>, "modelSwitch"> {
  const shown = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "user_message" && isShownUserMessageItem(item) ? [item.messageId] : [],
    ),
  );
  let previous: ModelSwitchRun | undefined;
  for (const run of projection.runs) {
    // A wake shows as a notification, but its context handoff row still shows the swap.
    if (!anchorsModelSwitch(run, shown)) continue;
    if (previous === undefined || runRanAfter(run, previous)) previous = run;
  }
  const from = previous?.modelSelection ?? baseline;
  return from === undefined || modelSelectionsEqual(from, to) ? {} : { modelSwitch: { from, to } };
}

function providerLabel(instanceId: string, provider: ServerProvider | undefined): string {
  const customName = provider?.displayName?.trim();
  if (customName) return customName;
  if (provider) {
    return PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.instanceId;
  }
  return instanceId;
}

function modelLabel(model: string, provider: ServerProvider | undefined): string {
  const matched = provider?.models.find(
    (entry) => entry.slug === model || entry.aliases?.includes(model),
  );
  return matched?.name ?? formatModelSlugName(model);
}

export function formatFailoverNotice(
  notice: OrchestrationV2FailoverNotice,
  providers: readonly ServerProvider[] = [],
): string {
  const fromProvider = providers.find((entry) => entry.instanceId === notice.fromInstanceId);
  const toProvider = providers.find((entry) => entry.instanceId === notice.toInstanceId);
  const fromName = providerLabel(notice.fromInstanceId, fromProvider);
  const toName = providerLabel(notice.toInstanceId, toProvider);
  const toModel = modelLabel(notice.toModel, toProvider);

  if (notice.kind === "same_provider_account") {
    return `Usage limit reached on ${fromName} → continued on ${toName} (${toModel})`;
  }
  const fromDriverName = fromProvider
    ? (PROVIDER_DISPLAY_NAMES[fromProvider.driver] ?? fromName)
    : fromName;
  return `All ${fromDriverName} accounts reached usage limit → handed off to ${toName} (${toModel})`;
}

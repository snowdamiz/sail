import { msg, useMessages } from "gt-react";
import type { AgentFeedbackPreview, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, MinusIcon } from "lucide-react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { WorkLogRow } from "./WorkLog";

type FeedbackRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "feedback_request" }>;

const TITLE = msg("Feedback for the T3 team");

const KIND_LABELS: Record<AgentFeedbackPreview["kind"], string> = {
  bug: msg("Bug"),
  confusing: msg("Confusing"),
  missing_capability: msg("Missing capability"),
  wrong_docs: msg("Wrong docs"),
  other: msg("Other"),
};

const seconds = (ms: number) => `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;

export function FeedbackRequestCard(props: { readonly item: FeedbackRequestItem }) {
  const m = useMessages();
  const { item } = props;
  const Icon = item.feedbackStatus === "sent" ? CheckIcon : MinusIcon;
  const label =
    item.feedbackStatus === "sent"
      ? m(msg("Sent"))
      : item.feedbackStatus === "declined"
        ? m(msg("Not sent"))
        : m(msg("Closed without sending"));

  return (
    <Collapsible data-v2-item-type={item.type}>
      <CollapsibleTrigger
        render={
          <WorkLogRow
            icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
            label={
              <>
                {m(TITLE)} · {label}
              </>
            }
            trailing={<ChevronDownIcon className="size-3.5 text-icon-muted" aria-hidden />}
          />
        }
      />
      <CollapsiblePanel>
        <div className="pt-2 pb-1 pl-5">
          <FeedbackPreview preview={item.preview} />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function FeedbackPreview({ preview }: { readonly preview: AgentFeedbackPreview }) {
  const m = useMessages();
  const fields = [
    { label: m(msg("Kind")), value: m(KIND_LABELS[preview.kind]) },
    { label: m(msg("About")), value: preview.subject },
    { label: m(msg("Expected")), value: preview.expected },
    { label: m(msg("Happened")), value: preview.actual },
    { label: m(msg("Did instead")), value: preview.workaround },
  ].filter((field) => field.value !== "");

  const trace = preview.trace;
  const textSpan = (() => {
    if (trace === null) return 0;
    const withText = trace.entries.filter((entry) => entry.text !== undefined);
    return withText.length === 0
      ? 0
      : trace.turns - Math.min(...withText.map((entry) => entry.turn)) + 1;
  })();

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {fields.map((field) => (
          <div key={field.label} className="contents">
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 wrap-anywhere text-foreground">{field.value}</dd>
          </div>
        ))}
      </dl>
      {trace !== null ? (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className="size-3.5" aria-hidden />
            {m(
              msg(
                "Outline of {turns, plural, one {{turns} recent turn} other {{turns} recent turns}}, {textTurns, plural, =0 {no message text} one {message text of the last turn} other {message text of the last {textTurns} turns}}{truncated, select, yes {, shortened to fit} other {}}",
                {
                  turns: trace.turns,
                  textTurns: textSpan,
                  truncated: trace.truncated ? "yes" : "no",
                },
              ),
            )}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ol className="mt-2 flex max-h-80 min-w-0 flex-col gap-1 overflow-y-auto font-mono text-xs">
              {trace.entries.map((entry) => {
                const what =
                  entry.type === "tool"
                    ? [
                        entry.tool ?? "tool",
                        entry.outcome,
                        entry.durationMs === undefined ? undefined : seconds(entry.durationMs),
                      ]
                        .filter((part) => part !== undefined)
                        .join(" · ")
                    : m(
                        msg("{speaker} · {count} characters", {
                          speaker: m(entry.type === "user" ? msg("You") : msg("Agent")),
                          count: entry.length ?? 0,
                        }),
                      );
                return (
                  <li
                    key={`${entry.turn}-${entry.type}-${entry.tool ?? ""}-${entry.outcome ?? ""}-${entry.durationMs ?? ""}-${entry.length ?? ""}-${entry.text ?? ""}`}
                    className="min-w-0"
                  >
                    <span className="text-muted-foreground">
                      {m(msg("Turn {turn} · {what}", { turn: entry.turn, what }))}
                    </span>
                    {entry.text !== undefined ? (
                      <p className="mt-0.5 mb-1 whitespace-pre-wrap wrap-anywhere text-foreground">
                        {entry.text}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

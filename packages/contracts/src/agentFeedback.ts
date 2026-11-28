import * as Schema from "effect/Schema";

export const AgentFeedbackKind = Schema.Literals([
  "bug",
  "confusing",
  "missing_capability",
  "wrong_docs",
  "other",
]);

/** Built by the server from the thread's stored items; the agent never writes it. */
export const AgentFeedbackTrace = Schema.Struct({
  turns: Schema.Int,
  textTurns: Schema.Int,
  /** A cap dropped an entry or cut or dropped a message text. */
  truncated: Schema.Boolean,
  entries: Schema.Array(
    Schema.Struct({
      turn: Schema.Int,
      type: Schema.Literals(["user", "assistant", "tool"]),
      tool: Schema.optionalKey(Schema.String),
      outcome: Schema.optionalKey(Schema.Literals(["ok", "error", "unfinished"])),
      durationMs: Schema.optionalKey(Schema.Int),
      /** A message's length in characters. */
      length: Schema.optionalKey(Schema.Int),
      text: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type AgentFeedbackTrace = typeof AgentFeedbackTrace.Type;

/** Read-only schema retained for historical feedback_request turn items. */
export const AgentFeedbackPreview = Schema.Struct({
  kind: AgentFeedbackKind,
  subject: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
  workaround: Schema.String,
  trace: Schema.NullOr(AgentFeedbackTrace),
});
export type AgentFeedbackPreview = typeof AgentFeedbackPreview.Type;

export const AgentFeedbackRequestStatus = Schema.Literals([
  "pending",
  "sent",
  "declined",
  "cancelled",
]);
export type AgentFeedbackRequestStatus = typeof AgentFeedbackRequestStatus.Type;

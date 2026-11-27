import * as Schema from "effect/Schema";

import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "./auth.ts";

export const BoatDaemonPhase = Schema.Literals(["stopped", "starting", "ready", "error"]);
export type BoatDaemonPhase = typeof BoatDaemonPhase.Type;

export const BoatDaemonStatus = Schema.Struct({
  phase: BoatDaemonPhase,
  error: Schema.NullOr(Schema.String),
});
export type BoatDaemonStatus = typeof BoatDaemonStatus.Type;

/** `shutdown` and `quit_app` stay off the list: the server owns the daemon's lifetime. */
export const BoatCommand = Schema.Literals([
  "get_state",
  "local_projects",
  "latest_thread",
  "get_machine_details",
  "create_machine",
  "add_project",
  "wake_machine",
  "sleep_machine",
  "open_machine",
  "pair_machine",
  "delete_machine",
  "resize_machine",
  "keep_awake",
  "sign_in_agent",
  "manage_agent_sign_in",
  "manage_boat_sign_in",
  "sign_out_boat",
  "turn_on_connect",
  "update_settings",
  "setup_action",
  "add_mcp",
]);
export type BoatCommand = typeof BoatCommand.Type;

/**
 * Machine commands start, stop, and bill Boat sandboxes. `setup_action` installs the Boat CLI
 * with its own installer and `add_mcp` edits the agent CLIs' configs on this server's computer.
 */
export const BOAT_COMMAND_SCOPES = {
  get_state: AuthOrchestrationReadScope,
  local_projects: AuthOrchestrationReadScope,
  latest_thread: AuthOrchestrationReadScope,
  get_machine_details: AuthOrchestrationReadScope,
  create_machine: AuthOrchestrationOperateScope,
  add_project: AuthOrchestrationOperateScope,
  wake_machine: AuthOrchestrationOperateScope,
  sleep_machine: AuthOrchestrationOperateScope,
  open_machine: AuthOrchestrationOperateScope,
  pair_machine: AuthOrchestrationOperateScope,
  delete_machine: AuthOrchestrationOperateScope,
  resize_machine: AuthOrchestrationOperateScope,
  keep_awake: AuthOrchestrationOperateScope,
  sign_in_agent: AuthOrchestrationOperateScope,
  manage_agent_sign_in: AuthOrchestrationOperateScope,
  manage_boat_sign_in: AuthEnvironmentMaintainScope,
  sign_out_boat: AuthEnvironmentMaintainScope,
  turn_on_connect: AuthOrchestrationOperateScope,
  update_settings: AuthOrchestrationOperateScope,
  setup_action: AuthEnvironmentMaintainScope,
  add_mcp: AuthEnvironmentMaintainScope,
} as const satisfies Record<BoatCommand, AuthEnvironmentScope>;

/** `args` is the command's own argument object; the daemon parses it and refuses a bad one. */
export const BoatInvokeInput = Schema.Struct({
  command: BoatCommand,
  args: Schema.optional(Schema.Unknown),
});
export type BoatInvokeInput = typeof BoatInvokeInput.Type;

export const BoatSignInPhase = Schema.Literals([
  "pending",
  "complete",
  "cancelled",
  "expired",
  "failed",
]);
export type BoatSignInPhase = typeof BoatSignInPhase.Type;

export const BoatSignIn = Schema.Struct({
  attemptId: Schema.String,
  onHost: Schema.Boolean,
  prompt: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("browser"), url: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("device"), url: Schema.String, code: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("paste"), url: Schema.String }),
    ]),
  ),
});
export type BoatSignIn = typeof BoatSignIn.Type;

export type BoatSignInAction =
  | { readonly action: "status" | "cancel"; readonly attemptId: string }
  | { readonly action: "submit"; readonly attemptId: string; readonly code: string };

/** Sign-in prompts and pairing links are returned only to the invoking client. */
export const BoatInvokeResult = Schema.Struct({
  data: Schema.Unknown,
  openUrl: Schema.optional(Schema.String),
  signIn: Schema.optional(BoatSignIn),
});
export type BoatInvokeResult = typeof BoatInvokeResult.Type;

export const BoatEvent = Schema.Union([
  Schema.TaggedStruct("status", { status: BoatDaemonStatus }),
  Schema.TaggedStruct("state", { state: Schema.Unknown }),
]);
export type BoatEvent = typeof BoatEvent.Type;

/** Every client of the server shows it, so sail-boatd keeps links, codes, and Boat output out. */
export const BoatNotice = Schema.Struct({ title: Schema.String, body: Schema.String });
export type BoatNotice = typeof BoatNotice.Type;

export class BoatError extends Schema.TaggedError<BoatError>()("BoatError", {
  message: Schema.String,
}) {}

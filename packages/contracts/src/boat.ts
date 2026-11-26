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

/**
 * `openUrl` and `userCode` go only to the caller that sent the command: a pairing link carries a
 * one-time token, and a Boat sign-in code is the caller's own.
 */
export const BoatInvokeResult = Schema.Struct({
  data: Schema.Unknown,
  openUrl: Schema.optional(Schema.String),
  userCode: Schema.optional(Schema.String),
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

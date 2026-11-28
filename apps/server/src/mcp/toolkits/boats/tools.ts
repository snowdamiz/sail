import {
  EnvironmentId,
  ModelSelection,
  OrchestratorMcpFailure,
  ProjectId,
  SessionTransferDirection,
  SessionTransferId,
  SessionTransferPhase,
  SessionTransferPreflightResult,
  SessionTransferRecord,
  SessionTransferTarget,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as BoatSupervisor from "../../../boat/BoatSupervisor.ts";
import * as SessionTransferCoordinator from "../../../boat/SessionTransferCoordinator.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const BoatsReadTool = Tool.make("t3_boats_read", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [BoatSupervisor.BoatSupervisor],
  description:
    "Read this server's Boats state: Boat setup, cloud machines, and costs, as the Boats page shows them.",
  success: Schema.Struct({ state: Schema.Unknown }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SessionTransferAction = Schema.Literals([
  "transfer",
  "preflight",
  "status",
  "list",
  "cancel",
]);

const SessionTransferTool = Tool.make("t3_session_transfer", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SessionTransferCoordinator.SessionTransferCoordinator,
    ServerEnvironment.ServerEnvironment,
    Digest.Digest,
  ],
  description:
    "Transfer a thread between Local and a Boat machine (`local_to_boat` or `boat_to_local`), or inspect/cancel transfers. Pass `requestId` for idempotent retries.",
  parameters: Schema.Struct({
    action: Schema.optional(SessionTransferAction),
    direction: Schema.optional(SessionTransferDirection),
    sourceEnvironmentId: Schema.optional(EnvironmentId),
    sourceThreadId: Schema.optional(ThreadId),
    target: Schema.optional(SessionTransferTarget),
    targetProjectId: Schema.optional(ProjectId),
    cloneDestinationPath: Schema.optional(TrimmedNonEmptyString),
    modelSelectionOverride: Schema.optional(ModelSelection),
    autoResume: Schema.optional(Schema.Boolean),
    confirmedRunningPause: Schema.optional(Schema.Boolean),
    requestId: Schema.optional(TrimmedNonEmptyString),
    transferId: Schema.optional(SessionTransferId),
    activeOnly: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    transferId: Schema.optional(SessionTransferId),
    status: Schema.optional(SessionTransferPhase),
    transfer: Schema.optional(SessionTransferRecord),
    transfers: Schema.optional(Schema.Array(SessionTransferRecord)),
    preflight: Schema.optional(SessionTransferPreflightResult),
    replayed: Schema.optional(Schema.Boolean),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const BoatsToolkit = Toolkit.make(BoatsReadTool, SessionTransferTool);

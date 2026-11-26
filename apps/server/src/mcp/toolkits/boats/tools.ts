import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as BoatSupervisor from "../../../boat/BoatSupervisor.ts";

const BoatsStateTool = Tool.make("t3_boats_state", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [BoatSupervisor.BoatSupervisor],
  description:
    "Read this server's Boats state: Boat setup, cloud machines, and costs, as the Boats page shows them.",
  success: Schema.Struct({ state: Schema.Unknown }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const BoatsToolkit = Toolkit.make(BoatsStateTool);

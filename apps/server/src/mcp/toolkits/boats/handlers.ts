import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as BoatSupervisor from "../../../boat/BoatSupervisor.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BoatsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(BoatsToolkit, {
  t3_boats_state: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const boats = yield* BoatSupervisor.BoatSupervisor;
      const { data } = yield* boats.invoke({ command: "get_state" }).pipe(
        Effect.catchTags({
          BoatError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
        }),
      );
      return { state: data };
    }),
  ),
});

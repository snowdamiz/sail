import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isServerMaintenanceBusy, withAdmission } from "../serverAdmission.ts";

export const admitMcp =
  (lane: "root" | "continuation") =>
  <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      withAdmission(lane),
      Effect.catchIf(isServerMaintenanceBusy, (error) =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: error.message,
            retryable: true,
          }),
        ),
      ),
    );

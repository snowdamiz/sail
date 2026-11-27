import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";

import { ServerAdmission } from "../serverAdmission.ts";

export const observeNativeChild = Effect.fn("ServerAdmission.observeNativeChild")(function* (
  child: Pick<ChildProcessSpawner.ChildProcessHandle, "exitCode" | "isRunning">,
) {
  const admission = yield* ServerAdmission;
  if (admission === undefined) return;
  const release = admission.trackLifetime("native-child");
  yield* child.exitCode.pipe(
    Effect.ignore,
    // A stdin failure can reject exitCode before the process itself exits.
    Effect.andThen(
      child.isRunning.pipe(
        Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("100 millis") }),
      ),
    ),
    Effect.tap(() => Effect.sync(release)),
    Effect.forkDetach,
  );
}, Effect.uninterruptible);

import * as HostProcess from "@t3tools/shared/HostProcess";
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

// Install before the spawner's finalizer, so the census outlives bounded native cleanup.
export const trackNativeProcessGroup = Effect.fn("ServerAdmission.trackNativeProcessGroup")(
  function* () {
    const admission = yield* ServerAdmission;
    if (
      admission === undefined ||
      (yield* HostProcess.Platform) !== "linux" ||
      !(yield* admission.hasPermit)
    ) {
      return undefined;
    }
    let group: ChildProcessSpawner.ProcessId | undefined;
    let release: (() => void) | undefined;
    yield* Effect.addFinalizer(() => {
      const pid = group;
      const retire = release;
      if (pid === undefined || retire === undefined) return Effect.void;
      return Effect.sync(() => {
        try {
          process.kill(-pid, 0);
          return false;
        } catch (error) {
          return (
            typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
          );
        }
      }).pipe(
        Effect.repeat({ while: (gone) => !gone, schedule: Schedule.spaced("100 millis") }),
        Effect.tap(() => Effect.sync(retire)),
        Effect.forkDetach,
        Effect.asVoid,
      );
    });
    return (child: Pick<ChildProcessSpawner.ChildProcessHandle, "pid">) => {
      group = child.pid;
      release = admission.trackLifetime("native-child");
    };
  },
);

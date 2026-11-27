import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { acquireBoatCliAccess, BoatLifecycleBusy } from "./boatLifecycle.ts";

export class BoatCliAccessError extends Schema.TaggedError<BoatCliAccessError>()(
  "BoatCliAccessError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return this.cause instanceof BoatLifecycleBusy
      ? "The pinned Boat home is busy. Retry the same command."
      : "Could not establish ownership of the pinned Boat home. Check the Boat service and retry.";
  }
}

export const holdBoatCliAccess = (baseDir: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => acquireBoatCliAccess(baseDir),
      catch: (cause) => new BoatCliAccessError({ cause }),
    }),
    (release) => Effect.sync(release),
  ).pipe(Effect.asVoid);

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { acquireBoatCliMutation, BoatLifecycleBusy } from "./boatLifecycle.ts";

export class BoatCliMutationError extends Schema.TaggedError<BoatCliMutationError>()(
  "BoatCliMutationError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return this.cause instanceof BoatLifecycleBusy
      ? "The pinned Boat home is busy. Retry the same command."
      : "Could not establish ownership of the pinned Boat home. Check the Boat service and retry.";
  }
}

export const holdBoatCliMutation = (baseDir: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => acquireBoatCliMutation(baseDir),
      catch: (cause) => new BoatCliMutationError({ cause }),
    }),
    (release) => Effect.sync(release),
  ).pipe(Effect.asVoid);

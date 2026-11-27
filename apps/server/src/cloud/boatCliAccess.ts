import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { acquireBoatCliAccess, acquireBoatMutation, BoatLifecycleBusy } from "./boatLifecycle.ts";

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

const holdBoatAccess = (acquire: () => () => void) =>
  Effect.acquireRelease(
    Effect.try({
      try: acquire,
      catch: (cause) => new BoatCliAccessError({ cause }),
    }),
    (release) => Effect.sync(release),
  ).pipe(Effect.asVoid);

export const holdBoatCliAccess = (baseDir: string) =>
  holdBoatAccess(() => acquireBoatCliAccess(baseDir));

export const holdBoatMutation = (baseDir: string) =>
  holdBoatAccess(() => acquireBoatMutation(baseDir));

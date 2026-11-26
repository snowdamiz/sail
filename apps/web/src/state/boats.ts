import { createBoatsEnvironmentAtoms } from "@t3tools/client-runtime/state/boats";
import { BOAT_COMMAND_SCOPES, type BoatCommand, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";

export const boatsEnvironment = createBoatsEnvironmentAtoms(connectionAtomRuntime, {
  // The daemon writes the title and body, so they show as it wrote them.
  onNotify: ({ title, body }) => toastManager.add({ type: "info", title, description: body }),
});

const BOAT_COMMANDS = Object.keys(BOAT_COMMAND_SCOPES) as BoatCommand[];

/** The Boats commands this connection's grant covers on the environment. */
export const boatCommandsAllowedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get): ReadonlySet<BoatCommand> =>
      new Set(
        BOAT_COMMANDS.filter((command) =>
          get(boatsEnvironment.invoke.permissionAtom(environmentId, { command })),
        ),
      ),
  ),
);

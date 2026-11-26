import { createBoatsEnvironmentAtoms } from "@t3tools/client-runtime/state/boats";
import { BOAT_COMMAND_SCOPES, type BoatCommand, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const boatsEnvironment = createBoatsEnvironmentAtoms(connectionAtomRuntime);

const BOAT_COMMANDS = Object.keys(BOAT_COMMAND_SCOPES) as BoatCommand[];

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

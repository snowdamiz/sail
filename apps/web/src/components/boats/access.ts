import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import type { Action } from "./machine";
import type { CommandName } from "./types";

export interface BoatAccess {
  readonly environmentId: EnvironmentId | null;
  readonly can: (command: CommandName) => boolean;
  readonly isPaired: (environmentId: EnvironmentId | null) => boolean;
  // The daemon's pairing and thread links are http://localhost ones until W12.
  readonly onHost: boolean;
}

export const BoatAccessContext = createContext<BoatAccess>({
  environmentId: null,
  can: () => false,
  isPaired: () => false,
  onHost: false,
});

export function useBoatAccess(): BoatAccess {
  return useContext(BoatAccessContext);
}

const HOST_LINK_COMMANDS: ReadonlySet<CommandName> = new Set(["open_machine", "pair_machine"]);

export function offered<A extends Action>(access: BoatAccess, action: A | null): A | null {
  return action !== null && (access.onHost || !HOST_LINK_COMMANDS.has(action.cmd)) ? action : null;
}

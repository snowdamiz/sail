import { createContext, useContext } from "react";

import type { Action } from "./machine";
import type { CommandName } from "./types";

/** What this client may do with this server's Boats. */
export interface BoatAccess {
  /** The connection's grant covers the command. The server refuses it otherwise. */
  readonly can: (command: CommandName) => boolean;
  /** The daemon's pairing and thread links point at this server's localhost (until W12). */
  readonly onHost: boolean;
}

export const BoatAccessContext = createContext<BoatAccess>({ can: () => false, onHost: false });

export function useBoatAccess(): BoatAccess {
  return useContext(BoatAccessContext);
}

const HOST_LINK_COMMANDS: ReadonlySet<CommandName> = new Set(["open_machine", "pair_machine"]);

/** The action, unless its answer is a link only the server's host can open. */
export function offered<A extends Action>(access: BoatAccess, action: A | null): A | null {
  return action !== null && (access.onHost || !HOST_LINK_COMMANDS.has(action.cmd)) ? action : null;
}

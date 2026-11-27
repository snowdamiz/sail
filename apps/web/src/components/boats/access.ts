import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import type { CommandName } from "./types";

export interface BoatAccess {
  readonly environmentId: EnvironmentId | null;
  readonly can: (command: CommandName) => boolean;
  readonly isPaired: (environmentId: EnvironmentId | null) => boolean;
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

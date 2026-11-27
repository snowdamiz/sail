import { createBoatsEnvironmentAtoms } from "@t3tools/client-runtime/state/boats";
import { BOAT_COMMAND_SCOPES, type BoatCommand, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { clientHostEnvironmentAtom } from "./clientHostEnvironment";
import { clientPreferencesServerAtom } from "./clientPreferences";
import { peerLinkEnvironment } from "./peerLinks";
import { localEnvironmentIdAtom } from "./primaryEnvironment";

export const boatsEnvironment = createBoatsEnvironmentAtoms(connectionAtomRuntime);

export const boatServerSelectionAtom = Atom.make<EnvironmentId | null>(null).pipe(Atom.keepAlive);

export const boatServerChoicesAtom = Atom.make((get) =>
  Array.from(get(environmentCatalog.catalogValueAtom).entries.values()).filter(
    (entry) => entry.enabled && entry.unsupportedReason === undefined,
  ),
);

export const boatServerIdAtom = Atom.make((get) => {
  const servers = get(boatServerChoicesAtom);
  const selection = get(boatServerSelectionAtom);
  if (selection !== null && servers.some(({ target }) => target.environmentId === selection))
    return selection;
  const main = get(clientPreferencesServerAtom);
  if (main != null && servers.some(({ target }) => target.environmentId === main)) return main;
  const local = get(localEnvironmentIdAtom);
  if (local !== null && servers.some(({ target }) => target.environmentId === local)) return local;
  return servers.length === 1 ? (servers[0]?.target.environmentId ?? null) : null;
});

const BOAT_COMMANDS = Object.keys(BOAT_COMMAND_SCOPES) as BoatCommand[];

export const boatCommandsAllowedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get): ReadonlySet<BoatCommand> =>
      new Set(
        BOAT_COMMANDS.filter(
          (command) =>
            get(boatsEnvironment.invoke.permissionAtom(environmentId, { command })) &&
            (command !== "pair_machine" ||
              get(clientHostEnvironmentAtom(environmentId)) ||
              get(peerLinkEnvironment.pairClient.permissionAtom(environmentId))),
        ),
      ),
  ),
);

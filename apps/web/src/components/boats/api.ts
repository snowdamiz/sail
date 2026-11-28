import type { BoatsView } from "@t3tools/client-runtime/state/boats";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { boatsEnvironment } from "~/state/boats";
import { useEnvironmentQuery } from "~/state/query";
import { usePairFromLink } from "../desktop/DesktopWebLinkCoordinator";
import { useBoatAccess } from "./access";
import { type BoatLink, type BoatReply, classifyBoatLink, errorText } from "./reply";
import type { CommandArgs, CommandName, MachineDetails, UiState } from "./types";

export async function invokeBoat<C extends CommandName>(
  environmentId: EnvironmentId | null,
  command: C,
  args: CommandArgs<C>,
): Promise<BoatReply<C>> {
  if (environmentId === null) throw new Error(m(msg("This app is not connected to a server.")));
  const result = await runAtomCommand(
    appAtomRegistry,
    boatsEnvironment.invoke,
    { environmentId, input: args === undefined ? { command } : { command, args } },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value as BoatReply<C>;
}

export function useBoatCall() {
  const { environmentId } = useBoatAccess();
  return <C extends CommandName>(command: C, args: CommandArgs<C>) =>
    invokeBoat(environmentId, command, args);
}

export type BoatsPage =
  | { readonly kind: "noServer" }
  | { readonly kind: "starting" }
  | { readonly kind: "offline"; readonly message: string; readonly daemon: boolean }
  | { readonly kind: "setup" | "ready"; readonly state: UiState };

function boatsPage(view: BoatsView | null, error: string | null): BoatsPage {
  if (error !== null) return { kind: "offline", message: error, daemon: false };
  if (view?.status?.phase === "error") {
    return {
      kind: "offline",
      message: view.status.error ?? m(msg("Boat daemon error")),
      daemon: true,
    };
  }
  const state = (view?.state ?? null) as UiState | null;
  if (state === null) return { kind: "starting" };
  return state.setup === "ready" ? { kind: "ready", state } : { kind: "setup", state };
}

export function useBoatsPage(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : boatsEnvironment.view({ environmentId, input: {} }),
  );
  const page: BoatsPage =
    environmentId === null ? { kind: "noServer" } : boatsPage(query.data, query.error);
  const retry = () =>
    page.kind === "offline" && page.daemon
      ? invokeBoat(environmentId, "get_state", undefined).then(() => undefined)
      : Promise.resolve(query.refresh());
  return { page, retry };
}

export function useFollowBoatLink(onHost: boolean) {
  const router = useRouter();
  const pairFromLink = usePairFromLink();
  return (openUrl: string | undefined, expectedEnvironmentId?: EnvironmentId): BoatLink => {
    const link = classifyBoatLink(openUrl, onHost);
    switch (link.kind) {
      case "pairing":
        void pairFromLink(link.pairingUrl, expectedEnvironmentId);
        break;
      case "app":
        void router.navigate({ href: link.href });
        break;
      case "browser":
        void readLocalApi()
          ?.shell.openExternal(link.url)
          .catch(() => undefined);
        break;
      case "ignored":
        break;
    }
    return link;
  };
}

export function useMachineDetails(
  id: string,
  version: unknown,
  onError: (text: string) => void,
): MachineDetails | null {
  const { environmentId } = useBoatAccess();
  const [details, setDetails] = useState<MachineDetails | null>(null);
  const failing = useRef(false);
  const latest = useRef(0);
  const activeRequest = useRef<{
    environmentId: EnvironmentId | null;
    id: string;
    version: unknown;
  } | null>(null);
  const reportError = useEffectEvent(onError);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- advances request generation at commit time before passive cleanup runs
  useLayoutEffect(() => {
    activeRequest.current = { environmentId, id, version };
    return () => {
      activeRequest.current = null;
      latest.current += 1;
    };
  }, [environmentId, id, version]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads machine details from the boat RPC endpoint when inputs change
  useEffect(() => {
    let cancelled = false;
    const req = ++latest.current;
    if (version === undefined) return;
    void invokeBoat(environmentId, "get_machine_details", { id }).then(
      ({ data }) => {
        if (cancelled || req !== latest.current || activeRequest.current === null) return;
        failing.current = false;
        setDetails(data);
      },
      (e) => {
        if (
          cancelled ||
          req !== latest.current ||
          activeRequest.current === null ||
          failing.current
        ) {
          return;
        }
        failing.current = true;
        reportError(errorText(e));
      },
    );
    return () => {
      cancelled = true;
      latest.current += 1;
    };
  }, [environmentId, id, version]);

  return details?.id === id ? details : null;
}

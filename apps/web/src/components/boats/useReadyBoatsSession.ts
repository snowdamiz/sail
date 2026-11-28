import { RegistryContext } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { BoatSignIn, BoatSignInPhase } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { useContext, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "~/state/use-atom-command";
import { useBoatAccess } from "./access";
import { useBoatCall, type useFollowBoatLink } from "./api";
import type { Notify } from "./components/BoatsFrame";
import {
  deriveMachineControls,
  type ActionRequest,
  type DeleteRefusal,
  type MachineControls,
} from "./components/MachineActions";
import type { CreateMachineInput } from "./components/NewMachine";
import { useIsMountedRef } from "./components/common";
import {
  ACTIONS,
  isMachineOpenable,
  machineKey,
  useMachineBusyLabel,
  type Action,
  type PendingAction,
} from "./machine";
import { errorText } from "./reply";
import type { LocalProject, MachineView, McpClient, Settings, UiState } from "./types";

type FollowLink = ReturnType<typeof useFollowBoatLink>;
type EntryIntent = "overview" | "projectPicker";

type ReadyLocation =
  | { readonly kind: "list" }
  | { readonly kind: "new" }
  | { readonly kind: "settings" }
  | { readonly kind: "details"; readonly machineId: string; readonly entry: EntryIntent };

type ReadyView =
  | { readonly kind: "list" }
  | { readonly kind: "new" }
  | { readonly kind: "settings" }
  | { readonly kind: "details"; readonly machine: MachineView; readonly entry: EntryIntent };

interface PendingOperation {
  readonly requestId: symbol;
  readonly action: PendingAction;
  readonly label: string;
}

function resolveReadyView(location: ReadyLocation, state: UiState): ReadyView {
  if (location.kind !== "details") return location;
  const machine = state.machines.find((candidate) => candidate.id === location.machineId);
  if (machine === undefined || !isMachineOpenable(machine)) {
    return { kind: "list" };
  }
  return { kind: "details", machine, entry: location.entry };
}

export function useReadyBoatsSession({
  state,
  supportsLocalProjects,
  follow,
  notify,
}: {
  readonly state: UiState;
  readonly supportsLocalProjects: boolean;
  readonly follow: FollowLink;
  readonly notify: Notify;
}) {
  const access = useBoatAccess();
  const call = useBoatCall();
  const gt = useGT();
  const message = useMessages();
  const registry = useContext(RegistryContext);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  const [location, setLocation] = useState<ReadyLocation>({ kind: "list" });
  const [pending, setPending] = useState<ReadonlyMap<string, PendingOperation>>(() => new Map());
  const [refused, setRefused] = useState<ReadonlyMap<string, DeleteRefusal>>(() => new Map());
  const [signIn, setSignIn] = useState<{
    readonly machineId: string;
    readonly attempt: BoatSignIn;
  } | null>(null);

  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const startingSignInRef = useRef(false);
  const activeAttemptIdRef = useRef<string | null>(null);
  const mountedRef = useIsMountedRef();
  const busyLabelFor = useMachineBusyLabel();

  const view = resolveReadyView(location, state);
  if (location.kind === "details" && view.kind === "list") {
    setLocation({ kind: "list" });
  }

  const back = () => setLocation({ kind: "list" });

  const navigate = (next: Exclude<ReadyLocation, { kind: "details" }>) => {
    setLocation(next);
  };

  const navigateToMachine = (machine: MachineView, entry: EntryIntent) => {
    if (!isMachineOpenable(machine)) return;
    setLocation({ kind: "details", machineId: machine.id, entry });
  };

  const finishSignIn = (attemptId: string, phase: BoatSignInPhase) => {
    if (!mountedRef.current || activeAttemptIdRef.current !== attemptId) return;
    activeAttemptIdRef.current = null;
    setSignIn((current) => (current?.attempt.attemptId === attemptId ? null : current));
    if (phase === "expired") notify(gt("The sign-in expired. Start again to get a new code."));
    if (phase === "failed") notify(gt("Sign-in could not finish. Try again."));
  };

  const clearRefusal = (key: string) => {
    setRefused((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  };

  const dispatchAction = (target: MachineView, request: ActionRequest) => {
    const latest =
      (target.id ? state.machines.find((candidate) => candidate.id === target.id) : undefined) ??
      target;
    const key = machineKey(latest);
    if (inFlightKeysRef.current.has(key)) return;

    let action: Action;
    if (request.kind === "run") {
      action = request.action;
    } else if (request.kind === "confirmed") {
      action = request.deletion.action;
    } else {
      if (!refused.has(key)) return;
      action = ACTIONS.deleteAnyway;
    }

    if (!access.can(action.cmd)) return;

    const isSignIn = action.cmd === "sign_in_agent" || action.cmd === "turn_on_connect";
    if (isSignIn && (signIn !== null || startingSignInRef.current)) return;
    if (isSignIn) startingSignInRef.current = true;

    inFlightKeysRef.current.add(key);
    const requestId = Symbol(action.cmd);
    const label = busyLabelFor(action);
    setPending((current) => {
      const next = new Map(current);
      next.set(key, { requestId, action, label });
      return next;
    });

    const pairIfAsked = (openUrl: string | undefined) => {
      if (!mountedRef.current) return;
      if (follow(openUrl, latest.environmentId ?? undefined).kind === "pairing") {
        notify(gt('Accept "{name}" to pair it with Sail', { name: latest.name }), "info");
      }
    };

    const run = async () => {
      switch (action.cmd) {
        case "delete_machine":
          clearRefusal(key);
          try {
            await call("delete_machine", { id: latest.id, discard: action.discard });
          } catch (error) {
            if (action.discard) throw error;
            if (mountedRef.current) {
              setRefused((current) => {
                const next = new Map(current);
                next.set(key, { message: errorText(error) });
                return next;
              });
            }
          }
          return;
        case "sign_in_agent":
        case "turn_on_connect": {
          setLocation({ kind: "details", machineId: latest.id, entry: "overview" });
          const reply = await (
            action.cmd === "sign_in_agent"
              ? call(action.cmd, { id: latest.id, agent: action.agent })
              : call(action.cmd, { id: latest.id })
          ).finally(() => {
            startingSignInRef.current = false;
          });
          if (!mountedRef.current) return;
          if (reply.signIn === undefined) throw new Error(gt("Sign-in could not start."));
          activeAttemptIdRef.current = reply.signIn.attemptId;
          setSignIn({ machineId: latest.id, attempt: reply.signIn });
          if (reply.signIn.onHost) follow(reply.signIn.prompt?.url);
          return;
        }
        case "keep_awake":
          await call("keep_awake", { id: latest.id, minutes: action.minutes });
          return;
        case "resize_machine":
          await call("resize_machine", { id: latest.id, size: action.size });
          return;
        case "wake_machine":
          await call("wake_machine", { id: latest.id });
          if (!mountedRef.current) return;
          if (
            !access.onHost &&
            latest.environmentId !== null &&
            access.isPaired(latest.environmentId)
          ) {
            void retryNow(latest.environmentId);
          }
          return;
        case "open_machine": {
          if (!access.onHost && latest.state === "asleep") {
            await call("wake_machine", { id: latest.id });
            if (!mountedRef.current) return;
          }
          const { data: thread } = await call("latest_thread", { id: latest.id });
          if (!mountedRef.current) return;
          if (thread === null) {
            notify(message(msg("No thread available to open.")), "info");
            return;
          }
          const reply = await call("open_machine", { id: latest.id, thread });
          if (!mountedRef.current) return;
          pairIfAsked(reply.openUrl);
          return;
        }
        case "pair_machine": {
          const id = latest.environmentId;
          if (access.onHost && id !== null) {
            const entry = registry.get(environmentCatalog.catalogValueAtom).entries.get(id);
            if (entry?.enabled === false && entry.unsupportedReason === undefined) {
              const result = await setEnabled({ environmentId: id, enabled: true });
              if (!mountedRef.current) return;
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return;
            }
          }
          const reply = await call("pair_machine", { id: latest.id });
          if (!mountedRef.current) return;
          pairIfAsked(reply.openUrl);
          return;
        }
        default: {
          const reply = await call(action.cmd, { id: latest.id });
          if (!mountedRef.current) return;
          pairIfAsked(reply.openUrl);
        }
      }
    };

    void run()
      .catch((error) => {
        if (mountedRef.current) notify(`${latest.name}: ${errorText(error)}`);
      })
      .finally(() => {
        inFlightKeysRef.current.delete(key);
        if (!mountedRef.current) return;
        setPending((current) => {
          if (current.get(key)?.requestId !== requestId) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      });
  };

  const addProject = (machine: MachineView, project: LocalProject) => {
    if (!access.can("add_project") || !machine.id) return;
    const key = machineKey(machine);
    if (inFlightKeysRef.current.has(key)) return;
    inFlightKeysRef.current.add(key);
    const requestId = Symbol("add_project");
    setPending((current) => {
      const next = new Map(current);
      next.set(key, {
        requestId,
        action: { cmd: "add_project", projectId: project.id },
        label: gt("Adding project…"),
      });
      return next;
    });
    void call("add_project", { id: machine.id, projectId: project.id })
      .then(
        () => {
          if (mountedRef.current) {
            notify(
              gt("{project} is on {machine}", { project: project.title, machine: machine.name }),
              "info",
            );
          }
        },
        (error) => {
          if (mountedRef.current) {
            notify(
              gt("Couldn't add {project} to {machine}: {error}", {
                project: project.title,
                machine: machine.name,
                error: errorText(error),
              }),
            );
          }
        },
      )
      .finally(() => {
        inFlightKeysRef.current.delete(key);
        if (!mountedRef.current) return;
        setPending((current) => {
          if (current.get(key)?.requestId !== requestId) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      });
  };

  const controlsFor = (machine: MachineView): MachineControls => {
    const key = machineKey(machine);
    const pendingOp = pending.get(key) ?? null;
    const presentation = deriveMachineControls({
      machine,
      sizes: state.sizes,
      access,
      supportsLocalProjects,
      pending: pendingOp === null ? null : { action: pendingOp.action, label: pendingOp.label },
      deleteRefusal: refused.get(key) ?? null,
      signingIn: signIn !== null,
    });
    return {
      ...presentation,
      request: (request) => dispatchAction(machine, request),
      onDismissDeleteError: () => clearRefusal(key),
      onAddProject: (project) => addProject(machine, project),
    };
  };

  const canCreate = access.can("create_machine");

  const create = (input: CreateMachineInput) => {
    if (!canCreate) return;
    setLocation({ kind: "list" });
    void call("create_machine", {
      name: input.name,
      size: input.size,
      projects: input.projects,
    }).then(
      (reply) => {
        if (!mountedRef.current) return;
        follow(reply.openUrl);
      },
      (error) => {
        if (mountedRef.current) notify(errorText(error));
      },
    );
  };

  const saveSettings = (settings: Settings) =>
    call("update_settings", { settings }).then(
      () => undefined,
      (error) => {
        if (mountedRef.current) notify(errorText(error));
      },
    );

  const addMcp = (client: McpClient) =>
    call("add_mcp", { client }).then(
      () => undefined,
      (error) => {
        if (mountedRef.current) notify(errorText(error));
      },
    );

  const signOut = () =>
    call("sign_out_boat", undefined).then(
      () => undefined,
      (error) => {
        if (mountedRef.current) notify(errorText(error));
      },
    );

  return {
    view,
    back,
    navigate,
    navigateToMachine,
    controlsFor,
    signIn,
    finishSignIn,
    canCreate,
    create,
    saveSettings,
    addMcp,
    signOut,
  };
}

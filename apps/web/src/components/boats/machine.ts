import { ProjectId, type EnvironmentId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import { m } from "~/i18n/messages";
import type { MachineState, MachineView, Size } from "./types";

type StatusDotClassName = "bg-success" | "bg-warning" | "bg-destructive" | "bg-muted-foreground/40";

type StatusBadgeVariant = "success" | "warning" | "error" | "secondary" | "outline";

interface StatusPresentation {
  readonly label: ReturnType<typeof msg>;
  readonly dotClassName: StatusDotClassName;
  readonly badgeVariant: StatusBadgeVariant;
}

export const MACHINE_STATUS = {
  working: {
    label: msg("Working"),
    dotClassName: "bg-success",
    badgeVariant: "success",
  },
  idle: {
    label: msg("Idle"),
    dotClassName: "bg-success",
    badgeVariant: "success",
  },
  sleeping: {
    label: msg("Going to sleep"),
    dotClassName: "bg-warning",
    badgeVariant: "warning",
  },
  asleep: {
    label: msg("Asleep"),
    dotClassName: "bg-muted-foreground/40",
    badgeVariant: "secondary",
  },
  waking: {
    label: msg("Waking"),
    dotClassName: "bg-warning",
    badgeVariant: "warning",
  },
  creating: {
    label: msg("Creating"),
    dotClassName: "bg-warning",
    badgeVariant: "warning",
  },
  error: {
    label: msg("Error"),
    dotClassName: "bg-destructive",
    badgeVariant: "error",
  },
  missing: {
    label: msg("Missing"),
    dotClassName: "bg-destructive",
    badgeVariant: "error",
  },
  unknown: {
    label: msg("Unknown"),
    dotClassName: "bg-muted-foreground/40",
    badgeVariant: "outline",
  },
} satisfies Record<MachineState, StatusPresentation>;

export function managedBoatOriginProject(
  machines: readonly MachineView[],
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ProjectId | undefined {
  const matches = machines.filter((machine) => machine.environmentId === environmentId);
  if (matches.length !== 1) return undefined;
  const projects = matches[0]!.projects.filter((project) => project.id === projectId);
  const origin = projects.length === 1 ? projects[0]?.originProjectId : undefined;
  return typeof origin === "string" && origin.trim() !== "" ? ProjectId.make(origin) : undefined;
}

export const machineKey = (machine: MachineView) => machine.id || `new:${machine.name}`;

export const isMachineOpenable = (machine: MachineView) =>
  !!machine.id && machine.state !== "creating";

interface ActionMeta {
  readonly label: string;
  readonly busy: string;
  readonly solid?: boolean;
}

type SimpleMachineAction = ActionMeta & {
  readonly cmd:
    | "open_machine"
    | "pair_machine"
    | "wake_machine"
    | "sleep_machine"
    | "turn_on_connect";
};

export type ResizeMachineAction = ActionMeta & {
  readonly cmd: "resize_machine";
  readonly size: string;
};

export type KeepAwakeAction = ActionMeta & {
  readonly cmd: "keep_awake";
  readonly minutes: number | null;
};

type SignInAgentAction = ActionMeta & {
  readonly cmd: "sign_in_agent";
  readonly agent: string;
};

export type DeleteMachineAction =
  | (ActionMeta & { readonly cmd: "delete_machine"; readonly discard: true })
  | (ActionMeta & { readonly cmd: "delete_machine"; readonly discard: false });

export type NonDeleteAction =
  | SimpleMachineAction
  | ResizeMachineAction
  | KeepAwakeAction
  | SignInAgentAction;

export type Action = NonDeleteAction | DeleteMachineAction;

export type PendingAction = Action | { readonly cmd: "add_project"; readonly projectId: string };

const PICK_PROJECT = { kind: "pickProject", label: msg("Add a project…") } as const;

type MenuItem = NonDeleteAction | typeof PICK_PROJECT;

export const signInTo = (agent: string): SignInAgentAction => ({
  cmd: "sign_in_agent",
  label: m(msg("Sign in {agent}"), { agent }),
  busy: msg("Signing in…"),
  agent,
});

export const ACTIONS = {
  pair: { cmd: "pair_machine", label: msg("Add to Sail"), busy: msg("Sending…"), solid: true },
  repair: { cmd: "pair_machine", label: msg("Add to Sail again"), busy: msg("Sending…") },
  open: { cmd: "open_machine", label: msg("Open last thread in Sail"), busy: msg("Opening…") },
  wake: { cmd: "wake_machine", label: msg("Wake now"), busy: msg("Waking…") },
  retry: { cmd: "wake_machine", label: msg("Try waking"), busy: msg("Waking…") },
  sleep: { cmd: "sleep_machine", label: msg("Sleep now"), busy: msg("Sleeping…") },
  connect: { cmd: "turn_on_connect", label: msg("Turn on"), busy: msg("Approve in browser…") },
  remove: { cmd: "delete_machine", label: msg("Remove"), busy: msg("Removing…"), discard: true },
  del: { cmd: "delete_machine", label: msg("Delete"), busy: msg("Deleting…"), discard: false },
  deleteAnyway: {
    cmd: "delete_machine",
    label: msg("Delete anyway"),
    busy: msg("Deleting…"),
    discard: true,
  },
} as const satisfies Record<string, Action>;

export function primaryAction(machine: MachineView, paired: boolean): Action | null {
  switch (machine.state) {
    case "working":
    case "idle":
    case "asleep":
      return paired ? null : ACTIONS.pair;
    case "error":
      return ACTIONS.retry;
    case "missing":
      return ACTIONS.remove;
    default:
      return null;
  }
}

export function useMachineActionLabel() {
  const gt = useGT();
  const messages = useMessages();
  return (action: Action | typeof PICK_PROJECT) => {
    if ("kind" in action) return messages(action.label);
    switch (action.cmd) {
      case "resize_machine":
        return gt("Resize to {size}", { size: action.size });
      case "sign_in_agent":
        return gt("Sign in {agent}", { agent: action.agent });
      case "keep_awake":
        return action.minutes === null
          ? gt("Turn off auto sleep")
          : action.minutes === 0
            ? gt("Stop staying awake")
            : gt("Stay awake for {duration}", { duration: duration(action.minutes * 60) });
      default:
        return messages(action.label);
    }
  };
}

export function useMachineBusyLabel() {
  const messages = useMessages();
  return (action: Action) => messages(action.busy);
}

export const STAY_AWAKE = [15, 30, 60, 120] as const;

export const keepAwake = (minutes: number): KeepAwakeAction => ({
  cmd: "keep_awake",
  label: minutes
    ? m(msg("Stay awake for {duration}"), { duration: duration(minutes * 60) })
    : msg("Stop staying awake"),
  busy: minutes ? msg("Waking…") : msg("Stopping…"),
  minutes,
});

export const autoSleep = (on: boolean): KeepAwakeAction => ({
  cmd: "keep_awake",
  label: on ? msg("Turn on auto sleep") : msg("Turn off auto sleep"),
  busy: on ? msg("Turning on auto sleep…") : msg("Turning off auto sleep…"),
  minutes: on ? 0 : null,
});

export const resizeTo = (size: string): ResizeMachineAction => ({
  cmd: "resize_machine",
  label: m(msg("Resize to {size}"), { size }),
  busy: msg("Resizing…"),
  size,
});

export function menuActions(
  machine: MachineView,
  sizes: readonly Size[],
  paired: boolean,
): MenuItem[] {
  if (!machine.id || machine.state === "missing") return [];
  const out: MenuItem[] = [];
  if (machine.state === "asleep") out.push(ACTIONS.wake);
  if (machine.state === "working" || machine.state === "idle") out.push(ACTIONS.sleep);
  out.push(PICK_PROJECT);
  if (paired) out.push(ACTIONS.repair);
  sizes.filter((s) => s.id !== machine.size).forEach((s) => out.push(resizeTo(s.id)));
  return out;
}

export function powerAction(machine: MachineView): SimpleMachineAction | null {
  if (machine.state === "asleep") return ACTIONS.wake;
  if (machine.state === "working" || machine.state === "idle") return ACTIONS.sleep;
  return null;
}

export function resizeHint(machine: MachineView) {
  if (machine.state === "asleep") return msg("Applies on next wake");
  if (machine.state === "working" || machine.waiting) {
    return msg("Applies after it next sleeps, never mid-turn");
  }
  if (machine.state === "idle") return msg("Restarts onto the new size now");
  return msg("Billed only while awake");
}

export function duration(secs: number): string {
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return mins % 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins / 60}h`;
}

export function timeLeft(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.ceil(secs / 60);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export const homePath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

export const hasRepo = (machine: MachineView, repoKey: string) =>
  machine.projects.some((p) => p.repoKey === repoKey);

export const needsProject = (machine: MachineView, paired: boolean) =>
  paired && !machine.projects.length && !["creating", "missing", "error"].includes(machine.state);

export const shortDate = (unixSecs: number, locale?: string) =>
  new Date(unixSecs * 1000).toLocaleDateString(locale || undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

export const money = (n: number) => `$${n.toFixed(2)}`;
export const hourly = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}/h`;

export const sizeOf = (sizes: readonly Size[], id: string) => sizes.find((s) => s.id === id);

const NAMES = [
  "skiff",
  "dinghy",
  "sloop",
  "ketch",
  "yawl",
  "cutter",
  "dory",
  "schooner",
  "clipper",
  "catboat",
  "junk",
  "brig",
];

export function suggestName(taken: string[]): string {
  const used = new Set(taken);
  const free = NAMES.find((n) => !used.has(n));
  if (free) return free;
  for (let i = 2; ; i++) if (!used.has(`skiff-${i}`)) return `skiff-${i}`;
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function cleanName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}

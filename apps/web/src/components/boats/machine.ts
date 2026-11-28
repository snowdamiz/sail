import { ProjectId, type EnvironmentId } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import type { MachineState, MachineView, Size } from "./types";

export type StatusDotClassName =
  | "bg-success"
  | "bg-warning"
  | "bg-destructive"
  | "bg-muted-foreground/40";

export type StatusBadgeVariant = "success" | "warning" | "error" | "secondary" | "outline";

export interface StatusPresentation {
  readonly label: ReturnType<typeof msg>;
  readonly legacyTag: string;
  readonly dotClassName: StatusDotClassName;
  readonly badgeVariant: StatusBadgeVariant;
}

export const MACHINE_STATUS = {
  working: {
    label: msg("Working"),
    legacyTag: "working",
    dotClassName: "bg-success",
    badgeVariant: "success",
  },
  idle: {
    label: msg("Idle"),
    legacyTag: "idle",
    dotClassName: "bg-success",
    badgeVariant: "success",
  },
  sleeping: {
    label: msg("Going to sleep"),
    legacyTag: "dozing off",
    dotClassName: "bg-warning",
    badgeVariant: "warning",
  },
  asleep: {
    label: msg("Asleep"),
    legacyTag: "zzz",
    dotClassName: "bg-muted-foreground/40",
    badgeVariant: "secondary",
  },
  waking: {
    label: msg("Waking"),
    legacyTag: "waking",
    dotClassName: "bg-warning",
    badgeVariant: "warning",
  },
  creating: {
    label: msg("Creating"),
    legacyTag: "building",
    dotClassName: "bg-warning",
    badgeVariant: "warning",
  },
  error: {
    label: msg("Error"),
    legacyTag: "error",
    dotClassName: "bg-destructive",
    badgeVariant: "error",
  },
  missing: {
    label: msg("Missing"),
    legacyTag: "gone",
    dotClassName: "bg-destructive",
    badgeVariant: "error",
  },
  unknown: {
    label: msg("Unknown"),
    legacyTag: "…",
    dotClassName: "bg-muted-foreground/40",
    badgeVariant: "outline",
  },
} satisfies Record<MachineState, StatusPresentation>;

export const stateTag = (s: MachineState) => MACHINE_STATUS[s].legacyTag;

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

export const machineKey = (m: MachineView) => m.id || `new:${m.name}`;

export const isMachineOpenable = (m: MachineView) => !!m.id && m.state !== "creating";

export type Action = {
  label: string;
  busy: string;
  solid?: boolean;
} & (
  | { cmd: "open_machine" | "pair_machine" | "wake_machine" | "sleep_machine" | "turn_on_connect" }
  | { cmd: "resize_machine"; size: string }
  | { cmd: "keep_awake"; minutes: number | null }
  | { cmd: "sign_in_agent"; agent: string }
  | { cmd: "delete_machine"; discard: boolean }
);

const PICK_PROJECT = { kind: "pickProject", label: "Add a project…" } as const;

export type MenuItem = Action | typeof PICK_PROJECT;

export const signInTo = (agent: string): Action => ({
  cmd: "sign_in_agent",
  label: `Sign in ${agent}`,
  busy: "Signing in…",
  agent,
});

export const ACTIONS = {
  pair: { cmd: "pair_machine", label: "Add to Sail", busy: "Sending…", solid: true },
  repair: { cmd: "pair_machine", label: "Add to Sail again", busy: "Sending…" },
  open: { cmd: "open_machine", label: "Open last thread in Sail", busy: "Opening…" },
  wake: { cmd: "wake_machine", label: "Wake now", busy: "Waking…" },
  retry: { cmd: "wake_machine", label: "Try waking", busy: "Waking…" },
  sleep: { cmd: "sleep_machine", label: "Sleep now", busy: "Sleeping…" },
  connect: { cmd: "turn_on_connect", label: "Turn on", busy: "Approve in browser…" },
  remove: { cmd: "delete_machine", label: "Remove", busy: "Removing…", discard: true },
  del: { cmd: "delete_machine", label: "Delete", busy: "Deleting…", discard: false },
  deleteAnyway: { cmd: "delete_machine", label: "Delete anyway", busy: "Deleting…", discard: true },
} satisfies Record<string, Action>;

export function primaryAction(m: MachineView, paired: boolean): Action | null {
  switch (m.state) {
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
  return (action: MenuItem) => {
    switch (action.label) {
      case ACTIONS.pair.label:
        return gt("Add to Sail");
      case ACTIONS.repair.label:
        return gt("Add to Sail again");
      case ACTIONS.open.label:
        return gt("Open last thread in Sail");
      case ACTIONS.wake.label:
        return gt("Wake now");
      case ACTIONS.retry.label:
        return gt("Try waking");
      case ACTIONS.sleep.label:
        return gt("Sleep now");
      case ACTIONS.remove.label:
        return gt("Remove");
      case ACTIONS.connect.label:
        return gt("Turn on");
      case PICK_PROJECT.label:
        return gt("Add a project…");
      default:
        return action.label;
    }
  };
}

export const STAY_AWAKE = [15, 30, 60, 120] as const;

export const keepAwake = (minutes: number): Action => ({
  cmd: "keep_awake",
  label: minutes ? `Stay awake for ${duration(minutes * 60)}` : "Stop staying awake",
  busy: minutes ? "Waking…" : "Stopping…",
  minutes,
});

export const autoSleep = (on: boolean): Action => ({
  cmd: "keep_awake",
  label: on ? "Turn on auto sleep" : "Turn off auto sleep",
  busy: on ? "Turning on auto sleep…" : "Turning off auto sleep…",
  minutes: on ? 0 : null,
});

export const resizeTo = (size: string): Action => ({
  cmd: "resize_machine",
  label: `Resize to ${size}`,
  busy: "Resizing…",
  size,
});

export function menuActions(m: MachineView, sizes: readonly Size[], paired: boolean): MenuItem[] {
  if (!m.id || m.state === "missing") return [];
  const out: MenuItem[] = [];
  if (m.state === "asleep") out.push(ACTIONS.wake);
  if (m.state === "working" || m.state === "idle") out.push(ACTIONS.sleep);
  out.push(PICK_PROJECT);
  if (paired) out.push(ACTIONS.repair);
  sizes.filter((s) => s.id !== m.size).forEach((s) => out.push(resizeTo(s.id)));
  return out;
}

export function powerAction(m: MachineView): Action | null {
  if (m.state === "asleep") return ACTIONS.wake;
  if (m.state === "working" || m.state === "idle") return ACTIONS.sleep;
  return null;
}

export function resizeHint(m: MachineView): string {
  if (m.state === "asleep") return "Applies on next wake";
  if (m.state === "working" || m.waiting) return "Applies after it next sleeps, never mid-turn";
  if (m.state === "idle") return "Restarts onto the new size now";
  return "Billed only while awake";
}

export function duration(secs: number): string {
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}

export function timeLeft(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.ceil(secs / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const homePath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

export const hasRepo = (m: MachineView, repoKey: string) =>
  m.projects.some((p) => p.repoKey === repoKey);

export const needsProject = (m: MachineView, paired: boolean) =>
  paired && !m.projects.length && !["creating", "missing", "error"].includes(m.state);

export const shortDate = (unixSecs: number) =>
  new Date(unixSecs * 1000).toLocaleDateString("en-US", {
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

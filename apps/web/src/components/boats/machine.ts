import type { MachineState, MachineView, Size } from "./types";

const TAGS: Record<MachineState, string> = {
  working: "working",
  idle: "idle",
  sleeping: "dozing off",
  asleep: "zzz",
  waking: "waking",
  creating: "building",
  error: "error",
  missing: "gone",
  unknown: "…",
};

export const stateTag = (s: MachineState) => TAGS[s];

/** Stable key: creating rows have no id yet. */
export const machineKey = (m: MachineView) => m.id || `new:${m.name}`;

export function seedOf(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return (h >>> 0) / 4294967296;
}

/** A backend command for one machine, with the arguments it needs beyond the id. */
export type Action = {
  label: string;
  busy: string;
  /** solid button when primary; outline otherwise */
  solid?: boolean;
} & (
  | { cmd: "open_machine"; thread?: string }
  | { cmd: "pair_machine" | "wake_machine" | "sleep_machine" | "turn_on_connect" }
  | { cmd: "resize_machine"; size: string }
  /** null = until stopped (auto sleep off), 0 ends it */
  | { cmd: "keep_awake"; minutes: number | null }
  /** the agent's name as `signedOut` lists it */
  | { cmd: "sign_in_agent"; agent: string }
  /** discard: delete even while work runs on it */
  | { cmd: "delete_machine"; discard: boolean }
);

/** UI-only ⋯ menu entry: opens the project picker in the details view. */
export const PICK_PROJECT = { kind: "pickProject", label: "Add a project…" } as const;

export type MenuItem = Action | typeof PICK_PROJECT;

export const signInTo = (agent: string): Action => ({
  cmd: "sign_in_agent",
  label: `Sign in ${agent}`,
  busy: "Signing in…",
  agent,
});

export const ACTIONS = {
  pair: { cmd: "open_machine", label: "Add to Sail", busy: "Sending…", solid: true },
  repair: { cmd: "pair_machine", label: "Add to Sail again", busy: "Sending…" },
  wake: { cmd: "wake_machine", label: "Wake now", busy: "Waking…" },
  retry: { cmd: "wake_machine", label: "Try waking", busy: "Waking…" },
  sleep: { cmd: "sleep_machine", label: "Sleep now", busy: "Sleeping…" },
  connect: { cmd: "turn_on_connect", label: "Turn on", busy: "Approve in browser…" },
  remove: { cmd: "delete_machine", label: "Remove", busy: "Removing…", discard: true },
  del: { cmd: "delete_machine", label: "Delete", busy: "Deleting…", discard: false },
  deleteAnyway: { cmd: "delete_machine", label: "Delete anyway", busy: "Deleting…", discard: true },
} satisfies Record<string, Action>;

/** The one obvious thing to do with a machine right now, if any. */
export function primaryAction(m: MachineView): Action | null {
  switch (m.state) {
    case "working":
    case "idle":
    case "asleep": // wakes by itself when used in Sail; opening it lives in the details view
      return m.paired ? null : ACTIONS.pair;
    case "error":
      return ACTIONS.retry;
    case "missing":
      return ACTIONS.remove;
    default:
      return null; // transitional: the boat + detail line say what's happening
  }
}

/** Opens the machine's latest thread in Sail, named so the button says where it goes. */
export const openIn = (thread: string): Action => ({
  cmd: "open_machine",
  label: "Open last thread in Sail",
  busy: "Opening…",
  thread,
});

/** "Stay awake for…" choices, in minutes. */
export const STAY_AWAKE = [15, 30, 60, 120] as const;

/** A one-time "stay up at least this long"; 0 stops it early. */
export const keepAwake = (minutes: number): Action => ({
  cmd: "keep_awake",
  label: minutes ? `Stay awake for ${duration(minutes * 60)}` : "Stop staying awake",
  busy: minutes ? "Waking…" : "Stopping…",
  minutes,
});

/** The auto sleep switch: off keeps the machine up until it's turned back on. */
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

/** Secondary actions for the ⋯ menu (delete is always appended by the menu). */
export function menuActions(m: MachineView, sizes: Size[]): MenuItem[] {
  if (!m.id || m.state === "missing") return [];
  const out: MenuItem[] = [];
  if (m.state === "asleep") out.push(ACTIONS.wake);
  if (m.state === "working" || m.state === "idle") out.push(ACTIONS.sleep);
  out.push(PICK_PROJECT);
  if (m.paired) out.push(ACTIONS.repair);
  sizes.filter((s) => s.id !== m.size).forEach((s) => out.push(resizeTo(s.id)));
  return out;
}

/** Wake or sleep, whichever applies now; null mid-transition. */
export function powerAction(m: MachineView): Action | null {
  if (m.state === "asleep") return ACTIONS.wake;
  if (m.state === "working" || m.state === "idle") return ACTIONS.sleep;
  return null;
}

/** When a resize takes effect, per contract. */
export function resizeHint(m: MachineView): string {
  if (m.state === "asleep") return "Applies on next wake";
  if (m.state === "working" || m.waiting) return "Applies after it next sleeps, never mid-turn";
  if (m.state === "idle") return "Restarts onto the new size now";
  return "Billed only while awake";
}

/** "2h 14m", "2h", "38m", "0m" */
export function duration(secs: number): string {
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}

/** "42s", "4m", "1h 5m"; minutes round up. Matches the backend's `human_secs`. */
export function timeLeft(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.ceil(secs / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "/Users/you/Dev/app" → "~/Dev/app" */
export const homePath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

/** The machine has this repository, or is getting it. */
export const hasRepo = (m: MachineView, repoKey: string) =>
  m.projects.some((p) => p.repoKey === repoKey);

/** Up and added to Sail, but nothing to work on yet: the last step of setting it up. */
export const needsProject = (m: MachineView) =>
  m.paired && !m.projects.length && !["creating", "missing", "error"].includes(m.state);

export const shortDate = (unixSecs: number) =>
  new Date(unixSecs * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

export const money = (n: number) => `$${n.toFixed(2)}`;
export const hourly = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}/h`;

export const sizeOf = (sizes: Size[], id: string) => sizes.find((s) => s.id === id);

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

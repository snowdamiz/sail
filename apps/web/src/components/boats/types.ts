// Mirrors docs/ui-contract.md exactly.

export type Setup = "starting" | "ready" | "installBoat" | "signInBoat" | "installT3";

export type MachineState =
  | "working"
  | "idle"
  | "sleeping"
  | "asleep"
  | "waking"
  | "creating"
  | "error"
  | "missing"
  | "unknown";

export interface MachineView {
  id: string;
  name: string;
  size: string;
  state: MachineState;
  detail: string;
  countdown: Countdown | null; // set while `detail` counts down
  paired: boolean;
  signedOut: string[];
  projects: MachineProject[]; // its T3 projects as last seen (never wakes it), then those being added
  keepAwakeUntil: number | null; // when a "keep awake" runs out (unix ms); null when off or until stopped
  keepAwakeForever: boolean; // kept awake until someone stops it: no auto sleep
  waiting: boolean; // an agent there waits on the user: a resize waits for the next sleep
}

export interface MachineProject {
  id: string; // T3's project id on the machine; while t3boat adds it, the local project's id
  title: string;
  repoKey: string | null; // T3's repository key: the same repo has it on every machine
  status: string | null; // set while t3boat adds it: clone progress as T3 Code words it
}

/** A T3 Code project on this server that can go to a machine (it has a git remote). */
export interface LocalProject {
  id: string;
  title: string;
  path: string;
  repoKey: string;
  icon: string | null; // data: URL of the project's favicon in T3 Code
}

/** `detail` as `template` with `{left}` filled in: the time left until `endsAt` (unix ms). */
export interface Countdown {
  template: string;
  endsAt: number;
}

export interface Settings {
  startAtLogin: boolean;
}

export interface Size {
  id: string;
  spec: string;
  hourly: number;
}

export type McpClient = "claudeCode" | "codex";

export interface UiState {
  setup: Setup;
  setupBusy: boolean;
  account: { identifier: string | null; plan: string | null } | null;
  machines: MachineView[];
  costs: { today: number; month: number; startsToday: number; startsLimit: number };
  settings: Settings;
  sizes: Size[];
  /** null = that CLI isn't installed */
  mcp: Record<McpClient, boolean | null>;
}

export interface MachineDetails {
  id: string;
  costToday: number;
  costMonth: number;
  awakeSecsToday: number;
  agents: { name: string; signedIn: boolean }[];
  t3Version: string;
  createdAt: number; // unix secs
  /** T3 Connect is on: the user's other devices reach it with their T3 account */
  connect: boolean;
}

export type SetupAction = "installBoat" | "signInBoat" | "installT3" | "recheck";

export interface Commands {
  get_state: [undefined, UiState];
  create_machine: [{ name: string; size: string; projects?: string[] }, void]; // projects: LocalProject ids to add once up
  local_projects: [undefined, LocalProject[]]; // pinned first, then most recent
  add_project: [{ id: string; projectId: string }, void]; // resolves once cloned
  wake_machine: [{ id: string }, void];
  sleep_machine: [{ id: string }, void];
  open_machine: [{ id: string; thread?: string }, void];
  pair_machine: [{ id: string }, void];
  delete_machine: [{ id: string; discard?: boolean }, void];
  resize_machine: [{ id: string; size: string }, void];
  keep_awake: [{ id: string; minutes: number | null }, void]; // null: until stopped; 0: stop
  sign_in_agent: [{ id: string; agent: string }, void];
  turn_on_connect: [{ id: string }, void]; // resolves once reachable, after the browser sign-in
  latest_thread: [{ id: string }, string | null]; // thread id
  get_machine_details: [{ id: string }, MachineDetails];
  add_mcp: [{ client: McpClient }, void];
  update_settings: [{ settings: Settings }, void];
  setup_action: [{ action: SetupAction }, void];
}

export type CommandName = keyof Commands;
export type CommandArgs<C extends CommandName> = Commands[C][0];
export type CommandResult<C extends CommandName> = Commands[C][1];

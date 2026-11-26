// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off extendsNativeError:off - A plain Node stand-in for the Boat CLI, run by path from its `boat` shim.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  AUTH_HOST,
  authLogPath,
  DOMAIN,
  ensureCaddy,
  publicUrl,
  publishSite,
  removeSite,
} from "../lib/caddy.ts";
import {
  docker,
  DockerError,
  dockerSucceeds,
  ensureNetwork,
  exists,
  FIXTURE_LABEL,
  inspect,
  NETWORK,
} from "../lib/docker.ts";
import {
  createJsonExclusive,
  homeId,
  logCall,
  readJson,
  standInHome,
  writeJsonAtomic,
} from "../lib/state.ts";
import {
  type DeviceCode,
  FAKE_IDENTITY,
  issueDeviceCode,
  waitForApproval,
} from "./sandbox/auth.ts";
import { type CommandSpec, type Invocation, parse, UsageError } from "./sandbox/cli.ts";
import { type Match, outbox, type SnapshotFailure, WORKER_ARG } from "./outbox-worker.ts";
import {
  AUTH_LOG,
  AUTH_ORIGIN_FILE,
  DEADLINE_FILE,
  ID_FILE,
  OUTBOX_DIR,
  READONLY_DIR,
  SNAPSHOT_NAME,
} from "./sandbox/outbox.ts";

const HERE = import.meta.dirname;
const IMAGE_REPOSITORY = "sail-fake-boat-sandbox";
const SNAPSHOT_REPO = "sail-fake-boat-snapshot";
const HOME_LABEL = `${FIXTURE_LABEL}.home`;
/** Boat's longest lifetime on a free trial (`native/sail-boat/src/boat.rs`). */
const TRIAL_TTL_SECS = 7200;
const STARTS_PER_DAY = 100;
const BOOT_TIMEOUT_MS = 120_000;
const DEFAULT_EXEC_TIMEOUT_SECS = 300;
/** Boat deletes a stopped sandbox's disk after 14 days. */
const DISK_TTL_SECS = 14 * 24 * 3600;
/** Memory caps that fit several sandboxes in an 8 GB Docker VM. */
const SIZES = { small: "1g", default: "1536m", large: "2g" } as const;
const SANDBOX_ID = /^bx-[0-9a-f]{12}$/;
const REMOTE_PATH = /^(bx-[0-9a-f]{12}):(.+)$/;

type Size = keyof typeof SIZES;
type Plan = "paid" | "trial";
type State = "running" | "stopped" | "starting" | "stopping";

class BoatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface AccountRecord {
  readonly identifier: string;
  readonly plan: Plan;
  readonly signedInAt: string;
}

interface SandboxRecord {
  readonly id: string;
  readonly name: string;
  readonly type: Size;
  readonly createdAt: string;
  readonly ttlSeconds: number | null;
  /** The lifetime's end as of the last start or extend. Reported only while running. */
  readonly archiveAfter: string | null;
}

interface SnapshotRecord {
  readonly name: string;
  readonly sandboxId: string;
  readonly createdAt: string;
  /** What `new --from` runs, so a later commit under the same tag never changes it. */
  readonly imageId: string;
}

interface DockerState {
  readonly Status: string;
  readonly StartedAt: string;
  readonly FinishedAt: string;
}

interface Live {
  readonly state: State;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** `paused` is a running sandbox mid-`docker commit`. */
const STATES: Readonly<Record<string, State>> = {
  running: "running",
  paused: "running",
  restarting: "starting",
  removing: "stopping",
  created: "stopped",
  exited: "stopped",
  dead: "stopped",
};

const HOME = standInHome("boat", "FAKE_BOAT_HOME");
const HOME_ID = homeId(HOME);
const at = (...parts: ReadonlyArray<string>) => NodePath.join(HOME, ...parts);
const ACCOUNT_FILE = at("account.json");
const SIGN_INS = at("sign-ins");
const now = () => new Date().toISOString();
const container = (id: string) => `sail-boat-${id}`;
const siteId = (id: string, port: number) => `boat-${id}-${port}`;
const snapshotTag = (name: string) => `${SNAPSHOT_REPO}:${HOME_ID}-${name}`;
const sandboxFile = (id: string) => at("sandboxes", `${id}.json`);
const snapshotFile = (name: string) => at("snapshots", `${name}.json`);
const signInFile = (code: string) => NodePath.join(SIGN_INS, `${code}.json`);
const readonlyDir = (id: string) => at("readonly", id);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (value: unknown) => console.log(JSON.stringify(value));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNoSuch(error: unknown): boolean {
  return error instanceof DockerError && /no such (object|container|image)/i.test(error.stderr);
}

function listDir(dir: string): ReadonlyArray<string> {
  try {
    return NodeFS.readdirSync(dir);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

function records<T>(dir: string): ReadonlyArray<T> {
  return listDir(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => readJson<T>(NodePath.join(dir, file)) ?? []);
}

function integer(value: string | true | undefined, name: string, min = 0, max = 2 ** 53): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) {
    throw new BoatError("invalid_arguments", `${name} needs a whole number from ${min}`);
  }
  return parsed;
}

function text(value: string | true | undefined, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BoatError("invalid_arguments", `${name} is required`);
  }
  return value;
}

function size(value: string | true | undefined): Size {
  const type = text(value, "--type");
  if (!(type in SIZES)) throw new BoatError("invalid_type", `Unknown sandbox type ${type}`);
  return type as Size;
}

function snapshotName(name: string | undefined): string {
  if (!name || !SNAPSHOT_NAME.test(name)) {
    throw new BoatError("invalid_name", "Use lowercase letters, digits and dashes");
  }
  return name;
}

function diskTtlSeconds(): number {
  const raw = process.env.FAKE_BOAT_DISK_TTL_SECS;
  if (raw === undefined || raw === "") return DISK_TTL_SECS;
  if (!/^\d+$/.test(raw)) {
    throw new BoatError(
      "invalid_arguments",
      `FAKE_BOAT_DISK_TTL_SECS must be whole seconds, got ${raw}`,
    );
  }
  return Number(raw);
}

function trialRefusal(): BoatError {
  return new BoatError("trial_auto_stop_required", "Set a TTL of 2 hours or less");
}

function lifetime(invocation: Inv, plan: Plan): { ttlSeconds: number | null } | undefined {
  const noAutoStop = invocation.flags.has("no-auto-stop");
  const ttl = invocation.flags.get("ttl");
  if (noAutoStop && ttl !== undefined) {
    throw new BoatError("invalid_arguments", "--no-auto-stop and --ttl conflict");
  }
  if (noAutoStop) {
    if (plan === "trial") throw trialRefusal();
    return { ttlSeconds: null };
  }
  if (ttl === undefined) return undefined;
  const seconds = integer(ttl, "--ttl", 1);
  if (plan === "trial" && seconds > TRIAL_TTL_SECS) throw trialRefusal();
  return { ttlSeconds: seconds };
}

function deadline(ttlSeconds: number | null): string | null {
  return ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function account(): AccountRecord | undefined {
  return readJson<AccountRecord>(ACCOUNT_FILE);
}

function plan(): Plan {
  const value = process.env.FAKE_BOAT_PLAN ?? "paid";
  if (value !== "paid" && value !== "trial") {
    throw new BoatError("invalid_arguments", `FAKE_BOAT_PLAN must be paid or trial, got ${value}`);
  }
  return value;
}

/** The newest attempt; a logout or a fresh code removes the older ones. */
function currentSignIn(): DeviceCode | undefined {
  return records<DeviceCode>(SIGN_INS).toSorted((a, b) => b.issuedAtMs - a.issuedAtMs)[0];
}

/** True for exactly one caller, so an attempt signs in at most once and never after a logout. */
function claimFile(path: string): boolean {
  const claimed = `${path}.claimed-${process.pid}`;
  try {
    NodeFS.renameSync(path, claimed);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  NodeFS.rmSync(claimed, { force: true });
  return true;
}

/** Caddy's sign-in origin, with its port, for the sandbox's own CLIs to print. */
function authOrigin(): string {
  try {
    return publicUrl(AUTH_HOST);
  } catch (error) {
    if (!(error instanceof DockerError)) throw error;
  }
  ensureCaddy();
  return publicUrl(AUTH_HOST);
}

function sandboxRecord(id: string | undefined): SandboxRecord {
  const record = id && SANDBOX_ID.test(id) ? readJson<SandboxRecord>(sandboxFile(id)) : undefined;
  if (!record) throw new BoatError("not_found", `Sandbox ${id ?? ""} not found`);
  return record;
}

function sandboxRecords(): ReadonlyArray<SandboxRecord> {
  return records<SandboxRecord>(at("sandboxes")).toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

function snapshotRecord(name: string): SnapshotRecord {
  const record = readJson<SnapshotRecord>(snapshotFile(name));
  if (!record) throw new BoatError("not_found", `Snapshot ${name} not found`);
  return record;
}

function live(id: string): Live | null {
  try {
    const state = inspect<DockerState>(container(id), ".State");
    return {
      state: STATES[state.Status] ?? "stopped",
      startedAt: new Date(state.StartedAt).toISOString(),
      finishedAt: new Date(state.FinishedAt).toISOString(),
    };
  } catch (error) {
    if (isNoSuch(error)) return null;
    throw error;
  }
}

function requireLive(record: SandboxRecord): Live {
  const state = live(record.id);
  if (!state) throw new BoatError("not_found", `Sandbox ${record.id} not found`);
  return state;
}

const PAUSE_WAIT_MS = 60_000;

function isPaused(id: string): boolean {
  try {
    return inspect<boolean>(container(id), ".State.Paused");
  } catch {
    return false;
  }
}

/** `docker commit` pauses a sandbox so its snapshot is consistent; a call waits that out. */
function requireRunning(record: SandboxRecord): Live {
  for (let waited = 0; waited < PAUSE_WAIT_MS && isPaused(record.id); waited += 200) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  const state = requireLive(record);
  if (state.state !== "running") {
    throw new BoatError("sandbox_not_running", `Sandbox ${record.id} is ${state.state}`);
  }
  return state;
}

function view(record: SandboxRecord, state: Live) {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    state: state.state,
    createdAt: record.createdAt,
    stoppedAt: state.state === "stopped" ? state.finishedAt : null,
    archiveAfter: state.state === "running" ? record.archiveAfter : null,
    ttlSeconds: record.ttlSeconds,
  };
}

function contextHash(): string {
  const hash = NodeCrypto.createHash("sha256");
  const files = listDir(NodePath.join(HERE, "sandbox")).map((file) => `sandbox/${file}`);
  for (const file of ["sandbox.Dockerfile", ...files.toSorted()]) {
    hash.update(file).update(NodeFS.readFileSync(NodePath.join(HERE, file)));
  }
  return hash.digest("hex").slice(0, 16);
}

function sandboxImage(): string {
  const named = process.env.FAKE_BOAT_IMAGE;
  if (named) {
    if (!exists("image", named)) {
      throw new BoatError("image_missing", `FAKE_BOAT_IMAGE names ${named}, which is not built`);
    }
    return named;
  }
  const image = `${IMAGE_REPOSITORY}:${contextHash()}`;
  if (!exists("image", image)) {
    print({ progress: "building", image });
    docker(
      [
        "build",
        "--label",
        `${FIXTURE_LABEL}=boat-image`,
        "--tag",
        image,
        "--file",
        NodePath.join(HERE, "sandbox.Dockerfile"),
        HERE,
      ],
      { timeoutMs: 20 * 60_000 },
    );
  }
  return image;
}

/** The directories a sandbox mounts: its outbox, which it writes, and one it only reads. */
function prepareMounts(id: string): void {
  const requests = OUTBOX.dir(id);
  NodeFS.mkdirSync(requests, { recursive: true });
  // The sandbox writes as uid 1000, whatever uid owns this directory (CI runners use 1001).
  NodeFS.chmodSync(requests, 0o777);
  NodeFS.writeFileSync(NodePath.join(requests, ID_FILE), id);
  NodeFS.mkdirSync(readonlyDir(id), { recursive: true });
  writeAuthOrigin(id);
}

function writeAuthOrigin(id: string): void {
  writeJsonAtomic(NodePath.join(readonlyDir(id), AUTH_ORIGIN_FILE), authOrigin());
}

/** The sandbox powers itself off at this time (`sandbox/lifetime.sh`), as Boat stops it. */
function setDeadline(id: string, archiveAfter: string | null): void {
  const file = NodePath.join(readonlyDir(id), DEADLINE_FILE);
  if (archiveAfter === null) NodeFS.rmSync(file, { force: true });
  else writeJsonAtomic(file, Math.ceil(Date.parse(archiveAfter) / 1000));
}

function resize(id: string, type: Size): void {
  const memory = SIZES[type];
  docker(["update", "--memory", memory, "--memory-swap", memory, container(id)]);
}

function runContainer(record: SandboxRecord, image: string): void {
  const memory = SIZES[record.type];
  ensureNetwork();
  docker([
    "run",
    "--detach",
    "--name",
    container(record.id),
    "--hostname",
    record.id,
    "--privileged",
    "--cgroupns=private",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "--stop-signal",
    "SIGRTMIN+3",
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--label",
    `${FIXTURE_LABEL}=boat-sandbox`,
    "--label",
    `${FIXTURE_LABEL}.boat-sandbox=${record.id}`,
    "--label",
    `${HOME_LABEL}=${HOME_ID}`,
    "--network",
    NETWORK,
    "--volume",
    `${OUTBOX.dir(record.id)}:${OUTBOX_DIR}`,
    "--volume",
    `${readonlyDir(record.id)}:${READONLY_DIR}:ro`,
    "--volume",
    `${authLogPath()}:${AUTH_LOG}:ro`,
    image,
  ]);
}

/** Until PID 1 and `user`'s manager both answer, so the next exec can run `systemctl --user`. */
async function waitForBoot(id: string): Promise<void> {
  const give = Date.now() + BOOT_TIMEOUT_MS;
  const managers = [[], ["-u", "user", "-e", "XDG_RUNTIME_DIR=/run/user/1000"]];
  for (const as of managers) {
    for (;;) {
      const scope = as.length === 0 ? [] : ["--user"];
      const check = NodeChildProcess.spawnSync(
        "docker",
        ["exec", ...as, container(id), "systemctl", ...scope, "is-system-running", "--wait"],
        { encoding: "utf8", timeout: 30_000 },
      );
      const said = (check.stdout ?? "").trim();
      if (said === "running" || said === "degraded") break;
      if (Date.now() > give || /is not running/.test(check.stderr ?? "")) {
        throw new BoatError("boot_failed", `Sandbox ${id} did not boot: ${said || check.stderr}`);
      }
      await sleep(200);
    }
  }
}

function recordStart(id: string): void {
  NodeFS.appendFileSync(at("starts.jsonl"), `${JSON.stringify({ time: now(), sandboxId: id })}\n`);
}

function hostedPorts(id: string): ReadonlyArray<number> {
  return listDir(at("hosts", id)).map(Number);
}

function removeSandbox(id: string): void {
  try {
    docker(["rm", "--force", "--volumes", container(id)]);
  } catch (error) {
    if (!isNoSuch(error)) throw error;
  }
  for (const port of hostedPorts(id)) removeSite(siteId(id, port));
  for (const path of [at("hosts", id), OUTBOX.dir(id), readonlyDir(id), sandboxFile(id)]) {
    NodeFS.rmSync(path, { recursive: true, force: true });
  }
}

function commitSnapshot(sandboxId: string, name: string): void {
  const previous = readJson<SnapshotRecord>(snapshotFile(name))?.imageId;
  const imageId = docker(
    [
      "commit",
      "--change",
      `LABEL ${FIXTURE_LABEL}=boat-snapshot`,
      "--change",
      `LABEL ${HOME_LABEL}=${HOME_ID}`,
      container(sandboxId),
      snapshotTag(name),
    ],
    { timeoutMs: 10 * 60_000 },
  ).trim();
  writeJsonAtomic(snapshotFile(name), { name, sandboxId, createdAt: now(), imageId });
  if (!previous || previous === imageId) return;
  try {
    docker(["image", "rm", previous]);
  } catch (error) {
    // A sandbox created from the old snapshot still uses its image.
    if (!(error instanceof DockerError)) throw error;
  }
}

function snapshotRecords(): ReadonlyArray<SnapshotRecord> {
  return records<SnapshotRecord>(at("snapshots")).toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

const OUTBOX = outbox({
  home: HOME,
  entry: import.meta.filename,
  save: (sandboxId, name) => {
    if (!exists("container", container(sandboxId))) {
      throw new Error(`sandbox ${sandboxId} no longer exists`);
    }
    commitSnapshot(sandboxId, name);
  },
});

function reportFailures(failures: ReadonlyArray<SnapshotFailure>): void {
  for (const failure of failures) {
    console.error(JSON.stringify({ code: "snapshot_failed", ...failure }));
  }
}

function settleBudgetMs(defaultMs: number): number {
  const raw = process.env.FAKE_BOAT_SETTLE_SECS;
  if (raw === undefined || raw === "") return defaultMs;
  return integer(raw, "FAKE_BOAT_SETTLE_SECS", 0, 3600) * 1000;
}

/** Waits out the saves a sandbox asked for that `match` covers, which the real Boat finished before replying. */
async function settled(match: Match, defaultBudgetMs: number): Promise<void> {
  if (!(await OUTBOX.settle(match, settleBudgetMs(defaultBudgetMs)))) {
    throw new BoatError(
      "snapshot_in_progress",
      "A snapshot the sandbox asked for is still saving. Try again shortly.",
    );
  }
  reportFailures(OUTBOX.failures(match));
}

async function settledSnapshot(
  name: string | undefined,
  budgetMs = 100_000,
): Promise<SnapshotRecord> {
  const valid = snapshotName(name);
  await settled({ name: valid }, budgetMs);
  return snapshotRecord(valid);
}

interface Ran {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function run(
  args: ReadonlyArray<string>,
  options: { readonly input?: Buffer; readonly killAfterMs?: number } = {},
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = options.killAfterMs
      ? setTimeout(() => child.kill("SIGKILL"), options.killAfterMs)
      : undefined;
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

const REFUSED_PAUSED =
  /^Error response from daemon: container \S+ is paused, unpause the container before exec\s*$/i;

/** Short enough that a retried call still ends inside Sail Boat's own timeout for it. */
const PAUSE_RETRY_MS = 20_000;

/**
 * A commit can pause the sandbox between `requireRunning` and the `docker exec`, and Docker then
 * refuses before the guest runs anything, so the exec is retried until the pause ends.
 */
async function execUnpaused(
  args: ReadonlyArray<string>,
  options: { readonly input?: Buffer; readonly killAfterMs?: number } = {},
): Promise<Ran> {
  const give = Date.now() + PAUSE_RETRY_MS;
  for (;;) {
    const ran = await run(args, options);
    if (ran.status === 0 || !REFUSED_PAUSED.test(ran.stderr.toString()) || Date.now() >= give)
      return ran;
    await sleep(200);
  }
}

function remotePath(path: string): string {
  return path.startsWith("/") ? path : `/home/user/${path}`;
}

async function upload(local: string, id: string, remote: string): Promise<void> {
  requireRunning(sandboxRecord(id));
  const stat = NodeFS.statSync(local);
  if (!stat.isFile()) throw new BoatError("invalid_arguments", `${local} is not a file`);
  const script = 'd=$1; [ -d "$d" ] && d="$d/$2"; cat > "$d" && chmod "$3" "$d"';
  const mode = (stat.mode & 0o777).toString(8);
  const copied = await execUnpaused(
    [
      "exec",
      "-i",
      "-u",
      "user",
      "-w",
      "/home/user",
      container(id),
      "sh",
      "-c",
      script,
      "sh",
      remotePath(remote),
      NodePath.basename(local),
      mode,
    ],
    { input: NodeFS.readFileSync(local) },
  );
  if (copied.status !== 0) throw new BoatError("scp_failed", copied.stderr.toString().trim());
}

async function download(id: string, remote: string, local: string): Promise<void> {
  requireRunning(sandboxRecord(id));
  const copied = await execUnpaused([
    "exec",
    "-u",
    "user",
    container(id),
    "cat",
    "--",
    remotePath(remote),
  ]);
  if (copied.status !== 0) throw new BoatError("scp_failed", copied.stderr.toString().trim());
  const isDir = NodeFS.existsSync(local) && NodeFS.statSync(local).isDirectory();
  NodeFS.writeFileSync(
    isDir ? NodePath.join(local, NodePath.basename(remote)) : local,
    copied.stdout,
  );
}

function listen(server: NodeNet.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(new BoatError("port_in_use", `Port ${port} is in use on this computer`)),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
}

/** One `docker exec` per connection, ended with it so none outlives the connection it carried. */
function pipeInto(
  id: string,
  remote: number,
  socket: NodeNet.Socket,
): NodeChildProcess.ChildProcess {
  const pipe = NodeChildProcess.spawn(
    "docker",
    ["exec", "-i", container(id), "socat", "-", `TCP:127.0.0.1:${remote}`],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  socket.pipe(pipe.stdin);
  pipe.stdout.pipe(socket);
  pipe.stdin.on("error", () => {});
  pipe.on("error", () => socket.destroy());
  socket.on("error", () => socket.destroy());
  // Ending stdin lets socat flush what the client sent; the kill only catches a pipe that hangs.
  socket.on("close", () => {
    pipe.stdin.end();
    setTimeout(() => pipe.kill(), 2000).unref();
  });
  pipe.on("close", () => socket.end());
  return pipe;
}

type Inv = Invocation<Command>;

type Command = CommandSpec & {
  readonly mutating: boolean;
  /** Everything prints JSON, which the fake requires `--json` for, except `forward`. */
  readonly prints: "json" | "nothing";
} & (
    | { readonly signedIn: false; readonly run: (invocation: Inv) => Promise<number> }
    | {
        readonly signedIn: true;
        readonly run: (invocation: Inv, account: AccountRecord) => Promise<number>;
      }
  );

const TABLE: ReadonlyArray<Command> = [
  {
    path: ["status"],
    mutating: false,
    prints: "json",
    signedIn: false,
    run: async () => {
      const signedIn = account();
      print({
        account: signedIn
          ? { identifier: signedIn.identifier, signedIn: true, plan: signedIn.plan }
          : { identifier: null, signedIn: false, plan: null },
      });
      return 0;
    },
  },
  {
    path: ["onboard"],
    flags: { wait: "boolean" },
    mutating: true,
    prints: "json",
    signedIn: false,
    run: async (invocation) => {
      const pending = currentSignIn();
      if (invocation.flags.has("wait")) {
        if (!pending) {
          if (account()) return (print({}), 0);
          throw new BoatError("sign_in_not_started", "No sign-in is pending. Run boat onboard.");
        }
        print({ progress: "waiting", userCode: pending.code });
        const file = signInFile(pending.code);
        const outcome = await waitForApproval(pending, authLogPath(), () =>
          NodeFS.existsSync(file),
        );
        if (outcome === "expired") {
          NodeFS.rmSync(file, { force: true });
          throw new BoatError("sign_in_expired", "The sign-in code expired. Run boat onboard.");
        }
        if (outcome === "cancelled" || !claimFile(file)) {
          throw new BoatError(
            "sign_in_cancelled",
            "A logout or a newer boat onboard replaced this sign-in.",
          );
        }
        writeJsonAtomic(ACCOUNT_FILE, {
          identifier: FAKE_IDENTITY,
          plan: plan(),
          signedInAt: now(),
        });
        print({});
        return 0;
      }
      ensureCaddy();
      const signedIn = account();
      if (signedIn) {
        throw new BoatError("already_signed_in", `Already signed in as ${signedIn.identifier}`);
      }
      let signIn = pending && pending.expiresAtMs > Date.now() ? pending : undefined;
      if (!signIn) {
        signIn = issueDeviceCode("boat");
        NodeFS.rmSync(SIGN_INS, { recursive: true, force: true });
        createJsonExclusive(signInFile(signIn.code), signIn);
      }
      const url = `${publicUrl(AUTH_HOST)}/boat/device?code=${signIn.code}`;
      print({ url, userCode: signIn.code });
      return 0;
    },
  },
  {
    path: ["logout"],
    mutating: true,
    prints: "json",
    signedIn: false,
    run: async () => {
      NodeFS.rmSync(ACCOUNT_FILE, { force: true });
      NodeFS.rmSync(SIGN_INS, { recursive: true, force: true });
      print({});
      return 0;
    },
  },
  {
    path: ["new"],
    flags: {
      name: "string",
      type: "string",
      from: "string",
      ttl: "string",
      "no-auto-stop": "boolean",
    },
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation, signedIn) => {
      const type = size(invocation.flags.get("type"));
      const name = text(invocation.flags.get("name"), "--name");
      const life = lifetime(invocation, signedIn.plan);
      if (!life) throw new BoatError("lifetime_required", "Pass --ttl <seconds> or --no-auto-stop");
      const from = invocation.flags.get("from");
      const image =
        from === undefined ? sandboxImage() : (await settledSnapshot(text(from, "--from"))).imageId;
      ensureCaddy();
      const id = `bx-${NodeCrypto.randomBytes(6).toString("hex")}`;
      const record: SandboxRecord = {
        id,
        name,
        type,
        createdAt: now(),
        ttlSeconds: life.ttlSeconds,
        archiveAfter: deadline(life.ttlSeconds),
      };
      print({ progress: "creating", id });
      prepareMounts(id);
      setDeadline(id, record.archiveAfter);
      writeJsonAtomic(sandboxFile(id), record);
      try {
        runContainer(record, image);
        print({ progress: "booting", id });
        await waitForBoot(id);
      } catch (error) {
        removeSandbox(id);
        throw error instanceof BoatError
          ? error
          : new BoatError("create_failed", errorMessage(error));
      }
      recordStart(id);
      print(view(record, requireLive(record)));
      return 0;
    },
  },
  {
    path: ["info"],
    args: ["sandbox"],
    mutating: false,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      const record = sandboxRecord(invocation.args.sandbox);
      print({ sandbox: view(record, requireLive(record)) });
      return 0;
    },
  },
  {
    path: ["list"],
    flags: { all: "boolean" },
    mutating: false,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      const all = invocation.flags.has("all");
      const sandboxes = sandboxRecords().flatMap((record) => {
        const state = live(record.id);
        return state && (all || state.state !== "stopped") ? [view(record, state)] : [];
      });
      print({ sandboxes });
      return 0;
    },
  },
  {
    path: ["stop"],
    args: ["sandbox"],
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      const record = sandboxRecord(invocation.args.sandbox);
      await settled({ sandboxId: record.id }, 20_000);
      requireLive(record);
      docker(["stop", "--time", "30", container(record.id)], { timeoutMs: 60_000 });
      print({});
      return 0;
    },
  },
  {
    path: ["resume"],
    args: ["sandbox"],
    flags: { type: "string", ttl: "string", "no-auto-stop": "boolean" },
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation, signedIn) => {
      const diskTtl = diskTtlSeconds();
      const record = sandboxRecord(invocation.args.sandbox);
      const state = requireLive(record);
      const type = invocation.flags.has("type") ? size(invocation.flags.get("type")) : record.type;
      const life = lifetime(invocation, signedIn.plan) ?? { ttlSeconds: record.ttlSeconds };
      if (state.state === "stopped" && Date.now() - Date.parse(state.finishedAt) > diskTtl * 1000) {
        throw new BoatError(
          "snapshot_data_expired",
          "This sandbox's disk was deleted after it stayed stopped too long",
        );
      }
      const next: SandboxRecord = {
        ...record,
        type,
        ttlSeconds: life.ttlSeconds,
        archiveAfter: deadline(life.ttlSeconds),
      };
      resize(record.id, type);
      setDeadline(record.id, next.archiveAfter);
      writeAuthOrigin(record.id);
      if (state.state !== "running") {
        print({ progress: "resuming", id: record.id });
        try {
          docker(["start", container(record.id)]);
          await waitForBoot(record.id);
        } catch (error) {
          dockerSucceeds(["stop", "--time", "30", container(record.id)]);
          resize(record.id, record.type);
          setDeadline(record.id, record.archiveAfter);
          throw error instanceof BoatError
            ? error
            : new BoatError("resume_failed", errorMessage(error));
        }
        recordStart(record.id);
      }
      writeJsonAtomic(sandboxFile(record.id), next);
      print(view(next, requireLive(next)));
      return 0;
    },
  },
  {
    path: ["extend"],
    args: ["sandbox"],
    flags: { ttl: "string" },
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation, signedIn) => {
      const record = sandboxRecord(invocation.args.sandbox);
      requireLive(record);
      const ttl = integer(invocation.flags.get("ttl"), "--ttl", 1);
      if (signedIn.plan === "trial" && ttl > TRIAL_TTL_SECS) throw trialRefusal();
      const next: SandboxRecord = { ...record, ttlSeconds: ttl, archiveAfter: deadline(ttl) };
      setDeadline(record.id, next.archiveAfter);
      writeJsonAtomic(sandboxFile(record.id), next);
      print({});
      return 0;
    },
  },
  {
    path: ["delete"],
    args: ["sandbox"],
    flags: { yes: "boolean" },
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      if (!invocation.flags.has("yes")) {
        throw new BoatError("confirmation_required", "Pass --yes to delete without a prompt");
      }
      const { id } = sandboxRecord(invocation.args.sandbox);
      await settled({ sandboxId: id }, 100_000);
      removeSandbox(id);
      print({});
      return 0;
    },
  },
  {
    path: ["snapshot"],
    args: ["sandbox", "name"],
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      const name = snapshotName(invocation.args.name);
      const record = sandboxRecord(invocation.args.sandbox);
      await settled({ name }, 100_000);
      requireLive(record);
      commitSnapshot(record.id, name);
      print({});
      return 0;
    },
  },
  {
    path: ["snapshot", "rm"],
    args: ["name"],
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      const { name } = await settledSnapshot(invocation.args.name, 45_000);
      try {
        docker(["image", "rm", "--force", snapshotTag(name)]);
      } catch (error) {
        if (!isNoSuch(error)) throw error;
      }
      NodeFS.rmSync(snapshotFile(name), { force: true });
      print({});
      return 0;
    },
  },
  {
    path: ["snapshots"],
    mutating: false,
    prints: "json",
    signedIn: true,
    run: async () => {
      await settled({}, 15_000);
      const named = snapshotRecords().map(({ name, sandboxId, createdAt }) => ({
        name,
        sandboxId,
        createdAt,
      }));
      print({ named });
      return 0;
    },
  },
  {
    path: ["exec"],
    args: ["sandbox"],
    flags: { timeout: "string" },
    afterDoubleDash: true,
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      const record = sandboxRecord(invocation.args.sandbox);
      requireRunning(record);
      const timeout = invocation.flags.has("timeout")
        ? integer(invocation.flags.get("timeout"), "--timeout", 1)
        : DEFAULT_EXEC_TIMEOUT_SECS;
      if (invocation.afterDoubleDash.length === 0) {
        throw new BoatError("invalid_arguments", "exec needs a command after --");
      }
      const env = Object.entries(process.env).flatMap(([key, value]) =>
        key.startsWith("FAKE_AUTH_") && value !== undefined ? ["-e", `${key}=${value}`] : [],
      );
      const started = Date.now();
      const ran = await execUnpaused(
        [
          "exec",
          "-u",
          "user",
          "-w",
          "/home/user",
          "-e",
          "HOME=/home/user",
          ...env,
          container(record.id),
          "timeout",
          String(timeout),
          ...invocation.afterDoubleDash,
        ],
        { killAfterMs: (timeout + 10) * 1000 },
      );
      // coreutils `timeout` exits 124 when it had to stop the command.
      const timedOut =
        ran.status === null || (ran.status === 124 && Date.now() - started >= timeout * 1000);
      print({
        exitCode: timedOut ? null : ran.status,
        stdout: ran.stdout.toString(),
        stderr: ran.stderr.toString(),
      });
      return timedOut ? 124 : (ran.status ?? 1);
    },
  },
  {
    path: ["scp"],
    args: ["from", "to"],
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async ({ args: { from = "", to = "" } }) => {
      const up = REMOTE_PATH.exec(to);
      const down = REMOTE_PATH.exec(from);
      if (up?.[1] && up[2] && !down) await upload(from, up[1], up[2]);
      else if (down?.[1] && down[2] && !up) await download(down[1], down[2], to);
      else
        throw new BoatError("invalid_arguments", "usage: scp <local> <id>:<path>, or the reverse");
      print({});
      return 0;
    },
  },
  {
    path: ["host"],
    args: ["sandbox", "port"],
    flags: { public: "boolean", localhost: "boolean" },
    mutating: true,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      const record = sandboxRecord(invocation.args.sandbox);
      requireRunning(record);
      const port = integer(invocation.args.port, "port", 1, 65535);
      if (!invocation.flags.has("public")) {
        throw new BoatError("invalid_arguments", "The fake only makes --public hosts");
      }
      const scheme = process.env.FAKE_BOAT_HOST_SCHEME ?? "https";
      if (scheme !== "https" && scheme !== "http") {
        throw new BoatError("invalid_arguments", "FAKE_BOAT_HOST_SCHEME must be https or http");
      }
      if (invocation.flags.has("localhost")) {
        const args = [
          "exec",
          container(record.id),
          "systemctl",
          "enable",
          "--now",
          `fake-boat-host@${port}.service`,
        ];
        const enabled = await execUnpaused(args);
        if (enabled.status !== 0)
          throw new DockerError(args, enabled.status, enabled.stderr.toString());
      }
      NodeFS.mkdirSync(at("hosts", record.id), { recursive: true });
      NodeFS.writeFileSync(at("hosts", record.id, String(port)), "");
      const host = `${record.id}-${port}.${DOMAIN}`;
      const upstream = `${container(record.id)}:${port}`;
      const https = publishSite({ id: siteId(record.id, port), host, upstream, plainHttp: true });
      print({ url: scheme === "http" ? publicUrl(host, "http") : https });
      return 0;
    },
  },
  {
    path: ["forward"],
    args: ["sandbox"],
    flags: { remote: "string", local: "string" },
    mutating: false,
    prints: "nothing",
    signedIn: true,
    run: async (invocation) => {
      const record = sandboxRecord(invocation.args.sandbox);
      requireRunning(record);
      const remote = integer(invocation.flags.get("remote"), "--remote", 1, 65535);
      const local = integer(invocation.flags.get("local"), "--local", 1, 65535);
      const sockets = new Set<NodeNet.Socket>();
      const pipes = new Set<NodeChildProcess.ChildProcess>();
      const server = NodeNet.createServer((socket) => {
        const pipe = pipeInto(record.id, remote, socket);
        sockets.add(socket);
        pipes.add(pipe);
        socket.on("close", () => sockets.delete(socket));
        pipe.on("close", () => pipes.delete(pipe));
      });
      await listen(server, local);
      // Logged now: Sail Boat ends a forward with SIGKILL, which no exit handler sees.
      logCall(HOME, { argv: process.argv.slice(2), mutating: false, exitCode: 0 });
      const close = () => {
        server.close();
        for (const socket of sockets) socket.destroy();
        for (const pipe of pipes) pipe.kill();
        process.exit(0);
      };
      process.once("SIGTERM", close);
      process.once("SIGINT", close);
      return new Promise<number>(() => {});
    },
  },
  {
    path: ["usage"],
    args: ["sandbox"],
    flags: { since: "string" },
    mutating: false,
    prints: "json",
    signedIn: true,
    run: async (invocation) => {
      const record = sandboxRecord(invocation.args.sandbox);
      const state = requireLive(record);
      const since = integer(invocation.flags.get("since"), "--since");
      const started = Date.parse(state.startedAt) / 1000;
      const ended = (state.state === "stopped" ? Date.parse(state.finishedAt) : Date.now()) / 1000;
      print({ dollars: 0, seconds: Math.max(0, Math.round(ended - Math.max(since, started))) });
      return 0;
    },
  },
  {
    path: ["limits"],
    flags: { all: "boolean" },
    mutating: false,
    prints: "json",
    signedIn: true,
    run: async () => {
      const today = now().slice(0, 10);
      const lines = NodeFS.existsSync(at("starts.jsonl"))
        ? NodeFS.readFileSync(at("starts.jsonl"), "utf8").split("\n").filter(Boolean)
        : [];
      const used = lines.filter((line) => {
        const start = JSON.parse(line) as { readonly time: string };
        return start.time.startsWith(today);
      }).length;
      print({ starts: { day: { used, limit: STARTS_PER_DAY } } });
      return 0;
    },
  },
];

async function main(argv: ReadonlyArray<string>): Promise<{ code: number; mutating: boolean }> {
  let mutating = false;
  try {
    const invocation = parse(TABLE, argv, ["--json"]);
    const command = invocation.command;
    mutating = command.mutating;
    if (command.prints === "json" && !invocation.global.has("--json")) {
      throw new BoatError(
        "json_required",
        "The fake boat prints only JSON: pass --json before any --",
      );
    }
    if (!command.signedIn) return { code: await command.run(invocation), mutating };
    const signedIn = account();
    if (!signedIn) throw new BoatError("not_signed_in", "Not signed in. Run boat onboard.");
    return { code: await command.run(invocation, signedIn), mutating };
  } catch (error) {
    const code =
      error instanceof BoatError || error instanceof UsageError ? error.code : "internal";
    console.error(JSON.stringify({ code, error: errorMessage(error) }));
    return { code: 1, mutating };
  }
}

if (process.argv[2] === WORKER_ARG) {
  OUTBOX.work();
} else {
  const argv = process.argv.slice(2);
  const result = await main(argv);
  logCall(HOME, { argv, mutating: result.mutating, exitCode: result.code });
  try {
    // Requests this command's own work queued, such as an in-sandbox `boat snapshot` it ran.
    OUTBOX.start();
  } catch (error) {
    console.error(JSON.stringify({ code: "worker_not_started", error: errorMessage(error) }));
  }
  process.exitCode = result.code;
}

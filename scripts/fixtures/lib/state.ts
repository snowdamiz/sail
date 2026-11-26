// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Local stand-ins keep plain JSON files on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

/**
 * Shared by every checkout on this computer: the Caddy front door and global name reservations.
 * Read from the account database, so a process with another `HOME` or `XDG_STATE_HOME` still
 * finds the one Caddy every lane uses instead of making a second CA and replacing it.
 */
export function fixturesRoot(): string {
  return NodePath.join(NodeOS.userInfo().homedir, ".local", "state", "sail-fixtures");
}

function stateRoot(): string {
  const state = process.env.XDG_STATE_HOME || NodePath.join(NodeOS.homedir(), ".local", "state");
  return NodePath.join(state, "sail-fixtures");
}

const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

const CHECKOUT = NodePath.resolve(import.meta.dirname, "../../..");

/**
 * One spelling per directory, such as `/private/tmp` for `/tmp` on macOS, resolved through the
 * nearest part of `path` that exists, so a home's id never depends on how it was written.
 */
export function canonicalPath(path: string): string {
  const missing: Array<string> = [];
  for (let at = NodePath.resolve(path); ; at = NodePath.dirname(at)) {
    try {
      return NodePath.join(NodeFS.realpathSync(at), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ENOTDIR") || at === NodePath.dirname(at)) throw error;
      missing.unshift(NodePath.basename(at));
    }
  }
}

/**
 * A fake's records, one home per checkout unless `envName` names another, so parallel lanes in
 * separate worktrees never share an account, a sandbox list, or a call log.
 */
export function standInHome(kind: "fly" | "boat", envName: string): string {
  const chosen = process.env[envName];
  return canonicalPath(chosen || NodePath.join(stateRoot(), kind, shortHash(CHECKOUT)));
}

/** Labels and names every Docker resource a home creates, so cleanup can find only its own. */
export function homeId(home: string): string {
  return shortHash(canonicalPath(home));
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeTemporary(path: string, value: unknown): string {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  return temporary;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  NodeFS.renameSync(writeTemporary(path, value), path);
}

/**
 * Writes only when nothing is there yet; false when another caller got there first. The file
 * appears whole, by hard link, so a racing reader never parses a half-written one.
 */
export function createJsonExclusive(path: string, value: unknown): boolean {
  const temporary = writeTemporary(path, value);
  try {
    NodeFS.linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

const LOCK_WAIT_MS = 5 * 60_000;
const SQLITE_BUSY = 5;
const SQLITE_NOTADB = 26;

/** Collecting a connection would close it, so a held lock stays reachable until its release. */
const held = new Set<NodeSqlite.DatabaseSync>();

const sqliteCode = (error: unknown) => (error as { readonly errcode?: number }).errcode;

/**
 * Holds `path` exclusively until the returned release runs, or returns nothing when another process
 * held it for all of `waitMs`. The kernel owns the lock (SQLite's fcntl lock on the file), so it ends
 * with its process however that process ends, and no file ever names a holder that could be stale.
 */
export function takeLock(path: string, waitMs = 0): (() => void) | undefined {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const db = new NodeSqlite.DatabaseSync(path, { timeout: waitMs });
    try {
      db.exec("BEGIN EXCLUSIVE");
      held.add(db);
      return () => {
        held.delete(db);
        db.close();
      };
    } catch (error) {
      db.close();
      if (sqliteCode(error) === SQLITE_BUSY) return undefined;
      // No holder ever writes to the file, so emptying one it cannot read displaces nobody.
      if (sqliteCode(error) !== SQLITE_NOTADB || attempt > 0) throw error;
      NodeFS.truncateSync(path, 0);
    }
  }
}

export function withLock<T>(path: string, run: () => T, waitMs = LOCK_WAIT_MS): T {
  const release = takeLock(path, waitMs);
  if (!release) throw new Error(`${path} is still held by another process after ${waitMs} ms`);
  try {
    return run();
  } finally {
    release();
  }
}

/** A process by its pid and the time it started, so a reused pid never passes for one that ended. */
export interface ProcessRef {
  readonly pid: number;
  readonly started: string;
}

export function processRef(pid: number): ProcessRef | undefined {
  // One clock and one language, so every process prints a given start the same way.
  const ps = NodeChildProcess.spawnSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  });
  const [stat, ...started] = ps.stdout.trim().split(/\s+/);
  // `Z` and `X` have ended; `E` (macOS) is ending, after the kernel dropped its locks.
  if (ps.status !== 0 || !stat || /^[ZX]|E/.test(stat) || started.length === 0) return undefined;
  return { pid, started: started.join(" ") };
}

let self: ProcessRef | undefined;
export function thisProcess(): ProcessRef {
  self ??= processRef(process.pid);
  if (!self) throw new Error(`ps cannot see this process (${process.pid})`);
  return self;
}

/** False for anything that does not name a running process exactly, a malformed record included. */
export function isRunning(ref: Partial<ProcessRef> | undefined): boolean {
  if (typeof ref?.pid !== "number" || typeof ref.started !== "string") return false;
  return processRef(ref.pid)?.started === ref.started;
}

const reservationPath = (namespace: string, name: string) =>
  NodePath.join(fixturesRoot(), "names", namespace, name);

const isHome = (owner: string | undefined, home: string) =>
  owner !== undefined && canonicalPath(owner) === canonicalPath(home);

/**
 * Claims `name` across every home on this computer, as a real service's global namespace does.
 * True when `home` holds it, whether just now or earlier, under any spelling of its path.
 */
export function reserveName(namespace: string, name: string, home: string): boolean {
  const path = reservationPath(namespace, name);
  if (createJsonExclusive(path, { owner: canonicalPath(home) })) return true;
  return isHome(readJson<{ readonly owner: string }>(path)?.owner, home);
}

export function nameOwner(namespace: string, name: string): string | undefined {
  return readJson<{ readonly owner: string }>(reservationPath(namespace, name))?.owner;
}

export function releaseName(namespace: string, name: string, home: string): void {
  if (isHome(nameOwner(namespace, name), home)) NodeFS.rmSync(reservationPath(namespace, name));
}

export interface CallRecord {
  readonly argv: ReadonlyArray<string>;
  readonly mutating: boolean;
  readonly exitCode: number;
}

/** One JSON line per invocation in `<home>/calls.jsonl`. A caller masks secrets in `argv` first. */
export function logCall(home: string, record: CallRecord): void {
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.appendFileSync(
    NodePath.join(home, "calls.jsonl"),
    `${JSON.stringify({ time: new Date().toISOString(), argv: record.argv, cwd: process.cwd(), mutating: record.mutating, exitCode: record.exitCode })}\n`,
    { mode: 0o600 },
  );
}

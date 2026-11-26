// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Local stand-ins keep plain JSON files on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
 * A fake's records, one home per checkout unless `envName` names another, so parallel lanes in
 * separate worktrees never share an account, a sandbox list, or a call log.
 */
export function standInHome(kind: "fly" | "boat", envName: string): string {
  const chosen = process.env[envName];
  return chosen ? NodePath.resolve(chosen) : NodePath.join(stateRoot(), kind, shortHash(CHECKOUT));
}

/** Labels and names every Docker resource a home creates, so cleanup can find only its own. */
export function homeId(home: string): string {
  return shortHash(NodePath.resolve(home));
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

const reservationPath = (namespace: string, name: string) =>
  NodePath.join(fixturesRoot(), "names", namespace, name);

/**
 * Claims `name` across every home on this computer, as a real service's global namespace does.
 * True when `owner` holds it, whether just now or earlier.
 */
export function reserveName(namespace: string, name: string, owner: string): boolean {
  const path = reservationPath(namespace, name);
  if (createJsonExclusive(path, { owner })) return true;
  return readJson<{ readonly owner: string }>(path)?.owner === owner;
}

export function nameOwner(namespace: string, name: string): string | undefined {
  return readJson<{ readonly owner: string }>(reservationPath(namespace, name))?.owner;
}

export function releaseName(namespace: string, name: string, owner: string): void {
  if (nameOwner(namespace, name) === owner) NodeFS.rmSync(reservationPath(namespace, name));
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

// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Local stand-ins keep plain JSON files on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Shared by every checkout on this computer: the Caddy front door and global name reservations. */
export function fixturesRoot(): string {
  const state = process.env.XDG_STATE_HOME ?? NodePath.join(NodeOS.homedir(), ".local", "state");
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
  return process.env[envName] ?? NodePath.join(fixturesRoot(), kind, shortHash(CHECKOUT));
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

export function writeJsonAtomic(path: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  NodeFS.renameSync(temporary, path);
}

/** Writes only when nothing is there yet; false when another caller got there first. */
export function createJsonExclusive(path: string, value: unknown): boolean {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  try {
    NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
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

/** One JSON line per invocation in `<home>/calls.jsonl`, with `secretFlags` values masked. */
export function logCall(
  home: string,
  record: CallRecord,
  secretFlags: ReadonlyArray<string> = [],
): void {
  const argv = record.argv.map((arg, index) => {
    const flag = secretFlags.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag !== undefined && arg.startsWith(`${flag}=`)) return `${flag}=<redacted>`;
    const previous = record.argv[index - 1];
    return previous !== undefined && secretFlags.includes(previous) ? "<redacted>" : arg;
  });
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.appendFileSync(
    NodePath.join(home, "calls.jsonl"),
    `${JSON.stringify({ time: new Date().toISOString(), argv, cwd: process.cwd(), mutating: record.mutating, exitCode: record.exitCode })}\n`,
    { mode: 0o600 },
  );
}

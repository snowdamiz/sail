// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - The computer side of the fake sandboxes' snapshot outbox, run inside the plain Node fake `boat`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { createJsonExclusive, readJson, writeJsonAtomic } from "../lib/state.ts";
import { parseRequest, parseRequestFile, requestFile, type RequestFile } from "./sandbox/outbox.ts";

/** The argument that makes the fake `boat` run as the outbox worker. */
export const WORKER_ARG = "--outbox-worker";

export interface SnapshotFailure {
  readonly name: string;
  readonly sandboxId: string;
  readonly failedAt: string;
  readonly error: string;
}

/** Which requests a caller waits on: one sandbox's, one snapshot name's, or all. */
export interface Match {
  readonly sandboxId?: string;
  readonly name?: string;
}

interface QueuedRequest {
  readonly sandboxId: string;
  readonly file: RequestFile;
}

export interface Outbox {
  /** The directory a sandbox writes its requests to. */
  readonly dir: (sandboxId: string) => string;
  /** Hands queued requests to a detached worker, so no command waits on another's commit. */
  readonly start: () => void;
  /** The worker's own loop; it exits once the queue is empty. */
  readonly work: () => void;
  /**
   * Saves the matching requests, or waits for the worker saving them, within `budgetMs`. False
   * when the budget ran out with one still queued or saving.
   */
  readonly settle: (match: Match, budgetMs: number) => Promise<boolean>;
  readonly failures: (match?: Match) => ReadonlyArray<SnapshotFailure>;
}

export interface OutboxOptions {
  readonly home: string;
  /** The script that runs `work()` when given `WORKER_ARG`. */
  readonly entry: string;
  /** Commits `name` from `sandboxId`, throwing why it could not. */
  readonly save: (sandboxId: string, name: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Alive only while that pid still runs this fake: a dead worker's pid can be reused by anything. */
function isAlive(pid: number): boolean {
  const ps = NodeChildProcess.spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return ps.status === 0 && ps.stdout.includes(NodePath.join("fake-boat", "boat.ts"));
}

function entries(dir: string): ReadonlyArray<string> {
  try {
    return NodeFS.readdirSync(dir);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

function lockHolder(lock: string): number | undefined {
  return readJson<{ readonly pid: number }>(lock)?.pid;
}

/**
 * Removes `lock` only while `stalePid` still holds it. The rename lets one caller take it, and a
 * lock a live worker took in the meantime goes back in place.
 */
export function breakStaleLock(lock: string, stalePid: number): boolean {
  const moved = `${lock}.breaking-${process.pid}`;
  try {
    NodeFS.renameSync(lock, moved);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  const holder = lockHolder(moved);
  if (holder === stalePid) {
    NodeFS.rmSync(moved);
    return true;
  }
  try {
    NodeFS.linkSync(moved, lock);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  NodeFS.rmSync(moved);
  return false;
}

/** True when this process now holds `lock`, taking it over from a holder that died. */
export function takeLock(lock: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createJsonExclusive(lock, { pid: process.pid })) return true;
    const holder = lockHolder(lock);
    if (holder !== undefined && (isAlive(holder) || !breakStaleLock(lock, holder))) return false;
  }
  return false;
}

export function outbox({ home, entry, save }: OutboxOptions): Outbox {
  const root = NodePath.join(home, "outbox");
  const lock = NodePath.join(home, "worker.json");
  const dir = (sandboxId: string) => NodePath.join(root, sandboxId);
  const sandboxes = (match: Match) =>
    match.sandboxId === undefined ? entries(root) : [match.sandboxId];

  const requests = (match: Match): ReadonlyArray<QueuedRequest> =>
    sandboxes(match).flatMap((sandboxId) =>
      entries(dir(sandboxId)).flatMap((name) => {
        const file = parseRequestFile(name);
        return file && (match.name === undefined || file.base === match.name)
          ? [{ sandboxId, file }]
          : [];
      }),
    );

  /** Requests nobody is saving: new, or held by a worker that died. */
  const queued = (match: Match = {}): ReadonlyArray<QueuedRequest> =>
    requests(match).filter(
      ({ file }) => file.stage === "pending" || (file.stage === "claimed" && !isAlive(file.pid)),
    );

  const saving = (match: Match) =>
    requests(match).some(({ file }) => file.stage === "claimed" && isAlive(file.pid));

  const claim = (request: QueuedRequest): string | undefined => {
    const claimed = NodePath.join(
      dir(request.sandboxId),
      requestFile({ stage: "claimed", base: request.file.base, pid: process.pid }),
    );
    try {
      NodeFS.renameSync(NodePath.join(dir(request.sandboxId), requestFile(request.file)), claimed);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    return claimed;
  };

  /** Saves a claimed request, or sets it aside as failed with the reason, never silently. */
  const fulfil = (request: QueuedRequest, claimed: string): void => {
    const { sandboxId } = request;
    const failed = NodePath.join(
      dir(sandboxId),
      requestFile({ stage: "failed", base: request.file.base }),
    );
    try {
      const body = parseRequest(NodeFS.readFileSync(claimed, "utf8"));
      if (body.sandboxId !== sandboxId || body.name !== request.file.base) {
        throw new Error(`sandbox ${sandboxId} sent ${request.file.base} to save ${body.name}`);
      }
      save(sandboxId, body.name);
      NodeFS.rmSync(failed, { force: true });
    } catch (error) {
      const failure: SnapshotFailure = {
        name: request.file.base,
        sandboxId,
        failedAt: new Date().toISOString(),
        error: errorMessage(error),
      };
      writeJsonAtomic(failed, failure);
    }
    NodeFS.rmSync(claimed, { force: true });
  };

  const drain = (match: Match = {}): void => {
    for (let waiting = queued(match); waiting.length > 0; waiting = queued(match)) {
      for (const request of waiting) {
        const claimed = claim(request);
        if (claimed) fulfil(request, claimed);
      }
    }
  };

  const start = (): void => {
    if (queued().length === 0) return;
    const holder = lockHolder(lock);
    if (holder !== undefined && isAlive(holder)) return;
    const log = NodeFS.openSync(NodePath.join(home, "worker.log"), "a");
    try {
      const worker = NodeChildProcess.spawn(process.execPath, [entry, WORKER_ARG], {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, FAKE_BOAT_HOME: home },
      });
      // The queue stays put for the next command to try again.
      worker.on("error", (error) =>
        console.error(JSON.stringify({ code: "worker_not_started", error: error.message })),
      );
      worker.unref();
    } finally {
      NodeFS.closeSync(log);
    }
  };

  const release = () => {
    if (lockHolder(lock) === process.pid) NodeFS.rmSync(lock, { force: true });
  };

  /** Only the lock's holder saves queued requests, so two of one name never land out of order. */
  const drainHolding = (match: Match = {}): boolean => {
    if (!takeLock(lock)) return false;
    try {
      drain(match);
    } finally {
      release();
    }
    return true;
  };

  const work = (): void => {
    while (queued().length > 0) if (!drainHolding()) return;
  };

  const settle = async (match: Match, budgetMs: number): Promise<boolean> => {
    const give = Date.now() + budgetMs;
    for (;;) {
      if (queued(match).length > 0) drainHolding(match);
      if (queued(match).length === 0 && !saving(match)) return true;
      if (Date.now() >= give) return false;
      await sleep(250);
    }
  };

  const failures = (match: Match = {}): ReadonlyArray<SnapshotFailure> =>
    requests(match).flatMap(({ sandboxId, file }) =>
      file.stage === "failed"
        ? (readJson<SnapshotFailure>(NodePath.join(dir(sandboxId), requestFile(file))) ?? [])
        : [],
    );

  return { dir, start, work, settle, failures };
}

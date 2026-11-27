// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off extendsNativeError:off - The plain Node `boat` inside a fake sandbox, run by the watchdog.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type CommandSpec, parse, UsageError } from "./cli.ts";
import { isObject } from "./jsonl.ts";
import {
  CALL_LOG,
  ID_FILE,
  OUTBOX_DIR,
  parseRequestFile,
  requestFile,
  SNAPSHOT_NAME,
  type SnapshotRequest,
} from "./outbox.ts";

/** Inside the 10 minutes `native/sail-boat/src/machine/watchdog.mjs` gives it (`SNAPSHOT_TIMEOUT_MS`). */
const SAVE_WAIT_MS = 9 * 60_000;
const SAVE_POLL_MS = 100;

class BoatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Command extends CommandSpec {
  readonly run: (args: Readonly<Record<string, string>>) => void | Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The sandbox's own key only reaches itself, and this one cannot reach Docker. */
function ownSandbox(id: string): void {
  const own = NodeFS.readFileSync(NodePath.join(OUTBOX_DIR, ID_FILE), "utf8").trim();
  if (id !== own) throw new BoatError("not_found", `sandbox ${id} not found`);
}

function scheduleShutdown(): void {
  const scheduled = NodeChildProcess.spawnSync(
    "sudo",
    [
      "-n",
      "systemd-run",
      "--on-active=1",
      "--timer-property=AccuracySec=100ms",
      "/bin/systemctl",
      "poweroff",
    ],
    { encoding: "utf8" },
  );
  if (scheduled.status !== 0) throw new BoatError("stop_failed", scheduled.stderr.trim());
}

function readIfPresent(path: string): string | undefined {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Queued, or claimed by the computer's worker, which removes it once saved or failed. */
function saving(name: string): boolean {
  return NodeFS.readdirSync(OUTBOX_DIR).some((file) => {
    const request = parseRequestFile(file);
    return request?.base === name && request.stage !== "failed";
  });
}

/** Returns once the computer saved it: the watchdog counts a finished command as a saved snapshot. */
async function snapshot(sandbox: string, name: string): Promise<void> {
  ownSandbox(sandbox);
  if (!SNAPSHOT_NAME.test(name)) {
    throw new BoatError("invalid_name", "Use lowercase letters, digits and dashes");
  }
  const failedFile = NodePath.join(OUTBOX_DIR, requestFile({ stage: "failed", base: name }));
  const earlierFailure = readIfPresent(failedFile);
  const request: SnapshotRequest = {
    sandboxId: sandbox,
    name,
    requestedAt: new Date().toISOString(),
  };
  const file = NodePath.join(OUTBOX_DIR, requestFile({ stage: "pending", base: name }));
  NodeFS.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(request));
  NodeFS.renameSync(`${file}.${process.pid}.tmp`, file);
  const give = Date.now() + SAVE_WAIT_MS;
  while (saving(name)) {
    if (Date.now() >= give) {
      // Unclaimed, it would still save after this call reported that it failed.
      NodeFS.rmSync(file, { force: true });
      throw new BoatError("snapshot_timeout", `The computer did not save ${name} in time`);
    }
    await sleep(SAVE_POLL_MS);
  }
  const failure = readIfPresent(failedFile);
  if (failure === undefined || failure === earlierFailure) return;
  const parsed: unknown = JSON.parse(failure);
  const error = isObject(parsed) && typeof parsed.error === "string" ? parsed.error : failure;
  throw new BoatError("snapshot_failed", error);
}

const TABLE: ReadonlyArray<Command> = [
  {
    path: ["stop"],
    args: ["sandbox"],
    run: ({ sandbox = "" }) => {
      ownSandbox(sandbox);
      scheduleShutdown();
    },
  },
  {
    path: ["snapshot"],
    args: ["sandbox", "name"],
    run: ({ sandbox = "", name = "" }) => snapshot(sandbox, name),
  },
];

async function main(argv: ReadonlyArray<string>): Promise<number> {
  try {
    const invocation = parse(TABLE, argv, ["--json"]);
    if (!invocation.global.has("--json")) {
      throw new BoatError(
        "json_required",
        "The fake boat prints only JSON: pass --json before any --",
      );
    }
    await invocation.command.run(invocation.args);
    console.log("{}");
    return 0;
  } catch (error) {
    const code =
      error instanceof BoatError || error instanceof UsageError ? error.code : "internal";
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ code, error: message }));
    return 1;
  }
}

const argv = process.argv.slice(2);
const exitCode = await main(argv);
NodeFS.appendFileSync(
  NodePath.join(OUTBOX_DIR, CALL_LOG),
  `${JSON.stringify({ time: new Date().toISOString(), argv, cwd: process.cwd(), mutating: true, exitCode })}\n`,
);
process.exitCode = exitCode;

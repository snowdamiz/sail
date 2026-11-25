// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off extendsNativeError:off - The plain Node `boat` inside a fake sandbox, run by the watchdog.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type CommandSpec, parse, UsageError } from "./cli.ts";
import {
  CALL_LOG,
  ID_FILE,
  OUTBOX_DIR,
  requestFile,
  SNAPSHOT_NAME,
  type SnapshotRequest,
} from "./outbox.ts";

class BoatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Command extends CommandSpec {
  readonly run: (args: Readonly<Record<string, string>>) => void;
}

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
    run: ({ sandbox = "", name = "" }) => {
      ownSandbox(sandbox);
      if (!SNAPSHOT_NAME.test(name)) {
        throw new BoatError("invalid_name", "Use lowercase letters, digits and dashes");
      }
      const request: SnapshotRequest = {
        sandboxId: sandbox,
        name,
        requestedAt: new Date().toISOString(),
      };
      const file = NodePath.join(OUTBOX_DIR, requestFile(name));
      NodeFS.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(request));
      NodeFS.renameSync(`${file}.${process.pid}.tmp`, file);
    },
  },
];

function main(argv: ReadonlyArray<string>): number {
  try {
    const invocation = parse(TABLE, argv, ["--json"]);
    invocation.command.run(invocation.args);
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
const exitCode = main(argv);
NodeFS.appendFileSync(
  NodePath.join(OUTBOX_DIR, CALL_LOG),
  `${JSON.stringify({ time: new Date().toISOString(), argv, cwd: process.cwd(), mutating: true, exitCode })}\n`,
);
process.exitCode = exitCode;

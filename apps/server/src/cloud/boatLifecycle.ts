// @effect-diagnostics globalTimers:off -- Standalone launcher coordinates OS leases.
// @effect-diagnostics nodeBuiltinImport:off -- Also used by the standalone service launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  decodeStagedSailRelease,
  parseLegacyServiceState,
  parseServiceState,
  SERVICE_STATE_FILE,
} from "./serviceProtocol.ts";

const INSTALLATION_ID = "boat-installation-id";
const LIFECYCLE_LOCK = "boat-lifecycle.lock";
const BOAT_BOOT_OPERATION = "boat-power-operation";
export const BOAT_CAPABILITY = "boat-maintenance-capability.json";
export const BOAT_REQUEST = "boat-maintenance-request.json";
export const BOAT_READY = "boat-maintenance-ready.json";

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function readOptional(path: string): string | undefined {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}

export function boatRuntime(baseDir: string) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher.
  if (process.platform !== "linux") return undefined;
  const marker = NodePath.join(baseDir, "runtime", INSTALLATION_ID);
  const installation = NodeFS.lstatSync(marker, { throwIfNoEntry: false });
  if (installation === undefined) return undefined;
  if (!installation.isFile()) throw new Error("Boat installation marker must be a regular file.");
  const home = NodeFS.realpathSync(baseDir);
  const runtime = NodePath.join(home, "runtime");
  if (NodeFS.realpathSync(runtime) !== runtime) throw new Error("Boat runtime must be canonical.");
  return runtime;
}

// @effect-diagnostics-next-line extendsNativeError:off -- The standalone launcher runs without Effect.
export class BoatLifecycleBusy extends Error {
  constructor() {
    super("Another operation owns the pinned Boat lifecycle.");
  }
}

export function acquireBoatLifecycle(
  runtime: string,
  mode: "recover" | "mutate" | "cli",
): () => void {
  const fd = NodeFS.openSync(
    NodePath.join(runtime, LIFECYCLE_LOCK),
    NodeFS.constants.O_CREAT | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_RDONLY,
    0o600,
  );
  try {
    // flock locks the open file description. The parent retains it after flock exits.
    const result = NodeChildProcess.spawnSync(
      "flock",
      [...(mode === "cli" ? ["-s"] : []), "-n", "-E", "75", "3"],
      {
        stdio: ["ignore", "ignore", "ignore", fd],
        timeout: 2_000,
      },
    );
    if (result.status === 75) throw new BoatLifecycleBusy();
    if (result.status !== 0) throw result.error ?? new Error("Boat lifecycle flock failed.");
    if (readOptional(NodePath.join(runtime, BOAT_BOOT_OPERATION)) !== undefined) {
      throw new BoatLifecycleBusy();
    }
    if (mode !== "recover") {
      const raw = readOptional(NodePath.join(runtime, SERVICE_STATE_FILE));
      if (raw === undefined && mode === "cli") {
        throw new Error("The pinned Boat service journal is missing.");
      }
      if (raw !== undefined) {
        const state = parseServiceState(raw);
        if (
          state?.maintenance !== undefined ||
          state?.update?.status === "pending" ||
          (state === undefined && parseLegacyServiceState(raw) === undefined)
        ) {
          throw new Error("The Boat service journal requires launcher recovery.");
        }
      }
    }
    return () => NodeFS.closeSync(fd);
  } catch (error) {
    NodeFS.closeSync(fd);
    throw error;
  }
}

export function acquireBoatMutation(baseDir: string): () => void {
  const runtime = boatRuntime(baseDir);
  return runtime === undefined ? () => {} : acquireBoatLifecycle(runtime, "mutate");
}

export function acquireBoatCliMutation(baseDir: string): () => void {
  const runtime = boatRuntime(baseDir);
  return runtime === undefined ? () => {} : acquireBoatLifecycle(runtime, "cli");
}

const SERVICE = "t3code.service";
const CGROUP_ROOT = "/sys/fs/cgroup";

function systemdProperties(unit: string, property: string) {
  const result = NodeChildProcess.spawnSync(
    "systemctl",
    ["--user", "show", "--property=" + property, "--", unit],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0) throw new Error(`Could not inspect Boat unit ${unit}.`);
  return new Map(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function populated(directory: string): boolean {
  const events = readOptional(NodePath.join(directory, "cgroup.events"));
  if (events === undefined) throw new Error("The Boat cgroup is unobservable.");
  const state = /^populated ([01])$/m.exec(events)?.[1];
  if (state === undefined) throw new Error("The Boat cgroup population is unobservable.");
  return state === "1";
}

function subgroupsAreEmpty(directory: string): boolean {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).every(
    (entry) => !entry.isDirectory() || !populated(NodePath.join(directory, entry.name)),
  );
}

export function openBoatCoordinator(runtime: string, serviceUnit: string | undefined) {
  const baseDir = NodePath.dirname(runtime);
  const installationId = NodeFS.readFileSync(
    NodePath.join(runtime, INSTALLATION_ID),
    "utf8",
  ).trim();
  const environmentId = NodeFS.readFileSync(
    NodePath.join(baseDir, "userdata", "environment-id"),
    "utf8",
  ).trim();
  if (installationId === "" || environmentId === "") throw new Error("Incomplete Boat identity.");

  const controlGroup = /^0::(\/[^\n]+)$/m.exec(
    NodeFS.readFileSync("/proc/self/cgroup", "utf8"),
  )?.[1];
  if (
    serviceUnit !== SERVICE ||
    controlGroup === undefined ||
    !controlGroup.endsWith("/" + SERVICE)
  ) {
    return undefined;
  }
  const directory = NodePath.join(CGROUP_ROOT, controlGroup);
  const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const pid = process.pid;
  const stat = NodeFS.readFileSync("/proc/self/stat", "utf8");
  const launcherStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (launcherStart === undefined) throw new Error("Cannot read the Boat launcher start time.");
  const assertCgroupsIdle = (incumbentPid?: number) => {
    const service = systemdProperties(SERVICE, "MainPID,ActiveState,ControlGroup,Job");
    if (
      service.get("MainPID") !== String(pid) ||
      service.get("ActiveState") !== "active" ||
      service.get("ControlGroup") !== controlGroup ||
      service.get("Job") !== "" ||
      !controlGroup.endsWith("/app.slice/" + SERVICE)
    ) {
      throw new Error("The Boat service cgroup does not match the running launcher.");
    }

    const expected = new Set([String(pid)]);
    if (incumbentPid !== undefined) expected.add(String(incumbentPid));
    const assertServiceMembers = () => {
      const processes = new Set(
        NodeFS.readFileSync(NodePath.join(directory, "cgroup.procs"), "utf8").trim().split(/\s+/),
      );
      if (
        processes.size !== expected.size ||
        [...expected].some((id) => !processes.has(id)) ||
        !subgroupsAreEmpty(directory)
      ) {
        throw new Error("The Boat service cgroup contains unexpected processes.");
      }
    };
    assertServiceMembers();

    // This parent contains both the shared restart-surviving slice and per-home agent slices.
    const agentUnit = "app-t3code.slice";
    const agentGroup = NodePath.join(NodePath.dirname(controlGroup), agentUnit);
    const agentDirectory = NodePath.join(CGROUP_ROOT, agentGroup);
    const agent = systemdProperties(agentUnit, "ActiveState,ControlGroup,Job,LoadState");
    const group = agent.get("ControlGroup");
    if (
      agent.get("Job") !== "" ||
      agent.get("LoadState") !== "loaded" ||
      (group === agentGroup
        ? agent.get("ActiveState") !== "active" || populated(agentDirectory)
        : group !== "" ||
          agent.get("ActiveState") !== "inactive" ||
          NodeFS.lstatSync(agentDirectory, { throwIfNoEntry: false }) !== undefined)
    ) {
      throw new Error("The Boat agent slices are occupied or unobservable.");
    }

    // Scope launch can move a process between the service and agent slice.
    assertServiceMembers();
  };

  return {
    installation: { baseDir, installationId, environmentId },
    drainBudgetMs: 5_000,
    assertPreCutover: (incumbentPid: number) => assertCgroupsIdle(incumbentPid),
    assertReaped: () => assertCgroupsIdle(),
    acquire: async ({ signal }: { readonly signal: AbortSignal }) => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          return acquireBoatLifecycle(runtime, "recover");
        } catch (error) {
          if (!(error instanceof BoatLifecycleBusy) || attempt >= 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    automatic: {
      runtime,
      bootId,
      pid,
      launcherStart,
      readRequest: () => {
        const raw = readOptional(NodePath.join(runtime, BOAT_REQUEST));
        if (raw === undefined) return undefined;
        const request: unknown = JSON.parse(raw);
        if (
          typeof request !== "object" ||
          request === null ||
          !("bootId" in request) ||
          request.bootId !== bootId ||
          !("instanceId" in request) ||
          typeof request.instanceId !== "string" ||
          !("requestId" in request) ||
          typeof request.requestId !== "string" ||
          !("release" in request)
        )
          return undefined;
        const release = decodeStagedSailRelease(request.release);
        return release === undefined
          ? undefined
          : { requestId: request.requestId, instanceId: request.instanceId, release };
      },
    },
  };
}

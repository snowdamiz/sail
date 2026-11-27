import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const home = NodePath.join(NodeOS.homedir(), ".t3");
const runtime = NodePath.join(home, "runtime");
function processStat(pid) {
  const text = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ");
}
const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
export const sandboxBoot = `${bootId}:${processStat(1)[19]}`;
const powerPath = NodePath.join(runtime, "boat-power-operation");
const installationPath = NodePath.join(runtime, "boat-installation-id");
const configPath = NodePath.join(NodeOS.homedir(), ".sail-boat", "config.json");
export const enrolled = () => NodeFS.existsSync(installationPath);

function readJson(file) {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

function sync(file) {
  const fd = NodeFS.openSync(file, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function writeJson(file, value) {
  const temporary = `${file}.${NodeCrypto.randomUUID()}`;
  try {
    NodeFS.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    sync(temporary);
    NodeFS.renameSync(temporary, file);
    sync(NodePath.dirname(file));
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

function clearPower() {
  NodeFS.rmSync(powerPath);
  sync(runtime);
}

function lock() {
  const canonical = NodePath.join(NodeFS.realpathSync(home), "runtime");
  if (NodeFS.realpathSync(runtime) !== canonical)
    throw new Error("Boat runtime must be canonical.");
  const fd = NodeFS.openSync(
    NodePath.join(runtime, "boat-lifecycle.lock"),
    NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_RDONLY | NodeFS.constants.O_CREAT,
    0o600,
  );
  try {
    const held = NodeChildProcess.spawnSync("flock", ["-n", "-E", "75", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout: 2000,
    });
    if (held.status !== 0) throw held.error ?? new Error("Boat lifecycle is unavailable.");
    return fd;
  } catch (error) {
    NodeFS.closeSync(fd);
    throw error;
  }
}

function assertIdle() {
  if (NodeFS.existsSync(powerPath)) throw new Error("A Boat power operation is unresolved.");
  const state = readJson(NodePath.join(runtime, "service-state.json"));
  if (
    !state ||
    ![2, 3, 4].includes(state.protocol) ||
    typeof state.activeVersion !== "string" ||
    state.update?.status === "pending" ||
    state.maintenance !== undefined
  ) {
    throw new Error("Boat service selection needs launcher recovery.");
  }
}

export function reservePower(kind, sandbox) {
  const fd = lock();
  try {
    assertIdle();
    writeJson(powerPath, { kind, sandbox, bootId });
    return fd;
  } catch (error) {
    NodeFS.closeSync(fd);
    throw error;
  }
}

export function finishSnapshot(fd) {
  try {
    clearPower();
  } finally {
    NodeFS.closeSync(fd);
  }
}

export function acknowledgeResume(sandbox) {
  const fd = lock();
  try {
    const pending = readJson(powerPath);
    if (pending !== undefined) {
      if (pending.kind !== "stop" || pending.sandbox !== sandbox) {
        throw new Error("A conflicting Boat power operation is unresolved.");
      }
      clearPower();
    }
    const config = readJson(configPath);
    if (config?.sandbox !== sandbox) throw new Error("Boat sandbox identity changed.");
    if (config.bootId !== sandboxBoot) {
      writeJson(configPath, { ...config, bootId: sandboxBoot });
    }
  } finally {
    NodeFS.closeSync(fd);
  }
}

function currentReady() {
  const capability = readJson(NodePath.join(runtime, "boat-maintenance-capability.json"));
  const state = readJson(NodePath.join(runtime, "service-state.json"));
  if (
    !capability ||
    !state ||
    state.protocol !== 4 ||
    state.maintenance !== undefined ||
    state.update?.status === "pending" ||
    state.activeVersion !== capability.version ||
    capability.bootId !== bootId ||
    capability.installationId !== NodeFS.readFileSync(installationPath, "utf8").trim()
  )
    return;
  try {
    const [state, parent] = processStat(capability.childPid);
    const launcher = processStat(capability.launcherPid);
    if (
      state === "Z" ||
      Number(parent) !== capability.launcherPid ||
      launcher[0] === "Z" ||
      launcher[19] !== capability.launcherStart
    )
      return;
  } catch {
    return;
  }
  return capability;
}

export function readyReceipt() {
  if (!enrolled()) return;
  const capability = currentReady();
  const receipt = readJson(NodePath.join(runtime, "boat-maintenance-ready.json"));
  if (
    capability &&
    receipt?.release?.version === capability.version &&
    receipt.environmentId === capability.environmentId &&
    receipt.installationId === capability.installationId
  )
    return receipt;
}

function recoverRestore(sandbox) {
  const fd = lock();
  try {
    const previous = readJson(configPath);
    const pending = readJson(powerPath);
    if (
      previous?.sandbox !== sandbox &&
      pending?.sandbox === previous?.sandbox &&
      (pending?.kind === "snapshot" || pending?.kind === "stop")
    ) {
      // This journal was copied from a different sandbox. Its operation cannot stop this clone.
      clearPower();
    } else if (pending !== undefined) {
      throw new Error("A Boat power operation is unresolved.");
    }
  } finally {
    NodeFS.closeSync(fd);
  }
}

export function maintenanceEligible() {
  if (!enrolled()) return false;
  return currentReady()?.censusComplete === true;
}

function stageWake(target, installerUrl, environmentId, sandbox) {
  if (!enrolled()) return;
  const config = readJson(configPath);
  if (config?.sandbox !== sandbox) return;
  const capability = currentReady();
  if (
    capability?.environmentId !== environmentId ||
    !capability.censusComplete ||
    capability.version === target
  )
    return;
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sail-boat-stage-"));
  try {
    const installer = NodePath.join(temporary, "install.sh");
    const download = NodeChildProcess.spawnSync("curl", [
      "-fsSL",
      "--max-time",
      "60",
      "-o",
      installer,
      installerUrl,
    ]);
    if (download.status !== 0) throw new Error("Could not download the Sail stage installer.");
    const stage = NodeChildProcess.spawnSync(
      "timeout",
      ["-k", "5s", "480s", "sh", installer, "--stage-only"],
      { encoding: "utf8", env: { ...process.env, T3CODE_HOME: home, T3CODE_VERSION: target } },
    );
    if (stage.status !== 0) throw new Error(`Sail staging failed: ${stage.stderr ?? ""}`);
    const archiveSha256 = stage.stdout.trim();
    const fd = lock();
    try {
      assertIdle();
      if (currentReady()?.instanceId !== capability.instanceId) return;
      const treeSha256 = NodeFS.readFileSync(
        NodePath.join(runtime, "boat-staged", target, ".sail-tree-sha256"),
        "utf8",
      ).trim();
      if (![archiveSha256, treeSha256].every((value) => /^[0-9a-f]{64}$/.test(value))) {
        throw new Error("Invalid Sail staging receipt.");
      }
      writeJson(NodePath.join(runtime, "boat-maintenance-request.json"), {
        bootId,
        requestId: NodeCrypto.randomUUID(),
        instanceId: capability.instanceId,
        release: { version: target, archiveSha256, treeSha256 },
      });
    } finally {
      NodeFS.closeSync(fd);
    }
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [action, first, second, third, fourth] = process.argv.slice(2);
  switch (action) {
    case "boot":
      console.log(sandboxBoot);
      break;
    case "restore":
      if (enrolled()) recoverRestore(first);
      break;
    case "wake":
      stageWake(first, second, third, fourth);
      break;
    case "retire":
      if (enrolled()) {
        if (readJson(configPath)?.sandbox !== first)
          throw new Error("Boat sandbox identity changed.");
        const pending = readJson(powerPath);
        if (pending?.kind !== "retire" || pending.sandbox !== first) {
          NodeFS.closeSync(reservePower("retire", first));
        }
      }
      break;
    default:
      throw new Error("Unknown Boat lifecycle command.");
  }
}

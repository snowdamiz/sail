// @effect-diagnostics nodeBuiltinImport:off -- The stable launcher runs without Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { StagedSailRelease } from "./serviceProtocol.ts";

async function sync(path: string) {
  const handle = await NodeFSP.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function stagedTreeSha256(root: string, signal: AbortSignal, durable = false) {
  const tree = NodeCrypto.createHash("sha256");
  const visit = async (relative: string): Promise<void> => {
    signal.throwIfAborted();
    const path = NodePath.join(root, relative);
    const stat = await NodeFSP.lstat(path);
    if (stat.isDirectory()) {
      tree.update(JSON.stringify([relative, "directory"]));
      for (const name of (await NodeFSP.readdir(path)).sort()) {
        await visit(relative === "" ? name : NodePath.join(relative, name));
      }
    } else if (stat.isFile() && relative !== "") {
      const content = NodeCrypto.createHash("sha256");
      for await (const chunk of NodeFS.createReadStream(path, { signal })) content.update(chunk);
      tree.update(JSON.stringify([relative, "file", stat.mode & 0o777, content.digest("hex")]));
    } else {
      throw new Error("Unsupported entry in staged Sail runtime.");
    }
    if (durable) await sync(path);
  };
  await visit("");
  return tree.digest("hex");
}

export async function verifyStagedSailRelease(
  path: string,
  release: StagedSailRelease,
  signal: AbortSignal,
  durable = false,
) {
  if (
    (await NodeFSP.realpath(path)) !== path ||
    (await stagedTreeSha256(path, signal, durable)) !== release.treeSha256 ||
    (await NodeFSP.readFile(NodePath.join(path, ".install-complete"), "utf8")).trim() !==
      release.version ||
    (await NodeFSP.readFile(NodePath.join(path, ".sail-product"), "utf8")).trim() !== "sail" ||
    (await NodeFSP.readFile(NodePath.join(path, ".sail-archive-sha256"), "utf8")).trim() !==
      release.archiveSha256
  ) {
    throw new Error("The staged Sail runtime does not match its verified release.");
  }
  await NodeFSP.access(NodePath.join(path, "t3"), NodeFS.constants.X_OK);
}

async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

const stagedPath = (baseDir: string, version: string) =>
  NodePath.join(baseDir, "runtime", "boat-staged", version);

export async function checkStagedSailRelease(
  baseDir: string,
  release: StagedSailRelease,
  target: string,
  signal: AbortSignal,
) {
  const versions = NodePath.dirname(target);
  if ((await NodeFSP.realpath(versions)) !== versions || (await exists(target))) {
    throw new Error("The Sail runtime's canonical version slot must be vacant.");
  }
  await verifyStagedSailRelease(stagedPath(baseDir, release.version), release, signal);
}

export async function publishStagedSailRelease(
  baseDir: string,
  release: StagedSailRelease,
  target: string,
  updateId: string,
  signal: AbortSignal,
) {
  const versions = NodePath.dirname(target);
  const temporary = NodePath.join(versions, `.boat-stage-\${updateId}`);
  await NodeFSP.mkdir(temporary, { mode: 0o700 });
  try {
    await NodeFSP.cp(stagedPath(baseDir, release.version), temporary, { recursive: true });
    await verifyStagedSailRelease(temporary, release, signal, true);
    if (await exists(target)) throw new Error("The Sail runtime version slot is occupied.");
    await NodeFSP.rename(temporary, target);
    await sync(versions);
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}

export async function removeMaintenanceRuntime(
  target: string,
  release: StagedSailRelease,
  updateId: string,
  signal: AbortSignal,
) {
  const versions = NodePath.dirname(target);
  const temporary = NodePath.join(versions, `.boat-stage-\${updateId}`);
  await NodeFSP.rm(temporary, { recursive: true, force: true });
  if (await exists(target)) {
    await verifyStagedSailRelease(target, release, signal);
    await NodeFSP.rename(target, temporary);
    await sync(versions);
    await NodeFSP.rm(temporary, { recursive: true });
  }
  await sync(versions);
}

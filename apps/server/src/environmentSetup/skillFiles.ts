// @effect-diagnostics nodeBuiltinImport:off - bounded reads require O_NOFOLLOW and O_NONBLOCK.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  EnvironmentSetupSkillPath,
  EnvironmentSetupSkillRoot,
  MAX_ENVIRONMENT_SETUP_BYTES,
  MAX_ENVIRONMENT_SETUP_FILES,
  environmentSetupSkillRoots,
  type EnvironmentSetupSkillFile,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isPortablePath = Schema.is(EnvironmentSetupSkillPath);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function fileInfo(file: string) {
  try {
    return await NodeFSP.lstat(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function directoryWithin(home: string, segments: readonly string[], create = false) {
  let directory = home;
  for (const segment of segments) {
    directory = NodePath.join(directory, segment);
    let info = await fileInfo(directory);
    if (info === undefined) {
      if (!create) return undefined;
      await NodeFSP.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
      info = await fileInfo(directory);
    }
    if (!info?.isDirectory() || (await NodeFSP.realpath(directory)) !== directory) {
      throw new Error("A skill directory is not a regular directory.");
    }
  }
  return directory;
}

async function readFile(
  file: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; executable: boolean } | undefined> {
  const info = await fileInfo(file);
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) {
    throw new Error("A skill file is linked, oversized, or not a regular file.");
  }
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > maxBytes
    ) {
      throw new Error("A skill file changed while it was being read.");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("A skill file changed while it was being read.");
    return { bytes: buffer.subarray(0, offset), executable: (opened.mode & 0o100) !== 0 };
  } finally {
    await handle.close();
  }
}

export async function exportSkillFiles(home: string) {
  const files: EnvironmentSetupSkillFile[] = [];
  let remainingBytes = MAX_ENVIRONMENT_SETUP_BYTES;
  let entries = 0;
  const countEntry = () => {
    if (++entries > MAX_ENVIRONMENT_SETUP_FILES * 4) {
      throw new Error("Too many entries in the user skill directories.");
    }
  };
  const walk = async (
    root: EnvironmentSetupSkillRoot,
    rootSegments: readonly string[],
    relative: readonly string[],
  ) => {
    const directory = await directoryWithin(home, [...rootSegments, ...relative]);
    if (directory === undefined) return;
    for await (const entry of await NodeFSP.opendir(directory)) {
      countEntry();
      if (entry.name.startsWith(".")) continue;
      const segments = [...relative, entry.name];
      const filePath = segments.join("/");
      if (!isPortablePath(filePath)) throw new Error("A skill file has an unsupported name.");
      if (entry.isDirectory()) {
        await walk(root, rootSegments, segments);
        continue;
      }
      if (files.length >= MAX_ENVIRONMENT_SETUP_FILES) throw new Error("Too many skill files.");
      const source = await readFile(NodePath.join(directory, entry.name), remainingBytes);
      if (source === undefined) throw new Error("A skill file disappeared during export.");
      const { bytes, executable } = source;
      remainingBytes -= bytes.length;
      const fields = { root, path: filePath, ...(executable ? { executable } : {}) };
      try {
        files.push({ ...fields, encoding: "utf8", content: utf8.decode(bytes) });
      } catch {
        files.push({ ...fields, encoding: "base64", content: bytes.toString("base64") });
      }
    }
  };
  for (const root of EnvironmentSetupSkillRoot.literals) {
    const rootSegments = environmentSetupSkillRoots[root];
    const directory = await directoryWithin(home, rootSegments);
    if (directory === undefined) continue;
    for await (const entry of await NodeFSP.opendir(directory)) {
      countEntry();
      if (!entry.isDirectory() || !isPortablePath(`${entry.name}/SKILL.md`)) continue;
      const skillDirectory = await directoryWithin(home, [...rootSegments, entry.name]);
      if (skillDirectory && (await fileInfo(NodePath.join(skillDirectory, "SKILL.md")))) {
        await walk(root, rootSegments, [entry.name]);
      }
    }
  }
  return files.sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path));
}

const skillFileBytes = (file: EnvironmentSetupSkillFile) =>
  Buffer.from(file.content, file.encoding);

export function validateSkillFileList(files: readonly EnvironmentSetupSkillFile[]) {
  const spellings = new Map<string, string>();
  const directories = new Set<string>();
  const paths = new Set<string>();
  const folders = new Set<string>();
  for (const file of files) {
    const segments = file.path.split("/");
    folders.add(`${file.root}/${segments[0]}/SKILL.md`);
    let prefix: string = file.root;
    for (const [index, segment] of segments.entries()) {
      prefix += `/${segment}`;
      const key = prefix.toLowerCase();
      const spelling = spellings.get(key);
      if (spelling !== undefined && spelling !== prefix) return false;
      spellings.set(key, prefix);
      if (index < segments.length - 1) directories.add(prefix);
    }
    if (paths.has(prefix)) return false;
    paths.add(prefix);
  }
  return (
    [...folders].every((entry) => paths.has(entry)) &&
    [...paths].every((entry) => !directories.has(entry))
  );
}

function fingerprint(info: NodeFS.Stats | undefined) {
  if (info === undefined) return undefined;
  if (!info.isFile() || info.nlink !== 1) throw new Error("Expected a regular skill file.");
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(":");
}

export async function inspectSkillFiles(
  home: string,
  files: readonly EnvironmentSetupSkillFile[],
  platform: NodeJS.Platform,
) {
  const changes = [];
  for (const file of files) {
    const segments = file.path.split("/");
    const name = segments.pop()!;
    const parents = [...environmentSetupSkillRoots[file.root], ...segments];
    const directory = await directoryWithin(home, parents);
    const bytes = skillFileBytes(file);
    const destination = directory === undefined ? undefined : NodePath.join(directory, name);
    const info = destination === undefined ? undefined : await fileInfo(destination);
    const existing = fingerprint(info);
    const previous =
      destination !== undefined && info?.size === bytes.length
        ? await readFile(destination, bytes.length)
        : undefined;
    if (
      previous?.bytes.equals(bytes) &&
      (platform === "win32" || previous.executable === (file.executable ?? false))
    )
      continue;
    changes.push({ file, parents, name, bytes, existing });
  }
  return changes;
}

export async function writeSkillFiles(
  home: string,
  changes: Awaited<ReturnType<typeof inspectSkillFiles>>,
  platform: NodeJS.Platform,
) {
  for (const { file, parents, name, bytes, existing } of changes) {
    const directory = await directoryWithin(home, parents, true);
    if (directory === undefined) throw new Error("The skill directory is unavailable.");
    const parent =
      platform === "linux"
        ? await NodeFSP.open(directory, NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW)
        : undefined;
    const anchor = parent === undefined ? directory : `/proc/self/fd/${parent.fd}`;
    try {
      const initial = await NodeFSP.stat(anchor);
      const checkDirectory = async () => {
        const current = await fileInfo(directory);
        if (
          (await directoryWithin(home, parents)) !== directory ||
          (await NodeFSP.realpath(anchor)) !== directory ||
          initial.dev !== current?.dev ||
          initial.ino !== current.ino
        ) {
          throw new Error("The skill directory changed. Preview the copy again.");
        }
      };
      await checkDirectory();
      const destination = NodePath.join(anchor, name);
      const staging = NodePath.join(anchor, `.sail-setup-${NodeCrypto.randomUUID()}`);
      const mode = file.executable ? 0o700 : 0o600;
      const handle = await NodeFSP.open(staging, "wx", mode);
      try {
        await handle.writeFile(bytes);
        if (platform !== "win32") await handle.chmod(mode);
        await handle.close();
        await checkDirectory();
        if (fingerprint(await fileInfo(destination)) !== existing) {
          throw new Error("A skill file changed. Preview the copy again.");
        }
        await NodeFSP.rename(staging, destination);
      } finally {
        await handle.close();
        if (parent === undefined) await checkDirectory();
        await NodeFSP.rm(staging, { force: true });
      }
    } finally {
      await parent?.close();
    }
  }
}

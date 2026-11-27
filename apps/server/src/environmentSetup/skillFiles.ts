// @effect-diagnostics nodeBuiltinImport:off - bounded reads require O_NOFOLLOW and O_NONBLOCK.
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
    return await NodeFSP.lstat(file, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

const identity = ({ dev, ino }: NodeFS.BigIntStats) => `${dev}:${ino}`;

async function directoryIdentity(directory: string) {
  const info = await fileInfo(directory);
  if (info === undefined) return null;
  if (!info.isDirectory() || (await NodeFSP.realpath(directory)) !== directory) {
    throw new Error("A skill directory is not a regular directory.");
  }
  return identity(info);
}

async function directoryWithin(home: string, segments: readonly string[]) {
  let directory = home;
  for (const segment of segments) {
    directory = NodePath.join(directory, segment);
    if ((await directoryIdentity(directory)) === null) return undefined;
  }
  return directory;
}

async function snapshotDirectories(home: string, parents: readonly string[]) {
  const homeIdentity = await directoryIdentity(home);
  if (homeIdentity === null) throw new Error("The user home is unavailable.");
  const snapshot: Array<{ directory: string; id: string | null }> = [
    { directory: home, id: homeIdentity },
  ];
  let directory = home;
  let id: string | null = homeIdentity;
  for (const segment of parents) {
    directory = NodePath.join(directory, segment);
    if (id !== null) id = await directoryIdentity(directory);
    snapshot.push({ directory, id });
  }
  return snapshot;
}

async function readFile(
  file: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; executable: boolean } | undefined> {
  const info = await fileInfo(file);
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1n || info.size > maxBytes) {
    throw new Error("A skill file is linked, oversized, or not a regular file.");
  }
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > maxBytes
    ) {
      throw new Error("A skill file changed while it was being read.");
    }
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (BigInt(offset) !== opened.size)
      throw new Error("A skill file changed while it was being read.");
    return { bytes: buffer.subarray(0, offset), executable: (opened.mode & 0o100n) !== 0n };
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

function fingerprint(info: NodeFS.BigIntStats | undefined) {
  if (info === undefined) return null;
  if (!info.isFile() || info.nlink !== 1n) throw new Error("Expected a regular skill file.");
  return {
    version: [identity(info), info.size, info.mtimeNs, info.mode].join(":"),
    ctime: info.ctimeNs.toString(),
  };
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
    const directories = await snapshotDirectories(home, parents);
    const parent = directories.at(-1);
    const destination = parent?.id ? NodePath.join(parent.directory, name) : undefined;
    const bytes = skillFileBytes(file);
    const info = destination === undefined ? undefined : await fileInfo(destination);
    const existing = fingerprint(info);
    const previous =
      destination !== undefined && info?.size === BigInt(bytes.length)
        ? await readFile(destination, bytes.length)
        : undefined;
    if (
      previous?.bytes.equals(bytes) &&
      (platform === "win32" || previous.executable === (file.executable ?? false))
    )
      continue;
    changes.push({ file, parents, directories, name, bytes, existing });
  }
  return changes;
}

export class SkillWriteError extends Schema.TaggedError<
  SkillWriteError,
  { readonly brand: unique symbol }
>()("SkillWriteError", { message: Schema.String }) {}

async function publishSkillFile({
  home,
  anchor,
  directory,
  change,
  platform,
  checkDirectory,
}: {
  home: string;
  anchor: string;
  directory: string;
  change: Awaited<ReturnType<typeof inspectSkillFiles>>[number];
  platform: NodeJS.Platform;
  checkDirectory: () => Promise<void>;
}) {
  const { file, name, bytes, existing } = change;
  const destination = NodePath.join(anchor, name);
  const checkDestination = async () => {
    const current = fingerprint(await fileInfo(destination));
    if (current?.version !== existing?.version || current?.ctime !== existing?.ctime) {
      throw new Error("The target skill file changed.");
    }
  };
  await checkDirectory();
  await checkDestination();
  const staging = await NodeFSP.mkdtemp(NodePath.join(anchor, ".sail-setup-"));
  const stagingInfo = await NodeFSP.lstat(staging, { bigint: true });
  const incoming = NodePath.join(staging, ".incoming");
  const probe = NodePath.join(staging, ".link-check");
  const original = NodePath.join(staging, name);
  const checkStaging = async () => {
    await checkDirectory();
    const info = await fileInfo(staging);
    if (!info?.isDirectory() || identity(info) !== identity(stagingInfo)) {
      throw new Error("The skill staging directory changed.");
    }
  };
  let displaced = false;
  let cleaned = false;
  try {
    await checkStaging();
    const mode = file.executable ? 0o700 : 0o600;
    const handle = await NodeFSP.open(incoming, "wx", mode);
    try {
      await handle.writeFile(bytes);
      if (platform !== "win32") await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    if (existing !== null) {
      // Verify hard-link support before moving the original out of the way.
      await checkStaging();
      await NodeFSP.link(incoming, probe);
      await NodeFSP.unlink(probe);
    }
    await checkStaging();
    await checkDestination();
    if (existing !== null) {
      await NodeFSP.rename(destination, original);
      displaced = true;
      // A rename can change ctime. Keep the original inode even after a successful copy.
      if (fingerprint(await fileInfo(original))?.version !== existing.version) {
        throw new Error("The target skill file changed.");
      }
      await checkStaging();
    }
    await NodeFSP.link(incoming, destination);
  } catch (error) {
    if (!displaced) throw error;
    const recovery = NodePath.relative(
      home,
      NodePath.join(directory, NodePath.basename(staging), name),
    );
    throw new SkillWriteError({
      message: `The skill copy stopped. Look for the original file at "${recovery}" under the target home. Preview the copy again.`,
    });
  } finally {
    cleaned = await (async () => {
      await checkStaging();
      await NodeFSP.rm(incoming, { force: true });
      await NodeFSP.rm(probe, { force: true });
      if (!displaced) await NodeFSP.rmdir(staging);
      return true;
    })().catch(() => false);
  }
  if (!cleaned) {
    throw new SkillWriteError({
      message:
        "A skill file was published but its staging directory changed or could not be cleaned. Preview the copy again.",
    });
  }
}

export async function writeSkillFiles({
  home,
  configuredHome,
  changes,
  platform,
}: {
  home: string;
  configuredHome: string;
  changes: Awaited<ReturnType<typeof inspectSkillFiles>>;
  platform: NodeJS.Platform;
}) {
  const created = new Map<string, string>();
  for (const change of changes) {
    const { parents, directories } = change;
    const checkDirectories = async () => {
      if (configuredHome !== home && (await NodeFSP.realpath(configuredHome)) !== home) {
        throw new Error("The target home changed.");
      }
      const current = await snapshotDirectories(home, parents);
      for (const [index, { directory, id }] of directories.entries()) {
        if (current[index]?.id !== (id ?? created.get(directory) ?? null)) {
          throw new Error("A target skill directory changed.");
        }
      }
    };
    for (const { directory, id } of directories) {
      if (id !== null || created.has(directory)) continue;
      await checkDirectories();
      await NodeFSP.mkdir(directory, { mode: 0o700 });
      const createdId = await directoryIdentity(directory);
      if (createdId === null) throw new Error("A created skill directory disappeared.");
      created.set(directory, createdId);
    }
    await checkDirectories();
    const directory = NodePath.join(home, ...parents);
    const parent =
      platform === "linux"
        ? await NodeFSP.open(directory, NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW)
        : undefined;
    // Linux anchors publication to the open parent. macOS and Windows resolve pathnames.
    // Even an open parent can move, so the checks depend on a stable directory tree.
    const anchor = parent === undefined ? directory : `/proc/self/fd/${parent.fd}`;
    try {
      const checkDirectory = async () => {
        await checkDirectories();
        if (parent !== undefined) {
          const expected = directories.at(-1)?.id ?? created.get(directory);
          if (
            (await NodeFSP.realpath(anchor)) !== directory ||
            identity(await parent.stat({ bigint: true })) !== expected
          ) {
            throw new Error("The open target skill directory changed.");
          }
        }
      };
      await publishSkillFile({ home, anchor, directory, change, platform, checkDirectory });
    } finally {
      await parent?.close();
    }
  }
}

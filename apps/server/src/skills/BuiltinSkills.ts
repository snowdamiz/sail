// @effect-diagnostics nodeBuiltinImport:off -- Atomic symlink swap and synchronous startup materialization use node:fs/path/crypto.
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parse as parseYamlDocument } from "yaml";

import type * as ServerConfig from "../config.ts";

export const BUILTIN_PSTACK_PACK_ID = "pstack" as const;
const BUILTIN_PSTACK_PREFIX = `${BUILTIN_PSTACK_PACK_ID}:`;
const PACK_HASH_FILENAME = ".pack-hash";
const SENTINEL_SKILL_RELATIVE_PATH = NodePath.join("poteto-mode", "SKILL.md");
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LEADING_SLASH_COMMAND_PATTERN = /^\s*\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/;
const STALE_TMP_AGE_MS = 60_000;

export interface MaterializedBuiltinSkillPack {
  readonly id: typeof BUILTIN_PSTACK_PACK_ID;
  readonly hash: string;
  readonly pluginDir: string;
  readonly skillsDir: string;
  readonly versionDir: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export interface BuiltinSkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
}

export interface ResolveBundledPstackOptions {
  readonly sourceDir?: string;
  readonly execPath?: string;
}

export interface MaterializeBuiltinPstackOptions extends ResolveBundledPstackOptions {
  readonly platform?: NodeJS.Platform;
  readonly nowMs?: number;
}

function resolveBuiltinSkillsDir(
  config: Pick<ServerConfig.ServerConfig["Service"], "stateDir" | "builtinSkillsDir">,
): string {
  return config.builtinSkillsDir ?? NodePath.join(config.stateDir, "builtin-skills");
}

function isValidPstackSourceDir(candidate: string): boolean {
  try {
    return NodeFS.statSync(
      NodePath.join(candidate, "skills", SENTINEL_SKILL_RELATIVE_PATH),
    ).isFile();
  } catch {
    return false;
  }
}

export function resolveBundledPstackSourceDir(
  options: ResolveBundledPstackOptions = {},
): string | undefined {
  const candidates: Array<string> = [];
  if (options.sourceDir) {
    candidates.push(NodePath.resolve(options.sourceDir));
  }
  const execPath = options.execPath ?? HostProcess.ExecutablePath.defaultValue();
  if (execPath) {
    candidates.push(
      NodePath.resolve(NodePath.dirname(execPath), "builtin-skills", BUILTIN_PSTACK_PACK_ID),
    );
  }
  candidates.push(
    NodePath.resolve(import.meta.dirname, "builtin-skills", BUILTIN_PSTACK_PACK_ID),
    NodePath.resolve(import.meta.dirname, "..", "builtin-skills", BUILTIN_PSTACK_PACK_ID),
    NodePath.resolve(import.meta.dirname, "..", "..", "builtin-skills", BUILTIN_PSTACK_PACK_ID),
  );

  for (const candidate of candidates) {
    if (isValidPstackSourceDir(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

export function parseBuiltinSkillFrontmatter(
  contents: string,
): BuiltinSkillFrontmatter | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;

  const frontmatter = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(frontmatter);
  } catch {
    const repaired = frontmatter.replace(
      /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
      (line, prefix: string, value: string) => {
        const scalar = value.split(/[ \t]+#/)[0] ?? "";
        if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
          return line;
        }
        return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
      },
    );
    try {
      parsed = parseYamlDocument(repaired);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

function shouldSkipPackEntry(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === ".DS_Store";
}

function collectPackFiles(rootDir: string, currentRel = ""): Array<string> {
  const currentAbs = currentRel ? NodePath.join(rootDir, currentRel) : rootDir;
  const entries = NodeFS.readdirSync(currentAbs, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const files: Array<string> = [];
  for (const entry of entries) {
    if (shouldSkipPackEntry(entry.name)) continue;
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectPackFiles(rootDir, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function computeDirectoryHash(rootDir: string): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const rel of collectPackFiles(rootDir)) {
    const abs = NodePath.join(rootDir, ...rel.split("/"));
    const stat = NodeFS.statSync(abs);
    hash.update(rel);
    hash.update("\0");
    hash.update(String(stat.mode & 0o111));
    hash.update("\0");
    hash.update(NodeFS.readFileSync(abs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function copyTreeClean(sourceDir: string, targetDir: string): void {
  NodeFS.mkdirSync(targetDir, { recursive: true });
  for (const entry of NodeFS.readdirSync(sourceDir, { withFileTypes: true })) {
    if (shouldSkipPackEntry(entry.name)) continue;
    const src = NodePath.join(sourceDir, entry.name);
    const dst = NodePath.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeClean(src, dst);
    } else if (entry.isFile()) {
      NodeFS.copyFileSync(src, dst);
      const mode = NodeFS.statSync(src).mode;
      if ((mode & 0o111) !== 0) {
        try {
          NodeFS.chmodSync(dst, mode & 0o777);
        } catch {}
      }
    }
  }
}

function symlinkPointsTo(linkPath: string, targetDir: string): boolean {
  try {
    const lstat = NodeFS.lstatSync(linkPath);
    if (!lstat.isSymbolicLink()) return false;
    return NodeFS.realpathSync(linkPath) === NodeFS.realpathSync(targetDir);
  } catch {
    return false;
  }
}

function atomicSwapSymlink(
  packRoot: string,
  linkPath: string,
  versionDir: string,
  hash: string,
  platform: NodeJS.Platform,
): void {
  if (symlinkPointsTo(linkPath, versionDir)) return;

  const tmpLink = NodePath.join(packRoot, `.skills.tmp-${NodeCrypto.randomUUID()}`);
  const linkTarget = platform === "win32" ? versionDir : NodePath.join("skills.versions", hash);
  const linkType = platform === "win32" ? "junction" : "dir";
  NodeFS.symlinkSync(linkTarget, tmpLink, linkType);

  try {
    NodeFS.renameSync(tmpLink, linkPath);
  } catch {
    try {
      NodeFS.rmSync(linkPath, { recursive: true, force: true });
      NodeFS.renameSync(tmpLink, linkPath);
    } catch (error) {
      try {
        NodeFS.rmSync(tmpLink, { force: true });
      } catch {}
      throw error;
    }
  }
}

function syncSupportSubdir(sourceRoot: string, packRoot: string, subdir: string): void {
  const src = NodePath.join(sourceRoot, subdir);
  if (!NodeFS.existsSync(src)) return;

  const dst = NodePath.join(packRoot, subdir);
  const tmp = NodePath.join(packRoot, `.${subdir}.tmp-${NodeCrypto.randomUUID()}`);
  copyTreeClean(src, tmp);
  try {
    NodeFS.rmSync(dst, { recursive: true, force: true });
    NodeFS.renameSync(tmp, dst);
  } catch (error) {
    try {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

function syncSupportFile(sourceRoot: string, packRoot: string, filename: string): void {
  const src = NodePath.join(sourceRoot, filename);
  if (!NodeFS.existsSync(src)) return;

  const dst = NodePath.join(packRoot, filename);
  const tmp = NodePath.join(packRoot, `.${filename}.tmp-${NodeCrypto.randomUUID()}`);
  NodeFS.copyFileSync(src, tmp);
  try {
    NodeFS.renameSync(tmp, dst);
  } catch (error) {
    try {
      NodeFS.rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }
}

function cleanupStaleVersions(versionsDir: string, activeHash: string, nowMs?: number): void {
  for (const entry of NodeFS.readdirSync(versionsDir)) {
    if (entry === activeHash) continue;
    const entryPath = NodePath.join(versionsDir, entry);
    if (entry.startsWith(".tmp-")) {
      if (nowMs === undefined) continue;
      try {
        if (nowMs - NodeFS.statSync(entryPath).mtimeMs < STALE_TMP_AGE_MS) {
          continue;
        }
      } catch {
        continue;
      }
    }
    try {
      NodeFS.rmSync(entryPath, { recursive: true, force: true });
    } catch {}
  }
}

function loadSkillsFromDirectory(skillsDir: string): ReadonlyArray<ServerProviderSkill> {
  const skills: Array<ServerProviderSkill> = [];
  const entries = NodeFS.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipPackEntry(entry.name)) continue;
    const skillPath = NodePath.join(skillsDir, entry.name, "SKILL.md");
    let contents: string;
    try {
      contents = NodeFS.readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const frontmatter = parseBuiltinSkillFrontmatter(contents);
    const name = frontmatter?.name ?? entry.name;
    if (!name) continue;
    skills.push({
      name,
      ...(frontmatter?.description ? { description: frontmatter.description } : {}),
      path: skillPath,
      scope: "builtin",
      enabled: true,
      ...(frontmatter?.userInvocationOnly === true ? { userInvocationOnly: true } : {}),
      ...(frontmatter?.userInvocable === false ? { userInvocable: false } : {}),
    });
  }
  return skills.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function materializeBuiltinPstackSync(
  builtinSkillsDir: string,
  options: MaterializeBuiltinPstackOptions = {},
): MaterializedBuiltinSkillPack | undefined {
  const sourceDir = resolveBundledPstackSourceDir(options);
  if (!sourceDir) return undefined;

  const platform = options.platform ?? HostProcess.Platform.defaultValue();
  const hash = computeDirectoryHash(sourceDir);
  const packRoot = NodePath.join(NodePath.resolve(builtinSkillsDir), BUILTIN_PSTACK_PACK_ID);
  const versionsDir = NodePath.join(packRoot, "skills.versions");
  const versionDir = NodePath.join(versionsDir, hash);
  const skillsDir = NodePath.join(packRoot, "skills");
  const hashFile = NodePath.join(packRoot, PACK_HASH_FILENAME);

  NodeFS.mkdirSync(versionsDir, { recursive: true });

  if (!NodeFS.existsSync(NodePath.join(versionDir, SENTINEL_SKILL_RELATIVE_PATH))) {
    const tmpVersionDir = NodePath.join(versionsDir, `.tmp-${hash}-${NodeCrypto.randomUUID()}`);
    copyTreeClean(NodePath.join(sourceDir, "skills"), tmpVersionDir);
    try {
      NodeFS.renameSync(tmpVersionDir, versionDir);
    } catch {
      // Another process may have materialized the identical content hash concurrently.
      try {
        NodeFS.rmSync(tmpVersionDir, { recursive: true, force: true });
      } catch {}
      if (!NodeFS.existsSync(NodePath.join(versionDir, SENTINEL_SKILL_RELATIVE_PATH))) {
        copyTreeClean(NodePath.join(sourceDir, "skills"), versionDir);
      }
    }
  }

  atomicSwapSymlink(packRoot, skillsDir, versionDir, hash, platform);

  const recordedHash = (() => {
    try {
      return NodeFS.readFileSync(hashFile, "utf8").trim();
    } catch {
      return undefined;
    }
  })();
  const sourceHasLicense = NodeFS.existsSync(NodePath.join(sourceDir, "LICENSE"));
  if (
    recordedHash !== hash ||
    !NodeFS.existsSync(NodePath.join(packRoot, ".claude-plugin", "plugin.json")) ||
    (sourceHasLicense && !NodeFS.existsSync(NodePath.join(packRoot, "LICENSE")))
  ) {
    syncSupportSubdir(sourceDir, packRoot, ".claude-plugin");
    syncSupportSubdir(sourceDir, packRoot, "agents");
    syncSupportFile(sourceDir, packRoot, "LICENSE");
    const tmpHash = NodePath.join(packRoot, `.pack-hash.tmp-${NodeCrypto.randomUUID()}`);
    NodeFS.writeFileSync(tmpHash, `${hash}\n`, "utf8");
    NodeFS.renameSync(tmpHash, hashFile);
  }

  cleanupStaleVersions(versionsDir, hash, options.nowMs);

  return {
    id: BUILTIN_PSTACK_PACK_ID,
    hash,
    pluginDir: packRoot,
    skillsDir,
    versionDir,
    skills: loadSkillsFromDirectory(skillsDir),
  };
}

export const materializeBuiltinPstack = Effect.fn("BuiltinSkills.materializeBuiltinPstack")(
  function* (
    config: Pick<
      ServerConfig.ServerConfig["Service"],
      "stateDir" | "builtinSkillsDir" | "builtinSkillsEnabled"
    >,
    options: ResolveBundledPstackOptions = {},
  ) {
    if (config.builtinSkillsEnabled === false) {
      return undefined;
    }
    const execPath = options.execPath ?? (yield* HostProcess.ExecutablePath);
    const platform = yield* HostProcess.Platform;
    const nowMs = yield* Clock.currentTimeMillis;
    const builtinSkillsDir = resolveBuiltinSkillsDir(config);
    return yield* Effect.sync(() =>
      materializeBuiltinPstackSync(builtinSkillsDir, {
        ...(options.sourceDir === undefined ? {} : { sourceDir: options.sourceDir }),
        execPath,
        platform,
        nowMs,
      }),
    ).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("Failed to materialize built-in pstack skills.", { defect }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  },
);

export function mergeBuiltinSkills(
  providerSkills: ReadonlyArray<ServerProviderSkill>,
  builtinSkills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  if (builtinSkills.length === 0) return providerSkills;
  if (providerSkills.length === 0) return builtinSkills;

  const existingNames = new Set(providerSkills.map((skill) => skill.name));
  const additions = builtinSkills.filter((skill) => !existingNames.has(skill.name));
  if (additions.length === 0) return providerSkills;
  return [...providerSkills, ...additions];
}

function normalizeBuiltinSkillToken(token: string): string {
  return token.startsWith(BUILTIN_PSTACK_PREFIX)
    ? token.slice(BUILTIN_PSTACK_PREFIX.length)
    : token;
}

export function findReferencedBuiltinSkills(
  prompt: string,
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  if (skills.length === 0 || prompt.trim().length === 0) return [];

  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const matched: Array<ServerProviderSkill> = [];
  const seen = new Set<string>();

  const leadingSlash = LEADING_SLASH_COMMAND_PATTERN.exec(prompt);
  if (leadingSlash?.[1]) {
    const candidate = skillsByName.get(normalizeBuiltinSkillToken(leadingSlash[1]));
    if (candidate && !seen.has(candidate.name)) {
      seen.add(candidate.name);
      matched.push(candidate);
    }
  }

  for (const match of prompt.matchAll(SKILL_MENTION_PATTERN)) {
    const rawName = match[2];
    if (!rawName) continue;
    const candidate = skillsByName.get(normalizeBuiltinSkillToken(rawName));
    if (candidate && !seen.has(candidate.name)) {
      seen.add(candidate.name);
      matched.push(candidate);
    }
  }

  return matched;
}

export function resolveBuiltinSkillPromptHint(
  prompt: string,
  pack: Pick<MaterializedBuiltinSkillPack, "skillsDir" | "skills"> | undefined,
): string | undefined {
  if (!pack) return undefined;
  const matched = findReferencedBuiltinSkills(prompt, pack.skills);
  if (matched.length === 0) return undefined;

  const skillLines = matched.map((skill) => `- ${skill.name}: ${skill.path}`).join("\n");
  return [
    "Built-in pstack skill referenced. Read the SKILL.md file(s) below before proceeding:",
    skillLines,
    `Resolve relative ../<name>/SKILL.md and <plugin root>/skills/ references inside "${pack.skillsDir}".`,
  ].join("\n");
}

export function prependBuiltinSkillPromptHint(
  prompt: string,
  pack: Pick<MaterializedBuiltinSkillPack, "skillsDir" | "skills"> | undefined,
): string {
  const hint = resolveBuiltinSkillPromptHint(prompt, pack);
  return hint === undefined ? prompt : `${hint}\n\n${prompt}`;
}

export function rewriteUnprefixedBuiltinClaudeCommand(
  text: string,
  skills: ReadonlyMap<string, Pick<ServerProviderSkill, "scope">>,
): string {
  const match = LEADING_SLASH_COMMAND_PATTERN.exec(text);
  const rawName = match?.[1];
  if (!rawName || rawName.startsWith(BUILTIN_PSTACK_PREFIX)) {
    return text;
  }
  const skill = skills.get(rawName);
  if (skill?.scope !== "builtin") {
    return text;
  }
  const slashIndex = text.indexOf("/");
  return `${text.slice(0, slashIndex)}/${BUILTIN_PSTACK_PREFIX}${rawName}${text.slice(slashIndex + 1 + rawName.length)}`;
}

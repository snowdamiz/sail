// @effect-diagnostics nodeBuiltinImport:off -- streaming sha256 hash of large git bundles avoids buffering the entire file in memory, and node:fs/promises lstat inspects symlinks without following them.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as VcsProcess from "./VcsProcess.ts";

const DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES = 100 * 1024 * 1024; // 100 MiB

const MAX_OFFENDING_PATHS_REPORTED = 10;
const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1";
const LFS_POINTER_MAX_INSPECT_BYTES = 1024;
const STATUS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const BUNDLE_TIMEOUT_MS = 120_000;

const READ_ONLY_GIT_FLAGS: ReadonlyArray<string> = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
];

const TRANSFER_COMMIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "T3 Session Transfer",
  GIT_AUTHOR_EMAIL: "transfer@t3.local",
  GIT_COMMITTER_NAME: "T3 Session Transfer",
  GIT_COMMITTER_EMAIL: "transfer@t3.local",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

const TRANSFER_REFLOG_ENV: Readonly<Record<string, string>> = {
  GIT_COMMITTER_NAME: "T3 Session Transfer",
  GIT_COMMITTER_EMAIL: "transfer@t3.local",
};

export const WorkspaceBundleErrorCode = Schema.Literals([
  "not_git_repo",
  "bundle_too_large",
  "invalid_bundle",
  "git_error",
  "io_error",
]);
export type WorkspaceBundleErrorCode = typeof WorkspaceBundleErrorCode.Type;

export const WorkspaceBundleOffendingPath = Schema.Struct({
  path: Schema.String,
  sizeBytes: Schema.Number,
});
export type WorkspaceBundleOffendingPath = typeof WorkspaceBundleOffendingPath.Type;

export class WorkspaceBundleError extends Schema.TaggedError<WorkspaceBundleError>()(
  "WorkspaceBundleError",
  {
    code: WorkspaceBundleErrorCode,
    message: Schema.String,
    offendingPaths: Schema.optional(Schema.Array(WorkspaceBundleOffendingPath)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ExportWorkspaceBundleInput {
  readonly transferId: string;
  readonly cwd: string;
  readonly outputPath: string;
  readonly sharedRemoteRefs?: ReadonlyArray<string>;
  readonly maxBundleBytes?: number;
}

export interface ExportWorkspaceBundleResult {
  readonly bundlePath: string;
  readonly bundleSizeBytes: number;
  readonly bundleSha256: string;
  readonly branch: string | null;
  readonly headSha: string;
  readonly baseRef: string | null;
  readonly isDetachedHead: boolean;
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly incremental: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface GitCommonDirIdentity {
  readonly deviceId: string;
  readonly inode: string;
  readonly birthtimeNs: string | null;
  readonly objectsInode: string;
  readonly objectsBirthtimeNs: string | null;
}

export interface ResolvedGitCommonDir {
  readonly gitCommonDir: string;
  readonly identity: GitCommonDirIdentity;
}

export function isValidGitCommonDirIdentity(
  identity: GitCommonDirIdentity | null | undefined,
): identity is GitCommonDirIdentity {
  if (identity === null || identity === undefined) {
    return false;
  }
  if (
    typeof identity.deviceId !== "string" ||
    identity.deviceId.trim().length === 0 ||
    typeof identity.inode !== "string" ||
    identity.inode.trim().length === 0 ||
    typeof identity.objectsInode !== "string" ||
    identity.objectsInode.trim().length === 0
  ) {
    return false;
  }
  if (
    identity.birthtimeNs !== null &&
    (typeof identity.birthtimeNs !== "string" || identity.birthtimeNs.trim().length === 0)
  ) {
    return false;
  }
  if (
    identity.objectsBirthtimeNs !== null &&
    (typeof identity.objectsBirthtimeNs !== "string" ||
      identity.objectsBirthtimeNs.trim().length === 0)
  ) {
    return false;
  }
  return true;
}

export function isSameGitCommonDirIdentity(
  expected: GitCommonDirIdentity,
  actual: GitCommonDirIdentity,
): boolean {
  if (!isValidGitCommonDirIdentity(expected) || !isValidGitCommonDirIdentity(actual)) {
    return false;
  }
  if (
    expected.deviceId !== actual.deviceId ||
    expected.inode !== actual.inode ||
    expected.objectsInode !== actual.objectsInode
  ) {
    return false;
  }
  if (expected.birthtimeNs !== null && actual.birthtimeNs !== expected.birthtimeNs) {
    return false;
  }
  if (
    expected.objectsBirthtimeNs !== null &&
    actual.objectsBirthtimeNs !== expected.objectsBirthtimeNs
  ) {
    return false;
  }
  return true;
}

interface AllocatedWorkspaceWorktree {
  readonly repoCwd: string;
  readonly gitCommonDir: string;
  readonly gitCommonDirIdentity: GitCommonDirIdentity;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommitSha: string;
  readonly branchHeadSha: string | null;
  readonly allowedBranchHeadShas: ReadonlyArray<string>;
  readonly createdBranch: boolean;
}

export interface ReservedWorktreeAllocations {
  readonly reservedWorktreePaths: ReadonlySet<string>;
  readonly reservedBranchNames: ReadonlySet<string>;
}

export interface ImportWorkspaceBundleInput {
  readonly transferId: string;
  readonly repoCwd: string;
  readonly bundlePath: string;
  readonly sourceBranch: string | null;
  readonly targetLabel: "boat" | "local";
  readonly worktreePath?: string;
  readonly worktreesDirectory?: string;
  readonly reservedWorktreePaths?: ReadonlySet<string>;
  readonly reservedBranchNames?: ReadonlySet<string>;
  readonly resolveReservedAllocations?: (context: {
    readonly repoCwd: string;
    readonly gitCommonDir: string;
    readonly gitCommonDirIdentity: GitCommonDirIdentity;
  }) => Effect.Effect<ReservedWorktreeAllocations, WorkspaceBundleError>;
  readonly withWorktreeAllocationLock?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    context?: { readonly gitCommonDir: string },
  ) => Effect.Effect<A, E, R>;
  readonly onWorktreeAllocated?: (
    allocation: AllocatedWorkspaceWorktree,
  ) => Effect.Effect<void, WorkspaceBundleError>;
  readonly onWorktreeCreated?: (
    allocation: AllocatedWorkspaceWorktree,
  ) => Effect.Effect<void, WorkspaceBundleError>;
  readonly onWorktreeAllocationCleared?: (
    allocation: AllocatedWorkspaceWorktree,
  ) => Effect.Effect<void>;
  readonly beforeApplyDirtyLayers?: (
    worktreePath: string,
  ) => Effect.Effect<void, WorkspaceBundleError>;
}

export interface ImportWorkspaceBundleResult {
  readonly branch: string;
  readonly createdBranch: boolean;
  readonly worktreePath: string;
  readonly gitCommonDir: string;
  readonly gitCommonDirIdentity: GitCommonDirIdentity;
  readonly headSha: string;
  readonly baseCommitSha: string;
  readonly branchHeadSha: string;
  readonly allowedBranchHeadShas: ReadonlyArray<string>;
  readonly branchRenamedFrom: string | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface RemoveWorkspaceWorktreeInput {
  readonly repoCwd: string;
  readonly expectedGitCommonDir: string;
  readonly expectedGitCommonDirIdentity: GitCommonDirIdentity;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
  readonly expectedBranch?: string | null;
  readonly expectedBranchHeadSha?: string | null;
}

export interface RegisteredWorkspaceWorktree {
  readonly path: string;
  readonly isMain: boolean;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly locked: boolean;
  readonly lockReason: string | null;
}

export interface WorkspaceBundleShape {
  readonly resolveGitCommonDir: (cwd: string) => Effect.Effect<string | null, WorkspaceBundleError>;
  readonly resolveGitCommonDirIdentity: (
    cwd: string,
  ) => Effect.Effect<ResolvedGitCommonDir | null, WorkspaceBundleError>;
  readonly findRegisteredWorktree: (
    repoCwd: string,
    worktreePath: string,
  ) => Effect.Effect<RegisteredWorkspaceWorktree | null, WorkspaceBundleError>;
  readonly exportWorkspaceBundle: (
    input: ExportWorkspaceBundleInput,
  ) => Effect.Effect<ExportWorkspaceBundleResult, WorkspaceBundleError>;
  readonly importWorkspaceBundle: (
    input: ImportWorkspaceBundleInput,
  ) => Effect.Effect<ImportWorkspaceBundleResult, WorkspaceBundleError>;
  readonly removeWorktree: (
    input: RemoveWorkspaceWorktreeInput,
  ) => Effect.Effect<void, WorkspaceBundleError>;
}

export class WorkspaceBundle extends Context.Service<WorkspaceBundle, WorkspaceBundleShape>()(
  "t3/vcs/WorkspaceBundle",
) {}

function sanitizeTransferId(transferId: string): string {
  const sanitized = transferId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, "-");
  return sanitized.length > 0 ? sanitized : "transfer";
}

function transferRefPrefix(transferId: string): string {
  const hashSuffix = NodeCrypto.createHash("sha256").update(transferId).digest("hex").slice(0, 12);
  const base = sanitizeTransferId(transferId).slice(0, 48);
  return `refs/t3-transfer/${base}-${hashSuffix}`;
}

function shortTransferId(transferId: string): string {
  const cleaned = transferId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return cleaned.length > 0 ? cleaned.slice(0, 8) : "transfer";
}

interface ParsedStatusEntry {
  readonly xy: string;
  readonly path: string;
}

function parsePorcelainZStatus(stdout: string): ReadonlyArray<ParsedStatusEntry> {
  const entries: ParsedStatusEntry[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;
    const xy = token.slice(0, 2);
    const filePath = token.slice(3);
    entries.push({ xy, path: filePath });
    // Renames/copies in -z output emit the original path as the next NUL-delimited token.
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      i += 1;
    }
  }
  return entries;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

function parseWorktreeListPorcelainZ(stdout: string): ReadonlyArray<RegisteredWorkspaceWorktree> {
  const entries: Array<RegisteredWorkspaceWorktree> = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentHeadSha: string | null = null;
  let currentLocked = false;
  let currentLockReason: string | null = null;

  const flush = () => {
    if (currentPath !== null) {
      entries.push({
        path: currentPath,
        isMain: entries.length === 0,
        branch: currentBranch,
        headSha: currentHeadSha,
        locked: currentLocked,
        lockReason: currentLockReason,
      });
    }
    currentPath = null;
    currentBranch = null;
    currentHeadSha = null;
    currentLocked = false;
    currentLockReason = null;
  };

  for (const rawField of stdout.split("\0")) {
    if (rawField.length === 0) {
      flush();
      continue;
    }
    if (rawField.startsWith("worktree ")) {
      flush();
      currentPath = rawField.slice("worktree ".length);
      continue;
    }
    if (currentPath !== null) {
      if (rawField.startsWith("HEAD ")) {
        currentHeadSha = stripTrailingAsciiLineEndings(rawField.slice("HEAD ".length)) || null;
      } else if (rawField.startsWith("branch refs/heads/")) {
        currentBranch = rawField.slice("branch refs/heads/".length);
      } else if (rawField === "locked") {
        currentLocked = true;
      } else if (rawField.startsWith("locked ")) {
        currentLocked = true;
        currentLockReason = stripTrailingAsciiLineEndings(rawField.slice("locked ".length)) || null;
      }
    }
  }
  flush();
  return entries;
}

interface ParsedLocalBranches {
  readonly branchHeads: ReadonlyMap<string, string>;
  readonly symbolicBranches: ReadonlySet<string>;
}

function stripTrailingAsciiLineEndings(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

function parseLocalBranchHeads(stdout: string): ParsedLocalBranches {
  const branchHeads = new Map<string, string>();
  const symbolicBranches = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;
    const fields = rawLine.split("\t");
    const rawRefName = fields[0] ?? "";
    const sha = stripTrailingAsciiLineEndings(fields[1] ?? "");
    const symref = fields[2] ?? "";
    if (!rawRefName.startsWith("refs/heads/")) continue;
    const branchName = rawRefName.slice("refs/heads/".length);
    if (branchName.length === 0) continue;
    if (symref.length > 0) {
      symbolicBranches.add(branchName);
    }
    if (sha.length > 0) {
      branchHeads.set(branchName, sha);
    }
  }
  return { branchHeads, symbolicBranches };
}

const ACTIVE_WORKTREE_GIT_OPERATIONS: ReadonlyArray<{
  readonly relativePath: string;
  readonly label: string;
}> = [
  { relativePath: "BISECT_START", label: "bisect" },
  { relativePath: "BISECT_LOG", label: "bisect" },
  { relativePath: "BISECT_NAMES", label: "bisect" },
  { relativePath: "rebase-merge", label: "rebase" },
  { relativePath: "rebase-apply", label: "rebase" },
  { relativePath: "MERGE_HEAD", label: "merge" },
  { relativePath: "CHERRY_PICK_HEAD", label: "cherry-pick" },
  { relativePath: "REVERT_HEAD", label: "revert" },
  { relativePath: "sequencer", label: "cherry-pick/revert" },
];

function stripSingleRefsHeadsPrefix(refName: string): string | null {
  if (!refName.startsWith("refs/heads/")) {
    return null;
  }
  const branch = refName.slice("refs/heads/".length);
  return branch.length > 0 ? branch : null;
}

function parseRebaseUpdateRefsBranches(content: string): ReadonlyArray<string> {
  const branches: Array<string> = [];
  for (const token of content.split(/[\0\r\n\t ]+/)) {
    const branch = stripSingleRefsHeadsPrefix(token);
    if (branch !== null) {
      branches.push(branch);
    }
  }
  return branches;
}

function parseRebaseTodoUpdateRefBranches(content: string): ReadonlyArray<string> {
  const branches: Array<string> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/^[ \t]+/, "");
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:update-ref|u)[ \t]+([^ \t\r\n\0]+)/.exec(line);
    if (match?.[1] === undefined) {
      continue;
    }
    const branch = stripSingleRefsHeadsPrefix(match[1]);
    if (branch !== null) {
      branches.push(branch);
    }
  }
  return branches;
}

function allocateDestinationBranch(input: {
  readonly sourceBranch: string | null;
  readonly headSha: string;
  readonly targetLabel: "boat" | "local";
  readonly transferId: string;
  readonly localBranches: ReadonlyMap<string, string>;
  readonly symbolicBranches?: ReadonlySet<string>;
  readonly checkedOutBranches: ReadonlySet<string>;
  readonly reservedBranches?: ReadonlySet<string>;
}): {
  readonly branch: string;
  readonly useExistingBranch: boolean;
  readonly branchRenamedFrom: string | null;
  readonly warning: string | null;
} {
  const shortId = shortTransferId(input.transferId);
  const isSymbolic = (candidate: string) => input.symbolicBranches?.has(candidate) ?? false;
  const isReserved = (candidate: string) => input.reservedBranches?.has(candidate) ?? false;
  const isAvailableForNew = (candidate: string) =>
    !input.localBranches.has(candidate) &&
    !isSymbolic(candidate) &&
    !input.checkedOutBranches.has(candidate) &&
    !isReserved(candidate);

  if (input.sourceBranch === null) {
    const base = `${input.targetLabel}-transfer-${shortId}`;
    let candidate = base;
    for (let suffix = 2; !isAvailableForNew(candidate); suffix += 1) {
      candidate = `${base}-${suffix}`;
    }
    return {
      branch: candidate,
      useExistingBranch: false,
      branchRenamedFrom: null,
      warning: `Source workspace was on a detached HEAD; checked out branch '${candidate}' on destination.`,
    };
  }

  const existingSha = input.localBranches.get(input.sourceBranch);
  const isSourceSymbolic = isSymbolic(input.sourceBranch);
  const isCheckedOut = input.checkedOutBranches.has(input.sourceBranch);
  const isSourceReserved = isReserved(input.sourceBranch);

  if (!isSourceSymbolic && !isCheckedOut && !isSourceReserved && existingSha === undefined) {
    return {
      branch: input.sourceBranch,
      useExistingBranch: false,
      branchRenamedFrom: null,
      warning: null,
    };
  }

  if (!isSourceSymbolic && !isCheckedOut && !isSourceReserved && existingSha === input.headSha) {
    return {
      branch: input.sourceBranch,
      useExistingBranch: true,
      branchRenamedFrom: null,
      warning: null,
    };
  }

  const preferred = `${input.sourceBranch}-${input.targetLabel}`;
  let candidate: string;
  if (isAvailableForNew(preferred)) {
    candidate = preferred;
  } else {
    const fallbackBase = `${input.sourceBranch}-transfer-${shortId}`;
    candidate = fallbackBase;
    for (let suffix = 2; !isAvailableForNew(candidate); suffix += 1) {
      candidate = `${fallbackBase}-${suffix}`;
    }
  }

  const reason = isSourceSymbolic
    ? "is a symbolic ref"
    : isCheckedOut
      ? "already checked out or in use by another worktree"
      : isSourceReserved
        ? "reserved by another transfer"
        : "exists locally at a different commit";
  return {
    branch: candidate,
    useExistingBranch: false,
    branchRenamedFrom: input.sourceBranch,
    warning: `Branch '${input.sourceBranch}' ${reason}; created '${candidate}' on destination.`,
  };
}

const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const runGit = Effect.fn("WorkspaceBundle.runGit")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
    },
  ) {
    return yield* vcsProcess
      .run({
        operation,
        command: "git",
        args,
        cwd,
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.allowNonZeroExit !== undefined
          ? { allowNonZeroExit: options.allowNonZeroExit }
          : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.maxOutputBytes !== undefined
          ? { maxOutputBytes: options.maxOutputBytes }
          : {}),
        ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBundleError({
              code: "git_error",
              message: `Git command '${operation}' failed: ${cause.message}`,
              cause,
            }),
        ),
      );
  });

  // Always pass --no-optional-locks and disable fsmonitor for read-only source git commands
  // so export never refreshes or rewrites the repository's real .git/index stat cache.
  const runReadOnlyGit = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
    },
  ) => runGit(operation, cwd, [...READ_ONLY_GIT_FLAGS, ...args], options);

  const deleteRefsBestEffort = (cwd: string, refs: ReadonlyArray<string>) =>
    Effect.forEach(
      refs,
      (ref) =>
        runGit("WorkspaceBundle.deleteRef", cwd, ["update-ref", "--no-deref", "-d", ref], {
          allowNonZeroExit: true,
        }).pipe(Effect.ignore),
      { discard: true },
    );

  const sha256File = (filePath: string) =>
    fileSystem.stream(filePath).pipe(
      Stream.runFold(
        () => NodeCrypto.createHash("sha256"),
        (hash, chunk) => hash.update(chunk),
      ),
      Effect.map((hash) => hash.digest("hex")),
      Effect.mapError(
        (cause) =>
          new WorkspaceBundleError({
            code: "io_error",
            message: `Failed to compute SHA-256 checksum for bundle '${filePath}'.`,
            cause,
          }),
      ),
    );

  const detectLfsWarning = Effect.fn("WorkspaceBundle.detectLfsWarning")(function* (
    repoTopLevel: string,
    gitCommonDir: string,
    dirtyPaths: ReadonlyArray<string>,
  ) {
    const candidateAttrFiles = [
      path.join(repoTopLevel, ".gitattributes"),
      path.join(gitCommonDir, "info", "attributes"),
    ];
    for (const attrFile of candidateAttrFiles) {
      const content = yield* fileSystem
        .readFileString(attrFile)
        .pipe(Effect.orElseSucceed(() => null));
      if (content !== null && /\bfilter=lfs\b/.test(content)) {
        return "Repository tracks Git LFS files (.gitattributes filter=lfs); LFS binary objects are not included in the workspace bundle and must be fetched on the destination.";
      }
    }

    for (const relPath of dirtyPaths) {
      const fullPath = path.join(repoTopLevel, relPath);
      const stat = yield* fileSystem.stat(fullPath).pipe(Effect.orElseSucceed(() => null));
      if (stat?.type !== "File" || Number(stat.size) > LFS_POINTER_MAX_INSPECT_BYTES) {
        continue;
      }
      const text = yield* fileSystem
        .readFileString(fullPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (text !== null && text.startsWith(LFS_POINTER_HEADER)) {
        return "Workspace contains Git LFS pointer files; LFS binary objects are not included in the workspace bundle and must be fetched on the destination.";
      }
    }

    return null;
  });

  const detectDirtySubmoduleWarning = Effect.fn("WorkspaceBundle.detectDirtySubmoduleWarning")(
    function* (repoTopLevel: string) {
      const gitmodulesPath = path.join(repoTopLevel, ".gitmodules");
      const hasGitmodules = yield* fileSystem
        .exists(gitmodulesPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!hasGitmodules) return null;

      const status = yield* runReadOnlyGit("WorkspaceBundle.submoduleStatus", repoTopLevel, [
        "submodule",
        "status",
      ]).pipe(Effect.orElseSucceed(() => null));
      if (status === null) return null;

      const dirtySubmodules: string[] = [];
      for (const line of status.stdout.split(/\r?\n/)) {
        if (line.length < 2) continue;
        const prefix = line[0];
        if (prefix === "+" || prefix === "-" || prefix === "U") {
          const parts = line
            .slice(1)
            .replace(/^[ \t]+|[ \t]+$/g, "")
            .split(/[ \t]+/);
          if (parts[1]) dirtySubmodules.push(parts[1]);
        }
      }

      if (dirtySubmodules.length === 0) return null;
      return `Submodules with uncommitted, uninitialized, or shifted state are not bundled recursively: ${dirtySubmodules.join(", ")}.`;
    },
  );

  const exportWorkspaceBundle: WorkspaceBundleShape["exportWorkspaceBundle"] = Effect.fn(
    "WorkspaceBundle.exportWorkspaceBundle",
  )(function* (input) {
    const maxBundleBytes = input.maxBundleBytes ?? DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES;

    const insideWorkTree = yield* runReadOnlyGit(
      "WorkspaceBundle.isInsideWorkTree",
      input.cwd,
      ["rev-parse", "--is-inside-work-tree"],
      { allowNonZeroExit: true },
    );
    if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim() !== "true") {
      return yield* new WorkspaceBundleError({
        code: "not_git_repo",
        message: `Directory '${input.cwd}' is not inside a Git work tree.`,
      });
    }

    const revInfo = yield* runReadOnlyGit("WorkspaceBundle.revParseDirs", input.cwd, [
      "rev-parse",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ]);
    const [rawTopLevel, rawGitDir, rawGitCommonDir] = stripTrailingAsciiLineEndings(
      revInfo.stdout,
    ).split(/\r?\n/);
    if (!rawTopLevel || !rawGitDir || !rawGitCommonDir) {
      return yield* new WorkspaceBundleError({
        code: "not_git_repo",
        message: `Unable to resolve Git repository directories for '${input.cwd}'.`,
      });
    }
    const repoTopLevel = path.resolve(input.cwd, rawTopLevel);
    const gitDir = path.resolve(input.cwd, rawGitDir);
    const gitCommonDir = path.resolve(input.cwd, rawGitCommonDir);

    const headCheck = yield* runReadOnlyGit(
      "WorkspaceBundle.resolveHead",
      repoTopLevel,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { allowNonZeroExit: true },
    );
    if (headCheck.exitCode !== 0) {
      return yield* new WorkspaceBundleError({
        code: "git_error",
        message: "Git repository has no HEAD commit to bundle.",
      });
    }
    const headSha = headCheck.stdout.trim();
    const headTree = (yield* runReadOnlyGit("WorkspaceBundle.resolveHeadTree", repoTopLevel, [
      "rev-parse",
      "HEAD^{tree}",
    ])).stdout.trim();

    const branchCheck = yield* runReadOnlyGit(
      "WorkspaceBundle.resolveBranch",
      repoTopLevel,
      ["symbolic-ref", "-q", "HEAD"],
      { allowNonZeroExit: true },
    );
    const rawHeadRef =
      branchCheck.exitCode === 0 ? stripTrailingAsciiLineEndings(branchCheck.stdout) : "";
    const branch = stripSingleRefsHeadsPrefix(rawHeadRef);
    const isDetachedHead = branch === null;

    // Enumerate dirty & untracked files to pre-check size ceiling before staging or bundling.
    const statusResult = yield* runReadOnlyGit(
      "WorkspaceBundle.statusPorcelain",
      repoTopLevel,
      ["status", "--porcelain=v1", "-z", "-uall"],
      { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES },
    );
    const statusEntries = parsePorcelainZStatus(statusResult.stdout);

    let hasUnstagedChanges = false;
    let hasUntrackedFiles = false;
    const candidateDirtyPaths = new Set<string>();
    for (const entry of statusEntries) {
      if (entry.xy === "??") {
        hasUntrackedFiles = true;
      } else if (entry.xy[1] !== " ") {
        hasUnstagedChanges = true;
      }
      if (entry.xy[1] !== "D") {
        candidateDirtyPaths.add(entry.path);
      }
    }

    const sizedPaths: WorkspaceBundleOffendingPath[] = [];
    let totalDirtyBytes = 0;
    for (const relPath of candidateDirtyPaths) {
      const fullPath = path.join(repoTopLevel, relPath);
      const stat = yield* fileSystem.stat(fullPath).pipe(Effect.orElseSucceed(() => null));
      if (stat?.type !== "File") continue;
      const sizeBytes = Number(stat.size);
      totalDirtyBytes += sizeBytes;
      sizedPaths.push({ path: relPath, sizeBytes });
    }

    if (totalDirtyBytes > maxBundleBytes) {
      const offendingPaths = sizedPaths
        .toSorted((a, b) => b.sizeBytes - a.sizeBytes)
        .slice(0, MAX_OFFENDING_PATHS_REPORTED);
      const summary = offendingPaths
        .slice(0, 5)
        .map((entry) => `${entry.path} (${formatByteSize(entry.sizeBytes)})`)
        .join(", ");
      return yield* new WorkspaceBundleError({
        code: "bundle_too_large",
        message: `Workspace dirty/untracked files (${formatByteSize(totalDirtyBytes)}) exceed the ${formatByteSize(maxBundleBytes)} transfer limit. Largest files: ${summary}`,
        offendingPaths,
      });
    }

    const warnings: string[] = [];
    const [submoduleWarning, lfsWarning] = yield* Effect.all([
      detectDirtySubmoduleWarning(repoTopLevel),
      detectLfsWarning(repoTopLevel, gitCommonDir, [...candidateDirtyPaths]),
    ]);
    if (submoduleWarning !== null) warnings.push(submoduleWarning);
    if (lfsWarning !== null) warnings.push(lfsWarning);

    const refPrefix = transferRefPrefix(input.transferId);
    const headRef = `${refPrefix}/head`;
    const indexRef = `${refPrefix}/index`;
    const worktreeRef = `${refPrefix}/worktree`;
    const createdRefs: string[] = [];

    const scratchDir = yield* fileSystem.makeTempDirectory({ prefix: "t3-transfer-idx-" }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceBundleError({
            code: "io_error",
            message: "Failed to create scratch directory for workspace bundle export.",
            cause,
          }),
      ),
    );

    return yield* Effect.gen(function* () {
      // Layer 1: exact HEAD commit (works for detached HEAD and unpushed commits alike).
      yield* runGit("WorkspaceBundle.updateHeadRef", repoTopLevel, [
        "update-ref",
        headRef,
        headSha,
      ]);
      createdRefs.push(headRef);

      // Layer 2: staged index snapshot using a private scratch index copy (never touches real index).
      const realIndexPath = path.join(gitDir, "index");
      const scratchIndex1 = path.join(scratchDir, "index-staged");
      const realIndexExists = yield* fileSystem
        .exists(realIndexPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (realIndexExists) {
        yield* fileSystem.copyFile(realIndexPath, scratchIndex1).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceBundleError({
                code: "io_error",
                message: "Failed to copy Git index into scratch index file.",
                cause,
              }),
          ),
        );
      } else {
        yield* runReadOnlyGit(
          "WorkspaceBundle.readTreeScratch",
          repoTopLevel,
          ["read-tree", headSha],
          {
            env: { GIT_INDEX_FILE: scratchIndex1 },
          },
        );
      }

      const indexTree = (yield* runReadOnlyGit(
        "WorkspaceBundle.writeIndexTree",
        repoTopLevel,
        ["write-tree"],
        {
          env: { GIT_INDEX_FILE: scratchIndex1 },
        },
      )).stdout.trim();
      const hasStagedChanges = indexTree !== headTree;
      let indexCommit: string | null = null;
      if (hasStagedChanges) {
        indexCommit = (yield* runReadOnlyGit(
          "WorkspaceBundle.commitIndexTree",
          repoTopLevel,
          ["commit-tree", indexTree, "-p", headSha, "-m", "t3-transfer:index"],
          { env: TRANSFER_COMMIT_ENV },
        )).stdout.trim();
        yield* runGit("WorkspaceBundle.updateIndexRef", repoTopLevel, [
          "update-ref",
          indexRef,
          indexCommit,
        ]);
        createdRefs.push(indexRef);
      }

      // Layer 3: working tree + untracked non-ignored files using a second scratch index.
      // Populate via read-tree from indexTree (NOT copyFile) so stat-cache fields are zeroed:
      // copying the index would give scratchIndex2 a newer mtime than working-tree files,
      // defeating Git racy-git detection for same-second, same-size unstaged edits.
      const scratchIndex2 = path.join(scratchDir, "index-worktree");
      yield* runReadOnlyGit(
        "WorkspaceBundle.readTreeWorktreeScratch",
        repoTopLevel,
        ["read-tree", indexTree],
        {
          env: { GIT_INDEX_FILE: scratchIndex2 },
        },
      );
      yield* runReadOnlyGit("WorkspaceBundle.stageWorktree", repoTopLevel, ["add", "-A"], {
        env: { GIT_INDEX_FILE: scratchIndex2 },
        timeoutMs: BUNDLE_TIMEOUT_MS,
      });
      const worktreeTree = (yield* runReadOnlyGit(
        "WorkspaceBundle.writeWorktreeTree",
        repoTopLevel,
        ["write-tree"],
        {
          env: { GIT_INDEX_FILE: scratchIndex2 },
        },
      )).stdout.trim();
      const hasWorktreeDiff = worktreeTree !== indexTree;
      if (hasWorktreeDiff) {
        const worktreeParent = indexCommit ?? headSha;
        const worktreeCommit = (yield* runReadOnlyGit(
          "WorkspaceBundle.commitWorktreeTree",
          repoTopLevel,
          ["commit-tree", worktreeTree, "-p", worktreeParent, "-m", "t3-transfer:worktree"],
          { env: TRANSFER_COMMIT_ENV },
        )).stdout.trim();
        yield* runGit("WorkspaceBundle.updateWorktreeRef", repoTopLevel, [
          "update-ref",
          worktreeRef,
          worktreeCommit,
        ]);
        createdRefs.push(worktreeRef);
      }

      // Exclude only caller-supplied sharedRemoteRefs that are strict ancestors of HEAD so
      // refs/t3-transfer/.../head is always bundled. Pass validated commit SHAs (not moving ref
      // names) so a concurrent `git fetch` advancing a ref to HEAD cannot race with `--not`.
      const excludeCommitShas: string[] = [];
      const seenExcludeShas = new Set<string>();
      let baseRef: string | null = null;
      if (input.sharedRemoteRefs !== undefined && input.sharedRemoteRefs.length > 0) {
        for (const candidate of input.sharedRemoteRefs) {
          const check = yield* runReadOnlyGit(
            "WorkspaceBundle.verifySharedRef",
            repoTopLevel,
            ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
            { allowNonZeroExit: true },
          );
          if (check.exitCode !== 0) continue;
          const candidateSha = check.stdout.trim();
          if (candidateSha.length === 0 || candidateSha === headSha) {
            continue;
          }
          const isAncestor = yield* runReadOnlyGit(
            "WorkspaceBundle.checkBaseRef",
            repoTopLevel,
            ["merge-base", "--is-ancestor", candidateSha, headSha],
            { allowNonZeroExit: true },
          );
          if (isAncestor.exitCode !== 0) {
            continue;
          }
          if (!seenExcludeShas.has(candidateSha)) {
            seenExcludeShas.add(candidateSha);
            excludeCommitShas.push(candidateSha);
          }
          if (baseRef === null) {
            baseRef = candidate;
          }
        }
      }

      yield* fileSystem.makeDirectory(path.dirname(input.outputPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBundleError({
              code: "io_error",
              message: `Failed to create parent directory for bundle '${input.outputPath}'.`,
              cause,
            }),
        ),
      );

      const positiveRefs = [...createdRefs];
      let incremental = false;

      if (excludeCommitShas.length > 0) {
        const countResult = yield* runReadOnlyGit(
          "WorkspaceBundle.countIncrementalCommits",
          repoTopLevel,
          ["rev-list", "--count", ...positiveRefs, "--not", ...excludeCommitShas],
          { allowNonZeroExit: true },
        );
        const incrementalCount =
          countResult.exitCode === 0 ? Number.parseInt(countResult.stdout.trim(), 10) : 0;

        if (Number.isFinite(incrementalCount) && incrementalCount > 0) {
          const incBundle = yield* runReadOnlyGit(
            "WorkspaceBundle.createIncrementalBundle",
            repoTopLevel,
            ["bundle", "create", input.outputPath, ...positiveRefs, "--not", ...excludeCommitShas],
            { allowNonZeroExit: true, timeoutMs: BUNDLE_TIMEOUT_MS },
          );
          if (incBundle.exitCode === 0) {
            incremental = true;
          }
        }
      }

      if (!incremental) {
        yield* runReadOnlyGit(
          "WorkspaceBundle.createFullBundle",
          repoTopLevel,
          ["bundle", "create", input.outputPath, ...positiveRefs],
          { timeoutMs: BUNDLE_TIMEOUT_MS },
        );
      }

      const bundleStat = yield* fileSystem.stat(input.outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBundleError({
              code: "io_error",
              message: `Failed to inspect created bundle '${input.outputPath}'.`,
              cause,
            }),
        ),
      );
      const bundleSizeBytes = Number(bundleStat.size);
      if (bundleSizeBytes > maxBundleBytes) {
        yield* fileSystem.remove(input.outputPath, { force: true }).pipe(Effect.ignore);
        const offendingPaths = sizedPaths
          .toSorted((a, b) => b.sizeBytes - a.sizeBytes)
          .slice(0, MAX_OFFENDING_PATHS_REPORTED);
        return yield* new WorkspaceBundleError({
          code: "bundle_too_large",
          message: `Exported workspace bundle (${formatByteSize(bundleSizeBytes)}) exceeds the ${formatByteSize(maxBundleBytes)} limit.`,
          ...(offendingPaths.length > 0 ? { offendingPaths } : {}),
        });
      }

      const bundleSha256 = yield* sha256File(input.outputPath);

      return {
        bundlePath: input.outputPath,
        bundleSizeBytes,
        bundleSha256,
        branch,
        headSha,
        baseRef,
        isDetachedHead,
        hasStagedChanges,
        hasUnstagedChanges,
        hasUntrackedFiles,
        incremental,
        warnings,
      } satisfies ExportWorkspaceBundleResult;
    }).pipe(
      Effect.ensuring(
        Effect.all(
          [
            deleteRefsBestEffort(repoTopLevel, createdRefs),
            fileSystem.remove(scratchDir, { recursive: true, force: true }).pipe(Effect.ignore),
          ],
          { discard: true },
        ),
      ),
    );
  });

  const normalizePathForComparison = Effect.fn("WorkspaceBundle.normalizePathForComparison")(
    function* (targetPath: string) {
      let current = path.resolve(targetPath);
      const trailingSegments: Array<string> = [];
      while (true) {
        const realResult = yield* Effect.result(fileSystem.realPath(current));
        if (Result.isSuccess(realResult)) {
          const base = path.normalize(realResult.success);
          return trailingSegments.length === 0
            ? base
            : path.normalize(path.join(base, ...trailingSegments.reverse()));
        }
        const parent = path.dirname(current);
        if (parent === current) {
          return path.normalize(path.resolve(targetPath));
        }
        trailingSegments.push(path.basename(current));
        current = parent;
      }
    },
  );

  const resolveGitCommonDir: WorkspaceBundleShape["resolveGitCommonDir"] = Effect.fn(
    "WorkspaceBundle.resolveGitCommonDir",
  )(function* (cwd: string) {
    const result = yield* runReadOnlyGit(
      "WorkspaceBundle.resolveGitCommonDir",
      cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { allowNonZeroExit: true },
    );
    const rawCommonDir = result.exitCode === 0 ? stripTrailingAsciiLineEndings(result.stdout) : "";
    if (rawCommonDir.length === 0) {
      return null;
    }
    return yield* normalizePathForComparison(path.resolve(cwd, rawCommonDir));
  });

  const readGitCommonDirIdentity = Effect.fn("WorkspaceBundle.readGitCommonDirIdentity")(function* (
    gitCommonDir: string,
  ): Effect.fn.Return<GitCommonDirIdentity, WorkspaceBundleError> {
    const objectsDir = path.join(gitCommonDir, "objects");
    const [commonStat, objectsStat] = yield* Effect.all([
      Effect.tryPromise({
        try: () => NodeFSP.lstat(gitCommonDir, { bigint: true }),
        catch: (cause) =>
          new WorkspaceBundleError({
            code: "io_error",
            message: `Failed to stat git common dir '${gitCommonDir}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      }),
      Effect.tryPromise({
        try: () => NodeFSP.lstat(objectsDir, { bigint: true }),
        catch: (cause) =>
          new WorkspaceBundleError({
            code: "io_error",
            message: `Failed to stat git objects dir '${objectsDir}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      }),
    ]);
    if (commonStat.isSymbolicLink() || !commonStat.isDirectory()) {
      return yield* new WorkspaceBundleError({
        code: "git_error",
        message: `Git common dir '${gitCommonDir}' is not a real directory.`,
      });
    }
    return {
      deviceId: commonStat.dev.toString(),
      inode: commonStat.ino.toString(),
      birthtimeNs: commonStat.birthtimeNs > 0n ? commonStat.birthtimeNs.toString() : null,
      objectsInode: objectsStat.ino.toString(),
      objectsBirthtimeNs: objectsStat.birthtimeNs > 0n ? objectsStat.birthtimeNs.toString() : null,
    } satisfies GitCommonDirIdentity;
  });

  const resolveGitCommonDirIdentity: WorkspaceBundleShape["resolveGitCommonDirIdentity"] =
    Effect.fn("WorkspaceBundle.resolveGitCommonDirIdentity")(function* (cwd: string) {
      const gitCommonDir = yield* resolveGitCommonDir(cwd);
      if (gitCommonDir === null) {
        return null;
      }
      const identity = yield* readGitCommonDirIdentity(gitCommonDir);
      return {
        gitCommonDir,
        identity,
      } satisfies ResolvedGitCommonDir;
    });

  const allocateWorktreePath = Effect.fn("WorkspaceBundle.allocateWorktreePath")(function* (input: {
    readonly repoCwd: string;
    readonly gitCommonDir: string;
    readonly branch: string;
    readonly worktreesDirectory?: string;
    readonly reservedWorktreePaths?: ReadonlySet<string>;
  }) {
    const parentDir = resolveWorktreesDirectory(
      input.worktreesDirectory ?? "",
      serverConfig.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (parentDir === null) {
      return yield* new WorkspaceBundleError({
        code: "io_error",
        message: `Worktrees directory '${input.worktreesDirectory ?? ""}' must be an absolute path and not a filesystem root.`,
      });
    }
    const normalizedReservedPaths = new Set<string>();
    for (const reservedPath of input.reservedWorktreePaths ?? []) {
      normalizedReservedPaths.add(yield* normalizePathForComparison(reservedPath));
    }

    const repoName = path.basename(path.resolve(input.repoCwd));
    const identity = `${input.gitCommonDir}\0${input.branch}`;
    const hash = yield* digest.digest(Digest.sha256, new TextEncoder().encode(identity));
    let prefix = "";
    for (const character of input.branch.replace(/\//g, "-")) {
      if (Buffer.byteLength(prefix + character) > 23) break;
      prefix += character;
    }
    const basePath = path.join(parentDir, repoName, `${prefix}-${Hex.encode(hash).slice(0, 16)}`);
    const isCandidateTaken = function* (candidatePath: string) {
      const normalizedCandidate = yield* normalizePathForComparison(candidatePath);
      if (normalizedReservedPaths.has(normalizedCandidate)) {
        return true;
      }
      return yield* fileSystem.exists(candidatePath).pipe(Effect.orElseSucceed(() => false));
    };
    let candidate = basePath;
    for (let suffix = 2; yield* isCandidateTaken(candidate); suffix += 1) {
      candidate = `${basePath}-${suffix}`;
    }
    return candidate;
  });

  const listRegisteredWorktrees = Effect.fn("WorkspaceBundle.listRegisteredWorktrees")(function* (
    repoCwd: string,
  ) {
    const listResult = yield* runGit(
      "WorkspaceBundle.listWorktrees",
      repoCwd,
      ["worktree", "list", "--porcelain", "-z"],
      { outputMode: "error" },
    );
    if (listResult.stdoutTruncated) {
      return yield* new WorkspaceBundleError({
        code: "git_error",
        message: `Git command 'WorkspaceBundle.listWorktrees' produced truncated git worktree list output in '${repoCwd}'.`,
      });
    }
    return parseWorktreeListPorcelainZ(listResult.stdout);
  });

  const findRegisteredWorktree = Effect.fn("WorkspaceBundle.findRegisteredWorktree")(function* (
    repoCwd: string,
    worktreePath: string,
  ) {
    const entries = yield* listRegisteredWorktrees(repoCwd);
    const normalizedTarget = yield* normalizePathForComparison(path.resolve(repoCwd, worktreePath));
    for (const entry of entries) {
      const normalizedEntry = yield* normalizePathForComparison(path.resolve(repoCwd, entry.path));
      if (normalizedEntry === normalizedTarget) {
        return entry;
      }
    }
    return null;
  });

  const isEnoentError = (cause: unknown): boolean =>
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT";

  const inspectPathWithLstat = (
    targetPath: string,
  ): Effect.Effect<"exists" | "enoent", WorkspaceBundleError> =>
    Effect.tryPromise({
      try: async () => {
        try {
          await NodeFSP.lstat(targetPath);
          return "exists" as const;
        } catch (cause) {
          if (isEnoentError(cause)) {
            return "enoent" as const;
          }
          throw cause;
        }
      },
      catch: (cause) =>
        new WorkspaceBundleError({
          code: "io_error",
          message: `Failed to inspect worktree path '${targetPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });

  const readOptionalGitStateFile = (
    filePath: string,
  ): Effect.Effect<string | null, WorkspaceBundleError> =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await NodeFSP.readFile(filePath, "utf8");
        } catch (cause) {
          if (isEnoentError(cause)) {
            return null;
          }
          throw cause;
        }
      },
      catch: (cause) =>
        new WorkspaceBundleError({
          code: "git_error",
          message: `Failed to read Git worktree state file '${filePath}': ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });

  const listLinkedWorktreeGitDirs = (
    gitCommonDir: string,
  ): Effect.Effect<ReadonlyArray<string>, WorkspaceBundleError> =>
    Effect.tryPromise({
      try: async () => {
        const worktreesAdminDir = path.join(gitCommonDir, "worktrees");
        const readEntries = async () => {
          try {
            return await NodeFSP.readdir(worktreesAdminDir, { withFileTypes: true });
          } catch (cause) {
            if (isEnoentError(cause)) {
              return null;
            }
            throw cause;
          }
        };
        const entries = await readEntries();
        if (entries === null) {
          return [];
        }

        const dirs: Array<string> = [];
        for (const entry of entries) {
          const entryPath = path.join(worktreesAdminDir, entry.name);
          if (entry.isDirectory()) {
            dirs.push(entryPath);
          } else if (entry.isSymbolicLink()) {
            try {
              const stat = await NodeFSP.stat(entryPath);
              if (stat.isDirectory()) {
                dirs.push(entryPath);
              }
            } catch (cause) {
              if (!isEnoentError(cause)) {
                throw cause;
              }
            }
          }
        }
        return dirs;
      },
      catch: (cause) =>
        new WorkspaceBundleError({
          code: "git_error",
          message: `Failed to enumerate Git worktree admin directories in '${gitCommonDir}': ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });

  const findInUseWorktreeBranches = Effect.fn("WorkspaceBundle.findInUseWorktreeBranches")(
    function* (
      gitCommonDir: string,
    ): Effect.fn.Return<ReadonlyMap<string, string>, WorkspaceBundleError> {
      const normalizedCommonDir = path.resolve(gitCommonDir);
      const listResult = yield* runReadOnlyGit(
        "WorkspaceBundle.listWorktreesForInUseBranches",
        normalizedCommonDir,
        ["--git-dir", normalizedCommonDir, "worktree", "list", "--porcelain", "-z"],
        { outputMode: "error" },
      );
      if (listResult.stdoutTruncated) {
        return yield* new WorkspaceBundleError({
          code: "git_error",
          message: `Git command 'WorkspaceBundle.listWorktreesForInUseBranches' produced truncated git worktree list output in '${normalizedCommonDir}'.`,
        });
      }

      const inUseBranches = new Map<string, string>();
      for (const entry of parseWorktreeListPorcelainZ(listResult.stdout)) {
        if (entry.branch !== null && !inUseBranches.has(entry.branch)) {
          inUseBranches.set(entry.branch, `checked out by worktree '${entry.path}'`);
        }
      }

      const linkedWorktreeGitDirs = yield* listLinkedWorktreeGitDirs(normalizedCommonDir);
      const worktreeGitDirs = [normalizedCommonDir, ...linkedWorktreeGitDirs];

      for (const wtGitDir of worktreeGitDirs) {
        const rebaseMergeHeadName = yield* readOptionalGitStateFile(
          path.join(wtGitDir, "rebase-merge", "head-name"),
        );
        if (rebaseMergeHeadName !== null) {
          const branch = stripSingleRefsHeadsPrefix(
            stripTrailingAsciiLineEndings(rebaseMergeHeadName),
          );
          if (branch !== null && !inUseBranches.has(branch)) {
            inUseBranches.set(branch, `held by an active rebase in '${wtGitDir}'`);
          }
        }

        const rebaseApplyHeadName = yield* readOptionalGitStateFile(
          path.join(wtGitDir, "rebase-apply", "head-name"),
        );
        if (rebaseApplyHeadName !== null) {
          const branch = stripSingleRefsHeadsPrefix(
            stripTrailingAsciiLineEndings(rebaseApplyHeadName),
          );
          if (branch !== null && !inUseBranches.has(branch)) {
            inUseBranches.set(branch, `held by an active rebase in '${wtGitDir}'`);
          }
        }

        const rebaseUpdateRefs = yield* readOptionalGitStateFile(
          path.join(wtGitDir, "rebase-merge", "update-refs"),
        );
        if (rebaseUpdateRefs !== null) {
          for (const branch of parseRebaseUpdateRefsBranches(rebaseUpdateRefs)) {
            if (!inUseBranches.has(branch)) {
              inUseBranches.set(
                branch,
                `held by an active rebase (--update-refs) in '${wtGitDir}'`,
              );
            }
          }
        }

        const rebaseTodo = yield* readOptionalGitStateFile(
          path.join(wtGitDir, "rebase-merge", "git-rebase-todo"),
        );
        if (rebaseTodo !== null) {
          for (const branch of parseRebaseTodoUpdateRefBranches(rebaseTodo)) {
            if (!inUseBranches.has(branch)) {
              inUseBranches.set(
                branch,
                `held by an active rebase (--update-refs) in '${wtGitDir}'`,
              );
            }
          }
        }

        const rebaseDone = yield* readOptionalGitStateFile(
          path.join(wtGitDir, "rebase-merge", "done"),
        );
        if (rebaseDone !== null) {
          for (const branch of parseRebaseTodoUpdateRefBranches(rebaseDone)) {
            if (!inUseBranches.has(branch)) {
              inUseBranches.set(
                branch,
                `held by an active rebase (--update-refs) in '${wtGitDir}'`,
              );
            }
          }
        }

        const bisectStart = yield* readOptionalGitStateFile(path.join(wtGitDir, "BISECT_START"));
        if (bisectStart !== null) {
          // Git writes the literal branch short name (never a full refs/heads/ refname) into
          // BISECT_START, so preserve it verbatim (including any literal `refs/heads/` prefix
          // and non-ASCII Unicode whitespace such as U+00A0).
          const branch = stripTrailingAsciiLineEndings(bisectStart);
          if (branch.length > 0 && !inUseBranches.has(branch)) {
            inUseBranches.set(branch, `held by an active bisect in '${wtGitDir}'`);
          }
        }
      }

      return inUseBranches;
    },
  );

  const resolveRegisteredWorktreeGitDir = Effect.fn(
    "WorkspaceBundle.resolveRegisteredWorktreeGitDir",
  )(function* (
    gitCommonDir: string,
    repoCwd: string,
    worktreePath: string,
    registeredPath: string,
  ): Effect.fn.Return<string | null, WorkspaceBundleError> {
    const normalizedTarget = yield* normalizePathForComparison(path.resolve(repoCwd, worktreePath));
    const normalizedRegistered = yield* normalizePathForComparison(
      path.resolve(repoCwd, registeredPath),
    );
    const linkedWorktreeGitDirs = yield* listLinkedWorktreeGitDirs(gitCommonDir);
    for (const wtGitDir of linkedWorktreeGitDirs) {
      const gitdirFile = yield* readOptionalGitStateFile(path.join(wtGitDir, "gitdir"));
      if (gitdirFile === null) {
        continue;
      }
      const gitdirTarget = stripTrailingAsciiLineEndings(gitdirFile);
      if (gitdirTarget.length === 0) {
        continue;
      }
      const resolvedGitFile = path.resolve(wtGitDir, gitdirTarget);
      const candidateWorktreePath = yield* normalizePathForComparison(
        path.dirname(resolvedGitFile),
      );
      if (
        candidateWorktreePath === normalizedTarget ||
        candidateWorktreePath === normalizedRegistered
      ) {
        return wtGitDir;
      }
    }

    const pathState = yield* inspectPathWithLstat(worktreePath);
    if (pathState === "enoent") {
      return null;
    }

    const revParseResult = yield* runReadOnlyGit(
      "WorkspaceBundle.resolveWorktreeGitDir",
      worktreePath,
      ["rev-parse", "--path-format=absolute", "--git-dir"],
    );
    const resolvedGitDir = stripTrailingAsciiLineEndings(revParseResult.stdout);
    if (resolvedGitDir.length === 0) {
      return yield* new WorkspaceBundleError({
        code: "git_error",
        message: `Failed to resolve git dir for worktree '${worktreePath}'.`,
      });
    }
    return path.resolve(worktreePath, resolvedGitDir);
  });

  const detectActiveWorktreeOperation = Effect.fn("WorkspaceBundle.detectActiveWorktreeOperation")(
    function* (wtGitDir: string): Effect.fn.Return<string | null, WorkspaceBundleError> {
      const markerOperation = yield* Effect.tryPromise({
        try: async () => {
          for (const entry of ACTIVE_WORKTREE_GIT_OPERATIONS) {
            const indicatorPath = path.join(wtGitDir, entry.relativePath);
            try {
              await NodeFSP.lstat(indicatorPath);
              return `${entry.label} (${entry.relativePath})`;
            } catch (cause) {
              if (!isEnoentError(cause)) {
                throw cause;
              }
            }
          }
          return null;
        },
        catch: (cause) =>
          new WorkspaceBundleError({
            code: "git_error",
            message: `Failed to inspect active Git operations in '${wtGitDir}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });
      if (markerOperation !== null) {
        return markerOperation;
      }

      // Inspect the administrative <wtGitDir>/index directly regardless of whether worktreePath
      // still exists on disk (e.g. if the worktree directory was moved or renamed), so a
      // conflicted index such as single-commit `git cherry-pick --no-commit` always blocks removal.
      const indexPath = path.join(wtGitDir, "index");
      const indexExists = yield* Effect.tryPromise({
        try: async () => {
          try {
            await NodeFSP.stat(indexPath);
            return true;
          } catch (cause) {
            if (isEnoentError(cause)) {
              return false;
            }
            throw cause;
          }
        },
        catch: (cause) =>
          new WorkspaceBundleError({
            code: "git_error",
            message: `Failed to inspect Git worktree index '${indexPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });
      if (indexExists) {
        const unmergedResult = yield* runReadOnlyGit(
          "WorkspaceBundle.checkUnmergedWorktreeIndex",
          wtGitDir,
          ["--git-dir", wtGitDir, "--work-tree", wtGitDir, "ls-files", "--unmerged"],
          { env: { GIT_INDEX_FILE: indexPath } },
        );
        if (unmergedResult.stdout.length > 0 || unmergedResult.stdoutTruncated) {
          return "unmerged index entries (conflict)";
        }
      }
      return null;
    },
  );

  const verifyExpectedGitCommonDir = Effect.fn("WorkspaceBundle.verifyExpectedGitCommonDir")(
    function* (input: {
      readonly repoCwd: string;
      readonly expectedGitCommonDir: string;
      readonly expectedGitCommonDirIdentity: GitCommonDirIdentity;
    }): Effect.fn.Return<ResolvedGitCommonDir, WorkspaceBundleError> {
      if (
        typeof input.expectedGitCommonDir !== "string" ||
        input.expectedGitCommonDir.trim().length === 0
      ) {
        return yield* new WorkspaceBundleError({
          code: "git_error",
          message: `Refusing to remove worktree/branch in '${input.repoCwd}' because expectedGitCommonDir is empty.`,
        });
      }
      if (!isValidGitCommonDirIdentity(input.expectedGitCommonDirIdentity)) {
        return yield* new WorkspaceBundleError({
          code: "git_error",
          message: `Refusing to remove worktree/branch in '${input.repoCwd}' because expectedGitCommonDirIdentity is missing or invalid.`,
        });
      }
      const resolvedRepo = yield* resolveGitCommonDirIdentity(input.repoCwd);
      const expectedNormalized = path.resolve(input.expectedGitCommonDir);
      if (resolvedRepo === null || resolvedRepo.gitCommonDir !== expectedNormalized) {
        return yield* new WorkspaceBundleError({
          code: "git_error",
          message: `Refusing to remove worktree/branch in '${input.repoCwd}' because git common dir '${resolvedRepo?.gitCommonDir ?? "(none)"}' does not match expected '${expectedNormalized}'.`,
        });
      }
      if (!isSameGitCommonDirIdentity(input.expectedGitCommonDirIdentity, resolvedRepo.identity)) {
        return yield* new WorkspaceBundleError({
          code: "git_error",
          message: `Refusing to remove worktree/branch in '${input.repoCwd}' because filesystem identity of git common dir '${resolvedRepo.gitCommonDir}' does not match expected repository identity.`,
        });
      }
      return resolvedRepo;
    },
  );

  const removeWorktree: WorkspaceBundleShape["removeWorktree"] = Effect.fn(
    "WorkspaceBundle.removeWorktree",
  )(function* (input) {
    const verifiedRepo = yield* verifyExpectedGitCommonDir({
      repoCwd: input.repoCwd,
      expectedGitCommonDir: input.expectedGitCommonDir,
      expectedGitCommonDirIdentity: input.expectedGitCommonDirIdentity,
    });
    const expectedNormalized = verifiedRepo.gitCommonDir;

    let worktreeError: WorkspaceBundleError | null = null;
    let branchError: WorkspaceBundleError | null = null;
    const verifiedBranchHeadSha: string | null =
      typeof input.expectedBranchHeadSha === "string" &&
      input.expectedBranchHeadSha.trim().length > 0
        ? input.expectedBranchHeadSha.trim()
        : null;

    if (input.worktreePath !== undefined && input.worktreePath !== null) {
      const worktreePath = input.worktreePath;
      const beforeEntryResult = yield* Effect.result(
        findRegisteredWorktree(input.repoCwd, worktreePath),
      );

      if (Result.isFailure(beforeEntryResult)) {
        worktreeError = beforeEntryResult.failure;
      } else if (beforeEntryResult.success !== null) {
        const registered = beforeEntryResult.success;
        const registeredHeadSha =
          registered.headSha !== null && registered.headSha.trim().length > 0
            ? registered.headSha.trim()
            : null;
        if (registered.isMain) {
          worktreeError = new WorkspaceBundleError({
            code: "git_error",
            message: `Refusing to remove main worktree '${worktreePath}' in '${input.repoCwd}'.`,
          });
        } else if (
          input.expectedBranch !== undefined &&
          input.expectedBranch !== null &&
          registered.branch !== input.expectedBranch
        ) {
          worktreeError = new WorkspaceBundleError({
            code: "git_error",
            message: `Refusing to remove worktree '${worktreePath}' in '${input.repoCwd}' because it is checked out on branch '${registered.branch ?? "(detached)"}' instead of expected '${input.expectedBranch}'.`,
          });
        } else if (verifiedBranchHeadSha !== null && registeredHeadSha !== verifiedBranchHeadSha) {
          worktreeError = new WorkspaceBundleError({
            code: "git_error",
            message: `Refusing to remove worktree '${worktreePath}' in '${input.repoCwd}' because its HEAD commit '${registeredHeadSha ?? "(unknown)"}' does not match expected '${verifiedBranchHeadSha}'.`,
          });
        } else if (registered.locked) {
          const lockReason = registered.lockReason;
          worktreeError = new WorkspaceBundleError({
            code: "git_error",
            message:
              lockReason !== null
                ? `Cannot remove locked worktree '${worktreePath}': ${lockReason}`
                : `Cannot remove locked worktree '${worktreePath}'. Unlock the worktree before retrying cleanup.`,
          });
        } else {
          const activeOperationResult = yield* Effect.result(
            Effect.gen(function* () {
              const wtGitDir = yield* resolveRegisteredWorktreeGitDir(
                expectedNormalized,
                input.repoCwd,
                worktreePath,
                registered.path,
              );
              if (wtGitDir === null) {
                return null;
              }
              return yield* detectActiveWorktreeOperation(wtGitDir);
            }),
          );
          if (Result.isFailure(activeOperationResult)) {
            worktreeError = activeOperationResult.failure;
          } else if (activeOperationResult.success !== null) {
            worktreeError = new WorkspaceBundleError({
              code: "git_error",
              message: `Refusing to remove worktree '${worktreePath}' in '${input.repoCwd}' because it has an active git operation (${activeOperationResult.success}).`,
            });
          } else {
            const gitRemoveResult = yield* Effect.result(
              runGit(
                "WorkspaceBundle.removeWorktree",
                input.repoCwd,
                ["worktree", "remove", "--force", worktreePath],
                { allowNonZeroExit: true },
              ),
            );
            let gitRemoveDetail: string | null = null;
            if (Result.isFailure(gitRemoveResult)) {
              gitRemoveDetail = gitRemoveResult.failure.message;
            } else if (gitRemoveResult.success.exitCode !== 0) {
              const stderr = gitRemoveResult.success.stderr.trim();
              const stdout = gitRemoveResult.success.stdout.trim();
              gitRemoveDetail =
                stderr.length > 0
                  ? stderr
                  : stdout.length > 0
                    ? stdout
                    : `exit code ${gitRemoveResult.success.exitCode}`;
            }

            if (gitRemoveDetail !== null) {
              const pathStateResult = yield* Effect.result(inspectPathWithLstat(worktreePath));
              if (Result.isFailure(pathStateResult)) {
                worktreeError = pathStateResult.failure;
              } else if (pathStateResult.success === "exists") {
                worktreeError = new WorkspaceBundleError({
                  code: "git_error",
                  message: `Failed to remove worktree '${worktreePath}' in '${input.repoCwd}': ${gitRemoveDetail}`,
                });
              } else {
                // Directory is already ENOENT on disk; prune the stale Git worktree admin entry and
                // confirm the worktree is no longer registered.
                const pruneResult = yield* Effect.result(
                  runGit("WorkspaceBundle.pruneWorktrees", input.repoCwd, ["worktree", "prune"], {
                    allowNonZeroExit: true,
                  }),
                );
                if (Result.isFailure(pruneResult)) {
                  worktreeError = pruneResult.failure;
                } else if (pruneResult.success.exitCode !== 0) {
                  const detail =
                    pruneResult.success.stderr.trim() ||
                    pruneResult.success.stdout.trim() ||
                    `exit code ${pruneResult.success.exitCode}`;
                  worktreeError = new WorkspaceBundleError({
                    code: "git_error",
                    message: `Failed to prune worktrees in '${input.repoCwd}': ${detail}`,
                  });
                } else {
                  const verifyUnregisteredResult = yield* Effect.result(
                    findRegisteredWorktree(input.repoCwd, worktreePath),
                  );
                  if (Result.isFailure(verifyUnregisteredResult)) {
                    worktreeError = verifyUnregisteredResult.failure;
                  } else if (verifyUnregisteredResult.success !== null) {
                    worktreeError = new WorkspaceBundleError({
                      code: "git_error",
                      message: verifyUnregisteredResult.success.locked
                        ? `Worktree '${worktreePath}' is locked and still registered in '${input.repoCwd}'.`
                        : `Worktree '${worktreePath}' is still registered in '${input.repoCwd}' after prune (${gitRemoveDetail}).`,
                    });
                  }
                }
              }
            }
          }
        }
      } else {
        // Unregistered path: ENOENT is an idempotent no-op; any existing path on disk is refused
        // with git_error (NEVER run recursive filesystem removal).
        const pathStateResult = yield* Effect.result(inspectPathWithLstat(worktreePath));
        if (Result.isFailure(pathStateResult)) {
          worktreeError = pathStateResult.failure;
        } else if (pathStateResult.success === "exists") {
          worktreeError = new WorkspaceBundleError({
            code: "git_error",
            message: `Refusing to remove unregistered directory '${worktreePath}' in '${input.repoCwd}'.`,
          });
        }
      }
    }

    if (
      worktreeError === null &&
      input.branch !== undefined &&
      input.branch !== null &&
      input.branch.length > 0
    ) {
      const branch = input.branch;
      const expectedBranchHeadSha = verifiedBranchHeadSha;
      if (expectedBranchHeadSha === null || expectedBranchHeadSha.length === 0) {
        branchError = new WorkspaceBundleError({
          code: "git_error",
          message: `Refusing to delete branch '${branch}' in '${input.repoCwd}' without a verified expectedBranchHeadSha.`,
        });
      } else {
        const refName = `refs/heads/${branch}`;
        const symrefCheckBefore = yield* Effect.result(
          runReadOnlyGit(
            "WorkspaceBundle.checkBranchSymbolicRef",
            input.repoCwd,
            ["--git-dir", expectedNormalized, "symbolic-ref", "-q", refName],
            { allowNonZeroExit: true },
          ),
        );
        if (Result.isFailure(symrefCheckBefore)) {
          branchError = symrefCheckBefore.failure;
        } else if (symrefCheckBefore.success.exitCode === 0) {
          // Ref is a symbolic ref, not a direct branch owned by this transfer:
          // never delete the symref or its target.
          yield* Effect.logWarning(
            "Skipping branch deletion because ref is a symbolic ref rather than a direct branch.",
            {
              repoCwd: input.repoCwd,
              expectedGitCommonDir: expectedNormalized,
              branch,
              targetRef: stripTrailingAsciiLineEndings(symrefCheckBefore.success.stdout),
            },
          );
        } else if (symrefCheckBefore.success.exitCode !== 1) {
          const symrefDetail =
            symrefCheckBefore.success.stderr.trim() ||
            symrefCheckBefore.success.stdout.trim() ||
            `exit code ${symrefCheckBefore.success.exitCode}`;
          branchError = new WorkspaceBundleError({
            code: "git_error",
            message: `Failed to inspect symbolic-ref status for branch '${branch}' in '${input.repoCwd}': ${symrefDetail}`,
          });
        } else {
          // Re-verify expectedGitCommonDir + filesystem identity and confirm the branch is
          // neither checked out nor held by an active rebase/bisect in any worktree immediately
          // before deleting the ref with explicit `--git-dir` and `--no-deref` (`git update-ref -d`
          // bypasses Git worktree checkout/rebase/bisect guards).
          const reverifyRepoResult = yield* Effect.result(
            verifyExpectedGitCommonDir({
              repoCwd: input.repoCwd,
              expectedGitCommonDir: input.expectedGitCommonDir,
              expectedGitCommonDirIdentity: input.expectedGitCommonDirIdentity,
            }),
          );
          if (Result.isFailure(reverifyRepoResult)) {
            branchError = reverifyRepoResult.failure;
          } else {
            const inUseBranchesResult = yield* Effect.result(
              findInUseWorktreeBranches(expectedNormalized),
            );
            if (Result.isFailure(inUseBranchesResult)) {
              branchError = inUseBranchesResult.failure;
            } else {
              const inUseReason = inUseBranchesResult.success.get(branch);
              if (inUseReason !== undefined) {
                branchError = new WorkspaceBundleError({
                  code: "git_error",
                  message: `Refusing to delete branch '${branch}' in '${input.repoCwd}' because it is ${inUseReason}.`,
                });
              } else {
                const deleteBranchResult = yield* Effect.result(
                  runGit(
                    "WorkspaceBundle.deleteUnusedBranch",
                    input.repoCwd,
                    [
                      "--git-dir",
                      expectedNormalized,
                      "update-ref",
                      "--no-deref",
                      "-d",
                      refName,
                      expectedBranchHeadSha,
                    ],
                    { allowNonZeroExit: true },
                  ),
                );
                let deleteBranchDetail: string | null = null;
                if (Result.isFailure(deleteBranchResult)) {
                  deleteBranchDetail = deleteBranchResult.failure.message;
                } else if (deleteBranchResult.success.exitCode !== 0) {
                  const stderr = deleteBranchResult.success.stderr.trim();
                  const stdout = deleteBranchResult.success.stdout.trim();
                  deleteBranchDetail =
                    stderr.length > 0
                      ? stderr
                      : stdout.length > 0
                        ? stdout
                        : `exit code ${deleteBranchResult.success.exitCode}`;
                }

                if (deleteBranchDetail !== null) {
                  const symrefCheckAfter = yield* Effect.result(
                    runReadOnlyGit(
                      "WorkspaceBundle.verifyBranchNotSymbolicRef",
                      input.repoCwd,
                      ["--git-dir", expectedNormalized, "symbolic-ref", "-q", refName],
                      { allowNonZeroExit: true },
                    ),
                  );
                  if (Result.isFailure(symrefCheckAfter)) {
                    branchError = symrefCheckAfter.failure;
                  } else if (symrefCheckAfter.success.exitCode === 0) {
                    yield* Effect.logWarning(
                      "Skipping branch deletion because ref became a symbolic ref.",
                      {
                        repoCwd: input.repoCwd,
                        expectedGitCommonDir: expectedNormalized,
                        branch,
                        targetRef: stripTrailingAsciiLineEndings(symrefCheckAfter.success.stdout),
                      },
                    );
                  } else if (symrefCheckAfter.success.exitCode !== 1) {
                    const symrefAfterDetail =
                      symrefCheckAfter.success.stderr.trim() ||
                      symrefCheckAfter.success.stdout.trim() ||
                      `exit code ${symrefCheckAfter.success.exitCode}`;
                    branchError = new WorkspaceBundleError({
                      code: "git_error",
                      message: `Failed to verify symbolic-ref status for branch '${branch}' in '${input.repoCwd}': ${symrefAfterDetail}`,
                    });
                  } else {
                    const verifyBranchResult = yield* Effect.result(
                      runReadOnlyGit(
                        "WorkspaceBundle.verifyBranchDeleted",
                        input.repoCwd,
                        [
                          "--git-dir",
                          expectedNormalized,
                          "rev-parse",
                          "--verify",
                          "--quiet",
                          refName,
                        ],
                        { allowNonZeroExit: true },
                      ),
                    );
                    if (Result.isFailure(verifyBranchResult)) {
                      branchError = verifyBranchResult.failure;
                    } else if (verifyBranchResult.success.exitCode === 0) {
                      const actualSha = verifyBranchResult.success.stdout.trim();
                      if (actualSha.length > 0 && actualSha !== expectedBranchHeadSha) {
                        // Branch now points to a different commit SHA — it is no longer our created
                        // branch tip, so never force-delete it; return cleanly without touching it.
                        yield* Effect.logWarning(
                          "Skipping branch deletion because branch tip moved away from expected commit SHA.",
                          {
                            repoCwd: input.repoCwd,
                            branch,
                            expectedBranchHeadSha,
                            actualSha,
                          },
                        );
                      } else {
                        // Ref still points to expectedBranchHeadSha (e.g., transient .lock file):
                        // fail with retryable git_error so cleanup retries once the lock clears.
                        branchError = new WorkspaceBundleError({
                          code: "git_error",
                          message: `Failed to delete branch '${branch}' in '${input.repoCwd}': ${deleteBranchDetail}`,
                        });
                      }
                    } else if (verifyBranchResult.success.exitCode !== 1) {
                      const verifyDetail =
                        verifyBranchResult.success.stderr.trim() ||
                        verifyBranchResult.success.stdout.trim() ||
                        `exit code ${verifyBranchResult.success.exitCode}`;
                      branchError = new WorkspaceBundleError({
                        code: "git_error",
                        message: `Failed to verify deletion of branch '${branch}' in '${input.repoCwd}': ${verifyDetail}`,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    if (worktreeError !== null && branchError !== null) {
      return yield* new WorkspaceBundleError({
        code: worktreeError.code,
        message: `${worktreeError.message}; ${branchError.message}`,
        cause: worktreeError,
      });
    }
    if (worktreeError !== null) {
      return yield* worktreeError;
    }
    if (branchError !== null) {
      return yield* branchError;
    }
  });

  const importWorkspaceBundle: WorkspaceBundleShape["importWorkspaceBundle"] = Effect.fn(
    "WorkspaceBundle.importWorkspaceBundle",
  )(function* (input) {
    const resolvedRepo = yield* resolveGitCommonDirIdentity(input.repoCwd);
    if (resolvedRepo === null) {
      return yield* new WorkspaceBundleError({
        code: "not_git_repo",
        message: `Destination directory '${input.repoCwd}' is not a Git repository.`,
      });
    }
    const { gitCommonDir, identity: gitCommonDirIdentity } = resolvedRepo;

    const bundleExists = yield* fileSystem
      .exists(input.bundlePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!bundleExists) {
      return yield* new WorkspaceBundleError({
        code: "invalid_bundle",
        message: `Workspace bundle not found at '${input.bundlePath}'.`,
      });
    }

    const refPrefix = transferRefPrefix(input.transferId);
    const headRef = `${refPrefix}/head`;
    const indexRef = `${refPrefix}/index`;
    const worktreeRef = `${refPrefix}/worktree`;
    const allTempRefs = [headRef, indexRef, worktreeRef];

    let createdWorktreePath: string | null = null;
    let createdBranchName: string | null = null;
    let createdBranchHeadSha: string | null = null;
    let allocatedWorktree: AllocatedWorkspaceWorktree | null = null;
    let committed = false;

    const runWithAllocationLock = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      input.withWorktreeAllocationLock !== undefined
        ? input.withWorktreeAllocationLock(effect, { gitCommonDir })
        : effect;

    const scratchDir = yield* fileSystem
      .makeTempDirectory({ prefix: "t3-transfer-import-idx-" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBundleError({
              code: "io_error",
              message: "Failed to create scratch directory for workspace bundle import.",
              cause,
            }),
        ),
      );

    return yield* Effect.gen(function* () {
      const fetchResult = yield* runGit(
        "WorkspaceBundle.fetchBundle",
        input.repoCwd,
        ["fetch", "--no-tags", input.bundlePath, `+${refPrefix}/*:${refPrefix}/*`],
        { allowNonZeroExit: true, timeoutMs: BUNDLE_TIMEOUT_MS },
      );
      if (fetchResult.exitCode !== 0) {
        return yield* new WorkspaceBundleError({
          code: "invalid_bundle",
          message: `Failed to unbundle workspace transfer '${input.transferId}': ${fetchResult.stderr.trim() || fetchResult.stdout.trim()}`,
        });
      }

      const resolveOptionalRef = (ref: string) =>
        runGit(
          "WorkspaceBundle.resolveImportedRef",
          input.repoCwd,
          ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) =>
            result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null,
          ),
        );

      const [headSha, indexCommit, worktreeCommit] = yield* Effect.all([
        resolveOptionalRef(headRef),
        resolveOptionalRef(indexRef),
        resolveOptionalRef(worktreeRef),
      ]);

      if (headSha === null) {
        return yield* new WorkspaceBundleError({
          code: "invalid_bundle",
          message: `Workspace bundle is missing required ref '${headRef}'.`,
        });
      }

      const cleanupCreatedBranchRef = Effect.fn("WorkspaceBundle.cleanupCreatedBranchRef")(
        function* (branch: string, expectedHeadSha: string): Effect.fn.Return<boolean, never> {
          const reverifyRepoResult = yield* Effect.result(
            verifyExpectedGitCommonDir({
              repoCwd: input.repoCwd,
              expectedGitCommonDir: gitCommonDir,
              expectedGitCommonDirIdentity: gitCommonDirIdentity,
            }),
          );
          if (Result.isFailure(reverifyRepoResult)) {
            yield* Effect.logWarning(
              "Failed to re-verify git common dir while cleaning up newly created branch ref.",
              {
                repoCwd: input.repoCwd,
                branch,
                cause: reverifyRepoResult.failure,
              },
            );
            return false;
          }

          const refName = `refs/heads/${branch}`;
          const symrefBeforeResult = yield* Effect.result(
            runReadOnlyGit(
              "WorkspaceBundle.checkCreatedBranchSymbolicRefBeforeCleanup",
              input.repoCwd,
              ["--git-dir", gitCommonDir, "symbolic-ref", "-q", refName],
              { allowNonZeroExit: true },
            ),
          );
          if (Result.isFailure(symrefBeforeResult)) {
            yield* Effect.logWarning(
              "Failed to inspect symbolic-ref status while cleaning up newly created branch ref.",
              {
                repoCwd: input.repoCwd,
                branch,
                cause: symrefBeforeResult.failure,
              },
            );
            return false;
          }
          if (symrefBeforeResult.success.exitCode === 0) {
            // Ref became a symbolic ref: never delete the symref or its target.
            return true;
          }
          if (symrefBeforeResult.success.exitCode !== 1) {
            yield* Effect.logWarning(
              "Unexpected symbolic-ref exit code while cleaning up newly created branch ref.",
              {
                repoCwd: input.repoCwd,
                branch,
                exitCode: symrefBeforeResult.success.exitCode,
              },
            );
            return false;
          }

          const inUseBranchesResult = yield* Effect.result(findInUseWorktreeBranches(gitCommonDir));
          if (Result.isFailure(inUseBranchesResult)) {
            yield* Effect.logWarning(
              "Failed to inspect in-use worktree branches while cleaning up newly created branch ref.",
              {
                repoCwd: input.repoCwd,
                branch,
                cause: inUseBranchesResult.failure,
              },
            );
            return false;
          }
          if (inUseBranchesResult.success.has(branch)) {
            // Branch is in use by another worktree: never delete it.
            return true;
          }

          const deleteResult = yield* Effect.result(
            runGit(
              "WorkspaceBundle.deleteIncompleteCreatedBranchRef",
              input.repoCwd,
              [
                "--git-dir",
                gitCommonDir,
                "update-ref",
                "--no-deref",
                "-d",
                refName,
                expectedHeadSha,
              ],
              { allowNonZeroExit: true },
            ),
          );
          if (Result.isSuccess(deleteResult) && deleteResult.success.exitCode === 0) {
            return true;
          }

          const symrefAfterResult = yield* Effect.result(
            runReadOnlyGit(
              "WorkspaceBundle.checkCreatedBranchSymbolicRefAfterCleanup",
              input.repoCwd,
              ["--git-dir", gitCommonDir, "symbolic-ref", "-q", refName],
              { allowNonZeroExit: true },
            ),
          );
          if (Result.isFailure(symrefAfterResult)) {
            yield* Effect.logWarning(
              "Failed to verify symbolic-ref status after newly created branch ref cleanup failure.",
              {
                repoCwd: input.repoCwd,
                branch,
                cause: symrefAfterResult.failure,
              },
            );
            return false;
          }
          if (symrefAfterResult.success.exitCode === 0) {
            return true;
          }
          if (symrefAfterResult.success.exitCode !== 1) {
            return false;
          }

          const verifyResult = yield* Effect.result(
            runReadOnlyGit(
              "WorkspaceBundle.verifyIncompleteCreatedBranchRefDeleted",
              input.repoCwd,
              ["--git-dir", gitCommonDir, "rev-parse", "--verify", "--quiet", refName],
              { allowNonZeroExit: true },
            ),
          );
          if (Result.isFailure(verifyResult)) {
            yield* Effect.logWarning(
              "Failed to verify newly created branch ref after cleanup failure.",
              {
                repoCwd: input.repoCwd,
                branch,
                cause: verifyResult.failure,
              },
            );
            return false;
          }
          if (verifyResult.success.exitCode === 1) {
            return true;
          }
          if (verifyResult.success.exitCode === 0) {
            const actualSha = stripTrailingAsciiLineEndings(verifyResult.success.stdout);
            if (actualSha.length > 0 && actualSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
              // Branch moved to another commit; never touch it.
              return true;
            }
          }
          yield* Effect.logWarning(
            "Failed to delete newly created branch ref during incomplete add cleanup.",
            {
              repoCwd: input.repoCwd,
              branch,
              expectedHeadSha,
            },
          );
          return false;
        },
      );

      const verifyPendingBranchRefCreatedByTransfer = Effect.fn(
        "WorkspaceBundle.verifyPendingBranchRefCreatedByTransfer",
      )(function* (
        branch: string,
        expectedHeadSha: string,
        expectedReflogMessage: string,
      ): Effect.fn.Return<"cleanup" | "skip" | "error"> {
        const reverifyRepoResult = yield* Effect.result(
          verifyExpectedGitCommonDir({
            repoCwd: input.repoCwd,
            expectedGitCommonDir: gitCommonDir,
            expectedGitCommonDirIdentity: gitCommonDirIdentity,
          }),
        );
        if (Result.isFailure(reverifyRepoResult)) {
          yield* Effect.logWarning(
            "Failed to re-verify git common dir while checking pending branch ref creation.",
            {
              repoCwd: input.repoCwd,
              branch,
              cause: reverifyRepoResult.failure,
            },
          );
          return "error";
        }

        const refName = `refs/heads/${branch}`;
        const symrefResult = yield* Effect.result(
          runReadOnlyGit(
            "WorkspaceBundle.checkPendingBranchRefSymbolicRef",
            input.repoCwd,
            ["--git-dir", gitCommonDir, "symbolic-ref", "-q", refName],
            { allowNonZeroExit: true },
          ),
        );
        if (Result.isFailure(symrefResult)) {
          yield* Effect.logWarning(
            "Failed to inspect symbolic-ref status while checking pending branch ref creation.",
            {
              repoCwd: input.repoCwd,
              branch,
              cause: symrefResult.failure,
            },
          );
          return "error";
        }
        if (symrefResult.success.exitCode === 0) {
          return "skip";
        }
        if (symrefResult.success.exitCode !== 1) {
          yield* Effect.logWarning(
            "Unexpected symbolic-ref exit code while checking pending branch ref creation.",
            {
              repoCwd: input.repoCwd,
              branch,
              exitCode: symrefResult.success.exitCode,
            },
          );
          return "error";
        }

        const verifyRefResult = yield* Effect.result(
          runReadOnlyGit(
            "WorkspaceBundle.verifyPendingBranchRefExists",
            input.repoCwd,
            ["--git-dir", gitCommonDir, "rev-parse", "--verify", "--quiet", refName],
            { allowNonZeroExit: true },
          ),
        );
        if (Result.isFailure(verifyRefResult)) {
          yield* Effect.logWarning("Failed to verify pending destination branch ref existence.", {
            repoCwd: input.repoCwd,
            branch,
            cause: verifyRefResult.failure,
          });
          return "error";
        }
        if (verifyRefResult.success.exitCode === 1) {
          return "skip";
        }
        if (verifyRefResult.success.exitCode !== 0) {
          yield* Effect.logWarning(
            "Unexpected rev-parse exit code while checking pending branch ref creation.",
            {
              repoCwd: input.repoCwd,
              branch,
              exitCode: verifyRefResult.success.exitCode,
            },
          );
          return "error";
        }
        const actualSha = stripTrailingAsciiLineEndings(verifyRefResult.success.stdout);
        if (actualSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
          return "skip";
        }

        const reflogResult = yield* Effect.result(
          runReadOnlyGit(
            "WorkspaceBundle.checkPendingBranchReflog",
            input.repoCwd,
            [
              "--git-dir",
              gitCommonDir,
              "log",
              "-g",
              "-n",
              "1",
              "--no-show-signature",
              "--format=%H%x09%gs",
              refName,
              "--",
            ],
            { allowNonZeroExit: true },
          ),
        );
        if (Result.isFailure(reflogResult)) {
          yield* Effect.logWarning(
            "Failed to inspect reflog while checking pending branch ref creation.",
            {
              repoCwd: input.repoCwd,
              branch,
              cause: reflogResult.failure,
            },
          );
          return "error";
        }
        if (reflogResult.success.exitCode !== 0) {
          yield* Effect.logWarning(
            "Unexpected git log -g exit code while checking pending branch ref creation.",
            {
              repoCwd: input.repoCwd,
              branch,
              exitCode: reflogResult.success.exitCode,
            },
          );
          return "error";
        }

        const reflogLine = stripTrailingAsciiLineEndings(reflogResult.success.stdout);
        const tabIdx = reflogLine.indexOf("\t");
        if (tabIdx <= 0) {
          return "skip";
        }
        const loggedSha = reflogLine.slice(0, tabIdx);
        const loggedMessage = reflogLine.slice(tabIdx + 1);
        return loggedSha.toLowerCase() === expectedHeadSha.toLowerCase() &&
          loggedMessage === expectedReflogMessage
          ? "cleanup"
          : "skip";
      });

      const cleanupIncompleteAdd = Effect.fn("WorkspaceBundle.cleanupIncompleteAdd")(function* (
        allocation: AllocatedWorkspaceWorktree,
        options: {
          readonly gitWorktreeAddInvoked: boolean;
          readonly worktreePathPreExisted: boolean;
          readonly createdBranchRef: boolean;
          readonly pendingBranchRefCreationMessage?: string | null;
          readonly isExternalCollision?: boolean;
        },
      ) {
        // Still under the per-repo allocation lock: never leave ownership claiming a path or
        // branch this transfer did not create, and clean up only partial artifacts positively
        // verified as created/registered by this transfer.
        const clearOwnership =
          input.onWorktreeAllocationCleared !== undefined
            ? input.onWorktreeAllocationCleared(allocation)
            : Effect.void;
        const finishBranchCleanupAndClear = Effect.gen(function* () {
          let branchCleaned = true;
          if (allocation.branch.length > 0) {
            if (options.createdBranchRef) {
              branchCleaned = yield* cleanupCreatedBranchRef(allocation.branch, headSha);
            } else if (
              options.pendingBranchRefCreationMessage !== undefined &&
              options.pendingBranchRefCreationMessage !== null
            ) {
              const provenance = yield* verifyPendingBranchRefCreatedByTransfer(
                allocation.branch,
                headSha,
                options.pendingBranchRefCreationMessage,
              );
              if (provenance === "cleanup") {
                branchCleaned = yield* cleanupCreatedBranchRef(allocation.branch, headSha);
              } else if (provenance === "error") {
                branchCleaned = false;
              }
            }
          }
          if (branchCleaned) {
            yield* clearOwnership;
          }
        });

        if (
          options.isExternalCollision ||
          !options.gitWorktreeAddInvoked ||
          options.worktreePathPreExisted
        ) {
          yield* finishBranchCleanupAndClear;
          return;
        }

        // Inspect git worktree registration BEFORE removing anything (removing the worktree
        // unregisters it). Never guess on lookup failure: preserve ownership instead.
        const registeredEntryResult = yield* Effect.result(
          findRegisteredWorktree(input.repoCwd, allocation.worktreePath),
        );
        if (Result.isFailure(registeredEntryResult)) {
          yield* Effect.logWarning(
            "Failed to inspect registered worktrees while cleaning up incomplete git worktree add.",
            {
              repoCwd: input.repoCwd,
              worktreePath: allocation.worktreePath,
              branch: allocation.branch,
              cause: registeredEntryResult.failure,
            },
          );
          return;
        }
        const registeredEntry = registeredEntryResult.success;
        const expectedBranch = allocation.branch.length > 0 ? allocation.branch : null;
        const registeredHeadSha =
          registeredEntry?.headSha !== null &&
          registeredEntry?.headSha !== undefined &&
          registeredEntry.headSha.trim().length > 0
            ? registeredEntry.headSha.trim()
            : null;
        const headShaMatchesAllowed =
          registeredHeadSha !== null &&
          allocation.allowedBranchHeadShas.includes(registeredHeadSha);
        const matchesOwnedWorktree =
          registeredEntry !== null &&
          !registeredEntry.isMain &&
          headShaMatchesAllowed &&
          (expectedBranch !== null
            ? registeredEntry.branch === expectedBranch
            : registeredEntry.branch === null);

        // NEVER call recursive rm -rf on an unregistered directory and NEVER remove a worktree or
        // branch checked out on a different branch or commit SHA. Only remove worktreePath when
        // findRegisteredWorktree confirms worktreePath is registered as a non-main worktree
        // matching this transfer's branch and transfer-authored commit SHA.
        if (!matchesOwnedWorktree) {
          yield* finishBranchCleanupAndClear;
          return;
        }

        const cleanupPartialResult = yield* Effect.result(
          removeWorktree({
            repoCwd: input.repoCwd,
            expectedGitCommonDir: gitCommonDir,
            expectedGitCommonDirIdentity: gitCommonDirIdentity,
            worktreePath: allocation.worktreePath,
            branch: null,
            expectedBranch,
            expectedBranchHeadSha: registeredHeadSha,
          }),
        );
        if (Result.isSuccess(cleanupPartialResult)) {
          yield* finishBranchCleanupAndClear;
        } else {
          yield* Effect.logWarning(
            "Failed to clean up partial artifacts after incomplete git worktree add.",
            {
              repoCwd: input.repoCwd,
              worktreePath: allocation.worktreePath,
              branch: allocation.branch,
              cause: cleanupPartialResult.failure,
            },
          );
        }
      });

      const { branchAllocation, worktreePath } = yield* runWithAllocationLock(
        Effect.suspend(() => {
          let allocatedInLock: AllocatedWorkspaceWorktree | null = null;
          let createdBranchRef = false;
          let pendingBranchRefCreationMessage: string | null = null;
          let gitWorktreeAddInvoked = false;
          let gitWorktreeAddSucceeded = false;
          let worktreePathPreExisted = false;

          return Effect.gen(function* () {
            const [localBranchesOutput, inUseWorktreeBranches, dynamicReserved] = yield* Effect.all(
              [
                runReadOnlyGit(
                  "WorkspaceBundle.listLocalBranches",
                  input.repoCwd,
                  [
                    "--git-dir",
                    gitCommonDir,
                    "for-each-ref",
                    "--format=%(refname)%09%(objectname)%09%(symref)",
                    "refs/heads",
                  ],
                  { outputMode: "error" },
                ),
                findInUseWorktreeBranches(gitCommonDir),
                input.resolveReservedAllocations !== undefined
                  ? input.resolveReservedAllocations({
                      repoCwd: input.repoCwd,
                      gitCommonDir,
                      gitCommonDirIdentity,
                    })
                  : Effect.succeed({
                      reservedWorktreePaths: new Set<string>(),
                      reservedBranchNames: new Set<string>(),
                    } satisfies ReservedWorktreeAllocations),
              ],
            );
            if (localBranchesOutput.stdoutTruncated) {
              return yield* new WorkspaceBundleError({
                code: "git_error",
                message: `Git command 'WorkspaceBundle.listLocalBranches' produced truncated git for-each-ref output in '${input.repoCwd}'.`,
              });
            }

            const reservedBranches = new Set<string>(input.reservedBranchNames ?? []);
            for (const branch of dynamicReserved.reservedBranchNames) {
              reservedBranches.add(branch);
            }
            const reservedWorktreePaths = new Set<string>(input.reservedWorktreePaths ?? []);
            for (const reservedPath of dynamicReserved.reservedWorktreePaths) {
              reservedWorktreePaths.add(reservedPath);
            }

            const checkedOutBranches = new Set<string>(inUseWorktreeBranches.keys());
            const parsedLocalBranches = parseLocalBranchHeads(localBranchesOutput.stdout);
            const knownSymbolicBranches = new Set<string>(parsedLocalBranches.symbolicBranches);

            let branchAllocation = allocateDestinationBranch({
              sourceBranch: input.sourceBranch,
              headSha,
              targetLabel: input.targetLabel,
              transferId: input.transferId,
              localBranches: parsedLocalBranches.branchHeads,
              symbolicBranches: knownSymbolicBranches,
              checkedOutBranches,
              reservedBranches,
            });
            // Also guard against dangling symbolic refs under refs/heads/ (which git for-each-ref
            // omits) so import never dereferences a symbolic ref into another branch.
            for (;;) {
              const symrefCheck = yield* runReadOnlyGit(
                "WorkspaceBundle.checkAllocatedBranchSymbolicRef",
                input.repoCwd,
                [
                  "--git-dir",
                  gitCommonDir,
                  "symbolic-ref",
                  "-q",
                  `refs/heads/${branchAllocation.branch}`,
                ],
                { allowNonZeroExit: true },
              );
              if (symrefCheck.exitCode === 1) {
                break;
              }
              if (symrefCheck.exitCode !== 0) {
                const detail =
                  symrefCheck.stderr.trim() ||
                  symrefCheck.stdout.trim() ||
                  `exit code ${symrefCheck.exitCode}`;
                return yield* new WorkspaceBundleError({
                  code: "git_error",
                  message: `Failed to inspect symbolic-ref status for destination branch '${branchAllocation.branch}' in '${input.repoCwd}': ${detail}`,
                });
              }
              knownSymbolicBranches.add(branchAllocation.branch);
              branchAllocation = allocateDestinationBranch({
                sourceBranch: input.sourceBranch,
                headSha,
                targetLabel: input.targetLabel,
                transferId: input.transferId,
                localBranches: parsedLocalBranches.branchHeads,
                symbolicBranches: knownSymbolicBranches,
                checkedOutBranches,
                reservedBranches,
              });
            }

            let worktreePath: string;
            if (input.worktreePath !== undefined) {
              worktreePath = path.resolve(input.repoCwd, input.worktreePath);
              const normalizedRequested = yield* normalizePathForComparison(worktreePath);
              for (const reservedPath of reservedWorktreePaths) {
                if ((yield* normalizePathForComparison(reservedPath)) === normalizedRequested) {
                  return yield* new WorkspaceBundleError({
                    code: "io_error",
                    message: `Requested worktree path '${worktreePath}' is reserved by another in-flight transfer.`,
                  });
                }
              }
            } else {
              worktreePath = yield* allocateWorktreePath({
                repoCwd: input.repoCwd,
                gitCommonDir,
                branch: branchAllocation.branch,
                reservedWorktreePaths,
                ...(input.worktreesDirectory !== undefined
                  ? { worktreesDirectory: input.worktreesDirectory }
                  : {}),
              });
            }

            yield* fileSystem.makeDirectory(path.dirname(worktreePath), { recursive: true }).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceBundleError({
                    code: "io_error",
                    message: `Failed to create worktree parent directory for '${worktreePath}'.`,
                    cause,
                  }),
              ),
            );

            const existedBeforeAllocation = yield* fileSystem
              .exists(worktreePath)
              .pipe(Effect.orElseSucceed(() => true));
            if (existedBeforeAllocation) {
              return yield* new WorkspaceBundleError({
                code: "io_error",
                message: `Requested worktree path '${worktreePath}' already exists.`,
              });
            }

            const allocation: AllocatedWorkspaceWorktree = {
              repoCwd: input.repoCwd,
              gitCommonDir,
              gitCommonDirIdentity,
              worktreePath,
              branch: branchAllocation.branch,
              baseCommitSha: headSha,
              branchHeadSha: headSha,
              allowedBranchHeadShas: [headSha],
              createdBranch: !branchAllocation.useExistingBranch,
            };

            allocatedInLock = allocation;
            if (input.onWorktreeAllocated !== undefined) {
              yield* input.onWorktreeAllocated(allocation);
            }

            // Re-verify under the allocation lock right before invoking git worktree add that
            // worktreePath does not pre-exist (e.g. created externally while paused in callback).
            const existedBeforeAdd = yield* fileSystem
              .exists(worktreePath)
              .pipe(Effect.orElseSucceed(() => true));
            if (existedBeforeAdd) {
              worktreePathPreExisted = true;
              yield* cleanupIncompleteAdd(allocation, {
                gitWorktreeAddInvoked: false,
                worktreePathPreExisted: true,
                createdBranchRef: false,
              });
              allocatedInLock = null;
              return yield* new WorkspaceBundleError({
                code: "io_error",
                message: `Worktree path '${worktreePath}' already exists before git worktree add.`,
              });
            }

            // Re-verify immediately after onWorktreeAllocated and immediately before
            // branch creation / `git worktree add` that refs/heads/<branch> was not turned into
            // a symbolic ref (pointing to another branch or dangling) while paused in the callback.
            const allocatedRefName = `refs/heads/${branchAllocation.branch}`;
            const symrefCheckBeforeAdd = yield* Effect.result(
              runReadOnlyGit(
                "WorkspaceBundle.verifyAllocatedBranchNotSymbolicRefBeforeAdd",
                input.repoCwd,
                ["--git-dir", gitCommonDir, "symbolic-ref", "-q", allocatedRefName],
                { allowNonZeroExit: true },
              ),
            );
            if (Result.isFailure(symrefCheckBeforeAdd)) {
              yield* cleanupIncompleteAdd(allocation, {
                gitWorktreeAddInvoked: false,
                worktreePathPreExisted: false,
                createdBranchRef: false,
              });
              allocatedInLock = null;
              return yield* symrefCheckBeforeAdd.failure;
            }
            if (symrefCheckBeforeAdd.success.exitCode === 0) {
              const targetRef = stripTrailingAsciiLineEndings(symrefCheckBeforeAdd.success.stdout);
              yield* cleanupIncompleteAdd(allocation, {
                gitWorktreeAddInvoked: false,
                worktreePathPreExisted: false,
                createdBranchRef: false,
              });
              allocatedInLock = null;
              return yield* new WorkspaceBundleError({
                code: "git_error",
                message: `Refusing to add worktree for destination branch '${branchAllocation.branch}' in '${input.repoCwd}' because '${allocatedRefName}' is a symbolic ref targeting '${targetRef}'.`,
              });
            }
            if (symrefCheckBeforeAdd.success.exitCode !== 1) {
              const detail =
                symrefCheckBeforeAdd.success.stderr.trim() ||
                symrefCheckBeforeAdd.success.stdout.trim() ||
                `exit code ${symrefCheckBeforeAdd.success.exitCode}`;
              yield* cleanupIncompleteAdd(allocation, {
                gitWorktreeAddInvoked: false,
                worktreePathPreExisted: false,
                createdBranchRef: false,
              });
              allocatedInLock = null;
              return yield* new WorkspaceBundleError({
                code: "git_error",
                message: `Failed to verify symbolic-ref status for destination branch '${branchAllocation.branch}' in '${input.repoCwd}' before git worktree add: ${detail}`,
              });
            }

            // Never invoke `git worktree add -b`: if a dangling symref is introduced concurrently
            // at refs/heads/<branch>, `worktree add -b` dereferences it and creates the foreign
            // target branch. Instead, atomically create the direct ref via `update-ref --no-deref`
            // against the zero OID, then attach the worktree with `git worktree add` (no `-b`).
            if (!branchAllocation.useExistingBranch) {
              const nullOid = "0".repeat(headSha.length);
              const reflogMessage = `t3-session-transfer:create-branch:${NodeCrypto.randomUUID()}`;
              pendingBranchRefCreationMessage = reflogMessage;
              const createRefResult = yield* Effect.result(
                runGit(
                  "WorkspaceBundle.createDestinationBranchRef",
                  input.repoCwd,
                  [
                    "--git-dir",
                    gitCommonDir,
                    "update-ref",
                    "--create-reflog",
                    "--no-deref",
                    "-m",
                    reflogMessage,
                    allocatedRefName,
                    headSha,
                    nullOid,
                  ],
                  {
                    allowNonZeroExit: true,
                    env: TRANSFER_REFLOG_ENV,
                  },
                ),
              );
              if (Result.isFailure(createRefResult)) {
                yield* cleanupIncompleteAdd(allocation, {
                  gitWorktreeAddInvoked: false,
                  worktreePathPreExisted: false,
                  createdBranchRef: false,
                  pendingBranchRefCreationMessage,
                });
                pendingBranchRefCreationMessage = null;
                allocatedInLock = null;
                return yield* createRefResult.failure;
              }
              if (createRefResult.success.exitCode !== 0) {
                pendingBranchRefCreationMessage = null;
                const detail =
                  createRefResult.success.stderr.trim() ||
                  createRefResult.success.stdout.trim() ||
                  `exit code ${createRefResult.success.exitCode}`;
                yield* cleanupIncompleteAdd(allocation, {
                  gitWorktreeAddInvoked: false,
                  worktreePathPreExisted: false,
                  createdBranchRef: false,
                });
                allocatedInLock = null;
                return yield* new WorkspaceBundleError({
                  code: "git_error",
                  message: `Failed to atomically create destination branch ref '${allocatedRefName}' in '${input.repoCwd}': ${detail}`,
                });
              }
              createdBranchRef = true;
              pendingBranchRefCreationMessage = null;
            }

            const addArgs = ["worktree", "add", "--", worktreePath, branchAllocation.branch];
            gitWorktreeAddInvoked = true;
            const addResult = yield* Effect.result(
              runGit("WorkspaceBundle.addWorktree", input.repoCwd, addArgs, {
                timeoutMs: BUNDLE_TIMEOUT_MS,
              }),
            );
            if (Result.isFailure(addResult)) {
              const errMsg = addResult.failure.message.toLowerCase();
              const isExternalCollision =
                errMsg.includes("already exists") ||
                errMsg.includes("already used by worktree") ||
                errMsg.includes("already checked out");
              yield* cleanupIncompleteAdd(allocation, {
                isExternalCollision,
                gitWorktreeAddInvoked,
                worktreePathPreExisted,
                createdBranchRef,
              });
              allocatedInLock = null;
              return yield* addResult.failure;
            }

            // Verify under the lock that the registered worktree is non-main, on the expected
            // branch at exact headSha, and not a symref; on mismatch, remove only the new worktree
            // (plus CAS-deleting our newly created ref if untouched), clear ownership, and fail.
            const [registeredAfterAddResult, symrefCheckAfterAddResult] = yield* Effect.all([
              Effect.result(findRegisteredWorktree(input.repoCwd, worktreePath)),
              Effect.result(
                runReadOnlyGit(
                  "WorkspaceBundle.verifyAllocatedBranchNotSymbolicRefAfterAdd",
                  input.repoCwd,
                  ["--git-dir", gitCommonDir, "symbolic-ref", "-q", allocatedRefName],
                  { allowNonZeroExit: true },
                ),
              ),
            ]);
            const registeredAfterAdd = Result.isSuccess(registeredAfterAddResult)
              ? registeredAfterAddResult.success
              : null;
            const registeredAfterAddHeadSha =
              registeredAfterAdd !== null && registeredAfterAdd.headSha !== null
                ? stripTrailingAsciiLineEndings(registeredAfterAdd.headSha)
                : null;
            const postAddHeadShaMatches =
              registeredAfterAddHeadSha !== null &&
              registeredAfterAddHeadSha.toLowerCase() === headSha.toLowerCase();
            const postAddRegisteredValid =
              registeredAfterAdd !== null &&
              !registeredAfterAdd.isMain &&
              registeredAfterAdd.branch === branchAllocation.branch &&
              postAddHeadShaMatches;
            const postAddNotSymbolic =
              Result.isSuccess(symrefCheckAfterAddResult) &&
              symrefCheckAfterAddResult.success.exitCode === 1;

            if (!postAddRegisteredValid || !postAddNotSymbolic) {
              const clearOwnership =
                input.onWorktreeAllocationCleared !== undefined
                  ? input.onWorktreeAllocationCleared(allocation)
                  : Effect.void;
              let worktreeCleaned = false;
              if (Result.isSuccess(registeredAfterAddResult)) {
                if (registeredAfterAdd !== null && !registeredAfterAdd.isMain) {
                  const removePostAddResult = yield* Effect.result(
                    removeWorktree({
                      repoCwd: input.repoCwd,
                      expectedGitCommonDir: gitCommonDir,
                      expectedGitCommonDirIdentity: gitCommonDirIdentity,
                      worktreePath,
                      branch: null,
                      expectedBranch: registeredAfterAdd.branch,
                      expectedBranchHeadSha: registeredAfterAdd.headSha,
                    }),
                  );
                  if (Result.isSuccess(removePostAddResult)) {
                    worktreeCleaned = true;
                  } else {
                    yield* Effect.logWarning(
                      "Failed to remove newly added worktree after post-add verification failure.",
                      {
                        repoCwd: input.repoCwd,
                        worktreePath,
                        branch: branchAllocation.branch,
                        registeredBranch: registeredAfterAdd.branch,
                        registeredHeadSha: registeredAfterAddHeadSha,
                        expectedHeadSha: headSha,
                        cause: removePostAddResult.failure,
                      },
                    );
                  }
                } else {
                  worktreeCleaned = true;
                }
              } else {
                yield* Effect.logWarning(
                  "Failed to inspect newly added worktree after post-add verification failure.",
                  {
                    repoCwd: input.repoCwd,
                    worktreePath,
                    branch: branchAllocation.branch,
                    cause: registeredAfterAddResult.failure,
                  },
                );
              }
              if (worktreeCleaned) {
                const branchCleaned =
                  createdBranchRef && branchAllocation.branch.length > 0
                    ? yield* cleanupCreatedBranchRef(branchAllocation.branch, headSha)
                    : true;
                if (branchCleaned) {
                  yield* clearOwnership;
                }
              }
              allocatedInLock = null;

              const postAddFailureReason = Result.isFailure(registeredAfterAddResult)
                ? `failed to verify registered worktree: ${registeredAfterAddResult.failure.message}`
                : Result.isFailure(symrefCheckAfterAddResult)
                  ? `failed to verify symbolic-ref status for '${allocatedRefName}': ${symrefCheckAfterAddResult.failure.message}`
                  : symrefCheckAfterAddResult.success.exitCode === 0
                    ? `'${allocatedRefName}' is a symbolic ref targeting '${stripTrailingAsciiLineEndings(symrefCheckAfterAddResult.success.stdout)}'`
                    : symrefCheckAfterAddResult.success.exitCode !== 1
                      ? `symbolic-ref check for '${allocatedRefName}' failed with exit code ${symrefCheckAfterAddResult.success.exitCode}`
                      : registeredAfterAdd === null
                        ? `worktree '${worktreePath}' is not registered after git worktree add`
                        : registeredAfterAdd.isMain
                          ? `worktree '${worktreePath}' resolved to the main worktree`
                          : registeredAfterAdd.branch !== branchAllocation.branch
                            ? `worktree '${worktreePath}' attached to branch '${registeredAfterAdd.branch ?? "(detached)"}' instead of expected '${branchAllocation.branch}'`
                            : `worktree '${worktreePath}' checked out HEAD '${registeredAfterAddHeadSha ?? "(unknown)"}' instead of expected '${headSha}'`;
              return yield* new WorkspaceBundleError({
                code: "git_error",
                message: `Post-add verification failed for destination branch '${branchAllocation.branch}' in '${input.repoCwd}': ${postAddFailureReason}.`,
              });
            }

            const createdAllocation: AllocatedWorkspaceWorktree = {
              ...allocation,
              baseCommitSha: headSha,
              branchHeadSha: headSha,
              allowedBranchHeadShas: [headSha],
            };
            gitWorktreeAddSucceeded = true;
            createdWorktreePath = worktreePath;
            createdBranchHeadSha = headSha;
            if (!branchAllocation.useExistingBranch) {
              createdBranchName = branchAllocation.branch;
            }
            allocatedWorktree = createdAllocation;
            if (input.onWorktreeCreated !== undefined) {
              yield* input.onWorktreeCreated(createdAllocation);
            }
            return { branchAllocation, worktreePath };
          }).pipe(
            Effect.onInterrupt(() =>
              !gitWorktreeAddSucceeded && allocatedInLock !== null
                ? cleanupIncompleteAdd(allocatedInLock, {
                    gitWorktreeAddInvoked,
                    worktreePathPreExisted,
                    createdBranchRef,
                    pendingBranchRefCreationMessage,
                  })
                : Effect.void,
            ),
          );
        }),
      );

      // Run optional non-destructive setup hook while worktree is clean at HEAD,
      // BEFORE applying staged/unstaged/untracked dirty layers.
      if (input.beforeApplyDirtyLayers !== undefined) {
        yield* input.beforeApplyDirtyLayers(worktreePath);
      }

      // Apply Layer 2 (staged index) into the new worktree's real index + working files.
      if (indexCommit !== null) {
        yield* runGit("WorkspaceBundle.applyIndexLayer", worktreePath, [
          "read-tree",
          "--reset",
          "-u",
          `${indexCommit}^{tree}`,
        ]);
      }

      // Apply Layer 3 (working tree + untracked files) WITHOUT modifying the real git index.
      if (worktreeCommit !== null) {
        const worktreeGitDirRaw = stripTrailingAsciiLineEndings(
          (yield* runGit("WorkspaceBundle.worktreeGitDir", worktreePath, [
            "rev-parse",
            "--git-dir",
          ])).stdout,
        );
        const worktreeGitDir = path.resolve(worktreePath, worktreeGitDirRaw);
        const worktreeRealIndex = path.join(worktreeGitDir, "index");
        const applyIndexPath = path.join(scratchDir, "apply-worktree-index");

        yield* fileSystem.copyFile(worktreeRealIndex, applyIndexPath).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceBundleError({
                code: "io_error",
                message: "Failed to copy worktree index to apply dirty worktree layer.",
                cause,
              }),
          ),
        );

        const baseTreeRef = indexCommit !== null ? `${indexCommit}^{tree}` : `${headSha}^{tree}`;
        const mergeApply = yield* runGit(
          "WorkspaceBundle.applyWorktreeLayer",
          worktreePath,
          ["read-tree", "-m", "-u", baseTreeRef, `${worktreeCommit}^{tree}`],
          {
            env: { GIT_INDEX_FILE: applyIndexPath },
            allowNonZeroExit: true,
            timeoutMs: BUNDLE_TIMEOUT_MS,
          },
        );
        if (mergeApply.exitCode !== 0) {
          yield* runGit(
            "WorkspaceBundle.applyWorktreeLayerForce",
            worktreePath,
            ["read-tree", "--reset", "-u", `${worktreeCommit}^{tree}`],
            {
              env: { GIT_INDEX_FILE: applyIndexPath },
              timeoutMs: BUNDLE_TIMEOUT_MS,
            },
          );
        }
      }

      const authoredBranchHeadSha = createdBranchHeadSha ?? headSha;
      committed = true;
      return {
        branch: branchAllocation.branch,
        createdBranch: !branchAllocation.useExistingBranch,
        worktreePath,
        gitCommonDir,
        gitCommonDirIdentity,
        headSha,
        baseCommitSha: headSha,
        branchHeadSha: authoredBranchHeadSha,
        allowedBranchHeadShas: [headSha],
        branchRenamedFrom: branchAllocation.branchRenamedFrom,
        warnings: branchAllocation.warning !== null ? [branchAllocation.warning] : [],
      } satisfies ImportWorkspaceBundleResult;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* deleteRefsBestEffort(input.repoCwd, allTempRefs);
          yield* fileSystem
            .remove(scratchDir, { recursive: true, force: true })
            .pipe(Effect.ignore);
          if (!committed && createdWorktreePath !== null) {
            yield* runWithAllocationLock(
              Effect.gen(function* () {
                const cleanupResult = yield* Effect.result(
                  removeWorktree({
                    repoCwd: input.repoCwd,
                    expectedGitCommonDir: gitCommonDir,
                    expectedGitCommonDirIdentity: gitCommonDirIdentity,
                    worktreePath: createdWorktreePath,
                    branch: createdBranchName,
                    expectedBranch: allocatedWorktree?.branch ?? createdBranchName,
                    expectedBranchHeadSha: createdBranchHeadSha,
                  }),
                );
                if (Result.isSuccess(cleanupResult)) {
                  if (
                    allocatedWorktree !== null &&
                    input.onWorktreeAllocationCleared !== undefined
                  ) {
                    yield* input.onWorktreeAllocationCleared(allocatedWorktree);
                  }
                } else {
                  yield* Effect.logWarning(
                    "Failed to clean up partial workspace bundle import worktree.",
                    {
                      repoCwd: input.repoCwd,
                      worktreePath: createdWorktreePath,
                      branch: createdBranchName,
                      cause: cleanupResult.failure,
                    },
                  );
                }
              }),
            );
          }
        }),
      ),
    );
  });

  return WorkspaceBundle.of({
    resolveGitCommonDir,
    resolveGitCommonDirIdentity,
    findRegisteredWorktree,
    exportWorkspaceBundle,
    importWorkspaceBundle,
    removeWorktree,
  });
});

export const layer: Layer.Layer<
  WorkspaceBundle,
  never,
  | VcsProcess.VcsProcess
  | FileSystem.FileSystem
  | Path.Path
  | Digest.Digest
  | ServerConfig.ServerConfig
> = Layer.effect(WorkspaceBundle, make);

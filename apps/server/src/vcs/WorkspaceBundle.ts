// @effect-diagnostics nodeBuiltinImport:off -- streaming sha256 hash of large git bundles avoids buffering the entire file in memory.
import * as NodeCrypto from "node:crypto";
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

interface AllocatedWorkspaceWorktree {
  readonly repoCwd: string;
  readonly gitCommonDir: string;
  readonly worktreePath: string;
  readonly branch: string;
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
  }) => Effect.Effect<ReservedWorktreeAllocations, WorkspaceBundleError>;
  readonly withWorktreeAllocationLock?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    context?: { readonly gitCommonDir: string },
  ) => Effect.Effect<A, E, R>;
  readonly onWorktreeAllocated?: (
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
  readonly headSha: string;
  readonly branchRenamedFrom: string | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface RemoveWorkspaceWorktreeInput {
  readonly repoCwd: string;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
}

export interface WorkspaceBundleShape {
  readonly resolveGitCommonDir: (cwd: string) => Effect.Effect<string | null, WorkspaceBundleError>;
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

interface ParsedWorktreeEntry {
  readonly path: string;
  readonly isMain: boolean;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly lockReason: string | null;
}

function parseWorktreeListPorcelainZ(stdout: string): ReadonlyArray<ParsedWorktreeEntry> {
  const entries: Array<ParsedWorktreeEntry> = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentLocked = false;
  let currentLockReason: string | null = null;

  const flush = () => {
    if (currentPath !== null) {
      entries.push({
        path: currentPath,
        isMain: entries.length === 0,
        branch: currentBranch,
        locked: currentLocked,
        lockReason: currentLockReason,
      });
    }
    currentPath = null;
    currentBranch = null;
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
      if (rawField.startsWith("branch refs/heads/")) {
        currentBranch = rawField.slice("branch refs/heads/".length);
      } else if (rawField === "locked") {
        currentLocked = true;
      } else if (rawField.startsWith("locked ")) {
        currentLocked = true;
        currentLockReason = rawField.slice("locked ".length).trim() || null;
      }
    }
  }
  flush();
  return entries;
}

function parseLocalBranchHeads(stdout: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx <= 0) continue;
    const refName = line.slice(0, spaceIdx);
    const sha = line.slice(spaceIdx + 1).trim();
    if (refName && sha) {
      map.set(refName, sha);
    }
  }
  return map;
}

function allocateDestinationBranch(input: {
  readonly sourceBranch: string | null;
  readonly headSha: string;
  readonly targetLabel: "boat" | "local";
  readonly transferId: string;
  readonly localBranches: ReadonlyMap<string, string>;
  readonly checkedOutBranches: ReadonlySet<string>;
  readonly reservedBranches?: ReadonlySet<string>;
}): {
  readonly branch: string;
  readonly useExistingBranch: boolean;
  readonly branchRenamedFrom: string | null;
  readonly warning: string | null;
} {
  const shortId = shortTransferId(input.transferId);
  const isReserved = (candidate: string) => input.reservedBranches?.has(candidate) ?? false;
  const isAvailableForNew = (candidate: string) =>
    !input.localBranches.has(candidate) &&
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
  const isCheckedOut = input.checkedOutBranches.has(input.sourceBranch);
  const isSourceReserved = isReserved(input.sourceBranch);

  if (!isCheckedOut && !isSourceReserved && existingSha === undefined) {
    return {
      branch: input.sourceBranch,
      useExistingBranch: false,
      branchRenamedFrom: null,
      warning: null,
    };
  }

  if (!isCheckedOut && !isSourceReserved && existingSha === input.headSha) {
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

  const reason = isCheckedOut
    ? "already checked out in another worktree"
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
    },
  ) => runGit(operation, cwd, [...READ_ONLY_GIT_FLAGS, ...args], options);

  const deleteRefsBestEffort = (cwd: string, refs: ReadonlyArray<string>) =>
    Effect.forEach(
      refs,
      (ref) =>
        runGit("WorkspaceBundle.deleteRef", cwd, ["update-ref", "-d", ref], {
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
          const parts = line.slice(1).trim().split(/\s+/);
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
    const [rawTopLevel, rawGitDir, rawGitCommonDir] = revInfo.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim());
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
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { allowNonZeroExit: true },
    );
    const branch =
      branchCheck.exitCode === 0 && branchCheck.stdout.trim().length > 0
        ? branchCheck.stdout.trim()
        : null;
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
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      return null;
    }
    return yield* normalizePathForComparison(path.resolve(cwd, result.stdout.trim()));
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

  const removeWorktree: WorkspaceBundleShape["removeWorktree"] = Effect.fn(
    "WorkspaceBundle.removeWorktree",
  )(function* (input) {
    let worktreeError: WorkspaceBundleError | null = null;
    let branchError: WorkspaceBundleError | null = null;

    if (input.worktreePath !== undefined && input.worktreePath !== null) {
      const worktreePath = input.worktreePath;
      const beforeEntryResult = yield* Effect.result(
        findRegisteredWorktree(input.repoCwd, worktreePath),
      );
      let gitRemoveDetail: string | null = null;
      let allowFilesystemFallback = false;

      if (Result.isFailure(beforeEntryResult)) {
        worktreeError = beforeEntryResult.failure;
      } else if (beforeEntryResult.success?.isMain) {
        worktreeError = new WorkspaceBundleError({
          code: "git_error",
          message: `Refusing to remove main worktree '${worktreePath}' in '${input.repoCwd}'.`,
        });
      } else if (beforeEntryResult.success?.locked) {
        const lockReason = beforeEntryResult.success.lockReason;
        worktreeError = new WorkspaceBundleError({
          code: "git_error",
          message:
            lockReason !== null
              ? `Cannot remove locked worktree '${worktreePath}': ${lockReason}`
              : `Cannot remove locked worktree '${worktreePath}'. Unlock the worktree before retrying cleanup.`,
        });
      } else {
        allowFilesystemFallback = true;
        if (beforeEntryResult.success !== null) {
          const gitRemoveResult = yield* Effect.result(
            runGit(
              "WorkspaceBundle.removeWorktree",
              input.repoCwd,
              ["worktree", "remove", "--force", worktreePath],
              { allowNonZeroExit: true },
            ),
          );
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
            const postRemoveCheck = yield* Effect.result(
              findRegisteredWorktree(input.repoCwd, worktreePath),
            );
            if (Result.isFailure(postRemoveCheck)) {
              allowFilesystemFallback = false;
              worktreeError = postRemoveCheck.failure;
            } else if (postRemoveCheck.success?.locked) {
              allowFilesystemFallback = false;
              const lockReason = postRemoveCheck.success.lockReason;
              worktreeError = new WorkspaceBundleError({
                code: "git_error",
                message:
                  lockReason !== null
                    ? `Cannot remove locked worktree '${worktreePath}': ${lockReason}`
                    : `Cannot remove locked worktree '${worktreePath}'. Unlock the worktree before retrying cleanup.`,
              });
            }
          }
        }
      }

      if (allowFilesystemFallback) {
        const fsRemoveResult = yield* Effect.result(
          fileSystem.remove(worktreePath, { recursive: true }).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.void,
            ),
            Effect.mapError(
              (cause) =>
                new WorkspaceBundleError({
                  code: "io_error",
                  message: `Failed to remove worktree directory '${worktreePath}': ${cause.message}`,
                  cause,
                }),
            ),
          ),
        );
        if (Result.isFailure(fsRemoveResult)) {
          worktreeError = fsRemoveResult.failure;
        } else {
          const stillExistsResult = yield* Effect.result(
            fileSystem.exists(worktreePath).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(false),
              ),
              Effect.mapError(
                (cause) =>
                  new WorkspaceBundleError({
                    code: "io_error",
                    message: `Failed to verify removal of worktree directory '${worktreePath}': ${cause.message}`,
                    cause,
                  }),
              ),
            ),
          );
          if (Result.isFailure(stillExistsResult)) {
            worktreeError = stillExistsResult.failure;
          } else if (stillExistsResult.success) {
            worktreeError = new WorkspaceBundleError({
              code: "io_error",
              message:
                gitRemoveDetail !== null
                  ? `Worktree directory '${worktreePath}' still exists after removal (${gitRemoveDetail}).`
                  : `Worktree directory '${worktreePath}' still exists after removal.`,
            });
          }
        }

        const pruneResult = yield* Effect.result(
          runGit("WorkspaceBundle.pruneWorktrees", input.repoCwd, ["worktree", "prune"], {
            allowNonZeroExit: true,
          }),
        );
        if (worktreeError === null) {
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
          }
        }

        if (worktreeError === null) {
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
                : gitRemoveDetail !== null
                  ? `Worktree '${worktreePath}' is still registered in '${input.repoCwd}' after removal (${gitRemoveDetail}).`
                  : `Worktree '${worktreePath}' is still registered in '${input.repoCwd}' after removal.`,
            });
          }
        }
      }
    }

    if (input.branch !== undefined && input.branch !== null && input.branch.length > 0) {
      const branch = input.branch;
      const deleteBranchResult = yield* Effect.result(
        runGit(
          "WorkspaceBundle.deleteUnusedBranch",
          input.repoCwd,
          ["branch", "-D", "--", branch],
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

      const verifyBranchResult = yield* Effect.result(
        runGit(
          "WorkspaceBundle.verifyBranchDeleted",
          input.repoCwd,
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          { allowNonZeroExit: true },
        ),
      );
      if (Result.isFailure(verifyBranchResult)) {
        branchError = verifyBranchResult.failure;
      } else if (verifyBranchResult.success.exitCode === 0) {
        branchError = new WorkspaceBundleError({
          code: "git_error",
          message:
            deleteBranchDetail !== null
              ? `Failed to delete branch '${branch}' in '${input.repoCwd}': ${deleteBranchDetail}`
              : `Branch '${branch}' still exists in '${input.repoCwd}' after deletion.`,
        });
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
    const insideWorkTree = yield* runGit(
      "WorkspaceBundle.importIsGitRepo",
      input.repoCwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { allowNonZeroExit: true },
    );
    if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim().length === 0) {
      return yield* new WorkspaceBundleError({
        code: "not_git_repo",
        message: `Destination directory '${input.repoCwd}' is not a Git repository.`,
      });
    }
    const gitCommonDir = yield* normalizePathForComparison(
      path.resolve(input.repoCwd, insideWorkTree.stdout.trim()),
    );

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

      const cleanupIncompleteAdd = Effect.fn("WorkspaceBundle.cleanupIncompleteAdd")(function* (
        allocation: AllocatedWorkspaceWorktree,
        options?: { readonly isExternalCollision?: boolean },
      ) {
        // Still under the per-repo allocation lock: never leave ownership claiming a path or
        // branch this transfer did not create, and clean up any partial artifacts we created.
        const clearOwnership =
          input.onWorktreeAllocationCleared !== undefined
            ? input.onWorktreeAllocationCleared(allocation)
            : Effect.void;
        if (options?.isExternalCollision) {
          yield* clearOwnership;
          return;
        }
        const pathExists = yield* fileSystem
          .exists(allocation.worktreePath)
          .pipe(Effect.orElseSucceed(() => false));
        const registeredEntry = yield* findRegisteredWorktree(
          input.repoCwd,
          allocation.worktreePath,
        ).pipe(Effect.orElseSucceed(() => null));
        const hasWorktreeArtifact = pathExists || registeredEntry !== null;
        const hasBranchArtifact = allocation.createdBranch
          ? yield* runGit(
              "WorkspaceBundle.checkFailedAddBranch",
              input.repoCwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${allocation.branch}`],
              { allowNonZeroExit: true },
            ).pipe(
              Effect.map((r) => r.exitCode === 0),
              Effect.orElseSucceed(() => true),
            )
          : false;

        if (!hasWorktreeArtifact && !hasBranchArtifact) {
          yield* clearOwnership;
          return;
        }

        const cleanupPartialResult = yield* Effect.result(
          removeWorktree({
            repoCwd: input.repoCwd,
            worktreePath: hasWorktreeArtifact ? allocation.worktreePath : null,
            branch: hasBranchArtifact ? allocation.branch : null,
          }),
        );
        if (Result.isSuccess(cleanupPartialResult)) {
          yield* clearOwnership;
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
          let addSucceeded = false;

          return Effect.gen(function* () {
            const [localBranchesOutput, registeredWorktrees, dynamicReserved] = yield* Effect.all([
              runGit("WorkspaceBundle.listLocalBranches", input.repoCwd, [
                "for-each-ref",
                "--format=%(refname:short) %(objectname)",
                "refs/heads",
              ]),
              listRegisteredWorktrees(input.repoCwd),
              input.resolveReservedAllocations !== undefined
                ? input.resolveReservedAllocations({ repoCwd: input.repoCwd, gitCommonDir })
                : Effect.succeed({
                    reservedWorktreePaths: new Set<string>(),
                    reservedBranchNames: new Set<string>(),
                  } satisfies ReservedWorktreeAllocations),
            ]);

            const reservedBranches = new Set<string>(input.reservedBranchNames ?? []);
            for (const branch of dynamicReserved.reservedBranchNames) {
              reservedBranches.add(branch);
            }
            const reservedWorktreePaths = new Set<string>(input.reservedWorktreePaths ?? []);
            for (const reservedPath of dynamicReserved.reservedWorktreePaths) {
              reservedWorktreePaths.add(reservedPath);
            }

            const checkedOutBranches = new Set<string>();
            for (const entry of registeredWorktrees) {
              if (entry.branch !== null) {
                checkedOutBranches.add(entry.branch);
              }
            }

            const branchAllocation = allocateDestinationBranch({
              sourceBranch: input.sourceBranch,
              headSha,
              targetLabel: input.targetLabel,
              transferId: input.transferId,
              localBranches: parseLocalBranchHeads(localBranchesOutput.stdout),
              checkedOutBranches,
              reservedBranches,
            });

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

            const allocation: AllocatedWorkspaceWorktree = {
              repoCwd: input.repoCwd,
              gitCommonDir,
              worktreePath,
              branch: branchAllocation.branch,
              createdBranch: !branchAllocation.useExistingBranch,
            };

            allocatedInLock = allocation;
            if (input.onWorktreeAllocated !== undefined) {
              yield* input.onWorktreeAllocated(allocation);
            }

            const addArgs = branchAllocation.useExistingBranch
              ? ["worktree", "add", "--", worktreePath, branchAllocation.branch]
              : ["worktree", "add", "-b", branchAllocation.branch, "--", worktreePath, headSha];
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
              yield* cleanupIncompleteAdd(allocation, { isExternalCollision });
              allocatedInLock = null;
              return yield* addResult.failure;
            }

            addSucceeded = true;
            createdWorktreePath = worktreePath;
            if (!branchAllocation.useExistingBranch) {
              createdBranchName = branchAllocation.branch;
            }
            allocatedWorktree = allocation;
            return { branchAllocation, worktreePath };
          }).pipe(
            Effect.onInterrupt(() =>
              !addSucceeded && allocatedInLock !== null
                ? cleanupIncompleteAdd(allocatedInLock)
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
        const worktreeGitDirRaw = (yield* runGit("WorkspaceBundle.worktreeGitDir", worktreePath, [
          "rev-parse",
          "--git-dir",
        ])).stdout.trim();
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

      committed = true;
      return {
        branch: branchAllocation.branch,
        createdBranch: !branchAllocation.useExistingBranch,
        worktreePath,
        gitCommonDir,
        headSha,
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
                    worktreePath: createdWorktreePath,
                    branch: createdBranchName,
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

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as WorkspaceBundle from "./WorkspaceBundle.ts";

const GIT_TEST_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

const makeTestLayer = () => {
  const basePlatform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const serverConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-workspace-bundle-test-",
  }).pipe(Layer.provide(basePlatform));
  const processRunner = ProcessRunner.layer.pipe(Layer.provide(basePlatform));
  const vcsProcess = VcsProcess.layer.pipe(Layer.provide(Layer.merge(basePlatform, processRunner)));
  return WorkspaceBundle.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(basePlatform, serverConfig, vcsProcess)),
  );
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const output = yield* vcsProcess.run({
      operation: "WorkspaceBundle.test.git",
      command: "git",
      args,
      cwd,
      env: GIT_TEST_ENV,
      timeoutMs: 15_000,
    });
    return output.stdout;
  });

const listTransferRefs = (cwd: string) =>
  git(cwd, ["for-each-ref", "--format=%(refname)", "refs/t3-transfer"]).pipe(
    Effect.map((stdout) =>
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  );

describe("WorkspaceBundle", () => {
  it.effect(
    "round-trips unpushed commits, staged/unstaged/deleted/untracked files losslessly without remote",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-roundtrip-" });
        const srcRepo = path.join(root, "src-repo");
        const dstRepo = path.join(root, "dst-repo");
        const bundlePath = path.join(root, "transfer.bundle");

        yield* fs.makeDirectory(srcRepo, { recursive: true });
        yield* fs.makeDirectory(dstRepo, { recursive: true });

        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(srcRepo, ".gitignore"), "ignored.log\n");
        yield* fs.writeFileString(path.join(srcRepo, "a.txt"), "base-a\n");
        yield* fs.writeFileString(path.join(srcRepo, "b.txt"), "base-b\n");
        yield* fs.writeFileString(path.join(srcRepo, "c.txt"), "base-c\n");
        yield* fs.writeFileString(path.join(srcRepo, "d.txt"), "base-d\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "initial commit"]);

        // Create an unpushed feature branch with an extra commit.
        yield* git(srcRepo, ["checkout", "-b", "feat/lossless-state"]);
        yield* fs.writeFileString(path.join(srcRepo, "committed.txt"), "unpushed commit content\n");
        yield* git(srcRepo, ["add", "committed.txt"]);
        yield* git(srcRepo, ["commit", "-m", "unpushed feature commit"]);

        // Stage changes: modify a.txt, delete c.txt, add staged-am.txt & staged-ad.txt.
        yield* fs.writeFileString(path.join(srcRepo, "a.txt"), "staged-a\n");
        yield* fs.remove(path.join(srcRepo, "c.txt"));
        yield* fs.writeFileString(path.join(srcRepo, "staged-am.txt"), "staged-am\n");
        yield* fs.writeFileString(path.join(srcRepo, "staged-ad.txt"), "staged-ad\n");
        yield* git(srcRepo, ["add", "-A"]);

        // Apply distinct unstaged changes on top of staged index.
        yield* fs.writeFileString(path.join(srcRepo, "a.txt"), "unstaged-a\n"); // MM
        yield* fs.writeFileString(path.join(srcRepo, "b.txt"), "unstaged-b\n"); //  M
        yield* fs.remove(path.join(srcRepo, "d.txt")); //  D
        yield* fs.writeFileString(path.join(srcRepo, "staged-am.txt"), "unstaged-am\n"); // AM
        yield* fs.remove(path.join(srcRepo, "staged-ad.txt")); // AD
        yield* fs.makeDirectory(path.join(srcRepo, "nested"), { recursive: true });
        yield* fs.writeFileString(
          path.join(srcRepo, "nested", "untracked.txt"),
          "hello untracked\n",
        ); // ??
        yield* fs.writeFileString(path.join(srcRepo, "ignored.log"), "should not be bundled\n");

        const srcStatusBefore = yield* git(srcRepo, ["status", "--porcelain=v1", "-uall"]);
        const srcStagedDiffBefore = yield* git(srcRepo, ["diff", "--cached"]);
        const srcUnstagedDiffBefore = yield* git(srcRepo, ["diff"]);
        const srcHeadSha = (yield* git(srcRepo, ["rev-parse", "HEAD"])).trim();

        const exported = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-roundtrip-1",
          cwd: srcRepo,
          outputPath: bundlePath,
        });

        expect(exported.branch).toBe("feat/lossless-state");
        expect(exported.headSha).toBe(srcHeadSha);
        expect(exported.isDetachedHead).toBe(false);
        expect(exported.hasStagedChanges).toBe(true);
        expect(exported.hasUnstagedChanges).toBe(true);
        expect(exported.hasUntrackedFiles).toBe(true);
        expect(exported.incremental).toBe(false);
        expect(exported.bundleSizeBytes).toBeGreaterThan(0);
        expect(exported.bundleSha256).toMatch(/^[a-f0-9]{64}$/);

        // Source index & status must be completely untouched and temp refs deleted.
        expect(yield* git(srcRepo, ["status", "--porcelain=v1", "-uall"])).toBe(srcStatusBefore);
        expect(yield* git(srcRepo, ["diff", "--cached"])).toBe(srcStagedDiffBefore);
        expect(yield* listTransferRefs(srcRepo)).toEqual([]);

        // Destination is an empty initialized git repo with no remote.
        yield* git(dstRepo, ["init", "-b", "main"]);
        const imported = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-roundtrip-1",
          repoCwd: dstRepo,
          bundlePath,
          sourceBranch: exported.branch,
          targetLabel: "boat",
        });

        expect(imported.branch).toBe("feat/lossless-state");
        expect(imported.branchRenamedFrom).toBeNull();
        expect(imported.headSha).toBe(srcHeadSha);
        expect(imported.warnings).toEqual([]);

        // Exact status, staged diff, unstaged diff, and untracked contents match on destination.
        expect(yield* git(imported.worktreePath, ["status", "--porcelain=v1", "-uall"])).toBe(
          srcStatusBefore,
        );
        expect(yield* git(imported.worktreePath, ["diff", "--cached"])).toBe(srcStagedDiffBefore);
        expect(yield* git(imported.worktreePath, ["diff"])).toBe(srcUnstagedDiffBefore);
        expect(
          yield* fs.readFileString(path.join(imported.worktreePath, "nested", "untracked.txt")),
        ).toBe("hello untracked\n");
        expect(yield* fs.exists(path.join(imported.worktreePath, "ignored.log"))).toBe(false);
        expect(yield* listTransferRefs(dstRepo)).toEqual([]);

        // Cleanup helper removes the created worktree cleanly.
        yield* bundleService.removeWorktree({
          repoCwd: dstRepo,
          worktreePath: imported.worktreePath,
          branch: imported.branch,
        });
        expect(yield* fs.exists(imported.worktreePath)).toBe(false);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "produces incremental bundles against shared remote refs, including clean HEAD == origin/main",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-incremental-" });
        const bareRemote = path.join(root, "remote.git");
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");

        yield* fs.makeDirectory(bareRemote, { recursive: true });
        yield* git(bareRemote, ["init", "--bare", "-b", "main"]);

        // Populate remote with 2 commits so HEAD has a parent.
        const seedRepo = path.join(root, "seed");
        yield* fs.makeDirectory(seedRepo, { recursive: true });
        yield* git(seedRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(seedRepo, "base.txt"), "v1\n");
        yield* git(seedRepo, ["add", "-A"]);
        yield* git(seedRepo, ["commit", "-m", "c1"]);
        yield* fs.writeFileString(path.join(seedRepo, "base.txt"), "v2\n");
        yield* git(seedRepo, ["add", "-A"]);
        yield* git(seedRepo, ["commit", "-m", "c2"]);
        yield* git(seedRepo, ["remote", "add", "origin", bareRemote]);
        yield* git(seedRepo, ["push", "-u", "origin", "main"]);

        yield* git(root, ["clone", bareRemote, srcRepo]);
        yield* git(root, ["clone", bareRemote, dstRepo]);

        // Case 1: Clean HEAD == origin/main (must NOT fail with empty bundle error).
        const cleanBundle = path.join(root, "clean.bundle");
        const cleanExport = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-clean-inc",
          cwd: srcRepo,
          outputPath: cleanBundle,
        });
        expect(cleanExport.incremental).toBe(true);
        expect(cleanExport.baseRef).toBe("refs/remotes/origin/main");

        // Destination already has `main` checked out, so import renames to `main-boat`.
        const cleanImport = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-clean-inc",
          repoCwd: dstRepo,
          bundlePath: cleanBundle,
          sourceBranch: cleanExport.branch,
          targetLabel: "boat",
        });
        expect(cleanImport.branch).toBe("main-boat");
        expect(cleanImport.branchRenamedFrom).toBe("main");
        expect(cleanImport.warnings.length).toBe(1);
        expect(cleanImport.headSha).toBe(cleanExport.headSha);

        // Case 2: Second transfer from `main` collides with `main-boat` too -> falls back to `main-transfer-<shortId>`.
        const secondBundle = path.join(root, "clean-2.bundle");
        yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-abcd1234",
          cwd: srcRepo,
          outputPath: secondBundle,
        });
        const secondImport = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-abcd1234",
          repoCwd: dstRepo,
          bundlePath: secondBundle,
          sourceBranch: "main",
          targetLabel: "boat",
        });
        expect(secondImport.branch).toBe("main-transfer-xferabcd");
        expect(secondImport.branchRenamedFrom).toBe("main");

        // Case 3: Unpushed commit ahead of origin/main with dirty edit.
        yield* git(srcRepo, ["checkout", "-b", "feat/ahead"]);
        yield* fs.writeFileString(path.join(srcRepo, "ahead.txt"), "ahead\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "ahead commit"]);
        yield* fs.writeFileString(path.join(srcRepo, "ahead.txt"), "ahead dirty\n");

        const aheadBundle = path.join(root, "ahead.bundle");
        const aheadExport = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-ahead-inc",
          cwd: srcRepo,
          outputPath: aheadBundle,
          sharedRemoteRefs: ["refs/remotes/origin/main"],
        });
        expect(aheadExport.incremental).toBe(true);
        expect(aheadExport.baseRef).toBe("refs/remotes/origin/main");

        const aheadImport = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-ahead-inc",
          repoCwd: dstRepo,
          bundlePath: aheadBundle,
          sourceBranch: aheadExport.branch,
          targetLabel: "boat",
        });
        expect(aheadImport.branch).toBe("feat/ahead");
        expect(yield* fs.readFileString(path.join(aheadImport.worktreePath, "ahead.txt"))).toBe(
          "ahead dirty\n",
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "handles detached HEAD and runs beforeApplyDirtyLayers hook before restoring dirty edits",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-detached-" });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const bundlePath = path.join(root, "detached.bundle");

        yield* fs.makeDirectory(srcRepo, { recursive: true });
        yield* fs.makeDirectory(dstRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(srcRepo, "app.txt"), "clean-head\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "init"]);

        // Detach HEAD and make dirty changes.
        const headSha = (yield* git(srcRepo, ["rev-parse", "HEAD"])).trim();
        yield* git(srcRepo, ["checkout", "--detach", headSha]);
        yield* fs.writeFileString(path.join(srcRepo, "app.txt"), "dirty-after-setup\n");
        yield* fs.writeFileString(path.join(srcRepo, "notes.txt"), "untracked-note\n");

        const exported = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-det999",
          cwd: srcRepo,
          outputPath: bundlePath,
        });
        expect(exported.branch).toBeNull();
        expect(exported.isDetachedHead).toBe(true);

        yield* git(dstRepo, ["init", "-b", "main"]);
        let appContentDuringHook = "";
        let notesExistedDuringHook = true;
        const imported = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-det999",
          repoCwd: dstRepo,
          bundlePath,
          sourceBranch: null,
          targetLabel: "local",
          beforeApplyDirtyLayers: (worktreePath) =>
            Effect.gen(function* () {
              appContentDuringHook = yield* fs.readFileString(path.join(worktreePath, "app.txt"));
              notesExistedDuringHook = yield* fs.exists(path.join(worktreePath, "notes.txt"));
              yield* fs.writeFileString(
                path.join(worktreePath, "setup-marker.txt"),
                "from-setup\n",
              );
            }).pipe(Effect.orDie),
        });

        expect(imported.branch).toBe("local-transfer-xferdet9");
        expect(imported.warnings[0]).toContain("detached HEAD");
        // Hook saw clean HEAD before dirty layers were applied.
        expect(appContentDuringHook).toBe("clean-head\n");
        expect(notesExistedDuringHook).toBe(false);
        // Dirty layers were applied after the hook, while preserving non-colliding setup output.
        expect(yield* fs.readFileString(path.join(imported.worktreePath, "app.txt"))).toBe(
          "dirty-after-setup\n",
        );
        expect(yield* fs.readFileString(path.join(imported.worktreePath, "notes.txt"))).toBe(
          "untracked-note\n",
        );
        expect(yield* fs.readFileString(path.join(imported.worktreePath, "setup-marker.txt"))).toBe(
          "from-setup\n",
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces bundle ceiling with top offending paths and detects LFS / dirty submodule warnings",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-limits-" });
        const subRepo = path.join(root, "sub-origin");
        const repo = path.join(root, "repo");
        const bundlePath = path.join(root, "out.bundle");

        yield* fs.makeDirectory(subRepo, { recursive: true });
        yield* git(subRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(subRepo, "sub.txt"), "v1\n");
        yield* git(subRepo, ["add", "-A"]);
        yield* git(subRepo, ["commit", "-m", "sub init"]);

        yield* fs.makeDirectory(repo, { recursive: true });
        yield* git(repo, ["init", "-b", "main"]);
        yield* fs.writeFileString(
          path.join(repo, ".gitattributes"),
          "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
        yield* fs.writeFileString(path.join(repo, "readme.md"), "hello\n");
        yield* git(repo, ["add", "-A"]);
        yield* git(repo, ["commit", "-m", "init"]);
        yield* git(repo, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          subRepo,
          "vendor/sub",
        ]);
        yield* git(repo, ["commit", "-m", "add submodule"]);

        // Advance submodule commit without committing parent gitlink -> dirty/shifted submodule.
        const subWorktree = path.join(repo, "vendor", "sub");
        yield* fs.writeFileString(path.join(subWorktree, "sub.txt"), "v2\n");
        yield* git(subWorktree, ["add", "-A"]);
        yield* git(subWorktree, ["commit", "-m", "sub advance"]);

        // Create oversized untracked files exceeding a 2 KiB cap.
        yield* fs.writeFileString(path.join(repo, "huge.bin"), "x".repeat(4096));
        yield* fs.writeFileString(path.join(repo, "medium.bin"), "y".repeat(512));

        const tooLarge = yield* Effect.result(
          bundleService.exportWorkspaceBundle({
            transferId: "xfer-too-large",
            cwd: repo,
            outputPath: bundlePath,
            maxBundleBytes: 2048,
          }),
        );
        expect(Result.isFailure(tooLarge)).toBe(true);
        if (Result.isFailure(tooLarge)) {
          expect(tooLarge.failure.code).toBe("bundle_too_large");
          expect(tooLarge.failure.offendingPaths?.[0]?.path).toBe("huge.bin");
          expect(tooLarge.failure.offendingPaths?.[0]?.sizeBytes).toBe(4096);
        }
        expect(yield* fs.exists(bundlePath)).toBe(false);

        // Remove huge file, verify both LFS and dirty submodule warnings are emitted.
        yield* fs.remove(path.join(repo, "huge.bin"));
        const exported = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-lfs-warn",
          cwd: repo,
          outputPath: bundlePath,
        });
        expect(exported.warnings.some((w) => w.includes("Git LFS"))).toBe(true);
        expect(exported.warnings.some((w) => w.includes("vendor/sub"))).toBe(true);

        // Non-git directory fails with not_git_repo.
        const nonGit = path.join(root, "not-a-repo");
        yield* fs.makeDirectory(nonGit, { recursive: true });
        const notGitResult = yield* Effect.result(
          bundleService.exportWorkspaceBundle({
            transferId: "xfer-non-git",
            cwd: nonGit,
            outputPath: path.join(root, "nongit.bundle"),
          }),
        );
        expect(Result.isFailure(notGitResult)).toBe(true);
        if (Result.isFailure(notGitResult)) {
          expect(notGitResult.failure.code).toBe("not_git_repo");
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );
});

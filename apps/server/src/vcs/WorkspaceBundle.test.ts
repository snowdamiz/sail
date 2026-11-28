// @effect-diagnostics nodeBuiltinImport:off -- utimesSync and createHash verify .git/index byte-for-byte immutability after mtime changes.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
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
  const basePlatform = Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer);
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
        expect(imported.createdBranch).toBe(true);
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
    "handles full bundles when sharedRemoteRefs is omitted (stale destination remote), dirty checkout at pushed HEAD, and strict-ancestor incremental bundles",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-incremental-" });
        const bareRemote = path.join(root, "remote.git");
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const staleDstRepo = path.join(root, "stale-dst");

        yield* fs.makeDirectory(bareRemote, { recursive: true });
        yield* git(bareRemote, ["init", "--bare", "-b", "main"]);

        // Populate remote with 1 initial commit and clone staleDstRepo BEFORE newer commits arrive.
        const seedRepo = path.join(root, "seed");
        yield* fs.makeDirectory(seedRepo, { recursive: true });
        yield* git(seedRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(seedRepo, "base.txt"), "v1\n");
        yield* git(seedRepo, ["add", "-A"]);
        yield* git(seedRepo, ["commit", "-m", "c1"]);
        yield* git(seedRepo, ["remote", "add", "origin", bareRemote]);
        yield* git(seedRepo, ["push", "-u", "origin", "main"]);

        // staleDstRepo only has c1 (its origin/main is behind srcRepo's origin/main).
        yield* git(root, ["clone", bareRemote, staleDstRepo]);

        // Advance remote with c2 and clone srcRepo & dstRepo from updated remote.
        yield* fs.writeFileString(path.join(seedRepo, "base.txt"), "v2\n");
        yield* git(seedRepo, ["add", "-A"]);
        yield* git(seedRepo, ["commit", "-m", "c2"]);
        yield* git(seedRepo, ["push", "origin", "main"]);

        yield* git(root, ["clone", bareRemote, srcRepo]);
        yield* git(root, ["clone", bareRemote, dstRepo]);

        // Case (b): Omitting sharedRemoteRefs exports a FULL bundle so stale destination remotes import cleanly.
        const staleBundle = path.join(root, "stale-full.bundle");
        const staleExport = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-stale-dst",
          cwd: srcRepo,
          outputPath: staleBundle,
        });
        expect(staleExport.incremental).toBe(false);
        expect(staleExport.baseRef).toBeNull();

        const staleImport = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-stale-dst",
          repoCwd: staleDstRepo,
          bundlePath: staleBundle,
          sourceBranch: staleExport.branch,
          targetLabel: "boat",
        });
        expect(staleImport.branch).toBe("main-boat");
        expect(staleImport.createdBranch).toBe(true);
        expect(staleImport.branchRenamedFrom).toBe("main");
        expect(staleImport.headSha).toBe(staleExport.headSha);
        expect(yield* fs.readFileString(path.join(staleImport.worktreePath, "base.txt"))).toBe(
          "v2\n",
        );

        // Collision fallback: second transfer from `main` collides with `main-boat` -> `main-transfer-<shortId>`.
        const secondBundle = path.join(root, "clean-2.bundle");
        yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-abcd1234",
          cwd: srcRepo,
          outputPath: secondBundle,
        });
        const secondImport = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-abcd1234",
          repoCwd: staleDstRepo,
          bundlePath: secondBundle,
          sourceBranch: "main",
          targetLabel: "boat",
        });
        expect(secondImport.branch).toBe("main-transfer-xferabcd");
        expect(secondImport.createdBranch).toBe(true);
        expect(secondImport.branchRenamedFrom).toBe("main");

        // Case (a): Dirty checkout at pushed HEAD (HEAD == origin/main) WITH sharedRemoteRefs: ["refs/remotes/origin/main"].
        // Filtering out HEAD from excludeRefs ensures refs/t3-transfer/<id>/head is STILL bundled and imports cleanly.
        yield* fs.writeFileString(path.join(srcRepo, "base.txt"), "v2-staged\n");
        yield* git(srcRepo, ["add", "base.txt"]);
        yield* fs.writeFileString(path.join(srcRepo, "base.txt"), "v2-unstaged\n");
        yield* fs.writeFileString(path.join(srcRepo, "untracked-at-head.txt"), "hello-dirty\n");

        const dirtyAtHeadBundle = path.join(root, "dirty-at-head.bundle");
        const dirtyAtHeadExport = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-dirty-pushed-head",
          cwd: srcRepo,
          outputPath: dirtyAtHeadBundle,
          sharedRemoteRefs: ["refs/remotes/origin/main"],
        });
        expect(dirtyAtHeadExport.incremental).toBe(false);
        expect(dirtyAtHeadExport.baseRef).toBeNull();
        expect(dirtyAtHeadExport.hasStagedChanges).toBe(true);
        expect(dirtyAtHeadExport.hasUnstagedChanges).toBe(true);
        expect(dirtyAtHeadExport.hasUntrackedFiles).toBe(true);

        const dirtyAtHeadImport = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-dirty-pushed-head",
          repoCwd: dstRepo,
          bundlePath: dirtyAtHeadBundle,
          sourceBranch: dirtyAtHeadExport.branch,
          targetLabel: "boat",
        });
        expect(dirtyAtHeadImport.headSha).toBe(dirtyAtHeadExport.headSha);
        expect((yield* git(dirtyAtHeadImport.worktreePath, ["show", ":base.txt"])).trim()).toBe(
          "v2-staged",
        );
        expect(
          yield* fs.readFileString(path.join(dirtyAtHeadImport.worktreePath, "base.txt")),
        ).toBe("v2-unstaged\n");
        expect(
          yield* fs.readFileString(
            path.join(dirtyAtHeadImport.worktreePath, "untracked-at-head.txt"),
          ),
        ).toBe("hello-dirty\n");

        // Clean working tree before Case (c).
        yield* git(srcRepo, ["reset", "--hard", "HEAD"]);
        yield* fs.remove(path.join(srcRepo, "untracked-at-head.txt"));

        // Case (c): Valid incremental bundle where sharedRemoteRefs contains a strict ancestor present on destination.
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
          sharedRemoteRefs: ["refs/remotes/origin/main", "HEAD"],
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
        expect(aheadImport.createdBranch).toBe(true);
        expect(yield* fs.readFileString(path.join(aheadImport.worktreePath, "ahead.txt"))).toBe(
          "ahead dirty\n",
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "reports createdBranch: false when reusing an idle pre-existing branch at the same SHA",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-reuse-branch-" });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const bundlePath = path.join(root, "reuse.bundle");

        yield* fs.makeDirectory(srcRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(srcRepo, "file.txt"), "v1\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "init"]);
        yield* git(srcRepo, ["checkout", "-b", "feat/existing"]);
        yield* fs.writeFileString(path.join(srcRepo, "file.txt"), "v2\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "feat"]);

        // Clone to destination and switch destination back to main so feat/existing exists locally but is idle.
        yield* git(root, ["clone", srcRepo, dstRepo]);
        yield* git(dstRepo, ["checkout", "-b", "main", "origin/main"]);

        const exported = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-reuse-branch",
          cwd: srcRepo,
          outputPath: bundlePath,
        });
        const imported = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-reuse-branch",
          repoCwd: dstRepo,
          bundlePath,
          sourceBranch: exported.branch,
          targetLabel: "boat",
        });

        expect(imported.branch).toBe("feat/existing");
        expect(imported.createdBranch).toBe(false);

        // Removing the worktree without passing branch preserves the pre-existing branch.
        yield* bundleService.removeWorktree({
          repoCwd: dstRepo,
          worktreePath: imported.worktreePath,
        });
        const branchRef = (yield* git(dstRepo, [
          "rev-parse",
          "--verify",
          "refs/heads/feat/existing",
        ])).trim();
        expect(branchRef).toBe(exported.headSha);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "does not modify .git/index bytes even when a tracked file mtime changes without content edits",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-index-immutable-" });
        const repo = path.join(root, "repo");
        const bundlePath = path.join(root, "index-check.bundle");

        yield* fs.makeDirectory(repo, { recursive: true });
        yield* git(repo, ["init", "-b", "main"]);
        const trackedFile = path.join(repo, "tracked.txt");
        yield* fs.writeFileString(trackedFile, "immutable content\n");
        yield* git(repo, ["add", "-A"]);
        yield* git(repo, ["commit", "-m", "initial"]);

        // Bump tracked file mtime without changing contents (would normally trigger git status stat-cache refresh).
        const futureSec = Math.floor(NodeFS.statSync(trackedFile).mtimeMs / 1000) + 120;
        NodeFS.utimesSync(trackedFile, futureSec, futureSec);

        const indexPath = path.join(repo, ".git", "index");
        const indexBefore = NodeFS.readFileSync(indexPath);
        const shaBefore = NodeCrypto.createHash("sha256").update(indexBefore).digest("hex");

        yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-index-immutable",
          cwd: repo,
          outputPath: bundlePath,
        });

        const indexAfter = NodeFS.readFileSync(indexPath);
        const shaAfter = NodeCrypto.createHash("sha256").update(indexAfter).digest("hex");
        expect(shaAfter).toBe(shaBefore);
        expect(indexAfter.equals(indexBefore)).toBe(true);
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
        expect(imported.createdBranch).toBe(true);
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

  it.effect(
    "passes validated strict-ancestor commit SHAs (not moving ref names) to git bundle create --not",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseVcsProcess = yield* VcsProcess.VcsProcess;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-sha-not-" });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const bundlePath = path.join(root, "sha-not.bundle");

        yield* fs.makeDirectory(srcRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(srcRepo, "file.txt"), "c1\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "c1"]);
        const c1Sha = (yield* git(srcRepo, ["rev-parse", "HEAD"])).trim();

        // Clone destination at c1 only.
        yield* git(root, ["clone", srcRepo, dstRepo]);

        // Set refs/remotes/origin/main to c1 in srcRepo, then create c2 ahead of it.
        yield* git(srcRepo, ["update-ref", "refs/remotes/origin/main", c1Sha]);
        yield* git(srcRepo, ["checkout", "-b", "feat/sha-race"]);
        yield* fs.writeFileString(path.join(srcRepo, "file.txt"), "c2\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "c2"]);
        const c2Sha = (yield* git(srcRepo, ["rev-parse", "HEAD"])).trim();
        expect(c2Sha).not.toBe(c1Sha);

        // Wrap VcsProcess to advance refs/remotes/origin/main -> c2 (HEAD) right after
        // checkBaseRef validates c1, simulating a concurrent `git fetch` racing bundle creation.
        const recordedBundleArgs: Array<ReadonlyArray<string>> = [];
        let advancedRef = false;
        const racingVcsLayer = Layer.succeed(VcsProcess.VcsProcess, {
          run: (runInput) =>
            Effect.gen(function* () {
              if (runInput.operation === "WorkspaceBundle.createIncrementalBundle") {
                recordedBundleArgs.push(runInput.args);
              }
              const result = yield* baseVcsProcess.run(runInput);
              if (runInput.operation === "WorkspaceBundle.checkBaseRef" && !advancedRef) {
                advancedRef = true;
                yield* baseVcsProcess.run({
                  operation: "WorkspaceBundle.test.raceAdvanceRef",
                  command: "git",
                  args: ["update-ref", "refs/remotes/origin/main", c2Sha],
                  cwd: srcRepo,
                  env: GIT_TEST_ENV,
                  timeoutMs: 15_000,
                });
              }
              return result;
            }),
        });

        const racingBundleLayer = Layer.fresh(WorkspaceBundle.layer).pipe(
          Layer.provide(racingVcsLayer),
        );

        const exported = yield* Effect.gen(function* () {
          const svc = yield* WorkspaceBundle.WorkspaceBundle;
          return yield* svc.exportWorkspaceBundle({
            transferId: "xfer-sha-race",
            cwd: srcRepo,
            outputPath: bundlePath,
            sharedRemoteRefs: ["refs/remotes/origin/main"],
          });
        }).pipe(Effect.provide(racingBundleLayer));

        expect(advancedRef).toBe(true);
        expect(exported.incremental).toBe(true);
        expect(exported.baseRef).toBe("refs/remotes/origin/main");
        expect(exported.headSha).toBe(c2Sha);

        // Verify git bundle create received the immutable validated commit SHA, not the moving ref name.
        expect(recordedBundleArgs).toHaveLength(1);
        const args = recordedBundleArgs[0]!;
        const notIdx = args.indexOf("--not");
        expect(notIdx).toBeGreaterThan(-1);
        expect(args.slice(notIdx + 1)).toEqual([c1Sha]);
        expect(args).not.toContain("refs/remotes/origin/main");

        // Destination (at c1) imports the bundle cleanly and checks out c2.
        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;
        const imported = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-sha-race",
          repoCwd: dstRepo,
          bundlePath,
          sourceBranch: exported.branch,
          targetLabel: "boat",
        });
        expect(imported.headSha).toBe(c2Sha);
        expect(yield* fs.readFileString(path.join(imported.worktreePath, "file.txt"))).toBe("c2\n");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "propagates worktree removal and branch deletion errors instead of silently succeeding, and recovers cleanly on retry",
    () =>
      Effect.gen(function* () {
        const baseFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseVcsProcess = yield* VcsProcess.VcsProcess;

        const root = yield* baseFs.makeTempDirectoryScoped({ prefix: "t3-wb-remove-err-" });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const bundlePath = path.join(root, "remove-err.bundle");

        yield* baseFs.makeDirectory(srcRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* baseFs.writeFileString(path.join(srcRepo, "file.txt"), "base\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "init"]);
        yield* git(root, ["clone", srcRepo, dstRepo]);

        yield* git(srcRepo, ["checkout", "-b", "feat/remove-err"]);
        yield* baseFs.writeFileString(path.join(srcRepo, "file.txt"), "feature\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "feature"]);

        const baseBundleService = yield* WorkspaceBundle.WorkspaceBundle;
        const exported = yield* baseBundleService.exportWorkspaceBundle({
          transferId: "xfer-remove-err",
          cwd: srcRepo,
          outputPath: bundlePath,
        });
        const imported = yield* baseBundleService.importWorkspaceBundle({
          transferId: "xfer-remove-err",
          repoCwd: dstRepo,
          bundlePath,
          sourceBranch: exported.branch,
          targetLabel: "boat",
        });

        expect(imported.branch).toBe("feat/remove-err");
        expect(imported.createdBranch).toBe(true);
        expect(yield* baseFs.exists(imported.worktreePath)).toBe(true);

        let blockWorktreeRemoval = true;
        const wrappedFsLayer = Layer.succeed(FileSystem.FileSystem, {
          ...baseFs,
          remove: (targetPath, removeOptions) =>
            blockWorktreeRemoval && targetPath === imported.worktreePath
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: targetPath,
                  }),
                )
              : baseFs.remove(targetPath, removeOptions),
        });
        const wrappedVcsLayer = Layer.succeed(VcsProcess.VcsProcess, {
          run: (runInput) =>
            blockWorktreeRemoval && runInput.operation === "WorkspaceBundle.removeWorktree"
              ? Effect.succeed({
                  exitCode: 128 as VcsProcess.VcsProcessOutput["exitCode"],
                  stdout: "",
                  stderr: "error: failed to delete worktree: Permission denied",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                })
              : baseVcsProcess.run(runInput),
        });
        const faultBundleLayer = Layer.fresh(WorkspaceBundle.layer).pipe(
          Layer.provide(Layer.merge(wrappedFsLayer, wrappedVcsLayer)),
        );

        // 1. Worktree directory removal failure (PermissionDenied) must propagate as WorkspaceBundleError.
        const worktreeFail = yield* Effect.gen(function* () {
          const svc = yield* WorkspaceBundle.WorkspaceBundle;
          return yield* Effect.result(
            svc.removeWorktree({
              repoCwd: dstRepo,
              worktreePath: imported.worktreePath,
            }),
          );
        }).pipe(Effect.provide(faultBundleLayer));
        expect(Result.isFailure(worktreeFail)).toBe(true);
        if (Result.isFailure(worktreeFail)) {
          expect(worktreeFail.failure.code).toBe("io_error");
        }
        expect(yield* baseFs.exists(imported.worktreePath)).toBe(true);

        // 2. Unblock worktree removal, but lock the created branch ref so git branch -D fails while
        //    the branch still exists. removeWorktree must remove the worktree and report branch failure.
        blockWorktreeRemoval = false;
        const branchLockPath = path.join(
          dstRepo,
          ".git",
          "refs",
          "heads",
          "feat",
          "remove-err.lock",
        );
        yield* baseFs.writeFileString(branchLockPath, "locked\n");
        try {
          const branchFail = yield* Effect.gen(function* () {
            const svc = yield* WorkspaceBundle.WorkspaceBundle;
            return yield* Effect.result(
              svc.removeWorktree({
                repoCwd: dstRepo,
                worktreePath: imported.worktreePath,
                branch: imported.branch,
              }),
            );
          }).pipe(Effect.provide(faultBundleLayer));
          expect(Result.isFailure(branchFail)).toBe(true);
          if (Result.isFailure(branchFail)) {
            expect(branchFail.failure.code).toBe("git_error");
          }
          expect(yield* baseFs.exists(imported.worktreePath)).toBe(false);
          expect((yield* git(dstRepo, ["branch", "--list", "feat/remove-err"])).trim()).not.toBe(
            "",
          );
        } finally {
          yield* baseFs.remove(branchLockPath, { force: true }).pipe(Effect.ignore);
        }

        // 3. Retry once the branch lock is cleared: treats missing worktree as already gone and deletes branch.
        yield* baseBundleService.removeWorktree({
          repoCwd: dstRepo,
          worktreePath: imported.worktreePath,
          branch: imported.branch,
        });
        expect((yield* git(dstRepo, ["branch", "--list", "feat/remove-err"])).trim()).toBe("");

        // 4. Subsequent call when both worktree and branch are already gone succeeds idempotently.
        yield* baseBundleService.removeWorktree({
          repoCwd: dstRepo,
          worktreePath: imported.worktreePath,
          branch: imported.branch,
        });
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "refuses to delete a locked worktree directory, fails with git_error while keeping registration, and removes cleanly after unlock",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-locked-wt-" });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const bundlePath = path.join(root, "locked-wt.bundle");

        yield* fs.makeDirectory(srcRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(srcRepo, "file.txt"), "base\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "init"]);
        yield* git(root, ["clone", srcRepo, dstRepo]);

        yield* git(srcRepo, ["checkout", "-b", "feat/locked-wt"]);
        yield* fs.writeFileString(path.join(srcRepo, "file.txt"), "feature\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "feature"]);

        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;
        const exported = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-locked-wt",
          cwd: srcRepo,
          outputPath: bundlePath,
        });
        const imported = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-locked-wt",
          repoCwd: dstRepo,
          bundlePath,
          sourceBranch: exported.branch,
          targetLabel: "boat",
        });

        expect(imported.branch).toBe("feat/locked-wt");
        expect(imported.createdBranch).toBe(true);
        expect(yield* fs.exists(imported.worktreePath)).toBe(true);

        yield* git(dstRepo, ["worktree", "lock", "--reason", "in use", imported.worktreePath]);
        let unlocked = false;
        try {
          const lockedResult = yield* Effect.result(
            bundleService.removeWorktree({
              repoCwd: dstRepo,
              worktreePath: imported.worktreePath,
              branch: imported.branch,
            }),
          );
          expect(Result.isFailure(lockedResult)).toBe(true);
          if (Result.isFailure(lockedResult)) {
            expect(lockedResult.failure.code).toBe("git_error");
          }

          // Locked worktree directory must NOT be rm -rf'd and must remain registered with its branch.
          expect(yield* fs.exists(imported.worktreePath)).toBe(true);
          expect(yield* fs.readFileString(path.join(imported.worktreePath, "file.txt"))).toBe(
            "feature\n",
          );
          const lockedPorcelain = yield* git(dstRepo, ["worktree", "list", "--porcelain"]);
          const realWorktreePath = yield* fs.realPath(imported.worktreePath);
          expect(lockedPorcelain).toContain(`worktree ${realWorktreePath}`);
          expect(lockedPorcelain).toContain("locked in use");
          expect((yield* git(dstRepo, ["branch", "--list", "feat/locked-wt"])).trim()).not.toBe("");

          // Unlock and retry: must delete worktree, unregister it from git worktree list, and delete branch.
          yield* git(dstRepo, ["worktree", "unlock", imported.worktreePath]);
          unlocked = true;

          yield* bundleService.removeWorktree({
            repoCwd: dstRepo,
            worktreePath: imported.worktreePath,
            branch: imported.branch,
          });
          expect(yield* fs.exists(imported.worktreePath)).toBe(false);
          const afterPorcelain = yield* git(dstRepo, ["worktree", "list", "--porcelain"]);
          expect(afterPorcelain).not.toContain(realWorktreePath);
          expect((yield* git(dstRepo, ["branch", "--list", "feat/locked-wt"])).trim()).toBe("");
        } finally {
          if (!unlocked) {
            yield* git(dstRepo, ["worktree", "unlock", imported.worktreePath]).pipe(Effect.ignore);
          }
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "detects a locked worktree whose path contains a literal newline via --porcelain -z and removes cleanly after unlock",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wb-newline-wt-" });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const bundlePath = path.join(root, "newline-wt.bundle");
        const newlineWorktreePath = path.join(root, "wt-with-newline\nlocked-dir");

        yield* fs.makeDirectory(srcRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(srcRepo, "file.txt"), "base\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "init"]);
        yield* git(root, ["clone", srcRepo, dstRepo]);

        yield* git(srcRepo, ["checkout", "-b", "feat/newline-locked-wt"]);
        yield* fs.writeFileString(path.join(srcRepo, "file.txt"), "feature\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "feature"]);

        const bundleService = yield* WorkspaceBundle.WorkspaceBundle;
        const exported = yield* bundleService.exportWorkspaceBundle({
          transferId: "xfer-newline-locked-wt",
          cwd: srcRepo,
          outputPath: bundlePath,
        });
        const imported = yield* bundleService.importWorkspaceBundle({
          transferId: "xfer-newline-locked-wt",
          repoCwd: dstRepo,
          bundlePath,
          sourceBranch: exported.branch,
          targetLabel: "boat",
          worktreePath: newlineWorktreePath,
        });

        expect(imported.worktreePath).toBe(newlineWorktreePath);
        expect(imported.branch).toBe("feat/newline-locked-wt");
        expect(yield* fs.exists(imported.worktreePath)).toBe(true);

        yield* git(dstRepo, [
          "worktree",
          "lock",
          "--reason",
          "newline path lock",
          imported.worktreePath,
        ]);
        let unlocked = false;
        try {
          const lockedResult = yield* Effect.result(
            bundleService.removeWorktree({
              repoCwd: dstRepo,
              worktreePath: imported.worktreePath,
              branch: imported.branch,
            }),
          );
          expect(Result.isFailure(lockedResult)).toBe(true);
          if (Result.isFailure(lockedResult)) {
            expect(lockedResult.failure.code).toBe("git_error");
            expect(lockedResult.failure.message).toContain("newline path lock");
          }

          // Locked worktree directory must NOT be recursively deleted and must stay registered.
          expect(yield* fs.exists(imported.worktreePath)).toBe(true);
          expect(yield* fs.readFileString(path.join(imported.worktreePath, "file.txt"))).toBe(
            "feature\n",
          );
          const lockedPorcelainZ = yield* git(dstRepo, ["worktree", "list", "--porcelain", "-z"]);
          const realWorktreePath = yield* fs.realPath(imported.worktreePath);
          expect(lockedPorcelainZ).toContain(`worktree ${realWorktreePath}\0`);
          expect(lockedPorcelainZ).toContain("locked newline path lock\0");
          expect(
            (yield* git(dstRepo, ["branch", "--list", "feat/newline-locked-wt"])).trim(),
          ).not.toBe("");

          // Unlock and retry: must remove directory, unregister worktree, and delete branch cleanly.
          yield* git(dstRepo, ["worktree", "unlock", imported.worktreePath]);
          unlocked = true;

          yield* bundleService.removeWorktree({
            repoCwd: dstRepo,
            worktreePath: imported.worktreePath,
            branch: imported.branch,
          });
          expect(yield* fs.exists(imported.worktreePath)).toBe(false);
          const afterPorcelainZ = yield* git(dstRepo, ["worktree", "list", "--porcelain", "-z"]);
          expect(afterPorcelainZ).not.toContain(`worktree ${realWorktreePath}\0`);
          expect((yield* git(dstRepo, ["branch", "--list", "feat/newline-locked-wt"])).trim()).toBe(
            "",
          );
        } finally {
          if (!unlocked) {
            yield* git(dstRepo, ["worktree", "unlock", imported.worktreePath]).pipe(Effect.ignore);
          }
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "fails with WorkspaceBundleError without deleting the worktree directory when git worktree list stdout is truncated",
    () =>
      Effect.gen(function* () {
        const baseFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseVcsProcess = yield* VcsProcess.VcsProcess;

        const root = yield* baseFs.makeTempDirectoryScoped({ prefix: "t3-wb-truncated-wt-" });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const bundlePath = path.join(root, "truncated-wt.bundle");

        yield* baseFs.makeDirectory(srcRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* baseFs.writeFileString(path.join(srcRepo, "file.txt"), "base\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "init"]);
        yield* git(root, ["clone", srcRepo, dstRepo]);

        yield* git(srcRepo, ["checkout", "-b", "feat/truncated-wt"]);
        yield* baseFs.writeFileString(path.join(srcRepo, "file.txt"), "feature\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "feature"]);

        const baseBundleService = yield* WorkspaceBundle.WorkspaceBundle;
        const exported = yield* baseBundleService.exportWorkspaceBundle({
          transferId: "xfer-truncated-wt",
          cwd: srcRepo,
          outputPath: bundlePath,
        });
        const imported = yield* baseBundleService.importWorkspaceBundle({
          transferId: "xfer-truncated-wt",
          repoCwd: dstRepo,
          bundlePath,
          sourceBranch: exported.branch,
          targetLabel: "boat",
        });

        expect(yield* baseFs.exists(imported.worktreePath)).toBe(true);

        const observedListCalls: Array<{
          readonly args: ReadonlyArray<string>;
          readonly outputMode: VcsProcess.VcsProcessInput["outputMode"];
        }> = [];
        const truncatedVcsLayer = Layer.succeed(VcsProcess.VcsProcess, {
          run: (runInput) => {
            if (runInput.operation === "WorkspaceBundle.listWorktrees") {
              observedListCalls.push({
                args: runInput.args,
                outputMode: runInput.outputMode,
              });
              return Effect.succeed({
                exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
                stdout: `worktree ${dstRepo}\0HEAD 0000000000000000000000000000000000000000\0`,
                stderr: "",
                stdoutTruncated: true,
                stderrTruncated: false,
              });
            }
            return baseVcsProcess.run(runInput);
          },
        });
        const truncatedBundleLayer = Layer.fresh(WorkspaceBundle.layer).pipe(
          Layer.provide(truncatedVcsLayer),
        );

        const truncatedResult = yield* Effect.gen(function* () {
          const svc = yield* WorkspaceBundle.WorkspaceBundle;
          return yield* Effect.result(
            svc.removeWorktree({
              repoCwd: dstRepo,
              worktreePath: imported.worktreePath,
              branch: imported.branch,
            }),
          );
        }).pipe(Effect.provide(truncatedBundleLayer));

        expect(observedListCalls).toEqual([
          {
            args: ["worktree", "list", "--porcelain", "-z"],
            outputMode: "error",
          },
        ]);
        expect(Result.isFailure(truncatedResult)).toBe(true);
        if (Result.isFailure(truncatedResult)) {
          expect(truncatedResult.failure.code).toBe("git_error");
          expect(truncatedResult.failure.message).toContain("truncated");
        }

        // Worktree directory and files must remain intact on disk.
        expect(yield* baseFs.exists(imported.worktreePath)).toBe(true);
        expect(yield* baseFs.readFileString(path.join(imported.worktreePath, "file.txt"))).toBe(
          "feature\n",
        );
        expect((yield* git(dstRepo, ["branch", "--list", "feat/truncated-wt"])).trim()).not.toBe(
          "",
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );
  it.effect(
    "never deletes an externally created branch when interrupted after onWorktreeAllocated (both before and during git worktree add) and invokes onWorktreeCreated inside the lock",
    () =>
      Effect.gen(function* () {
        const baseFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseVcsProcess = yield* VcsProcess.VcsProcess;

        const root = yield* baseFs.makeTempDirectoryScoped({
          prefix: "t3-wb-interrupt-ext-branch-",
        });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const bundlePath = path.join(root, "interrupt-ext.bundle");

        yield* baseFs.makeDirectory(srcRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* baseFs.writeFileString(path.join(srcRepo, "file.txt"), "base\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "init"]);
        yield* git(root, ["clone", srcRepo, dstRepo]);

        yield* git(srcRepo, ["checkout", "-b", "feat/ext-branch-interrupt"]);
        yield* baseFs.writeFileString(path.join(srcRepo, "file.txt"), "feature\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "feature"]);

        const baseBundleService = yield* WorkspaceBundle.WorkspaceBundle;
        const exported = yield* baseBundleService.exportWorkspaceBundle({
          transferId: "xfer-ext-branch-interrupt",
          cwd: srcRepo,
          outputPath: bundlePath,
        });

        // Part 1: Interrupt while paused in onWorktreeAllocated (gitWorktreeAddInvoked === false)
        // after someone independently creates the requested branch in dstRepo.
        const allocPaused = yield* Deferred.make<void>();
        let allocatedBranchName = "";
        let allocatedWorktreePath = "";
        let clearedCount = 0;

        const fiber1 = yield* Effect.forkChild(
          baseBundleService.importWorkspaceBundle({
            transferId: "xfer-ext-branch-interrupt",
            repoCwd: dstRepo,
            bundlePath,
            sourceBranch: exported.branch,
            targetLabel: "boat",
            onWorktreeAllocated: (allocation) =>
              Effect.gen(function* () {
                allocatedBranchName = allocation.branch;
                allocatedWorktreePath = allocation.worktreePath;
                yield* Deferred.succeed(allocPaused, undefined);
                return yield* Effect.never;
              }),
            onWorktreeAllocationCleared: () =>
              Effect.sync(() => {
                clearedCount += 1;
              }),
          }),
        );
        yield* Deferred.await(allocPaused);
        expect(allocatedBranchName).toBe("feat/ext-branch-interrupt");

        // Independently create the branch in dstRepo before interrupting the transfer.
        yield* git(dstRepo, ["branch", allocatedBranchName]);
        const extBranchSha1 = (yield* git(dstRepo, [
          "rev-parse",
          `refs/heads/${allocatedBranchName}`,
        ])).trim();
        yield* Fiber.interrupt(fiber1);

        expect(clearedCount).toBe(1);
        expect(
          (yield* git(dstRepo, ["rev-parse", `refs/heads/${allocatedBranchName}`])).trim(),
        ).toBe(extBranchSha1);
        expect(yield* baseFs.exists(allocatedWorktreePath)).toBe(false);

        // Remove the external branch to run Part 2 on the same branch name.
        yield* git(dstRepo, ["branch", "-D", allocatedBranchName]);

        // Part 2: Pause right at VcsProcess.run("WorkspaceBundle.addWorktree") (gitWorktreeAddInvoked === true,
        // gitWorktreeAddSucceeded === false), independently create the branch in dstRepo, then interrupt.
        const addPaused = yield* Deferred.make<void>();
        let pauseAdd = true;
        let clearedCount2 = 0;
        let createdCallbackInsideLock = false;
        let lockHeld = false;

        const pausedVcsLayer = Layer.succeed(VcsProcess.VcsProcess, {
          run: (runInput) => {
            if (runInput.operation === "WorkspaceBundle.addWorktree" && pauseAdd) {
              pauseAdd = false;
              return Deferred.succeed(addPaused, undefined).pipe(Effect.andThen(Effect.never));
            }
            return baseVcsProcess.run(runInput);
          },
        });
        const pausedBundleLayer = Layer.fresh(WorkspaceBundle.layer).pipe(
          Layer.provide(pausedVcsLayer),
        );

        yield* Effect.gen(function* () {
          const svc = yield* WorkspaceBundle.WorkspaceBundle;
          let allocatedPath2 = "";
          const fiber2 = yield* Effect.forkChild(
            svc.importWorkspaceBundle({
              transferId: "xfer-ext-branch-interrupt",
              repoCwd: dstRepo,
              bundlePath,
              sourceBranch: exported.branch,
              targetLabel: "boat",
              onWorktreeAllocated: (allocation) =>
                Effect.sync(() => {
                  allocatedPath2 = allocation.worktreePath;
                }),
              onWorktreeAllocationCleared: () =>
                Effect.sync(() => {
                  clearedCount2 += 1;
                }),
            }),
          );
          yield* Deferred.await(addPaused);
          yield* git(dstRepo, ["branch", "feat/ext-branch-interrupt"]);
          const extBranchSha2 = (yield* git(dstRepo, [
            "rev-parse",
            "refs/heads/feat/ext-branch-interrupt",
          ])).trim();
          yield* Fiber.interrupt(fiber2);

          expect(clearedCount2).toBe(1);
          expect(
            (yield* git(dstRepo, ["rev-parse", "refs/heads/feat/ext-branch-interrupt"])).trim(),
          ).toBe(extBranchSha2);
          expect(yield* baseFs.exists(allocatedPath2)).toBe(false);

          // Part 3: Normal import invokes onWorktreeCreated while still holding withWorktreeAllocationLock.
          const imported = yield* svc.importWorkspaceBundle({
            transferId: "xfer-ext-branch-interrupt",
            repoCwd: dstRepo,
            bundlePath,
            sourceBranch: exported.branch,
            targetLabel: "boat",
            withWorktreeAllocationLock: (effect) =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  lockHeld = true;
                }),
                () => effect,
                () =>
                  Effect.sync(() => {
                    lockHeld = false;
                  }),
              ),
            onWorktreeCreated: () =>
              Effect.sync(() => {
                createdCallbackInsideLock = lockHeld;
              }),
          });
          expect(createdCallbackInsideLock).toBe(true);
          expect(imported.branch).not.toBe("feat/ext-branch-interrupt");
          expect(
            (yield* git(dstRepo, ["rev-parse", "refs/heads/feat/ext-branch-interrupt"])).trim(),
          ).toBe(extBranchSha2);
        }).pipe(Effect.provide(pausedBundleLayer));
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "never recursively deletes an unregistered directory or a worktree on a different branch when interrupted during add, and guards removeWorktree unregistered fallbacks",
    () =>
      Effect.gen(function* () {
        const baseFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseVcsProcess = yield* VcsProcess.VcsProcess;

        const root = yield* baseFs.makeTempDirectoryScoped({
          prefix: "t3-wb-unregistered-dir-guard-",
        });
        const srcRepo = path.join(root, "src");
        const dstRepo = path.join(root, "dst");
        const otherRepo = path.join(root, "other");
        const bundlePath = path.join(root, "unreg-guard.bundle");

        yield* baseFs.makeDirectory(srcRepo, { recursive: true });
        yield* git(srcRepo, ["init", "-b", "main"]);
        yield* baseFs.writeFileString(path.join(srcRepo, "file.txt"), "base\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "init"]);
        yield* git(root, ["clone", srcRepo, dstRepo]);
        yield* git(root, ["clone", srcRepo, otherRepo]);

        yield* git(srcRepo, ["checkout", "-b", "feat/unreg-dir-guard"]);
        yield* baseFs.writeFileString(path.join(srcRepo, "file.txt"), "feature\n");
        yield* git(srcRepo, ["add", "-A"]);
        yield* git(srcRepo, ["commit", "-m", "feature"]);

        const baseBundleService = yield* WorkspaceBundle.WorkspaceBundle;
        const exported = yield* baseBundleService.exportWorkspaceBundle({
          transferId: "xfer-unreg-dir-guard",
          cwd: srcRepo,
          outputPath: bundlePath,
        });

        // Probe 1 (Finding 2 exact probe): Pause add right after its final path check (inside
        // WorkspaceBundle.addWorktree before git spawns), independently create a directory + file
        // at worktreePath, then interrupt -> directory + file MUST survive untouched and ownership
        // MUST be cleared!
        const addPaused1 = yield* Deferred.make<void>();
        let pauseAdd1 = true;
        const pausedVcsLayer1 = Layer.succeed(VcsProcess.VcsProcess, {
          run: (runInput) => {
            if (runInput.operation === "WorkspaceBundle.addWorktree" && pauseAdd1) {
              pauseAdd1 = false;
              return Deferred.succeed(addPaused1, undefined).pipe(Effect.andThen(Effect.never));
            }
            return baseVcsProcess.run(runInput);
          },
        });
        const pausedBundleLayer1 = Layer.fresh(WorkspaceBundle.layer).pipe(
          Layer.provide(pausedVcsLayer1),
        );

        let clearedCount1 = 0;
        let allocatedPath1 = "";
        yield* Effect.gen(function* () {
          const svc = yield* WorkspaceBundle.WorkspaceBundle;
          const fiber = yield* Effect.forkChild(
            svc.importWorkspaceBundle({
              transferId: "xfer-unreg-dir-guard",
              repoCwd: dstRepo,
              bundlePath,
              sourceBranch: exported.branch,
              targetLabel: "boat",
              onWorktreeAllocated: (allocation) =>
                Effect.sync(() => {
                  allocatedPath1 = allocation.worktreePath;
                }),
              onWorktreeAllocationCleared: () =>
                Effect.sync(() => {
                  clearedCount1 += 1;
                }),
            }),
          );
          yield* Deferred.await(addPaused1);

          // Independently create a non-worktree directory + user file at the allocated path.
          yield* baseFs.makeDirectory(allocatedPath1, { recursive: true });
          const userFilePath = path.join(allocatedPath1, "user-important.txt");
          yield* baseFs.writeFileString(userFilePath, "do not delete me\n");

          yield* Fiber.interrupt(fiber);

          expect(clearedCount1).toBe(1);
          expect(yield* baseFs.exists(allocatedPath1)).toBe(true);
          expect(yield* baseFs.readFileString(userFilePath)).toBe("do not delete me\n");
        }).pipe(Effect.provide(pausedBundleLayer1));

        // Probe 2 (Finding 1 in cleanupIncompleteAdd): Pause add right after its final path check,
        // independently register a Git worktree at allocatedWorktreePath on a DIFFERENT branch
        // with an uncommitted file, then interrupt -> worktree, uncommitted file, and branch MUST
        // ALL survive untouched while ownership is cleared!
        const addPaused2 = yield* Deferred.make<void>();
        let pauseAdd2 = true;
        const pausedVcsLayer2 = Layer.succeed(VcsProcess.VcsProcess, {
          run: (runInput) => {
            if (runInput.operation === "WorkspaceBundle.addWorktree" && pauseAdd2) {
              pauseAdd2 = false;
              return Deferred.succeed(addPaused2, undefined).pipe(Effect.andThen(Effect.never));
            }
            return baseVcsProcess.run(runInput);
          },
        });
        const pausedBundleLayer2 = Layer.fresh(WorkspaceBundle.layer).pipe(
          Layer.provide(pausedVcsLayer2),
        );

        let clearedCount2 = 0;
        let allocatedPath2 = "";
        yield* Effect.gen(function* () {
          const svc = yield* WorkspaceBundle.WorkspaceBundle;
          const fiber = yield* Effect.forkChild(
            svc.importWorkspaceBundle({
              transferId: "xfer-unreg-dir-guard",
              repoCwd: dstRepo,
              bundlePath,
              sourceBranch: exported.branch,
              targetLabel: "boat",
              onWorktreeAllocated: (allocation) =>
                Effect.sync(() => {
                  allocatedPath2 = allocation.worktreePath;
                }),
              onWorktreeAllocationCleared: () =>
                Effect.sync(() => {
                  clearedCount2 += 1;
                }),
            }),
          );
          yield* Deferred.await(addPaused2);

          // Independently register a worktree at allocatedPath2 on a DIFFERENT branch.
          const otherBranch = "feat/independent-wt-branch";
          yield* git(dstRepo, ["worktree", "add", "-b", otherBranch, allocatedPath2, "HEAD"]);
          const dirtyFile = path.join(allocatedPath2, "wip.txt");
          yield* baseFs.writeFileString(dirtyFile, "uncommitted work\n");

          yield* Fiber.interrupt(fiber);

          expect(clearedCount2).toBe(1);
          expect(yield* baseFs.exists(allocatedPath2)).toBe(true);
          expect(yield* baseFs.readFileString(dirtyFile)).toBe("uncommitted work\n");
          expect((yield* git(dstRepo, ["branch", "--list", otherBranch])).trim()).not.toBe("");

          // Probe 3: removeWorktree with expectedBranch mismatch MUST refuse to force-remove
          // the worktree and leave its directory, file, and branch untouched!
          const wrongBranchRemove = yield* Effect.result(
            baseBundleService.removeWorktree({
              repoCwd: dstRepo,
              worktreePath: allocatedPath2,
              branch: otherBranch,
              expectedBranch: "feat/unreg-dir-guard",
            }),
          );
          expect(Result.isFailure(wrongBranchRemove)).toBe(true);
          if (Result.isFailure(wrongBranchRemove)) {
            expect(wrongBranchRemove.failure.code).toBe("git_error");
          }
          expect(yield* baseFs.exists(allocatedPath2)).toBe(true);
          expect(yield* baseFs.readFileString(dirtyFile)).toBe("uncommitted work\n");
          expect((yield* git(dstRepo, ["branch", "--list", otherBranch])).trim()).not.toBe("");
        }).pipe(Effect.provide(pausedBundleLayer2));

        // Probe 4: removeWorktree on unregistered directories:
        // (a) Plain directory without `.git` -> refuses with git_error, leaves untouched.
        const plainDir = path.join(root, "plain-user-dir");
        yield* baseFs.makeDirectory(plainDir, { recursive: true });
        yield* baseFs.writeFileString(path.join(plainDir, "keep.txt"), "precious\n");
        const plainFail = yield* Effect.result(
          baseBundleService.removeWorktree({
            repoCwd: dstRepo,
            worktreePath: plainDir,
          }),
        );
        expect(Result.isFailure(plainFail)).toBe(true);
        expect(yield* baseFs.readFileString(path.join(plainDir, "keep.txt"))).toBe("precious\n");

        // (b) Directory with `.git` gitfile pointing to a DIFFERENT repo's worktrees dir -> refuses!
        const foreignDir = path.join(root, "foreign-wt-dir");
        yield* baseFs.makeDirectory(foreignDir, { recursive: true });
        yield* baseFs.writeFileString(
          path.join(foreignDir, ".git"),
          `gitdir: ${path.join(otherRepo, ".git", "worktrees", "foreign")}\n`,
        );
        yield* baseFs.writeFileString(path.join(foreignDir, "foreign.txt"), "other repo\n");
        const foreignFail = yield* Effect.result(
          baseBundleService.removeWorktree({
            repoCwd: dstRepo,
            worktreePath: foreignDir,
          }),
        );
        expect(Result.isFailure(foreignFail)).toBe(true);
        expect(yield* baseFs.readFileString(path.join(foreignDir, "foreign.txt"))).toBe(
          "other repo\n",
        );

        // (c) Orphaned worktree directory whose `.git` gitfile points strictly inside
        //     `<dstRepo gitCommonDir>/worktrees/` -> allowed when fallback is enabled (default),
        //     refused when allowUnregisteredGitWorktreeFallback is false.
        const orphanDir = path.join(root, "orphan-wt-dir");
        yield* baseFs.makeDirectory(orphanDir, { recursive: true });
        yield* baseFs.writeFileString(
          path.join(orphanDir, ".git"),
          `gitdir: ${path.join(dstRepo, ".git", "worktrees", "orphan-wt")}\n`,
        );
        yield* baseFs.writeFileString(path.join(orphanDir, "orphan.txt"), "stale\n");

        const disallowedOrphan = yield* Effect.result(
          baseBundleService.removeWorktree({
            repoCwd: dstRepo,
            worktreePath: orphanDir,
            allowUnregisteredGitWorktreeFallback: false,
          }),
        );
        expect(Result.isFailure(disallowedOrphan)).toBe(true);
        expect(yield* baseFs.exists(orphanDir)).toBe(true);

        yield* baseBundleService.removeWorktree({
          repoCwd: dstRepo,
          worktreePath: orphanDir,
        });
        expect(yield* baseFs.exists(orphanDir)).toBe(false);
      }).pipe(Effect.provide(makeTestLayer())),
  );
});

#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
  STAGE_INSTALL_ARGS,
} from "./build-desktop-artifact.ts";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

export const ServerRuntimePlatform = Schema.Literals(["mac", "linux", "win"]);
export const ServerRuntimeArch = Schema.Literals(["arm64", "x64"]);
export type ServerRuntimePlatform = typeof ServerRuntimePlatform.Type;
export type ServerRuntimeArch = typeof ServerRuntimeArch.Type;

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

export class ServerRuntimeInputMissingError extends Schema.TaggedError<ServerRuntimeInputMissingError>()(
  "ServerRuntimeInputMissingError",
  { inputPath: Schema.String, hint: Schema.String },
) {
  override get message(): string {
    return `Missing ${this.inputPath}. ${this.hint}`;
  }
}

export class ServerRuntimeInstallFailedError extends Schema.TaggedError<ServerRuntimeInstallFailedError>()(
  "ServerRuntimeInstallFailedError",
  { exitCode: Schema.Int },
) {
  override get message(): string {
    return `vp install --prod (server runtime externals) exited with code ${this.exitCode}.`;
  }
}

export function serverRuntimePlatformKey(
  platform: ServerRuntimePlatform,
  arch: ServerRuntimeArch,
): string {
  const nodePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return `${nodePlatform}-${arch}`;
}

export class ServerRuntimeOutputNotEmptyError extends Schema.TaggedError<ServerRuntimeOutputNotEmptyError>()(
  "ServerRuntimeOutputNotEmptyError",
  { outputDir: Schema.String },
) {
  override get message(): string {
    return `${this.outputDir} is not empty. Staging writes and deletes package files there, so pass a new directory.`;
  }
}

const readServerRuntimeInputs = Effect.fn("readServerRuntimeInputs")(function* (input: {
  readonly repoRoot: string;
  readonly platform: ServerRuntimePlatform;
  readonly arch: ServerRuntimeArch;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* decodeWorkspaceConfig(
    yield* fs.readFileString(path.join(input.repoRoot, "pnpm-workspace.yaml")),
  );
  const catalog = workspace.catalog ?? {};
  const serverDependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies,
    catalog,
    "apps/server",
  );
  const fffNodeVersion = serverDependencies["@ff-labs/fff-node"];
  if (fffNodeVersion === undefined) {
    return yield* new ServerRuntimeInputMissingError({
      inputPath: "apps/server/package.json#dependencies['@ff-labs/fff-node']",
      hint: "The runtime stages fff's platform binary from this version.",
    });
  }
  return {
    workspace,
    catalog,
    dependencies: {
      ...selectCliRuntimeExternalDependencies(serverDependencies),
      ...resolveFffNativeDependencies(input.platform, input.arch, fffNodeVersion),
    },
  };
});

export const resolveServerRuntimeDependencies = (
  input: Parameters<typeof readServerRuntimeInputs>[0],
) => readServerRuntimeInputs(input).pipe(Effect.map((inputs) => inputs.dependencies));

/** Installed runtimes cannot rely on pnpm's store layout surviving archival or a container copy. */
export const stageServerRuntime = Effect.fn("stageServerRuntime")(function* (input: {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly platform: ServerRuntimePlatform;
  readonly arch: ServerRuntimeArch;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { workspace, catalog, dependencies } = yield* readServerRuntimeInputs(input);
  const patchedDependencies = createStagePatchedDependencies(
    workspace.patchedDependencies ?? {},
    dependencies,
  );

  yield* fs.makeDirectory(input.stageDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(input.stageDir, "package.json"),
    `${yield* encodeJsonString({
      name: "t3-runtime",
      private: true,
      packageManager: rootPackageJson.packageManager,
      dependencies,
    })}\n`,
  );
  yield* fs.writeFileString(
    path.join(input.stageDir, "pnpm-workspace.yaml"),
    yield* encodeStageWorkspaceConfig({
      ...createStageWorkspaceConfig({
        platform: input.platform,
        arch: input.arch,
        ...(workspace.allowBuilds ? { allowBuilds: workspace.allowBuilds } : {}),
        patchedDependencies,
        overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/server"),
      }),
      nodeLinker: "hoisted",
    }),
  );
  if (Object.keys(patchedDependencies).length > 0) {
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(input.stageDir, "patches"));
  }

  const install = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  const exitCode = yield* spawner
    .spawn(
      ChildProcess.make(install.command, install.args, {
        cwd: input.stageDir,
        shell: install.shell,
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.flatMap((child) => child.exitCode),
      Effect.scoped,
    );
  if (Number(exitCode) !== 0) {
    return yield* new ServerRuntimeInstallFailedError({ exitCode: Number(exitCode) });
  }

  const platformKey = serverRuntimePlatformKey(input.platform, input.arch);
  const prebuildsDir = path.join(input.stageDir, "node_modules/node-pty/prebuilds");
  const foreignPrebuilds = (yield* fs
    .readDirectory(prebuildsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter(
    (entry) => entry !== platformKey,
  );
  for (const entry of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "patches",
    "node_modules/.pnpm",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.bin",
    ...foreignPrebuilds.map((entry) => `node_modules/node-pty/prebuilds/${entry}`),
  ]) {
    yield* fs.remove(path.join(input.stageDir, entry), { recursive: true, force: true });
  }
  // Nested .bin shims are unused symlinks, which the npm registry rejects in tarballs.
  yield* removeNestedBinDirectories(fs, path, path.join(input.stageDir, "node_modules"));
});

const removeNestedBinDirectories = Effect.fn("stage-server-runtime.removeNestedBinDirectories")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    root: string,
  ): Effect.fn.Return<void, PlatformError.PlatformError> {
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const child = path.join(root, entry);
      if (entry === ".bin") {
        yield* fs.remove(child, { recursive: true, force: true });
        continue;
      }
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") {
        yield* removeNestedBinDirectories(fs, path, child);
      }
    }
  },
);

export const stageServerRuntimeToNewDirectory = Effect.fn("stageServerRuntimeToNewDirectory")(
  function* (input: {
    readonly outputDir: string;
    readonly platform: ServerRuntimePlatform;
    readonly arch: ServerRuntimeArch;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stageDir = path.resolve(input.outputDir);
    const existing = yield* fs.readDirectory(stageDir).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        (): Effect.Effect<ReadonlyArray<string>> => Effect.succeed([]),
      ),
    );
    if (existing.length > 0) {
      return yield* new ServerRuntimeOutputNotEmptyError({ outputDir: stageDir });
    }
    yield* stageServerRuntime({
      repoRoot: yield* path.fromFileUrl(new URL("..", import.meta.url)),
      stageDir,
      platform: input.platform,
      arch: input.arch,
    });
  },
);

const command = Command.make(
  "stage-server-runtime",
  {
    platform: Flag.Literals("platform", ServerRuntimePlatform.literals),
    arch: Flag.Literals("arch", ServerRuntimeArch.literals),
    outputDir: Flag.String("output-dir").pipe(
      Flag.withDescription("New or empty directory that receives node_modules."),
    ),
  },
  stageServerRuntimeToNewDirectory,
).pipe(
  Command.withDescription(
    "Install the server bundle's runtime externals into <output-dir>/node_modules for one platform.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}

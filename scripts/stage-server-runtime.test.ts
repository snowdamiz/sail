import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { isRuntimeExternalCliDependency } from "./lib/cli-external-packages.ts";
import {
  resolveServerRuntimeDependencies,
  serverRuntimePlatformKey,
  stageServerRuntime,
} from "./stage-server-runtime.ts";

const Manifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));

/** Node's package lookup: the nearest node_modules/<name> from `fromDir` up to the stage root. */
const findPackageDir = Effect.fn("test.findPackageDir")(function* (
  stageDir: string,
  fromDir: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (yield* fs.exists(path.join(candidate, "package.json"))) return candidate;
    if (dir === stageDir || !dir.startsWith(stageDir)) return undefined;
  }
});

it.layer(NodeServices.layer)("stage-server-runtime", (it) => {
  it.effect(
    "stages a self-contained tree with every runtime external the server bundle loads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
        const hostPlatform = yield* HostProcess.Platform;
        const platform =
          hostPlatform === "darwin" ? "mac" : hostPlatform === "win32" ? "win" : "linux";
        const hostArch = yield* HostProcess.Architecture;
        assert.isTrue(hostArch === "arm64" || hostArch === "x64", `unsupported arch ${hostArch}`);
        const arch = hostArch === "arm64" ? "arm64" : "x64";
        const stageDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-runtime-" });

        yield* stageServerRuntime({ repoRoot, stageDir, platform, arch });

        const { dependencies } = yield* resolveServerRuntimeDependencies({
          repoRoot,
          platform,
          arch,
        });
        const externals = Object.keys(dependencies);
        assert.includeMembers(externals, ["node-pty", "@cursor/sdk", "playwright-core"]);
        assert.isTrue(
          externals.every(
            (name) => isRuntimeExternalCliDependency(name) || name.startsWith("@ff-labs/fff-bin-"),
          ),
          "only runtime externals are staged",
        );

        const missing: Array<string> = [];
        const visited = new Set<string>();
        const queue = externals.map((name) => ({ from: stageDir, name, optional: false }));
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const dir = yield* findPackageDir(stageDir, next.from, next.name);
          if (dir === undefined) {
            if (!next.optional) missing.push(`${next.name} (from ${next.from})`);
            continue;
          }
          if (visited.has(dir)) continue;
          visited.add(dir);
          const manifest = yield* decodeManifest(
            yield* fs.readFileString(path.join(dir, "package.json")),
          );
          const optional = manifest.optionalDependencies ?? {};
          for (const name of Object.keys({ ...manifest.dependencies, ...optional })) {
            queue.push({ from: dir, name, optional: Object.hasOwn(optional, name) });
          }
        }
        assert.deepEqual(missing, []);

        for (const leftover of [
          "package.json",
          "pnpm-lock.yaml",
          "node_modules/.pnpm",
          "node_modules/.bin",
        ]) {
          assert.isFalse(yield* fs.exists(path.join(stageDir, leftover)), leftover);
        }
        assert.deepEqual(
          yield* fs.readDirectory(path.join(stageDir, "node_modules/node-pty/prebuilds")),
          [serverRuntimePlatformKey(platform, arch)],
        );
      }).pipe(Effect.scoped),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - the publication test coordinates an editor save with the native link call.
import * as NodeFSP from "node:fs/promises";
import {
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  MAX_ENVIRONMENT_SETUP_BYTES,
  MAX_ENVIRONMENT_SETUP_FILES,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  WS_METHODS,
  clientRpcRequiredScopes,
  type EnvironmentSetupBundle,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as Keybindings from "../keybindings.ts";
import { makeAdmission, ServerAdmission } from "../serverAdmission.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as Transfer from "./EnvironmentSetupTransfer.ts";

vi.mock("node:fs/promises", { spy: true });

const providerId = ProviderInstanceId.make("example");
const registryId = ProviderInstanceId.make("sampleRegistry");
const localId = ProviderInstanceId.make("sampleLocal");
const registryDriver = ProviderDriverKind.make("acpRegistry");
const driver = ProviderDriverKind.make("codex");
const sourceReference = { provider: SecretProviderId.make("fixture"), reference: "dummy/source" };
const targetReference = { provider: SecretProviderId.make("fixture"), reference: "dummy/target" };

const withEnvironment = <A, E, R>(
  home: string,
  settings: Partial<ServerSettings>,
  operation: Effect.Effect<A, E, R>,
) =>
  operation.pipe(
    Effect.provide(
      Transfer.layerTest(home).pipe(
        Layer.provideMerge(Layer.merge(Keybindings.layer, EnvironmentTheme.layer)),
        Layer.provideMerge(ServerSettingsService.layerTest(settings)),
        Layer.provideMerge(ServerConfig.layerTest(home, home)),
      ),
    ),
  );

it.layer(NodeServices.layer)("portable environment setup", (it) => {
  it.effect("copies setup in both directions while preserving local paths and credentials", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const target = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const sourceSkill = path.join(source, ".agents", "skills", "source-skill");
      const targetSkill = path.join(target, ".codex", "skills", "target-skill");
      yield* fs.makeDirectory(sourceSkill, { recursive: true });
      yield* fs.makeDirectory(targetSkill, { recursive: true });
      yield* fs.writeFileString(path.join(sourceSkill, "SKILL.md"), "# Source skill\n");
      yield* fs.writeFileString(path.join(sourceSkill, "run.sh"), "#!/bin/sh\n");
      if (platform !== "win32") yield* fs.chmod(path.join(sourceSkill, "run.sh"), 0o700);
      yield* fs.writeFile(path.join(sourceSkill, "sample.bin"), new Uint8Array([0xff, 0]));
      yield* fs.writeFileString(path.join(targetSkill, "SKILL.md"), "# Target skill\n");
      const sourceSettings = {
        worktreesDirectory: "/dummy/source-worktrees",
        responseStreamingMode: "turn",
        providerInstances: {
          [registryId]: {
            driver: registryDriver,
            config: { agentId: "dummy-agent", commandPath: "/dummy/registry" },
          },
          [localId]: {
            driver: registryDriver,
            enabled: true,
            config: { source: "local", commandPath: "/dummy/local" },
          },
          [providerId]: {
            driver,
            displayName: "Source provider",
            config: {
              binaryPath: "/dummy/source-bin",
              homePath: "/dummy/source-home",
              apiKey: "dummy-config-secret",
              customModels: ["sample-model"],
            },
            environment: [
              { name: "EXAMPLE_TOKEN", value: sourceReference, sensitive: true },
              { name: "MISSING_TOKEN", value: "dummy-env-secret", sensitive: true },
              { name: "CUSTOM_PATH", value: "/dummy/source-env", sensitive: false },
            ],
          },
        },
      } satisfies Partial<ServerSettings>;
      const bundle = yield* withEnvironment(
        source,
        sourceSettings,
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const shortcuts = yield* Keybindings.Keybindings;
          const themes = yield* EnvironmentTheme.EnvironmentThemeService;
          yield* shortcuts.upsertKeybindingRule({ key: "mod+shift+j", command: "chat.find" });
          yield* themes.publishPortable([
            {
              id: "example",
              file: { name: "Example", appearance: "dark", canvas: "#112233", accent: "#556677" },
            },
          ]);
          return yield* transfer.export();
        }),
      );
      const serialized = JSON.stringify(bundle);
      for (const localValue of [
        "worktreesDirectory",
        "binaryPath",
        "homePath",
        "dummy-config-secret",
        "dummy-env-secret",
        "dummy/source",
        "CUSTOM_PATH",
      ]) {
        expect(serialized).not.toContain(localValue);
      }
      expect(bundle.providers.find(({ id }) => id === providerId)).toEqual({
        id: providerId,
        driver,
        displayName: "Source provider",
        customModels: ["sample-model"],
        requiredEnvironment: ["EXAMPLE_TOKEN", "MISSING_TOKEN"],
      });
      expect(bundle.providers.find(({ id }) => id === registryId)).toMatchObject({
        acp: { source: "registry", agentId: "dummy-agent" },
      });
      expect(serialized).not.toContain("/dummy/registry");
      expect(serialized).not.toContain("/dummy/local");

      const reverseBundle = yield* withEnvironment(
        target,
        {
          worktreesDirectory: "/dummy/target-worktrees",
          favorites: [{ provider: providerId, model: "target-model" }],
          providerInstances: {
            [providerId]: {
              driver,
              config: {
                binaryPath: "/dummy/target-bin",
                homePath: "/dummy/target-home",
                apiKey: targetReference,
              },
              environment: [{ name: "EXAMPLE_TOKEN", value: targetReference, sensitive: true }],
            },
          },
        },
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const settings = yield* ServerSettingsService.ServerSettingsService;
          const preview = yield* transfer.import({ action: "preview", bundle });
          expect(preview.providers.find(({ id }) => id === localId)?.needsLocalSetup).toBe(true);
          const destination = path.join(target, ".agents", "skills", "source-skill");
          expect(yield* fs.exists(destination)).toBe(false);
          expect(preview.providers[0]?.missingEnvironment).toEqual(["MISSING_TOKEN"]);
          expect(preview.skills).toEqual([{ root: "agents", folder: "source-skill" }]);
          const apply = { action: "apply", bundle, revision: preview.revision } as const;
          yield* transfer.import(apply);
          yield* transfer.import(apply);
          const next = yield* transfer.import({ action: "preview", bundle });
          expect(next).toMatchObject({
            settings: false,
            keybindings: false,
            themes: [],
            skills: [],
            providers: bundle.providers.map(() => ({ changed: false })),
          });
          expect(yield* settings.getSettings).toMatchObject({
            worktreesDirectory: "/dummy/target-worktrees",
            favorites: [{ provider: providerId, model: "target-model" }],
            providerInstances: {
              [registryId]: {
                driver: registryDriver,
                config: { source: "registry", agentId: "dummy-agent" },
              },
              [localId]: { driver: registryDriver, enabled: false, config: { source: "local" } },
              [providerId]: {
                config: {
                  binaryPath: "/dummy/target-bin",
                  homePath: "/dummy/target-home",
                  apiKey: targetReference,
                  customModels: ["sample-model"],
                },
                environment: [
                  { name: "EXAMPLE_TOKEN", value: targetReference, sensitive: true },
                  { name: "MISSING_TOKEN", value: "", sensitive: true },
                ],
              },
            },
          });
          expect(Array.from(yield* fs.readFile(path.join(destination, "sample.bin")))).toEqual([
            0xff, 0,
          ]);
          if (platform !== "win32") {
            const script = path.join(destination, "run.sh");
            yield* fs.chmod(script, 0o600);
            const repair = yield* transfer.import({ action: "preview", bundle });
            expect(repair.skills).toEqual([{ root: "agents", folder: "source-skill" }]);
            yield* transfer.import({ action: "apply", bundle, revision: repair.revision });
            expect((yield* fs.stat(script)).mode & 0o100).toBe(0o100);
          }
          return yield* transfer.export();
        }),
      );

      yield* withEnvironment(
        source,
        sourceSettings,
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const preview = yield* transfer.import({ action: "preview", bundle: reverseBundle });
          yield* transfer.import({
            action: "apply",
            bundle: reverseBundle,
            revision: preview.revision,
          });
          expect(
            yield* fs.readFileString(
              path.join(source, ".codex", "skills", "target-skill", "SKILL.md"),
            ),
          ).toBe("# Target skill\n");
        }),
      );
    }),
  );

  it.effect("requires a fresh preview when a target setting changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* withEnvironment(
        home,
        {},
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const settings = yield* ServerSettingsService.ServerSettingsService;
          const original = yield* transfer.export();
          const bundle = {
            ...original,
            skills: [
              { root: "agents", path: "sample/SKILL.md", encoding: "utf8", content: "# Sample" },
            ],
          } satisfies EnvironmentSetupBundle;
          const preview = yield* transfer.import({ action: "preview", bundle });
          yield* settings.updateSettings({ responseStreamingMode: "turn" });
          const error = yield* Effect.flip(
            transfer.import({ action: "apply", bundle, revision: preview.revision }),
          );
          expect(error.message).toContain("Preview the copy again");
          expect(yield* fs.exists(path.join(home, ".agents"))).toBe(false);
        }),
      );
    }),
  );

  it.effect("holds setup writes behind the maintenance gate and allows retry after reopening", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const admission = makeAdmission(Effect.succeed([]), "complete");
      yield* withEnvironment(
        home,
        {},
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const bundle = {
            ...(yield* transfer.export()),
            skills: [
              { root: "agents", path: "sample/SKILL.md", encoding: "utf8", content: "# Sample" },
            ],
          } satisfies EnvironmentSetupBundle;
          const seal = Symbol();
          expect(yield* admission.drain(seal, "2 seconds")).toEqual({ kind: "sealed" });
          const preview = yield* transfer.import({ action: "preview", bundle });
          const apply = transfer.import({ action: "apply", bundle, revision: preview.revision });
          const error = yield* Effect.flip(apply);
          expect(error.message).toContain("Server maintenance is in progress");
          const skill = path.join(home, ".agents", "skills", "sample", "SKILL.md");
          expect(yield* fs.exists(skill)).toBe(false);
          expect(yield* admission.abort(seal)).toBe(true);
          yield* apply;
          expect(yield* fs.readFileString(skill)).toBe("# Sample");
        }),
      ).pipe(Effect.provideService(ServerAdmission, admission));
    }),
  );

  it.effect("requires a fresh preview when a destination ancestor changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* withEnvironment(
        home,
        {},
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const bundle = {
            ...(yield* transfer.export()),
            skills: [
              { root: "agents", path: "sample/SKILL.md", encoding: "utf8", content: "# Sample" },
            ],
          } satisfies EnvironmentSetupBundle;
          const provider = path.join(home, ".agents");
          const root = path.join(provider, "skills");
          const leaf = path.join(root, "sample", "SKILL.md");
          yield* fs.makeDirectory(provider);
          const missingRoot = yield* transfer.import({ action: "preview", bundle });
          yield* fs.makeDirectory(root);
          const emptyRoot = yield* transfer.import({ action: "preview", bundle });
          expect(emptyRoot.revision).not.toBe(missingRoot.revision);

          yield* fs.rename(provider, path.join(home, ".agents-original"));
          yield* fs.makeDirectory(root, { recursive: true });
          const error = yield* Effect.flip(
            transfer.import({ action: "apply", bundle, revision: emptyRoot.revision }),
          );
          expect(error.message).toContain("Preview the copy again");
          expect(yield* fs.exists(leaf)).toBe(false);

          const fresh = yield* transfer.import({ action: "preview", bundle });
          yield* fs.writeFileString(path.join(root, "local-note"), "Keep this");
          yield* transfer.import({ action: "apply", bundle, revision: fresh.revision });
          expect(yield* fs.readFileString(leaf)).toBe("# Sample");
          expect(yield* fs.readFileString(path.join(root, "local-note"))).toBe("Keep this");
        }),
      );
    }),
  );

  it.effect("preserves an editor save after apply has checked the preview", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* withEnvironment(
        home,
        {},
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const bundle = {
            ...(yield* transfer.export()),
            skills: [
              { root: "agents", path: "sample/SKILL.md", encoding: "utf8", content: "# Imported" },
            ],
          } satisfies EnvironmentSetupBundle;
          const directory = path.join(home, ".agents", "skills", "sample");
          yield* fs.makeDirectory(directory, { recursive: true });
          const leaf = path.join(directory, "SKILL.md");
          for (const previous of [undefined, "# Existing"]) {
            if (previous !== undefined) yield* fs.writeFileString(leaf, previous);
            const preview = yield* transfer.import({ action: "preview", bundle });
            let checks = 0;
            const editorSave = Effect.gen(function* () {
              if (++checks === 2) yield* fs.writeFileString(leaf, "# Editor save");
            });
            const error = yield* Effect.flip(
              transfer.import({ action: "apply", bundle, revision: preview.revision }, editorSave),
            );
            expect(error.message).toContain("Preview the copy again");
            expect(yield* fs.readFileString(leaf)).toBe("# Editor save");
          }

          const fresh = yield* transfer.import({ action: "preview", bundle });
          yield* transfer.import({ action: "apply", bundle, revision: fresh.revision });
          expect(yield* fs.readFileString(leaf)).toBe("# Imported");
          expect((yield* transfer.export()).skills).toEqual(bundle.skills);
          const recovery = (yield* fs.readDirectory(directory)).filter((name) =>
            name.startsWith(".sail-setup-"),
          );
          expect(recovery).toHaveLength(1);
          for (const name of recovery) {
            expect(yield* fs.readFileString(path.join(directory, name, "SKILL.md"))).toBe(
              "# Editor save",
            );
          }
        }),
      );
    }),
  );

  it.effect("keeps a new editor file when it arrives during publication", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const native = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      yield* withEnvironment(
        home,
        {},
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const bundle = {
            ...(yield* transfer.export()),
            skills: [
              { root: "agents", path: "sample/SKILL.md", encoding: "utf8", content: "# Imported" },
            ],
          } satisfies EnvironmentSetupBundle;
          const directory = path.join(home, ".agents", "skills", "sample");
          yield* fs.makeDirectory(directory, { recursive: true });
          const leaf = path.join(directory, "SKILL.md");
          const editorSave = "# Saved during import";
          using _link = vi
            .spyOn(NodeFSP, "link")
            .mockImplementation(async (source, destination) => {
              if (typeof destination === "string" && path.basename(destination) === "SKILL.md") {
                await native.writeFile(leaf, editorSave, { flag: "wx" });
              }
              await native.link(source, destination);
            });

          for (const previous of [undefined, "# Existing"]) {
            if (previous !== undefined) yield* fs.writeFileString(leaf, previous);
            const preview = yield* transfer.import({ action: "preview", bundle });
            const error = yield* Effect.flip(
              transfer.import({ action: "apply", bundle, revision: preview.revision }),
            );
            expect(error.message).toContain("Preview the copy again");
            expect(yield* fs.readFileString(leaf)).toBe(editorSave);
            const recovery = (yield* fs.readDirectory(directory)).filter((name) =>
              name.startsWith(".sail-setup-"),
            );
            if (previous === undefined) {
              expect(recovery).toHaveLength(0);
            } else {
              expect(recovery).toHaveLength(1);
              for (const name of recovery) {
                const saved = path.join(directory, name, "SKILL.md");
                expect(error.message).toContain(path.relative(home, saved));
                expect(yield* fs.readFileString(saved)).toBe(previous);
              }
            }
          }
        }),
      );
    }),
  );

  it.effect("rejects invalid bundle shapes and sizes before writing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* withEnvironment(
        home,
        {},
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const bundle = yield* transfer.export();
          const file = {
            root: "agents",
            path: "sample/SKILL.md",
            encoding: "utf8",
            content: "# Sample",
          } satisfies EnvironmentSetupBundle["skills"][number];
          const invalid = [
            [{ ...file, path: "../sample/SKILL.md" }],
            [{ ...file, path: "/sample/SKILL.md" }],
            [{ ...file, path: "sample\\SKILL.md" }],
            [file, file],
            [{ ...file, content: "a".repeat(MAX_ENVIRONMENT_SETUP_BYTES) }],
            Array.from({ length: MAX_ENVIRONMENT_SETUP_FILES + 1 }, (_, index) => ({
              ...file,
              path: `sample-${index}/SKILL.md`,
            })),
            [{ ...file, kind: "symlink" }],
          ];
          for (const skills of invalid) {
            const error = yield* Effect.flip(
              transfer.import({
                action: "preview",
                bundle: { ...bundle, skills },
              }),
            );
            assert.strictEqual(error._tag, "EnvironmentSetupError");
          }
          expect(yield* fs.exists(path.join(home, ".agents"))).toBe(false);
        }),
      );
    }),
  );

  it.effect("rejects a linked target skill directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const linked = yield* fs.makeTempDirectoryScoped();
      const bundle = yield* withEnvironment(
        linked,
        {},
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const base = yield* transfer.export();
          return {
            ...base,
            skills: [
              { root: "agents", path: "sample/SKILL.md", encoding: "utf8", content: "# Sample" },
            ],
          } satisfies EnvironmentSetupBundle;
        }),
      );
      const agents = path.join(home, ".agents");
      yield* fs.makeDirectory(agents);
      yield* fs.symlink(linked, path.join(agents, "skills"));
      yield* withEnvironment(
        home,
        {},
        Effect.gen(function* () {
          const transfer = yield* Transfer.EnvironmentSetupTransfer;
          const failure = yield* Effect.flip(transfer.import({ action: "preview", bundle }));
          assert.strictEqual(failure._tag, "EnvironmentSetupError");
        }),
      );
      expect(yield* fs.exists(path.join(linked, "sample"))).toBe(false);
    }),
  );
});

it("requires every scope crossed by the copy", () => {
  expect(clientRpcRequiredScopes(WS_METHODS.environmentSetupExport, {})).toEqual([
    AuthProvidersManageScope,
    AuthFilesystemReadScope,
  ]);
  expect(clientRpcRequiredScopes(WS_METHODS.environmentSetupImport, undefined)).toEqual([
    AuthSettingsWriteScope,
    AuthProvidersManageScope,
    AuthTerminalOperateScope,
  ]);
});

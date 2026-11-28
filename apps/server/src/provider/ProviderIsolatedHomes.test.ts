// @effect-diagnostics-next-line nodeBuiltinImport:off -- test computes reference sha256 hashes.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure synchronous unit tests pass NodePath as Pick<Path.Path, "join">.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  isolatedProviderHomeHash,
  resolveIsolatedClaudeHomePath,
  resolveIsolatedCodexShadowHomePath,
  resolveIsolatedEnvProviderHomePath,
  withAutoIsolatedProviderHome,
  withAutoIsolatedProviderInstanceMutation,
  withAutoIsolatedProviderInstancesPatch,
} from "./ProviderIsolatedHomes.ts";

const STATE_DIR = "/var/lib/sail/state";

describe("ProviderIsolatedHomes", () => {
  it("computes deterministic sha256 isolated home paths matching ProviderAuthSync convention", () => {
    const claudeId = ProviderInstanceId.make("claudeAgent_work");
    const codexId = ProviderInstanceId.make("codex_work");
    const expectedClaudeHash = NodeCrypto.createHash("sha256").update(claudeId).digest("hex");
    const expectedCodexHash = NodeCrypto.createHash("sha256").update(codexId).digest("hex");

    expect(isolatedProviderHomeHash(claudeId)).toBe(expectedClaudeHash);
    expect(
      resolveIsolatedClaudeHomePath({ stateDir: STATE_DIR, instanceId: claudeId, path: NodePath }),
    ).toBe(NodePath.join(STATE_DIR, "providers", "claude", expectedClaudeHash));
    expect(
      resolveIsolatedCodexShadowHomePath({
        stateDir: STATE_DIR,
        instanceId: codexId,
        path: NodePath,
      }),
    ).toBe(NodePath.join(STATE_DIR, "providers", "codex", expectedCodexHash));
  });

  it("auto-assigns isolated homePath for non-default Claude instances without one", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent_2");
    const result = withAutoIsolatedProviderHome({
      stateDir: STATE_DIR,
      instanceId,
      instance: {
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude 2",
        enabled: true,
        config: { binaryPath: "/usr/local/bin/claude" },
      },
      path: NodePath,
    });

    expect(result.config).toEqual({
      binaryPath: "/usr/local/bin/claude",
      homePath: resolveIsolatedClaudeHomePath({
        stateDir: STATE_DIR,
        instanceId,
        path: NodePath,
      }),
    });
  });

  it("preserves explicit homePath on non-default Claude and leaves default Claude untouched", () => {
    const defaultClaude = {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      config: {},
    };
    expect(
      withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: ProviderInstanceId.make("claudeAgent"),
        instance: defaultClaude,
        path: NodePath,
      }),
    ).toBe(defaultClaude);

    const customClaude = {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      config: { homePath: "~/.claude-work" },
    };
    expect(
      withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: ProviderInstanceId.make("claudeAgent_work"),
        instance: customClaude,
        path: NodePath,
      }),
    ).toBe(customClaude);
  });

  it("auto-assigns isolated shadowHomePath for non-default existing-CLI Codex instances", () => {
    const instanceId = ProviderInstanceId.make("codex_2");
    const result = withAutoIsolatedProviderHome({
      stateDir: STATE_DIR,
      instanceId,
      instance: {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex 2",
        enabled: true,
        config: { setupMode: "existing" },
      },
      path: NodePath,
    });

    expect(result.config).toEqual({
      setupMode: "existing",
      shadowHomePath: resolveIsolatedCodexShadowHomePath({
        stateDir: STATE_DIR,
        instanceId,
        path: NodePath,
      }),
    });
  });

  it("skips managed Codex, default Codex, explicit Codex homes, and other drivers", () => {
    const managedCodex = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { setupMode: "managed" },
    };
    expect(
      withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: ProviderInstanceId.make("codex_managed_2"),
        instance: managedCodex,
        path: NodePath,
      }),
    ).toBe(managedCodex);

    const defaultCodex = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { setupMode: "existing" },
    };
    expect(
      withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: ProviderInstanceId.make("codex"),
        instance: defaultCodex,
        path: NodePath,
      }),
    ).toBe(defaultCodex);

    const explicitCodex = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { homePath: "~/.codex-custom" },
    };
    expect(
      withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: ProviderInstanceId.make("codex_custom"),
        instance: explicitCodex,
        path: NodePath,
      }),
    ).toBe(explicitCodex);

    const cursor = {
      driver: ProviderDriverKind.make("cursor"),
      enabled: true,
    };
    expect(
      withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: ProviderInstanceId.make("cursor_2"),
        instance: cursor,
        path: NodePath,
      }),
    ).toBe(cursor);
  });

  it("auto-isolates Grok, OpenCode, Pi, and Muse secondary accounts via environment directories", () => {
    const cases = [
      { driver: "grok", instanceId: "grok_2", envVar: "GROK_HOME", subdir: "grok" },
      { driver: "opencode", instanceId: "opencode_2", envVar: "XDG_DATA_HOME", subdir: "opencode" },
      { driver: "pi", instanceId: "pi_2", envVar: "PI_CODING_AGENT_DIR", subdir: "pi" },
      { driver: "muse", instanceId: "muse_2", envVar: "XDG_DATA_HOME", subdir: "muse" },
    ] as const;

    for (const entry of cases) {
      const id = ProviderInstanceId.make(entry.instanceId);
      const result = withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: id,
        instance: {
          driver: ProviderDriverKind.make(entry.driver),
          enabled: true,
        },
        path: NodePath,
      });
      expect(result.environment).toEqual([
        {
          name: entry.envVar,
          value: resolveIsolatedEnvProviderHomePath({
            stateDir: STATE_DIR,
            subdir: entry.subdir,
            instanceId: id,
            path: NodePath,
          }),
          sensitive: false,
        },
      ]);

      // Default instance stays untouched.
      const defaultInstance = {
        driver: ProviderDriverKind.make(entry.driver),
        enabled: true,
      };
      expect(
        withAutoIsolatedProviderHome({
          stateDir: STATE_DIR,
          instanceId: ProviderInstanceId.make(entry.driver),
          instance: defaultInstance,
          path: NodePath,
        }),
      ).toBe(defaultInstance);

      // Explicit env var stays untouched.
      const customInstance = {
        driver: ProviderDriverKind.make(entry.driver),
        enabled: true,
        environment: [{ name: entry.envVar, value: "/custom/dir", sensitive: false }],
      };
      expect(
        withAutoIsolatedProviderHome({
          stateDir: STATE_DIR,
          instanceId: id,
          instance: customInstance,
          path: NodePath,
        }),
      ).toBe(customInstance);
    }
  });

  it("never alters homePath/env when upserting or patching an already-existing instance", () => {
    const claudeId = ProviderInstanceId.make("claudeAgent_legacy");
    const existingInstance = {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Old Name",
      enabled: true,
      config: { homePath: "" },
    };
    const renamed = {
      ...existingInstance,
      displayName: "New Name",
    };

    const upserted = withAutoIsolatedProviderInstanceMutation({
      stateDir: STATE_DIR,
      mutation: {
        operation: "upsert",
        instanceId: claudeId,
        instance: renamed,
      },
      existingInstances: { [claudeId]: existingInstance },
      path: NodePath,
    });
    expect(upserted.operation).toBe("upsert");
    if (upserted.operation === "upsert") {
      expect(upserted.instance).toBe(renamed);
    }

    const patched = withAutoIsolatedProviderInstancesPatch({
      stateDir: STATE_DIR,
      patch: { providerInstances: { [claudeId]: renamed } },
      existingInstances: { [claudeId]: existingInstance },
      path: NodePath,
    });
    expect(patched.providerInstances?.[claudeId]).toBe(renamed);

    // Explicit CLAUDE_CONFIG_DIR on a brand-new instance is also preserved.
    const envClaude = {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/custom/claude", sensitive: false }],
    };
    expect(
      withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: ProviderInstanceId.make("claudeAgent_env"),
        instance: envClaude,
        path: NodePath,
      }),
    ).toBe(envClaude);

    const winMixedCaseClaude = {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      environment: [{ name: "Claude_Config_Dir", value: "C:\\claude-win", sensitive: false }],
    };
    expect(
      withAutoIsolatedProviderHome({
        stateDir: STATE_DIR,
        instanceId: ProviderInstanceId.make("claudeAgent_win_env"),
        instance: winMixedCaseClaude,
        platform: "win32",
        path: NodePath,
      }),
    ).toBe(winMixedCaseClaude);
  });

  it("applies auto-isolation to provider instance mutations and settings patches", () => {
    const claudeId = ProviderInstanceId.make("claudeAgent_work");
    const created = withAutoIsolatedProviderInstanceMutation({
      stateDir: STATE_DIR,
      mutation: {
        operation: "create",
        instanceId: claudeId,
        instance: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
        },
      },
      path: NodePath,
    });
    expect(created.operation).toBe("create");
    if (created.operation === "create") {
      expect(created.instance.config).toEqual({
        homePath: resolveIsolatedClaudeHomePath({
          stateDir: STATE_DIR,
          instanceId: claudeId,
          path: NodePath,
        }),
      });
    }

    const removed = {
      operation: "remove" as const,
      instanceId: claudeId,
    };
    expect(
      withAutoIsolatedProviderInstanceMutation({
        stateDir: STATE_DIR,
        mutation: removed,
        path: NodePath,
      }),
    ).toBe(removed);

    const codexId = ProviderInstanceId.make("codex_team");
    const patched = withAutoIsolatedProviderInstancesPatch({
      stateDir: STATE_DIR,
      patch: {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            config: { setupMode: "existing" },
          },
        },
      },
      path: NodePath,
    });
    expect(patched.providerInstances?.[codexId]?.config).toEqual({
      setupMode: "existing",
      shadowHomePath: resolveIsolatedCodexShadowHomePath({
        stateDir: STATE_DIR,
        instanceId: codexId,
        path: NodePath,
      }),
    });
  });

  effectIt.layer(NodeServices.layer)("terminal login directory provisioning", (itLayer) => {
    itLayer.effect(
      "ensures isolated CLAUDE_CONFIG_DIR and CODEX_HOME directories exist before login PTY spawn",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmpRoot = yield* fs.makeTempDirectoryScoped({ prefix: "sail-isolated-pty-" });
          const claudeId = ProviderInstanceId.make("claudeAgent_2");
          const codexId = ProviderInstanceId.make("codex_2");
          const claudeHome = resolveIsolatedClaudeHomePath({
            stateDir: tmpRoot,
            instanceId: claudeId,
            path,
          });
          const codexShadow = resolveIsolatedCodexShadowHomePath({
            stateDir: tmpRoot,
            instanceId: codexId,
            path,
          });

          const settingsLayer = ServerSettings.layerTest({
            providerInstances: {
              [claudeId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                enabled: true,
                config: { homePath: claudeHome },
              },
              [codexId]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                config: { setupMode: "existing", shadowHomePath: codexShadow },
              },
            },
          });

          yield* Effect.gen(function* () {
            const serverSettings = yield* ServerSettings.ServerSettingsService;
            const claudeEnv = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
              deriveProviderInstanceConfigMap,
              serverSettings,
              path,
              fileSystem: fs,
              rawProviderInstanceId: claudeId,
              env: undefined,
            });
            expect(claudeEnv.CLAUDE_CONFIG_DIR).toBe(path.resolve(claudeHome));
            expect(yield* fs.exists(claudeHome)).toBe(true);

            const codexEnv = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
              deriveProviderInstanceConfigMap,
              serverSettings,
              path,
              fileSystem: fs,
              rawProviderInstanceId: codexId,
              env: undefined,
            });
            expect(codexEnv.CODEX_HOME).toBe(path.resolve(codexShadow));
            expect(yield* fs.exists(codexShadow)).toBe(true);
          }).pipe(Effect.provide(settingsLayer));
        }),
    );
  });
});

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

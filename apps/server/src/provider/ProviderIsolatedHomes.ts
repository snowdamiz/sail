// @effect-diagnostics-next-line nodeBuiltinImport:off -- deterministic isolated home paths are pure functions shared across settings handlers and auth sync.
import * as NodeCrypto from "node:crypto";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import type * as Path from "effect/Path";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER);
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getTrimmedString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

export function isolatedProviderHomeHash(instanceId: string): string {
  return NodeCrypto.createHash("sha256").update(instanceId).digest("hex");
}

export function resolveIsolatedClaudeHomePath(input: {
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly path: Pick<Path.Path, "join">;
}): string {
  return input.path.join(
    input.stateDir,
    "providers",
    "claude",
    isolatedProviderHomeHash(input.instanceId),
  );
}

export function resolveIsolatedCodexShadowHomePath(input: {
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly path: Pick<Path.Path, "join">;
}): string {
  return input.path.join(
    input.stateDir,
    "providers",
    "codex",
    isolatedProviderHomeHash(input.instanceId),
  );
}

/**
 * Assigns a deterministic isolated home path for non-default CLI accounts when no explicit path is
 * configured, preventing secondary accounts from overwriting `~/.claude` or `~/.codex`.
 */
export function withAutoIsolatedProviderHome(input: {
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly path: Pick<Path.Path, "join">;
}): ProviderInstanceConfig {
  const { instanceId, instance, stateDir, path } = input;
  const existingConfig = isRecord(instance.config) ? instance.config : {};

  if (instance.driver === CLAUDE_DRIVER) {
    if (instanceId === DEFAULT_CLAUDE_INSTANCE_ID) return instance;
    if (getTrimmedString(existingConfig, "homePath").length > 0) return instance;
    return {
      ...instance,
      config: {
        ...existingConfig,
        homePath: resolveIsolatedClaudeHomePath({ stateDir, instanceId, path }),
      },
    };
  }

  if (instance.driver === CODEX_DRIVER) {
    if (instanceId === DEFAULT_CODEX_INSTANCE_ID) return instance;
    if (existingConfig.setupMode === "managed") return instance;
    if (
      getTrimmedString(existingConfig, "homePath").length > 0 ||
      getTrimmedString(existingConfig, "shadowHomePath").length > 0
    ) {
      return instance;
    }
    return {
      ...instance,
      config: {
        ...existingConfig,
        shadowHomePath: resolveIsolatedCodexShadowHomePath({ stateDir, instanceId, path }),
      },
    };
  }

  return instance;
}

export function withAutoIsolatedProviderInstanceMutation(input: {
  readonly stateDir: string;
  readonly mutation: ProviderInstanceMutation;
  readonly path: Pick<Path.Path, "join">;
}): ProviderInstanceMutation {
  const { mutation, stateDir, path } = input;
  if (mutation.operation === "remove") return mutation;
  const nextInstance = withAutoIsolatedProviderHome({
    stateDir,
    instanceId: mutation.instanceId,
    instance: mutation.instance,
    path,
  });
  if (nextInstance === mutation.instance) return mutation;
  return {
    ...mutation,
    instance: nextInstance,
  };
}

export function withAutoIsolatedProviderInstancesPatch(input: {
  readonly stateDir: string;
  readonly patch: ServerSettingsPatch;
  readonly path: Pick<Path.Path, "join">;
}): ServerSettingsPatch {
  const { patch, stateDir, path } = input;
  if (!patch.providerInstances) return patch;

  let changed = false;
  const nextInstances: Record<string, ProviderInstanceConfig | null | undefined> = {};
  for (const [rawId, entry] of Object.entries(patch.providerInstances)) {
    if (entry === null || entry === undefined) {
      nextInstances[rawId] = entry;
      continue;
    }
    const nextEntry = withAutoIsolatedProviderHome({
      stateDir,
      instanceId: rawId as ProviderInstanceId,
      instance: entry,
      path,
    });
    if (nextEntry !== entry) changed = true;
    nextInstances[rawId] = nextEntry;
  }

  if (!changed) return patch;
  return {
    ...patch,
    providerInstances: nextInstances as NonNullable<ServerSettingsPatch["providerInstances"]>,
  };
}

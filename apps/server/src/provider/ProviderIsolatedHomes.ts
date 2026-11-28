// @effect-diagnostics-next-line nodeBuiltinImport:off -- deterministic isolated home paths are pure functions shared across settings handlers and auth sync.
import * as NodeCrypto from "node:crypto";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import type * as Path from "effect/Path";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const GROK_DRIVER = ProviderDriverKind.make("grok");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const PI_DRIVER = ProviderDriverKind.make("pi");
const MUSE_DRIVER = ProviderDriverKind.make("muse");

const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER);
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);

const ENV_ISOLATED_DRIVERS: ReadonlyMap<
  ProviderDriverKind,
  { readonly envVar: string; readonly subdir: string }
> = new Map([
  [GROK_DRIVER, { envVar: "GROK_HOME", subdir: "grok" }],
  [OPENCODE_DRIVER, { envVar: "XDG_DATA_HOME", subdir: "opencode" }],
  [PI_DRIVER, { envVar: "PI_CODING_AGENT_DIR", subdir: "pi" }],
  [MUSE_DRIVER, { envVar: "XDG_DATA_HOME", subdir: "muse" }],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getTrimmedString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

function hasConfiguredEnvVar(
  environment: ProviderInstanceEnvironment | undefined,
  envVar: string,
  platform?: NodeJS.Platform,
): boolean {
  if (!environment || environment.length === 0) return false;
  const isWindows = platform === "win32";
  const target = isWindows ? envVar.toUpperCase() : envVar;
  return environment.some((entry) => {
    const entryName = isWindows ? entry.name.trim().toUpperCase() : entry.name.trim();
    if (entryName !== target) return false;
    if (typeof entry.value === "string") return entry.value.trim().length > 0;
    return true;
  });
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

export function resolveIsolatedEnvProviderHomePath(input: {
  readonly stateDir: string;
  readonly subdir: string;
  readonly instanceId: ProviderInstanceId;
  readonly path: Pick<Path.Path, "join">;
}): string {
  return input.path.join(
    input.stateDir,
    "providers",
    input.subdir,
    isolatedProviderHomeHash(input.instanceId),
  );
}

/**
 * Assigns a deterministic isolated home path or environment directory for newly created
 * non-default CLI accounts when no explicit path/env override is configured, preventing secondary
 * accounts from colliding with the primary account's credentials while never mutating already-saved
 * instances during rename/edit operations.
 */
export function withAutoIsolatedProviderHome(input: {
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly existingInstance?: ProviderInstanceConfig | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly path: Pick<Path.Path, "join">;
}): ProviderInstanceConfig {
  const { instanceId, instance, existingInstance, platform, stateDir, path } = input;
  // Never change the home directory of an already-persisted instance on rename/edit.
  if (existingInstance !== undefined) return instance;

  const existingConfig = isRecord(instance.config) ? instance.config : {};

  if (instance.driver === CLAUDE_DRIVER) {
    if (instanceId === DEFAULT_CLAUDE_INSTANCE_ID) return instance;
    if (getTrimmedString(existingConfig, "homePath").length > 0) return instance;
    if (hasConfiguredEnvVar(instance.environment, "CLAUDE_CONFIG_DIR", platform)) return instance;
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
      getTrimmedString(existingConfig, "shadowHomePath").length > 0 ||
      hasConfiguredEnvVar(instance.environment, "CODEX_HOME", platform)
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

  const envIsolation = ENV_ISOLATED_DRIVERS.get(instance.driver);
  if (envIsolation !== undefined) {
    if (instanceId === defaultInstanceIdForDriver(instance.driver)) return instance;
    if (hasConfiguredEnvVar(instance.environment, envIsolation.envVar, platform)) return instance;
    const isolatedDir = resolveIsolatedEnvProviderHomePath({
      stateDir,
      subdir: envIsolation.subdir,
      instanceId,
      path,
    });
    return {
      ...instance,
      environment: [
        ...(instance.environment ?? []),
        {
          name: envIsolation.envVar,
          value: isolatedDir,
          sensitive: false,
        },
      ],
    };
  }

  return instance;
}

export function withAutoIsolatedProviderInstanceMutation(input: {
  readonly stateDir: string;
  readonly mutation: ProviderInstanceMutation;
  readonly existingInstances?: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly path: Pick<Path.Path, "join">;
}): ProviderInstanceMutation {
  const { mutation, existingInstances, platform, stateDir, path } = input;
  if (mutation.operation === "remove") return mutation;
  const nextInstance = withAutoIsolatedProviderHome({
    stateDir,
    instanceId: mutation.instanceId,
    instance: mutation.instance,
    existingInstance:
      mutation.operation === "create" ? undefined : existingInstances?.[mutation.instanceId],
    platform,
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
  readonly existingInstances?: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly path: Pick<Path.Path, "join">;
}): ServerSettingsPatch {
  const { patch, existingInstances, platform, stateDir, path } = input;
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
      existingInstance: existingInstances?.[rawId],
      platform,
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

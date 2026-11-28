import * as NodeUtil from "node:util";
import {
  defaultInstanceIdForDriver,
  isSecretReference,
  type ProviderAuthExportBundleInput,
  type ProviderAuthExportBundleResult,
  type ProviderAuthImportBundleInput,
  type ProviderAuthImportBundleResult,
  type ProviderAuthSyncBundle,
  ProviderAuthSyncError,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type SecretReference,
  type ServerSettings,
  type SyncedAntigravityProfileFile,
  type SyncedAntigravityProfileFileName,
  type SyncedCliAuthEntry,
  type SyncedProviderEnvVar,
  type SyncedProviderInstance,
  type SyncedProviderStoreBlob,
  type SyncedProviderStoreDriver,
} from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import { resolveAntigravityInstanceDirectories } from "./antigravityAuthSupport.ts";
import { claudeAccountConfigPath } from "./claudeResetCredits.ts";
import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import {
  resolveIsolatedClaudeHomePath,
  resolveIsolatedCodexShadowHomePath,
} from "./ProviderIsolatedHomes.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const MAX_AUTH_FILE_BYTES = 512 * 1024;
const KEYCHAIN_TIMEOUT = "3 seconds" as const;

const HOST_ONLY_CONFIG_FIELDS = new Set([
  "binaryPath",
  "homePath",
  "shadowHomePath",
  "commandPath",
]);

const SECRET_CONFIG_FIELDS_BY_DRIVER: Readonly<Record<string, ReadonlySet<string>>> = {
  antigravity: new Set(["apiKey"]),
  opencode: new Set(["serverPassword"]),
};

const ANTIGRAVITY_TOKEN_FILES: ReadonlyArray<SyncedAntigravityProfileFileName> = [
  "acp_token.json",
  "antigravity-oauth-token",
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function formatPrettyJsonLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatKeychainAddPasswordCommand(
  account: string,
  serviceName: string,
  hexPayload: string,
): string {
  return `add-generic-password -U -a ${JSON.stringify(account)} -s ${JSON.stringify(serviceName)} -X ${hexPayload}\n`;
}

function isPortableOnePasswordProvider(
  settings: ServerSettings,
  providerId: SecretReference["provider"],
): boolean {
  const entry = settings.secretProviders[providerId];
  if (entry === undefined || entry.kind !== "one_password" || !isRecord(entry.config)) {
    return false;
  }
  const token = entry.config.serviceAccountToken;
  return typeof token === "string" && token.trim().length > 0 && token.trim() !== SECRET_REDACTED;
}

function getStringField(config: unknown, field: string): string {
  if (!isRecord(config)) return "";
  const value = config[field];
  return typeof value === "string" ? value : "";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted();
    return `{${keys
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function extractClaudeExpiryMs(rawJson: string): number | undefined {
  const parsed = parseJsonObject(rawJson);
  const oauth = parsed?.claudeAiOauth;
  if (!isRecord(oauth)) return undefined;
  const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (accessToken.length === 0) return undefined;
  return typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
    ? oauth.expiresAt
    : undefined;
}

function hasValidClaudeCredentials(rawJson: string): boolean {
  const parsed = parseJsonObject(rawJson);
  if (!parsed) return false;
  const oauth = parsed.claudeAiOauth;
  if (isRecord(oauth)) {
    const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
    const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken.trim() : "";
    if (accessToken.length > 0 || refreshToken.length > 0) return true;
  }
  return false;
}

function extractCodexRefreshMs(rawJson: string): number | undefined {
  const parsed = parseJsonObject(rawJson);
  if (!parsed) return undefined;
  const lastRefresh = parsed.last_refresh;
  if (typeof lastRefresh !== "string") return undefined;
  const ms = Date.parse(lastRefresh);
  return Number.isFinite(ms) ? ms : undefined;
}

function hasValidCodexAuth(rawJson: string): boolean {
  const parsed = parseJsonObject(rawJson);
  if (!parsed) return false;
  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0) {
    return true;
  }
  if (isRecord(parsed.tokens)) {
    return Object.values(parsed.tokens).some(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
  }
  return false;
}

function extractStoreBlobFreshnessMs(
  driver: SyncedProviderStoreDriver,
  payload: string,
): number | undefined {
  const parsed = parseJsonObject(payload);
  if (!parsed) return undefined;
  if (driver === "codex-chatgpt") {
    if (Array.isArray(parsed.sessions)) {
      let best: number | undefined;
      for (const session of parsed.sessions) {
        if (
          isRecord(session) &&
          typeof session.expiresAt === "number" &&
          Number.isFinite(session.expiresAt)
        ) {
          best = best === undefined ? session.expiresAt : Math.max(best, session.expiresAt);
        }
      }
      return best;
    }
    if (typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt)) {
      return parsed.expiresAt;
    }
  }
  if (driver === "cursor") {
    if (typeof parsed.apiKeyExpiresAtMs === "number" && Number.isFinite(parsed.apiKeyExpiresAtMs)) {
      return parsed.apiKeyExpiresAtMs;
    }
    if (typeof parsed.createdAtMs === "number" && Number.isFinite(parsed.createdAtMs)) {
      return parsed.createdAtMs;
    }
  }
  return undefined;
}

function shouldKeepExistingToken(
  existingMs: number | undefined,
  incomingMs: number | undefined,
  nowMs: number,
): boolean {
  if (existingMs === undefined) return false;
  // Never protect an already-expired token over a fresh one.
  if (existingMs <= nowMs) return false;
  if (incomingMs === undefined) return true;
  return existingMs > incomingMs;
}

function isNonEmptyAuthJsonObject(raw: string): boolean {
  const parsed = parseJsonObject(raw);
  return parsed !== undefined && Object.keys(parsed).length > 0;
}

function mergeJsonKeyMaps(input: {
  readonly existingRaw: string | undefined;
  readonly incomingRaw: string;
  readonly preferExistingNewer: boolean;
}): { readonly merged: string; readonly changed: boolean } {
  const incoming = parseJsonObject(input.incomingRaw);
  if (!incoming || Object.keys(incoming).length === 0) {
    return { merged: input.existingRaw ?? "", changed: false };
  }
  const existing =
    input.existingRaw !== undefined ? (parseJsonObject(input.existingRaw) ?? {}) : {};
  const next: Record<string, unknown> = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (input.preferExistingNewer && Object.hasOwn(existing, key) && existing[key] !== undefined) {
      continue;
    }
    if (!NodeUtil.isDeepStrictEqual(existing[key], value)) {
      next[key] = value;
      changed = true;
    }
  }
  if (!changed) {
    return { merged: input.existingRaw ?? "", changed: false };
  }
  return { merged: formatPrettyJsonLine(next), changed: true };
}

function stripHostOnlyConfig(config: unknown): Record<string, unknown> | undefined {
  if (!isRecord(config)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (HOST_ONLY_CONFIG_FIELDS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isBundleEmpty(bundle: ProviderAuthSyncBundle): boolean {
  return (
    bundle.instances.length === 0 &&
    bundle.storeBlobs.length === 0 &&
    bundle.antigravityFiles.length === 0 &&
    bundle.cliAuth.length === 0
  );
}

function hasMeaningfulInstanceData(
  instance: SyncedProviderInstance,
  isDefaultInstance: boolean,
): boolean {
  if (!isDefaultInstance) return true;
  if (instance.environment !== undefined && instance.environment.length > 0) return true;
  if (instance.portableConfig !== undefined && Object.keys(instance.portableConfig).length > 0) {
    return true;
  }
  if (instance.displayName !== undefined || instance.accentColor !== undefined) return true;
  return false;
}

export class ProviderAuthSync extends Context.Service<
  ProviderAuthSync,
  {
    readonly exportBundle: (
      input?: ProviderAuthExportBundleInput,
    ) => Effect.Effect<ProviderAuthExportBundleResult, ProviderAuthSyncError>;
    readonly importBundle: (
      input: ProviderAuthImportBundleInput,
    ) => Effect.Effect<ProviderAuthImportBundleResult, ProviderAuthSyncError>;
  }
>()("t3/provider/ProviderAuthSync") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const resolverOption = yield* Effect.serviceOption(SecretResolver.SecretResolver);
  const providerRegistryOption = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const spawnerOption = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const lock = yield* Semaphore.make(1);

  const provideIo = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Digest.Digest>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Digest.Digest, digest),
    );

  const sha256Hex = (value: string) =>
    digest
      .digest(Digest.sha256, textEncoder.encode(value))
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  const readSmallTextFile = Effect.fn("ProviderAuthSync.readSmallTextFile")(function* (
    filePath: string,
  ): Effect.fn.Return<string | undefined> {
    const stat = yield* fs.stat(filePath).pipe(Effect.option);
    if (Option.isNone(stat) || stat.value.type !== "File") return undefined;
    if (Number(stat.value.size) <= 0 || Number(stat.value.size) > MAX_AUTH_FILE_BYTES) {
      return undefined;
    }
    const content = yield* fs.readFileString(filePath).pipe(Effect.option);
    return Option.getOrUndefined(content);
  });

  const writeSecretFile = Effect.fn("ProviderAuthSync.writeSecretFile")(function* (
    filePath: string,
    contents: string,
  ) {
    const platform = yield* HostProcess.Platform;
    const directory = path.dirname(filePath);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* writeFileStringAtomically({ filePath, contents });
    if (platform !== "win32") {
      yield* fs.chmod(filePath, 0o600).pipe(Effect.ignore);
    }
  });

  const claudeKeychainServiceName = Effect.fn("ProviderAuthSync.claudeKeychainServiceName")(
    function* (configDir: string) {
      const home = yield* HostProcess.HomeDirectory;
      const defaultDir = path.resolve(path.join(home, ".claude"));
      const resolved = path.resolve(configDir);
      if (resolved === defaultDir) {
        return "Claude Code-credentials";
      }
      const hash = yield* sha256Hex(resolved);
      return `Claude Code-credentials-${hash.slice(0, 8)}`;
    },
  );

  const readClaudeKeychainCredentials = Effect.fn("ProviderAuthSync.readClaudeKeychainCredentials")(
    function* (configDir: string): Effect.fn.Return<string | undefined> {
      const platform = yield* HostProcess.Platform;
      if (platform !== "darwin" || Option.isNone(spawnerOption)) {
        return undefined;
      }
      const serviceName = yield* claudeKeychainServiceName(configDir);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawnerOption.value.spawn(
            ChildProcess.make(
              "/usr/bin/security",
              ["find-generic-password", "-s", serviceName, "-w"],
              { shell: false },
            ),
          );
          const [stdout, exitCode] = yield* Effect.all(
            [
              collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_AUTH_FILE_BYTES }),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (Number(exitCode) !== 0 || stdout.truncated) return undefined;
          const trimmed = stdout.text.trim();
          return hasValidClaudeCredentials(trimmed) ? trimmed : undefined;
        }),
      ).pipe(
        Effect.timeoutOption(KEYCHAIN_TIMEOUT),
        Effect.map((maybeResult) => Option.getOrUndefined(maybeResult)),
        Effect.orElseSucceed(() => undefined),
      );
    },
  );

  const writeClaudeKeychainCredentials = Effect.fn(
    "ProviderAuthSync.writeClaudeKeychainCredentials",
  )(function* (configDir: string, credentialsJson: string): Effect.fn.Return<void> {
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin" || Option.isNone(spawnerOption)) {
      return;
    }
    const env = yield* HostProcess.Environment;
    const serviceName = yield* claudeKeychainServiceName(configDir);
    const account = (env.USER ?? "claude").replaceAll(/[^A-Za-z0-9._-]/g, "") || "claude";
    const hexPayload = Hex.encode(textEncoder.encode(credentialsJson));
    const commandLine = formatKeychainAddPasswordCommand(account, serviceName, hexPayload);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawnerOption.value.spawn(
          ChildProcess.make("/usr/bin/security", ["-i"], {
            shell: false,
            stdin: { stream: Stream.make(textEncoder.encode(commandLine)), endOnDone: true },
          }),
        );
        yield* child.exitCode;
      }),
    ).pipe(
      Effect.timeoutOption(KEYCHAIN_TIMEOUT),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not update macOS Keychain for synced Claude credentials", {
          serviceName,
          cause,
        }),
      ),
      Effect.ignore,
    );
  });

  const resolveSecretValueForExport = Effect.fn("ProviderAuthSync.resolveSecretValueForExport")(
    function* (
      settings: ServerSettings,
      reference: SecretReference,
      forceResolve: boolean,
    ): Effect.fn.Return<string | SecretReference | undefined> {
      if (!forceResolve && isPortableOnePasswordProvider(settings, reference.provider)) {
        return reference;
      }
      if (Option.isNone(resolverOption)) {
        return forceResolve ? undefined : reference;
      }
      const resolved = yield* resolverOption.value
        .read([reference])
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string | undefined> => [undefined]));
      const literal = resolved[0];
      if (typeof literal === "string" && literal.length > 0 && literal !== SECRET_REDACTED) {
        return literal;
      }
      return forceResolve ? undefined : reference;
    },
  );

  const readStoreBlob = Effect.fn("ProviderAuthSync.readStoreBlob")(function* (
    driver: SyncedProviderStoreDriver,
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<string | undefined> {
    const store = yield* ProviderCredentialStore.make(driver, instanceId).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.provideService(Digest.Digest, digest),
    );
    const raw = yield* store.get.pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isNone(raw) || raw.value.byteLength === 0) return undefined;
    const payload = textDecoder.decode(raw.value);
    return payload.trim().length > 0 ? payload : undefined;
  });

  const writeStoreBlob = Effect.fn("ProviderAuthSync.writeStoreBlob")(function* (
    driver: SyncedProviderStoreDriver,
    instanceId: ProviderInstanceId,
    payload: string,
  ) {
    const store = yield* ProviderCredentialStore.make(driver, instanceId).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.provideService(Digest.Digest, digest),
    );
    yield* store.set(textEncoder.encode(payload));
  });

  const collectInstancesForDriver = (
    settings: ServerSettings,
    driver: ProviderDriverKind,
  ): ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig | undefined;
  }> => {
    const defaultId = defaultInstanceIdForDriver(driver);
    const seen = new Set<ProviderInstanceId>();
    const result: Array<{
      readonly instanceId: ProviderInstanceId;
      readonly instance: ProviderInstanceConfig | undefined;
    }> = [];
    seen.add(defaultId);
    result.push({
      instanceId: defaultId,
      instance: settings.providerInstances[defaultId],
    });
    for (const [rawId, instance] of Object.entries(settings.providerInstances).toSorted(
      ([a], [b]) => a.localeCompare(b),
    )) {
      if (instance.driver !== driver) continue;
      const instanceId = rawId as ProviderInstanceId;
      if (seen.has(instanceId)) continue;
      seen.add(instanceId);
      result.push({ instanceId, instance });
    }
    return result;
  };

  const resolveOpenCodeAuthPath = Effect.fn("ProviderAuthSync.resolveOpenCodeAuthPath")(function* (
    env: NodeJS.ProcessEnv,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const configured = env.XDG_DATA_HOME?.trim();
    const dataHome = configured
      ? expandHomePath(configured, home)
      : path.join(home, ".local", "share");
    return path.resolve(path.join(dataHome, "opencode", "auth.json"));
  });

  const resolveGrokAuthPath = Effect.fn("ProviderAuthSync.resolveGrokAuthPath")(function* (
    env: NodeJS.ProcessEnv,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const configured = env.GROK_HOME?.trim();
    const grokHome = configured ? expandHomePath(configured, home) : path.join(home, ".grok");
    return path.resolve(path.join(grokHome, "auth.json"));
  });

  const resolvePiAuthPath = Effect.fn("ProviderAuthSync.resolvePiAuthPath")(function* (
    env: NodeJS.ProcessEnv,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const configured = env.PI_CODING_AGENT_DIR?.trim();
    const piDir = configured ? expandHomePath(configured, home) : path.join(home, ".pi", "agent");
    return path.resolve(path.join(piDir, "auth.json"));
  });

  const envVarMatchKey = (name: string, isWindows: boolean): string =>
    isWindows ? name.trim().toUpperCase() : name.trim();

  const hasInstanceEnvironmentVar = (
    instance: ProviderInstanceConfig | undefined,
    name: string,
    isWindows: boolean,
  ): boolean => {
    const target = envVarMatchKey(name, isWindows);
    return (
      instance?.environment?.some(
        (entry) =>
          envVarMatchKey(entry.name, isWindows) === target &&
          (typeof entry.value !== "string" || entry.value.trim().length > 0),
      ) === true
    );
  };

  const resolveInstanceEnvironmentForAuth = Effect.fn(
    "ProviderAuthSync.resolveInstanceEnvironmentForAuth",
  )(function* (
    environment: ProviderInstanceConfig["environment"],
    baseEnv: NodeJS.ProcessEnv,
  ): Effect.fn.Return<{
    readonly env: NodeJS.ProcessEnv;
    readonly unresolvedKeys: ReadonlySet<string>;
  }> {
    const isWindows = (yield* HostProcess.Platform) === "win32";
    const unresolvedKeys = new Set<string>();
    if (!environment || environment.length === 0) {
      return {
        env: yield* mergeProviderInstanceEnvironment(environment, baseEnv),
        unresolvedKeys,
      };
    }
    const references: Array<SecretReference> = [];
    const referenceIndexes: Array<number> = [];
    for (let index = 0; index < environment.length; index += 1) {
      const entry = environment[index];
      if (entry !== undefined && isSecretReference(entry.value)) {
        references.push(entry.value);
        referenceIndexes.push(index);
      }
    }
    const resolvedByIndex = new Map<number, string | undefined>();
    if (references.length > 0 && Option.isSome(resolverOption)) {
      const resolvedValues = yield* resolverOption.value
        .read(references)
        .pipe(
          Effect.orElseSucceed((): ReadonlyArray<string | undefined> =>
            references.map(() => undefined),
          ),
        );
      for (let index = 0; index < referenceIndexes.length; index += 1) {
        resolvedByIndex.set(referenceIndexes[index]!, resolvedValues[index]);
      }
    }
    const resolvedEnvironment = environment.map((entry, index) => {
      const key = envVarMatchKey(entry.name, isWindows);
      if (isSecretReference(entry.value)) {
        const literal = resolvedByIndex.get(index);
        if (typeof literal === "string" && literal.length > 0 && literal !== SECRET_REDACTED) {
          unresolvedKeys.delete(key);
          return { ...entry, value: literal };
        }
        unresolvedKeys.add(key);
        return entry;
      }
      if (typeof entry.value === "string" && entry.value.trim().length > 0) {
        unresolvedKeys.delete(key);
      }
      return entry;
    });
    const merged = { ...(yield* mergeProviderInstanceEnvironment(resolvedEnvironment, baseEnv)) };
    if (unresolvedKeys.size > 0) {
      for (const existingKey of Object.keys(merged)) {
        if (unresolvedKeys.has(envVarMatchKey(existingKey, isWindows))) {
          delete merged[existingKey];
        }
      }
    }
    return { env: merged, unresolvedKeys };
  });

  const resolveClaudePathsForInstance = Effect.fn("ProviderAuthSync.resolveClaudePathsForInstance")(
    function* (
      instanceId: ProviderInstanceId,
      instance: ProviderInstanceConfig | undefined,
      createIsolatedIfNonDefault: boolean,
    ) {
      const env = yield* HostProcess.Environment;
      const isWindows = (yield* HostProcess.Platform) === "win32";
      const { env: instanceEnv, unresolvedKeys } = yield* resolveInstanceEnvironmentForAuth(
        instance?.environment,
        env,
      );
      const configuredHome = getStringField(instance?.config, "homePath").trim();
      const hasExplicitEnvHome = hasInstanceEnvironmentVar(
        instance,
        "CLAUDE_CONFIG_DIR",
        isWindows,
      );
      const explicitEnvHome = hasExplicitEnvHome
        ? (instanceEnv.CLAUDE_CONFIG_DIR?.trim() ?? "")
        : "";
      if (
        !configuredHome &&
        (unresolvedKeys.has(envVarMatchKey("CLAUDE_CONFIG_DIR", isWindows)) ||
          (hasExplicitEnvHome && explicitEnvHome.length === 0))
      ) {
        return undefined;
      }
      const isDefault =
        instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
      let effectiveHomePath = configuredHome;
      const shouldIsolate =
        !configuredHome && !hasExplicitEnvHome && !isDefault && createIsolatedIfNonDefault;
      if (shouldIsolate) {
        effectiveHomePath = resolveIsolatedClaudeHomePath({
          stateDir: serverConfig.stateDir,
          instanceId,
          path,
        });
      }
      const configDir = yield* resolveClaudeHomePath({ homePath: effectiveHomePath }, instanceEnv);
      const accountPath = yield* claudeAccountConfigPath(
        effectiveHomePath.length > 0
          ? configDir
          : instanceEnv.CLAUDE_CONFIG_DIR?.trim() || undefined,
      );
      return {
        configDir,
        credentialsPath: path.join(configDir, ".credentials.json"),
        accountPath,
        isolatedHomePath: shouldIsolate ? effectiveHomePath : undefined,
      };
    },
  );

  const resolveCodexAuthPathForInstance = Effect.fn(
    "ProviderAuthSync.resolveCodexAuthPathForInstance",
  )(function* (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig | undefined,
    createIsolatedIfNonDefault: boolean,
  ) {
    const env = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const isWindows = (yield* HostProcess.Platform) === "win32";
    const { env: instanceEnv, unresolvedKeys } = yield* resolveInstanceEnvironmentForAuth(
      instance?.environment,
      env,
    );
    const configuredHome = getStringField(instance?.config, "homePath").trim();
    const configuredShadow = getStringField(instance?.config, "shadowHomePath").trim();
    const hasExplicitEnvHome = hasInstanceEnvironmentVar(instance, "CODEX_HOME", isWindows);
    const explicitEnvHome = hasExplicitEnvHome ? (instanceEnv.CODEX_HOME?.trim() ?? "") : "";
    const isDefault = instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
    if (!configuredHome && !configuredShadow && hasExplicitEnvHome) {
      if (
        unresolvedKeys.has(envVarMatchKey("CODEX_HOME", isWindows)) ||
        explicitEnvHome.length === 0
      ) {
        return undefined;
      }
      return {
        authPath: path.join(path.resolve(expandHomePath(explicitEnvHome, home)), "auth.json"),
        isolatedShadowHomePath: undefined,
      };
    }
    if (!configuredHome && !configuredShadow && !isDefault && createIsolatedIfNonDefault) {
      const isolatedShadow = resolveIsolatedCodexShadowHomePath({
        stateDir: serverConfig.stateDir,
        instanceId,
        path,
      });
      return {
        authPath: path.join(isolatedShadow, "auth.json"),
        isolatedShadowHomePath: isolatedShadow,
      };
    }
    const layout = yield* resolveCodexHomeLayout({
      enabled: instance?.enabled ?? true,
      binaryPath: "",
      homePath: configuredHome,
      shadowHomePath: configuredShadow,
      launchArgs: "",
      customModels: [],
    });
    const dir = layout.effectiveHomePath ?? layout.sharedHomePath;
    return {
      authPath: path.join(dir, "auth.json"),
      isolatedShadowHomePath: undefined,
    };
  });

  const exportBundle: ProviderAuthSync["Service"]["exportBundle"] = Effect.fn(
    "ProviderAuthSync.exportBundle",
  )(function* (rawInput) {
    const forceResolve = rawInput?.resolveSecretReferences === true;
    const env = yield* HostProcess.Environment;

    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAuthSyncError({
            reason: "export_failed",
            detail: "Could not read server settings for provider auth export.",
            cause,
          }),
      ),
    );

    const instances: Array<SyncedProviderInstance> = [];
    for (const [rawId, instance] of Object.entries(settings.providerInstances).toSorted(
      ([a], [b]) => a.localeCompare(b),
    )) {
      const instanceId = rawId as ProviderInstanceId;
      // Local ACP binaries only exist on the host that configured them.
      if (
        instance.driver === "acpRegistry" &&
        isRecord(instance.config) &&
        instance.config.source === "local"
      ) {
        continue;
      }

      const rawPortableConfig = stripHostOnlyConfig(instance.config);
      let portableConfig: Record<string, unknown> | undefined;
      if (rawPortableConfig !== undefined) {
        const secretFields = SECRET_CONFIG_FIELDS_BY_DRIVER[instance.driver];
        const nextConfig: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(rawPortableConfig)) {
          if (secretFields?.has(field)) {
            if (isSecretReference(value)) {
              const resolved = yield* resolveSecretValueForExport(settings, value, forceResolve);
              if (resolved !== undefined) {
                nextConfig[field] = resolved;
              }
            } else if (typeof value === "string" && value.length > 0 && value !== SECRET_REDACTED) {
              nextConfig[field] = value;
            }
            continue;
          }
          nextConfig[field] = value;
        }
        if (Object.keys(nextConfig).length > 0) {
          portableConfig = nextConfig;
        }
      }

      const exportedEnv: Array<SyncedProviderEnvVar> = [];
      for (const variable of instance.environment ?? []) {
        if (isSecretReference(variable.value)) {
          const resolved = yield* resolveSecretValueForExport(
            settings,
            variable.value,
            forceResolve,
          );
          if (resolved !== undefined) {
            exportedEnv.push({
              name: variable.name,
              value: resolved,
              sensitive: variable.sensitive,
            });
          }
        } else if (
          typeof variable.value === "string" &&
          variable.value.length > 0 &&
          variable.value !== SECRET_REDACTED &&
          variable.valueRedacted !== true
        ) {
          exportedEnv.push({
            name: variable.name,
            value: variable.value,
            sensitive: variable.sensitive,
          });
        }
      }
      exportedEnv.sort((left, right) => left.name.localeCompare(right.name));

      const syncedInstance: SyncedProviderInstance = {
        instanceId,
        driver: instance.driver,
        ...(instance.displayName !== undefined ? { displayName: instance.displayName } : {}),
        ...(instance.accentColor !== undefined ? { accentColor: instance.accentColor } : {}),
        ...(instance.enabled !== undefined ? { enabled: instance.enabled } : {}),
        ...(portableConfig !== undefined ? { portableConfig } : {}),
        ...(exportedEnv.length > 0 ? { environment: exportedEnv } : {}),
      };
      const isDefault = instanceId === defaultInstanceIdForDriver(instance.driver);
      if (hasMeaningfulInstanceData(syncedInstance, isDefault)) {
        instances.push(syncedInstance);
      }
    }

    // Sail-owned ProviderCredentialStore blobs (Managed Codex ChatGPT + Cursor).
    const storeBlobs: Array<SyncedProviderStoreBlob> = [];
    for (const { instanceId } of collectInstancesForDriver(
      settings,
      ProviderDriverKind.make("codex"),
    )) {
      for (const storeDriver of ["codex-chatgpt", "codex-chatgpt-registration"] as const) {
        const payload = yield* readStoreBlob(storeDriver, instanceId);
        if (payload !== undefined) {
          storeBlobs.push({ driver: storeDriver, instanceId, payload });
        }
      }
    }
    for (const { instanceId } of collectInstancesForDriver(
      settings,
      ProviderDriverKind.make("cursor"),
    )) {
      const payload = yield* readStoreBlob("cursor", instanceId);
      if (payload !== undefined) {
        storeBlobs.push({ driver: "cursor", instanceId, payload });
      }
    }
    storeBlobs.sort((left, right) =>
      `${left.driver}\0${left.instanceId}`.localeCompare(`${right.driver}\0${right.instanceId}`),
    );

    // Antigravity isolated GEMINI_HOME auth files.
    const antigravityFiles: Array<SyncedAntigravityProfileFile> = [];
    for (const { instanceId } of collectInstancesForDriver(
      settings,
      ProviderDriverKind.make("antigravity"),
    )) {
      const directories = yield* resolveAntigravityInstanceDirectories(
        serverConfig.stateDir,
        instanceId,
      );
      const acpDir = path.join(directories.profile, "antigravity-acp");
      for (const fileName of ANTIGRAVITY_TOKEN_FILES) {
        const content = yield* readSmallTextFile(path.join(acpDir, fileName));
        if (content !== undefined && content.trim().length > 0) {
          antigravityFiles.push({ instanceId, fileName, content });
        }
      }
    }
    antigravityFiles.sort((left, right) =>
      `${left.instanceId}\0${left.fileName}`.localeCompare(
        `${right.instanceId}\0${right.fileName}`,
      ),
    );

    // Vendor CLI auth files (Claude, Codex, OpenCode, Grok, Pi).
    const cliAuth: Array<SyncedCliAuthEntry> = [];

    const isWindows = (yield* HostProcess.Platform) === "win32";
    const seenClaudeDirs = new Set<string>();
    for (const { instanceId, instance } of collectInstancesForDriver(
      settings,
      ProviderDriverKind.make("claudeAgent"),
    )) {
      const paths = yield* resolveClaudePathsForInstance(instanceId, instance, false);
      if (paths === undefined) continue;
      if (seenClaudeDirs.has(paths.configDir)) continue;
      seenClaudeDirs.add(paths.configDir);

      let credentialsJson = yield* readSmallTextFile(paths.credentialsPath);
      if (!credentialsJson || !hasValidClaudeCredentials(credentialsJson)) {
        credentialsJson = yield* readClaudeKeychainCredentials(paths.configDir);
      }
      if (!credentialsJson || !hasValidClaudeCredentials(credentialsJson)) continue;

      const accountRaw = yield* readSmallTextFile(paths.accountPath);
      const accountObj = accountRaw ? parseJsonObject(accountRaw) : undefined;
      const oauthAccount = isRecord(accountObj?.oauthAccount) ? accountObj.oauthAccount : undefined;
      cliAuth.push({
        kind: "claude",
        instanceId,
        credentialsJson,
        ...(oauthAccount !== undefined ? { oauthAccount } : {}),
      });
    }

    const seenCodexPaths = new Set<string>();
    for (const { instanceId, instance } of collectInstancesForDriver(
      settings,
      ProviderDriverKind.make("codex"),
    )) {
      const codexPaths = yield* resolveCodexAuthPathForInstance(instanceId, instance, false);
      if (codexPaths === undefined) continue;
      const { authPath } = codexPaths;
      if (seenCodexPaths.has(authPath)) continue;
      seenCodexPaths.add(authPath);
      const authJson = yield* readSmallTextFile(authPath);
      if (authJson !== undefined && hasValidCodexAuth(authJson)) {
        cliAuth.push({ kind: "codex", instanceId, authJson });
      }
    }

    const seenOpenCodePaths = new Set<string>();
    for (const { instanceId, instance } of collectInstancesForDriver(
      settings,
      ProviderDriverKind.make("opencode"),
    )) {
      const { env: instanceEnv, unresolvedKeys } = yield* resolveInstanceEnvironmentForAuth(
        instance?.environment,
        env,
      );
      if (
        unresolvedKeys.has(envVarMatchKey("XDG_DATA_HOME", isWindows)) ||
        (hasInstanceEnvironmentVar(instance, "XDG_DATA_HOME", isWindows) &&
          !instanceEnv.XDG_DATA_HOME?.trim())
      ) {
        continue;
      }
      const authPath = yield* resolveOpenCodeAuthPath(instanceEnv);
      if (seenOpenCodePaths.has(authPath)) continue;
      seenOpenCodePaths.add(authPath);
      const authJson = yield* readSmallTextFile(authPath);
      if (authJson !== undefined && isNonEmptyAuthJsonObject(authJson)) {
        cliAuth.push({ kind: "opencode", instanceId, authJson });
      }
    }

    const seenGrokPaths = new Set<string>();
    for (const { instanceId, instance } of collectInstancesForDriver(
      settings,
      ProviderDriverKind.make("grok"),
    )) {
      const { env: instanceEnv, unresolvedKeys } = yield* resolveInstanceEnvironmentForAuth(
        instance?.environment,
        env,
      );
      if (
        unresolvedKeys.has(envVarMatchKey("GROK_HOME", isWindows)) ||
        (hasInstanceEnvironmentVar(instance, "GROK_HOME", isWindows) &&
          !instanceEnv.GROK_HOME?.trim())
      ) {
        continue;
      }
      const authPath = yield* resolveGrokAuthPath(instanceEnv);
      if (seenGrokPaths.has(authPath)) continue;
      seenGrokPaths.add(authPath);
      const authJson = yield* readSmallTextFile(authPath);
      if (authJson !== undefined && isNonEmptyAuthJsonObject(authJson)) {
        cliAuth.push({ kind: "grok", instanceId, authJson });
      }
    }

    const seenPiPaths = new Set<string>();
    for (const { instanceId, instance } of collectInstancesForDriver(
      settings,
      ProviderDriverKind.make("pi"),
    )) {
      const { env: instanceEnv, unresolvedKeys } = yield* resolveInstanceEnvironmentForAuth(
        instance?.environment,
        env,
      );
      if (
        unresolvedKeys.has(envVarMatchKey("PI_CODING_AGENT_DIR", isWindows)) ||
        (hasInstanceEnvironmentVar(instance, "PI_CODING_AGENT_DIR", isWindows) &&
          !instanceEnv.PI_CODING_AGENT_DIR?.trim())
      ) {
        continue;
      }
      const authPath = yield* resolvePiAuthPath(instanceEnv);
      if (seenPiPaths.has(authPath)) continue;
      seenPiPaths.add(authPath);
      const authJson = yield* readSmallTextFile(authPath);
      if (authJson !== undefined && isNonEmptyAuthJsonObject(authJson)) {
        cliAuth.push({ kind: "pi", instanceId, authJson });
      }
    }

    cliAuth.sort((left, right) =>
      `${left.kind}\0${left.instanceId}`.localeCompare(`${right.kind}\0${right.instanceId}`),
    );

    const bundle: ProviderAuthSyncBundle = {
      version: 1,
      instances,
      storeBlobs,
      antigravityFiles,
      cliAuth,
    };

    const fingerprint = isBundleEmpty(bundle) ? "" : yield* sha256Hex(canonicalJson(bundle));
    return { bundle, fingerprint } satisfies ProviderAuthExportBundleResult;
  }, provideIo);

  const importBundle: ProviderAuthSync["Service"]["importBundle"] = Effect.fn(
    "ProviderAuthSync.importBundle",
  )(
    function* (input: ProviderAuthImportBundleInput) {
      const preferExistingNewer = input.preferExistingNewer === true;
      const nowMs = yield* Clock.currentTimeMillis;
      const env = yield* HostProcess.Environment;
      const isWindows = (yield* HostProcess.Platform) === "win32";

      const currentSettings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAuthSyncError({
              reason: "import_failed",
              detail: "Could not read target settings for provider auth import.",
              cause,
            }),
        ),
      );

      let changed = false;
      let importedInstances = 0;
      let importedCredentials = 0;

      // 1. Merge portable provider instances, config secrets, and environment variables.
      const nextInstances: Record<string, ProviderInstanceConfig> = {
        ...currentSettings.providerInstances,
      };
      let settingsChanged = false;

      for (const incoming of input.bundle.instances) {
        const existing = Object.hasOwn(nextInstances, incoming.instanceId)
          ? nextInstances[incoming.instanceId]
          : undefined;
        if (existing !== undefined && existing.driver !== incoming.driver) {
          continue;
        }
        if (
          incoming.driver === "acpRegistry" &&
          isRecord(incoming.portableConfig) &&
          incoming.portableConfig.source === "local"
        ) {
          continue;
        }

        const existingConfig = isRecord(existing?.config) ? { ...existing.config } : {};
        const secretFields = SECRET_CONFIG_FIELDS_BY_DRIVER[incoming.driver];
        if (incoming.portableConfig !== undefined) {
          for (const [field, value] of Object.entries(incoming.portableConfig)) {
            if (HOST_ONLY_CONFIG_FIELDS.has(field) || value === undefined) continue;
            if (secretFields?.has(field)) {
              if (value === "" || value === SECRET_REDACTED) continue;
              const existingVal = existingConfig[field];
              const existingHasSecret =
                isSecretReference(existingVal) ||
                (typeof existingVal === "string" &&
                  existingVal.length > 0 &&
                  existingVal !== SECRET_REDACTED);
              if (preferExistingNewer && existingHasSecret) continue;
            }
            existingConfig[field] = value;
          }
        }

        const existingEnvList = existing?.environment ?? [];
        const envByName = new Map(
          existingEnvList.map((entry) => [envVarMatchKey(entry.name, isWindows), entry] as const),
        );
        for (const incomingVar of incoming.environment ?? []) {
          if (
            typeof incomingVar.value === "string" &&
            (incomingVar.value.length === 0 || incomingVar.value === SECRET_REDACTED)
          ) {
            continue;
          }
          const matchKey = envVarMatchKey(incomingVar.name, isWindows);
          const currentVar = envByName.get(matchKey);
          const currentHasValue =
            currentVar !== undefined &&
            (isSecretReference(currentVar.value) ||
              (typeof currentVar.value === "string" &&
                currentVar.value.length > 0 &&
                currentVar.value !== SECRET_REDACTED));
          if (preferExistingNewer && currentHasValue) {
            continue;
          }
          envByName.set(matchKey, {
            name: incomingVar.name,
            value: incomingVar.value,
            sensitive: incomingVar.sensitive,
          });
        }
        const mergedEnvironment = Array.from(envByName.values());

        const merged: ProviderInstanceConfig = {
          ...existing,
          driver: incoming.driver,
          ...(incoming.displayName !== undefined
            ? { displayName: incoming.displayName }
            : existing?.displayName !== undefined
              ? { displayName: existing.displayName }
              : {}),
          ...(incoming.accentColor !== undefined
            ? { accentColor: incoming.accentColor }
            : existing?.accentColor !== undefined
              ? { accentColor: existing.accentColor }
              : {}),
          ...(incoming.enabled !== undefined
            ? { enabled: incoming.enabled }
            : existing?.enabled !== undefined
              ? { enabled: existing.enabled }
              : {}),
          ...(Object.keys(existingConfig).length > 0 ? { config: existingConfig } : {}),
          ...(mergedEnvironment.length > 0 ? { environment: mergedEnvironment } : {}),
        };

        if (!NodeUtil.isDeepStrictEqual(existing, merged)) {
          nextInstances[incoming.instanceId] = merged;
          settingsChanged = true;
          importedInstances += 1;
        }
      }

      // 2. Import Sail-owned ProviderCredentialStore blobs (Managed Codex ChatGPT + Cursor).
      for (const blob of input.bundle.storeBlobs) {
        if (blob.payload.trim().length === 0) continue;
        const existing = yield* readStoreBlob(blob.driver, blob.instanceId);
        if (existing === blob.payload) continue;
        if (preferExistingNewer && existing !== undefined) {
          const existingMs = extractStoreBlobFreshnessMs(blob.driver, existing);
          const incomingMs = extractStoreBlobFreshnessMs(blob.driver, blob.payload);
          if (shouldKeepExistingToken(existingMs, incomingMs, nowMs)) {
            continue;
          }
        }
        yield* writeStoreBlob(blob.driver, blob.instanceId, blob.payload).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAuthSyncError({
                reason: "import_failed",
                detail: `Could not store synced ${blob.driver} credentials.`,
                cause,
              }),
          ),
        );
        changed = true;
        importedCredentials += 1;
      }

      // 3. Import Antigravity isolated GEMINI_HOME auth files.
      for (const file of input.bundle.antigravityFiles) {
        if (file.content.trim().length === 0) continue;
        const directories = yield* resolveAntigravityInstanceDirectories(
          serverConfig.stateDir,
          file.instanceId,
        );
        const targetPath = path.join(directories.profile, "antigravity-acp", file.fileName);
        const existing = yield* readSmallTextFile(targetPath);
        if (existing === file.content) continue;
        if (preferExistingNewer && existing !== undefined && existing.trim().length > 0) {
          continue;
        }
        yield* writeSecretFile(targetPath, file.content).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAuthSyncError({
                reason: "import_failed",
                detail: `Could not write synced Antigravity ${file.fileName}.`,
                cause,
              }),
          ),
        );
        changed = true;
        importedCredentials += 1;
      }

      // 4. Import vendor CLI auth files (Claude, Codex, OpenCode, Grok, Pi).
      for (const entry of input.bundle.cliAuth) {
        if (entry.kind === "claude") {
          if (!hasValidClaudeCredentials(entry.credentialsJson)) continue;
          const instance = nextInstances[entry.instanceId];
          const paths = yield* resolveClaudePathsForInstance(entry.instanceId, instance, true);
          if (paths === undefined) continue;
          let existingCreds = yield* readSmallTextFile(paths.credentialsPath);
          if (!existingCreds || !hasValidClaudeCredentials(existingCreds)) {
            existingCreds = yield* readClaudeKeychainCredentials(paths.configDir);
          }
          const skipCredsWrite =
            existingCreds === entry.credentialsJson ||
            (preferExistingNewer &&
              existingCreds !== undefined &&
              shouldKeepExistingToken(
                extractClaudeExpiryMs(existingCreds),
                extractClaudeExpiryMs(entry.credentialsJson),
                nowMs,
              ));

          if (!skipCredsWrite) {
            yield* writeSecretFile(paths.credentialsPath, entry.credentialsJson).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAuthSyncError({
                    reason: "import_failed",
                    detail: "Could not write synced Claude credentials.",
                    cause,
                  }),
              ),
            );
            yield* writeClaudeKeychainCredentials(paths.configDir, entry.credentialsJson);
            changed = true;
            importedCredentials += 1;
          }

          if (entry.oauthAccount !== undefined && !skipCredsWrite) {
            const existingAccountRaw = yield* readSmallTextFile(paths.accountPath);
            const existingAccountObj =
              existingAccountRaw !== undefined ? (parseJsonObject(existingAccountRaw) ?? {}) : {};
            const nextAccountObj: Record<string, unknown> = {
              ...existingAccountObj,
              oauthAccount: entry.oauthAccount,
              ...(existingAccountObj.hasCompletedOnboarding === undefined
                ? { hasCompletedOnboarding: true }
                : {}),
            };
            if (!NodeUtil.isDeepStrictEqual(existingAccountObj, nextAccountObj)) {
              yield* writeSecretFile(paths.accountPath, formatPrettyJsonLine(nextAccountObj)).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAuthSyncError({
                      reason: "import_failed",
                      detail: "Could not update Claude account config.",
                      cause,
                    }),
                ),
              );
              changed = true;
            }
          }

          if (paths.isolatedHomePath !== undefined) {
            const currentInstance = nextInstances[entry.instanceId];
            if (currentInstance !== undefined) {
              const currentCfg = isRecord(currentInstance.config) ? currentInstance.config : {};
              if (getStringField(currentCfg, "homePath").trim().length === 0) {
                nextInstances[entry.instanceId] = {
                  ...currentInstance,
                  config: { ...currentCfg, homePath: paths.isolatedHomePath },
                };
                settingsChanged = true;
              }
            }
          }
          continue;
        }

        if (entry.kind === "codex") {
          if (!hasValidCodexAuth(entry.authJson)) continue;
          const instance = nextInstances[entry.instanceId];
          const codexPaths = yield* resolveCodexAuthPathForInstance(
            entry.instanceId,
            instance,
            true,
          );
          if (codexPaths === undefined) continue;
          const { authPath, isolatedShadowHomePath } = codexPaths;
          const existing = yield* readSmallTextFile(authPath);
          if (existing !== entry.authJson) {
            const keepExisting =
              preferExistingNewer &&
              existing !== undefined &&
              hasValidCodexAuth(existing) &&
              (() => {
                const existingRefresh = extractCodexRefreshMs(existing);
                const incomingRefresh = extractCodexRefreshMs(entry.authJson);
                if (existingRefresh === undefined) return false;
                if (incomingRefresh === undefined) return true;
                return existingRefresh > incomingRefresh;
              })();
            if (!keepExisting) {
              yield* writeSecretFile(authPath, entry.authJson).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAuthSyncError({
                      reason: "import_failed",
                      detail: "Could not write synced Codex credentials.",
                      cause,
                    }),
                ),
              );
              changed = true;
              importedCredentials += 1;
            }
          }
          if (isolatedShadowHomePath !== undefined) {
            const currentInstance = nextInstances[entry.instanceId];
            if (currentInstance !== undefined) {
              const currentCfg = isRecord(currentInstance.config) ? currentInstance.config : {};
              if (getStringField(currentCfg, "shadowHomePath").trim().length === 0) {
                nextInstances[entry.instanceId] = {
                  ...currentInstance,
                  config: { ...currentCfg, shadowHomePath: isolatedShadowHomePath },
                };
                settingsChanged = true;
              }
            }
          }
          continue;
        }

        if (entry.kind === "opencode" || entry.kind === "grok" || entry.kind === "pi") {
          const instance = nextInstances[entry.instanceId];
          const { env: instanceEnv, unresolvedKeys } = yield* resolveInstanceEnvironmentForAuth(
            instance?.environment,
            env,
          );
          const envVarName =
            entry.kind === "opencode"
              ? "XDG_DATA_HOME"
              : entry.kind === "grok"
                ? "GROK_HOME"
                : "PI_CODING_AGENT_DIR";
          if (
            unresolvedKeys.has(envVarMatchKey(envVarName, isWindows)) ||
            (hasInstanceEnvironmentVar(instance, envVarName, isWindows) &&
              !instanceEnv[envVarName]?.trim())
          ) {
            continue;
          }
          const authPath =
            entry.kind === "opencode"
              ? yield* resolveOpenCodeAuthPath(instanceEnv)
              : entry.kind === "grok"
                ? yield* resolveGrokAuthPath(instanceEnv)
                : yield* resolvePiAuthPath(instanceEnv);
          const existingRaw = yield* readSmallTextFile(authPath);
          const { merged, changed: fileChanged } = mergeJsonKeyMaps({
            existingRaw,
            incomingRaw: entry.authJson,
            preferExistingNewer,
          });
          if (fileChanged) {
            yield* writeSecretFile(authPath, merged).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAuthSyncError({
                    reason: "import_failed",
                    detail: `Could not write synced ${entry.kind} credentials.`,
                    cause,
                  }),
              ),
            );
            changed = true;
            importedCredentials += 1;
          }
        }
      }

      if (settingsChanged) {
        yield* settingsService
          .updateSettings({
            providerInstances: nextInstances as ServerSettings["providerInstances"],
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAuthSyncError({
                  reason: "import_failed",
                  detail: "Could not persist synced provider instances.",
                  cause,
                }),
            ),
          );
        changed = true;
      }

      if (changed && Option.isSome(providerRegistryOption)) {
        yield* providerRegistryOption.value
          .reloadSecretsAndRefresh()
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      }

      return {
        changed,
        importedInstances,
        importedCredentials,
      } satisfies ProviderAuthImportBundleResult;
    },
    lock.withPermits(1),
    provideIo,
  );

  return ProviderAuthSync.of({
    exportBundle,
    importBundle,
  });
});

export const layer = Layer.effect(ProviderAuthSync, make);

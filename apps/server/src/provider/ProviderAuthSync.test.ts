import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  type ServerSettings,
} from "@t3tools/contracts";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveAntigravityInstanceDirectories } from "./antigravityAuthSupport.ts";
import * as ProviderAuthSync from "./ProviderAuthSync.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import {
  resolveIsolatedClaudeHomePath,
  resolveIsolatedCodexShadowHomePath,
} from "./ProviderIsolatedHomes.ts";

const ONE_PASSWORD_KIND = SecretProviderKind.make("one_password");
const PORTABLE_VAULT_ID = SecretProviderId.make("portable-1p");
const LOCAL_VAULT_ID = SecretProviderId.make("local-1p");

function makeMemorySecretStore() {
  const data = new Map<string, Uint8Array>();
  const layer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      directory: "/tmp/test-secrets",
      get: (key) => Effect.sync(() => Option.fromNullishOr(data.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          data.set(key, new Uint8Array(value));
        }),
      create: (key, value) =>
        Effect.sync(() => {
          if (data.has(key)) return false;
          data.set(key, new Uint8Array(value));
          return true;
        }),
      getOrCreateRandom: (key, bytes) =>
        Effect.sync(() => {
          const existing = data.get(key);
          if (existing) return existing;
          const next = new Uint8Array(bytes);
          data.set(key, next);
          return next;
        }),
      remove: (key) =>
        Effect.sync(() => {
          data.delete(key);
        }),
    }),
  );
  return { data, layer };
}

function makeServerNode(options: {
  readonly homeDir: string;
  readonly stateDir: string;
  readonly platform?: NodeJS.Platform;
  readonly settingsOverrides?: Partial<ServerSettings>;
  readonly resolvedSecrets?: ReadonlyMap<string, string>;
}) {
  const secretStore = makeMemorySecretStore();
  const hostLayer = Layer.mergeAll(
    Layer.succeed(HostProcess.HomeDirectory, options.homeDir),
    Layer.succeed(HostProcess.Platform, options.platform ?? ("linux" as NodeJS.Platform)),
    Layer.succeed(HostProcess.Environment, {}),
  );
  const configLayer = ServerConfig.ServerConfig.layerTest(options.stateDir, options.stateDir);
  const settingsLayer = ServerSettingsService.layerTest(options.settingsOverrides ?? {});

  const secretDriver = defineSecretProviderDriver({
    kind: ONE_PASSWORD_KIND,
    definition: defineSecretProvider({
      kind: ONE_PASSWORD_KIND,
      label: "1Password",
      configSchema: Schema.Struct({
        serviceAccountToken: Schema.optionalKey(Schema.String),
        account: Schema.optionalKey(Schema.String),
      }),
      isReference: (ref) => ref.startsWith("op://"),
      referencePlaceholder: "op://vault/item/field",
      invalidReferenceMessage: "Use op:// reference.",
    }),
    read: (_config, references) =>
      Effect.sync(() => references.map((ref) => options.resolvedSecrets?.get(ref))),
  });

  const resolverLayer = SecretResolver.layer({
    drivers: [secretDriver],
    secretProviders: Effect.succeed(options.settingsOverrides?.secretProviders ?? {}),
  });

  const baseLayer = Layer.mergeAll(
    secretStore.layer,
    configLayer,
    settingsLayer,
    resolverLayer,
    hostLayer,
  ).pipe(Layer.provideMerge(Layer.merge(NodeCrypto.layer, NodeServices.layer)));

  const fullLayer = ProviderAuthSync.layer.pipe(Layer.provideMerge(baseLayer));

  return { fullLayer, secretStore };
}

describe("ProviderAuthSync", () => {
  it.effect(
    "exports and imports all provider credential types while preserving host paths and resolving Boat secret references",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const nowMs = yield* Clock.currentTimeMillis;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "sail-provider-sync-" });
          const srcHome = path.join(root, "src-home");
          const srcState = path.join(root, "src-state");
          const dstHome = path.join(root, "dst-home");
          const dstState = path.join(root, "dst-state");

          const claudeId = ProviderInstanceId.make("claudeAgent");
          const codexId = ProviderInstanceId.make("codex");
          const cursorId = ProviderInstanceId.make("cursor");
          const antigravityId = ProviderInstanceId.make("antigravity");
          const localAcpId = ProviderInstanceId.make("local-acp-1");

          const resolvedSecrets = new Map<string, string>([
            ["op://Dev/Anthropic/key", "sk-ant-resolved-123"],
            ["op://Dev/LocalOnly/key", "sk-local-only-456"],
          ]);

          const srcNode = makeServerNode({
            homeDir: srcHome,
            stateDir: srcState,
            resolvedSecrets,
            settingsOverrides: {
              secretProviders: {
                [PORTABLE_VAULT_ID]: {
                  kind: ONE_PASSWORD_KIND,
                  label: "1Password SA",
                  config: { serviceAccountToken: "ops_service_account_token" },
                },
                [LOCAL_VAULT_ID]: {
                  kind: ONE_PASSWORD_KIND,
                  label: "1Password Desktop",
                  config: { account: "my.1password.com" },
                },
              },
              providerInstances: {
                [claudeId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { binaryPath: "/opt/homebrew/bin/claude", homePath: "" },
                  environment: [
                    {
                      name: "ANTHROPIC_API_KEY",
                      value: {
                        provider: PORTABLE_VAULT_ID,
                        reference: "op://Dev/Anthropic/key",
                      },
                      sensitive: true,
                    },
                    {
                      name: "EXTRA_KEY",
                      value: {
                        provider: LOCAL_VAULT_ID,
                        reference: "op://Dev/LocalOnly/key",
                      },
                      sensitive: true,
                    },
                  ],
                },
                [antigravityId]: {
                  driver: ProviderDriverKind.make("antigravity"),
                  config: {
                    authMethod: "gemini-api-key",
                    apiKey: "gemini-secret-key",
                    binaryPath: "/usr/local/bin/agy",
                  },
                },
                [localAcpId]: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  config: {
                    source: "local",
                    commandPath: "/Users/me/custom-agent",
                  },
                },
              },
            },
          });

          const dstNode = makeServerNode({
            homeDir: dstHome,
            stateDir: dstState,
            settingsOverrides: {
              providerInstances: {
                [claudeId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { binaryPath: "/usr/bin/claude" },
                },
              },
            },
          });

          // Populate source credentials across all storage mechanisms.
          const claudeCreds = JSON.stringify({
            claudeAiOauth: {
              accessToken: "claude-access-1",
              refreshToken: "claude-refresh-1",
              expiresAt: nowMs + 3_600_000,
            },
          });
          yield* fs.makeDirectory(path.join(srcHome, ".claude"), { recursive: true });
          yield* fs.writeFileString(
            path.join(srcHome, ".claude", ".credentials.json"),
            claudeCreds,
          );
          yield* fs.writeFileString(
            path.join(srcHome, ".claude.json"),
            JSON.stringify({
              oauthAccount: { emailAddress: "dev@example.com", organizationUuid: "org-1" },
            }),
          );

          const codexAuth = JSON.stringify({
            tokens: { access_token: "codex-access-1", refresh_token: "codex-refresh-1" },
            last_refresh: "2026-11-27T12:00:00.000Z",
          });
          yield* fs.makeDirectory(path.join(srcHome, ".codex"), { recursive: true });
          yield* fs.writeFileString(path.join(srcHome, ".codex", "auth.json"), codexAuth);

          yield* fs.makeDirectory(path.join(srcHome, ".local", "share", "opencode"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(srcHome, ".local", "share", "opencode", "auth.json"),
            JSON.stringify({ "opencode-go": { type: "api", key: "oc-key-1" } }),
          );

          yield* fs.makeDirectory(path.join(srcHome, ".grok"), { recursive: true });
          yield* fs.writeFileString(
            path.join(srcHome, ".grok", "auth.json"),
            JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "grok-key-1" } }),
          );

          yield* fs.makeDirectory(path.join(srcHome, ".pi", "agent"), { recursive: true });
          yield* fs.writeFileString(
            path.join(srcHome, ".pi", "agent", "auth.json"),
            JSON.stringify({ openai: { type: "api_key", key: "pi-key-1" } }),
          );

          // Pre-seed target OpenCode with an existing provider to verify key-level merge.
          yield* fs.makeDirectory(path.join(dstHome, ".local", "share", "opencode"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(dstHome, ".local", "share", "opencode", "auth.json"),
            JSON.stringify({ existing: { type: "api", key: "keep-me" } }),
          );

          // Export from source (including store blobs and Antigravity token files).
          const { desktopExport, boatExport } = yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            const codexStore = yield* ProviderCredentialStore.make("codex-chatgpt", codexId);
            yield* codexStore.set(
              new TextEncoder().encode(
                JSON.stringify({
                  activeClientId: "oaiapp_1",
                  sessions: [
                    {
                      clientId: "oaiapp_1",
                      accessToken: "chatgpt-token-1",
                      refreshToken: "chatgpt-refresh-1",
                      expiresAt: nowMs + 3_600_000,
                      earliestRefreshAt: null,
                      scopes: ["chatgpt.tokens.use.direct"],
                      subject: "sub-1",
                      email: "dev@example.com",
                    },
                  ],
                }),
              ),
            );
            const cursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
            yield* cursorStore.set(
              new TextEncoder().encode(
                JSON.stringify({
                  version: 1,
                  backendUrl: "https://api2.cursor.sh",
                  apiKey: "cursor-key-1",
                  createdAtMs: nowMs,
                }),
              ),
            );
            const agyDirs = yield* resolveAntigravityInstanceDirectories(
              (yield* ServerConfig.ServerConfig).stateDir,
              antigravityId,
            );
            const agyAcpDir = path.join(agyDirs.profile, "antigravity-acp");
            yield* fs.makeDirectory(agyAcpDir, { recursive: true });
            yield* fs.writeFileString(
              path.join(agyAcpDir, "antigravity-oauth-token"),
              JSON.stringify({ token: { access_token: "agy-access-1" } }),
            );

            const desktopExport = yield* sync.exportBundle({ resolveSecretReferences: false });
            const boatExport = yield* sync.exportBundle({ resolveSecretReferences: true });
            return { desktopExport, boatExport };
          }).pipe(Effect.provide(srcNode.fullLayer));

          assert.isAbove(desktopExport.fingerprint.length, 0);
          // Local ACP instance must never be exported.
          assert.isFalse(
            desktopExport.bundle.instances.some((entry) => entry.instanceId === localAcpId),
          );
          // Portable 1P reference stays a reference for Desktop<->Web, while local 1P resolves to literal.
          const desktopClaude = desktopExport.bundle.instances.find(
            (entry) => entry.instanceId === claudeId,
          );
          assert.deepStrictEqual(
            desktopClaude?.environment?.find((env) => env.name === "ANTHROPIC_API_KEY")?.value,
            { provider: PORTABLE_VAULT_ID, reference: "op://Dev/Anthropic/key" },
          );
          assert.strictEqual(
            desktopClaude?.environment?.find((env) => env.name === "EXTRA_KEY")?.value,
            "sk-local-only-456",
          );
          // Boat export resolves ALL references to literal strings.
          const boatClaude = boatExport.bundle.instances.find(
            (entry) => entry.instanceId === claudeId,
          );
          assert.strictEqual(
            boatClaude?.environment?.find((env) => env.name === "ANTHROPIC_API_KEY")?.value,
            "sk-ant-resolved-123",
          );

          // Import boat bundle into destination server.
          yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            const settings = yield* ServerSettingsService;

            const firstImport = yield* sync.importBundle({ bundle: boatExport.bundle });
            assert.isTrue(firstImport.changed);
            assert.isAbove(firstImport.importedCredentials, 0);

            // Second identical import is an idempotent no-op.
            const secondImport = yield* sync.importBundle({ bundle: boatExport.bundle });
            assert.isFalse(secondImport.changed);

            // Destination keeps its own Linux binaryPath while receiving synced env vars & Antigravity key.
            const nextSettings = yield* settings.getSettings;
            assert.strictEqual(
              (nextSettings.providerInstances[claudeId]?.config as { binaryPath?: string })
                ?.binaryPath,
              "/usr/bin/claude",
            );
            assert.strictEqual(
              nextSettings.providerInstances[claudeId]?.environment?.find(
                (env) => env.name === "ANTHROPIC_API_KEY",
              )?.value,
              "sk-ant-resolved-123",
            );
            assert.strictEqual(
              (nextSettings.providerInstances[antigravityId]?.config as { apiKey?: string })
                ?.apiKey,
              "gemini-secret-key",
            );

            // Store blobs landed in destination ServerSecretStore.
            const dstCodexStore = yield* ProviderCredentialStore.make("codex-chatgpt", codexId);
            assert.isTrue(Option.isSome(yield* dstCodexStore.get));
            const dstCursorStore = yield* ProviderCredentialStore.make("cursor", cursorId);
            assert.isTrue(Option.isSome(yield* dstCursorStore.get));

            // Antigravity token file landed in destination stateDir.
            const dstAgyDirs = yield* resolveAntigravityInstanceDirectories(
              (yield* ServerConfig.ServerConfig).stateDir,
              antigravityId,
            );
            const agyToken = yield* fs.readFileString(
              path.join(dstAgyDirs.profile, "antigravity-acp", "antigravity-oauth-token"),
            );
            assert.include(agyToken, "agy-access-1");

            // CLI auth files landed cleanly.
            assert.strictEqual(
              yield* fs.readFileString(path.join(dstHome, ".claude", ".credentials.json")),
              claudeCreds,
            );
            const dstClaudeJson = JSON.parse(
              yield* fs.readFileString(path.join(dstHome, ".claude.json")),
            ) as { oauthAccount?: { emailAddress?: string }; hasCompletedOnboarding?: boolean };
            assert.strictEqual(dstClaudeJson.oauthAccount?.emailAddress, "dev@example.com");
            assert.isTrue(dstClaudeJson.hasCompletedOnboarding);

            assert.strictEqual(
              yield* fs.readFileString(path.join(dstHome, ".codex", "auth.json")),
              codexAuth,
            );

            // OpenCode auth.json preserved existing target keys while adding synced keys.
            const dstOpenCode = JSON.parse(
              yield* fs.readFileString(
                path.join(dstHome, ".local", "share", "opencode", "auth.json"),
              ),
            ) as Record<string, unknown>;
            assert.isDefined(dstOpenCode.existing);
            assert.isDefined(dstOpenCode["opencode-go"]);

            assert.include(
              yield* fs.readFileString(path.join(dstHome, ".grok", "auth.json")),
              "grok-key-1",
            );
            assert.include(
              yield* fs.readFileString(path.join(dstHome, ".pi", "agent", "auth.json")),
              "pi-key-1",
            );
          }).pipe(Effect.provide(dstNode.fullLayer));
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
      ),
  );

  it.effect(
    "preserves strictly newer unexpired tokens when preferExistingNewer is true and overwrites when false",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const nowMs = yield* Clock.currentTimeMillis;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "sail-provider-freshness-" });
          const dstHome = path.join(root, "dst-home");
          const dstState = path.join(root, "dst-state");

          const claudeId = ProviderInstanceId.make("claudeAgent");
          const newerCreds = JSON.stringify({
            claudeAiOauth: {
              accessToken: "newer-access",
              refreshToken: "newer-refresh",
              expiresAt: nowMs + 7_200_000,
            },
          });
          const olderCreds = JSON.stringify({
            claudeAiOauth: {
              accessToken: "older-access",
              refreshToken: "older-refresh",
              expiresAt: nowMs + 1_800_000,
            },
          });

          yield* fs.makeDirectory(path.join(dstHome, ".claude"), { recursive: true });
          yield* fs.writeFileString(path.join(dstHome, ".claude", ".credentials.json"), newerCreds);

          const dstNode = makeServerNode({ homeDir: dstHome, stateDir: dstState });

          yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            const bundle = {
              version: 1 as const,
              instances: [],
              storeBlobs: [],
              antigravityFiles: [],
              cliAuth: [
                {
                  kind: "claude" as const,
                  instanceId: claudeId,
                  credentialsJson: olderCreds,
                },
              ],
            };

            const reconcile = yield* sync.importBundle({ bundle, preferExistingNewer: true });
            assert.isFalse(reconcile.changed);
            assert.strictEqual(
              yield* fs.readFileString(path.join(dstHome, ".claude", ".credentials.json")),
              newerCreds,
            );

            const livePush = yield* sync.importBundle({ bundle, preferExistingNewer: false });
            assert.isTrue(livePush.changed);
            assert.strictEqual(
              yield* fs.readFileString(path.join(dstHome, ".claude", ".credentials.json")),
              olderCreds,
            );
          }).pipe(Effect.provide(dstNode.fullLayer));
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
      ),
  );

  it.effect(
    "exports and imports secondary Claude, Codex, OpenCode, Grok, and Pi accounts in isolated directories",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const nowMs = yield* Clock.currentTimeMillis;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "sail-multi-account-sync-" });
          const srcHome = path.join(root, "src-home");
          const srcState = path.join(root, "src-state");
          const dstHome = path.join(root, "dst-home");
          const dstState = path.join(root, "dst-state");

          const claudeWorkId = ProviderInstanceId.make("claudeAgent_work");
          const codexWorkId = ProviderInstanceId.make("codex_work");
          const opencodeWorkId = ProviderInstanceId.make("opencode_work");
          const grokWorkId = ProviderInstanceId.make("grok_work");
          const piWorkId = ProviderInstanceId.make("pi_work");

          const srcClaudeWorkHome = resolveIsolatedClaudeHomePath({
            stateDir: srcState,
            instanceId: claudeWorkId,
            path,
          });
          const srcCodexWorkShadow = resolveIsolatedCodexShadowHomePath({
            stateDir: srcState,
            instanceId: codexWorkId,
            path,
          });

          const srcNode = makeServerNode({
            homeDir: srcHome,
            stateDir: srcState,
            settingsOverrides: {
              providerInstances: {
                [claudeWorkId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  displayName: "Claude Work",
                  enabled: true,
                  config: { homePath: srcClaudeWorkHome },
                },
                [codexWorkId]: {
                  driver: ProviderDriverKind.make("codex"),
                  displayName: "Codex Work",
                  enabled: true,
                  config: { setupMode: "existing", shadowHomePath: srcCodexWorkShadow },
                },
                [opencodeWorkId]: {
                  driver: ProviderDriverKind.make("opencode"),
                  displayName: "OpenCode Work",
                  enabled: true,
                  environment: [
                    { name: "XDG_DATA_HOME", value: "~/opencode-work-data", sensitive: false },
                  ],
                },
                [grokWorkId]: {
                  driver: ProviderDriverKind.make("grok"),
                  displayName: "Grok Work",
                  enabled: true,
                  environment: [{ name: "GROK_HOME", value: "~/grok-work-home", sensitive: false }],
                },
                [piWorkId]: {
                  driver: ProviderDriverKind.make("pi"),
                  displayName: "Pi Work",
                  enabled: true,
                  environment: [
                    { name: "PI_CODING_AGENT_DIR", value: "~/pi-work-agent", sensitive: false },
                  ],
                },
              },
            },
          });

          const dstNode = makeServerNode({ homeDir: dstHome, stateDir: dstState });

          // Seed default + secondary credentials on source.
          const defaultClaudeCreds = JSON.stringify({
            claudeAiOauth: {
              accessToken: "claude-default",
              refreshToken: "claude-default-r",
              expiresAt: nowMs + 3_600_000,
            },
          });
          const workClaudeCreds = JSON.stringify({
            claudeAiOauth: {
              accessToken: "claude-work",
              refreshToken: "claude-work-r",
              expiresAt: nowMs + 3_600_000,
            },
          });
          yield* fs.makeDirectory(path.join(srcHome, ".claude"), { recursive: true });
          yield* fs.writeFileString(
            path.join(srcHome, ".claude", ".credentials.json"),
            defaultClaudeCreds,
          );
          yield* fs.makeDirectory(srcClaudeWorkHome, { recursive: true });
          yield* fs.writeFileString(
            path.join(srcClaudeWorkHome, ".credentials.json"),
            workClaudeCreds,
          );

          const defaultCodexAuth = JSON.stringify({
            tokens: { access_token: "codex-default" },
            last_refresh: "2026-11-27T12:00:00.000Z",
          });
          const workCodexAuth = JSON.stringify({
            tokens: { access_token: "codex-work" },
            last_refresh: "2026-11-27T12:05:00.000Z",
          });
          yield* fs.makeDirectory(path.join(srcHome, ".codex"), { recursive: true });
          yield* fs.writeFileString(path.join(srcHome, ".codex", "auth.json"), defaultCodexAuth);
          yield* fs.makeDirectory(srcCodexWorkShadow, { recursive: true });
          yield* fs.writeFileString(path.join(srcCodexWorkShadow, "auth.json"), workCodexAuth);

          yield* fs.makeDirectory(path.join(srcHome, ".local", "share", "opencode"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(srcHome, ".local", "share", "opencode", "auth.json"),
            JSON.stringify({ defaultKey: { type: "api", key: "oc-default" } }),
          );
          yield* fs.makeDirectory(path.join(srcHome, "opencode-work-data", "opencode"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(srcHome, "opencode-work-data", "opencode", "auth.json"),
            JSON.stringify({ workKey: { type: "api", key: "oc-work" } }),
          );

          yield* fs.makeDirectory(path.join(srcHome, ".grok"), { recursive: true });
          yield* fs.writeFileString(
            path.join(srcHome, ".grok", "auth.json"),
            JSON.stringify({ default: { key: "grok-default" } }),
          );
          yield* fs.makeDirectory(path.join(srcHome, "grok-work-home"), { recursive: true });
          yield* fs.writeFileString(
            path.join(srcHome, "grok-work-home", "auth.json"),
            JSON.stringify({ work: { key: "grok-work" } }),
          );

          yield* fs.makeDirectory(path.join(srcHome, ".pi", "agent"), { recursive: true });
          yield* fs.writeFileString(
            path.join(srcHome, ".pi", "agent", "auth.json"),
            JSON.stringify({ default: { type: "api_key", key: "pi-default" } }),
          );
          yield* fs.makeDirectory(path.join(srcHome, "pi-work-agent"), { recursive: true });
          yield* fs.writeFileString(
            path.join(srcHome, "pi-work-agent", "auth.json"),
            JSON.stringify({ work: { type: "api_key", key: "pi-work" } }),
          );

          const exported = yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            return yield* sync.exportBundle({ resolveSecretReferences: true });
          }).pipe(Effect.provide(srcNode.fullLayer));

          assert.isTrue(
            exported.bundle.cliAuth.some(
              (entry) => entry.kind === "opencode" && entry.instanceId === opencodeWorkId,
            ),
          );
          assert.isTrue(
            exported.bundle.cliAuth.some(
              (entry) => entry.kind === "grok" && entry.instanceId === grokWorkId,
            ),
          );
          assert.isTrue(
            exported.bundle.cliAuth.some(
              (entry) => entry.kind === "pi" && entry.instanceId === piWorkId,
            ),
          );

          yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            const settings = yield* ServerSettingsService;
            const dstConfig = yield* ServerConfig.ServerConfig;

            const imported = yield* sync.importBundle({ bundle: exported.bundle });
            assert.isTrue(imported.changed);

            const nextSettings = yield* settings.getSettings;
            const expectedDstClaudeWorkHome = resolveIsolatedClaudeHomePath({
              stateDir: dstConfig.stateDir,
              instanceId: claudeWorkId,
              path,
            });
            const expectedDstCodexWorkShadow = resolveIsolatedCodexShadowHomePath({
              stateDir: dstConfig.stateDir,
              instanceId: codexWorkId,
              path,
            });

            assert.strictEqual(
              (nextSettings.providerInstances[claudeWorkId]?.config as { homePath?: string })
                ?.homePath,
              expectedDstClaudeWorkHome,
            );
            assert.strictEqual(
              (nextSettings.providerInstances[codexWorkId]?.config as { shadowHomePath?: string })
                ?.shadowHomePath,
              expectedDstCodexWorkShadow,
            );

            assert.strictEqual(
              yield* fs.readFileString(path.join(dstHome, ".claude", ".credentials.json")),
              defaultClaudeCreds,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(expectedDstClaudeWorkHome, ".credentials.json")),
              workClaudeCreds,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(dstHome, ".codex", "auth.json")),
              defaultCodexAuth,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(expectedDstCodexWorkShadow, "auth.json")),
              workCodexAuth,
            );

            assert.include(
              yield* fs.readFileString(
                path.join(dstHome, ".local", "share", "opencode", "auth.json"),
              ),
              "oc-default",
            );
            assert.include(
              yield* fs.readFileString(
                path.join(dstHome, "opencode-work-data", "opencode", "auth.json"),
              ),
              "oc-work",
            );
            assert.include(
              yield* fs.readFileString(path.join(dstHome, ".grok", "auth.json")),
              "grok-default",
            );
            assert.include(
              yield* fs.readFileString(path.join(dstHome, "grok-work-home", "auth.json")),
              "grok-work",
            );
            assert.include(
              yield* fs.readFileString(path.join(dstHome, ".pi", "agent", "auth.json")),
              "pi-default",
            );
            assert.include(
              yield* fs.readFileString(path.join(dstHome, "pi-work-agent", "auth.json")),
              "pi-work",
            );
          }).pipe(Effect.provide(dstNode.fullLayer));
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
      ),
  );

  it.effect(
    "preserves explicit CLAUDE_CONFIG_DIR and CODEX_HOME environment overrides without injecting homePath or shadowHomePath on import",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const nowMs = yield* Clock.currentTimeMillis;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "sail-env-auth-sync-" });
          const dstHome = path.join(root, "dst-home");
          const dstState = path.join(root, "dst-state");
          const customClaudeDir = path.join(dstHome, "custom-claude-env");
          const customCodexDir = path.join(dstHome, "custom-codex-env");

          const claudeEnvId = ProviderInstanceId.make("claudeAgent_env");
          const codexEnvId = ProviderInstanceId.make("codex_env");

          const dstNode = makeServerNode({
            homeDir: dstHome,
            stateDir: dstState,
            settingsOverrides: {
              providerInstances: {
                [claudeEnvId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  displayName: "Claude Env",
                  enabled: true,
                  environment: [
                    { name: "CLAUDE_CONFIG_DIR", value: customClaudeDir, sensitive: false },
                  ],
                },
                [codexEnvId]: {
                  driver: ProviderDriverKind.make("codex"),
                  displayName: "Codex Env",
                  enabled: true,
                  environment: [{ name: "CODEX_HOME", value: customCodexDir, sensitive: false }],
                },
              },
            },
          });

          const claudeCreds = JSON.stringify({
            claudeAiOauth: {
              accessToken: "claude-env-token",
              refreshToken: "claude-env-refresh",
              expiresAt: nowMs + 3_600_000,
            },
          });
          const codexAuth = JSON.stringify({
            tokens: { access_token: "codex-env-token" },
            last_refresh: "2026-11-27T12:10:00.000Z",
          });

          yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            const settings = yield* ServerSettingsService;

            const result = yield* sync.importBundle({
              bundle: {
                version: 1,
                instances: [],
                storeBlobs: [],
                antigravityFiles: [],
                cliAuth: [
                  { kind: "claude", instanceId: claudeEnvId, credentialsJson: claudeCreds },
                  { kind: "codex", instanceId: codexEnvId, authJson: codexAuth },
                ],
              },
            });
            assert.isTrue(result.changed);

            const nextSettings = yield* settings.getSettings;
            assert.isUndefined(
              (nextSettings.providerInstances[claudeEnvId]?.config as { homePath?: string })
                ?.homePath,
            );
            assert.isUndefined(
              (nextSettings.providerInstances[codexEnvId]?.config as { shadowHomePath?: string })
                ?.shadowHomePath,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(customClaudeDir, ".credentials.json")),
              claudeCreds,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(customCodexDir, "auth.json")),
              codexAuth,
            );
          }).pipe(Effect.provide(dstNode.fullLayer));
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
      ),
  );

  it.effect(
    "preserves mixed-case Claude_Config_Dir and Codex_Home environment overrides on win32 during import",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const nowMs = yield* Clock.currentTimeMillis;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "sail-win-env-auth-sync-" });
          const dstHome = path.join(root, "dst-home");
          const dstState = path.join(root, "dst-state");
          const customClaudeDir = path.join(dstHome, "custom-claude-win");
          const customCodexDir = path.join(dstHome, "custom-codex-win");

          const claudeEnvId = ProviderInstanceId.make("claudeAgent_win_env");
          const codexEnvId = ProviderInstanceId.make("codex_win_env");

          const dstNode = makeServerNode({
            homeDir: dstHome,
            stateDir: dstState,
            platform: "win32",
            settingsOverrides: {
              providerInstances: {
                [claudeEnvId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  displayName: "Claude Win Env",
                  enabled: true,
                  environment: [
                    { name: "Claude_Config_Dir", value: customClaudeDir, sensitive: false },
                  ],
                },
                [codexEnvId]: {
                  driver: ProviderDriverKind.make("codex"),
                  displayName: "Codex Win Env",
                  enabled: true,
                  environment: [{ name: "Codex_Home", value: customCodexDir, sensitive: false }],
                },
              },
            },
          });

          const claudeCreds = JSON.stringify({
            claudeAiOauth: {
              accessToken: "claude-win-token",
              refreshToken: "claude-win-refresh",
              expiresAt: nowMs + 3_600_000,
            },
          });
          const codexAuth = JSON.stringify({
            tokens: { access_token: "codex-win-token" },
            last_refresh: "2026-11-27T12:15:00.000Z",
          });

          yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            const settings = yield* ServerSettingsService;

            const result = yield* sync.importBundle({
              bundle: {
                version: 1,
                instances: [],
                storeBlobs: [],
                antigravityFiles: [],
                cliAuth: [
                  { kind: "claude", instanceId: claudeEnvId, credentialsJson: claudeCreds },
                  { kind: "codex", instanceId: codexEnvId, authJson: codexAuth },
                ],
              },
            });
            assert.isTrue(result.changed);

            const nextSettings = yield* settings.getSettings;
            assert.isUndefined(
              (nextSettings.providerInstances[claudeEnvId]?.config as { homePath?: string })
                ?.homePath,
            );
            assert.isUndefined(
              (nextSettings.providerInstances[codexEnvId]?.config as { shadowHomePath?: string })
                ?.shadowHomePath,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(customClaudeDir, ".credentials.json")),
              claudeCreds,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(customCodexDir, "auth.json")),
              codexAuth,
            );
          }).pipe(Effect.provide(dstNode.fullLayer));
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
      ),
  );

  it.effect(
    "reconciles mixed-case Codex_Home vs CODEX_HOME on win32 without duplicating env vars or misrouting auth.json",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "sail-win-reconcile-sync-" });
          const dstHome = path.join(root, "dst-home");
          const dstState = path.join(root, "dst-state");
          const existingCodexDir = path.join(dstHome, "existing-codex");
          const incomingCodexDir = path.join(dstHome, "incoming-codex");
          const codexEnvId = ProviderInstanceId.make("codex_win_reconcile");

          const dstNode = makeServerNode({
            homeDir: dstHome,
            stateDir: dstState,
            platform: "win32",
            settingsOverrides: {
              providerInstances: {
                [codexEnvId]: {
                  driver: ProviderDriverKind.make("codex"),
                  displayName: "Codex Win Reconcile",
                  enabled: true,
                  environment: [{ name: "Codex_Home", value: existingCodexDir, sensitive: false }],
                },
              },
            },
          });

          const codexAuth = JSON.stringify({
            tokens: { access_token: "codex-reconcile-token" },
            last_refresh: "2026-11-27T12:20:00.000Z",
          });

          yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            const settings = yield* ServerSettingsService;

            const result = yield* sync.importBundle({
              preferExistingNewer: true,
              bundle: {
                version: 1,
                instances: [
                  {
                    instanceId: codexEnvId,
                    driver: ProviderDriverKind.make("codex"),
                    displayName: "Codex Win Reconcile",
                    enabled: true,
                    environment: [
                      { name: "CODEX_HOME", value: incomingCodexDir, sensitive: false },
                    ],
                  },
                ],
                storeBlobs: [],
                antigravityFiles: [],
                cliAuth: [{ kind: "codex", instanceId: codexEnvId, authJson: codexAuth }],
              },
            });
            assert.isTrue(result.changed);

            const nextSettings = yield* settings.getSettings;
            const instance = nextSettings.providerInstances[codexEnvId];
            assert.strictEqual(instance?.environment?.length, 1);
            assert.strictEqual(instance?.environment?.[0]?.name, "Codex_Home");
            assert.strictEqual(instance?.environment?.[0]?.value, existingCodexDir);
            assert.isUndefined(
              (instance?.config as { shadowHomePath?: string } | undefined)?.shadowHomePath,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(existingCodexDir, "auth.json")),
              codexAuth,
            );
            assert.isFalse(yield* fs.exists(path.join(incomingCodexDir, "auth.json")));
          }).pipe(Effect.provide(dstNode.fullLayer));
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
      ),
  );

  it.effect(
    "resolves secret-backed Claude_Config_Dir and Codex_Home on win32 without generating isolated homes, and skips unresolvable secret homes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const nowMs = yield* Clock.currentTimeMillis;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "sail-win-secret-home-sync-" });
          const dstHome = path.join(root, "dst-home");
          const dstState = path.join(root, "dst-state");
          const secretClaudeDir = path.join(dstHome, "secret-claude");
          const secretCodexDir = path.join(dstHome, "secret-codex");

          const claudeSecretId = ProviderInstanceId.make("claudeAgent_secret_home");
          const codexSecretId = ProviderInstanceId.make("codex_secret_home");
          const codexUnresolvedId = ProviderInstanceId.make("codex_unresolved_secret_home");

          const dstNode = makeServerNode({
            homeDir: dstHome,
            stateDir: dstState,
            platform: "win32",
            resolvedSecrets: new Map([
              ["op://vault/claude/home", secretClaudeDir],
              ["op://vault/codex/home", secretCodexDir],
            ]),
            settingsOverrides: {
              secretProviders: {
                [PORTABLE_VAULT_ID]: {
                  kind: ONE_PASSWORD_KIND,
                  label: "1Password SA",
                  config: { serviceAccountToken: "ops_token" },
                },
              },
              providerInstances: {
                [claudeSecretId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  displayName: "Claude Secret Home",
                  enabled: true,
                  environment: [
                    {
                      name: "Claude_Config_Dir",
                      value: { provider: PORTABLE_VAULT_ID, reference: "op://vault/claude/home" },
                      sensitive: true,
                    },
                  ],
                },
                [codexSecretId]: {
                  driver: ProviderDriverKind.make("codex"),
                  displayName: "Codex Secret Home",
                  enabled: true,
                  environment: [
                    {
                      name: "Codex_Home",
                      value: { provider: PORTABLE_VAULT_ID, reference: "op://vault/codex/home" },
                      sensitive: true,
                    },
                  ],
                },
                [codexUnresolvedId]: {
                  driver: ProviderDriverKind.make("codex"),
                  displayName: "Codex Unresolved Secret Home",
                  enabled: true,
                  environment: [
                    {
                      name: "Codex_Home",
                      value: { provider: PORTABLE_VAULT_ID, reference: "op://vault/codex/missing" },
                      sensitive: true,
                    },
                  ],
                },
              },
            },
          });

          const claudeCreds = JSON.stringify({
            claudeAiOauth: {
              accessToken: "claude-secret-home-token",
              refreshToken: "claude-secret-home-refresh",
              expiresAt: nowMs + 3_600_000,
            },
          });
          const codexAuth = JSON.stringify({
            tokens: { access_token: "codex-secret-home-token" },
            last_refresh: "2026-11-27T12:25:00.000Z",
          });

          yield* Effect.gen(function* () {
            const sync = yield* ProviderAuthSync.ProviderAuthSync;
            const settings = yield* ServerSettingsService;

            const result = yield* sync.importBundle({
              bundle: {
                version: 1,
                instances: [],
                storeBlobs: [],
                antigravityFiles: [],
                cliAuth: [
                  { kind: "claude", instanceId: claudeSecretId, credentialsJson: claudeCreds },
                  { kind: "codex", instanceId: codexSecretId, authJson: codexAuth },
                  { kind: "codex", instanceId: codexUnresolvedId, authJson: codexAuth },
                ],
              },
            });
            assert.isTrue(result.changed);

            const nextSettings = yield* settings.getSettings;
            assert.isUndefined(
              (nextSettings.providerInstances[claudeSecretId]?.config as { homePath?: string })
                ?.homePath,
            );
            assert.isUndefined(
              (nextSettings.providerInstances[codexSecretId]?.config as { shadowHomePath?: string })
                ?.shadowHomePath,
            );
            assert.isUndefined(
              (
                nextSettings.providerInstances[codexUnresolvedId]?.config as {
                  shadowHomePath?: string;
                }
              )?.shadowHomePath,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(secretClaudeDir, ".credentials.json")),
              claudeCreds,
            );
            assert.strictEqual(
              yield* fs.readFileString(path.join(secretCodexDir, "auth.json")),
              codexAuth,
            );
            assert.isFalse(yield* fs.exists(path.join(dstHome, ".codex", "auth.json")));
          }).pipe(Effect.provide(dstNode.fullLayer));
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
      ),
  );
});

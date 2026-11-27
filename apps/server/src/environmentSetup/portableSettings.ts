import {
  AcpRegistryAgentId,
  CustomModelSetting,
  PortableEnvironmentSettings,
  type PortableProviderInstance,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const projectSettings = Schema.decodeUnknownSync(PortableEnvironmentSettings);
const decodeInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);
const isRegistryId = Schema.is(AcpRegistryAgentId);
const decodeModels = Schema.decodeUnknownOption(Schema.Array(CustomModelSetting));

export const portableSettings = (settings: ServerSettings) => projectSettings(settings);

function configField(config: unknown, field: string): unknown {
  if (!config || typeof config !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(config, field)?.value;
}

export function hasProviderCredential(
  config: unknown,
  field: NonNullable<PortableProviderInstance["requiredCredential"]>,
) {
  const value = configField(config, field);
  return typeof value === "string" ? value.length > 0 : value !== null && value !== undefined;
}

function portableAcpConfig(config: unknown): PortableProviderInstance["acp"] {
  if (configField(config, "source") === "local") return { source: "local" };
  const agentId = configField(config, "agentId");
  return isRegistryId(agentId) ? { source: "registry", agentId } : undefined;
}

export function needsLocalProviderSetup(provider: PortableProviderInstance, config: unknown) {
  const command = configField(config, "commandPath");
  return provider.acp?.source === "local" && !(typeof command === "string" && command.length > 0);
}

export function providerIdentityConflicts(
  provider: PortableProviderInstance,
  current: ProviderInstanceConfig,
) {
  if (current.driver !== provider.driver) return true;
  const target = current.driver === "acpRegistry" ? portableAcpConfig(current.config) : undefined;
  const source = provider.acp;
  if (!target || !source) return false;
  return (
    target.source !== source.source ||
    (target.source === "registry" &&
      source.source === "registry" &&
      target.agentId !== source.agentId)
  );
}

export function portableProviders(settings: ServerSettings): readonly PortableProviderInstance[] {
  return Object.keys(settings.providerInstances)
    .sort()
    .flatMap((id) => {
      const instanceId = decodeInstanceId(id);
      const instance = settings.providerInstances[instanceId];
      if (instance === undefined) return [];
      const { driver, displayName, enabled, config } = instance;
      const accentColor = instance.accentColor;
      const acp = driver === "acpRegistry" ? portableAcpConfig(config) : undefined;
      const customModels = decodeModels(configField(config, "customModels"));
      const credential =
        driver === "antigravity" ? "apiKey" : driver === "opencode" ? "serverPassword" : undefined;
      return {
        id: instanceId,
        driver,
        ...(displayName === undefined ? {} : { displayName }),
        ...(accentColor && /^#[a-f0-9]{6}$/i.test(accentColor) ? { accentColor } : {}),
        ...(enabled === undefined || acp?.source === "local" ? {} : { enabled }),
        ...(customModels._tag === "Some" ? { customModels: customModels.value } : {}),
        ...(acp === undefined ? {} : { acp }),
        ...(credential !== undefined && hasProviderCredential(config, credential)
          ? { requiredCredential: credential }
          : {}),
        requiredEnvironment: [
          ...new Set(
            instance.environment
              ?.filter(
                ({ sensitive, value, valueRedacted }) =>
                  sensitive || typeof value !== "string" || valueRedacted,
              )
              .map(({ name }) => name),
          ),
        ].sort(),
      };
    });
}

export function mergePortableProvider(
  provider: PortableProviderInstance,
  current: ProviderInstanceConfig | undefined,
): ProviderInstanceConfig {
  const knownVariables = new Set(current?.environment?.map(({ name }) => name));
  const missingVariables = provider.requiredEnvironment
    .filter((name) => !knownVariables.has(name))
    .map((name) => ({ name, value: "", sensitive: true }));
  const config = current?.config;
  const enabled = needsLocalProviderSetup(provider, config) ? false : provider.enabled;
  return {
    ...current,
    driver: provider.driver,
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    ...(provider.accentColor === undefined ? {} : { accentColor: provider.accentColor }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(provider.customModels === undefined && provider.acp === undefined
      ? {}
      : {
          config: {
            ...(config && typeof config === "object" && !Array.isArray(config) ? config : {}),
            ...provider.acp,
            ...(provider.customModels === undefined ? {} : { customModels: provider.customModels }),
          },
        }),
    ...(missingVariables.length === 0
      ? {}
      : { environment: [...(current?.environment ?? []), ...missingVariables] }),
  };
}

import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { AcpRegistryAgentId } from "./acpRegistry.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KeybindingsConfig } from "./keybindings.ts";
import { CustomModelSetting } from "./model.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  ProviderInstanceId,
} from "./providerInstance.ts";
import { EnvironmentThemeFile, EnvironmentThemeId } from "./server.ts";
import { ServerSettings } from "./settings.ts";

export const MAX_ENVIRONMENT_SETUP_BYTES = 5_000_000;
export const MAX_ENVIRONMENT_SETUP_FILES = 500;

export const PortableEnvironmentSettings = ServerSettings.mapFields((fields) =>
  Struct.pick(fields, [
    "defaultAppearance",
    "defaultTheme",
    "favorites",
    "providerModelPreferences",
    "responseStreamingMode",
    "sidebarAutoSettleAfterDays",
    "sidebarAutoSettleKeepPullRequests",
    "sidebarAutoSettleOnMerge",
  ]),
);
export type PortableEnvironmentSettings = typeof PortableEnvironmentSettings.Type;

const ProviderCredentialField = Schema.Literals(["apiKey", "serverPassword"]);

export const PortableProviderInstance = Schema.Struct({
  id: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  accentColor: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^#[a-f0-9]{6}$/i))),
  enabled: Schema.optionalKey(Schema.Boolean),
  customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
  requiredEnvironment: Schema.Array(ProviderInstanceEnvironmentVariableName),
  requiredCredential: Schema.optionalKey(ProviderCredentialField),
  acp: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ source: Schema.Literal("local") }),
      Schema.Struct({ source: Schema.Literal("registry"), agentId: AcpRegistryAgentId }),
    ]),
  ),
});
export type PortableProviderInstance = typeof PortableProviderInstance.Type;

const skillRoots = {
  agents: [".agents", "skills"],
  antigravity: [".gemini", "antigravity-cli", "skills"],
  gemini: [".gemini", "config", "skills"],
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  cursor: [".cursor", "skills"],
  fx: [".fx", "skills"],
  grok: [".grok", "skills"],
  opencode: [".config", "opencode", "skills"],
  pi: [".pi", "agent", "skills"],
} as const;

export const EnvironmentSetupSkillRoot = Schema.Literals([
  "agents",
  "antigravity",
  "gemini",
  "claude",
  "codex",
  "cursor",
  "fx",
  "grok",
  "opencode",
  "pi",
]);
export type EnvironmentSetupSkillRoot = typeof EnvironmentSetupSkillRoot.Type;
export const environmentSetupSkillRoots: Readonly<
  Record<EnvironmentSetupSkillRoot, readonly string[]>
> = skillRoots;

const safePathSegment =
  /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$))[a-z0-9_@-](?:[a-z0-9_@. -]*[a-z0-9_@-])?$/i;
export const EnvironmentSetupSkillPath = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter((path) => {
    const segments = path.split("/");
    return (
      segments.length >= 2 &&
      segments.length <= 16 &&
      segments.every((segment) => segment.length <= 128 && safePathSegment.test(segment))
    );
  }),
);

const SkillFileFields = {
  root: EnvironmentSetupSkillRoot,
  path: EnvironmentSetupSkillPath,
  executable: Schema.optionalKey(Schema.Boolean),
};
export const EnvironmentSetupSkillFile = Schema.Union([
  Schema.Struct({
    ...SkillFileFields,
    encoding: Schema.Literal("utf8"),
    content: Schema.String.check(Schema.isMaxLength(MAX_ENVIRONMENT_SETUP_BYTES)),
  }),
  Schema.Struct({
    ...SkillFileFields,
    encoding: Schema.Literal("base64"),
    content: Schema.String.check(
      Schema.isMaxLength(MAX_ENVIRONMENT_SETUP_BYTES),
      Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    ),
  }),
]);
export type EnvironmentSetupSkillFile = typeof EnvironmentSetupSkillFile.Type;

export const EnvironmentSetupBundle = Schema.Struct({
  version: Schema.Literal(1),
  settings: PortableEnvironmentSettings,
  providers: Schema.Array(PortableProviderInstance),
  keybindings: KeybindingsConfig,
  themes: Schema.Array(Schema.Struct({ id: EnvironmentThemeId, file: EnvironmentThemeFile })),
  skills: Schema.Array(EnvironmentSetupSkillFile).check(
    Schema.isMaxLength(MAX_ENVIRONMENT_SETUP_FILES),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type EnvironmentSetupBundle = typeof EnvironmentSetupBundle.Type;

export const EnvironmentSetupImportInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("preview"), bundle: EnvironmentSetupBundle }),
  Schema.Struct({
    action: Schema.Literal("apply"),
    bundle: EnvironmentSetupBundle,
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
]);
export type EnvironmentSetupImportInput = typeof EnvironmentSetupImportInput.Type;

export const EnvironmentSetupPreview = Schema.Struct({
  revision: Schema.String,
  settings: Schema.Boolean,
  providers: Schema.Array(
    Schema.Struct({
      id: ProviderInstanceId,
      name: Schema.String,
      changed: Schema.Boolean,
      missingEnvironment: Schema.Array(ProviderInstanceEnvironmentVariableName),
      missingCredential: Schema.optionalKey(ProviderCredentialField),
      needsLocalSetup: Schema.Boolean,
    }),
  ),
  keybindings: Schema.Boolean,
  themes: Schema.Array(EnvironmentThemeId),
  skills: Schema.Array(
    Schema.Struct({
      root: EnvironmentSetupSkillRoot,
      folder: Schema.String,
    }),
  ),
});
export type EnvironmentSetupPreview = typeof EnvironmentSetupPreview.Type;

export class EnvironmentSetupError extends Schema.TaggedError<EnvironmentSetupError>()(
  "EnvironmentSetupError",
  { message: Schema.String },
) {}

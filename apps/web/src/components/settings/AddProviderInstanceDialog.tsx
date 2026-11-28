import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@t3tools/client-runtime/provider-instance-ids";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  AuthTerminalOperateScope,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  environmentSupportsLocalSessions,
  isManagedDriverAllowed,
  type AcpRegistrySearchAgent,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type SecretReference,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import type {
  ProviderClientDefinition,
  ProviderEnvironmentField,
} from "@t3tools/provider-core/client";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { CheckIcon, ChevronDownIcon, TerminalIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { m as resolveMessage, type MessageResolver } from "../../i18n/messages";
import { cn, randomUUID } from "../../lib/utils";
import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "../../onboarding/providerReadiness.logic";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { resolveOfficialAcpRegistryIconUrl } from "./AcpRegistryIcon";
import { AcpRegistrySearchStep, useAcpRegistrySearch } from "./AcpRegistrySearchStep";
import {
  ACP_REGISTRY_WIZARD_STEPS,
  ADD_PROVIDER_WIZARD_STEPS,
  LOCAL_ACP_WIZARD_STEPS,
  resolveAcpRegistryWizardNavigation,
  resolveWizardNavigation,
  updateProviderIdentityDraft,
  type ProviderIdentityDraft,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";
import { AddManagedCodexAccountDialog } from "./CodexSetupSection";
import { providerClients } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import {
  nextProviderEnvironmentWithFieldSecret,
  nextProviderEnvironmentWithFieldValue,
  ProviderEnvironmentSection,
} from "./ProviderInstanceCard";
import { deriveProviderSettingsFields, ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderSetupSection, readAntigravityAuthMethod } from "./ProviderSetupSection";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";
import { SecretSourceInput, useSecretSources, type SecretSource } from "./SecretSourceInput";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

const LazyTerminalViewport = lazy(() =>
  import("../ThreadTerminalDrawer").then((mod) => ({ default: mod.TerminalViewport })),
);

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const DEFAULT_DRIVER_OPTION = providerClients.definitions[0]!;
const DRIVER_OPTIONS = providerClients.definitions.filter(
  (option) => option.driverKind !== ACP_REGISTRY_DRIVER_KIND,
);
const FEATURED_DRIVER_OPTIONS = DRIVER_OPTIONS.filter((option) => option.featured !== false);
const MORE_DRIVER_OPTIONS = DRIVER_OPTIONS.filter((option) => option.featured === false);
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
const EMPTY_ENVIRONMENT: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [];
const WIZARD_CLI_AUTH_THREAD_ID = ThreadId.make("wizard-provider-auth");
const ADD_ACCOUNT_SIGN_IN_WIZARD_STEPS = [
  ...ADD_PROVIDER_WIZARD_STEPS,
  msg("Sign in", { $context: "wizard step" }),
] as const;

type PostCreateAuth =
  | { readonly kind: "wizard"; readonly instanceId: ProviderInstanceId }
  | {
      readonly kind: "antigravity";
      readonly instanceId: ProviderInstanceId;
      readonly config: Record<string, unknown>;
    }
  | {
      readonly kind: "cli";
      readonly instanceId: ProviderInstanceId;
      readonly driver: "claudeAgent" | "codex";
      readonly instance: ProviderInstanceConfig;
    };

function validateInstanceId(
  id: string,
  existing: ReadonlySet<string>,
  resolve: MessageResolver,
): string | null {
  if (id.length === 0) return resolve(msg("Instance ID is required."));
  if (id.length > 64) return resolve(msg("Instance ID must be 64 characters or fewer."));
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return resolve(
      msg("Instance ID must start with a letter and use only letters, digits, '-', or '_'."),
    );
  }
  if (existing.has(id)) return resolve(msg("An instance named ''{id}'' already exists.", { id }));
  return null;
}

function suggestAccountDisplayName(input: {
  readonly driver: ProviderDriverKind;
  readonly driverLabel: string;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly existingIds: ReadonlySet<string>;
}): string {
  const { driver, driverLabel, providerInstances, serverProviders, existingIds } = input;
  const driverIds = new Set<string>();
  const usedLabels = new Set<string>();

  if (driver === "codex" || driver === "claudeAgent") {
    driverIds.add(driver);
  }
  for (const [id, instance] of Object.entries(providerInstances ?? {})) {
    if (instance.driver !== driver) continue;
    driverIds.add(id);
    if (instance.displayName?.trim()) {
      usedLabels.add(instance.displayName.trim().toLowerCase());
    }
  }
  for (const provider of serverProviders) {
    if (provider.driver !== driver) continue;
    driverIds.add(provider.instanceId);
    if (provider.displayName?.trim()) {
      usedLabels.add(provider.displayName.trim().toLowerCase());
    }
  }

  let index = Math.max(2, driverIds.size + 1);
  while (
    usedLabels.has(`${driverLabel} ${index}`.toLowerCase()) ||
    existingIds.has(`${driver}_${index}`)
  ) {
    index += 1;
  }
  return `${driverLabel} ${index}`;
}

function hasEnvironmentVariable(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  name: string,
): boolean {
  return environment.some((entry) => {
    if (entry.name.trim() !== name) return false;
    return typeof entry.value === "string"
      ? entry.value.trim().length > 0
      : entry.value.reference.trim().length > 0;
  });
}

function ProviderOptionGrid({
  options,
  value,
  disabled,
  onValueChange,
  ...labelProps
}: {
  readonly options: ReadonlyArray<ProviderClientDefinition>;
  readonly value: ProviderDriverKind;
  readonly disabled: boolean;
  readonly onValueChange: (value: string) => void;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
}) {
  return (
    <RadioGroup
      {...labelProps}
      disabled={disabled}
      value={value}
      onValueChange={onValueChange}
      className="grid grid-cols-1 sm:grid-cols-2"
    >
      {options.map((option) => (
        <RadioPrimitive.Root
          key={option.driverKind}
          value={option.driverKind}
          className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
        >
          <ProviderInstanceIcon
            driverKind={option.driverKind}
            displayName={option.label}
            iconClassName="size-4"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {option.label}
          </span>
          <RadioPrimitive.Indicator
            className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
            aria-hidden
          >
            <CheckIcon className="size-3.5 shrink-0" />
          </RadioPrimitive.Indicator>
          {option.badgeLabel ? (
            <Badge variant="warning" size="sm">
              {option.badgeLabel}
            </Badge>
          ) : null}
        </RadioPrimitive.Root>
      ))}
    </RadioGroup>
  );
}

function WizardEnvironmentFieldRow({
  field,
  environment,
  environmentId,
  secretSources,
  idPrefix,
  onChange,
}: {
  readonly field: ProviderEnvironmentField;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly environmentId: EnvironmentId;
  readonly secretSources: ReadonlyArray<SecretSource>;
  readonly idPrefix: string;
  readonly onChange: (next: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const variable = environment.find((entry) => entry.name === field.name);
  const inputId = `${idPrefix}-env-${field.name}`;
  const value = variable?.value ?? "";

  return (
    <SettingsRow
      title={<label htmlFor={inputId}>{field.label}</label>}
      description={field.description}
      control={
        <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-56">
          {field.sensitive === false ? (
            <Input
              id={inputId}
              size="sm"
              className="min-w-0 flex-1"
              autoComplete="off"
              value={typeof value === "string" ? value : ""}
              onChange={(event) =>
                onChange(
                  nextProviderEnvironmentWithFieldValue(environment, field, event.target.value),
                )
              }
              placeholder={field.placeholder}
              spellCheck={false}
            />
          ) : (
            <SecretSourceInput
              id={inputId}
              size="sm"
              className="min-w-0 flex-1"
              value={value}
              onCommit={(next) =>
                onChange(nextProviderEnvironmentWithFieldValue(environment, field, next))
              }
              placeholder={field.placeholder}
              spellCheck={false}
              aria-label={field.label}
              sources={secretSources}
              environmentId={environmentId}
              onSecretChange={(secret: SecretReference | undefined) =>
                onChange(nextProviderEnvironmentWithFieldSecret(environment, field, secret))
              }
            />
          )}
        </div>
      }
    />
  );
}

function WizardAntigravityAuthenticationStep({
  environmentId,
  environmentLabel,
  instanceId,
  config,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly config: Record<string, unknown>;
  readonly onFinish: () => void;
}) {
  const gt = useGT();
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const signedIn = provider?.auth.status === "authenticated";
  const binaryPath =
    typeof config.binaryPath === "string" && config.binaryPath.trim().length > 0
      ? config.binaryPath.trim()
      : undefined;

  return (
    <>
      <WizardPanel className="min-h-72">
        <SettingsGroup variant="plain">
          {provider ? (
            <ProviderSetupSection
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              instanceId={instanceId}
              provider={provider}
              binaryPath={binaryPath}
              authMethod={readAntigravityAuthMethod(config)}
              enabled
              readOnly={false}
              onEnable={() => undefined}
            />
          ) : (
            <SettingsRow
              title={gt("Antigravity")}
              description={gt("Preparing account sign-in on {environment}…", {
                environment: environmentLabel,
              })}
            />
          )}
        </SettingsGroup>
      </WizardPanel>
      <WizardFooter>
        <Button size="sm" variant={signedIn ? "default" : "outline"} onClick={onFinish}>
          {signedIn ? gt("Done") : gt("Skip for now")}
        </Button>
      </WizardFooter>
    </>
  );
}

function WizardCliAuthTerminal({
  environmentId,
  instanceId,
  driver,
  cwd,
  command,
  keybindings,
  onCommandFinished,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: "claudeAgent" | "codex";
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
  readonly onCommandFinished: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `wizard-auth-${driver}-${randomUUID()}`);
  const threadRef = scopeThreadRef(environmentId, WIZARD_CLI_AUTH_THREAD_ID);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const commandRunning = useThreadRunningTerminalIds({
    environmentId,
    threadId: WIZARD_CLI_AUTH_THREAD_ID,
  }).includes(terminalId);
  const commandStartedRef = useRef(false);
  const handleCommandFinished = useEffectEvent(onCommandFinished);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider auth once the login CLI command exits
  useEffect(() => {
    if (commandRunning) {
      commandStartedRef.current = true;
    } else if (commandStartedRef.current) {
      commandStartedRef.current = false;
      handleCommandFinished();
    }
  }, [commandRunning]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the isolated login PTY, writes the login command, and closes it on cleanup
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    // oxlint-disable-next-line react/set-state-in-effect -- retry reopens the login terminal
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: WIZARD_CLI_AUTH_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId: instanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("writeFailed");
        return;
      }
      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: WIZARD_CLI_AUTH_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId: WIZARD_CLI_AUTH_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    instanceId,
    openTerminal,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry bumps setupAttempt to reopen the terminal.
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  return (
    <div
      data-thread-terminal-drawer
      className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal ? (
            gt("This connection cannot control terminals.")
          ) : setupState === "writeFailed" ? (
            <T>
              Run{" "}
              <code className="rounded bg-muted px-1 font-mono">
                <Var>{command}</Var>
              </code>{" "}
              in this terminal.
            </T>
          ) : setupState === "openFailed" ? (
            gt("Could not open sign-in terminal.")
          ) : setupState === "preparing" ? (
            gt("Opening sign-in terminal…")
          ) : (
            <T>Press Enter in the terminal to start sign-in.</T>
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" && canOperateTerminal ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setSetupAttempt((attempt) => attempt + 1)}
            >
              <T>Retry</T>
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            <T>Hide terminal</T>
          </Button>
        </div>
      </div>
      {terminalReady ? (
        <div className="h-56 w-full bg-background">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                <T>Loading terminal…</T>
              </div>
            }
          >
            <LazyTerminalViewport
              threadRef={threadRef}
              threadId={WIZARD_CLI_AUTH_THREAD_ID}
              terminalId={terminalId}
              terminalLabel={gt("Sign in to {agent}", { agent: driver })}
              cwd={cwd}
              providerInstanceId={instanceId}
              keybindings={keybindings}
              advancedTypography={advancedTypography}
              autoFocus
              visible
              onSessionExited={onCommandFinished}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

function WizardCliAuthenticationStep({
  environmentId,
  environmentLabel,
  instanceId,
  driver,
  instance,
  secretSources,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: "claudeAgent" | "codex";
  readonly instance: ProviderInstanceConfig;
  readonly secretSources: ReadonlyArray<SecretSource>;
  readonly onFinish: () => void;
}) {
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const canOperateTerminal =
    useEnvironmentScope(environmentId, AuthTerminalOperateScope) &&
    serverConfig !== null &&
    environmentSupportsLocalSessions(serverConfig);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState<string | SecretReference>("");
  const [savingApiKey, setSavingApiKey] = useState(false);

  const signedIn = provider?.auth.status === "authenticated";
  const authEmail = provider?.auth.email?.trim();
  const apiKeyEnvName = driver === "claudeAgent" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const apiKeyField: ProviderEnvironmentField = {
    name: apiKeyEnvName,
    label: gt("API key"),
    placeholder: driver === "claudeAgent" ? "sk-ant-…" : "sk-…",
    sensitive: true,
  };
  const hasApiKeyValue =
    typeof apiKeyValue === "string"
      ? apiKeyValue.trim().length > 0
      : apiKeyValue.reference.trim().length > 0;

  const loginCommand =
    serverConfig !== null
      ? provider && !provider.installed
        ? resolveOnboardingProviderInstallCommand(driver, serverConfig.environment.platform.os)
        : resolveOnboardingProviderLoginCommand(
            provider ?? {
              instanceId,
              driver: ProviderDriverKind.make(driver),
              enabled: true,
              installed: true,
              version: null,
              status: "warning",
              auth: { status: "unauthenticated" },
              checkedAt: "",
              models: [],
              slashCommands: [],
              skills: [],
            },
            settings,
            serverConfig.environment.platform.os,
          )
      : null;

  const saveApiKey = async () => {
    if (savingApiKey || !hasApiKeyValue) return;
    setSavingApiKey(true);
    const currentInstance = settings.providerInstances[instanceId] ?? instance;
    const nextEnvironment =
      typeof apiKeyValue === "string"
        ? nextProviderEnvironmentWithFieldValue(
            currentInstance.environment,
            apiKeyField,
            apiKeyValue,
          )
        : nextProviderEnvironmentWithFieldSecret(
            currentInstance.environment,
            apiKeyField,
            apiKeyValue,
          );
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId,
      instance: {
        ...currentInstance,
        environment: nextEnvironment,
      },
    });
    setSavingApiKey(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Could not save API key"),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
              : gt("The settings update failed."),
        });
      }
      return;
    }
    void refreshProviders({ environmentId, input: { instanceId, reloadSecrets: true } });
    toastManager.add({
      type: "success",
      title: gt("API key saved"),
      description: gt("Account ''{instanceId}'' is configured on {environment}.", {
        instanceId,
        environment: environmentLabel,
      }),
    });
    onFinish();
  };

  return (
    <>
      <WizardPanel className="min-h-72">
        <SettingsGroup variant="plain">
          {signedIn ? (
            <SettingsRow
              title={gt("Account connected")}
              description={
                authEmail
                  ? gt("Signed in as {email} on {environment}.", {
                      email: authEmail,
                      environment: environmentLabel,
                    })
                  : gt("Signed in on {environment}.", { environment: environmentLabel })
              }
              control={
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                  <CheckIcon className="size-3.5" />
                  <T context="agent status">Ready</T>
                </span>
              }
            />
          ) : null}

          {canOperateTerminal && serverConfig !== null && loginCommand !== null ? (
            <SettingsRow
              title={gt("Sign in with CLI")}
              description={gt(
                "Sign in using this account's own isolated credentials on {environment} without affecting other accounts.",
                { environment: environmentLabel },
              )}
              control={
                <Button
                  type="button"
                  size="sm"
                  variant={signedIn ? "outline" : "default"}
                  onClick={() => setTerminalOpen((open) => !open)}
                >
                  <TerminalIcon className="size-3.5" />
                  {terminalOpen ? gt("Hide terminal") : gt("Sign in via CLI")}
                </Button>
              }
            >
              {terminalOpen ? (
                <WizardCliAuthTerminal
                  environmentId={environmentId}
                  instanceId={instanceId}
                  driver={driver}
                  cwd={serverConfig.cwd}
                  command={loginCommand}
                  keybindings={serverConfig.keybindings}
                  onCommandFinished={() =>
                    void refreshProviders({ environmentId, input: { instanceId } })
                  }
                  onClose={() => {
                    setTerminalOpen(false);
                    void refreshProviders({ environmentId, input: { instanceId } });
                  }}
                />
              ) : null}
            </SettingsRow>
          ) : null}

          <SettingsRow
            title={
              <label htmlFor={`wizard-api-key-${instanceId}`}>
                {gt("Or use an API key ({envVar})", { envVar: apiKeyEnvName })}
              </label>
            }
            description={gt("Stored separately and scoped only to this account.")}
            control={
              <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-72">
                <SecretSourceInput
                  id={`wizard-api-key-${instanceId}`}
                  size="sm"
                  className="min-w-0 flex-1"
                  value={apiKeyValue}
                  onCommit={setApiKeyValue}
                  placeholder={apiKeyField.placeholder}
                  spellCheck={false}
                  aria-label={apiKeyEnvName}
                  sources={secretSources}
                  environmentId={environmentId}
                  onSecretChange={(secret) => setApiKeyValue(secret ?? "")}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={savingApiKey || !hasApiKeyValue}
                  onClick={() => void saveApiKey()}
                >
                  {savingApiKey ? gt("Saving…") : gt("Save key")}
                </Button>
              </div>
            }
          />
        </SettingsGroup>
      </WizardPanel>
      <WizardFooter>
        <Button size="sm" variant={signedIn ? "default" : "outline"} onClick={onFinish}>
          {signedIn ? gt("Done") : gt("Skip for now")}
        </Button>
      </WizardFooter>
    </>
  );
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated?: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => void;
  /** Opens with "Show more" expanded, so the ACP Registry search is in view. */
  readonly showMoreProviders?: boolean;
  /** Pre-selects a specific provider driver (for one-click "Add account"). */
  readonly initialDriver?: ProviderDriverKind;
  /** "account" tunes copy, defaults, and initial step for adding another account of a provider. */
  readonly mode?: "provider" | "account";
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
  onCreated,
  showMoreProviders: initialShowMoreProviders = false,
  initialDriver,
  mode = "provider",
}: AddProviderInstanceDialogProps) {
  const gt = useGT();
  const m = useMessages();
  const settings = useEnvironmentSettings(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const secretSources = useSecretSources(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);

  // Drivers the administrator's policy leaves out are not offered at all.
  const managedPolicy = useManagedPolicy(environmentId);
  const featuredDriverOptions = FEATURED_DRIVER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(managedPolicy, option.driverKind),
  );
  const moreDriverOptions = MORE_DRIVER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(managedPolicy, option.driverKind),
  );
  const acpRegistryAllowed = isManagedDriverAllowed(managedPolicy, ACP_REGISTRY_DRIVER_KIND);
  const resolvedInitialDriver =
    initialDriver !== undefined && isManagedDriverAllowed(managedPolicy, initialDriver)
      ? initialDriver
      : ((featuredDriverOptions[0] ?? moreDriverOptions[0])?.driverKind ??
        (acpRegistryAllowed ? ACP_REGISTRY_DRIVER_KIND : DEFAULT_DRIVER_KIND));
  const initialDriverLocks = managedInstanceLocks(managedPolicy, resolvedInitialDriver, m);
  const initialStep =
    mode === "account" &&
    initialDriver !== undefined &&
    resolvedInitialDriver !== ACP_REGISTRY_DRIVER_KIND &&
    (resolvedInitialDriver !== "codex" || Boolean(initialDriverLocks?.configKeys.has("setupMode")))
      ? 1
      : 0;

  const [wizardStep, setWizardStep] = useState(initialStep);
  const [addingChatGptAccount, setAddingChatGptAccount] = useState(false);
  const [driver, setDriver] = useState<ProviderDriverKind>(resolvedInitialDriver);
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    {},
  );
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [localEnvironment, setLocalEnvironment] = useState<
    ReadonlyArray<ProviderInstanceEnvironmentVariable>
  >([]);
  const [environmentByDriver, setEnvironmentByDriver] = useState<
    Record<string, ReadonlyArray<ProviderInstanceEnvironmentVariable>>
  >({});
  const [isManualAcpConfiguration, setIsManualAcpConfiguration] = useState(false);
  const [showMoreProviders, setShowMoreProviders] = useState(
    () =>
      initialShowMoreProviders ||
      moreDriverOptions.some((option) => option.driverKind === resolvedInitialDriver),
  );
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [postCreateAuth, setPostCreateAuth] = useState<PostCreateAuth | null>(null);

  // Reserve Codex/Claude default ids because they run before configuration, plus active providers.
  const existingIds = new Set([
    "codex",
    "claudeAgent",
    ...Object.keys(settings.providerInstances ?? {}),
    ...serverProviders.map((provider) => provider.instanceId),
  ]);

  const driverOption = providerClients.get(driver) ?? DEFAULT_DRIVER_OPTION;
  const isAcpRegistry = driver === ACP_REGISTRY_DRIVER_KIND;
  const showRegistrySearch =
    !postCreateAuth &&
    !addingChatGptAccount &&
    wizardStep === 0 &&
    !(isAcpRegistry && isManualAcpConfiguration);
  // Searches while Show more is closed, so the fold opens on results.
  const registry = useAcpRegistrySearch(environmentId, showRegistrySearch);
  const isPreparingRegistryAgent = registry.preparingId !== null;
  const isAccountMode = mode === "account";
  const defaultLabel =
    !isAcpRegistry && isAccountMode
      ? suggestAccountDisplayName({
          driver,
          driverLabel: driverOption.label,
          providerInstances: settings.providerInstances,
          serverProviders,
          existingIds,
        })
      : driverOption.label;
  const defaultIdentity: ProviderIdentityDraft = {
    label: defaultLabel,
    accentColor: "",
    instanceIdOverride: null,
  };
  const { label, accentColor, instanceIdOverride } = identityByDriver[driver] ?? defaultIdentity;
  const instanceId =
    instanceIdOverride ??
    deriveAvailableInstanceId(
      (candidateLabel) => {
        if (
          !candidateLabel.trim() ||
          candidateLabel === driverOption.label ||
          candidateLabel === defaultLabel
        ) {
          return isAcpRegistry ? `${driver}_custom` : driver;
        }
        return deriveInstanceId(driver, candidateLabel);
      },
      label,
      existingIds,
    );
  const driverSettingsFields = deriveProviderSettingsFields(driverOption, undefined, m);
  const driverEnvironmentFields = driverOption.environmentFields ?? [];
  const driverEnvironmentFieldNames = new Set(driverEnvironmentFields.map((field) => field.name));
  const driverEnvironment = environmentByDriver[driver] ?? EMPTY_ENVIRONMENT;
  const genericDriverEnvironment = driverEnvironment.filter(
    (entry) => !driverEnvironmentFieldNames.has(entry.name),
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds, m);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const identityStep = 1;
  const previewLabel = label.trim() || gt("{provider} Workspace", { provider: driverOption.label });

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const isLocalAcp = isAcpRegistry && isManualAcpConfiguration && configDraft.source === "local";
  const localCommandPath =
    typeof configDraft.commandPath === "string" ? configDraft.commandPath.trim() : "";
  const manualAgentId = typeof configDraft.agentId === "string" ? configDraft.agentId.trim() : "";
  const acpSelectionError = isLocalAcp
    ? localCommandPath.length > 0
      ? null
      : gt("Executable is required.")
    : selectedAcp !== null || (isManualAcpConfiguration && manualAgentId.length > 0)
      ? null
      : gt("Select an ACP or configure one manually.");
  const wizardStepSummaries = isAcpRegistry
    ? ([
        isLocalAcp ? gt("Local ACP command") : (selectedAcp?.name ?? (manualAgentId || null)),
        previewLabel,
        null,
      ] as const)
    : postCreateAuth !== null
      ? ([
          driverOption.label,
          settings.providerInstances[postCreateAuth.instanceId]?.displayName?.trim() ||
            previewLabel,
          null,
          null,
        ] as const)
      : ([driverOption.label, previewLabel, null] as const);

  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[driver];
      } else {
        next[driver] = config;
      }
      return next;
    });
  };
  const setDriverEnvironment = (
    nextEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => {
    setEnvironmentByDriver((existing) => ({
      ...existing,
      [driver]: nextEnvironment,
    }));
  };
  const setGenericDriverEnvironment = (
    nextGeneric: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => {
    const dedicated = driverEnvironment.filter((entry) =>
      driverEnvironmentFieldNames.has(entry.name),
    );
    setDriverEnvironment([...dedicated, ...nextGeneric]);
  };
  const selectDriver = (value: string) => {
    setDriver(ProviderDriverKind.make(value));
    setIsManualAcpConfiguration(false);
    setHasAttemptedSubmit(false);
  };
  const setIdentityDraft = (update: Partial<ProviderIdentityDraft>) => {
    setIdentityByDriver((existing) => ({
      ...existing,
      [driver]: { ...(existing[driver] ?? defaultIdentity), ...update },
    }));
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (isSaving || isPreparingRegistryAgent || postCreateAuth) return;
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    if (isAcpRegistry && !isLocalAcp && navigation.kind === "navigate" && navigation.step === 2) {
      void handleSave();
      return;
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      isAcpRegistry
        ? isLocalAcp
          ? resolveWizardNavigation(wizardStep, requestedStep, LOCAL_ACP_WIZARD_STEPS.length, {
              instanceIdError,
              prerequisite: { step: 0, error: acpSelectionError },
            })
          : resolveAcpRegistryWizardNavigation(wizardStep, requestedStep, {
              instanceIdError,
              selectionError: acpSelectionError,
            })
        : resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
            instanceIdError,
          }),
    );
  };

  const handleAcpPrepared = (agent: AcpRegistrySearchAgent) => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    const nextLabel = agent.name;
    const registryIconUrl = resolveOfficialAcpRegistryIconUrl(agent.icon);
    const nextInstanceId = deriveAvailableInstanceId(
      (candidateLabel) => deriveInstanceId(ACP_REGISTRY_DRIVER_KIND, candidateLabel),
      nextLabel,
      existingIds,
    );
    setSelectedAcp(agent);
    setIsManualAcpConfiguration(false);
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: nextLabel,
        instanceIdOverride: nextInstanceId,
      }),
    );
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: {
        agentId: agent.id,
        distribution: "auto",
        ...(registryIconUrl ? { registryIconUrl } : {}),
      },
    }));
    setHasAttemptedSubmit(false);
    setWizardStep(1);
  };

  const handleManualAcpConfiguration = () => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigByDriver((existing) => {
      const next = { ...existing };
      delete next[ACP_REGISTRY_DRIVER_KIND];
      return next;
    });
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: "",
        instanceIdOverride: null,
      }),
    );
    setHasAttemptedSubmit(false);
  };

  const handleLocalAcpConfiguration = () => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: { source: "local", commandArgs: [] },
    }));
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: gt("Local ACP"),
        instanceIdOverride: null,
      }),
    );
    setLocalEnvironment([]);
    setHasAttemptedSubmit(false);
  };

  // A policy that owns this driver's launch settings also rules out ChatGPT's own runtime.
  const driverLocks = managedInstanceLocks(managedPolicy, driver, m);
  const existingDriverCanAuthenticate = serverProviders.some(
    (provider) => provider.driver === driver && provider.setup?.canAuthenticate === true,
  );

  const resolvePostCreateAuth = (input: {
    readonly brandedId: ProviderInstanceId;
    readonly config: Record<string, unknown>;
    readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
    readonly instance: ProviderInstanceConfig;
  }): PostCreateAuth | null => {
    if (isAcpRegistry && !isLocalAcp) {
      return { kind: "wizard", instanceId: input.brandedId };
    }
    if (driver === "cursor") {
      return hasEnvironmentVariable(input.environment, "CURSOR_API_KEY")
        ? null
        : { kind: "wizard", instanceId: input.brandedId };
    }
    if (driver === "antigravity") {
      return readAntigravityAuthMethod(input.config) === "oauth-personal"
        ? { kind: "antigravity", instanceId: input.brandedId, config: input.config }
        : null;
    }
    if (driver === "claudeAgent") {
      if (hasEnvironmentVariable(input.environment, "ANTHROPIC_API_KEY")) return null;
      if (serverConfig === null && !isAccountMode) return null;
      return {
        kind: "cli",
        instanceId: input.brandedId,
        driver: "claudeAgent",
        instance: input.instance,
      };
    }
    if (driver === "codex") {
      if (hasEnvironmentVariable(input.environment, "OPENAI_API_KEY")) return null;
      if (serverConfig === null && !isAccountMode) return null;
      return {
        kind: "cli",
        instanceId: input.brandedId,
        driver: "codex",
        instance: input.instance,
      };
    }
    if (!isAcpRegistry && existingDriverCanAuthenticate) {
      return { kind: "wizard", instanceId: input.brandedId };
    }
    return null;
  };

  const handleSave = async () => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    if (isSaving || postCreateAuth) return;
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null || (isAcpRegistry && acpSelectionError !== null)) return;

    const config =
      driver === "codex"
        ? { ...configByDriver[driver], setupMode: "existing" }
        : (configByDriver[driver] ?? {});
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);
    const cleanedEnvironment = (isLocalAcp ? localEnvironment : driverEnvironment).filter(
      (variable) => variable.name.trim().length > 0,
    );

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
      ...(cleanedEnvironment.length > 0 ? { environment: cleanedEnvironment } : {}),
    };
    const brandedId = ProviderInstanceId.make(instanceId);
    setIsSaving(true);
    const result = await persistProviderInstance({
      operation: "create",
      instanceId: brandedId,
      instance: nextInstance,
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setIsSaving(false);
      toastManager.add({
        type: "error",
        title: gt("Could not add provider instance"),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
            : gt("The settings update failed."),
      });
      return;
    }
    onCreated?.(brandedId, driver);
    void refreshProviders({ environmentId, input: { instanceId: brandedId } });

    const nextAuthStep = resolvePostCreateAuth({
      brandedId,
      config,
      environment: cleanedEnvironment,
      instance: nextInstance,
    });
    if (nextAuthStep !== null) {
      setPostCreateAuth(nextAuthStep);
      setIsSaving(false);
      setWizardStep(isAcpRegistry ? 2 : 3);
      return;
    }

    toastManager.add({
      type: "success",
      title: gt("Provider instance added"),
      description: gt("{provider} instance ''{instanceId}'' was added.", {
        provider: driverOption.label,
        instanceId,
      }),
    });
    onOpenChange(false);
  };

  if (addingChatGptAccount) {
    return (
      <AddManagedCodexAccountDialog
        environmentId={environmentId}
        onClose={() => onOpenChange(false)}
        onAccountCreated={(createdId) => onCreated?.(createdId, ProviderDriverKind.make("codex"))}
      />
    );
  }

  const willAdvanceToSignIn =
    !isAcpRegistry &&
    ((driver === "cursor" && !hasEnvironmentVariable(driverEnvironment, "CURSOR_API_KEY")) ||
      (driver === "antigravity" && readAntigravityAuthMethod(configDraft) === "oauth-personal") ||
      (driver === "claudeAgent" &&
        !hasEnvironmentVariable(driverEnvironment, "ANTHROPIC_API_KEY") &&
        (serverConfig !== null || isAccountMode)) ||
      (driver === "codex" &&
        !hasEnvironmentVariable(driverEnvironment, "OPENAI_API_KEY") &&
        (serverConfig !== null || isAccountMode)) ||
      existingDriverCanAuthenticate);

  const dialogTitle = isAccountMode
    ? isAcpRegistry || (wizardStep === 0 && initialDriver === undefined)
      ? gt("Add account")
      : gt("Add {provider} account", { provider: driverOption.label })
    : gt("Add provider");

  const finalSubmitLabel = isSaving
    ? gt("Adding…")
    : isAcpRegistry && !isLocalAcp
      ? gt("Continue to sign-in")
      : isAccountMode
        ? willAdvanceToSignIn
          ? gt("Continue to sign-in")
          : gt("Add account")
        : gt("Add instance");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup size="wide">
        <WizardHeader
          title={dialogTitle}
          description={
            <T>
              Add an account or configure a provider on <Var>{environmentLabel}</Var>.
            </T>
          }
        >
          {isAcpRegistry ? (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              steps={isLocalAcp ? LOCAL_ACP_WIZARD_STEPS : ACP_REGISTRY_WIZARD_STEPS}
              disabled={isSaving || isPreparingRegistryAgent || postCreateAuth !== null}
              identityStep={1}
              prerequisite={{ step: 0, error: acpSelectionError }}
              onNavigation={applyWizardNavigation}
            />
          ) : (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              steps={
                postCreateAuth !== null
                  ? ADD_ACCOUNT_SIGN_IN_WIZARD_STEPS
                  : ADD_PROVIDER_WIZARD_STEPS
              }
              disabled={isSaving || isPreparingRegistryAgent || postCreateAuth !== null}
              onNavigation={applyWizardNavigation}
            />
          )}
        </WizardHeader>

        {postCreateAuth?.kind === "wizard" ? (
          <ProviderWizardAuthenticationStep
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={postCreateAuth.instanceId}
            onFinish={() => onOpenChange(false)}
          />
        ) : postCreateAuth?.kind === "antigravity" ? (
          <WizardAntigravityAuthenticationStep
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={postCreateAuth.instanceId}
            config={postCreateAuth.config}
            onFinish={() => onOpenChange(false)}
          />
        ) : postCreateAuth?.kind === "cli" ? (
          <WizardCliAuthenticationStep
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={postCreateAuth.instanceId}
            driver={postCreateAuth.driver}
            instance={postCreateAuth.instance}
            secretSources={secretSources}
            onFinish={() => onOpenChange(false)}
          />
        ) : (
          <>
            <WizardPanel className={cn(isAcpRegistry && wizardStep === identityStep && "min-h-72")}>
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  {gt("Provider", { $context: "wizard step" })}
                </div>
                <ProviderOptionGrid
                  options={featuredDriverOptions}
                  value={driver}
                  disabled={isPreparingRegistryAgent}
                  onValueChange={selectDriver}
                  aria-labelledby="add-instance-driver-label"
                />
              </div>

              {wizardStep === 0 && (moreDriverOptions.length > 0 || acpRegistryAllowed) ? (
                <Collapsible open={showMoreProviders} onOpenChange={setShowMoreProviders}>
                  <div className="flex pt-2">
                    <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
                      {showMoreProviders ? gt("Show less") : gt("Show more")}
                      <ChevronDownIcon
                        aria-hidden
                        className={cn("transition-transform", showMoreProviders && "rotate-180")}
                      />
                    </CollapsibleTrigger>
                  </div>
                  {/* WizardPanel already animates its height, so the fold opens without its own. */}
                  <CollapsiblePanel animate={false}>
                    <div className="space-y-4 pt-4">
                      <ProviderOptionGrid
                        options={moreDriverOptions}
                        value={driver}
                        disabled={isPreparingRegistryAgent}
                        onValueChange={selectDriver}
                        aria-label={gt("More providers")}
                      />
                      {!acpRegistryAllowed ? null : (
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <div aria-hidden className="flex-1 border-t border-border/70" />
                          <span>
                            <T>Or choose from ACP Registry</T>
                          </span>
                          <div aria-hidden className="flex-1 border-t border-border/70" />
                        </div>
                      )}
                      {!acpRegistryAllowed ? null : isAcpRegistry && isManualAcpConfiguration ? (
                        <div className="grid gap-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-medium text-foreground">
                                {isLocalAcp ? gt("Local ACP command") : gt("Enter manually")}
                              </h3>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {isLocalAcp
                                  ? gt("Run an installed ACP executable on {environment}.", {
                                      environment: environmentLabel,
                                    })
                                  : gt(
                                      "Enter an official registry ID and any local executable or auth override.",
                                    )}
                              </p>
                            </div>
                            <Button
                              onClick={() => {
                                setIsManualAcpConfiguration(false);
                                setHasAttemptedSubmit(false);
                              }}
                              size="xs"
                              variant="ghost"
                            >
                              <T>Search registry</T>
                            </Button>
                          </div>
                          <SettingsGroup variant="plain">
                            <ProviderSettingsForm
                              definition={driverOption}
                              value={configDraft}
                              idPrefix="add-provider-acpRegistry-manual"
                              variant="settings"
                              onChange={setConfigDraft}
                              environmentId={environmentId}
                            />
                            {isLocalAcp ? (
                              <ProviderEnvironmentSection
                                environment={localEnvironment}
                                onChange={setLocalEnvironment}
                                secretSources={secretSources}
                                environmentId={environmentId}
                              />
                            ) : null}
                          </SettingsGroup>
                          {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                            <p className="text-2xs text-destructive">{acpSelectionError}</p>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <AcpRegistrySearchStep
                            environmentId={environmentId}
                            registry={registry}
                            providerInstances={settings.providerInstances}
                            onPrepared={handleAcpPrepared}
                            onManualConfiguration={handleManualAcpConfiguration}
                            onLocalConfiguration={handleLocalAcpConfiguration}
                          />
                          {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                            <p className="mt-2 text-2xs text-destructive">{acpSelectionError}</p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              ) : null}

              {isAcpRegistry && wizardStep === 1 && selectedAcp ? (
                <div className="mb-4 flex items-start justify-between gap-3 border-b border-border/70 pb-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {selectedAcp.name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      v{selectedAcp.version} · {selectedAcp.distribution}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2 text-2xs">
                    {selectedAcp.website ? (
                      <a
                        aria-label={gt("Open documentation for {name} ({id})", {
                          name: selectedAcp.name,
                          id: selectedAcp.id,
                        })}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.website}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <T>Docs</T>
                      </a>
                    ) : null}
                    {selectedAcp.repository ? (
                      <a
                        aria-label={gt("Open source for {name} ({id})", {
                          name: selectedAcp.name,
                          id: selectedAcp.id,
                        })}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.repository}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {gt("Source", { $context: "link to source code" })}
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <SettingsGroup
                variant="plain"
                className={cn(wizardStep !== identityStep && "hidden")}
              >
                <SettingsRow
                  title={
                    <label htmlFor="add-provider-label">
                      {gt("Label", { $context: "noun, display name" })}
                    </label>
                  }
                  description={
                    <span id="add-provider-label-description">
                      <T>Shown in the provider list.</T>
                    </span>
                  }
                  control={
                    <Input
                      id="add-provider-label"
                      aria-describedby="add-provider-label-description"
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder={gt("e.g. Work")}
                      value={label}
                      onChange={(event) => setIdentityDraft({ label: event.target.value })}
                    />
                  }
                />
                <SettingsRow
                  title={
                    <label htmlFor="add-provider-instance-id">
                      <T>Instance ID</T>
                    </label>
                  }
                  description={
                    <span id="add-provider-instance-id-description">
                      <T>Letters, digits, '-', or '_'.</T>
                    </span>
                  }
                  status={
                    showInstanceIdError ? (
                      <span
                        id="add-provider-instance-id-error"
                        role="alert"
                        className="text-destructive"
                      >
                        {instanceIdError}
                      </span>
                    ) : undefined
                  }
                  control={
                    <Input
                      id="add-provider-instance-id"
                      aria-describedby={
                        showInstanceIdError
                          ? "add-provider-instance-id-description add-provider-instance-id-error"
                          : "add-provider-instance-id-description"
                      }
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder={`${driver}_work`}
                      value={instanceId}
                      onChange={(event) => {
                        setIdentityDraft({ instanceIdOverride: event.target.value });
                      }}
                      aria-invalid={showInstanceIdError}
                    />
                  }
                />
                <SettingsRow
                  title={gt("Accent color")}
                  description={gt("Optional marker shown in the picker.")}
                  control={
                    <ProviderAccentColorPicker
                      displayName={label || driverOption.label}
                      value={accentColor || undefined}
                      onCommit={(value) => setIdentityDraft({ accentColor: value })}
                      layout="inline"
                    />
                  }
                />
              </SettingsGroup>

              {!isAcpRegistry ? (
                <SettingsGroup variant="plain" className={cn(wizardStep !== 2 && "hidden")}>
                  {driverSettingsFields.length > 0 ? (
                    <ProviderSettingsForm
                      definition={driverOption}
                      value={configDraft}
                      idPrefix={`add-provider-${driver}`}
                      variant="settings"
                      onChange={setConfigDraft}
                      managed={
                        driverLocks && { keys: driverLocks.configKeys, reason: driverLocks.reason }
                      }
                      environmentId={environmentId}
                    />
                  ) : null}
                  {driverEnvironmentFields.map((field) => (
                    <WizardEnvironmentFieldRow
                      key={field.name}
                      field={field}
                      environment={driverEnvironment}
                      environmentId={environmentId}
                      secretSources={secretSources}
                      idPrefix={`add-provider-${driver}`}
                      onChange={setDriverEnvironment}
                    />
                  ))}
                  <ProviderEnvironmentSection
                    environment={genericDriverEnvironment}
                    onChange={setGenericDriverEnvironment}
                    secretSources={secretSources}
                    environmentId={environmentId}
                  />
                </SettingsGroup>
              ) : null}
            </WizardPanel>

            <WizardFooter>
              <Button
                variant={wizardStep === 0 ? "ghost-muted" : "outline"}
                size="sm"
                disabled={isSaving || isPreparingRegistryAgent}
                onClick={() => {
                  if (wizardStep === 0) {
                    onOpenChange(false);
                    return;
                  }
                  setWizardStep((step) => Math.max(0, step - 1));
                }}
              >
                {wizardStep === 0 ? gt("Cancel") : gt("Back")}
              </Button>
              {wizardStep === 0 && driver === "codex" ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => navigateToStep(1)}>
                    <T>Configure manually</T>
                  </Button>
                  {driverLocks?.configKeys.has("setupMode") ? null : (
                    <ChatGptConnectionButton
                      size="sm"
                      onClick={() => setAddingChatGptAccount(true)}
                    />
                  )}
                </>
              ) : wizardStep < (isAcpRegistry ? 1 : 2) ? (
                <Button
                  size="sm"
                  disabled={isPreparingRegistryAgent}
                  onClick={() => navigateToStep(wizardStep + 1)}
                >
                  <T>Next</T>
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={isSaving || !canManageProviders}
                  onClick={() => void handleSave()}
                >
                  {finalSubmitLabel}
                </Button>
              )}
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}

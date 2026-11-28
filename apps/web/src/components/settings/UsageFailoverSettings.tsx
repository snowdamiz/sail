import {
  DEFAULT_UNIFIED_SETTINGS,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  type UsageLimitPassOffRule,
} from "@t3tools/contracts";
import {
  createModelSelection,
  formatModelSlugName,
  pickModelSelection,
} from "@t3tools/shared/model";
import { detectPassOffRuleIssues } from "@t3tools/shared/usageFailover";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { AlertTriangleIcon, ArrowRightIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const ANY_MODEL_VALUE = "__any__";

interface DriverOption {
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly accountCount: number;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

function buildDriverOptions(
  providers: readonly ServerProvider[],
  rules: readonly UsageLimitPassOffRule[],
): ReadonlyArray<DriverOption> {
  const byDriver = new Map<
    ProviderDriverKind,
    { accountCount: number; models: Map<string, string> }
  >();

  for (const provider of providers) {
    const bucket = byDriver.get(provider.driver) ?? {
      accountCount: 0,
      models: new Map<string, string>(),
    };
    if (provider.enabled && provider.installed && provider.auth.status !== "unauthenticated") {
      bucket.accountCount += 1;
    }
    for (const model of provider.models) {
      if (!bucket.models.has(model.slug)) {
        bucket.models.set(model.slug, model.name);
      }
    }
    byDriver.set(provider.driver, bucket);
  }

  for (const rule of rules) {
    const bucket = byDriver.get(rule.sourceDriver) ?? {
      accountCount: 0,
      models: new Map<string, string>(),
    };
    if (rule.sourceModel !== null && !bucket.models.has(rule.sourceModel)) {
      bucket.models.set(rule.sourceModel, formatModelSlugName(rule.sourceModel));
    }
    byDriver.set(rule.sourceDriver, bucket);
  }

  return Array.from(byDriver.entries()).map(([driver, data]) => ({
    driver,
    label: PROVIDER_DISPLAY_NAMES[driver] ?? driver,
    accountCount: data.accountCount,
    models: Array.from(data.models.entries()).map(([slug, name]) => ({ slug, name })),
  }));
}

function createRuleId(existingRules: readonly UsageLimitPassOffRule[]): string {
  const existing = new Set(existingRules.map((rule) => rule.id));
  let candidate = `passoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  while (existing.has(candidate)) {
    candidate = `passoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return candidate;
}

export function UsageFailoverSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const navigate = useNavigate();
  const { target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);

  const rules = settings.usageLimitPassOffRules;
  const mixedAutoFailover = useScopedSettingsMixed(["autoFailoverOnUsageLimit"]);
  const mixedRules = useScopedSettingsMixed(["usageLimitPassOffRules"]);
  const driverOptions = buildDriverOptions(providers, rules);
  const issueByRuleId = detectPassOffRuleIssues(rules, providers, settings);

  const formatDriverOptionLabel = (option: DriverOption): string => {
    if (option.accountCount === 1) {
      return gt("{provider} (1 account)", { provider: option.label });
    }
    if (option.accountCount > 1) {
      return gt("{provider} ({count} accounts)", {
        provider: option.label,
        count: option.accountCount,
      });
    }
    return option.label;
  };

  const saveRules = (nextRules: ReadonlyArray<UsageLimitPassOffRule>) => {
    updateSettings({ usageLimitPassOffRules: nextRules });
  };

  const updateRule = (
    ruleId: string,
    updater: (rule: UsageLimitPassOffRule) => UsageLimitPassOffRule,
  ) => {
    saveRules(rules.map((rule) => (rule.id === ruleId ? updater(rule) : rule)));
  };

  const removeRule = (ruleId: string) => {
    saveRules(rules.filter((rule) => rule.id !== ruleId));
  };

  const addRule = () => {
    const usedDrivers = new Set(rules.map((rule) => rule.sourceDriver));
    const sourceOption =
      driverOptions.find((option) => option.accountCount > 0 && !usedDrivers.has(option.driver)) ??
      driverOptions.find((option) => option.accountCount > 0) ??
      driverOptions[0];
    if (!sourceOption) return;

    const targetEntry =
      entries.find(
        (entry) => entry.driverKind !== sourceOption.driver && entry.models.length > 0,
      ) ??
      entries.find((entry) => entry.models.length > 0) ??
      entries[0];
    if (!targetEntry) return;
    const defaultTargetModel = targetEntry.models[0]?.slug;
    if (!defaultTargetModel) return;

    const nextRule: UsageLimitPassOffRule = {
      id: createRuleId(rules),
      sourceDriver: sourceOption.driver,
      sourceModel: null,
      target: createModelSelection(targetEntry.instanceId, defaultTargetModel),
    };
    saveRules([...rules, nextRule]);
  };

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["autoFailoverOnUsageLimit"]}
        mixed={mixedAutoFailover}
        {...searchableSetting("auto-failover-usage-limit")}
        description={gt(
          "When an account runs out of usage, automatically transfer active threads to another connected account of the same provider, then continue with your configured pass-off model.",
        )}
        resetAction={
          mixedAutoFailover ||
          settings.autoFailoverOnUsageLimit !==
            DEFAULT_UNIFIED_SETTINGS.autoFailoverOnUsageLimit ? (
            <SettingResetButton
              ariaLabel={gt("Reset automatic usage failover to default")}
              onClick={() =>
                updateSettings({
                  autoFailoverOnUsageLimit: DEFAULT_UNIFIED_SETTINGS.autoFailoverOnUsageLimit,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["autoFailoverOnUsageLimit"]}
            checked={settings.autoFailoverOnUsageLimit}
            onCheckedChange={(checked) =>
              updateSettings({ autoFailoverOnUsageLimit: Boolean(checked) })
            }
            aria-label={gt("Automatic usage failover")}
          />
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["usageLimitPassOffRules"]}
        mixed={mixedRules}
        {...searchableSetting("usage-limit-pass-off-rules")}
        description={gt(
          "Choose which provider and model to continue on after all connected accounts of a provider run out of usage.",
        )}
        resetAction={
          mixedRules || rules.length > 0 ? (
            <SettingResetButton
              ariaLabel={gt("Reset pass-off rules to default")}
              onClick={() => saveRules(DEFAULT_UNIFIED_SETTINGS.usageLimitPassOffRules)}
            />
          ) : null
        }
      >
        <div className="flex flex-col gap-2 pt-3 pb-2">
          {rules.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {gt(
                "No pass-off rules configured. When all accounts of a provider run out of usage, threads will fall back to your Fallback model if one is set.",
              )}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {rules.map((rule, index) => {
                const sourceDriverOption = driverOptions.find(
                  (option) => option.driver === rule.sourceDriver,
                );
                const sourceModels = sourceDriverOption?.models ?? [];
                const targetEntry = entries.find(
                  (entry) => entry.instanceId === rule.target.instanceId,
                );
                const targetModelOptions = getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  rule.target.instanceId,
                  rule.target.model,
                );
                const targetDisabledReason = modelDisabledReason(
                  rule.target.instanceId,
                  rule.target.model,
                );
                const issue = issueByRuleId.get(rule.id);

                const applyTarget = (nextTarget: ModelSelection) => {
                  const reason = modelDisabledReason(nextTarget.instanceId, nextTarget.model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: gt("Pass-off target not saved"),
                      description: reason,
                    });
                    return;
                  }
                  updateRule(rule.id, (current) => ({ ...current, target: nextTarget }));
                };

                return (
                  <div
                    key={rule.id}
                    role="group"
                    aria-label={gt("Pass-off rule {number}", { number: index + 1 })}
                    className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={rule.sourceDriver}
                        onValueChange={(value) => {
                          if (!value) return;
                          const nextDriver = value as ProviderDriverKind;
                          updateRule(rule.id, (current) => ({
                            ...current,
                            sourceDriver: nextDriver,
                            sourceModel: null,
                          }));
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={gt("Source provider for rule {number}", {
                            number: index + 1,
                          })}
                        >
                          <SelectValue>
                            {(value: string | null) => {
                              const matched = driverOptions.find(
                                (option) => option.driver === value,
                              );
                              return matched
                                ? formatDriverOptionLabel(matched)
                                : (PROVIDER_DISPLAY_NAMES[rule.sourceDriver] ?? rule.sourceDriver);
                            }}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start" alignItemWithTrigger={false}>
                          {driverOptions.map((option) => (
                            <SelectItem key={option.driver} value={option.driver}>
                              {formatDriverOptionLabel(option)}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>

                      <Select
                        value={rule.sourceModel ?? ANY_MODEL_VALUE}
                        onValueChange={(value) => {
                          if (!value) return;
                          updateRule(rule.id, (current) => ({
                            ...current,
                            sourceModel: value === ANY_MODEL_VALUE ? null : value,
                          }));
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={gt("Source model for rule {number}", {
                            number: index + 1,
                          })}
                        >
                          <SelectValue>
                            {(value: string | null) => {
                              if (!value || value === ANY_MODEL_VALUE) {
                                return gt("Any model");
                              }
                              const matched = sourceModels.find((model) => model.slug === value);
                              return matched?.name ?? formatModelSlugName(value);
                            }}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start" alignItemWithTrigger={false}>
                          <SelectItem value={ANY_MODEL_VALUE}>{gt("Any model")}</SelectItem>
                          {sourceModels.map((model) => (
                            <SelectItem key={model.slug} value={model.slug}>
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>

                      <ArrowRightIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />

                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <ProviderModelPicker
                          environmentId={representative?.environmentId ?? null}
                          activeInstanceId={rule.target.instanceId}
                          model={rule.target.model}
                          lockedProvider={null}
                          instanceEntries={entries}
                          modelOptionsByInstance={targetModelOptions}
                          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                          triggerAriaLabel={gt("Pass-off target model for rule {number}", {
                            number: index + 1,
                          })}
                          getModelDisabledReason={modelDisabledReason}
                          onOpenProviderSetup={(instanceId) => {
                            if (representative) {
                              void navigate({
                                to: "/settings/providers",
                                search: {
                                  environmentId: representative.environmentId,
                                  instanceId,
                                },
                              });
                            }
                          }}
                          onInstanceModelChange={(instanceId, model) =>
                            applyTarget(pickModelSelection(rule.target, instanceId, model))
                          }
                        />
                        {targetEntry && !targetDisabledReason ? (
                          <TraitsPicker
                            provider={targetEntry.driverKind}
                            models={targetEntry.models}
                            model={rule.target.model}
                            modelOptions={rule.target.options ?? []}
                            allowPromptInjectedEffort={false}
                            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                            onModelOptionsChange={(options) =>
                              applyTarget(
                                createModelSelection(
                                  rule.target.instanceId,
                                  rule.target.model,
                                  options,
                                ),
                              )
                            }
                          />
                        ) : null}
                      </div>

                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        className="ml-auto"
                        aria-label={gt("Remove pass-off rule {number}", { number: index + 1 })}
                        onClick={() => removeRule(rule.id)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>

                    {issue ? (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <Badge variant="warning" size="sm">
                          <AlertTriangleIcon className="size-3" />
                          {issue === "self_loop" ? gt("Same provider") : gt("Pass-off cycle")}
                        </Badge>
                        <span>
                          {issue === "self_loop"
                            ? gt(
                                "Other accounts of the same provider are already tried first before pass-off rules.",
                              )
                            : gt(
                                "This rule loops back to an earlier provider. Automatic failover stops before repeating a provider.",
                              )}
                        </span>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <Button
              variant="outline"
              size="xs"
              disabled={driverOptions.length === 0 || entries.length === 0}
              onClick={addRule}
            >
              <PlusIcon className="size-3.5" />
              {gt("Add pass-off rule")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {gt(
                "Same-provider accounts are always tried first before passing off to another provider.",
              )}
            </p>
          </div>
        </div>
      </SettingsRow>
    </>
  );
}

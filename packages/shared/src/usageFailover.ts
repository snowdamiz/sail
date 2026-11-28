import {
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ServerSettings,
  type UsageLimitPassOffRule,
} from "@t3tools/contracts";

import { normalizeModelSlug, withLegacyUltracodeEffort } from "./model.ts";

const MAX_PASS_OFF_HOPS = 8;

function isWindowActiveAt(window: ServerProviderUsageWindow, now: number): boolean {
  return (
    !window.resetsAt ||
    !Number.isFinite(Date.parse(window.resetsAt)) ||
    Date.parse(window.resetsAt) > now
  );
}

function windowAppliesToModel(
  provider: ServerProvider | undefined,
  windows: readonly ServerProviderUsageWindow[],
  window: ServerProviderUsageWindow,
  model?: string,
): boolean {
  if (model !== undefined && window.modelIds !== undefined && !window.modelIds.includes(model)) {
    return false;
  }
  if (
    model !== undefined &&
    window.providerIds !== undefined &&
    !window.providerIds.includes(model.split("/")[0] ?? "")
  ) {
    return false;
  }
  if (model === undefined) return true;
  switch (provider?.driver) {
    case "antigravity": {
      const family = model.match(/^(gemini|claude|gpt)-/)?.[1];
      const pool = window.id.match(/^(gemini|claude|gpt|3p)-/)?.[1];
      return (
        pool === undefined ||
        family === undefined ||
        pool === family ||
        (pool === "3p" && (family === "claude" || family === "gpt"))
      );
    }
    case "codex": {
      const hasPlanWindows = windows.some(
        (entry) => entry.id === "primary" || entry.id === "secondary",
      );
      return window.id !== "individual" || !hasPlanWindows;
    }
    case "opencode":
      return !window.id.startsWith("go_") || model.startsWith("opencode-go/");
    default:
      return true;
  }
}

export function exhaustedUsageWindow(
  provider: ServerProvider | undefined,
  now: number,
  model?: string,
) {
  const windows = provider?.usageLimits?.windows ?? [];
  const exhausted = windows.filter(
    (window) =>
      (window.usedPercent ?? 0) >= 100 &&
      (model === undefined || window.modelIds === undefined || window.modelIds.includes(model)) &&
      (model === undefined ||
        window.providerIds === undefined ||
        window.providerIds.includes(model.split("/")[0] ?? "")) &&
      isWindowActiveAt(window, now),
  );
  if (model === undefined) return exhausted[0];
  switch (provider?.driver) {
    case "cursor": {
      const api = exhausted.find((window) => window.id === "apiPercentUsed");
      const auto = exhausted.find((window) => window.id === "autoPercentUsed");
      return /^(auto|default|grok|composer)/.test(model) ? auto && api : api;
    }
    case "antigravity": {
      const family = model.match(/^(gemini|claude|gpt)-/)?.[1];
      return exhausted.find((window) => {
        const pool = window.id.match(/^(gemini|claude|gpt|3p)-/)?.[1];
        return (
          pool === undefined ||
          family === undefined ||
          pool === family ||
          (pool === "3p" && (family === "claude" || family === "gpt"))
        );
      });
    }
    case "codex": {
      // Seat-based plans spend credits only past their plan windows, so the credit cap blocks only plans without them.
      const hasPlanWindows = windows.some(
        (window) => window.id === "primary" || window.id === "secondary",
      );
      return exhausted.find((window) => window.id !== "individual" || !hasPlanWindows);
    }
    case "opencode":
      return exhausted.find(
        (window) => !window.id.startsWith("go_") || model.startsWith("opencode-go/"),
      );
    default:
      return exhausted[0];
  }
}

export interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

export const nativeAccountReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

// Include every enabled login, even unreadable workspaces.
export function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

export type UsageLimitFailoverSettings = Pick<
  ServerSettings,
  | "autoFailoverOnUsageLimit"
  | "usageLimitPassOffRules"
  | "fallbackModelSelection"
  | "providerInstances"
  | "projectSettingsOverrides"
>;

export interface UsageLimitFailoverInput {
  readonly currentSelection: ModelSelection;
  readonly providers: readonly ServerProvider[];
  readonly settings: UsageLimitFailoverSettings;
  readonly projectId: ProjectId | null;
  readonly now: number;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly attemptedInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly attemptedAccountKeys?: ReadonlySet<string> | undefined;
}

export type UsageLimitFailoverResolution =
  | {
      readonly kind: "same_provider_account";
      readonly target: ModelSelection;
      readonly fromProvider: ServerProvider;
      readonly toProvider: ServerProvider;
    }
  | {
      readonly kind: "cross_provider_handoff";
      readonly target: ModelSelection;
      readonly fromProvider: ServerProvider;
      readonly toProvider: ServerProvider;
      readonly ruleId: string | null;
    }
  | {
      readonly kind: "none";
      readonly reason: "disabled" | "unknown_provider" | "no_eligible_target";
    };

function modelsMatchForDriver(driver: ProviderDriverKind, left: string, right: string): boolean {
  if (left === right) return true;
  const normalizedLeft = normalizeModelSlug(left, driver) ?? left;
  const normalizedRight = normalizeModelSlug(right, driver) ?? right;
  return normalizedLeft === normalizedRight;
}

function findMatchingProviderModel(
  provider: ServerProvider,
  model: string,
): ServerProviderModel | undefined {
  const exact = provider.models.find(
    (entry) => entry.slug === model || entry.aliases?.includes(model),
  );
  if (exact) return exact;
  const normalized = normalizeModelSlug(model, provider.driver);
  if (!normalized || normalized === model) return undefined;
  return provider.models.find(
    (entry) => entry.slug === normalized || entry.aliases?.includes(normalized),
  );
}

function isModelCompatible(provider: ServerProvider, model: string): boolean {
  if (provider.models.length === 0 || provider.configurableProviders === true) {
    return true;
  }
  return findMatchingProviderModel(provider, model) !== undefined;
}

function isRuntimeModeCompatible(
  provider: ServerProvider,
  runtimeMode: RuntimeMode | undefined,
): boolean {
  if (runtimeMode === undefined) return true;
  const supported = provider.supportedRuntimeModes;
  if (!supported || supported.length === 0) return true;
  return supported.includes(runtimeMode);
}

function isProjectInstanceEnabled(
  settings: UsageLimitFailoverSettings,
  projectId: ProjectId | null,
  candidate: ServerProvider,
): boolean {
  const projectOverride =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances?.[candidate.instanceId]
          ?.enabled;
  if (projectOverride !== undefined) return projectOverride;
  if (Object.hasOwn(settings.providerInstances, candidate.instanceId)) {
    return resolveProjectProviderInstanceEnabled(settings, projectId, candidate.instanceId);
  }
  return candidate.enabled;
}

function maxActiveUsagePercent(provider: ServerProvider, now: number, model: string): number {
  const windows = provider.usageLimits?.windows ?? [];
  let maxPercent = 0;
  for (const window of windows) {
    if (!isWindowActiveAt(window, now)) continue;
    if (!windowAppliesToModel(provider, windows, window, model)) continue;
    if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
      if (window.usedPercent > maxPercent) {
        maxPercent = window.usedPercent;
      }
    }
  }
  return maxPercent;
}

function reconcileModelOptions(
  provider: ServerProvider,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!options || options.length === 0) return undefined;
  const matchedModel = findMatchingProviderModel(provider, model);
  if (!matchedModel?.capabilities) {
    return options;
  }
  const descriptors = matchedModel.capabilities.optionDescriptors ?? [];
  if (descriptors.length === 0) {
    return undefined;
  }
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const normalizedInput = withLegacyUltracodeEffort(descriptors, options) ?? [];
  const seen = new Set<string>();
  const reconciled: Array<ProviderOptionSelection> = [];
  for (const selection of normalizedInput) {
    if (seen.has(selection.id)) continue;
    const descriptor = descriptorById.get(selection.id);
    if (!descriptor) continue;
    if (descriptor.type === "boolean") {
      if (typeof selection.value === "boolean") {
        reconciled.push({ id: selection.id, value: selection.value });
        seen.add(selection.id);
      }
    } else if (typeof selection.value === "string") {
      if (
        descriptor.options.length === 0 ||
        descriptor.options.some((option) => option.id === selection.value)
      ) {
        reconciled.push({ id: selection.id, value: selection.value });
        seen.add(selection.id);
      }
    }
  }
  return reconciled.length > 0 ? reconciled : undefined;
}

function buildReconciledSelection(
  provider: ServerProvider,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): ModelSelection {
  const reconciledOptions = reconcileModelOptions(provider, model, options);
  return reconciledOptions
    ? { instanceId: provider.instanceId, model, options: reconciledOptions }
    : { instanceId: provider.instanceId, model };
}

function resolveInstanceDriver(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  settings: Pick<ServerSettings, "providerInstances">,
): ProviderDriverKind | undefined {
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  if (provider) return provider.driver;
  if (Object.hasOwn(settings.providerInstances, instanceId)) {
    return settings.providerInstances[instanceId]?.driver;
  }
  return undefined;
}

export function resolveUsageLimitFailoverTarget(
  input: UsageLimitFailoverInput,
): UsageLimitFailoverResolution {
  const { currentSelection, providers, settings, projectId, now, runtimeMode } = input;
  if (!settings.autoFailoverOnUsageLimit) {
    return { kind: "none", reason: "disabled" };
  }
  const currentProvider = providers.find(
    (entry) => entry.instanceId === currentSelection.instanceId,
  );
  if (!currentProvider) {
    return { kind: "none", reason: "unknown_provider" };
  }

  const resolveAccountKey = accountKeyResolver(providers.map(nativeAccountReport));
  const excludedInstances = new Set<ProviderInstanceId>([
    ...(input.attemptedInstanceIds ?? []),
    currentSelection.instanceId,
  ]);
  const excludedAccountKeys = new Set<string>(input.attemptedAccountKeys ?? []);
  for (const instanceId of excludedInstances) {
    const provider = providers.find((entry) => entry.instanceId === instanceId);
    if (!provider) continue;
    const key = resolveAccountKey(nativeAccountReport(provider));
    if (key) excludedAccountKeys.add(key);
  }

  const settingsInstanceOrder = new Map(
    Object.keys(settings.providerInstances).map((id, index) => [id, index]),
  );
  const providerOrder = new Map(providers.map((provider, index) => [provider.instanceId, index]));

  const isCandidateEligible = (candidate: ServerProvider, model: string): boolean => {
    if (excludedInstances.has(candidate.instanceId)) return false;
    const key = resolveAccountKey(nativeAccountReport(candidate));
    if (key && excludedAccountKeys.has(key)) return false;
    if (
      !candidate.enabled ||
      !candidate.installed ||
      candidate.auth.status === "unauthenticated" ||
      !isProviderAvailable(candidate)
    ) {
      return false;
    }
    if (!isProjectInstanceEnabled(settings, projectId, candidate)) return false;
    if (exhaustedUsageWindow(candidate, now, model)) return false;
    if (!isRuntimeModeCompatible(candidate, runtimeMode)) return false;
    if (!isModelCompatible(candidate, model)) return false;
    return true;
  };

  const sortCandidates = (
    candidates: readonly ServerProvider[],
    model: string,
  ): readonly ServerProvider[] =>
    [...candidates].sort((left, right) => {
      const usageDelta =
        maxActiveUsagePercent(left, now, model) - maxActiveUsagePercent(right, now, model);
      if (usageDelta !== 0) return usageDelta;
      const settingsDelta =
        (settingsInstanceOrder.get(left.instanceId) ?? Number.MAX_SAFE_INTEGER) -
        (settingsInstanceOrder.get(right.instanceId) ?? Number.MAX_SAFE_INTEGER);
      if (settingsDelta !== 0) return settingsDelta;
      return (
        (providerOrder.get(left.instanceId) ?? Number.MAX_SAFE_INTEGER) -
        (providerOrder.get(right.instanceId) ?? Number.MAX_SAFE_INTEGER)
      );
    });

  // Tier 1: Same provider type, next connected distinct account.
  const sameDriverCandidates = sortCandidates(
    providers.filter(
      (candidate) =>
        candidate.driver === currentProvider.driver &&
        isCandidateEligible(candidate, currentSelection.model),
    ),
    currentSelection.model,
  );
  const tier1Target = sameDriverCandidates[0];
  if (tier1Target) {
    return {
      kind: "same_provider_account",
      target: buildReconciledSelection(
        tier1Target,
        currentSelection.model,
        currentSelection.options,
      ),
      fromProvider: currentProvider,
      toProvider: tier1Target,
    };
  }

  // Tier 2: Cross-provider pass-off graph walk after all accounts of the current driver are exhausted.
  const visitedSteps = new Set<string>();
  let walkDriver: ProviderDriverKind = currentProvider.driver;
  let walkModel = currentSelection.model;

  for (let hop = 0; hop < MAX_PASS_OFF_HOPS; hop += 1) {
    const stepKey = `${walkDriver}\0${normalizeModelSlug(walkModel, walkDriver) ?? walkModel}`;
    if (visitedSteps.has(stepKey)) break;
    visitedSteps.add(stepKey);

    const exactRule =
      settings.usageLimitPassOffRules.find(
        (rule) => rule.sourceDriver === walkDriver && rule.sourceModel === walkModel,
      ) ??
      settings.usageLimitPassOffRules.find(
        (rule) =>
          rule.sourceDriver === walkDriver &&
          rule.sourceModel !== null &&
          modelsMatchForDriver(walkDriver, rule.sourceModel, walkModel),
      );
    const driverWideRule =
      exactRule ??
      settings.usageLimitPassOffRules.find(
        (rule) => rule.sourceDriver === walkDriver && rule.sourceModel === null,
      );

    let matched: { readonly target: ModelSelection; readonly ruleId: string | null } | null = null;
    if (driverWideRule) {
      matched = { target: driverWideRule.target, ruleId: driverWideRule.id };
    } else if (settings.fallbackModelSelection !== null) {
      const fallbackDriver = resolveInstanceDriver(
        settings.fallbackModelSelection.instanceId,
        providers,
        settings,
      );
      if (fallbackDriver !== undefined && fallbackDriver !== walkDriver) {
        matched = { target: settings.fallbackModelSelection, ruleId: null };
      }
    }

    if (!matched) break;

    const targetProvider = providers.find(
      (entry) => entry.instanceId === matched.target.instanceId,
    );
    const targetDriver = resolveInstanceDriver(matched.target.instanceId, providers, settings);

    if (targetProvider && isCandidateEligible(targetProvider, matched.target.model)) {
      return {
        kind: "cross_provider_handoff",
        target: buildReconciledSelection(
          targetProvider,
          matched.target.model,
          matched.target.options,
        ),
        fromProvider: currentProvider,
        toProvider: targetProvider,
        ruleId: matched.ruleId,
      };
    }

    if (targetDriver !== undefined) {
      const otherAccounts = sortCandidates(
        providers.filter(
          (candidate) =>
            candidate.driver === targetDriver &&
            candidate.instanceId !== matched.target.instanceId &&
            isCandidateEligible(candidate, matched.target.model),
        ),
        matched.target.model,
      );
      const healthyAlternate = otherAccounts[0];
      if (healthyAlternate) {
        return {
          kind: "cross_provider_handoff",
          target: buildReconciledSelection(
            healthyAlternate,
            matched.target.model,
            matched.target.options,
          ),
          fromProvider: currentProvider,
          toProvider: healthyAlternate,
          ruleId: matched.ruleId,
        };
      }

      walkDriver = targetDriver;
      walkModel = matched.target.model;
    } else {
      break;
    }
  }

  return { kind: "none", reason: "no_eligible_target" };
}

export type PassOffRuleIssue = "self_loop" | "cycle";

/**
 * Flags pass-off rules that loop directly onto themselves or form a multi-hop cycle.
 */
export function detectPassOffRuleIssues(
  rules: readonly UsageLimitPassOffRule[],
  providers: readonly ServerProvider[],
  settings: Pick<ServerSettings, "providerInstances">,
): ReadonlyMap<string, PassOffRuleIssue> {
  const issues = new Map<string, PassOffRuleIssue>();

  const nextRuleFor = (
    driver: ProviderDriverKind,
    model: string | null,
  ): UsageLimitPassOffRule | undefined => {
    if (model !== null) {
      const exact =
        rules.find((rule) => rule.sourceDriver === driver && rule.sourceModel === model) ??
        rules.find(
          (rule) =>
            rule.sourceDriver === driver &&
            rule.sourceModel !== null &&
            modelsMatchForDriver(driver, rule.sourceModel, model),
        );
      if (exact) return exact;
    }
    return rules.find((rule) => rule.sourceDriver === driver && rule.sourceModel === null);
  };

  for (const rule of rules) {
    const targetDriver = resolveInstanceDriver(rule.target.instanceId, providers, settings);
    if (!targetDriver) continue;

    if (
      targetDriver === rule.sourceDriver &&
      (rule.sourceModel === null ||
        modelsMatchForDriver(rule.sourceDriver, rule.sourceModel, rule.target.model))
    ) {
      issues.set(rule.id, "self_loop");
      continue;
    }

    const visitedRuleIds = new Set<string>([rule.id]);
    let walkDriver: ProviderDriverKind = targetDriver;
    let walkModel: string | null = rule.target.model;

    for (let hop = 0; hop < MAX_PASS_OFF_HOPS; hop += 1) {
      const next = nextRuleFor(walkDriver, walkModel);
      if (!next) break;
      if (next.id === rule.id) {
        issues.set(rule.id, "cycle");
        break;
      }
      if (visitedRuleIds.has(next.id)) {
        break;
      }
      visitedRuleIds.add(next.id);
      const nextDriver = resolveInstanceDriver(next.target.instanceId, providers, settings);
      if (!nextDriver) break;
      walkDriver = nextDriver;
      walkModel = next.target.model;
    }
  }

  return issues;
}

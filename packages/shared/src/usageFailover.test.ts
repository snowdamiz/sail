import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type UsageLimitPassOffRule,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { detectPassOffRuleIssues, resolveUsageLimitFailoverTarget } from "./usageFailover.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const baseWindow = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 20,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

const claudeOpusModel: ServerProviderModel = {
  slug: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "max", label: "Max" },
        ],
      },
      {
        id: "fastMode",
        label: "Fast",
        type: "boolean",
        currentValue: false,
      },
    ],
  },
};

const codexSolModel: ServerProviderModel = {
  slug: "gpt-6.2-sol",
  name: "GPT-6.2 Sol",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
        ],
      },
    ],
  },
};

const antigravityModel: ServerProviderModel = {
  slug: "gemini-3.5-pro",
  name: "Gemini 3.5 Pro",
  isCustom: false,
  capabilities: {
    optionDescriptors: [],
  },
};

function makeProvider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [claudeOpusModel],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function withUsage(usedPercent: number) {
  return {
    checkedAt: "2026-09-03T11:00:00.000Z",
    windows: [{ ...baseWindow, usedPercent }],
  };
}

function makeSettings(overrides: Partial<ServerSettings> = {}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...overrides,
  };
}

describe("resolveUsageLimitFailoverTarget", () => {
  it("returns disabled when autoFailoverOnUsageLimit is false", () => {
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      usageLimits: withUsage(100),
    });
    const claude2 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_2"),
      auth: { status: "authenticated", email: "second@example.com" },
      usageLimits: withUsage(10),
    });

    const result = resolveUsageLimitFailoverTarget({
      currentSelection: {
        instanceId: claude1.instanceId,
        model: "claude-opus-5-5",
      },
      providers: [claude1, claude2],
      settings: makeSettings({ autoFailoverOnUsageLimit: false }),
      projectId: null,
      now,
    });

    expect(result).toEqual({ kind: "none", reason: "disabled" });
  });

  it("transfers to the lowest-usage connected 2nd and 3rd account of the same provider", () => {
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      auth: { status: "authenticated", email: "first@example.com" },
      usageLimits: withUsage(100),
    });
    const claude2 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_2"),
      auth: { status: "authenticated", email: "second@example.com" },
      usageLimits: withUsage(65),
    });
    const claude3 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_3"),
      auth: { status: "authenticated", email: "third@example.com" },
      usageLimits: withUsage(15),
    });

    const firstHop = resolveUsageLimitFailoverTarget({
      currentSelection: {
        instanceId: claude1.instanceId,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      providers: [claude1, claude2, claude3],
      settings: makeSettings(),
      projectId: null,
      now,
    });

    expect(firstHop.kind).toBe("same_provider_account");
    if (firstHop.kind !== "same_provider_account") throw new Error("expected Tier 1 failover");
    expect(firstHop.target).toEqual({
      instanceId: claude3.instanceId,
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(firstHop.toProvider.instanceId).toBe(claude3.instanceId);

    const secondHop = resolveUsageLimitFailoverTarget({
      currentSelection: firstHop.target,
      providers: [claude1, claude2, { ...claude3, usageLimits: withUsage(100) }],
      settings: makeSettings(),
      projectId: null,
      now,
      attemptedInstanceIds: new Set([claude1.instanceId]),
    });

    expect(secondHop.kind).toBe("same_provider_account");
    if (secondHop.kind !== "same_provider_account") throw new Error("expected second Tier 1 hop");
    expect(secondHop.target.instanceId).toBe(claude2.instanceId);
    expect(secondHop.target.model).toBe("claude-opus-5-5");
  });

  it("deduplicates instances sharing the same email or workspace to prevent ping-pong", () => {
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      auth: { status: "authenticated", email: "Alice@Example.com", workspaceId: "ws-1" },
      usageLimits: withUsage(100),
    });
    const claude1Duplicate = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_alias"),
      auth: { status: "authenticated", email: "alice@example.com", workspaceId: "ws-1" },
      usageLimits: withUsage(5),
    });
    const claudeDifferentWorkspace = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_team"),
      auth: { status: "authenticated", email: "alice@example.com", workspaceId: "ws-2" },
      usageLimits: withUsage(30),
    });

    const result = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude1.instanceId, model: "claude-opus-5-5" },
      providers: [claude1, claude1Duplicate, claudeDifferentWorkspace],
      settings: makeSettings(),
      projectId: null,
      now,
    });

    expect(result.kind).toBe("same_provider_account");
    if (result.kind !== "same_provider_account") throw new Error("expected Tier 1 failover");
    expect(result.target.instanceId).toBe(claudeDifferentWorkspace.instanceId);

    const onlyDuplicate = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude1.instanceId, model: "claude-opus-5-5" },
      providers: [claude1, claude1Duplicate],
      settings: makeSettings(),
      projectId: null,
      now,
    });
    expect(onlyDuplicate).toEqual({ kind: "none", reason: "no_eligible_target" });
  });

  it("passes off to a per-model rule with higher priority than a driver-wide rule when all Claude accounts are exhausted", () => {
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      auth: { status: "authenticated", email: "a@example.com" },
      usageLimits: withUsage(100),
    });
    const claude2 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_2"),
      auth: { status: "authenticated", email: "b@example.com" },
      usageLimits: withUsage(100),
    });
    const codex = makeProvider({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      models: [codexSolModel],
      usageLimits: withUsage(25),
    });
    const antigravity = makeProvider({
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      models: [antigravityModel],
      usageLimits: withUsage(10),
    });

    const rules: readonly UsageLimitPassOffRule[] = [
      {
        id: "driver-wide",
        sourceDriver: ProviderDriverKind.make("claudeAgent"),
        sourceModel: null,
        target: { instanceId: antigravity.instanceId, model: "gemini-3.5-pro" },
      },
      {
        id: "opus-exact",
        sourceDriver: ProviderDriverKind.make("claudeAgent"),
        sourceModel: "claude-opus-5-5",
        target: {
          instanceId: codex.instanceId,
          model: "gpt-6.2-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    ];

    const exact = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude1.instanceId, model: "claude-opus-5-5" },
      providers: [claude1, claude2, codex, antigravity],
      settings: makeSettings({ usageLimitPassOffRules: rules }),
      projectId: null,
      now,
    });
    expect(exact.kind).toBe("cross_provider_handoff");
    if (exact.kind !== "cross_provider_handoff") throw new Error("expected cross-provider handoff");
    expect(exact.ruleId).toBe("opus-exact");
    expect(exact.target).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-6.2-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });

    const wildcard = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude1.instanceId, model: "claude-sonnet-5-0" },
      providers: [claude1, claude2, codex, antigravity],
      settings: makeSettings({ usageLimitPassOffRules: rules }),
      projectId: null,
      now,
    });
    expect(wildcard.kind).toBe("cross_provider_handoff");
    if (wildcard.kind !== "cross_provider_handoff")
      throw new Error("expected driver-wide cross-provider handoff");
    expect(wildcard.ruleId).toBe("driver-wide");
    expect(wildcard.target).toEqual({
      instanceId: antigravity.instanceId,
      model: "gemini-3.5-pro",
    });
  });

  it("picks the target provider's 2nd account automatically when its primary account is also exhausted", () => {
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      usageLimits: withUsage(100),
    });
    const codex1 = makeProvider({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      auth: { status: "authenticated", email: "codex1@example.com" },
      models: [codexSolModel],
      usageLimits: withUsage(100),
    });
    const codex2 = makeProvider({
      instanceId: ProviderInstanceId.make("codex_2"),
      driver: ProviderDriverKind.make("codex"),
      auth: { status: "authenticated", email: "codex2@example.com" },
      models: [codexSolModel],
      usageLimits: withUsage(35),
    });

    const result = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude1.instanceId, model: "claude-opus-5-5" },
      providers: [claude1, codex1, codex2],
      settings: makeSettings({
        usageLimitPassOffRules: [
          {
            id: "claude-to-codex",
            sourceDriver: ProviderDriverKind.make("claudeAgent"),
            sourceModel: "claude-opus-5-5",
            target: {
              instanceId: codex1.instanceId,
              model: "gpt-6.2-sol",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          },
        ],
      }),
      projectId: null,
      now,
    });

    expect(result.kind).toBe("cross_provider_handoff");
    if (result.kind !== "cross_provider_handoff")
      throw new Error("expected cross-provider handoff");
    expect(result.target).toEqual({
      instanceId: codex2.instanceId,
      model: "gpt-6.2-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(result.toProvider.instanceId).toBe(codex2.instanceId);
  });

  it("walks multi-hop pass-off chains and terminates cleanly on cycles", () => {
    const claude = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      usageLimits: withUsage(100),
    });
    const codex = makeProvider({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      models: [codexSolModel],
      usageLimits: withUsage(100),
    });
    const antigravity = makeProvider({
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      models: [antigravityModel],
      usageLimits: withUsage(10),
    });

    const chainRules: readonly UsageLimitPassOffRule[] = [
      {
        id: "r1",
        sourceDriver: ProviderDriverKind.make("claudeAgent"),
        sourceModel: null,
        target: { instanceId: codex.instanceId, model: "gpt-6.2-sol" },
      },
      {
        id: "r2",
        sourceDriver: ProviderDriverKind.make("codex"),
        sourceModel: null,
        target: { instanceId: antigravity.instanceId, model: "gemini-3.5-pro" },
      },
    ];

    const multiHop = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
      providers: [claude, codex, antigravity],
      settings: makeSettings({ usageLimitPassOffRules: chainRules }),
      projectId: null,
      now,
    });
    expect(multiHop.kind).toBe("cross_provider_handoff");
    if (multiHop.kind !== "cross_provider_handoff") throw new Error("expected multi-hop handoff");
    expect(multiHop.target).toEqual({
      instanceId: antigravity.instanceId,
      model: "gemini-3.5-pro",
    });
    expect(multiHop.ruleId).toBe("r2");

    const cycleRules: readonly UsageLimitPassOffRule[] = [
      {
        id: "c1",
        sourceDriver: ProviderDriverKind.make("claudeAgent"),
        sourceModel: null,
        target: { instanceId: codex.instanceId, model: "gpt-6.2-sol" },
      },
      {
        id: "c2",
        sourceDriver: ProviderDriverKind.make("codex"),
        sourceModel: null,
        target: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
      },
    ];

    const cycleResult = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
      providers: [claude, codex],
      settings: makeSettings({ usageLimitPassOffRules: cycleRules }),
      projectId: null,
      now,
    });
    expect(cycleResult).toEqual({ kind: "none", reason: "no_eligible_target" });

    const issues = detectPassOffRuleIssues(cycleRules, [claude, codex], makeSettings());
    expect(issues.get("c1")).toBe("cycle");
    expect(issues.get("c2")).toBe("cycle");
  });

  it("enforces attemptedInstanceIds loop protection across sequential failovers", () => {
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      auth: { status: "authenticated", email: "a@example.com" },
      usageLimits: withUsage(10),
    });
    const claude2 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_2"),
      auth: { status: "authenticated", email: "b@example.com" },
      usageLimits: withUsage(10),
    });

    const result = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude2.instanceId, model: "claude-opus-5-5" },
      providers: [claude1, claude2],
      settings: makeSettings(),
      projectId: null,
      now,
      attemptedInstanceIds: new Set([claude1.instanceId]),
    });

    expect(result).toEqual({ kind: "none", reason: "no_eligible_target" });
  });

  it("strips incompatible model options cleanly on Tier 1 and Tier 2 handoff", () => {
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      auth: { status: "authenticated", email: "a@example.com" },
      usageLimits: withUsage(100),
    });
    const claude2 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_2"),
      auth: { status: "authenticated", email: "b@example.com" },
      models: [
        {
          ...claudeOpusModel,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
            ],
          },
        },
      ],
      usageLimits: withUsage(10),
    });

    const tier1 = resolveUsageLimitFailoverTarget({
      currentSelection: {
        instanceId: claude1.instanceId,
        model: "claude-opus-5-5",
        options: [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
          { id: "unknownOpt", value: "foo" },
        ],
      },
      providers: [claude1, claude2],
      settings: makeSettings(),
      projectId: null,
      now,
    });
    expect(tier1.kind).toBe("same_provider_account");
    if (tier1.kind !== "same_provider_account") throw new Error("expected Tier 1");
    expect(tier1.target.options).toBeUndefined();

    const codex = makeProvider({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      models: [codexSolModel],
      usageLimits: withUsage(10),
    });

    const tier2 = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude1.instanceId, model: "claude-opus-5-5" },
      providers: [claude1, codex],
      settings: makeSettings({
        usageLimitPassOffRules: [
          {
            id: "r1",
            sourceDriver: ProviderDriverKind.make("claudeAgent"),
            sourceModel: null,
            target: {
              instanceId: codex.instanceId,
              model: "gpt-6.2-sol",
              options: [
                { id: "reasoningEffort", value: "high" },
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ],
            },
          },
        ],
      }),
      projectId: null,
      now,
    });
    expect(tier2.kind).toBe("cross_provider_handoff");
    if (tier2.kind !== "cross_provider_handoff") throw new Error("expected Tier 2");
    expect(tier2.target.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });

  it("respects project-level provider overrides and runtime mode compatibility", () => {
    const projectId = ProjectId.make("proj-1");
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      auth: { status: "authenticated", email: "a@example.com" },
      usageLimits: withUsage(100),
    });
    const claude2 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_2"),
      auth: { status: "authenticated", email: "b@example.com" },
      usageLimits: withUsage(10),
    });
    const claude3 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent_3"),
      auth: { status: "authenticated", email: "c@example.com" },
      supportedRuntimeModes: ["approval-required"],
      usageLimits: withUsage(5),
    });

    const result = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude1.instanceId, model: "claude-opus-5-5" },
      providers: [claude1, claude2, claude3],
      settings: makeSettings({
        projectSettingsOverrides: {
          [projectId]: {
            providerInstances: {
              [claude2.instanceId]: { enabled: false },
            },
          },
        },
      }),
      projectId,
      now,
      runtimeMode: "full-access",
    });

    expect(result).toEqual({ kind: "none", reason: "no_eligible_target" });
  });

  it("falls back to global fallbackModelSelection when no pass-off rule matches and driver differs", () => {
    const claude1 = makeProvider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      usageLimits: withUsage(100),
    });
    const codex = makeProvider({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      models: [codexSolModel],
      usageLimits: withUsage(20),
    });

    const result = resolveUsageLimitFailoverTarget({
      currentSelection: { instanceId: claude1.instanceId, model: "claude-opus-5-5" },
      providers: [claude1, codex],
      settings: makeSettings({
        fallbackModelSelection: { instanceId: codex.instanceId, model: "gpt-6.2-sol" },
      }),
      projectId: null,
      now,
    });

    expect(result.kind).toBe("cross_provider_handoff");
    if (result.kind !== "cross_provider_handoff") throw new Error("expected fallback handoff");
    expect(result.ruleId).toBeNull();
    expect(result.target).toEqual({ instanceId: codex.instanceId, model: "gpt-6.2-sol" });
  });

  it("detects direct self-loop rules for UI validation", () => {
    const claude = makeProvider({ instanceId: ProviderInstanceId.make("claudeAgent") });
    const issues = detectPassOffRuleIssues(
      [
        {
          id: "self",
          sourceDriver: ProviderDriverKind.make("claudeAgent"),
          sourceModel: "claude-opus-5-5",
          target: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
        },
      ],
      [claude],
      makeSettings(),
    );
    expect(issues.get("self")).toBe("self_loop");
  });
});

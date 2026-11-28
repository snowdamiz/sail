// @effect-diagnostics nodeBuiltinImport:off -- Tests inspect real materialized files and symlinks on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import {
  makeClaudeQueryOptions,
  makeClaudeUserMessage,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  BUILTIN_PSTACK_PACK_ID,
  findReferencedBuiltinSkills,
  materializeBuiltinPstack,
  materializeBuiltinPstackSync,
  mergeBuiltinSkills,
  parseBuiltinSkillFrontmatter,
  prependBuiltinSkillPromptHint,
  prependClaudePotetoModeDirective,
  resolveBuiltinSkillPromptHint,
  resolveBundledPstackSourceDir,
  rewriteUnprefixedBuiltinClaudeCommand,
} from "./BuiltinSkills.ts";

const BANNED_CURSOR_SLUG_MANDATES: ReadonlyArray<string> = [
  "claude-opus-5-5-xhigh-fast",
  "claude-opus-5-5-high-fast",
  "claude-opus-5-5-medium-fast",
  "claude-opus-5-5-low-fast",
  "claude-fable-5-2-high",
  "gemini-4-neon-xhigh",
  "Opus 5.5 always runs its -fast slug",
  "Fable 5.2 and Gemini have no fast slug",
  "an old slug is one that matches `grok-*`",
];

function walkFiles(dir: string): Array<string> {
  const results: Array<string> = [];
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

describe("BuiltinSkills", () => {
  it("materializes pstack atomically with a symlink, is idempotent, and cleans stale versions", () => {
    const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sail-builtin-skills-"));
    try {
      const builtinDir = NodePath.join(tempRoot, "builtin-skills");
      const first = materializeBuiltinPstackSync(builtinDir);
      assert.isDefined(first);
      assert.equal(first.id, BUILTIN_PSTACK_PACK_ID);
      assert.isTrue(NodeFS.lstatSync(first.skillsDir).isSymbolicLink());
      assert.equal(NodeFS.realpathSync(first.skillsDir), NodeFS.realpathSync(first.versionDir));
      assert.isTrue(NodeFS.existsSync(NodePath.join(first.skillsDir, "poteto-mode", "SKILL.md")));
      assert.isTrue(
        NodeFS.existsSync(NodePath.join(first.pluginDir, ".claude-plugin", "plugin.json")),
      );
      assert.isTrue(NodeFS.existsSync(NodePath.join(first.pluginDir, "agents", "poteto-agent.md")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(first.pluginDir, "LICENSE")));
      assert.include(
        NodeFS.readFileSync(NodePath.join(first.pluginDir, "LICENSE"), "utf8"),
        "Lauren Tan",
      );
      if (HostProcess.Platform.defaultValue() !== "win32") {
        for (const helper of [
          NodePath.join(first.skillsDir, "statechart", "scripts", "statechart"),
          NodePath.join(first.skillsDir, "poteto-mode", "scripts", "watch-pr", "watch-pr"),
          NodePath.join(first.skillsDir, "poteto-mode", "scripts", "worktree-audit.sh"),
          NodePath.join(first.skillsDir, "show-me-your-work", "scripts", "log.sh"),
        ]) {
          assert.notEqual(
            NodeFS.statSync(helper).mode & 0o111,
            0,
            `expected executable bit on ${helper}`,
          );
        }
      }

      // Plant a stale version directory and verify re-materialization is idempotent and cleans it up.
      const staleVersionDir = NodePath.join(first.pluginDir, "skills.versions", "stale-deadbeef");
      NodeFS.mkdirSync(staleVersionDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(staleVersionDir, "old.txt"), "stale");

      const second = materializeBuiltinPstackSync(builtinDir);
      assert.isDefined(second);
      assert.equal(second.hash, first.hash);
      assert.equal(second.skillsDir, first.skillsDir);
      assert.equal(second.skills.length, first.skills.length);
      assert.isFalse(NodeFS.existsSync(staleVersionDir));
    } finally {
      NodeFS.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves bundled pstack from a SEA CLI executable sibling directory", () => {
    const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sail-sea-skills-"));
    try {
      const fakeExec = NodePath.join(tempRoot, "t3");
      const siblingSkill = NodePath.join(
        tempRoot,
        "builtin-skills",
        "pstack",
        "skills",
        "poteto-mode",
      );
      NodeFS.mkdirSync(siblingSkill, { recursive: true });
      NodeFS.writeFileSync(fakeExec, "");
      NodeFS.writeFileSync(
        NodePath.join(siblingSkill, "SKILL.md"),
        "---\nname: poteto-mode\ndescription: SEA fixture\n---\n",
      );

      const resolved = resolveBundledPstackSourceDir({ execPath: fakeExec });
      assert.equal(resolved, NodePath.join(tempRoot, "builtin-skills", "pstack"));
    } finally {
      NodeFS.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("parses valid frontmatter for every vendored pstack skill", () => {
    const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sail-frontmatter-"));
    try {
      const pack = materializeBuiltinPstackSync(tempRoot);
      assert.isDefined(pack);
      assert.isAbove(pack.skills.length, 40);

      for (const skill of pack.skills) {
        assert.isAbove(skill.name.length, 0);
        assert.isDefined(skill.description, `missing description on skill ${skill.name}`);
        assert.isAbove(skill.description.length, 0);
        assert.equal(skill.scope, "builtin");
        assert.isTrue(skill.enabled);
        assert.isTrue(NodeFS.existsSync(skill.path));
      }

      const potetoMode = pack.skills.find((skill) => skill.name === "poteto-mode");
      assert.isDefined(potetoMode);
      assert.isTrue(potetoMode.userInvocationOnly);

      const setupPstack = pack.skills.find((skill) => skill.name === "setup-pstack");
      assert.isDefined(setupPstack);
      assert.isUndefined(setupPstack.userInvocationOnly);

      const makeBotUi = pack.skills.find((skill) => skill.name === "make-bot-ui");
      assert.isDefined(makeBotUi);
      assert.include(makeBotUi.description ?? "", "webhook");

      const parsed = parseBuiltinSkillFrontmatter(
        "---\nname: demo\ndescription: Demo skill\ndisable-model-invocation: true\nuser-invocable: false\n---\n",
      );
      assert.deepEqual(parsed, {
        name: "demo",
        description: "Demo skill",
        userInvocationOnly: true,
        userInvocable: false,
      });
    } finally {
      NodeFS.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("contains zero hardcoded Cursor -fast slug mandates in vendored pstack files", () => {
    const sourceDir = resolveBundledPstackSourceDir();
    assert.isDefined(sourceDir);
    assert.isTrue(NodeFS.existsSync(NodePath.join(sourceDir, "UPSTREAM.md")));

    const files = walkFiles(sourceDir);
    assert.isAbove(files.length, 40);
    for (const file of files) {
      const content = NodeFS.readFileSync(file, "utf8");
      for (const banned of BANNED_CURSOR_SLUG_MANDATES) {
        assert.isFalse(
          content.includes(banned),
          `Found banned Cursor slug mandate "${banned}" in ${NodePath.relative(sourceDir, file)}`,
        );
      }
    }

    const potetoAgent = NodeFS.readFileSync(
      NodePath.join(sourceDir, "agents", "poteto-agent.md"),
      "utf8",
    );
    assert.notMatch(potetoAgent, /^model:\s*claude-/m);
  });

  it("preserves user and workspace skill precedence when merging built-in skills", () => {
    const userOverride: ServerProviderSkill = {
      name: "poteto-mode",
      description: "Custom workspace override",
      path: "/repo/.agents/skills/poteto-mode/SKILL.md",
      scope: "project",
      enabled: true,
    };
    const builtinSkills: ReadonlyArray<ServerProviderSkill> = [
      {
        name: "poteto-mode",
        description: "Built-in poteto-mode",
        path: "/state/builtin-skills/pstack/skills/poteto-mode/SKILL.md",
        scope: "builtin",
        enabled: true,
        userInvocationOnly: true,
      },
      {
        name: "arena",
        description: "Built-in arena",
        path: "/state/builtin-skills/pstack/skills/arena/SKILL.md",
        scope: "builtin",
        enabled: true,
        userInvocationOnly: true,
      },
    ];

    const merged = mergeBuiltinSkills([userOverride], builtinSkills);
    assert.deepEqual(
      merged.map((skill) => ({ name: skill.name, scope: skill.scope, path: skill.path })),
      [
        {
          name: "poteto-mode",
          scope: "project",
          path: "/repo/.agents/skills/poteto-mode/SKILL.md",
        },
        {
          name: "arena",
          scope: "builtin",
          path: "/state/builtin-skills/pstack/skills/arena/SKILL.md",
        },
      ],
    );
  });

  it("resolves built-in skill prompt hints only when a built-in skill is referenced", () => {
    const pack = {
      skillsDir: "/state/builtin-skills/pstack/skills",
      skills: [
        {
          name: "poteto-mode",
          description: "Poteto mode",
          path: "/state/builtin-skills/pstack/skills/poteto-mode/SKILL.md",
          scope: "builtin",
          enabled: true,
          userInvocationOnly: true,
        },
        {
          name: "arena",
          description: "Arena",
          path: "/state/builtin-skills/pstack/skills/arena/SKILL.md",
          scope: "builtin",
          enabled: true,
          userInvocationOnly: true,
        },
      ] satisfies ReadonlyArray<ServerProviderSkill>,
    };

    assert.isUndefined(resolveBuiltinSkillPromptHint("Fix the login bug", pack));
    assert.isUndefined(resolveBuiltinSkillPromptHint("/compact", pack));
    assert.isUndefined(resolveBuiltinSkillPromptHint("Price is $100", pack));
    assert.equal(prependBuiltinSkillPromptHint("Regular prompt", pack), "Regular prompt");

    const dollarHint = resolveBuiltinSkillPromptHint("Use $poteto-mode to fix this", pack);
    assert.isDefined(dollarHint);
    assert.include(dollarHint, "/state/builtin-skills/pstack/skills/poteto-mode/SKILL.md");
    assert.include(dollarHint, "/state/builtin-skills/pstack/skills");

    const slashHint = resolveBuiltinSkillPromptHint("/poteto-mode fix this", pack);
    assert.isDefined(slashHint);
    assert.include(slashHint, "/state/builtin-skills/pstack/skills/poteto-mode/SKILL.md");

    const prefixedHint = resolveBuiltinSkillPromptHint("/pstack:poteto-mode fix this", pack);
    assert.isDefined(prefixedHint);
    assert.include(prefixedHint, "/state/builtin-skills/pstack/skills/poteto-mode/SKILL.md");

    const multi = findReferencedBuiltinSkills("/poteto-mode then $arena", pack.skills);
    assert.deepEqual(
      multi.map((skill) => skill.name),
      ["poteto-mode", "arena"],
    );
  });

  it("wires Claude local plugin without touching systemPrompt and rewrites unprefixed built-in commands", () => {
    const withoutBuiltin = makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "thread-1",
      resume: false,
      cwd: "/repo",
    });
    const withBuiltin = makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "thread-1",
      resume: false,
      cwd: "/repo",
      builtinPluginDirectories: ["/state/builtin-skills/pstack"],
    });

    assert.deepEqual(withBuiltin.systemPrompt, withoutBuiltin.systemPrompt);
    assert.deepEqual(withBuiltin.plugins, [
      { type: "local", path: "/state/builtin-skills/pstack" },
    ]);

    const skills = new Map([
      [
        "poteto-mode",
        {
          path: "/state/builtin-skills/pstack/skills/poteto-mode/SKILL.md",
          scope: "builtin",
          userInvocationOnly: true,
        },
      ],
      [
        "custom-override",
        {
          path: "/repo/.claude/skills/custom-override/SKILL.md",
          scope: "project",
        },
      ],
    ]);

    assert.equal(
      rewriteUnprefixedBuiltinClaudeCommand("/poteto-mode fix bug", skills),
      "/pstack:poteto-mode fix bug",
    );
    assert.equal(
      rewriteUnprefixedBuiltinClaudeCommand("/pstack:poteto-mode fix bug", skills),
      "/pstack:poteto-mode fix bug",
    );
    assert.equal(
      rewriteUnprefixedBuiltinClaudeCommand("/custom-override do work", skills),
      "/custom-override do work",
    );

    const dollarMessage = makeClaudeUserMessage({
      text: "$poteto-mode fix bug",
      skills,
    });
    assert.deepEqual(dollarMessage.message.content, [
      { type: "text", text: "/pstack:poteto-mode fix bug" },
    ]);

    const slashMessage = makeClaudeUserMessage({
      text: "/poteto-mode fix bug",
      skills,
    });
    assert.equal(slashMessage.message.content, "/pstack:poteto-mode fix bug");
  });

  it("forces poteto-mode hints for non-Claude prompts and prepends $poteto-mode for Claude without duplication", () => {
    const pack = {
      skillsDir: "/state/builtin-skills/pstack/skills",
      skills: [
        {
          name: "poteto-mode",
          description: "Poteto mode",
          path: "/state/builtin-skills/pstack/skills/poteto-mode/SKILL.md",
          scope: "builtin",
          enabled: true,
          userInvocationOnly: true,
        },
        {
          name: "arena",
          description: "Arena",
          path: "/state/builtin-skills/pstack/skills/arena/SKILL.md",
          scope: "builtin",
          enabled: true,
          userInvocationOnly: true,
        },
      ] satisfies ReadonlyArray<ServerProviderSkill>,
    };

    const forcedHint = resolveBuiltinSkillPromptHint("Ship the toggle", pack, {
      forcePotetoMode: true,
    });
    assert.isDefined(forcedHint);
    assert.include(forcedHint, "Poteto mode is enabled for this session");
    assert.include(
      forcedHint,
      "- poteto-mode: /state/builtin-skills/pstack/skills/poteto-mode/SKILL.md",
    );

    const combinedHint = resolveBuiltinSkillPromptHint("Run $arena on this", pack, {
      forcePotetoMode: true,
    });
    assert.isDefined(combinedHint);
    assert.include(
      combinedHint,
      "- poteto-mode: /state/builtin-skills/pstack/skills/poteto-mode/SKILL.md",
    );
    assert.include(combinedHint, "- arena: /state/builtin-skills/pstack/skills/arena/SKILL.md");

    const dedupedHint = resolveBuiltinSkillPromptHint("Use $poteto-mode now", pack, {
      forcePotetoMode: true,
    });
    assert.isDefined(dedupedHint);
    assert.equal(dedupedHint.split("- poteto-mode:").length - 1, 1);

    assert.equal(
      prependClaudePotetoModeDirective("Ship the toggle", pack),
      "$poteto-mode\n\nShip the toggle",
    );
    assert.equal(prependClaudePotetoModeDirective("   ", pack), "$poteto-mode");
    assert.equal(
      prependClaudePotetoModeDirective("Use $poteto-mode here", pack),
      "Use $poteto-mode here",
    );
    assert.equal(
      prependClaudePotetoModeDirective("/poteto-mode ship it", pack),
      "/poteto-mode ship it",
    );
    assert.equal(
      prependClaudePotetoModeDirective("/pstack:poteto-mode ship it", pack),
      "/pstack:poteto-mode ship it",
    );

    const skills = new Map([
      [
        "poteto-mode",
        {
          path: "/state/builtin-skills/pstack/skills/poteto-mode/SKILL.md",
          scope: "builtin",
          userInvocationOnly: true,
        },
      ],
    ]);
    const directiveText = prependClaudePotetoModeDirective("Ship the toggle", pack);
    const directMessage = makeClaudeUserMessage({
      text: directiveText,
      skills,
    });
    assert.deepEqual(directMessage.message.content, [
      { type: "text", text: "/pstack:poteto-mode\n\nShip the toggle" },
    ]);

    const handoffPrefix = "Prior session context.\n\n";
    const claudeMessage = makeClaudeUserMessage({
      text: handoffPrefix + directiveText,
      skills,
      skillMentionsFrom: handoffPrefix.length,
    });
    assert.deepEqual(claudeMessage.message.content, [
      { type: "text", text: "Prior session context.\n\n/poteto-mode\n\nShip the toggle" },
      { type: "text", text: "/pstack:poteto-mode\n\nShip the toggle" },
    ]);
  });
});

it.layer(NodeServices.layer)("BuiltinSkills server integration", (it) => {
  it.effect(
    "derives builtinSkillsDir under stateDir and merges into ProviderRegistry snapshots",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "sail-builtin-registry-" });

        const userOverrideSkill: ServerProviderSkill = {
          name: "poteto-mode",
          description: "Repo override",
          path: "/workspace/.agents/skills/poteto-mode/SKILL.md",
          scope: "project",
          enabled: true,
        };
        const driver = ProviderDriverKind.make("codex");
        const baseSnapshot: ServerProvider = {
          instanceId: ProviderInstanceId.make("codex"),
          driver,
          displayName: "Codex",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [userOverrideSkill],
        };

        const instance: ProviderInstance = {
          instanceId: baseSnapshot.instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: "codex:builtin-test" },
          displayName: "Codex",
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(baseSnapshot),
            streamChanges: Stream.empty,
            refresh: Effect.succeed(baseSnapshot),
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd: () =>
            Effect.succeed({
              ...baseSnapshot,
              skills: [userOverrideSkill],
            }),
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        };
        const changes = yield* PubSub.unbounded<void>();

        const configLayer = ServerConfig.layerTest("/workspace", baseDir, {
          builtinSkillsEnabled: true,
        });
        const registryLayer = ProviderRegistry.layer.pipe(
          Layer.provideMerge(
            Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
              getInstance: () => Effect.succeed(instance),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.fromPubSub(changes),
              subscribeChanges: PubSub.subscribe(changes),
            }),
          ),
          Layer.provideMerge(
            Layer.mock(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator)({}),
          ),
          Layer.provideMerge(ModelManifest.layerTest),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(configLayer),
        );

        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          assert.equal(config.builtinSkillsDir, NodePath.join(config.stateDir, "builtin-skills"));

          const materialized = yield* materializeBuiltinPstack(config);
          assert.isDefined(materialized);

          const registry = yield* ProviderRegistry.ProviderRegistry;
          const providers = yield* registry.getProviders;
          assert.equal(providers.length, 1);
          const codex = providers[0]!;
          const poteto = codex.skills.find((skill) => skill.name === "poteto-mode");
          assert.equal(poteto?.scope, "project");
          assert.equal(poteto?.path, userOverrideSkill.path);
          const arena = codex.skills.find((skill) => skill.name === "arena");
          assert.equal(arena?.scope, "builtin");

          const refreshed = yield* registry.refreshWorkspaceSnapshot({
            instanceId: baseSnapshot.instanceId,
            cwd: "/workspace",
          });
          const ws = refreshed[0]?.workspaceSnapshots?.find((snap) => snap.cwd === "/workspace");
          assert.isDefined(ws);
          assert.equal(ws.skills.find((skill) => skill.name === "poteto-mode")?.scope, "project");
          assert.equal(ws.skills.find((skill) => skill.name === "arena")?.scope, "builtin");
        }).pipe(Effect.provide(registryLayer));
      }).pipe(Effect.scoped),
  );
});

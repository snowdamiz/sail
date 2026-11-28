---
name: setup-pstack
description: Configure which models and reasoning budgets pstack uses per role across any configured provider. Discovers live models via Sail's orchestrator_capabilities (or your host harness's catalog) and writes a settings file that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write pstack's per-role model settings:

- **Sail / T3 Code:** `~/.config/sail-pstack/models.md` (also reads `~/.config/t3-pstack/models.md` if present).
- **Cursor:** `~/.cursor/rules/pstack-models.mdc`, an always-applied rule.
- **Claude Code:** `~/.claude/rules/pstack-models.md`. Claude Code loads every file in `~/.claude/rules/` into each new session.
- **Every other harness** (Codex, Pi, OpenCode, Kiro, ACP, and others): `~/.agents/pstack-models.md`.

"The settings file" below means the file for your harness. On Sail, if `~/.config/sail-pstack/models.md` is missing, check `~/.config/t3-pstack/models.md`, then `~/.agents/pstack-models.md` and `~/.claude/rules/pstack-models.md` for existing preferences.

## Steps

### 1. Discover live providers, models, and option descriptors

- **On Sail / T3 Code:** Call `orchestrator_capabilities` to enumerate every live `providerInstanceId`, available `model` slug, and advertised model option descriptor (`effort`, `reasoningEffort`, `thought_level`, `fastMode`, `serviceTier`, etc.). Pass `search` when the user wants a model not in the initial short list.
- **Outside Sail:** Use your harness's live model catalog or CLI (`opencode models`, `pi --list-models`, or the models accepted by your subagent tool). If you cannot detect any automatically, ask the user to paste the model slugs they have access to.

Never write a concrete model slug you have not confirmed is available in the live catalog. The alias `inherit-parent` (and `auto`) is always valid without detection.

Treat every provider and model family cleanly as first-class:

- Anthropic / Claude (`opus`, `sonnet`, `fable`, `haiku`, etc.)
- OpenAI / Codex (`gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`, `gpt-daybreak-*`, `gpt-5.*`, etc.)
- Google / Gemini (`gemini-4-neon`, `gemini-4-carbon`, `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.*`, etc.)
- xAI / Grok (`grok-*`)
- Meta / Muse (`muse-*`)
- Cursor (`auto`, `composer-*`)
- Multi-provider `<provider>/<model>` slugs from OpenCode, Pi, fx, Kiro, ACP Registry, custom configured models, and any future model family.

Do not mark `grok-*`, non-neon `gemini-4-*`, or any other live model as deprecated.

### 2. Load current state

The default role-to-model mapping is `inherit-parent` for every role (shown in step 5 below). If a settings file already exists, read it and preserve its `# budget` line and every user-chosen role value. Drop retired role names that are not in step 5 (such as `hardest tasks`, `architect runners`, `reflect tooling`, or `why investigators`) and report what was dropped.

Never silently overwrite a user's model choice (including `grok-*`, `gemini-4-*`, `muse-*`, `gpt-*`, `claude-*`, `<provider>/<model>`, or custom models). Only flag an entry as needing a choice if its concrete slug is not available in the live catalog discovered in step 1.

### 3. Budget, map, and confirm

**(a) Ask for a reasoning budget.** Prefer your structured-question tool (`ask_question`, `AskUserQuestion`, `AskQuestion`, or `question`) over free text. Offer these three options with these exact labels, and note the current budget if recorded (default: `large`):

- `large — highest supported reasoning (xhigh / max)`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Map roles and options.** Start from the existing settings file or `inherit-parent` defaults. For each role:

- `inherit-parent` (or `auto`) inherits the parent thread's provider, model, and options (omit `target` in Sail's `delegate_task`).
- Concrete entries can specify `<model>` or `<providerInstanceId>:<model>` (or `<provider>/<model>` where the provider uses namespaced slugs) plus optional effort/reasoning settings.
- Map the budget to the option IDs actually advertised by `orchestrator_capabilities` for each chosen model (`effort`, `reasoningEffort`, `thought_level`, etc., or slug-embedded effort only when that provider encodes effort in the slug).
- Default to **standard speed**: do NOT enable `fastMode`, `serviceTier: "priority"`, or append `-fast` suffixes unless the user explicitly asks for fast mode and the model advertises support for it.
- For diverse panel roles (`arena runners`, `arena cross-judge pool`, `interrogate reviewers`), offer the user either `inherit-parent` or a cross-vendor selection built strictly from the live models discovered in step 1.

**(c) Show the roles and confirm.** Display every role with its resolved provider/model and effort option, marking any unavailable concrete slug as needing a choice. Ask whether to accept as-is or edit specific roles, offering live discovered models plus `inherit-parent`.

- For panel roles (`arena runners`, `interrogate reviewers`), each list entry spawns one subagent (including `inherit-parent`).
- For `arena cross-judge pool`, Arena picks the first live entry from a different vendor than the parent (skipping `inherit-parent`).
- For `swarm workers`, the value sets the default model for parallel workers unless a comparison assigns per-arm models.

### 4. Validate

Every concrete slug written must exist in the live catalog discovered in step 1, and every configured option key/value must be supported by that model's advertised option descriptors. `inherit-parent` and `auto` always pass. If a chosen slug or option is unsupported, report the mismatch and ask again.

### 5. Write the settings file

Write the settings file cleanly so re-runs are idempotent. Include YAML frontmatter with `alwaysApply: true` only when writing Cursor's `.mdc` file; in Sail (`~/.config/sail-pstack/models.md`), Claude Code, and other harnesses, start at the first `#` line. Shape:

```
# pstack model configuration. One line per role. Delete a line to fall back to `inherit-parent`.
# `inherit-parent` runs the role on the parent thread's provider, model, and options (omit `target` in `delegate_task`).
# Concrete entries use live models from `orchestrator_capabilities` (optional `providerInstanceId:` prefix and `[key=value]` options).
# Standard speed is used by default; never enable fast mode unless explicitly requested and supported.
# defaults: sail-1
# budget: large
feature, refactoring: inherit-parent
bug-fix: inherit-parent
perf-issue: inherit-parent
hillclimb: inherit-parent
judgment and prose: inherit-parent
arena runners: inherit-parent, inherit-parent
arena cross-judge pool: inherit-parent
swarm workers: inherit-parent
interrogate reviewers: inherit-parent, inherit-parent
```

### 6. Confirm

Tell the user which file was written and remind them that re-running `/setup-pstack` updates it at any time.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill or an existing harness). If not, offer once: "Want a project-local verification skill so agents can drive the app the way a user does and prove changes work? I can generate one with `/create-verification-skill`." On yes, invoke `/create-verification-skill`. On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, proof, or verifier against the code). If not, offer once: "Want a formal verification skill so agents can prove a key property of your code holds across every case in scope? I can generate one with `/create-formal-verification-skill`." On yes, invoke `/create-formal-verification-skill`. On no, move on without pushing.

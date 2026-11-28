# Upstream Provenance: pstack

- **Upstream repository:** https://github.com/backnotprop/pstack
- **Branch:** `main`
- **Commit SHA:** `10a29379878504c75efb8ccefa8a2c06d2376341`
- **Upstream version:** `0.15.48`

## Sail Model-Agnostic Adaptations

This vendored copy is bundled built-in across Sail desktop, server, CLI, and Boat machines:

1. **Model & provider agnostic:** Replaced Cursor-only hardcoded model slugs and `-fast` suffix mandates with live discovery via Sail's `orchestrator_capabilities` (with graceful fallback to the host harness's live model catalog outside Sail). Supports all Sail providers and model families (Anthropic/Claude, OpenAI/Codex, Google/Gemini, xAI/Grok, Meta/Muse, Cursor, `<provider>/<model>` from OpenCode/Pi/fx/Kiro/ACP Registry, custom models, and future families). Neither `grok-*` nor non-neon `gemini-4-*` models are treated as deprecated.
2. **Option-based effort and standard speed by default:** Reasoning/effort and speed controls are passed via `target.options` using the option IDs advertised by `orchestrator_capabilities` (`effort`, `reasoningEffort`, `thought_level`, `fastMode`, `serviceTier`, etc., or slug-embedded effort only when a provider uses slugs), defaulting to standard speed unless explicitly requested and supported.
3. **Sail-native delegation & configuration:** Default role models use `inherit-parent` (configurable via `~/.config/sail-pstack/models.md` or `~/.config/t3-pstack/models.md`, plus harness fallbacks). Subagent delegation prefers Sail's `delegate_task` with `target: { providerInstanceId, model, options }` and `isolation: "worktree"`, falling back to native harness subagent tools outside Sail.
4. **Lean packaging:** Excluded upstream test suites (`skills/statechart/scripts/test/**`, `skills/poteto-mode/scripts/watch-pr/*.test.ts`, `fakes.test-helper.ts`, `types.compile.ts`) and `node_modules` to keep the server and Boat CLI archive lean.
5. **Lint compatibility:** Normalized Node built-in imports in vendored `.ts` helper scripts to satisfy the repository linter without altering script behavior.

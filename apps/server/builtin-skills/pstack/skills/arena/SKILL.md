---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open a todolist with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on _this_ task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners from the `arena runners` line in the pstack settings file (`~/.config/sail-pstack/models.md` or `~/.config/t3-pstack/models.md` on Sail; `~/.cursor/rules/pstack-models.mdc` in Cursor; `~/.claude/rules/pstack-models.md` in Claude Code; `~/.agents/pstack-models.md` in other harnesses).
   - If the file or line is missing, query `orchestrator_capabilities` on Sail (or your host harness's live model catalog outside Sail) and pick 2-3 live models from distinct providers/vendors when multiple providers are configured (Anthropic/Claude, OpenAI/Codex, Google/Gemini, xAI/Grok, Meta/Muse, Cursor, `<provider>/<model>`, or custom models). If only one provider is available, default to `inherit-parent` across 2-3 independent runners.
   - An `inherit-parent` or `auto` entry inherits the parent's provider, model, and options (omit `target` in Sail's `delegate_task`, or omit `model` in native subagent tools).
   - Pass reasoning/effort via `target.options` using the option IDs advertised by `orchestrator_capabilities` for each model (standard speed by default; never invent `-fast` suffixes).
   - If a subagent tool rejects a model or option, fall back to a supported live model of the same family from `orchestrator_capabilities` or drop the seat (keeping at least two runners) and say so.
   - Spawn more candidates for multiple design directions, and repeat one model when the work is generation-bound rather than judgment-sensitive.
4. Give each candidate its own isolated checkout or output location (on Sail, `isolation: "worktree"` in `delegate_task`, or a git worktree / `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Spawn all N candidates in parallel (on Sail via `delegate_task` with `mode: "async"` and `isolation: "worktree"`; outside Sail via your harness's subagent tool with background execution). Give each candidate the task, the path to the shared grounding, its own output path, and instructions to produce the artifact plus a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, spawn one read-only judge from the `arena cross-judge pool` line in the pstack settings file.

- If the file or line is missing (or only lists `inherit-parent`), check `orchestrator_capabilities` (or your harness's live model catalog) and pick the first live model from a vendor other than the parent's.
- The judge should come from a different vendor than the parent when another vendor is configured. An `inherit-parent` or `auto` entry never acts as a cross-vendor judge. If only one vendor is configured or you cannot determine the parent's vendor, note that cross-vendor review was unavailable (or pick the first configured non-parent entry and say so).
- If the subagent tool rejects a model or option, fall back to the next supported cross-vendor model from `orchestrator_capabilities`, or skip the judge and say so.
- While you read in Phase D, the judge scores each candidate, by path label, on each rubric criterion and recommends a base.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.

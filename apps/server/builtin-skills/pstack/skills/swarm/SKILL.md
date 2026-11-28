---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Pick the worker model from the `swarm workers` line in the pstack settings file (`~/.config/sail-pstack/models.md` or `~/.config/t3-pstack/models.md` on Sail; `~/.cursor/rules/pstack-models.mdc` in Cursor; `~/.claude/rules/pstack-models.md` in Claude Code; `~/.agents/pstack-models.md` in other harnesses).
   - If the file or line is missing, default to `inherit-parent` (omit `target` in `delegate_task`, or omit `model` in native subagent tools).
   - For a concrete model or model race, verify each arm against `orchestrator_capabilities` on Sail (or your host harness's live model catalog outside Sail), passing reasoning/effort via `target.options` and keeping standard speed by default.
   - If a subagent tool rejects a model or option, fall back to a supported live model of the same family or `inherit-parent` and say so.
4. Give each worker its own isolated worktree (`isolation: "worktree"` on Sail) or writable output path when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

On Sail / T3 Code, spawn all N workers in parallel with `delegate_task` (`mode: "async"`, `isolation: "worktree"` when workers modify files, and `target: { providerInstanceId, model, options }` only when overriding `inherit-parent`).

Outside Sail, use your harness's subagent tool (`Agent` in Claude Code, `Task` in Cursor, `task` in OpenCode, `spawn_agent` in Codex), giving each worker its own worktree or output path. Drop parameters your tool doesn't have. If your harness has no subagent tool, run the workers yourself sequentially.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.

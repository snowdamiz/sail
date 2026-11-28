---
name: poteto-help
description: Guides users through pstack setup, /poteto-mode, and picking the skill, playbook, or principle for a task. Type /poteto-help with a question.
disable-model-invocation: true
---

# Poteto help

Answer the user's question about pstack, hand them a prompt they can send, and link the file the answer came from. For a help question, don't start the work. The user asked how, and a pstack run spends real tokens, so let them send the prompt.

A message that asks for work, such as "use pstack to fix this bug", is not a help question. Read [`poteto-mode`](../poteto-mode/SKILL.md) and do the work under it.

This file maps questions to the skills that hold the answers. Those files own the details. Read the file you route to before you quote it, and trust it when it disagrees with this map.

## Find out what they need

Infer the need from the message and the conversation. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one multiple-choice question with these options, then answer only the section they pick:

- Get set up
- Start a task with `/poteto-mode`
- Pick a skill for a situation
- Fix a run that went wrong
- Make pstack my own

Check the state that changes the answer, and mention it only when it does:

- No pstack settings file (`~/.config/sail-pstack/models.md` or `~/.config/t3-pstack/models.md` on Sail; `~/.cursor/rules/pstack-models.mdc` in Cursor; `~/.claude/rules/pstack-models.md` in Claude Code; `~/.agents/pstack-models.md` in other harnesses) means `/setup-pstack` hasn't run yet, so every role defaults to `inherit-parent`.
- No `verify-*` skill or other app harness in the project means agents have no scripted way to drive the app. Mention `/create-verification-skill` when the question is about proving a change works.
- No formal verification skill in the project means no property is checked past what tests reach. Mention `/create-formal-verification-skill` when the question is about a race, an invariant, or another case tests rarely hit. When one exists and the code it covers changed after the commit it records as last in sync, mention `/maintain-formal-verification-skill` if the question touches that code.

When the model settings file is missing and it matters (new user, setup/cost question, or multi-model configuration), ask at most once per chat whether they want to run `/setup-pstack` now or keep `inherit-parent` defaults for now.

## Get set up

1. **Built-in on Sail:** pstack ships built-in with Sail across desktop, server, CLI, and Boat machines — no separate install needed. Invoke any skill with `/<skill>` or `$<skill>` (e.g. `/poteto-mode`, `$setup-pstack`). Outside Sail, install via `npx skills add backnotprop/pstack` or your harness's plugin manager.
2. **Optional model config:** Run [`/setup-pstack`](../setup-pstack/SKILL.md). It queries your live providers and models (via `orchestrator_capabilities` on Sail), lets you pick a reasoning budget and per-role models (defaulting to `inherit-parent`), and writes `~/.config/sail-pstack/models.md` (or your harness's settings file). Then it offers once each to generate a verification skill and a formal verification skill.
3. **Start a real task:** Send `/poteto-mode` (or `$poteto-mode`) with a goal and a check that can pass or fail.

If cost is the worry, explain where tokens go: subagents and multi-model review panels. Roles set to `inherit-parent` stay on the parent thread's model at standard speed, and `/setup-pstack` lets you lower the reasoning budget or shorten panel lists. Save `/poteto-mode` for work that needs rigor.

## Start a task with `/poteto-mode`

`/poteto-mode` matches the task to a playbook, copies the playbook's steps into the todo list, and runs the other skills as the steps need them. A good prompt states the goal and how to tell it's done. It doesn't list skills, because a hand-written sequence tends to drop or reorder steps the playbook would keep. Read [`references/prompting.md`](references/prompting.md) before you help word one.

Start each new task with `/poteto-mode` (or `$poteto-mode`), or in harnesses with persistent Custom Modes, attach it as a mode. Mid-chat, "new task" makes the mode match a fresh playbook.

## Pick a skill

The default answer is `/poteto-mode`, which runs most of the others when its steps need them. Name a skill directly when the user wants more or less of something than the playbook gives. Read the skill before you recommend it, and give one example prompt.

| The user wants to                                                                              | Skill                                                                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Do any non-trivial task with rigor                                                             | [`/poteto-mode`](../poteto-mode/SKILL.md)                                               |
| Check that the agent understood their goal and the problem before it starts                    | [`/in-your-own-words`](../in-your-own-words/SKILL.md)                                   |
| Get a prompt rewritten deeper, not bigger, before sending it                                   | [`/sharpen`](../sharpen/SKILL.md)                                                       |
| Learn the expert words for what they're building and rewrite their description with them       | [`/reframe`](../reframe/SKILL.md)                                                       |
| Know how code works now, or where new code should live                                         | [`/how`](../how/SKILL.md)                                                               |
| Know why code is shaped this way, or where a number came from                                  | [`/why`](../why/SKILL.md)                                                               |
| Understand a change or subsystem, explained plainly                                            | [`/teach`](../teach/SKILL.md)                                                           |
| Catch up on their own recent work on a topic                                                   | [`/recall`](../recall/SKILL.md)                                                         |
| Catch up on what changed in this chat since their last message, with visuals and waiting calls | [`/ketchup`](../ketchup/SKILL.md)                                                       |
| Catch up like `/ketchup`, in a short subtitled video of slides                                 | [`/ketchup-video`](../ketchup-video/SKILL.md)                                           |
| Know what a small diff could break outside itself                                              | [`/blast-radius`](../blast-radius/SKILL.md)                                             |
| Settle types and module shape before code that crosses a function boundary                     | [`/architect`](../architect/SKILL.md)                                                   |
| Get several attempts at one brief, merged into the best one                                    | [`/arena`](../arena/SKILL.md)                                                           |
| Run parallel checks over slices, or race workers                                               | [`/swarm`](../swarm/SKILL.md)                                                           |
| Have different models review a diff and try to break it                                        | [`/interrogate`](../interrogate/SKILL.md)                                               |
| Fix a bug test-first when a cheap local test exists                                            | [`/tdd`](../tdd/SKILL.md)                                                               |
| Apply TypeScript rules to `.ts` or `.tsx` work                                                 | [`/typescript-best-practices`](../typescript-best-practices/SKILL.md)                   |
| Strip comments before review, using a reviewer that didn't write them                          | [`/no-comments`](../no-comments/SKILL.md)                                               |
| Clean AI tells out of prose                                                                    | [`/unslop`](../unslop/SKILL.md)                                                         |
| Write docs, an RFC, a README, a PR description, or a commit message to a standard              | [`/technical-writing`](../technical-writing/SKILL.md)                                   |
| Hear the last reply again in plain words                                                       | [`/bro`](../bro/SKILL.md)                                                               |
| Give agents a scripted way to drive the app and prove behavior                                 | [`/create-verification-skill`](../create-verification-skill/SKILL.md)                   |
| Bring a verification skill and its feature map back in line with the app                       | [`/maintain-verification-skill`](../maintain-verification-skill/SKILL.md)               |
| Formally verify a race, invariant, or other property that tests rarely reach                   | [`/create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md)     |
| Bring a formal verification back in line after the code it covers changed                      | [`/maintain-formal-verification-skill`](../maintain-formal-verification-skill/SKILL.md) |
| Show a PM or designer what the user sees as a chart checked by a TLA+ model                    | [`/statechart`](../statechart/SKILL.md)                                                 |
| Vet a performance number before reporting or acting on it                                      | [`/benchmark-checklist`](../benchmark-checklist/SKILL.md)                               |
| Run a large or cross-cutting change, or one to review after stepping away                      | [`/figure-it-out`](../figure-it-out/SKILL.md)                                           |
| Keep a decision log during a run, and review it afterward                                      | [`/show-me-your-work`](../show-me-your-work/SKILL.md)                                   |
| Pick a model for each role and a reasoning budget                                              | [`/setup-pstack`](../setup-pstack/SKILL.md)                                             |
| Turn their own working habits into a personal mode skill                                       | [`/automate-me`](../automate-me/SKILL.md)                                               |
| Turn what a finished task taught into skill edits                                              | [`/reflect`](../reflect/SKILL.md)                                                       |
| Stop agents from repeating the same mistakes in this repo                                      | [`/correct`](../correct/SKILL.md)                                                       |
| Build a page whose buttons wake a webhook bot                                                  | [`/make-bot-ui`](../make-bot-ui/SKILL.md)                                               |
| Find their way around pstack                                                                   | `/poteto-help`                                                                          |

If a skill directory next to this one is missing from the table, read its frontmatter and route by its description. The `principle-*` directories are covered under principles below.

Close calls:

- `/how` explains what the code does. `/why` explains the reasons. `/teach` runs one or both and explains the result plainly.
- `/arena` gives every worker the same brief and merges the best parts. `/swarm` splits work into slices or a race and returns one report.
- `/interrogate` reviews the diff. `/blast-radius` looks for breakage outside the diff and proves the one fact that makes the change safe.
- `/recall` rebuilds context across recent chats. `/ketchup` covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- `/figure-it-out` designs one rigorous run. The Autonomous run playbook drives one task to a finish condition.

## Playbooks and principles

Playbooks are step lists inside `/poteto-mode`, not skills, so they have no slash command. Inside `/poteto-mode`, describing the task picks one, and these phrases name one directly:

- "babysit this pr" or "check on pr 123" runs Babysit. It drives the PR to merge-ready and stops there. It doesn't merge unless the user asks to merge, land, or ship.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "full autopilot on this queue" runs Autopilot-full. "autopilot, don't merge" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

For work that spans phases or stacked PRs, asking `/poteto-mode` for a plan runs the [Multi-phase plan playbook](../poteto-mode/playbooks/multi-phase-plan.md), which writes the plan and doesn't implement it. For a design question, the Prototype playbook or `/architect` settles it in code first.

Principles are one-rule skills that `/poteto-mode` reads and cites in its replies. The user rarely invokes one. They steer with the names instead, as in "apply prove it works. show me the real output." Typing `/principle-<name>` still loads one on demand.

## Fix a run that went wrong

| Symptom                                                  | Fix                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The mode stopped applying after a few turns              | Start each new task with `/poteto-mode` (or `$poteto-mode`), or attach it as a persistent mode if your harness supports one. |
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode.                                                                       |
| A new model choice had no effect                         | Check `~/.config/sail-pstack/models.md` (or your harness's settings file) and start a fresh turn or thread.                  |
| Runs cost more than expected                             | See the cost paragraph under Get set up.                                                                                     |
| A skill didn't load on its own                           | Only `/setup-pstack` loads from the user's words. The others load when invoked or when `/poteto-mode` runs them.             |
| Parallel agents overwrote each other                     | Delegate with `isolation: "worktree"` on Sail, or give each worker its own git worktree.                                     |
| An overnight run moved but finished nothing              | Give the recurring task or loop a check that can pass or fail, not just a duration.                                          |
| The reply claims success from a green build              | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle.                               |

For a run that drifts, [`references/prompting.md`](references/prompting.md) has one-line steers.

## Make pstack my own

- [`/automate-me`](../automate-me/SKILL.md) drafts a personal mode skill from the user's own history, to use alongside `/poteto-mode`.
- [`/reflect`](../reflect/SKILL.md) after a session turns its lessons into skill edits the user approves.
- `/poteto-mode write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.

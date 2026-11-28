# Sail Rust and GPUI migration plan

Move Sail's desktop and web clients to Rust and GPUI, then move the workspace server and its launcher to Rust. Ship the first native desktop and browser WASM builds as opt-in clients of the existing Node server. Preserve the app install, paired environments, and active workspace data through the hybrid releases. Every shipped workflow must look and behave as it does in the qualifying incumbent Sail release.
Start from the published [Sail v0.1.17](https://github.com/snowdamiz/sail/releases/tag/v0.1.17), built at `18fd0e5d66291fc007163512d783d7268218db16`. Recheck the release baseline at execution time.
Run P01 through P17 in dependency order. Publish R1 through R7 at the checkpoints below. R1 through R6 are working releases that users can install and upgrade.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, such as a file, log, screenshot, test run, or SHA. The body is a how-to. The appendices explain and record.

Use `<plugin root>/skills/poteto-mode/playbooks/orchestrate.md` for this program. Land each ready PR through the repository's merge workflow. The operator reviews interaction changes at merge-ready and controls release promotion. The coordinator records the exact verified head, candidate artifact digests, and release URL.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and link this plan to the operator before starting implementation. Record the execution authorization in the decision log.
- [ ] Confirm the current release, installer targets, official hosted web origins, supported browser versions, active provider adapters, and updater support window. Save the inventory at the baseline SHA. Use macOS and Linux as the minimum packaged targets. Prove Windows before claiming it if it enters the published target set.
- [ ] Read these at program start and re-read them when auditing.
  - [ ] `cat <plugin root>/skills/poteto-mode/playbooks/orchestrate.md`
  - [ ] `cat <plugin root>/skills/swarm/SKILL.md`
  - [ ] `cat .agents/skills/test-t3-app/SKILL.md`
  - [ ] `cat <plugin root>/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] Read the pstack `visual-parity` playbook and the `interrogate`, `show-me-your-work`, `benchmark-checklist`, and `technical-writing` skills.
- [ ] When authorized to run the coordination program, arm an hourly schedule_task bound to the coordinator thread and record its ID.
- [ ] Use this tick prompt verbatim. "Re-read the execution playbook from disk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On hold or stand-down, stop the owners and suspend future release actions. Save the active heads and artifact identifiers.

### Spawn owners

- [ ] Give each PR an owner, an isolated worktree, and the file boundaries below. Give shared build and contract paths one owner at a time.
- [ ] Start P01 and P02 from `main`. Start P03 after both. Start P04 after P03.
- [ ] Start P05, P06, and P07 after P03. Start P08 after P06 and P07. Start P09 after P04 through P08. Start P10 after P08 and P09.
- [ ] Start P11 and P12 after P01. Start P13 after P01. Start P14 after P13. Start P15 after P11 through P14. Start P16 after P10 and P15. Start P17 after P16 and the support window below.
- [ ] Keep unqualified code off by default. Let opt-in clients and server candidates fall back through the preceding supported release. Keep tests against both runtimes until P17.
- [ ] Send screenshots and a video for P03 through P10 and P15 through P17 to the operator before merge. Record the operator's verdict with the reviewed SHA.

### PR mechanics, for every PR

- [ ] Resolve the forge from `git remote get-url origin`. Use GitHub for `snowdamiz/sail`. Record each PR number, base, and head in the program ledger.
- [ ] Open a ready PR when authorized for implementation. Link it to the owning Acid thread. Use the app's PR watcher for a request to babysit a PR.
- [ ] Run `vp run check:changed` before the PR-facing push. Run the affected Cargo package checks and WASM builds once Rust targets exist. Keep git hooks active.
- [ ] Use the repo's translation workflow when changing the legacy clients. Make the Rust UI consume equivalent message catalogs and check translations before client cutover.
- [ ] Run `deslop` before commit and `no-comments` and `interrogate` before review. Record accepted findings and the reason for each dismissal.
- [ ] Refresh the base before the code-ready report. After review, use the current head for the merge verdict unless the shipping playbook's patch-ID rule applies.

### Verdict and merge, for every PR

- [ ] Run the gate, live, performance, and independent audit lanes at the code-ready head. Include contracts, application state, packaging, or security in the audit according to the change.
- [ ] Require a pass in every applicable lane. If a lane cannot run, keep its outcome visible and leave the affected merge or release gate open.
- [ ] Merge on the coordinator's clean verdict at the current head and the operator's verdict where required. Apply the patch-ID rule from `playbooks/shipping.md` to an unchanged patch; otherwise renew affected evidence.
- [ ] Record each decision and result in the program's decision log. Share verification failures with the PR owner and re-run the affected lanes after correction.

### Boot recipe, for every live lane

- [ ] Fetch the named branch and use an isolated worktree at the exact head SHA. Run the owning checkout's setup and `vp i` if required.
- [ ] Start an isolated server with a copy of `statev2.sqlite` from the test fixture or a consented sanitized snapshot. Copy settings, secrets, and attachments only for cases that require them. Preserve live user data and use a unique state directory and port per lane.
- [ ] Drive legacy web and Electron with `.agents/skills/test-t3-app/SKILL.md` and the existing Replay provider. Start the browser WASM build from the same release asset. Use Chromium through the T3 Browser panel. Run the same flow with Firefox and Safari on their supported hosts. Drive native GPUI windows with the OS accessibility driver specified in P02.
- [ ] Use the installed binary for installer and updater lanes. Run server and CLI lanes with real HTTP, WebSocket, and process transcripts. Capture the harness or terminal result as an image when the lane has no application screen. Keep the machine-readable transcript beside it.
- [ ] Save each image to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return its path with the fixture ID, OS, browser or installer target, head SHA, server implementation, and observed result.
- [ ] Record a prior release baseline first for performance. Alternate trunk and head on the same machine with the same saved data and load. Warm up each build, capture at least 12 pairs, and report the p95 and the raw samples. The per-PR budgets are proposed limits for the program. Record any baseline-driven adjustment before judging head.
- [ ] Use [Testing](../internals/15_testing.md) and [Performance regressions](../internals/16_performance-regressions.md) for runtime and wire probes. Keep hosted and server-served web checks on the published origin configuration for the release candidate.

### Enforce visual and behavioral parity

- [ ] Freeze the incumbent desktop and web on the baseline SHA, widget dimensions, fonts, icons, locales, themes, zoom, device scale, browser, and OS used for comparison. Approve independent desktop and web reference captures before porting a view. Record any intervening independently shipped design change as a separate baseline revision with its source SHA and before-and-after evidence.
- [ ] Capture real rendered screens with deterministic time, data, providers, and motion. Compare native against incumbent desktop, and WASM against incumbent web, within the matching platform configuration. Require zero differing pixels in app-owned regions. Keep baseline images, drivers, and diff configuration immutable in feature PRs. Review any exclusion up front and limit it to nondeterministic external pixels. Use deterministic fixtures for preview content where possible.
- [ ] Replay the same events on both builds. Compare input and focus behavior, keyboard shortcuts and palette commands, navigation, selects and clipboard, accessible roles and names, notifications, and server state. Run loading, empty, error, offline, recovery, and persistence cases. Require identical app-visible outcomes and operator approval of motion and interaction evidence.
- [ ] Keep a coverage manifest keyed by feature, platform, and entry point. Require parity across chat, settings, command palette, keybindings, direct URLs, CLI and desktop activation, and permitted remote routes wherever the baseline exposes them. Fail release qualification on missing coverage, any unapproved visual delta, or a behavior difference. Limit an opt-in to qualified workflows. Enter the opt-in through a launch flag or preview URL so existing screens keep their controls and layout. Send any action outside the qualified workflow through the incumbent at the same destination, with the same account, environment, thread, and session intent. If that transition changes the user outcome, keep the workflow on the incumbent. Keep the incumbent default for a platform until its whole manifest passes.
- [ ] Use the pstack `visual-parity.md` playbook for every changed view. Save matched incumbent and candidate images, pixel diffs, behavior receipts, and video under the exact head SHA. Treat GPU, canvas, or font-rendering gaps as blockers. Keep the incumbent renderer if the GPUI implementation cannot match it.

### Ship a versioned release

- [ ] Publish **R1, planned 0.2.0**, after P04. Offer the same qualified GPUI chat workflow as an opt-in desktop window and an opt-in WASM page. Electron and React own the normal entry points and remaining workflows. Upgrade from the previous public installer and use one existing server from all three clients.
- [ ] Publish **R2, planned 0.3.0**, after P09. Make the qualified GPUI WASM web app the default. Keep a public React fallback and the preceding web asset revision. Ship the broader GPUI desktop workflow as opt-in.
- [ ] Publish **R3, planned 0.4.0**, after P10. Make the GPUI desktop launcher the default. Bundle the Node server independently. Include an Electron recovery launch path and retain the web rollback route.
- [ ] Publish **R4, planned 0.5.0**, after P11 and P12. Use the qualified Rust workers under the Node server. Provide per-worker or per-provider selection for rollback. Keep the Node host as the sole writer for each environment.
- [ ] Publish **R5, planned 0.6.0**, after P15. Offer the Rust server and Rust launcher for selected environments. Start with a test home and then a canary upgrade with a verified backup. Keep Node the default until R6.
- [ ] Publish **R6, planned 0.7.0**, after P16. Select the Rust host for qualified new installs and upgrades. Keep a supported Node recovery artifact and the app's client rollback paths through the support window.
- [ ] Publish **R7, planned 1.0.0**, after P17. Remove the first-party Node, Electron, and React runtime payloads from the official desktop, CLI, server, and web artifacts. Keep an immutable bridge release for supported upgrade paths.
- [ ] Resolve a fresh version at every checkpoint against the live stable release, remote tags, and existing GitHub drafts. Use the planned versions when available. Reserve a strictly higher minor release if one has already passed. Give a failed publication a fresh patch version. Keep the orchestration protocol, launcher protocol, and SQLite migration versions separate.
- [ ] Make one release version authoritative. Align the existing versioned JS manifests with `node scripts/update-release-package-versions.ts <version>` while those manifests ship. Feed the same release version into Cargo builds, the native app bundle, the WASM boot metadata, CLI output, and OCI labels. Check installed and served version endpoints against the release manifest.
- [ ] Build a unique draft lane from the exact release source and qualify it first. Use an isolated image namespace for lane runs. Build the final stable-version files into a separate draft and verify those bytes with the same smoke. Before publishing, record the source SHA, run ID, tag, installer hashes, updater metadata, WASM asset hashes, CLI archive hashes, and multi-architecture image digest.
- [ ] Use the promotion entry point added by P04. Verify updater SHA-512 entries as well as `SHA256SUMS`. Publish the verified draft and version tag without a rebuild. Advance any independently hosted web alias and the stable image pointer to the recorded revision and digest after the exact assets are available. Verify the same-origin assets served by the pinned image. Record a separate hosted alias promotion when that origin participates. Use a supported feed or manual installer path for each platform. Record the actual old-to-new update result.
- [ ] If a client release fails after publication, switch the web alias to the retained revision and disable the affected opt-in or default where safe. Publish a higher patch with the incumbent client path when updater version ordering requires it. Keep the prior full installer, archived runtime, and already accepted user writes.
- [ ] If a host trial fails before activation, restore the verified pre-upgrade snapshot and reinstall the incumbent over the same configuration. If the host already accepted new work, use a backward-readable downgrade or a verified forward recovery that carries the new writes. Save the rollback evidence and report the supported recovery action in the release notes.

## Freeze the incumbent and capture the compatibility contract (P01)

**Depends on.** None.

**Files.**

- [ ] Create `tests/migration/` for the fixture catalog, reference captures, and differential harness.
- [ ] Use `packages/contracts/src/rpc.ts`, `packages/client-runtime/src/`, and `scripts/scenarios/` as the incumbent references.

**Build.**

- [ ] Pin the public release and its matching source. Establish screenshot baselines and scripted action and state traces for every supported feature, including the current app chrome, all UI states, locales, and view sizes. Freeze v2 HTTP, RPC envelopes, typed errors, scopes, server capabilities, SQLite fixture metadata, and launcher bootstrap transcripts. Add release ledgers keyed by artifact, platform, and SHA.

**You see.**

- [ ] Incumbent Electron and web each pass the manifest against their own unchanged baseline.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `vp test run apps/server/src/ws.test.ts packages/client-runtime/src/rpc/session.test.ts`. Run the new baseline check twice and verify it fails for a deliberate pixel change, wrong event, or missing widget state.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Replay the same reference turn twice. Save `ref-chat.png`. Pass when hashes and action traces match.
- [ ] Lane 2. Capture provider prompt approval and denied access. Save `ref-approval.png`. Pass when both UI outcomes and scopes are recorded.
- [ ] Lane 3. Open empty, loading, and error views. Save `ref-states.png`. Pass when each view has a named capture.
- [ ] Lane 4. Open links from chat and the command palette. Save `ref-entry.png`. Pass when both routes and focus are recorded.
- [ ] Lane 5. Capture light, dark, zoomed, and translated windows. Save `ref-theme.png`. Pass when the manifest covers each pinned display state.
- [ ] Lane 6. Turn off the host and reconnect. Save `ref-offline.png`. Pass when offline and recovered state are distinct.
- [ ] Lane 7. Capture exact-version client rejection. Save `ref-contract.png`. Pass when HTTP 426 and the update option are recorded.
- [ ] Lane 8. Boot a copied home from the installer fixture. Save `ref-install.png`. Pass when the seeded thread opens.
- [ ] Lane 9. Play the existing Browser panel fixture. Save `ref-preview.png`. Pass when a deterministic preview and tool result are recorded.
- [ ] Lane 10. Inject a pixel and a replay result change in a scratch copy. Save `ref-negative.png`. Pass when the harness fails both cases.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Screenshot and trace capture time per fixture.
- [ ] Probe. Run the manifest against two copies of incumbent and against head using the same seeded state and viewport.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 15% extra capture time or 2 s extra per fixture.

**Review gate.** None. P01 does not change a published interaction.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Prove shared GPUI rendering on desktop and WASM (P02)

**Depends on.** None.

**Files.**

- [ ] Create `native/sail-client/` with native and WASM entry points and a pinned lockfile.
- [ ] Add the GPUI lane driver under `tests/migration/`.

**Build.**

- [ ] Pin an upstream GPUI revision and Rust toolchain. Build the same view crate into a native GPUI window and a WASM preview page. Use macOS Accessibility APIs and Linux AT-SPI for native controls. Add matching browser automation and screenshot capture for Chromium, Firefox, and Safari. Keep fixtures and styling aligned with P01 when both PRs land. Establish font loading, shadows, scaling, keyboard focus, and screenshot capture before shipping UI.

**You see.**

- [ ] The same fixed project and thread fixture appears in both new targets with a captured image and input trace.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `cargo test --locked --manifest-path native/sail-client/Cargo.toml` and `cargo build --locked --target wasm32-unknown-unknown --manifest-path native/sail-client/Cargo.toml` for the client target. Verify a deliberate style change fails the pixel comparison.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Replay incumbent startup, then open the new native fixture. Save `gpui-native.png`. Pass when the old launch works and the native window is interactive.
- [ ] Lane 2. Boot the same fixture in browser Chromium. Save `wasm-chromium.png`. Pass when the expected thread is visible.
- [ ] Lane 3. Boot the fixture in Firefox. Save `wasm-firefox.png`. Pass when fallback rendering and input work.
- [ ] Lane 4. Boot the fixture in Safari. Save `wasm-safari.png`. Pass when focus and text entry work.
- [ ] Lane 5. Force WebGL2. Save `wasm-webgl.png`. Pass when the render matches the WebGPU fixture.
- [ ] Lane 6. Disable both graphics backends. Save `wasm-unavailable.png`. Pass when the legacy web entry works.
- [ ] Lane 7. Render the pinned fonts at 1x and 2x. Save `gpui-scale.png`. Pass when the renderer resolves the required glyphs and geometry.
- [ ] Lane 8. Drive keyboard focus and selected text. Save `gpui-input.png`. Pass when events and visible selection match the fixture.
- [ ] Lane 9. Inspect accessible name and role for the composer. Save `gpui-a11y.png`. Pass when the OS driver finds and can activate it.
- [ ] Lane 10. Close and reopen the separate native process. Save `gpui-reopen.png`. Pass when the app exits cleanly and opens once.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to first interactive view and compressed WASM bytes.
- [ ] Probe. Run the same fixture at incumbent and head. Isolate WASM download, startup, and first paint with cold and warm caches.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% growth in the incumbent path. Fail above 2 s p95 added first-use wait or 8 MiB compressed for the new route.

**Review gate.** None. P02 does not change a published interaction.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Port the first real chat workflow to both builds (P03)

**Depends on.** P01 and P02.

**Files.**

- [ ] Edit `native/sail-client/` for typed wire, client state, transport, and the shared chat view.
- [ ] Use `native/sail-boat/src/proxy/upstream.rs` as a reference for Effect RPC framing.

**Build.**

- [ ] Implement pairing and scoped sessions with browser and native adapters. Keep protocol v2, request IDs, typed failures, chunk acknowledgements, cancellation, and heartbeat handling. Share the thread projection, atomically apply replay with its cursor, and distinguish offline state from stale data. Port the current thread list, transcript, composer, Stop, and loading and reconnect states using the incumbent styles. Send unsupported workflows through the normal incumbent entry.

**You see.**

- [ ] A single Replay turn appears in both GPUI builds and the incumbent, with the same messages, controls, and server receipt.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked client tests and `vp test run apps/server/src/ws.test.ts`. Replay the same versioned fixtures through both client implementations. Add browser cancellation, reconnect, and scope checks.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Send the same Replay prompt at trunk and both candidate targets. Save `chat-turn.png`. Pass when ordered messages, controls, and pixels match.
- [ ] Lane 2. Pair from desktop to the bundled local server. Save `chat-local.png`. Pass when the expected environment and thread open.
- [ ] Lane 3. Pair from hosted WASM to the existing HTTPS host. Save `chat-pair.png`. Pass when the browser completes the approved session exchange.
- [ ] Lane 4. Disconnect between replay chunks. Save `chat-resume.png`. Pass when the transcript resumes with no lost or duplicate text.
- [ ] Lane 5. Disconnect after command acceptance. Save `chat-once.png`. Pass when there is one turn and the same command receipt.
- [ ] Lane 6. Stop output mid-turn. Save `chat-stop.png`. Pass when the same turn settles as stopped.
- [ ] Lane 7. Use a read-only session. Save `chat-read-only.png`. Pass when the composer restrictions and server denial match.
- [ ] Lane 8. Revoke the active session. Save `chat-revoked.png`. Pass when the same relink state appears.
- [ ] Lane 9. Open a long settled thread and an empty one. Save `chat-states.png`. Pass when both match their reference image and position.
- [ ] Lane 10. Invoke a feature outside the migrated workflow. Save `chat-fallback.png`. Pass when the incumbent opens the same selected thread.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Prompt-to-first-token and reconnect-to-current-transcript p95.
- [ ] Probe. Alternate the same turn and disconnect schedule on same-server incumbent and candidate. Separate browser WASM boot from the turn.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% or 100 ms extra, whichever allows less regression. Keep the P02 WASM budget.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P03. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Package and promote the first hybrid release (P04)

**Depends on.** P03.

**Files.**

- [ ] Edit `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-installers.ts`, and `.github/workflows/release.yml`.
- [ ] Add a promotion workflow and exact-asset qualification under `.github/workflows/` and `scripts/`. Update `docs/operations/03_release.md` for Sail's actual path.

**Build.**

- [ ] Package the shared WASM assets with the server and stage an opt-in hosted revision. Bundle the GPUI native binary under the existing desktop identity. Let Electron supervise one backend and open the candidate. Add digest-guarded promotion with publish permissions separated from candidate build. Run the final stable draft against a pinned source ref. Use the workflow's GitHub Actions token to publish its tag without triggering a second tag build. Reject reused stable versions and asset replacement. Ship R1 only after the candidate and final stable bytes pass.

**You see.**

- [ ] The installed incumbent remains the default and both opt-in GPUI clients use its existing history. The release receipt names the exact installer, CLI, web, and server bytes.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `vp test run scripts/build-desktop-installers.test.ts scripts/merge-release-update-manifests.test.ts scripts/update-release-package-versions.test.ts`. Add tests for duplicate tag and draft, stale receipt, wrong SHA, and changed OCI digest.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Upgrade the last stable package and open the same thread. Save `install-upgrade.png`. Pass when installer identity and history match.
- [ ] Lane 2. Install on macOS arm64 and Intel from the exact assets. Save `install-macos.png`. Pass when DMG, ZIP, and updater hashes match.
- [ ] Lane 3. Install on Linux x86_64 and arm64. Save `install-linux.png`. Pass when AppImage and DEB launch under the same identity.
- [ ] Lane 4. Serve the WASM route from the exact OCI image digest. Save `install-wasm.png`. Pass when the route opens and original web works.
- [ ] Lane 5. Install the Linux CLI archive using its exact version. Save `install-cli.png`. Pass when reported version and checksum match.
- [ ] Lane 6. Kill the newly launched GPUI process. Save `install-crash.png`. Pass when Electron remains in the same thread.
- [ ] Lane 7. Exercise previous desktop update feed or installer path. Save `install-feed.png`. Pass when the updater upgrades to the intended bytes.
- [ ] Lane 8. Attempt to reuse a lane and stable version in a disposable workflow run. Save `install-duplicate.png`. Pass when both conflicts abort before upload.
- [ ] Lane 9. Supply a wrong promotion receipt in a disposable workflow run. Save `install-provenance.png`. Pass when the release and aliases stay unchanged.
- [ ] Lane 10. Rehearse web revision and desktop fallback. Save `install-rollback.png`. Pass when both return to the previous client with current history.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Clean install and upgrade-to-first-window p95.
- [ ] Probe. Alternate fresh, upgrade, and fallback runs with the incumbent and final draft on each shipped target. Record download and startup separately.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% p95 regression or 300 ms extra startup overhead, whichever allows less. Keep download and package size evidence.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P04. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Match the full chat interaction and presentation (P05)

**Depends on.** P03.

**Files.**

- [ ] Edit `native/sail-client/` and extend chat fixtures in `tests/migration/`.
- [ ] Use `apps/web/src/components/ChatView.tsx` and its browser tests as the reference.

**Build.**

- [ ] Port markdown, code blocks, inline diffs and tool output, attachments, mentions, drafts, model and permission selection, queued sends and steering, approvals, questions, secret prompts, forks, stop, resume, and history. Port scroll anchoring and virtualized transcripts. Match every applicable menu, shortcut, accessible action, and translation.

**You see.**

- [ ] The same seeded conversation, composer, and interactive event sequence look and behave identically on both GPUI targets.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked client tests and `vp test run apps/web/src/components/ChatView.browser.test.tsx`. Extend `scripts/scenarios/replay-turn-streams.e2e.ts` coverage through the P02 driver.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Replay a rich tool-call turn at trunk and both clients. Save `rich-replay.png`. Pass when pixels and ordered actions match.
- [ ] Lane 2. Scroll across a long streamed transcript. Save `rich-scroll.png`. Pass when scroll anchor and focus stay on the same item.
- [ ] Lane 3. Copy code and select across blocks. Save `rich-copy.png`. Pass when clipboard and selection state match.
- [ ] Lane 4. Upload then remove an attachment. Save `rich-attachment.png`. Pass when preview, upload, and removal match.
- [ ] Lane 5. Send while a turn is active and edit its queue entry. Save `rich-queue.png`. Pass when the same turn starts with the same content.
- [ ] Lane 6. Approve, answer, then deny three different requests. Save `rich-approvals.png`. Pass when prompts and settled results match.
- [ ] Lane 7. Use a secret fixture and restart the client. Save `rich-secret.png`. Pass when the prompt resolves and history contains no secret.
- [ ] Lane 8. Stop and resume a turn or fork a thread. Save `rich-fork.png`. Pass when the same history and branch are visible.
- [ ] Lane 9. Switch provider, permission mode, locale, and theme. Save `rich-settings.png`. Pass when menus, keybindings, and persisted state match.
- [ ] Lane 10. Open and restore an unsent draft from a deep link. Save `rich-draft.png`. Pass when navigation, caret, and draft match.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 scroll frame duration and input-to-visible-edit.
- [ ] Probe. Run one short and one long incumbent and candidate conversation with the same input sequence.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% or 2 ms more p95 frame duration. Fail above 50 ms for input-to-visible-edit.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P05. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Match projects settings and remote environment flows (P06)

**Depends on.** P03.

**Files.**

- [ ] Edit `native/sail-client/` for the shell and environment views.
- [ ] Use `apps/web/src/connection/`, `packages/client-runtime/src/authorization/`, and `docs/internals/05_remote.md` as references.

**Build.**

- [ ] Port project and thread navigation, worktree actions, settings, synced preferences, provider and integration sign-in, account state, commands, deep links, automation controls, notifications, and translations. Add platform storage for connection catalogs, auth proof keys, and drafts. Match local, LAN, Tailscale, SSH, relay, hosted, and Boat routes supported at baseline. Verify identity and scope on route changes.

**You see.**

- [ ] The same environments, projects, preferences, open threads, and affordances appear after launch or reconnect.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked client tests and `vp test run packages/client-runtime/src/connection/onboarding.test.ts packages/client-runtime/src/connection/supervisor.test.ts`. Reuse the incumbent hosted-pairing and route fixtures.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open the same project and worktree at trunk and head. Save `project-open.png`. Pass when the same selected rows and commands appear.
- [ ] Lane 2. Find and open a project from the command palette. Save `project-palette.png`. Pass when ordering, focus, and keyboard selection match.
- [ ] Lane 3. Create and remove a disposable worktree. Save `project-worktree.png`. Pass when workspace and UI outcomes match.
- [ ] Lane 4. Pair local, LAN, Tailscale, and SSH test hosts. Save `env-direct.png`. Pass when host identity and session are preserved.
- [ ] Lane 5. Pair via T3 Connect and switch accounts. Save `env-cloud.png`. Pass when the right relay connections update with direct ones intact.
- [ ] Lane 6. Open a forwarded Boat thread and wake the machine. Save `env-boat.png`. Pass when history and ready state match.
- [ ] Lane 7. Change a synchronized preference on desktop. Save `project-pref.png`. Pass when web receives the same value and local settings stay local.
- [ ] Lane 8. Revoke a paired session then restart. Save `env-revoke.png`. Pass when the same re-pair action appears.
- [ ] Lane 9. Open a copied thread URL or CLI activation. Save `project-deep-link.png`. Pass when navigation lands on the same thread and focus.
- [ ] Lane 10. Open settings in two locales and rebind a command. Save `project-i18n.png`. Pass when strings, keyboard layout, and stored binding match.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Open-project, paired-host ready, and command-palette p95.
- [ ] Probe. Replay the same account and projects via both clients. Run once on direct HTTPS and once on a test relay.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% or 150 ms more p95 latency. Fail on any increase in socket connections per environment.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P06. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Match terminal files editor and source-control workflows (P07)

**Depends on.** P03.

**Files.**

- [ ] Edit `native/sail-client/` terminal, file, editor, and source-control views.
- [ ] Use the incumbent `ThreadTerminalDrawer`, project workspace, diff, and forge integration views as references.

**Build.**

- [ ] Port terminal rendering and input, resize, copy, paste, URL and file links, input method behavior, file browsing and editing, diff and checkpoint controls, repository operations, worktree actions from chat, and PR and issue views. Keep operations on the selected environment and preserve streaming budgets and permission rules.

**You see.**

- [ ] Terminal bytes, file edits, Git state, and the screens used to control them match the incumbent.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked client tests and `vp test run apps/server/src/terminal/OutputProtocol.test.ts apps/web/src/components/ThreadTerminalDrawer.browser.test.tsx`. Extend the terminal and diff scenarios.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Type and resize the same terminal at trunk and head. Save `term-interactive.png`. Pass when pixels and emitted bytes match.
- [ ] Lane 2. Paste a fixed large input and stop output. Save `term-paste.png`. Pass when the exact input arrives once and the UI stays responsive.
- [ ] Lane 3. Open a file link from a remote terminal. Save `term-link.png`. Pass when the file is opened in its owning environment.
- [ ] Lane 4. Edit a file and cancel a conflicting write. Save `file-edit.png`. Pass when buffer and save semantics match.
- [ ] Lane 5. Open a syntax-highlighted diff and expand context. Save `diff-context.png`. Pass when text, wrapping, and selection match.
- [ ] Lane 6. Revert and restore a disposable checkpoint. Save `diff-checkpoint.png`. Pass when Git, provider state, and rendered history match.
- [ ] Lane 7. Create and sync a branch on a fixture repo. Save `git-branch.png`. Pass when commands target the same worktree and show the same result.
- [ ] Lane 8. Open a PR and issue from their marked entry points. Save `git-review.png`. Pass when links and application state match.
- [ ] Lane 9. Use a session without terminal or write permission. Save `term-scope.png`. Pass when the same controls are disabled and the host rejects mutations.
- [ ] Lane 10. Reconnect with a foreground terminal job. Save `term-reconnect.png`. Pass when the buffer, job outcome, and status agree.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Terminal input-to-paint, terminal queued bytes, and diff first paint.
- [ ] Probe. Replay equal terminal output, resize, and diff fixtures through both runtimes. Capture byte counts and p95.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% extra p95 time or 10% extra queued bytes. Reject any unbounded queue growth.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P07. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Move browser preview and platform services behind portable interfaces (P08)

**Depends on.** P06 and P07.

**Files.**

- [ ] Edit `native/sail-client/` and introduce a browser engine process boundary under `native/`.
- [ ] Use `apps/desktop/src/preview/`, `apps/web/src/browser/ServerBrowserSurface.tsx`, and `apps/desktop/src/preload.ts` as references.

**Build.**

- [ ] Inventory all desktop bridge methods and retain the incumbent implementations during transition. Provide a browser engine for native previews with isolated profile, remote loopback, automation, recording, capture, and passkey semantics. Preserve in-browser preview, authentication popups, history, uploads, downloads, clipboard, focus, and accessibility under the deployed headers. Qualify COOP, COEP, and CSP for the actual origins before enabling a threaded build.

**You see.**

- [ ] The same preview tabs, profile, screenshots, automation actions, and error states are visible. A selected remote localhost remains attached to its environment.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked client and broker tests and `vp test run apps/desktop/src/preview/DesktopBrowserHost.test.ts apps/web/src/browser/ServerBrowserSurface.browser.test.tsx`. Add tests for origin and profile isolation.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open the same preview and automation action at trunk and head. Save `preview-open.png`. Pass when chrome and page state match.
- [ ] Lane 2. Reload a signed-in profile. Save `preview-profile.png`. Pass when the expected profile stays signed in and isolated.
- [ ] Lane 3. Open tunnel loopback on a remote environment. Save `preview-loopback.png`. Pass when traffic reaches only the chosen remote host.
- [ ] Lane 4. Disconnect the remote route mid-preview. Save `preview-tunnel-down.png`. Pass when the same failure appears and the local device receives no traffic.
- [ ] Lane 5. Pick an element and inspect the thread attachment. Save `preview-pick.png`. Pass when coordinates, labels, and attachment match.
- [ ] Lane 6. Record and replay a short interaction. Save `preview-record.png`. Pass when timing and capture output match.
- [ ] Lane 7. Use a fixture passkey and an auth popup. Save `preview-auth.png`. Pass when the expected profile and session are used.
- [ ] Lane 8. Exercise clipboard, drag/drop, upload, and download. Save `preview-transfer.png`. Pass when the expected permissions and files match.
- [ ] Lane 9. Use a keyboard and screen reader to navigate preview controls. Save `preview-access.png`. Pass when focus order and accessible outcomes match.
- [ ] Lane 10. Run the same tasks with server-hosted and hosted web. Save `preview-web.png`. Pass when production browser headers allow every supported flow.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Preview ready, automation round-trip, and recording dropped frames.
- [ ] Probe. Alternate the same deterministic local and tunneled page with fixed recording and automation input.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% extra p95 time, any lost automation action, or more than 1% dropped frames above the baseline.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P08. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Switch the qualified web client default (P09)

**Depends on.** P04, P05, P06, P07, and P08.

**Files.**

- [ ] Edit `apps/web/`, the server client-asset routing, and the WASM bootstrap under `native/sail-client/`.
- [ ] Update the user-facing web upgrade and rollback notes.

**Build.**

- [ ] Serve the qualified GPUI WASM entry on server-hosted and supported hosted web origins. Preserve existing URLs, cache keys, redirects, authentication callbacks, keyboard navigation, and history. Keep the complete React app and a legacy route while the compatibility window is open. Ship R2 only after the full web manifest passes.

**You see.**

- [ ] Opening a saved web link shows the same Sail page and workflow, whether it loads GPUI or the retained client.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run WASM builds, asset routing tests, and the P01 matrix. Run the existing pairing and Replay scenarios through the candidate and the legacy route.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the full web parity manifest against the previous public client. Save `web-parity.png`. Pass when every app-owned image and behavioral trace passes.
- [ ] Lane 2. Load a saved deep link in Chromium. Save `web-chromium.png`. Pass when the same thread and history are shown.
- [ ] Lane 3. Load the same link in Firefox. Save `web-firefox.png`. Pass when input and graphics match its own baseline.
- [ ] Lane 4. Load the same link in Safari. Save `web-safari.png`. Pass when input and graphics match its own baseline.
- [ ] Lane 5. Pair via a hosted HTTPS link. Save `web-hosted.png`. Pass when the secret exchange and route work.
- [ ] Lane 6. Pair on a server-served origin. Save `web-server.png`. Pass when cookie and return navigation work.
- [ ] Lane 7. Open the app with an old cached bundle. Save `web-cache.png`. Pass when the versioned assets resolve together.
- [ ] Lane 8. Reject GPU initialization. Save `web-no-gpu.png`. Pass when the incumbent path opens the same destination.
- [ ] Lane 9. Exercise a sign-in popup and an attachment. Save `web-platform.png`. Pass when redirect, focus, and persisted result match.
- [ ] Lane 10. Restore the prior web revision. Save `web-alias-rollback.png`. Pass when thread data stays current and previously saved links still open.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Cold and warm time to first usable thread and cache transfer size.
- [ ] Probe. Use the same published-origin fixtures and browser profiles at both revisions with cached and uncached assets.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% or 250 ms more p95 time for the default route. Fail above the P02 transfer budget.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P09. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Switch the qualified desktop shell default (P10)

**Depends on.** P08 and P09.

**Files.**

- [ ] Create `native/sail-desktop/` for the native launcher and platform services.
- [ ] Edit `apps/desktop/src/app/`, `apps/desktop/src/backend/`, `apps/desktop/src/updates/`, and desktop packaging where ownership transfers.

**Build.**

- [ ] Launch the existing Node host as an independent bundled executable. Adopt existing app identity, state paths, catalog, supported secure credentials, browser profiles, shortcuts, and deep links. Keep one local supervisor and an Electron recovery entry. Gate startup on both backend readiness and a usable window. Preserve CLI and OS activation, update handoff, and rollback. Ship R3 per target after its full manifest passes.

**You see.**

- [ ] A normal desktop launch or update opens the same app, same destination, and same saved hosts.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked desktop and client tests and `vp test run apps/desktop/src/backend/DesktopBackendManager.test.ts`. Extend the installed desktop smoke to detect a crash after OS launch.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the full desktop parity manifest at trunk and head. Save `desktop-parity.png`. Pass when all captures and interactions match.
- [ ] Lane 2. Upgrade the last stable macOS bundle. Save `desktop-macos.png`. Pass when identity, preferences, and connections carry forward.
- [ ] Lane 3. Upgrade the last stable Linux AppImage and DEB. Save `desktop-linux.png`. Pass when launchers and same-home state are correct.
- [ ] Lane 4. Open a deep link and rerun the CLI shim. Save `desktop-activation.png`. Pass when one process opens the same window and thread.
- [ ] Lane 5. Import or broker macOS and Linux stored credentials. Save `desktop-credentials.png`. Pass when the same saved environments connect.
- [ ] Lane 6. Start with Local disabled and connect an SSH host. Save `desktop-remote-only.png`. Pass when no unexpected local backend starts.
- [ ] Lane 7. Kill the app after OS launch and before window readiness. Save `desktop-post-launch-crash.png`. Pass when the recovery path opens Electron.
- [ ] Lane 8. Install while a local backend is running. Save `desktop-update.png`. Pass when the handoff admits one owner and the client reconnects.
- [ ] Lane 9. Reopen a saved Browser panel profile. Save `desktop-browser-state.png`. Pass when cookies, preview, and permissions match.
- [ ] Lane 10. Restore the preceding desktop release. Save `desktop-fallback.png`. Pass when the same home and all accepted recent writes remain readable.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 launch-to-usable and updater-to-usable window.
- [ ] Probe. Alternate last stable installer and candidate on each released platform. Measure cold, warm, and upgrade launch.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% or 300 ms more p95 time. Require recovery to reach the incumbent on every injected startup failure.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P10. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Move bounded workspace services into Rust (P11)

**Depends on.** P01.

**Files.**

- [ ] Create `native/sail-services/` for Rust workspace workers.
- [ ] Edit adapters in `apps/server/src/terminal/`, `apps/server/src/workspace/`, and the VCS service as each capability qualifies.

**Build.**

- [ ] Keep Node as the authenticated server and SQLite owner. Port Git reads, workspace file and diff processing, then PTY and other OS process operations behind existing service boundaries. Use one typed private process interface for operations that need isolation. Switch one capability at a time and keep an incumbent path. Preserve cancellation and flow control.

**You see.**

- [ ] The current desktop and web clients see the same results when the selected operation runs in Rust.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked service tests and `vp test run apps/server/src/terminal/Manager.test.ts apps/server/src/terminal/OutputProtocol.test.ts apps/server/src/workspace/WorkspaceFileSystem.test.ts`. Extend the process and wire cases for parity.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same Git query at trunk and head. Save `svc-git.png`. Pass when payloads and Git state match.
- [ ] Lane 2. Read linked and ordinary files in a seeded workspace. Save `svc-files.png`. Pass when access boundaries and contents match.
- [ ] Lane 3. Compute and open a large result. Save `svc-diff.png`. Pass when encoded diff and expected truncation match.
- [ ] Lane 4. Spawn a PTY and exchange fixed bytes. Save `svc-terminal.png`. Pass when output ordering and exit state match.
- [ ] Lane 5. Resize and cancel a live command. Save `svc-cancel.png`. Pass when the terminal settles and children exit.
- [ ] Lane 6. Force a worker crash. Save `svc-crash.png`. Pass when the requester sees one typed error and recovery works.
- [ ] Lane 7. Disable the Rust worker. Save `svc-switch.png`. Pass when the incumbent handles the same operation.
- [ ] Lane 8. Use the same operation remotely. Save `svc-remote.png`. Pass when the selected host owns the request.
- [ ] Lane 9. Replay a read-only or denied mutation. Save `svc-scope.png`. Pass when the same authorization outcome is visible.
- [ ] Lane 10. Start and stop a worker during an update trial. Save `svc-drain.png`. Pass when no orphan process or unintended accepted work remains.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. File and Git operation latency, PTY throughput and memory.
- [ ] Probe. Use fixed repository sizes, PTY byte streams, and command timing. Record private IPC bytes and process memory at trunk and head.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% p95 overhead, any wrong bytes, or unbounded process and queue growth.

**Review gate.** None. P11 does not change a published interaction.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Port provider transports through adapter boundaries (P12)

**Depends on.** P01.

**Files.**

- [ ] Create Rust adapters under `native/sail-providers/` and bridge them through `packages/provider-core/` and `apps/server/src/orchestration-v2/Adapters/` during rollout.
- [ ] Use the adapters installed at P01 and the recorded provider fixtures as the parity inventory.

**Build.**

- [ ] Port one provider family at a time. Keep Node as owner of session admission, durable event receipts, and outbox settlement. Preserve provider IDs, capability advertisement, permissions, native session handles, and ordered output. Replace first-party Node SDK integration paths, including the Claude Agent SDK import, with a supported Rust or process boundary that preserves observed behavior. Keep versioned external provider tools and services as integrations. Ship R4 after P11 and P12 qualify.

**You see.**

- [ ] Sessions start or resume with the same provider and capabilities. Approval, interruption, and recovery end in the same state.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the locked provider tests and `vp test run apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts`. Compare recorded replay and run a bounded live sign-in and resume flow per enabled provider before switching its default.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Replay the same transcript at trunk and head for each adapter. Save `provider-replay.png`. Pass when normalized events and settled state match.
- [ ] Lane 2. Sign in with a consented test account. Save `provider-signin.png`. Pass when capabilities and identity match.
- [ ] Lane 3. Open a preserved native session. Save `provider-resume.png`. Pass when history and session identity match.
- [ ] Lane 4. Submit, steer, and stop a turn. Save `provider-controls.png`. Pass when each command maps to the expected native action.
- [ ] Lane 5. Respond to a permission request. Save `provider-approval.png`. Pass when approval identity, scope, and outcome match.
- [ ] Lane 6. Force adapter exit during a turn. Save `provider-crash.png`. Pass when recovery behaves as advertised for that provider.
- [ ] Lane 7. Replay a lost acknowledgement. Save `provider-ack.png`. Pass when only one turn starts.
- [ ] Lane 8. Swap provider credentials between test environments. Save `provider-credential.png`. Pass when each session stays on its intended identity.
- [ ] Lane 9. Run fork or revert where advertised. Save `provider-fork.png`. Pass when native conversation and workspace state match.
- [ ] Lane 10. Switch back to the incumbent transport. Save `provider-rollback.png`. Pass when the same environment resumes and accepted data survives.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Adapter added latency and memory during a common replay turn.
- [ ] Probe. Measure equivalent provider transcripts and repeat the live check independently of provider network time.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% or 50 ms added p95 adapter work. Fail on any duplicate turn or dropped event.

**Review gate.** None. P12 does not change a published interaction.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Implement a wire-compatible Rust host on isolated homes (P13)

**Depends on.** P01.

**Files.**

- [ ] Create `native/sail-server/` for the Rust HTTP and WebSocket server.
- [ ] Use `apps/server/src/ws.ts`, `packages/contracts/`, and existing auth and HTTP tests as references.

**Build.**

- [ ] Implement discovery, configuration, static assets, typed errors, pair and token endpoints, auth scopes, RPC v2, HTTP snapshot routes, upgrades, origin checks, stream acknowledgements and backpressure, interrupts, and shutdown. Use synthetic or copied homes. Keep experimental candidates outside the current server's real home and public feed. Prove both old and new clients against the same contract fixtures.

**You see.**

- [ ] An incumbent client and a GPUI client discover and use a Rust host with the same valid and invalid request results.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked server tests and `vp test run apps/server/src/ws.test.ts apps/server/src/browserPairing.test.ts apps/server/src/auth/SessionStore.test.ts`. Run P01 wire conformance in both directions.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Pair and stream with the incumbent client on each host. Save `host-incumbent.png`. Pass when discovery, config, and stream results match.
- [ ] Lane 2. Connect GPUI desktop to both hosts. Save `host-gpui-native.png`. Pass when the thread and its events match.
- [ ] Lane 3. Connect GPUI WASM to both hosts. Save `host-gpui-wasm.png`. Pass when origin and websocket results match.
- [ ] Lane 4. Send an unsupported protocol version. Save `host-version.png`. Pass when the same HTTP 426 and update contract appear.
- [ ] Lane 5. Exercise a scoped read and denied mutation. Save `host-scope.png`. Pass when the grant stays within scope.
- [ ] Lane 6. Renew then revoke an active session. Save `host-revoke.png`. Pass when the same lifecycle is visible.
- [ ] Lane 7. Send a sized output stream and interrupt it. Save `host-window.png`. Pass when ack, split-frame behavior, and teardown match.
- [ ] Lane 8. Reconnect at a cursor with a live tail. Save `host-live.png`. Pass when ordering and snapshots match.
- [ ] Lane 9. Force a pruned cursor. Save `host-resnapshot.png`. Pass when clients use the matching snapshot path.
- [ ] Lane 10. Serve the exact static web assets. Save `host-assets.png`. Pass when cache and bootstrap versions match.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Handshake, first snapshot, and stream p95 and bytes.
- [ ] Probe. Drive the same incumbent and Rust fixture with identical negotiated options and capture output sizes.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% p95 latency or 5% extra bytes. Require equivalent typed errors and flow control.

**Review gate.** None. P13 does not change a published interaction.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Port durable orchestration and recovery before write handoff (P14)

**Depends on.** P13.

**Files.**

- [ ] Edit `native/sail-server/` for migrations, decisions, projections, command receipts, and outbox.
- [ ] Use `apps/server/src/orchestration-v2/`, `apps/server/src/persistence/Migrations.ts`, and `apps/server/src/serverOwnership.ts` as the references.

**Build.**

- [ ] Port transactions and ordered publication as a single owner. Preserve migration IDs, environment identity, retained event encodings, projected history, request IDs, read positions, checkpoints, worktree associations, and durable or process-bound effects. Rehearse against disposable copies of the oldest supported predecessors, recent production-shaped snapshots, and interrupted updates. Run structural comparisons against SQLite and adjacent files. Keep shadow comparisons and candidate trials isolated from live writes.

**You see.**

- [ ] The same durable commands and interruption points produce matching history, projections, and recovery state.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked migration and recovery tests and `vp test run apps/server/src/orchestration-v2/EventSink.test.ts apps/server/src/orchestration-v2/ProjectionRecovery.test.ts apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Replay the same commands at trunk and head from equal snapshots. Save `store-replay.png`. Pass when journal, projections, receipts, and effects match.
- [ ] Lane 2. Upgrade the oldest supported fixture and open old history. Save `store-old.png`. Pass when migrations are complete and retained history opens.
- [ ] Lane 3. Reject a duplicate command after lost reply. Save `store-idempotent.png`. Pass when the receipt stays stable and no extra effect is queued.
- [ ] Lane 4. Crash before and after the command transaction. Save `store-crash.png`. Pass when atomicity and visible output agree.
- [ ] Lane 5. Crash after commit before publication. Save `store-publish.png`. Pass when reconnect resumes at the correct sequence.
- [ ] Lane 6. Restore a snapshot after event pruning. Save `store-pruned.png`. Pass when materialized history is complete.
- [ ] Lane 7. Recover a stopped, approved, and interrupted provider turn. Save `store-provider.png`. Pass when only valid work resumes.
- [ ] Lane 8. Run background and scheduled effects during controlled recovery. Save `store-jobs.png`. Pass when claim, order, and settlement match.
- [ ] Lane 9. Attempt concurrent ownership on the same fixture home. Save `store-owner.png`. Pass when one runtime owns the home.
- [ ] Lane 10. Compare attachments, settings, secrets, and checkpoint refs. Save `store-adjacent.png`. Pass when all outside-SQLite data remains valid.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 command commit, ready time and SQLite write volume.
- [ ] Probe. Use the same restored snapshots and command corpus. Capture transaction timing, WAL, disk, and recovery cost.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% p95 steady-state overhead, 15% migration overhead, or divergent durable state.

**Review gate.** None. P14 does not change a published interaction.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Qualify the Rust launcher and host on real upgrade paths (P15)

**Depends on.** P11, P12, P13, and P14.

**Files.**

- [ ] Create `native/sail-launcher/` and adapt the CLI, container, and desktop launch paths.
- [ ] Use `apps/server/src/serviceLauncher.ts`, `apps/server/src/serverAdmission.ts`, `packages/ssh/`, and `native/sail-boat/` as integration references.

**Build.**

- [ ] Match the previous launcher protocol and exact-version installation paths. Drain accepted work and fence producer roots before stopping the incumbent. Take a verified database and adjacent-data recovery snapshot after exit. Take the existing home lock, migrate, bind, report prepared, and leave admission closed until durable commit. Preserve update IDs and boot the previous runtime if a trial fails. Keep managed Boat handoff off until the producer census is complete. Ship R5 with explicit opt-in.

**You see.**

- [ ] A canary can select Rust and open the same environment. A failed trial reports rollback and reopens the same environment on Node.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked launcher and server tests and `vp test run apps/server/src/serviceLauncher.test.ts apps/server/src/serverAdmission.serving.test.ts`. Add mixed-owner restart and failure checkpoints to the installed-archive smoke.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Rehearse the same packaged update at trunk and head. Save `handoff-once.png`. Pass when the same environment returns with once-only effects.
- [ ] Lane 2. Install macOS and Linux packaged candidates on copied data. Save `handoff-desktop.png`. Pass when the desktop status completes after real ready.
- [ ] Lane 3. Install the exact Linux CLI artifact and update under a service manager. Save `handoff-cli.png`. Pass when the stable launcher selects the correct SHA.
- [ ] Lane 4. Update a remote SSH environment. Save `handoff-ssh.png`. Pass when reconnect preserves identity and existing permissions.
- [ ] Lane 5. Run a remote T3 Connect pairing through the container candidate. Save `handoff-connect.png`. Pass when proof-bound credentials and thread streaming work.
- [ ] Lane 6. Sleep, wake, and restore a Boat fixture. Save `handoff-boat.png`. Pass when the correct workspace resumes without changing owner.
- [ ] Lane 7. Crash after prepared and before durable commit. Save `handoff-precommit.png`. Pass when snapshot and Node recovery are verified.
- [ ] Lane 8. Fail the snapshot with insufficient disk. Save `handoff-disk.png`. Pass when the incumbent remains ready.
- [ ] Lane 9. Race launch, scheduled producers, and updater restart. Save `handoff-race.png`. Pass when no second server or extra work is admitted.
- [ ] Lane 10. Start a downgrade after a trial accepted writes. Save `handoff-postcommit.png`. Pass when backward-readable state retains those writes or the downgrade is refused.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Update outage and time from prepared to admitted.
- [ ] Probe. Alternate prior Node updates and Rust trials under equal producer load and fixture size. Record drain and restore separately.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% longer p95 outage with the same workload. Require first-try recovery at each admitted failure checkpoint.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P15. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Default the qualified Rust host and migrate remaining runtime services (P16)

**Depends on.** P10 and P15.

**Files.**

- [ ] Edit the Rust server and launcher, server image, deployment configuration, and installer scripts.
- [ ] Port required first-party services in `infra/relay/` and `native/sail-boat/src/machine/` using the existing control-plane and Boat protocols.

**Build.**

- [ ] Finish auth and OAuth, MCP and peer links, scheduler and webhooks, Browser hosting, provider, source-control, and integration coverage. Port remaining runtime Node portions of Boat lifecycle and relay to Rust on their deployment targets. Preserve tunnel authorization, account boundaries, durable object migrations, CLI contracts, and Fly entry points. Qualify production-shaped installations before enabling Rust by default for each supported topology. Keep a supported Node recovery artifact. Ship R6.

**You see.**

- [ ] Desktop, web, CLI, automation, and remote services expose the incumbent behavior while Rust owns each qualified host home.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run locked host and relay tests, `cargo test --locked --manifest-path native/sail-boat/Cargo.toml`, and `vp test run infra/relay/src/http/Api.test.ts infra/relay/src/environments/EnvironmentConnector.test.ts`. Run a recovery installation before promoting each topology.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the full host workflow parity suite at trunk and head. Save `rust-default.png`. Pass when all incumbent clients and GPUI clients pass.
- [ ] Lane 2. Fresh install and upgrade the default Linux CLI service. Save `rust-cli.png`. Pass when the expected Rust build runs and the same home opens.
- [ ] Lane 3. Update bundled desktop from incumbent and canary releases. Save `rust-desktop.png`. Pass when same threads and indicators survive.
- [ ] Lane 4. Deploy the pinned server image to a test Fly environment. Save `rust-fly.png`. Pass when runtime version, volume, origin, and remote peers agree.
- [ ] Lane 5. Pair, revoke, and change tunnel routes via the relay. Save `rust-relay.png`. Pass when proof checks and visible environment identity match.
- [ ] Lane 6. Run an authorized MCP call and a scheduled webhook. Save `rust-mcp.png`. Pass when scope, execution, and resulting thread state match.
- [ ] Lane 7. Open a peer-linked thread and exercise limited writes. Save `rust-peer.png`. Pass when the same link origin and mode ceilings hold.
- [ ] Lane 8. Wake and restore a Boat across the upgrade. Save `rust-boat.png`. Pass when its controller, data, and endpoint recover.
- [ ] Lane 9. Force a crash after activation. Save `rust-restart.png`. Pass when owned effects recover and current writes remain visible.
- [ ] Lane 10. Exercise the supported Node recovery path. Save `rust-rollback.png`. Pass when the published procedure retains current state.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 update outage, normal turn latency, and idle memory.
- [ ] Probe. Compare last stable host and Rust with identical transports, producers, traffic, and hardware. Observe relay latency separately.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% worse p95 or 10% more idle memory. Require all approved workloads and scopes to match.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P16. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Retire the legacy runtimes after the compatibility window (P17)

**Depends on.** P16.

**Files.**

- [ ] Remove shipped Electron and React paths in `apps/desktop/` and `apps/web/` once their consumers have moved.
- [ ] Remove the production Node host and build payloads from `apps/server/`, the desktop installer, Linux CLI archive, OCI image, and web deployment. Keep the versioned bridge assets and restore instructions.

**Build.**

- [ ] Recheck the complete P01 feature inventory and both reference renderers. Wait at least one full stable release cycle and 30 days after R6 becomes default. Require that every supported predecessor has a tested direct or bridge upgrade and that recovery retains post-cutover accepted writes. Require parity on the entire supported browser matrix, including an equivalent rendering path for supported configurations that cannot open the GPUI canvas. Keep retirement blocked until those configurations qualify. Remove adapters, flags, and payloads with their last caller. Keep only the environment protocol compatibility that supported remote installations still need. Ship R7 after checking the actual artifacts for runtime dependencies.

**You see.**

- [ ] Users update to the Rust desktop, GPUI web, and Rust host and complete the same workflows with the same saved data. The public assets contain the expected Rust builds.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run targeted compatibility tests, locked Rust and WASM tests, `vp run check:changed`, and the final packaged smoke and provenance checks. Inspect release SBOMs and service processes for first-party Node runtime paths.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `gpt-6.2-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the full desktop and web parity manifest at incumbent and head. Save `final-parity.png`. Pass when all screenshots and behaviors pass.
- [ ] Lane 2. Install the clean macOS and Linux packages. Save `final-desktop.png`. Pass when usual launches, update identity, and expected binaries work.
- [ ] Lane 3. Upgrade from the oldest supported installation. Save `final-oldest.png`. Pass when direct or documented bridge path preserves all data.
- [ ] Lane 4. Upgrade the latest public hybrid installation. Save `final-upgrade.png`. Pass when normal updater and browser route keep the same experience.
- [ ] Lane 5. Pair hosted and server-served clients to the tagged image. Save `final-web.png`. Pass when both origins serve the intended immutable assets.
- [ ] Lane 6. Install and update the shipped Linux archive. Save `final-cli.png`. Pass when the version matches and the previous launcher can hand off.
- [ ] Lane 7. Run all enabled providers and integrations from the packaged server. Save `final-provider.png`. Pass when each supported flow works with no first-party Node runtime.
- [ ] Lane 8. Inspect artifacts and installed process trees. Save `final-runtime.png`. Pass when release matches the declared payload contract.
- [ ] Lane 9. Fail the candidate and exercise the retained bridge. Save `final-recovery.png`. Pass when recovery preserves post-cutover writes.
- [ ] Lane 10. Fetch the published assets without build credentials. Save `final-public.png`. Pass when release tag, hashes, update manifest, and immutable image match.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 startup, turn and replay latency, and shipped runtime bytes.
- [ ] Probe. Compare the current official artifacts and R7 on the same verification workloads. Scan extracted assets and record runtime processes on each target.
- [ ] Baseline. Record the incumbent p95 and raw samples first. Record an absolute budget for candidate-only work when trunk has no equivalent.
- [ ] Rule. Fail above 10% worse p95, on a missing migration path, or on a first-party Node, Electron, or React runtime payload in an official artifact.

**Review gate.** The operator reviews before merge.

- [ ] Post the matched screenshots, zero-pixel diff, and a 30 to 60 second video for P17. The operator checks the evidence and approves the exact head before merge.

**Merge.**

- [ ] Record the exact clean head verdict, review triage, recomputed parity and performance result for affected paths, and the merged SHA.

## Close the program

- [ ] Check every required box and reconcile each PR and published release with its source and artifacts. Record any restriction or unqualified feature.
- [ ] On each supported target, open the same project and thread from an upgraded install, run the baseline workflows with the tagged release, and download and verify the public assets again. Record what the user sees and the durable result.
- [ ] Confirm installed GPUI desktop, hosted and server-served GPUI web, and the Rust host are in their final published artifacts. Verify supported upgrades, access control, recovery, and the retained compatibility window references.
- [ ] Close the coordination schedule after the last stable release is verified and hand back the release links, gates, and recovery instructions.

## Appendix A. Prototype evidence

- Sail source at `18fd0e5d66291fc007163512d783d7268218db16` shows existing Rust helpers and a Rust client of the Node RPC protocol. [Desktop native packaging](../../scripts/build-desktop-artifact.ts) · [Boat upstream client](../../native/sail-boat/src/proxy/upstream.rs)
- Zed upstream builds native and browser targets from the same example source. The web platform renders a document-owned canvas with WebGPU or WebGL2 and one top-level window. This is upstream evidence. P02 records the pinned revision, Sail prototype SHA, matched screenshots, and browser and platform receipts. [Shared GPUI example](https://github.com/zed-industries/zed/blob/main/crates/gpui/examples/hello_world.rs) · [GPUI web backend](https://github.com/zed-industries/zed/blob/main/crates/gpui_web/src/gpui_web.rs)
- Sail-specific native and WASM parity, packaged in-place upgrades, and Node-to-Rust live state takeover remain unproven. P01 through P04 cover the first client release. P14 through P16 cover host takeover.

## Appendix B. Alternatives rejected

- A simultaneous client, host, and installer replacement makes it hard to identify which change broke an upgrade. Keep the existing authenticated wire contract and change each owner on a separate verified release.
- Widget-level embedding of GPUI in the React tree would require a native bridge through Chromium's rendering and input system. Start with complete workflows and keep the incumbent route available until the replacement qualifies.
- Giving both hosts write access to one home would bypass the existing commit and publication ordering. Transfer durable state ownership once per environment.
- A separate Rust frontend that renders ordinary HTML remains a viable recovery design if GPU-backed web rendering cannot match the incumbent. Help the operator weigh a web target change before activating such a design.

## Appendix C. Risks

| Risk                                                                                               | Owner                   | Evidence that closes it                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Different font rasterization, layout, focus, selection, IME, screen reader output, zoom, or motion | P01 through P10         | Matching app-owned screenshots, action traces, and input and accessibility receipts for every released platform               |
| WebGPU and WebGL2 availability, assets, headers, or a browser-specific capability gap              | P02, P08, P09, P17      | Browser field matrix, exact origin receipts, and verified continuity on supported configurations                              |
| Browser profiles, keychains, activation, updater binding, and local server ownership               | P04, P08, P10           | Prior-release-to-candidate packaged upgrades and crash recovery against preserved data                                        |
| Wire skew, missed stream output, or duplicate sends                                                | P01, P03, P13, P16      | Same protocol fixtures, old/new client combinations, disconnect probes, and matching state                                    |
| Node SDK-only features and process-local provider sessions                                         | P12, P14, P16           | Recorded replay plus real-provider qualification, explicit resume support, and a fallback for each provider until replacement |
| Pruned journal, SQLite migrations, lost owner, and older launchers                                 | P14, P15, P16           | Snapshot recovery, matching materialized state, and failure injection both before and after activation                        |
| Existing desktop or server updates use an older installation path                                  | P04, P10, P15, P17      | New and previous launcher compatibility, a successful update by the documented mechanism, and a retained bridge               |
| Public release rerun overwrites an asset or moves a stable pointer                                 | P04 and every promotion | Duplicate-version and altered-receipt guards with exact SHA, asset digests, and image manifest                                |
| Runtime sidecars survive the rewrite                                                               | P16, P17                | Release-asset and process inventories, first-party production dependency checks, and managed-host parity                      |

## Appendix D. Links and reading list

- Read [Architecture](../internals/01_architecture.md), [Provider adapters](../internals/03_providers.md), [Environment authentication](../internals/04_environment-auth.md), [Remote architecture](../internals/05_remote.md), and [T3 Connect](../internals/06_t3-connect.md) before changing wire, state, or remote execution.
- Read [Server updates](../internals/07_server-updates.md), [Connection runtime](../internals/09_connection-runtime.md), [Internationalization](../internals/14_i18n.md), and [Testing](../internals/15_testing.md) before implementing the respective slice.
- Use the checked-in [Sail release workflow](../../.github/workflows/release.yml) and [version alignment script](../../scripts/update-release-package-versions.ts) to check current promotion behavior. The [release runbook](../operations/03_release.md) includes inherited upstream procedures. P04 updates Sail's current release path.
- Use the repo's [desktop and web control skill](../../.agents/skills/test-t3-app/SKILL.md) for the incumbent application. Use the P02 driver for GPUI. Use pstack `how` before moving a service boundary and `interrogate` before reviewing implementation. Keep the trail under pstack's `show-me-your-work` workflow.

# Sail personal cloud server plan

A developer runs one script and gets their own always-on Sail server on Fly.io at `https://<app>.fly.dev`, serving the same web UI the desktop app shows.
The desktop app joins that server with one click on a `sail://pair` link and can make it the main server, and a phone joins by scanning a QR code.
The rule is one server, many clients. Desktop and web show the same threads, providers, skills, settings, and preferences because they read one server.
Boats moves from the desktop process into the server, so `/boats` works from desktop, a local browser, and the Fly web app.
Boat machines install Sail's own server, which the release starts publishing, and remote clients reach machines at their own HTTPS address.
Every lane runs locally against stand-ins for Fly, Boat, and paid models that W3 builds, and Appendix E lists the real-account checks for later.
PRs in stack order are W1 to W13.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `<plugin root>/skills/poteto-mode/playbooks/autopilot-stack.md`. `<plugin root>` is the pstack plugin directory that holds `skills/poteto-mode/SKILL.md`. Inside Acid it is a `builtin-skills/<hash>` directory under `~/.t3/userdata`. The root builds one linear base-chained stack on `snowdamiz/sail`, rooted at `main`. Owners stop every PR at STACK-READY. The operator reviews and lands the stack bottom-up. No lane uses a Fly org, a boat.dev account, or a paid model. W6 lanes 1 and 2 are the only lanes that publish, and they create a draft prerelease with a private image.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Record in the decision trail the operator's calls from 2026-11-25. W13 is in scope, shared preferences default on, and every lane verifies with local stand-ins until real accounts exist.
- [ ] Read these at program start. Re-read them at every tick.
  - [ ] `cat <plugin root>/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `cat <plugin root>/skills/poteto-mode/playbooks/autopilot-full.md`
  - [ ] `cat <plugin root>/skills/swarm/SKILL.md`
  - [ ] `cat .agents/skills/test-t3-app/SKILL.md`
  - [ ] `cat <plugin root>/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `cat <plugin root>/skills/interrogate/SKILL.md`
  - [ ] `cat <plugin root>/skills/deslop/SKILL.md`
  - [ ] `cat <plugin root>/skills/no-comments/SKILL.md`
  - [ ] `cat <plugin root>/skills/show-me-your-work/SKILL.md`
- [ ] On the operator's go, arm the audit tick as an hourly schedule_task bound to this thread with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from disk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Each owner branches from its parent's branch, because the stack is linear.
  - [ ] W1 branches from `main`.
  - [ ] W2 after W1. W3 after W2. W4 after W3. W5 after W4. W6 after W5. W7 after W6.
  - [ ] W8 after W7. W9 after W8. W10 after W9. W11 after W10. W12 after W11. W13 after W12.
- [ ] Hold the file boundaries. Each PR touches only the paths in its own **Files.** block, the tests beside them, and the layer wiring that registers a new service. An owner that needs another path stops and asks the root, and the root records the change in this plan.
- [ ] Hold the review gate. W4, W7, W8, W9, W11, W12, and W13 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run `vp run check:changed` once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Run `/interrogate` with the `interrogate reviewers` panel on every PR before STACK-READY.
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.
- [ ] Translate new user-facing copy with `vp run i18n:generate`, then pass `vp run i18n:check`.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head. Run each full swarm per `<plugin root>/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends each clean PR to the stack with its base set to its parent's branch. Only the root rebases or retargets a link. The operator lands the stack bottom-up. A link whose patch-id is unchanged after a rebase keeps its verdict, per `playbooks/shipping.md`.

### Boot recipe, for every live lane

Each live lane runs in its own worktree at the PR head. Drive through the control skill above. Web lanes use `test-t3-app`. Container lanes use `docker` and `curl`. Fly lanes use the fake `fly` from W3, and Boat lanes use the fake `boat` from W3 and the Boats UI.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `vp i` once in the lane worktree.
- [ ] For a web lane, run `vp run dev` from the lane worktree, read the ports and the pairing URL from its output, and open the URL with `preview_navigate`. Never use `~/.t3/userdata` or `~/.sail`.
- [ ] For a lane that opens a `sail://` link, build the packaged desktop app from the lane SHA with `vp run build:desktop && vp run dist:desktop:artifact`, and run it with a temp `SAIL_HOME`. Desktop dev registers `sail-dev://`, so it cannot answer a `sail://` link.
- [ ] For a container lane, run `docker build -t sail-server:<short-sha> .`, then `docker run -d -p <free-port>:8080 -v sail-lane-<n>:/data sail-server:<short-sha>`. Capture the container id. Remove only that container and volume at the end.
- [ ] For a lane that needs released artifacts, build them locally at the lane SHA with the scripts the release workflow calls, and serve them with `node scripts/fixtures/release-mirror.ts`. Point `install.sh` at it with `T3CODE_RELEASE_BASE_URL`.
- [ ] For a Fly lane, put `scripts/fixtures/fake-fly` first on `PATH` and run `deploy/fly/deploy.sh --app sail-lane-<short-sha>-<n> --image sail-server:<short-sha>`. The fake serves the app at `https://<app>.localtest.me` through Caddy with `tls internal`. Run `fly apps destroy sail-lane-<short-sha>-<n> --yes` at the end.
- [ ] For a Boat lane, put `scripts/fixtures/fake-boat` first on `PATH` before the server starts. Each fake sandbox is a local container. Remove every fake sandbox at the end.
- [ ] Bundled servers have no `Replay (dev)` provider. A lane that needs an agent turn on a container, fake Fly, or fake Boat server runs `node scripts/fixtures/replay-provider.ts --home <SAIL_HOME>` first and uses the `showcase` model.
- [ ] Deliver input only through the control skill's commands. Read-only diagnostics are `curl`, `docker logs`, the fake `fly logs`, and `sqlite3 -readonly` on a copy of the lane's own data.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Stop Sail from building or trusting app.t3.codes links (W1)

**Depends on.** None. W1 is the stack root on `main`.

**Files.**

- [ ] Edit `packages/shared/src/connectAuth.ts` to remove `DEFAULT_HOSTED_APP_URL`, so the hosted origin is `string | undefined` everywhere.
- [ ] Edit `packages/shared/src/threadLinks.ts` so the hosted prefix and pattern are built per call and do not exist when the hosted origin is absent.
- [ ] Edit `packages/shared/src/promptLinks.ts` so an absent or empty origin falls back to the environment origin instead of throwing.
- [ ] Edit `packages/shared/src/providerAuthReturnUrl.ts` to take the trusted origin from its caller and drop the `https://app.t3.codes` literal.
- [ ] Edit `apps/web/src/hostedPairing.ts` and `apps/web/src/components/settings/ConnectionsSettings.logic.ts` so pairing links fall back to the direct link.
- [ ] Edit every caller of `configuredHostedAppUrl`, including `Sidebar.tsx`, `CommandPalette.tsx`, `copyPromptLink.ts`, `ChatView.tsx`, `MarkdownThreadLink.tsx`, and `CodexSetupSection.tsx`.
- [ ] Edit `apps/server/src/cloud/publicConfig.ts`, `apps/server/src/auth/McpOAuth.ts`, and `apps/server/src/auth/mcpOAuthHttp.ts` to treat the hosted URL as optional, and remove `NIGHTLY_HOSTED_APP_URL`.
- [ ] Edit `threadLinks.test.ts`, `promptLinks.test.ts`, `providerAuthReturnUrl.test.ts`, and `ConnectionsSettings.logic.test.ts`.

**Build.**

- [ ] Treat the hosted app URL as absent unless `VITE_HOSTED_APP_URL` is set, and make every link builder and origin check use the server's own origin instead.

**You see.**

- [ ] Copying a thread link from the sidebar gives a link to this server, and Codex's manual sign-in callback works on a non-loopback HTTPS origin.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Each edited test file gains an absent-origin case and an empty-string case. Run `vp test run packages/shared/src/threadLinks.test.ts packages/shared/src/promptLinks.test.ts packages/shared/src/providerAuthReturnUrl.test.ts apps/web/src/components/settings/ConnectionsSettings.logic.test.ts`.
- [ ] `providerAuthReturnUrl.test.ts` gains a case where `https://sail.example.test` is accepted only when the caller passes it as trusted.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Copy a thread link from the sidebar at trunk and head. Save `w1-sidebar-link.png`. Pass when trunk contains `app.t3.codes` and head contains the dev server origin.
- [ ] Lane 2. Copy a thread link from the command palette. Save `w1-palette-link.png`. Pass when it opens the same thread in a new tab.
- [ ] Lane 3. Copy a prompt link and open it. Save `w1-prompt-link.png`. Pass when a new tab on the same server opens with the prompt in the composer.
- [ ] Lane 4. Paste a thread link into a message and click it. Save `w1-markdown-link.png`. Pass when it navigates to the thread.
- [ ] Lane 5. Paste an old `https://app.t3.codes/threads/a/b` link into a message. Save `w1-old-link.png`. Pass when it renders as a plain link and the page does not crash.
- [ ] Lane 6. Build the web app with `VITE_HOSTED_APP_URL=https://hosted.example.test` and copy a thread link. Save `w1-configured-hosted.png`. Pass when it starts with `https://hosted.example.test`.
- [ ] Lane 7. Put the dev server behind `caddy reverse-proxy --from sail.localtest.me` with `tls internal`, then run the Codex manual callback. Save `w1-codex-callback.png`. Pass when the return URL is accepted.
- [ ] Lane 8. Create a LAN pairing link in Sharing & access. Save `w1-lan-link.png`. Pass when it matches trunk's link format.
- [ ] Lane 9. Run `rg -c "app\.t3\.codes" apps/server/dist apps/web/dist`. Save `w1-bundle-grep.txt`. Pass when the count is 0.
- [ ] Lane 10. Revoke the paired browser in Sharing & access, then reload it. Save `w1-revoked.png`. Pass when the revoked tab shows the pairing screen.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Gzipped size in bytes of all JS in `apps/web/dist/assets` at trunk and head.
- [ ] Probe. Run `vp run --filter @t3tools/web build` three times per side, interleaved trunk, head, trunk, head, and sum `gzip -c | wc -c` per file.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 2048 bytes.

**Review gate.** None. W1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W1 as the stack root, and the operator lands it bottom-up.

## Make pairing links correct and quiet for a deployed server (W2)

**Depends on.** W1.

**Files.**

- [ ] Edit `apps/server/src/cli/config.ts` to add `--public-url` with `SAIL_PUBLIC_URL`, falling back to `T3CODE_PUBLIC_URL`, and `--startup-pairing off` with `SAIL_STARTUP_PAIRING`.
- [ ] Edit `apps/server/src/startupAccess.ts` so pairing output uses the public URL, and so startup issues no credential when startup pairing is off.
- [ ] Edit `apps/server/src/serverRuntimeState.ts` to record the public URL.
- [ ] Edit `apps/server/src/cli/pair.ts` to resolve the home through the same `SAIL_HOME` then `T3CODE_HOME` config as `cli/config.ts:141-144`, and to read the recorded public URL.
- [ ] Edit `apps/server/src/cli/auth.ts` so `auth pairing create` defaults `--base-url` to the recorded public URL and gains `--require-running`, which refuses to mint when no live server owns the home.
- [ ] Edit `apps/web/src/environments/primary/auth.ts` and `apps/web/src/components/auth/PairingRouteSurface.tsx` if the reused-profile failure from Appendix A reproduces.
- [ ] Edit `apps/server/src/startupAccess.test.ts`, `apps/server/src/binCli.test.ts`, and a new browser test for pairing with a stale same-host cookie.
- [ ] Edit `docs/user/remote-access.md` to document both flags.

**Build.**

- [ ] Thread one optional `publicUrl` from config into every pairing-URL builder, let managed deploys turn off the startup credential, and fix home discovery for `t3 pair`.
- [ ] Reproduce the prototype's spent-token, signed-out failure with a stale cookie for the same host, then fix its first wrong step.

**You see.**

- [ ] `t3 serve --host 0.0.0.0 --port 8080 --public-url https://demo.fly.dev --startup-pairing off` logs a ready line with no token, and `t3 pair` prints `https://demo.fly.dev/pair#token=`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `startupAccess.test.ts` gains cases for set and unset `publicUrl` and for startup pairing off. Run `vp test run apps/server/src/startupAccess.test.ts`.
- [ ] `binCli.test.ts` gains cases for `SAIL_HOME` discovery in `pair` and for `--require-running`. Run `vp test run apps/server/src/binCli.test.ts`.
- [ ] The new stale-cookie browser test fails on trunk and passes on head. Run it with `vp test run <its path>`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `SAIL_HOME=<tmp> t3 serve --host 0.0.0.0 --port 8080`, then `SAIL_HOME=<tmp> t3 pair`, at trunk and head. Save `w2-sail-home-pair.txt`. Pass when trunk cannot find the server and head prints a link.
- [ ] Lane 2. Run head with `--public-url https://demo.fly.dev`. Save `w2-public-url.txt`. Pass when startup prints `https://demo.fly.dev/pair#token=`.
- [ ] Lane 3. Run head with `--startup-pairing off`. Save `w2-quiet-logs.txt`. Pass when `rg "#token=|Token:"` over the logs finds nothing.
- [ ] Lane 4. Run `t3 auth pairing create --json` with no `--base-url`. Save `w2-auth-create.txt`. Pass when `.pairUrl` starts with the public URL.
- [ ] Lane 5. Stop the server and run `t3 auth pairing create --json --require-running`. Save `w2-require-running.txt`. Pass when it exits non-zero and mints nothing.
- [ ] Lane 6. Pair a browser, then open a second fresh link in the same profile. Save `w2-reused-profile.png`. Pass when the tab ends signed in.
- [ ] Lane 7. Open one link in two tabs of different profiles. Save `w2-used-link.png`. Pass when the first tab is signed in and the second explains the link was used and how to get a new one.
- [ ] Lane 8. Pass `--public-url not-a-url`. Save `w2-bad-url.txt`. Pass when the server exits non-zero with a message that names the flag.
- [ ] Lane 9. Start desktop dev at head. Save `w2-desktop-unchanged.png`. Pass when its pairing links match trunk.
- [ ] Lane 10. Restart the server without flags. Save `w2-flags-removed.txt`. Pass when `t3 pair` falls back to the interface IP and startup prints a token again.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from process start to the ready log line on a fresh home.
- [ ] Probe. Start `t3 serve` five times per side, interleaved trunk and head, each on a new temp `SAIL_HOME`.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 5 percent.

**Review gate.** None. W2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W2 on W1, and the operator lands it bottom-up.

## Build local stand-ins for Fly, Boat, and paid models (W3)

**Depends on.** W2.

**Files.**

- [ ] Create `scripts/fixtures/fake-fly/fly`, a `fly` command for the subcommands `deploy/fly/deploy.sh` calls. It covers `auth whoami`, `apps create`, `apps list`, `apps destroy`, `volumes create`, `volumes list`, `volumes snapshots create`, `deploy`, `ssh console -u -C`, `logs`, `image show`, and `machine status`.
  - [ ] Back each app with one local container and one named volume, and log every call as JSON for tests.
  - [ ] Serve each app at `https://<app>.localtest.me` through one Caddy container with `tls internal` that sets `X-Forwarded-Proto` the way Fly Proxy does.
- [ ] Create `scripts/fixtures/fake-boat/boat`, a `boat --json` command for the subcommands `native/sail-boat/src/boat.rs` calls. It covers `account`, `onboard`, create, `list`, `info`, `exec`, `scp`, `host`, `forward`, `snapshot`, `stop`, `resume`, `extend`, and `delete`, with the JSON fields `boat.rs` parses.
  - [ ] Back each sandbox with a local container from `scripts/fixtures/fake-boat/sandbox.Dockerfile`, which runs systemd as PID 1 so `t3 service install` works.
  - [ ] Make `host` return `https://<sandbox>.localtest.me`, served by the same Caddy container.
  - [ ] Put fake `claude` and `codex` CLIs in the sandbox image that print a sign-in link, accept a pasted code or show a device code, and then report signed in.
- [ ] Create `scripts/fixtures/replay-provider.ts` that copies `apps/server/scripts/dev-replay-agent.ts` and its `dev-replay/` transcripts into a server home and registers them as a local `acpRegistry` provider instance named `Replay (fixture)`.
- [ ] Create `scripts/fixtures/release-mirror.ts` that serves locally built archives, `install.sh`, and `SHA256SUMS` in the layout `T3CODE_RELEASE_BASE_URL` expects.
- [ ] Create `scripts/fixtures/fake-fly.test.ts`, `fake-boat.test.ts`, and `release-mirror.test.ts`, which skip when Docker is missing.
- [ ] Edit `docs/internals/15_testing.md` with one paragraph that names these stand-ins and Appendix E's rule that real-account checks still follow.

**Build.**

- [ ] Build one stand-in per outside service, matched to the exact commands and JSON the code uses, so every later lane runs on one laptop with no accounts.

**You see.**

- [ ] With `scripts/fixtures/fake-fly` first on `PATH`, `fly apps create demo && fly deploy --app demo --image sail-proto:local` serves the Sail app at `https://demo.localtest.me`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Each fixture test drives every subcommand and checks the output shape against the parser that reads it. Run `vp test run scripts/fixtures`.
- [ ] A Rust test in `native/sail-boat` parses recorded fake `boat --json` output. Run `cargo test --manifest-path native/sail-boat/Cargo.toml boat`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no stand-ins, so record that, then create and deploy a fake Fly app from `sail-proto:local`. Save `w3-fake-fly-https.png`. Pass when `https://demo.localtest.me` serves the app shell with a `Secure` session cookie after pairing.
- [ ] Lane 2. Run the fake `fly ssh console -u sail -C "id"`. Save `w3-fake-ssh.txt`. Pass when it runs inside the app's container as `sail`.
- [ ] Lane 3. Snapshot a fake volume, write a file, and restore the snapshot to a new volume. Save `w3-fake-snapshot.txt`. Pass when the restored volume lacks the new file and keeps the old ones.
- [ ] Lane 4. Run the fake `fly logs` while the server starts. Save `w3-fake-logs.txt`. Pass when the ready line streams.
- [ ] Lane 5. Point `sail-boatd` from trunk's desktop at the fake `boat` and open `/boats`. Save `w3-fake-boat-setup.png`. Pass when setup moves past Boat sign-in using the fake code.
- [ ] Lane 6. Create a fake sandbox, then run `boat exec` and `boat scp` into it. Save `w3-fake-sandbox.txt`. Pass when both work and `systemctl --user status` answers inside it.
- [ ] Lane 7. Stop and resume a fake sandbox. Save `w3-fake-stop-resume.txt`. Pass when `info` reports each state and files survive.
- [ ] Lane 8. Run the fake `claude auth login` in a sandbox and paste its code. Save `w3-fake-claude.txt`. Pass when the fake reports signed in afterward.
- [ ] Lane 9. Register the replay fixture in a container server and run a `showcase` turn in the web UI. Save `w3-replay-turn.png`. Pass when the turn completes with its tool calls and approval.
- [ ] Lane 10. Build one CLI archive locally, serve it with the release mirror, and run `install.sh` in `debian:bookworm` with `T3CODE_RELEASE_BASE_URL`. Save `w3-mirror-install.txt`. Pass when `t3 --version` prints the built version.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Seconds for a fake Fly deploy of a prebuilt image and for a fake Boat sandbox to reach a running server. Trunk has no stand-ins, so both have absolute budgets that keep later lanes fast.
- [ ] Probe. Time five fake deploys and five fake sandbox creates on fresh volumes.
- [ ] Baseline. Record the prototype's cold start of about 3 seconds first.
- [ ] Rule. Fail when the fake deploy median exceeds 30 seconds, or the fake sandbox median exceeds 120 seconds.

**Review gate.** None. W3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W3 on W2, and the operator lands it bottom-up.

## Run Boats from the server so every client can use it (W4)

**Depends on.** W3.

**Files.**

- [ ] Create `apps/server/src/boat/BoatSupervisor.ts`, ported from `apps/desktop/src/boat/DesktopBoatSupervisor.ts`.
  - [ ] Set the daemon's whole environment. `SAIL_HOME` is this server's base dir, `SAIL_DESKTOP_CLI` is this server's own `t3` launcher, `SAIL_DESKTOP_ORIGIN` is this server's loopback origin, and `SAIL_BOAT_DATA_DIR` is `<base>/boat`.
  - [ ] Start the daemon at server boot when the Boat data dir holds machines or pending deletions, and on the first Boats call otherwise.
  - [ ] Publish status, state, and notify events through a `PubSub`. Publish no URLs and no codes.
- [ ] Create `apps/server/src/boat/BoatDaemonBinary.ts`, modelled on `apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts`.
- [ ] Edit `native/sail-boat/src/app.rs` and `native/sail-boat/src/daemon.rs` so commands that open a URL, such as `pair_machine`, `open_machine`, `open_thread`, and Boat sign-in, return the URL in their own response instead of a broadcast `desktop_action`.
- [ ] Create `packages/contracts/src/boat.ts` with the status schema, an invoke input whose `command` is an allowlist without `shutdown` and `quit_app`, a result that may carry `openUrl`, and an event union with no actions.
- [ ] Edit `packages/contracts/src/rpc.ts` to add `boatsInvoke` and the streaming `subscribeBoats`.
- [ ] Edit `apps/server/src/auth/RpcAuthorization.ts` and `packages/contracts/src/clientRpcPermissions.ts`. `subscribeBoats` and read commands need a read scope, machine commands a write scope, and `setup_action` and `add_mcp` the maintain scope.
- [ ] Edit `apps/server/src/ws.ts` to register both handlers.
- [ ] Create `packages/client-runtime/src/state/boats.ts`, and edit `packages/client-runtime/src/rpc/client.ts`.
- [ ] Edit `apps/web/src/components/boats/api.ts`, `SailBoatsApp.tsx`, `SetupView.tsx`, and `SettingsView.tsx` to use the environment RPC, act on `openUrl` only in the invoking tab, and say "this server".
- [ ] Hide **Open** and **Add to Sail** for clients that are not on the server's host until W12 ships, because the daemon builds `http://localhost` links.
- [ ] Edit `apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx` to export the pairing helper the Boats page reuses.
- [ ] Edit `apps/desktop/src/backend/DesktopBackendConfiguration.ts` to pass `SAIL_BOATD_PATH` to the server child.
- [ ] Delete `apps/desktop/src/boat/DesktopBoatSupervisor.ts`, `apps/desktop/src/ipc/methods/boat.ts`, the `BOAT_*` channels, the preload `boat` block, and `DesktopBridge.boat` in `packages/contracts/src/ipc.ts`.
- [ ] Move `apps/desktop/src/boat/DesktopBoatSupervisor.test.ts` to `apps/server/src/boat/BoatSupervisor.test.ts`.
- [ ] Add a Boats MCP tool under `apps/server/src/mcp/toolkits/`, per the AGENTS.md Agents rule.
- [ ] Add the Boats entry to the command palette.

**Build.**

- [ ] Make `BoatSupervisor` the one owner of `sail-boatd`, give it the full daemon environment, and send per-click URLs only to the client that clicked.

**You see.**

- [ ] A plain browser tab on the same machine opens `/boats`, sees the Boat setup screen, and no longer sees "Desktop app required".

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `BoatSupervisor.test.ts` keeps the fake-daemon integration and gains cases for the daemon environment, boot start with saved machines, and `notify` delivery. Run `vp test run apps/server/src/boat/BoatSupervisor.test.ts`.
- [ ] An RPC authorization test checks the three scope tiers. Run `vp test run apps/server/src/auth`.
- [ ] Rust tests cover `pair_machine` returning its URL. Run `cargo test --manifest-path native/sail-boat/Cargo.toml`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open `/boats` in the packaged desktop app at trunk and head. Save `w4-desktop-boats.png`. Pass when both show the same setup or machine list.
- [ ] Lane 2. Open `/boats` in a plain browser tab at head. Save `w4-web-boats.png`. Pass when the setup screen renders past the install-T3 step.
- [ ] Lane 3. Start Boat sign-in in tab A while tab B shows `/boats`. Save `w4-signin-isolated.png`. Pass when only tab A shows the link and code.
- [ ] Lane 4. Pair a read-only browser and open `/boats`. Save `w4-readonly.png`. Pass when state renders, actions are disabled, and a forced `boatsInvoke` is rejected.
- [ ] Lane 5. Kill `sail-boatd` by its captured PID, then click refresh. Save `w4-daemon-restart.png`. Pass when status returns to ready without a page reload.
- [ ] Lane 6. Seed a Boat data dir with one machine record, restart the server, and do not open `/boats`. Save `w4-boot-start.txt`. Pass when `sail-boatd` runs within 10 seconds of ready.
- [ ] Lane 7. Trigger a daemon `notify` event. Save `w4-notify-toast.png`. Pass when a toast shows the message in every open client.
- [ ] Lane 8. Search "Boats" in the command palette. Save `w4-palette.png`. Pass when the entry opens `/boats`.
- [ ] Lane 9. Call the Boats MCP tool from an agent thread on Replay (dev). Save `w4-mcp.png`. Pass when it returns the same state the UI shows.
- [ ] Lane 10. With the fake `boat`, create and then delete one machine from the web tab. Save `w4-create-delete.png`. Pass when it appears, then disappears, and the fake `boat --json list` shows no sandbox.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server idle RSS in MiB 60 seconds after ready with no Boats state, plus `get_state` round-trip milliseconds. Trunk has no server-side Boats, so the round trip has an absolute budget.
- [ ] Probe. Start the server five times per side, interleaved, read RSS with `ps -o rss`, then call `get_state` 50 times over the RPC at head.
- [ ] Baseline. Record the trunk idle RSS median first.
- [ ] Rule. Fail when head idle RSS exceeds trunk by more than 10 MiB, or when the head `get_state` p95 exceeds 150 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 4 screenshots into `~/.local/state/t3-pstack/media/sail-web-deploy/w4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of `/boats` in a browser tab on a lane VM. Save it as `~/.local/state/t3-pstack/media/sail-web-deploy/w4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W4 on W3, and the operator lands it bottom-up.

## Build a container image for a headless Sail server (W5)

**Depends on.** W4.

**Files.**

- [ ] Create `Dockerfile` with a Node build stage on `node:26.13.1-bookworm`, a Rust stage for `sail-boatd` and `t3-resource-monitor`, and a `bookworm-slim` runtime stage.
  - [ ] Set `HOME=/data/home`, `SAIL_HOME=/data/sail`, `T3CODE_HOME=/data/sail`, `SAIL_STARTUP_PAIRING=off`, and a `PATH` that starts with `/data/home/.local/bin` as image `ENV`, so `fly ssh` and `docker exec` sessions see them.
  - [ ] Install a `t3` launcher at `/usr/local/bin/t3`, run as user `sail`, and use `tini` as PID 1.
  - [ ] Install git, bash, ssh, ripgrep, curl, and CA certificates, then Claude Code with its install script allowed, Codex, and OpenCode.
- [ ] Create `.dockerignore` from the prototype's `Dockerfile.dockerignore`.
- [ ] Create `deploy/docker/entrypoint.sh` that creates `/data/home` and `/data/sail`, derives `SAIL_PUBLIC_URL` from `FLY_APP_NAME` when unset, and runs `t3 serve --host 0.0.0.0 --port 8080`.
- [ ] Create `scripts/stage-server-runtime.ts` from `stageRuntimeExternals` in `scripts/build-cli-archive.ts:135-229`, and edit `scripts/build-cli-archive.ts` to call it.
- [ ] Create `scripts/smoke-docker-image.ts` that runs the image, waits for `GET /`, mints a link with `t3 auth pairing create --json --require-running`, and redeems it.
- [ ] Edit `.github/workflows/ci.yml` to build and smoke the image on PRs that touch `Dockerfile`, `deploy/docker/**`, or `scripts/stage-server-runtime*`, and on every push to `main`, with BuildKit cache.

**Build.**

- [ ] Ship only the built server, one copy of the web client, and the staged runtime externals, not the monorepo's `node_modules`.

**You see.**

- [ ] `docker run -p 8080:8080 -v sail:/data sail-server` logs a ready line with no token, and `docker exec -u sail <id> t3 auth pairing create --json --require-running` prints a link that pairs.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/stage-server-runtime.test.ts` checks that the staged tree resolves every package in `scripts/lib/cli-external-packages.ts`. Run `vp test run scripts/stage-server-runtime.test.ts scripts/build-cli-archive.test.ts`.
- [ ] Run `node scripts/smoke-docker-image.ts --image sail-server:<short-sha>` and keep its output.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no image, so record that, then build head and pair a browser. Save `w5-paired.png`. Pass when the browser lands signed in.
- [ ] Lane 2. Open the terminal and run `id && uname -m`. Save `w5-terminal.png`. Pass when the shell runs as `sail`.
- [ ] Lane 3. Open Settings > Providers. Save `w5-providers.png`. Pass when Claude, Codex, and OpenCode show as installed.
- [ ] Lane 4. Run `claude --version && claude doctor` in the terminal. Save `w5-claude-ok.png`. Pass when neither reports a missing install step.
- [ ] Lane 5. Restart the container on the same volume. Save `w5-persist.png`. Pass when the browser session, a created project, and `~/.codex` survive.
- [ ] Lane 6. Open `/boats` in the container's web UI. Save `w5-boats.png`. Pass when setup asks for the Boat CLI or Boat sign-in, not for installing T3.
- [ ] Lane 7. Run `docker exec -u sail <id> t3 auth pairing create --json --require-running` with no extra env. Save `w5-exec-pair.txt`. Pass when the link pairs a fresh browser.
- [ ] Lane 8. Register the replay fixture and run a `showcase` turn. Save `w5-replay-turn.png`. Pass when the turn completes with its tool calls and approval.
- [ ] Lane 9. Send `docker stop` during the lane 8 thread's next turn, then start again. Save `w5-sigterm.png`. Pass when the server exits within 30 seconds and the thread recovers.
- [ ] Lane 10. Build on `linux/amd64` with `docker buildx` and run the smoke script. Save `w5-amd64.txt`. Pass when the smoke script passes.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Compressed image bytes, idle container memory after pairing, and seconds from `docker run` to a 200 on `GET /`. Trunk has no image, so each has an absolute budget. The prototype measured 1.85 GB compressed, 741 MiB idle, and about 3 seconds.
- [ ] Probe. Measure compressed size with `docker save <image> | gzip -c | wc -c`, idle memory with `docker stats --no-stream` 60 seconds after pairing, and five cold starts on fresh volumes. Record peak memory during lane 8.
- [ ] Baseline. Record the prototype values from Appendix A first.
- [ ] Rule. Fail when the compressed image exceeds 1.3 GB, idle memory exceeds 800 MiB, or the cold start median exceeds 10 seconds.

**Review gate.** None. W5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W5 on W4, and the operator lands it bottom-up.

## Publish the server image, CLI archives, and install.sh with each release (W6)

**Depends on.** W5.

**Files.**

- [ ] Edit `.github/workflows/release.yml`.
  - [ ] Add `packages: write` to the permissions.
  - [ ] Add a `server-image` job that pushes `ghcr.io/<owner>/sail-server:<version>` and `:<sha>` for amd64 and arm64, makes the package public, and moves `:latest` only for a non-prerelease version.
  - [ ] Add a `cli-archive` matrix that builds inside the oldest Debian image whose glibc both Node 26 and the Boat sandbox accept. It runs `cargo build --release` for `t3-resource-monitor` and `sail-boatd`, then `build-exe`, then `scripts/build-cli-archive.ts`.
  - [ ] Edit `publish` to upload `t3-<version>-linux-<arch>.tar.gz` and `install.sh` and list them in `SHA256SUMS`.
  - [ ] Add a lane mode. A version containing `-lane.` creates a draft prerelease, pushes the image to `sail-server-lane`, never moves `:latest`, and fails when the tag already exists.
- [ ] Edit `scripts/build-cli-archive.ts` to include `sail-boatd` next to `resource-monitor/`.
- [ ] Edit `scripts/install.sh` to write a product marker that W10 checks.
- [ ] Edit `scripts/install.test.ts` and `scripts/build-cli-archive.test.ts`.

**Build.**

- [ ] Publish every artifact a server host needs from one tagged release, and give lanes a mode that cannot touch a real release.

**You see.**

- [ ] The release page lists two `t3-<version>-linux-*.tar.gz` files and `install.sh`, and `docker pull ghcr.io/<owner>/sail-server:<version>` works without a login.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `build-cli-archive.test.ts` gains a case that the archive lists `sail-boatd`, and `install.test.ts` a case for the product marker. Run `vp test run scripts/build-cli-archive.test.ts scripts/install.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk's release cannot run safely, so read the latest real release's asset list with `gh release view`, then run lane mode at head. Save `w6-assets.png`. Pass when head's prerelease has every trunk asset kind plus the archives, `install.sh`, and the image.
- [ ] Lane 2. Run lane mode again with the same version. Save `w6-tag-guard.txt`. Pass when the workflow fails before uploading.
- [ ] Lane 3. Read the `:latest` digest before and after lane mode. Save `w6-latest-unchanged.txt`. Pass when the digest is unchanged and the release is a draft prerelease.
- [ ] Lane 4. Run `sha256sum -c SHA256SUMS` on the downloaded assets. Save `w6-sums.txt`. Pass when every line is OK.
- [ ] Lane 5. In a `debian:bookworm` container, run the prerelease's `install.sh` with `T3CODE_VERSION=<version>`. Save `w6-install-debian.txt`. Pass when `t3 --version` prints the Sail version and the product marker exists.
- [ ] Lane 6. Repeat lane 5 on `ubuntu:22.04` arm64. Save `w6-install-ubuntu-arm.txt`. Pass when the same checks hold.
- [ ] Lane 7. Run the installed `t3 serve --host 127.0.0.1 --port 3773` and curl `/`. Save `w6-archive-serves.txt`. Pass when it returns the app shell.
- [ ] Lane 8. Run `scripts/smoke-cli-archive.ts` on each archive. Save `w6-smoke.txt`. Pass when both pass.
- [ ] Lane 9. Log in with `gh auth token | docker login ghcr.io --password-stdin`, pull the private lane image on amd64 and arm64, and run `scripts/smoke-docker-image.ts`. Save `w6-image-smoke.txt`. Pass when both pair.
- [ ] Lane 10. Delete the W6 lane prerelease and lane image tags after every W6 lane finishes. Save `w6-cleanup.txt`. Pass when neither remains and the real latest release is unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Release workflow wall time and the size of each new asset.
- [ ] Probe. Read `gh run view --json` for the latest real release run and for the lane run.
- [ ] Baseline. Record the latest real release wall time first.
- [ ] Rule. Fail when the lane run exceeds the real run by more than 15 minutes, or an archive exceeds 300 MB.

**Review gate.** None. W6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W6 on W5, and the operator lands it bottom-up.

## Deploy a personal Sail server to Fly with one command (W7)

**Depends on.** W6.

**Files.**

- [ ] Create `deploy/fly/fly.toml` with `internal_port = 8080`, `force_https = true`, `auto_stop_machines = "off"`, `min_machines_running = 1`, a 10 GB `[[mounts]]` at `/data`, `shared-cpu-2x` with 4 GB, a `GET /` check, and an `[env]` block that repeats the image's home variables.
- [ ] Create `deploy/fly/deploy.sh`, needing only `flyctl` and `curl`.
  - [ ] Resolve the newest release tag and deploy `ghcr.io/<owner>/sail-server:<tag>`, unless `--image` or `--build` is given.
  - [ ] Create the app and the volume when missing, then deploy with `--ha=false`.
  - [ ] Check that `/.well-known/t3/environment` on the public URL reports the same `environmentId` as `/data/sail/userdata/environment-id` over `fly ssh`.
  - [ ] Mint two links with `fly ssh console -u sail -C "t3 auth pairing create --json --require-running"`. Open the first as `sail://pair?pairingUrl=<link>` on this computer, and print the second with a QR code for a browser or phone.
  - [ ] Support `--app`, `--region`, `--image`, `--build`, `--pair`, `--snapshot`, and `--dry-run`.
- [ ] Create `scripts/deploy-fly.test.ts` that runs the script against a fake `fly` on `PATH`.
- [ ] Create `docs/user/self-host-fly.md`. Cover deploy, provider sign-in from the in-app terminal, adding devices, snapshots and the restore runbook, upgrade, cost, and `fly apps destroy`.
- [ ] Create `.agents/skills/deploy-sail/SKILL.md` that runs `deploy/fly/deploy.sh`, stops for `fly auth login`, and hands back both links.
- [ ] Edit `README.md` and `docs/user/install.md` to link the new page.

**Build.**

- [ ] Make deploy, upgrade, and re-pair the same idempotent command, and never hand two clients the same one-time token.

**You see.**

- [ ] `deploy/fly/deploy.sh --app my-sail` ends with the desktop app asking "Add the backend at my-sail.fly.dev?" and a printed `https://my-sail.fly.dev/pair#token=` link with its QR code.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/deploy-fly.test.ts` checks that a first run creates the app and volume, a second run creates nothing, `--dry-run` calls no mutating command, two distinct tokens are minted, and a mismatched `environmentId` fails the run. Run `vp test run scripts/deploy-fly.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no deploy kit, so record that, then deploy head's image to a fresh fake Fly app. Save `w7-first-deploy.png`. Pass when the printed https link pairs a browser.
- [ ] Lane 2. Run the script again on the same app. Save `w7-rerun.txt`. Pass when it creates no new app or volume and prints new links.
- [ ] Lane 3. Let the script open its `sail://` link in the packaged desktop app while the browser from lane 1 stays open. Save `w7-desktop-added.png`. Pass when both clients stay signed in and desktop opens a thread on the fake Fly server.
- [ ] Lane 4. Open the printed link in a 390 px wide preview. Save `w7-phone.png`. Pass when the phone-width UI lands signed in.
- [ ] Lane 5. Run `claude auth login` in the web terminal up to the code prompt. Save `w7-claude-login.png`. Pass when the URL and the paste prompt appear.
- [ ] Lane 6. Run `codex login --device-auth` in the web terminal. Save `w7-codex-login.png`. Pass when a device code appears.
- [ ] Lane 7. Register the replay fixture, start a `showcase` turn, close the tab for 3 minutes, and reopen. Save `w7-turn-survives.png`. Pass when the turn finished on the server.
- [ ] Lane 8. Run the fake `fly deploy` mid-session. Save `w7-redeploy-reconnect.png`. Pass when the open tab reconnects without a re-pair.
- [ ] Lane 9. Run `deploy.sh --snapshot`, restore it to a new volume per the runbook, and attach a new machine. Save `w7-restore.png`. Pass when the environment ID, a thread with an attachment, and settings match.
- [ ] Lane 10. Run the fake `fly apps destroy` as the docs say. Save `w7-destroy.txt`. Pass when the container and its volumes are gone.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Seconds from script start to the printed link on a fresh fake app with a prebuilt image, seconds for a re-run, idle memory, and peak memory during two concurrent replay turns. Trunk has no deploy kit, so each has an absolute budget. Real Fly numbers wait for Appendix E.
- [ ] Probe. Time three fresh deploys and three re-runs, alternating. Read memory with the fake `fly ssh console -C "cat /sys/fs/cgroup/memory.peak"` after two concurrent `showcase` turns.
- [ ] Baseline. Record the W5 container idle memory and lane 8 peak first.
- [ ] Rule. Fail when a fresh deploy exceeds 120 seconds, a re-run exceeds 60 seconds, idle memory exceeds 900 MiB, or the two-turn peak exceeds 1.5 GiB.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 3, and 4 screenshots into `~/.local/state/t3-pstack/media/sail-web-deploy/w7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a fresh deploy through desktop connect on a lane VM. Save it as `~/.local/state/t3-pstack/media/sail-web-deploy/w7-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W7 on W6, and the operator lands it bottom-up.

## Connect Sail desktop in one click and make the server its main one (W8)

**Depends on.** W7.

**Files.**

- [ ] Create `apps/web/src/components/settings/OpenInDesktopButton.tsx` that renders **Open in Sail desktop** from `buildPairingAppLink` in `packages/shared/src/remote.ts`, hidden inside the desktop app.
- [ ] Edit `apps/web/src/components/settings/AuthorizedClientsSettings.tsx` to place the button next to the QR code.
- [ ] Edit `apps/web/src/components/settings/ConnectionsSettings.logic.ts` with a helper that picks the share base URL for any environment, using a saved remote environment's `httpBaseUrl`, and use it from `ConnectionsSettings.tsx`.
- [ ] Edit `apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx` so the "Backend added" step offers **Use <host> as your main server**, which turns off **Local environment** through the existing `setLocalEnvironmentEnabled`.
- [ ] Add a **Connect Sail desktop to this server** command palette action.
- [ ] Edit `apps/web/src/i18n/translations/*.json` and `docs/user/remote-access.md`.

**Build.**

- [ ] Build every share link from the environment being shared, and let a desktop that joins a server switch to it as its only environment in one confirmed step.

**You see.**

- [ ] In a browser on the Fly server, **Settings > Sharing & access > Create link** shows a QR code and **Open in Sail desktop**. Desktop then offers to make the server its main one.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `ConnectionsSettings.logic.test.ts` gains cases for primary, saved remote, and relay environments. Run `vp test run apps/web/src/components/settings/ConnectionsSettings.logic.test.ts`.
- [ ] A browser test renders `OpenInDesktopButton` with the encoded `sail://pair` href and hides it when `desktopBridge` exists. Run `vp test run apps/web/src/components/settings/OpenInDesktopButton.browser.test.tsx`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. In the packaged desktop app, open Sharing & access for a remote container environment at trunk and head. Save `w8-remote-link.png`. Pass when trunk shows a bare token and head shows a link on the container's origin.
- [ ] Lane 2. In a browser on a container server, create a link. Save `w8-web-button.png`. Pass when the QR code and the button both render.
- [ ] Lane 3. Click the button with the packaged desktop app running. Save `w8-desktop-confirm.png`. Pass when desktop asks to add the backend at the server origin.
- [ ] Lane 4. Accept and choose **Use as your main server**. Save `w8-main-server.png`. Pass when desktop restarts with no local server and its sidebar shows the server's threads.
- [ ] Lane 5. Switch **Local environment** back on. Save `w8-local-back.png`. Pass when the local server returns with its earlier threads.
- [ ] Lane 6. Open the page inside desktop for its own local server. Save `w8-no-button-in-desktop.png`. Pass when the button is hidden.
- [ ] Lane 7. Run the command palette action in the browser. Save `w8-palette.png`. Pass when it creates a link and opens the `sail://` URL.
- [ ] Lane 8. Switch the UI language to Japanese. Save `w8-ja.png`. Pass when the new copy is translated and fits.
- [ ] Lane 9. Revoke the desktop client from the browser. Save `w8-revoke.png`. Pass when desktop shows the environment as needing pairing.
- [ ] Lane 10. Click the button on a lane VM with no desktop app. Save `w8-no-desktop.png`. Pass when the page stays usable and the copyable link remains.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening Sharing & access to the QR code being painted.
- [ ] Probe. Open the page ten times per side, interleaved, and read a `performance.mark` pair with `preview_evaluate`.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 10 percent.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 4 screenshots into `~/.local/state/t3-pstack/media/sail-web-deploy/w8-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of browser-to-desktop connect and the main-server switch on a lane VM. Save it as `~/.local/state/t3-pstack/media/sail-web-deploy/w8-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W8 on W7, and the operator lands it bottom-up.

## Keep preferences the same on every device through the main server (W9)

**Depends on.** W8.

**Files.**

- [ ] Edit `packages/contracts/src/settings.ts` to mark the `ClientSettingsSchema` fields that stay per device, such as `confirmQuit` and `browserDefaultViewport`, and to add a server-side `clientPreferences` record for the rest.
- [ ] Edit `apps/server/src/serverSettings.ts` to store, validate, and stream `clientPreferences`.
- [ ] Create `packages/client-runtime/src/state/clientPreferences.ts` that reads the main server's copy, caches it locally, writes edits back, and applies live updates.
- [ ] Edit `apps/web/src/clientPersistenceStorage.ts` and `apps/desktop/src/settings/DesktopClientSettings.ts` to keep only per-device fields locally when sync is on.
- [ ] Add **Use the same preferences on every device** under **Settings > General**, on by default once a main server exists.
- [ ] Edit `apps/web/src/i18n/translations/*.json` and `docs/internals/01_architecture.md`, whose settings-ownership section this changes.

**Build.**

- [ ] Store shared preferences once on the main server, so desktop and browser read and write the same record and see each other's edits live.

**You see.**

- [ ] Changing the code font size in the browser changes it in the desktop app within a second, and the reverse.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `clientPreferences.test.ts` covers merge order, per-device fields staying local, and offline edits converging on reconnect. Run `vp test run packages/client-runtime/src/state/clientPreferences.test.ts`.
- [ ] A server test checks that a read-only session cannot write preferences. Run `vp test run apps/server/src/serverSettings.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Change the code font size in a browser at trunk and head with the packaged desktop app on the same server. Save `w9-browser-to-desktop.png`. Pass when trunk's desktop is unchanged and head's desktop updates.
- [ ] Lane 2. Change diff layout in desktop. Save `w9-desktop-to-browser.png`. Pass when the browser updates without a reload.
- [ ] Lane 3. Edit a preference in a browser while offline, then reconnect. Save `w9-offline.png`. Pass when both clients converge on the last write.
- [ ] Lane 4. Turn sync off on the browser and change a preference. Save `w9-sync-off.png`. Pass when desktop keeps its value.
- [ ] Lane 5. Change `browserDefaultViewport` in desktop. Save `w9-per-device.png`. Pass when the browser keeps its own value.
- [ ] Lane 6. Pair a read-only browser and change a preference. Save `w9-readonly.png`. Pass when the change stays local and the server rejects the write.
- [ ] Lane 7. Pair a fresh browser. Save `w9-new-device.png`. Pass when it opens with the shared preferences already applied.
- [ ] Lane 8. Switch the UI language to German. Save `w9-de.png`. Pass when the new toggle is translated and fits.
- [ ] Lane 9. Remove the main server from desktop. Save `w9-server-removed.png`. Pass when desktop keeps the last preferences locally.
- [ ] Lane 10. Edit the same preference from two browsers within one second. Save `w9-race.png`. Pass when all three clients settle on one value with no error.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from a preference edit in one client to the change rendering in another, plus app start time to first paint.
- [ ] Probe. Edit 20 times and read `performance.now()` marks on both clients with `preview_evaluate`. Start the web app five times per side, interleaved.
- [ ] Baseline. Record the trunk start-time median first.
- [ ] Rule. Fail when the edit round trip p95 exceeds 500 ms, or the head start-time median exceeds trunk by more than 5 percent.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 7 screenshots into `~/.local/state/t3-pstack/media/sail-web-deploy/w9-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of edits moving between desktop and browser on a lane VM. Save it as `~/.local/state/t3-pstack/media/sail-web-deploy/w9-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W9 on W8, and the operator lands it bottom-up.

## Make Boat machines install Sail's server (W10)

**Depends on.** W9.

**Files.**

- [ ] Edit `native/sail-boat/src/machine/provision.rs` so `DEFAULT_CLI_INSTALL_URL` is Sail's release `install.sh` from W6.
- [ ] Edit `native/sail-boat/src/machine/provision.sh` to keep machine state in `~/.t3`, pass that home on every `t3` call and on `service install`, use the Sail install URL, and reinstall when the W6 product marker is missing.
- [ ] Edit `native/sail-boat/src/machine/connect.rs` to pass the same home to `t3 up`.
- [ ] Add Rust tests next to `provision.rs` for the URL and the marker check.

**Build.**

- [ ] Swap the installer and pin the home that machines already use, so no state moves and the service installer never sees a second home.

**You see.**

- [ ] A new Boat machine reports the Sail server version in `/boats`, and an upgraded machine keeps its threads.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Rust tests cover the default URL and that an upstream `t3 v<version>` without the marker counts as not installed. Run `cargo test --manifest-path native/sail-boat/Cargo.toml provision`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. With the fake `boat`, create a machine at trunk and at head, with head installing from the release mirror. Save `w10-version.png`. Pass when trunk reports upstream T3 or fails and head reports the lane version.
- [ ] Lane 2. Create fake sandboxes on `debian:bullseye` and `ubuntu:22.04`, record `ldd --version` with `boat exec`, then run `t3 --version`. Save `w10-glibc.txt`. Pass when the archive's binaries run on both.
- [ ] Lane 3. Seed a thread and a peer link on a machine provisioned at trunk, then wake it at head. Save `w10-upgrade.png`. Pass when it reports Sail and the thread and link remain.
- [ ] Lane 4. Let the machine sleep, then open it. Save `w10-wake.png`. Pass when the watchdog wakes it and threads load.
- [ ] Lane 5. Register the replay fixture on the machine and run a `showcase` turn. Save `w10-thread.png`. Pass when the turn completes.
- [ ] Lane 6. Check the peer link on the home server with `t3 environment list`. Save `w10-peer-link.txt`. Pass when the machine is linked with full access.
- [ ] Lane 7. Set `SAIL_CLI_INSTALL_URL` to a mirror. Save `w10-override.txt`. Pass when provisioning uses the mirror.
- [ ] Lane 8. Break the install URL. Save `w10-install-fail.png`. Pass when `/boats` shows the install log tail, not a hang.
- [ ] Lane 9. Compare the machine's `t3 --version` with the home server's. Save `w10-cli-version.txt`. Pass when they match.
- [ ] Lane 10. Delete every lane machine. Save `w10-cleanup.txt`. Pass when the fake `boat --json list` shows none and no sandbox container remains.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Seconds from `create_machine` to the machine reporting ready.
- [ ] Probe. Create two machines per side, interleaved, with the fake `boat`, and read the daemon's event timestamps.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 20 percent.

**Review gate.** None. W10 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W10 on W9, and the operator lands it bottom-up.

## Sign in to Boat and to agents from a remote browser (W11)

**Depends on.** W10.

**Files.**

- [ ] Edit `native/sail-boat/src/daemon.rs` and `native/sail-boat/src/boat.rs` so Boat sign-in returns its URL and code to the invoking call, and add `sign_out_boat`.
- [ ] Edit `native/sail-boat/src/machine/signin.rs` to model a sign-in attempt with an id, a submit-code step, cancel, and expiry. Use the Claude code-paste flow and `codex login --device-auth` when the invoking client is not on the daemon's host.
- [ ] Edit `native/sail-boat/src/machine/connect.rs` so **Turn on Connect** returns its URL the same way, or is hidden when T3 Connect is unavailable.
- [ ] Edit `packages/contracts/src/boat.ts` for the new commands and results.
- [ ] Edit `apps/server/src/boat/BoatSupervisor.ts` to pass, per invoke, whether the client is on the server's host.
- [ ] Edit `apps/web/src/components/boats/components/SetupView.tsx` and `MachineDetails.tsx` to show the link, the code, and a paste box, and `apps/web/src/i18n/translations/*.json`.

**Build.**

- [ ] Choose the sign-in flow per click, and replace localhost-callback sign-in with link-and-code flows whenever the browser is not on the daemon's machine.

**You see.**

- [ ] From the Fly web UI, **Sign in to Boat** shows a link and a code, and **Sign in to Claude** on a machine shows a link and a paste box that completes sign-in.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Rust tests cover the attempt lifecycle, cancel killing the child, and expiry. Run `cargo test --manifest-path native/sail-boat/Cargo.toml signin`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Sign in to Boat from the packaged desktop app on its local server at trunk and head. Save `w11-local-signin.png`. Pass when both complete the same way.
- [ ] Lane 2. Start Boat sign-in from the fake Fly web UI while a second tab shows `/boats`. Save `w11-remote-boat.png`. Pass when only the first tab shows the link and code.
- [ ] Lane 3. Finish Boat sign-in by entering the fake `boat` code. Save `w11-boat-done.png`. Pass when `/boats` shows signed in.
- [ ] Lane 4. Sign in to Claude on a fake sandbox from the fake Fly web UI by pasting the fake `claude` CLI's code. Save `w11-claude-remote.png`. Pass when the daemon reports Claude signed in on that machine.
- [ ] Lane 5. Sign in to Codex on a fake sandbox with the fake `codex` CLI's device code. Save `w11-codex-remote.png`. Pass when the daemon reports Codex signed in on that machine.
- [ ] Lane 6. Cancel a sign-in midway. Save `w11-cancel.png`. Pass when the UI returns to signed out and `boat exec ps` shows no login process.
- [ ] Lane 7. Let a code expire. Save `w11-expired.png`. Pass when the UI offers a new code.
- [ ] Lane 8. Sign in from the desktop app connected to the fake Fly server. Save `w11-desktop-remote.png`. Pass when it uses the link-and-code flow.
- [ ] Lane 9. Use a 390 px wide preview for lane 4. Save `w11-narrow.png`. Pass when the link and box fit.
- [ ] Lane 10. Sign out of Boat from the web UI. Save `w11-signout.png`. Pass when the fake `boat account` reports signed out.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from clicking **Sign in** to the code rendering.
- [ ] Probe. Click five times per side, interleaved, for the local flow, and five times at head for the remote flow.
- [ ] Baseline. Record the trunk local median first.
- [ ] Rule. Fail when the head local median exceeds trunk by more than 20 percent, or the remote median exceeds 3000 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 4, and 5 screenshots into `~/.local/state/t3-pstack/media/sail-web-deploy/w11-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of remote Boat and Claude sign-in on a lane VM. Save it as `~/.local/state/t3-pstack/media/sail-web-deploy/w11-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W11 on W10, and the operator lands it bottom-up.

## Reach Boat machines from remote clients at their own HTTPS address (W12)

**Depends on.** W11.

**Files.**

- [ ] Edit `native/sail-boat/src/app.rs` so `pair_machine` for a client that is not on the daemon's host wakes the machine, mints a client pairing on the machine through the home server's peer link (`apps/server/src/peer/PeerClientPairing.ts`), and returns `<upstream_url>/pair#token=` to that client only.
- [ ] Edit `apps/server/src/boat/BoatSupervisor.ts` to pass the per-invoke host flag W11 added.
- [ ] Edit `apps/web/src/components/boats/components/MachineRow.tsx` and `MachineDetails.tsx` to show **Add to Sail** and **Open** again for remote clients, and to link an offline machine to **Wake** in `/boats`.
- [ ] Edit `docs/user/self-host-fly.md` to describe Boats on a Fly server.

**Build.**

- [ ] Send remote clients straight to each machine's existing public HTTPS address with a pairing the machine itself issues, so sessions are revocable on that machine and no new ports or tokens exist.

**You see.**

- [ ] In the Fly web UI, **Add to Sail** on a machine adds it as an environment at its Boat HTTPS address, and the desktop app connected to Fly can do the same.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Rust tests cover `pair_machine` choosing the local or remote link and waking first. Run `cargo test --manifest-path native/sail-boat/Cargo.toml pair`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Add a machine from the packaged desktop app on its local server at trunk and head. Save `w12-local-add.png`. Pass when both add it at `http://localhost:<port>`.
- [ ] Lane 2. Add a machine from the fake Fly web UI at head. Save `w12-web-add.png`. Pass when it appears as an environment at its Boat HTTPS address.
- [ ] Lane 3. Add the same machine from the desktop app connected to the fake Fly server. Save `w12-desktop-add.png`. Pass when desktop adds it too.
- [ ] Lane 4. Let the machine sleep, then press **Wake** from its offline row. Save `w12-wake.png`. Pass when the environment reconnects and a thread loads.
- [ ] Lane 5. Revoke the browser in the machine's own Sharing & access. Save `w12-revoke.png`. Pass when that browser loses the machine and desktop keeps it.
- [ ] Lane 6. Curl the machine's address with no session. Save `w12-auth.txt`. Pass when it returns 401.
- [ ] Lane 7. Add a machine from tab A while tab B shows `/boats`. Save `w12-pair-isolated.png`. Pass when tab B never receives the pairing link.
- [ ] Lane 8. Delete the machine from the web. Save `w12-delete.png`. Pass when the environment shows unreachable and **Remove** clears it.
- [ ] Lane 9. Run the fake `fly deploy` mid-session. Save `w12-redeploy.png`. Pass when machine environments stay connected.
- [ ] Lane 10. Remove every lane machine. Save `w12-cleanup.txt`. Pass when the fake `boat --json list` shows none and no sandbox container remains.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Seconds from opening a sleeping machine to its first thread rendering.
- [ ] Probe. Measure five wakes per side, interleaved, through the local proxy at trunk and through **Wake** on the fake Fly web UI at head.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 2 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 4 screenshots into `~/.local/state/t3-pstack/media/sail-web-deploy/w12-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of adding and waking a machine from the Fly web UI on a lane VM. Save it as `~/.local/state/t3-pstack/media/sail-web-deploy/w12-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W12 on W11, and the operator lands it bottom-up.

## Copy setup between environments in either direction (W13)

**Depends on.** W12.

**Files.**

- [ ] Create `packages/contracts/src/environmentSetup.ts` with an export bundle of portable server settings, provider instances without host paths or local secret values, keybindings, themes, and user-level skill folders.
- [ ] Create `apps/server/src/environmentSetup/EnvironmentSetupTransfer.ts` with `export` and `import` service methods. Import rejects `..`, absolute paths, and symlinks, caps files at 500 and bytes at 5 MB, and writes only inside each skills root.
- [ ] Edit `packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts`, and `apps/server/src/auth/RpcAuthorization.ts` for both methods.
- [ ] Add an MCP tool for both methods under `apps/server/src/mcp/toolkits/`.
- [ ] Create `apps/web/src/components/settings/CopySetupDialog.tsx` under **Settings > Environments**, with a source, a target, and a preview of what will change.
- [ ] Edit `apps/web/src/i18n/translations/*.json` and `docs/user/project-settings.md`.

**Build.**

- [ ] Let the client read a bundle from one environment and write it to another, so no server talks to another server and nothing syncs in the background.

**You see.**

- [ ] **Copy setup** from the laptop's local environment to the Fly environment previews the providers, skills, and settings it will copy, and the Fly environment then shows them.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `EnvironmentSetupTransfer.test.ts` checks that exports drop `binaryPath`, `homePath`, `worktreesDirectory`, and secret values, that import is idempotent, and that traversal, absolute paths, symlinks, and oversize bundles are rejected. Run `vp test run apps/server/src/environmentSetup`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claudeAgent_2/claude-opus-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no copy, so record that, then copy local to a container at head. Save `w13-copy-up.png`. Pass when the container lists the same providers and skills.
- [ ] Lane 2. Copy the container to local. Save `w13-copy-down.png`. Pass when local gains the container-only skill.
- [ ] Lane 3. Run the same copy twice. Save `w13-idempotent.png`. Pass when the second preview shows no changes.
- [ ] Lane 4. Copy a provider whose API key is a local secret. Save `w13-secret.png`. Pass when the target shows the instance with the key marked missing.
- [ ] Lane 5. Copy with a custom `binaryPath` on the source. Save `w13-paths.png`. Pass when the target keeps its own path.
- [ ] Lane 6. Send a hand-built bundle with a `../` skill path through the RPC. Save `w13-traversal.txt`. Pass when the server rejects it and writes nothing.
- [ ] Lane 7. Pair a read-only client and try to import. Save `w13-readonly.png`. Pass when the server refuses.
- [ ] Lane 8. Call the MCP tool from an agent thread. Save `w13-mcp.png`. Pass when it reports the same preview.
- [ ] Lane 9. Cancel at the preview step. Save `w13-cancel.png`. Pass when nothing changes on the target.
- [ ] Lane 10. Copy 50 skills totalling about 4 MB through a fake Fly lane app. Save `w13-many.png`. Pass when the copy finishes and all 50 appear.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Export bundle bytes and import milliseconds for a home with 50 skills, plus Settings > Environments load time. Trunk has no copy, so the bundle and import have absolute budgets.
- [ ] Probe. Run export and import five times at head with a seeded home, and load the settings page five times per side, interleaved.
- [ ] Baseline. Record the trunk settings-page median first.
- [ ] Rule. Fail when the bundle exceeds 5 MB, import p95 exceeds 3000 ms, or the settings page median regresses by more than 10 percent.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 4 screenshots into `~/.local/state/t3-pstack/media/sail-web-deploy/w13-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of copying setup both ways on a lane VM. Save it as `~/.local/state/t3-pstack/media/sail-web-deploy/w13-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W13 on W12, and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

One throwaway prototype ran against base `4cd93fb5` on 2026-11-25, in a local scratch directory outside the repo, with image `sail-proto:local`. The planner keeps its screenshots and Dockerfile in `~/.local/state/t3-pstack/media/sail-web-deploy/`.

Proved by running it.

- The server and web build in a `node:26.13.1-bookworm` multi-stage image on linux/arm64. A cold build took 341 seconds. See `proto-Dockerfile`.
- `GET /` returns the app shell, and `/.well-known/t3/environment` reports `linux` and `arm64`, about 3 seconds after start.
- A browser pairs with a link from `t3 auth pairing create --base-url`. See `proto-paired-welcome.png`.
- node-pty loads from a prebuild, and the terminal opens a bash shell. See `proto-terminal-linux-arm64.png`.
- Claude Code and Codex installed with `npm i -g` show as installed but not signed in. See `proto-providers-detected.png`.
- With `Host: demo.fly.dev` and `X-Forwarded-Proto: https`, the session cookie carries `Secure`.
- Idle memory after pairing was 741 MiB, and the image was 7 GB on disk and 1.85 GB compressed, with the whole monorepo `node_modules` inside.

Proved by reading code and confirmed by the plan review.

- Desktop Sharing & access for a remote environment shows a bare token (`ConnectionsSettings.tsx:1181-1183`, `AuthorizedClientsSettings.tsx:205-216`). W8 fixes it.
- `sail-boatd` finds the server only through `SAIL_DESKTOP_CLI` or `<SAIL_HOME>/bin` and never `PATH` (`native/sail-boat/src/t3desktop.rs:103-121`). W4 sets the variable.
- `t3 pair` reads only `T3CODE_HOME` (`apps/server/src/cli/pair.ts:290`). W2 fixes it.
- `threadLinks.ts:10` builds the hosted prefix from `DEFAULT_HOSTED_APP_URL` at load time, and `providerAuthReturnUrl.ts:9-11` trusts only loopback and `app.t3.codes`. W1 fixes both.
- Bundled servers do not seed `Replay (dev)` (`ProviderInstanceRegistryHydration.ts:89-95`), so container, Fly, and Boat lanes use a real cheap model.

Still unproven.

- The first pairing attempt in a reused browser profile spent its token and stayed signed out, while a fresh profile worked. W2 owns the reproduction and the fix.
- Nothing ran on Fly. WebSockets through Fly Proxy, `fly ssh` sessions, remote image pulls, and real memory under agent load are unmeasured. Appendix E measures them once an org exists.
- Whether a Boat machine's public HTTPS address wakes a sleeping sandbox on request is unknown. W12 assumes it does not and adds **Wake**, and Appendix E checks it.
- Boat CLI login in a container, the Boat sandbox glibc, and Cursor and Grok headless login are untested. Appendix E covers them.

## Appendix B. Alternatives rejected

- **Two servers that replicate each other.** The event store uses local autoincrement sequences, one orchestrator decides every command, outbox effects run where they commit, checkpoints are git refs on one disk, and provider sessions are local processes (`docs/internals/01_architecture.md`). Two writers would double-run turns and fork history. One server with many clients, plus W8's main-server switch and W9's shared preferences, gives the same result without that risk.
- **Publishing each Boat machine proxy on its own Fly port.** All four reviewers rejected it. A Fly `[[services]]` block has one `internal_port`, so a port range cannot reach separate listeners. Ports other than 80 and 443 need a dedicated IPv4. Cookies are not port-scoped, and the proxy's client tokens last ten years with no revocation (`native/sail-boat/src/proxy/mod.rs:35, 130`). W12 uses each machine's existing Boat HTTPS address and the machine's own sessions instead.
- **Moving Boat machine state from `~/.t3` to `~/.sail`.** `t3 service install` refuses a second home with `BootServiceOtherBaseDirError` (`apps/server/src/cloud/bootService.ts:1269`), and a scripts-only upgrade would point the watchdog at an empty home. W10 keeps `~/.t3`.
- **A static web app on Fly that tunnels back to the desktop.** It needs the laptop awake, and Sail has no relay. A self-hosted T3 Connect relay needs Cloudflare zones, Postgres, and a Clerk instance with a device grant (`infra/relay/README.md`).
- **A webcam QR scanner in the desktop app.** Clicking a `sail://pair` link on the same computer is faster than holding a code to a camera. QR codes stay for phones.
- **Copying provider credentials from desktop to the server.** Claude's terms forbid third parties from collecting or intermediating Claude.ai credentials. Each CLI's own login in the in-app terminal keeps the owner signed in to the unmodified CLI.
- **A `--private` Tailscale mode in W7.** It needs `tailscaled` in the image and its state on the volume. It is a follow-up that owns both the image and the Fly config.
- **Railway, Render, and Codespaces as the default.** Railway caps Hobby volumes at 5 GB and charges about $10 per GB of RAM, Render gives disks only to paid instances, and Codespaces stops after at most 4 idle hours.
- **Fly auto-stop.** Fly decides on inbound traffic only and can stop a machine mid-turn when the last tab closes, so `fly.toml` turns it off.

## Appendix C. Risks

- **Data loss on one volume.** A Fly volume is one NVMe disk with daily snapshots kept 5 days. W7 documents snapshots and a restore runbook, and lane 9 restores to a fresh volume.
- **A public server.** Anyone can reach the pairing page. Tokens last 5 minutes and sessions 30 days, managed deploys print no startup token (W2), and the owner watches the authorized clients list.
- **Claude subscription terms.** The owner signs in to the unmodified CLI on their own server. W7 docs must not suggest pasting `setup-token` output as a Fly secret until a maintainer reads the terms.
- **Boats spending money.** The daemon reaper deletes sandboxes that still bill (`native/sail-boat/src/app.rs:235`). W4 starts the daemon at boot when machines or pending deletions exist. Two daemons on one home would collide, so W4's owner checks the desktop WSL backend pool.
- **Lanes that publish.** W6's lane mode refuses existing tags, never moves `:latest`, and uses a separate private image package. A lane that bypasses it could replace a real release's assets with `--clobber`.
- **Stand-ins that drift.** The fake `fly` and `boat` can pass where the real services fail. W3 pins each fake to the subcommands, flags, and JSON fields the code calls, and Appendix E runs the same flows on the real services before anyone relies on them.
- **Cost.** A `shared-cpu-2x` machine with 4 GB plus a 10 GB volume is roughly $25 a month by estimate. W7 records the real bill and lowers the default to 2 GB only if the two-turn peak stays under 1.6 GiB.
- **Image size.** The 1.3 GB compressed budget assumes staging only the runtime externals. If the floor is higher, W5's owner reports the measured floor and the operator moves the budget.
- **Desktop session renewal without T3 Connect.** If desktop falls back to a 30-day bearer for the Fly server, it re-pairs after 30 idle days. W8's owner checks whether DPoP renewal is available.
- **Differences that remain on the web.** SSH environments, local editor launch, desktop updates, and the Electron browser panel stay desktop-only. Guest links still need T3 Connect.
- **glibc ceiling.** W6 builds archives on an older Debian image, and W10 lane 2 checks the Boat sandbox.

## Appendix D. Links and reading list

- Read `AGENTS.md`, `docs/internals/01_architecture.md`, `04_environment-auth.md`, `05_remote.md`, `09_connection-runtime.md`, `10_web-ui.md`, `14_i18n.md`, and `15_testing.md` before editing.
- Read `docs/user/remote-access.md` before W2, W7, and W8.
- Read `native/sail-boat/src/t3desktop.rs`, `daemon.rs`, `app.rs`, and `machine/signin.rs` before W4, W10, W11, and W12.
- Every PR runs `<plugin root>/skills/interrogate/SKILL.md` before STACK-READY. W4, W9, and W12 also run `<plugin root>/skills/how/SKILL.md` first, because they cross the desktop, server, client-runtime, and daemon boundaries.
- Keep the decision trail per `<plugin root>/skills/show-me-your-work/SKILL.md` in `~/.local/state/t3-pstack/sail-web-deploy/`.
- One adversarial review round ran on this plan with Claude Opus 5.5, GPT 6.2 Sol, Grok 4.7, and Gemini 4 Neon. The planner keeps the brief in `~/.local/state/t3-pstack/docs/sail-plan-review-brief.md`.
- Fly sources are `https://docs.fly.io/reference/configuration`, `https://docs.fly.io/launch/autostop-autostart`, `https://docs.fly.io/volumes/overview`, and `https://docs.fly.io/about/pricing`.
- Provider login sources are `https://code.claude.com/docs/en/authentication`, `https://code.claude.com/docs/en/legal-and-compliance`, and `https://learn.chatgpt.com/docs/auth`.

## Appendix E. Real-account checks deferred until accounts exist

The operator chose on 2026-11-25 to build and verify with local stand-ins first. Run these once a Fly org, a boat.dev account, and a provider login exist, and file any failure as a fix PR.

- Deploy W7's kit to a real Fly app and repeat its lanes 1 to 10. Record deploy time, idle memory, the two-turn peak with real Claude and Codex turns, and the first month's bill, then set the default machine size.
- Confirm WebSockets survive a `fly deploy` through Fly Proxy, and that `fly ssh console` sees the image `ENV`.
- Restore a real Fly volume snapshot per the runbook.
- Publish one real release and pull `ghcr.io/<owner>/sail-server:<version>` anonymously.
- Repeat W10, W11, and W12 lanes on real Boat machines. Record the sandbox glibc, whether the public HTTPS address wakes a sleeping machine, and whether Boat CLI login works inside the container.
- Sign in to real Claude, Codex, Cursor, and Grok accounts from the web terminal of a real Fly server, and run one turn on each.

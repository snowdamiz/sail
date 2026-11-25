# Testing

Rules for writing tests, and for asking for them in review.

## What to test

- Test behavior that can break, such as orchestration and event-sourcing, provider protocol translation, auth and permission guards, persistence and migrations, external-format parsing, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, callback wiring, and props rendered to static markup.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test, at each call site, or in web and mobile copies of the same logic.
- Write a browser test only for behavior that needs a real browser: layout and scrolling, focus and pointer input, real workers, or a component wired to its hooks. Logic a component calls gets a unit test beside it (`*.logic.test.ts`). A browser test file spends seconds in CI loading its module graph before its first test runs; a unit test takes milliseconds.
- In review, ask for a missing test only when it would catch a real regression. Do not ask for one assertion per constant, label, or `switch` case. Flag a new test that breaks the rules above, and name the fix: fold it into the existing case or table, delete it, keep one layer, or move a browser test whose assertions would pass without rendering into a unit test.
- Backend behavior changes ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in an existing case of the module's test file where one fits), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.

## Waiting for work

- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-frame-waits-in-browser-tests`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`.

## Web browser tests

- Web browser tests are `*.browser.test.tsx` or `*.browser.test.ts` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx`. `t3code/require-disposable-render` errors on the old patterns.
  - Acquire what the test drives after mounting (fake timers it advances, spies it sets up after mounting) after the render, so it disposes before the unmount. Anything the first render reads comes before it.
  - A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
  - `rerender` needs a fresh element on every call.
  - No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories read is reset by a `setup()` call at the top of the test.
  - `router` is on by default. Pass `router: false` only with a one-line comment saying why.

  ```tsx
  it("saves on Enter", async () => {
    const onSave = vi.fn();
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
    await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
    expect(onSave).toHaveBeenCalledWith("Title");
  });
  ```

## Scenarios

Scenarios are [e2e](https://e2e.com/docs) tests in [`scripts/scenarios`](../../scripts/scenarios) (`*.e2e.ts`) that drive the real app (server, HTTP/WS, web browser or pooled iOS simulator) using the free `Replay (dev)` agent. Use one as real-app proof for a user-reproducible bug fix:

```sh
vp run scenarios                                                  # run all
vp run scenarios:prove scripts/scenarios/<name>.e2e.ts --base main --upload-command "ghdrop upload"
```

- One test per file (`WEB` from `./t3.ts` or `IOS` from `./t3-mobile.ts`). Seed projects and threads via `t3.project` / `t3.thread` before calling `t3.open(...)` so the app does not land on first-run setup.
- In web scenarios, navigate directly with `t3.open(thread)` or `t3.open("/settings/...")` unless the scenario exercises sidebar navigation.
- Put `expect` assertions only on the behavior the bug breaks, and take `app.screenshot("label")` where the bug shows so `scenarios:prove` pairs base and head captures. Never call `agent.act` or `agent.assert` (no model is configured).
- The app starts with a minimal env (`PATH`, `HOME`, temp dir); pass extra env vars via `T3_SCENARIO_INHERIT_ENV='VAR,PREFIX_*'`. Run one scenario run at a time per checkout.
- `scenarios:prove` exits `0` only when the test fails on base and passes on head (`1` = did not prove, `2` = app failed to start, `3` = scenario failed before its assertion). iOS scenarios lease a Simlock simulator and require `SIMLOCK_AGENT_DEVICE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`.
- Scenarios cannot cover desktop shell/IPC, Android, provider-specific protocol behavior (replay speaks generic ACP), or timing/perf regressions.

## Local stand-ins prove only our side

[`scripts/fixtures`](../../scripts/fixtures) holds Docker-backed stand-ins for the services a deployed Sail server uses, so its checks run on one computer with no accounts. `fake-fly/fly` backs each Fly app with one container and named volumes. `fake-boat/boat` backs each Boat sandbox with a systemd container that has fake `claude` and `codex` CLIs. `replay-provider.ts` registers the free replay agent on a bundled server as `Replay (fixture)`. `release-mirror.ts` serves locally built CLI archives and `install.sh` in the layout of a GitHub release. One shared Caddy container serves each fake app and sandbox at `https://<name>.localtest.me`. Its root CA, `~/.local/state/sail-fixtures/caddy/ca/root.crt`, can sign only `localtest.me` names. Pass it to curl with `--cacert` and to Node with `NODE_EXTRA_CA_CERTS`. A browser trusts it only after someone adds it to the system keychain once, because T3's Browser panel asks a person about every untrusted certificate. `sail-boatd` trusts only the public webpki roots, so it reaches a fake machine only over `http://`. Each fake copies only the commands, flags, and JSON fields our code uses, so a pass shows that our code calls the service correctly, not that the service behaves this way. Before anyone relies on a flow, run it once on the real service, as Appendix E of the [personal cloud server plan](../plans/sail-personal-cloud-server.md) lists.

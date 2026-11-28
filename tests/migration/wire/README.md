# Check the incumbent v2 wire contract

Run the fixture from the repository root.

```sh
vp test run tests/migration/wire/incumbent.test.ts
```

The test starts the Sail source server on loopback with a fresh temporary home. It creates
and deletes a synthetic project, issues a read-only session, and checks
[`incumbent-v2.json`](incumbent-v2.json) against the server. It also changes the expected replay
sequence and checks that the comparison fails at that frame.

The capture uses the source at `f29f09835c97386742075c6edf799d1669923b15`. The public
[Sail v0.1.17 release](https://github.com/snowdamiz/sail/releases/tag/v0.1.17) is at
`18fd0e5d66291fc007163512d783d7268218db16`. The server, contracts, client runtime, and
dependency lockfile match between those commits. The test runs the source server.

## Check a candidate server

1. Start the candidate on a fresh, disposable home.
2. Apply the fixture's `seed.create` and `seed.remove` to `POST /api/projects/mutate` in that
   order with `orchestration:operate`. Add the absolute path to an empty directory as
   `workspaceRoot` in `seed.create`. The deletion must be at application sequence 2.
3. Issue a bearer token with the fixture's `sessionScopes` and set `SAIL_WIRE_READ_TOKEN`
   in the runner's environment. Then run the checker with the candidate's origin.

```sh
node tests/migration/wire/check.ts http://127.0.0.1:PORT
```

A Rust test can also read the fixture directly. Send each `send` object as one WebSocket
text frame and compare each response with its `receive` object in order. The checker
compares parsed JSON and records any nonnegative integer `Interrupt.fiberId` as `0`.
The final Pong marks the end of the checked exchange. The ticket and bearer token stay
out of the receipt.

The fixture covers shell event replay from a cursor with an HTTP resume decision.

## Check a Replay conversation

[`incumbent-replay-v2.json`](incumbent-replay-v2.json) freezes a Showcase turn from
the published v0.1.17 macOS arm64 package. The [source integration tests](incumbent.test.ts)
run the same check with the repository's Replay agent.

1. Prepare a new absolute fixture directory with
   `sh tests/migration/incumbent/replay-fixture.sh prepare "$fixture"`. Start the package
   or candidate on its `state` directory with startup pairing off. The check creates the
   project and thread and sends the prompt.
2. Issue one fresh session with `orchestration:read` and another with both
   `orchestration:read` and `orchestration:operate`. Supply them as
   `SAIL_WIRE_READ_TOKEN` and `SAIL_WIRE_OPERATE_TOKEN`.
3. Run the checker from the repository root.

```sh
node tests/migration/wire/replay.ts "$origin" "$fixture/project"
```

The checker acknowledges each chunk. It disconnects the writing socket after the send
receipt and disconnects the reading socket after the first streaming reply. A separate
read-only subscription waits for completion before a new socket resumes at the saved
cursor. The checker compares overlapping event cursors and payloads with the live witness
after coalescing superseded running updates. It ties the send receipt to the delivered
user item and applies projection events through cancellation. Completed runs and turn
items stay completed. The final projection must retain the captured v2 fields, resolve
the active provider thread and provider-turn node, match the streamed rows by unique ID,
and show each transcript item once in order. Retrying the command returns its original
receipt. A fresh read-only send receives the typed denial. The checker compares the
full settled projection before and after each action. New fields may be added to the
projection while established fields and references remain compatible. The sample
records preserve dynamic IDs, timestamps, and sequence values as examples. The checker
compares stable fields and cursor relationships across runs. Credentials and download
tickets stay out of the fixture.

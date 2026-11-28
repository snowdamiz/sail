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

The fixture covers shell event replay from a cursor with an HTTP resume decision. Replay
provider conversations, other transports, and the client's update UI need separate checks.

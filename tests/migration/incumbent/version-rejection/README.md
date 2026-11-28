# P01 client version rejection

This fixture serves a simulated protocol-1 boot-service descriptor to the published Sail v0.1.17 client at source `18fd0e5d66291fc007163512d783d7268218db16`. The published server independently returned HTTP 426 to a protocol-1 request and reported required protocol 2. Use that separate observation for the wire rejection. [Published runtime receipt](../runtime/v0.1.17-macos-arm64.json)

The fixture tests the other direction. The v0.1.17 client discovers older metadata, exchanges a one-time code for a bearer session, and can save the environment because it advertises self-update. The normal connection then stops at the client's descriptor check. Clicking **Update** opens a ticket-authenticated socket without the protocol parameter and requests `server.updateServer` for v0.1.17. The simulator records the request and returns a typed failure on purpose. It runs no update, installer, subprocess, relay, or upgrade download.

## Capture the published client

1. Use the installed v0.1.17 client against an isolated primary home. Use `sail://app` as the packaged Electron renderer origin. For a browser running the packaged client on the same machine, use its loopback HTTP origin, for example `http://127.0.0.1:12345`. Use the origin alone, without a route or trailing slash.
2. With the checkout dependencies installed, start the fixture from the repository root. The generated code goes into a private scratch file. The process prints its loopback origin and redacted event records.

   ```sh
   client_origin=sail://app
   scratch=$(mktemp -d)
   (umask 077; python3 -c 'import secrets; print("".join(secrets.choice("23456789ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(12)))' > "$scratch/code")
   node tests/migration/incumbent/version-rejection/fixture.mjs "$client_origin" "$scratch/code"
   ```

3. In **Settings → Environments → Add environment → Remote link**, put the fixture origin in **Host** and enter the code from the private scratch file in **Pairing code**. Submit **Add environment**. Keep the pairing form and network details out of the capture.
4. On the **P01 simulated older boot service** row, wait for **Client not supported** and **Update**. Capture this state as `ref-contract.png`. Click **Update** and observe the simulated failure and **Retry update**. The event records should include `pairing-exchanged`, `authenticated-bare-update-socket`, and `simulated-update-refused` with method `server.updateServer` and target version `0.1.17`. The update events should first appear after the click.
5. Label the UI and update request evidence as simulated protocol-1 metadata. Cite the published runtime receipt separately for HTTP 426 and required protocol 2. Stop the fixture with Ctrl-C. Its credentials and tickets expire when the process exits.

## Check the fixture without a client window

```sh
node --test --test-timeout=5000 tests/migration/incumbent/version-rejection/fixture.test.mjs
```

The check exercises a real loopback HTTP listener and WebSocket handshake. It rejects an invalid or reused pairing code, unauthenticated ticket minting, an uncredentialed or versioned socket, a reused socket ticket, and an unapproved browser origin. It checks that the authenticated update request returns the simulated failure and leaves the advertised protocol at 1.

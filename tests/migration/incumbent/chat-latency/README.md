# Measure a Replay turn and reconnect in the incumbent browser

Prepare a fresh [Replay fixture](../README.md#seed-the-replay-fixture-on-macos) and run the published package's bundled server with startup pairing off. Issue a test bearer session with `orchestration:read` and `orchestration:operate`. Set `SAIL_WIRE_OPERATE_TOKEN` privately for the seeder.

```sh
node tests/migration/incumbent/chat-latency/seed.mjs "$origin" "$fixture/project"
node tests/migration/incumbent/chat-latency/proxy.mjs \
  "$backend_port" "$fixture/state/userdata/statev2.sqlite"
```

The proxy prints its loopback port. Redeem a fresh one-time pairing link in an isolated Browser panel tab, using the proxy port as the link's origin. Navigate to `/<environment-id>/latency-00` and run the function in [browser-probe.js](browser-probe.js) with `latency-00` as its argument. Remove the `export default` prefix when evaluating it in the browser. Use a fresh numbered thread for every sample.

The probe starts the send timer at the Submit button click. It records the first assistant text as it appears in the DOM. The proxy then closes the browser's WebSocket while the Replay run is still active. It refuses reconnects until the run has completed and the saved projection matches all three fixture messages. The probe records the reconnect notice before asking the proxy to admit connections.

The reconnect timer starts when the browser requests that the proxy restore access. It ends when the browser shows one submitted message and the final reply with the expected code and every table cell, and the reconnect notice and Stop button have cleared. This interval includes the automatic retry delay, the loopback control request, and rendering. The provider completes the turn during the offline hold, outside the reconnect timer.

After timing, the probe expands **Worked for…** and checks all three rendered messages in order. Each sample retains the checked browser text and table cells alongside the saved server projection.

Discard two warmups and retain the raw outcomes for twelve measured turns. Use a fresh fixture and proxy to restart a failed series. Keep browser boot, pairing, thread creation, and screenshots outside the timers. [Published v0.1.17 receipt and samples](../observations/served-chromium-macos/chat-latency/receipt.json)

## Verify a lost send receipt

Use a fresh seeded thread and start the receipt gate in place of the timing proxy.

```sh
node tests/migration/incumbent/send-once-gate.mjs "$backend_port" latency-00
```

Pair through the gate's loopback origin. Open `latency-00`, type **Give me a short tour**, and click **Submit message** once. The gate drops the first successful send response and closes that socket. It checks that the client resends the same command on a new connection, then forwards the retry response after comparing it with the dropped receipt.

After the reply settles, expand **Worked for…** and check all three messages in order. Verify one accepted dispatch receipt and one completed run in the scratch database. Check that the stored receipt sequence matches the two wire responses. [Published v0.1.17 send-once receipt](../observations/served-chromium-macos/send-once/receipt.json)

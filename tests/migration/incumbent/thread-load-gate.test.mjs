import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const serverRequire = NodeModule.createRequire(
  new URL("../../../apps/server/package.json", import.meta.url),
);
const { WebSocketServer } = NodeModule.createRequire(
  serverRequire.resolve("@effect/platform-node/NodeSocket"),
)("ws");

NodeTest.test("a cancelled thread subscription stays cancelled when the gate opens", async (t) => {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sail-thread-load-gate-"));
  t.after(() => NodeFSP.rm(scratch, { recursive: true, force: true }));
  const gateFile = NodePath.join(scratch, "gate");
  await NodeFSP.writeFile(gateFile, "hold");

  const upstreamFrames = [];
  const upstream = NodeHttp.createServer();
  const sockets = new WebSocketServer({ server: upstream });
  t.after(() => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    upstream.close();
  });
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      upstreamFrames.push(frame);
      if (frame._tag === "Request") socket.send(JSON.stringify({ requestId: frame.id }));
    }),
  );
  upstream.listen(0, "127.0.0.1");
  await NodeEvents.once(upstream, "listening");

  const gate = NodeChildProcess.spawn(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("./thread-load-gate.mjs", import.meta.url)),
      "0",
      String(upstream.address().port),
      "fixture-thread",
      gateFile,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const gateExited = NodeEvents.once(gate, "exit");
  const lines = NodeReadline.createInterface({ input: gate.stdout });
  t.after(async () => {
    gate.kill();
    await gateExited;
    lines.close();
  });
  const [ready] = await NodeEvents.once(lines, "line");
  const origin = /^Listening on (127\.0\.0\.1:\d+)$/.exec(ready)?.[1];
  NodeAssert.ok(origin);

  const client = new WebSocket(`ws://${origin}/ws`);
  t.after(() => client.close());
  await NodeEvents.once(client, "open");
  const request = (id, threadId) => ({
    _tag: "Request",
    id,
    tag: "orchestration.subscribeThread",
    payload: { threadId },
    headers: [],
  });
  const cancelled = request(3, "fixture-thread");
  const retained = request("4", "fixture-thread");
  const unrelated = request("5", "other-thread");
  const reply = NodeEvents.once(client, "message");
  for (const frame of [cancelled, retained, { _tag: "Interrupt", requestId: "3" }, unrelated]) {
    client.send(JSON.stringify(frame));
  }
  NodeAssert.deepEqual(JSON.parse((await reply)[0].data), { requestId: "5" });
  NodeAssert.deepEqual(upstreamFrames, [unrelated]);

  const released = NodeEvents.once(client, "message");
  await NodeFSP.writeFile(gateFile, "open");
  NodeAssert.deepEqual(JSON.parse((await released)[0].data), { requestId: "4" });
  NodeAssert.deepEqual(upstreamFrames, [unrelated, retained]);

  const later = request("6", "other-thread");
  const activeInterrupt = { _tag: "Interrupt", requestId: "4" };
  const afterInterrupt = NodeEvents.once(client, "message");
  client.send(JSON.stringify(activeInterrupt));
  client.send(JSON.stringify(later));
  NodeAssert.deepEqual(JSON.parse((await afterInterrupt)[0].data), { requestId: "6" });
  NodeAssert.deepEqual(upstreamFrames, [unrelated, retained, activeInterrupt, later]);
});

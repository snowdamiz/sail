import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const serverRequire = NodeModule.createRequire(
  new URL("../../../apps/server/package.json", import.meta.url),
);
const { WebSocketServer } = NodeModule.createRequire(
  serverRequire.resolve("@effect/platform-node/NodeSocket"),
)("ws");
const host = "127.0.0.1";

it("rejects a retry that reuses the tracked command ID on a different thread", async () => {
  const server = NodeHttp.createServer();
  const upstream = new WebSocketServer({ server });
  const received = [];
  upstream.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      received.push(request.payload.threadId);
      socket.send(
        JSON.stringify({
          _tag: "Exit",
          requestId: request.id,
          exit: { _tag: "Success", value: { sequence: 9 } },
        }),
      );
    });
  });
  server.listen(0, host);
  const signal = AbortSignal.timeout(5_000);
  await NodeEvents.once(server, "listening", { signal });
  const gate = NodeChildProcess.spawn(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("./send-once-gate.mjs", import.meta.url)),
      String(server.address().port),
      "fixture-thread",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = NodeEvents.once(gate, "close");
  const lines = NodeReadline.createInterface({ input: gate.stdout });
  let stderr = "";
  gate.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  const clients = [];
  try {
    const [line] = await NodeEvents.once(lines, "line", { signal });
    const port = Number(line.split(":").at(-1));
    expect(port).toBeGreaterThan(0);
    for (const [id, threadId] of [
      [7, "fixture-thread"],
      [8, "other-thread"],
    ]) {
      const socket = new WebSocket(`ws://${host}:${port}/ws`);
      clients.push(socket);
      await NodeEvents.once(socket, "open", { signal });
      const disconnected = NodeEvents.once(socket, "close", { signal });
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id,
          tag: "orchestration.dispatchCommand",
          payload: { type: "message.dispatch", threadId, commandId: "tracked", text: "fixture" },
        }),
      );
      await disconnected;
    }
    expect(await closed).toEqual([1, null]);
    expect(stderr).toContain("Retry changed the command");
    expect(received).toEqual(["fixture-thread"]);
  } finally {
    for (const socket of clients) socket.close();
    lines.close();
    if (gate.exitCode === null) gate.kill();
    await closed;
    for (const socket of upstream.clients) socket.terminate();
    upstream.close();
    server.close();
  }
});

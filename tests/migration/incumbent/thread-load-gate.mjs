import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";

const [portText, upstreamPortText, threadId, gateFile] = process.argv.slice(2);
const port = Number(portText);
const upstreamPort = Number(upstreamPortText);
if (
  ![port, upstreamPort].every((value) => Number.isInteger(value) && value > 0 && value <= 65535) ||
  port === upstreamPort ||
  !threadId ||
  !gateFile
) {
  throw new Error(
    "Usage: node thread-load-gate.mjs <port> <upstream-port> <thread-id> <gate-file>",
  );
}

const serverRequire = NodeModule.createRequire(
  new URL("../../../apps/server/package.json", import.meta.url),
);
const { WebSocket, WebSocketServer } = NodeModule.createRequire(
  serverRequire.resolve("@effect/platform-node/NodeSocket"),
)("ws");
const loopback = "127.0.0.1";
const readGate = () => NodeFS.readFileSync(gateFile, "utf8").trim() === "hold";
const pending = new Set();

function hold(event, deliver) {
  pending.add(deliver);
  process.stdout.write(`${JSON.stringify({ event })}\n`);
}

setInterval(() => {
  if (pending.size === 0 || readGate()) return;
  for (const deliver of pending) deliver();
  pending.clear();
}, 50).unref();

const server = NodeHttp.createServer((request, response) => {
  const forward = () => {
    if (response.destroyed) return;
    const upstream = NodeHttp.request(
      {
        hostname: loopback,
        port: upstreamPort,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      }
      response.end("The packaged fixture server is unavailable");
    });
    request.pipe(upstream);
  };
  const path = new URL(request.url, `http://${loopback}`).pathname;
  const threadPath = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
  if (
    request.method === "GET" &&
    (path === threadPath || path.startsWith(`${threadPath}/`)) &&
    readGate()
  ) {
    hold("held-thread-http", forward);
    response.on("close", () => pending.delete(forward));
    return;
  }
  forward();
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const headers = Object.fromEntries(
    ["host", "origin", "cookie", "user-agent", "x-t3-orchestration-protocol"].flatMap((name) =>
      typeof request.headers[name] === "string" ? [[name, request.headers[name]]] : [],
    ),
  );
  const upstream = new WebSocket(`ws://${loopback}:${upstreamPort}${request.url}`, { headers });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.terminate());
  socket.on("close", () => upstream.terminate());
  upstream.once("open", () => {
    sockets.handleUpgrade(request, socket, head, (browser) => {
      browser.on("error", () => upstream.terminate());
      upstream.on("close", () => browser.terminate());
      browser.on("close", () => upstream.terminate());
      upstream.on("message", (data, binary) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary });
      });
      browser.on("message", (data, binary) => {
        const forward = () => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        };
        let frame;
        try {
          if (!binary) frame = JSON.parse(data.toString());
        } catch {
          forward();
          return;
        }
        if (
          frame?._tag === "Request" &&
          frame.tag === "orchestration.subscribeThread" &&
          frame.payload?.threadId === threadId &&
          readGate()
        ) {
          hold("held-thread-rpc", forward);
          return;
        }
        forward();
      });
    });
  });
});

readGate();
server.listen(port, loopback, () => process.stdout.write(`Listening on ${loopback}:${port}\n`));

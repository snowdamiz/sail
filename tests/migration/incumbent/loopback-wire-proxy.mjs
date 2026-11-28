import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";

const serverRequire = NodeModule.createRequire(
  new URL("../../../apps/server/package.json", import.meta.url),
);
const { WebSocket, WebSocketServer } = NodeModule.createRequire(
  serverRequire.resolve("@effect/platform-node/NodeSocket"),
)("ws");
const loopback = "127.0.0.1";

export function startLoopbackWireProxy({ port, upstreamPort, onHttp, onSocket }) {
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url, `http://${loopback}`);
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
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    };
    if (onHttp) onHttp(request, response, url, forward);
    else forward();
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url, `http://${loopback}`).pathname !== "/ws") {
      socket.destroy();
      return;
    }
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
        browser.on("close", () => upstream.terminate());
        upstream.on("close", () => browser.terminate());
        const hooks = onSocket(browser);
        upstream.on("message", (data, binary) => {
          const forward = () => {
            if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary });
          };
          if (hooks.toClient) hooks.toClient(data, binary, forward);
          else forward();
        });
        browser.on("message", (data, binary) => {
          const forward = () => {
            if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          };
          if (hooks.toServer) hooks.toServer(data, binary, forward);
          else forward();
        });
      });
    });
  });
  server.listen(port, loopback, () =>
    process.stdout.write(`Listening on ${loopback}:${server.address().port}\n`),
  );
}

export function parseWireFrame(data, binary) {
  if (binary) return undefined;
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
}

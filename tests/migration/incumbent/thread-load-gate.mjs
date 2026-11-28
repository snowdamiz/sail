import * as NodeFS from "node:fs";
import { parseWireFrame, startLoopbackWireProxy } from "./loopback-wire-proxy.mjs";

const [portText, upstreamPortText, threadId, gateFile] = process.argv.slice(2);
const port = Number(portText);
const upstreamPort = Number(upstreamPortText);
if (
  !portText ||
  !Number.isInteger(port) ||
  port < 0 ||
  port > 65535 ||
  !Number.isInteger(upstreamPort) ||
  upstreamPort < 1 ||
  upstreamPort > 65535 ||
  port === upstreamPort ||
  !threadId ||
  !gateFile
) {
  throw new Error(
    "Usage: node thread-load-gate.mjs <port> <upstream-port> <thread-id> <gate-file>",
  );
}

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

readGate();
startLoopbackWireProxy({
  port,
  upstreamPort,
  onHttp(request, response, url, forward) {
    const threadPath = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
    if (
      request.method === "GET" &&
      (url.pathname === threadPath || url.pathname.startsWith(`${threadPath}/`)) &&
      readGate()
    ) {
      hold("held-thread-http", forward);
      response.on("close", () => pending.delete(forward));
      return;
    }
    forward();
  },
  onSocket(browser) {
    const heldRequests = new Map();
    browser.on("close", () => {
      for (const deliver of heldRequests.values()) pending.delete(deliver);
      heldRequests.clear();
    });
    return {
      toServer(data, binary, forward) {
        const frame = parseWireFrame(data, binary);
        if (frame?._tag === "Interrupt") {
          const id = String(frame.requestId);
          const deliver = heldRequests.get(id);
          if (deliver) {
            heldRequests.delete(id);
            pending.delete(deliver);
            return;
          }
        }
        if (
          frame?._tag === "Request" &&
          frame.tag === "orchestration.subscribeThread" &&
          frame.payload?.threadId === threadId &&
          (typeof frame.id === "string" || typeof frame.id === "number") &&
          readGate()
        ) {
          const id = String(frame.id);
          const deliver = () => {
            heldRequests.delete(id);
            forward();
          };
          heldRequests.set(id, deliver);
          hold("held-thread-rpc", deliver);
          return;
        }
        forward();
      },
    };
  },
});

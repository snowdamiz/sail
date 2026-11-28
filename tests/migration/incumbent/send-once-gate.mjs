import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import { parseWireFrame, startLoopbackWireProxy } from "./loopback-wire-proxy.mjs";

const [upstreamPortText, threadId] = process.argv.slice(2);
const upstreamPort = Number(upstreamPortText);
NodeAssert.ok(Number.isInteger(upstreamPort) && upstreamPort > 0 && upstreamPort <= 65535);
NodeAssert.ok(threadId, "Pass the empty Replay fixture thread ID");

let connectionCount = 0;
let original;
let acceptedReceipt;
let replayed = false;
function report(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

startLoopbackWireProxy({
  port: 0,
  upstreamPort,
  onSocket(browser) {
    const connection = ++connectionCount;
    let requestId;
    return {
      toServer(data, binary, forward) {
        const frame = parseWireFrame(data, binary);
        if (
          frame?._tag === "Request" &&
          frame.tag === "orchestration.dispatchCommand" &&
          ((original && frame.payload?.commandId === original.command.commandId) ||
            (frame.payload?.type === "message.dispatch" && frame.payload.threadId === threadId))
        ) {
          NodeAssert.ok(
            typeof frame.id === "string" || typeof frame.id === "number",
            "Expected a wire request ID for the send",
          );
          NodeAssert.ok(typeof frame.payload.commandId === "string" && frame.payload.commandId);
          NodeAssert.equal(requestId, undefined, "Expected one send per connection");
          if (original) {
            NodeAssert.ok(acceptedReceipt, "Expected acceptance before retry");
            NodeAssert.equal(replayed, false, "Expected a single retry");
            NodeAssert.notEqual(connection, original.connection, "Expected a new connection");
            NodeAssert.deepEqual(frame.payload, original.command, "Retry changed the command");
          } else {
            original = { connection, command: frame.payload };
          }
          requestId = String(frame.id);
          report({
            event: "send",
            connection,
            requestId,
            commandId: frame.payload.commandId,
            commandSha256: NodeCrypto.createHash("sha256")
              .update(JSON.stringify(frame.payload))
              .digest("hex"),
          });
        }
        forward();
      },
      toClient(data, binary, forward) {
        const frame = parseWireFrame(data, binary);
        if (
          requestId === undefined ||
          frame?._tag !== "Exit" ||
          String(frame.requestId) !== requestId
        ) {
          forward();
          return;
        }
        NodeAssert.equal(frame.exit?._tag, "Success", "Expected the server to accept the send");
        const receipt = frame.exit.value;
        NodeAssert.ok(Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0);
        NodeAssert.deepEqual(receipt, { sequence: receipt.sequence });
        if (connection === original.connection) {
          NodeAssert.equal(acceptedReceipt, undefined, "Expected one original receipt");
          acceptedReceipt = receipt;
          report({ event: "receipt-dropped", connection, requestId, receipt });
          browser.terminate();
          return;
        }
        NodeAssert.equal(replayed, false, "Expected one replayed receipt");
        NodeAssert.deepEqual(receipt, acceptedReceipt, "Retry returned a different receipt");
        replayed = true;
        report({ event: "receipt-delivered", connection, requestId, receipt });
        forward();
      },
    };
  },
});

import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import { openWireSocket } from "../../wire/socket.ts";

const [address, targetVersion] = process.argv.slice(2);
const origin = new URL(address);
NodeAssert.equal(origin.hostname, "127.0.0.1");
const { socket: endpoint } = JSON.parse(
  NodeFS.readFileSync(new URL("../../wire/incumbent-v2.json", import.meta.url), "utf8"),
);
const token = NodeFS.readFileSync(0, "utf8").trim();
await using socket = await openWireSocket(origin, token, AbortSignal.timeout(120_000), endpoint);
socket.send({
  _tag: "Request",
  id: "0",
  tag: "server.updateServer",
  payload: { targetVersion },
  headers: [],
});
const reply = await socket.receive();
NodeAssert.equal(reply?._tag, "Exit");
NodeAssert.equal(reply.requestId, "0");
console.log(JSON.stringify(reply.exit));

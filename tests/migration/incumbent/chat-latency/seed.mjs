import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

import replay from "../../wire/incumbent-replay-v2.json" with { type: "json" };
import wire from "../../wire/incumbent-v2.json" with { type: "json" };
import { openWireSocket } from "../../wire/socket.ts";

const [originText, workspaceRoot, countText = "16"] = process.argv.slice(2);
const token = process.env.SAIL_WIRE_OPERATE_TOKEN;
const count = Number(countText);
NodeAssert.ok(
  originText && workspaceRoot && NodePath.isAbsolute(workspaceRoot) && token,
  "Pass the source origin and absolute fixture project path, and set SAIL_WIRE_OPERATE_TOKEN",
);
NodeAssert.ok(
  Number.isInteger(count) && count >= 1 && count <= 100,
  "Use a thread count from 1 to 100",
);
const origin = new URL(originText);
NodeAssert.ok(
  origin.protocol === "http:" && origin.hostname === "127.0.0.1",
  "Use an isolated loopback server",
);
const signal = AbortSignal.timeout(15_000);
const project = await fetch(new URL("/api/projects/mutate", origin), {
  method: "POST",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ ...replay.project, workspaceRoot }),
  redirect: "error",
  signal,
});
NodeAssert.equal(project.status, 200, "Create the fixture project");
await project.body?.cancel();

await using socket = await openWireSocket(origin, token, signal, wire.socket);
const threads = [];
for (let index = 0; index < count; index++) {
  const label = String(index).padStart(2, "0");
  const threadId = "latency-" + label;
  const command = {
    ...replay.createThread,
    threadId,
    commandId: "create-" + threadId,
    title: "Compatibility replay " + label,
  };
  socket.send({
    _tag: "Request",
    id: label,
    tag: "orchestration.dispatchCommand",
    payload: command,
    headers: [],
  });
  const reply = await socket.receive();
  NodeAssert.equal(reply?.requestId, label);
  NodeAssert.equal(reply?.exit?._tag, "Success");
  threads.push(threadId);
}
process.stdout.write(JSON.stringify(threads) + "\n");

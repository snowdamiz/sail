import * as NodeAssert from "node:assert/strict";

import incumbent from "./incumbent-v2.json" with { type: "json" };
import { openWireSocket } from "./socket.ts";

export async function checkWire(origin: URL, token: string, fixture = incumbent) {
  const signal = AbortSignal.timeout(15_000);
  const authorization = `Bearer ${token}`;
  for (const { path, headers, status, body } of fixture.http) {
    const response = await fetch(new URL(path, origin), {
      signal,
      ...(headers === undefined ? {} : { headers: { ...headers, authorization } }),
      redirect: "error",
    });
    NodeAssert.equal(response.status, status, path);
    NodeAssert.match(response.headers.get("content-type") ?? "", /^application\/json\b/, path);
    NodeAssert.deepEqual(await response.json(), body, path);
  }

  await using socket = await openWireSocket(origin, token, signal, fixture.socket);
  for (const [index, step] of fixture.socket.steps.entries()) {
    if (step.send !== undefined) {
      socket.send(step.send);
    } else {
      const frame = await socket.receive();
      NodeAssert.ok(frame !== undefined, `Socket closed at fixture step ${index + 1}`);
      NodeAssert.deepEqual(frame, step.receive, `Socket fixture step ${index + 1}`);
    }
  }
  await socket.close();
  NodeAssert.equal(await socket.receive(), undefined, "Unexpected frame after the final Pong");
}

if (import.meta.main) {
  const origin = process.argv[2];
  const token = process.env.SAIL_WIRE_READ_TOKEN;
  NodeAssert.ok(origin && token, "Pass the server origin and set SAIL_WIRE_READ_TOKEN");
  await checkWire(new URL(origin), token);
  process.stdout.write("Incumbent v2 wire checks passed.\n");
}

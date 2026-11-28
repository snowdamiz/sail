import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";

import incumbent from "./incumbent-v2.json" with { type: "json" };

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

  const issued = await fetch(new URL(fixture.socket.ticketPath, origin), {
    method: "POST",
    headers: { authorization },
    signal,
    redirect: "error",
  });
  NodeAssert.equal(issued.status, 200, "Minting the RPC ticket");
  NodeAssert.match(
    issued.headers.get("content-type") ?? "",
    /^application\/json\b/,
    "RPC ticket type",
  );
  const proof: unknown = await issued.json();
  NodeAssert.ok(
    typeof proof === "object" &&
      proof !== null &&
      "ticket" in proof &&
      typeof proof.ticket === "string" &&
      proof.ticket.trim().length > 0 &&
      "expiresAt" in proof &&
      typeof proof.expiresAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proof.expiresAt) &&
      Number.isFinite(Date.parse(proof.expiresAt)) &&
      new Date(proof.expiresAt).toISOString() === proof.expiresAt,
    "The ticket response must contain a token and its UTC expiry",
  );
  const url = new URL(fixture.socket.path, origin);
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(fixture.socket.ticketQuery, proof.ticket);
  const socket = new WebSocket(url);
  const socketFailure = new AbortController();
  socket.addEventListener("error", () => socketFailure.abort(new Error("RPC socket failed")), {
    once: true,
  });
  const socketSignal = AbortSignal.any([signal, socketFailure.signal]);
  const messages = NodeEvents.EventEmitter.on(socket, "message", {
    signal: socketSignal,
    close: ["close"],
  });
  try {
    await NodeEvents.EventEmitter.once(socket, "open", { signal: socketSignal });
    for (const [index, step] of fixture.socket.steps.entries()) {
      if (step.send !== undefined) {
        socket.send(JSON.stringify(step.send));
      } else {
        const message = await messages.next();
        NodeAssert.ok(!message.done, `Socket closed at fixture step ${index + 1}`);
        const event: unknown = message.value[0];
        NodeAssert.ok(
          event instanceof MessageEvent && typeof event.data === "string",
          "Expected text",
        );
        const frame: unknown = JSON.parse(
          event.data,
          function (this: { _tag?: unknown }, key: string, value: unknown): unknown {
            if (
              key === "fiberId" &&
              this._tag === "Interrupt" &&
              typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value >= 0
            ) {
              return 0;
            }
            return value;
          },
        );
        NodeAssert.deepEqual(frame, step.receive, `Socket fixture step ${index + 1}`);
      }
    }
    socket.close();
    NodeAssert.ok((await messages.next()).done, "Unexpected frame after the final Pong");
  } finally {
    socket.close();
    await messages.return?.();
  }
}

if (import.meta.main) {
  const origin = process.argv[2];
  const token = process.env.SAIL_WIRE_READ_TOKEN;
  NodeAssert.ok(origin && token, "Pass the server origin and set SAIL_WIRE_READ_TOKEN");
  await checkWire(new URL(origin), token);
  process.stdout.write("Incumbent v2 wire checks passed.\n");
}

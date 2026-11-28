import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";

interface TicketEndpoint {
  readonly ticketPath: string;
  readonly path: string;
  readonly ticketQuery: string;
}

export async function openWireSocket(
  origin: URL,
  token: string,
  signal: AbortSignal,
  endpoint: TicketEndpoint,
) {
  const authorization = `Bearer ${token}`;
  const issued = await fetch(new URL(endpoint.ticketPath, origin), {
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
  const url = new URL(endpoint.path, origin);
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(endpoint.ticketQuery, proof.ticket);
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
  } catch (error) {
    socket.close();
    await messages.return?.();
    throw error;
  }
  return {
    send(frame: unknown) {
      socket.send(JSON.stringify(frame));
    },
    async receive(): Promise<unknown> {
      const message = await messages.next();
      if (message.done) return undefined;
      const event: unknown = message.value[0];
      NodeAssert.ok(
        event instanceof MessageEvent && typeof event.data === "string",
        "Expected text",
      );
      return JSON.parse(
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
    },
    async close() {
      const closed = NodeEvents.EventEmitter.once(socket, "close", { signal: socketSignal });
      socket.close();
      await closed;
    },
    async [Symbol.asyncDispose]() {
      socket.close();
      await messages.return?.();
    },
  };
}

export type WireSocket = Awaited<ReturnType<typeof openWireSocket>>;

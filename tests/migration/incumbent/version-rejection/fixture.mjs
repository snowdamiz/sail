import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

// The server's locked Effect platform package supplies ws.
const serverRequire = NodeModule.createRequire(
  new URL("../../../../apps/server/package.json", import.meta.url),
);
const { WebSocketServer } = process.env.SAIL_MIGRATION_WS_MODULE
  ? serverRequire(process.env.SAIL_MIGRATION_WS_MODULE)
  : NodeModule.createRequire(serverRequire.resolve("@effect/platform-node/NodeSocket"))("ws");

const HOST = "127.0.0.1";
const DESCRIPTOR_PATH = "/.well-known/t3/environment";
const EXCHANGE_PATH = "/oauth/token";
const TICKET_PATH = "/api/auth/websocket-ticket/rpc";
const ACCESS_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const BOOTSTRAP_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const SCOPES = ["orchestration:read", "orchestration:operate", "environment:maintain"];
const UPDATE_METHOD = "server.updateServer";
const TARGET_VERSION = "0.1.17";
const REFUSAL = "Simulated boot service. The fixture does not install updates.";

const unauthorized = {
  _tag: "EnvironmentAuthInvalidError",
  code: "auth_invalid",
  reason: "invalid_credential",
  traceId: "simulated-version-rejection",
};

function json(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(body));
}

async function exchangeForm(request) {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
    return new URLSearchParams();
  }
  let body = "";
  for await (const chunk of request.setEncoding("utf8")) {
    body += chunk;
    if (body.length > 4096) throw new Error("Oversized token exchange");
  }
  return new URLSearchParams(body);
}

export async function startFixture({ clientOrigin, pairingCode, observe, port = 0 }) {
  if (
    !/^(?:sail:\/\/app|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)$/.test(clientOrigin) ||
    !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/.test(pairingCode)
  ) {
    throw new Error(
      "Expected sail://app or a loopback HTTP origin, and a 12-character pairing code",
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Expected a valid loopback port");
  }
  const descriptor = {
    environmentId: NodeCrypto.randomUUID(),
    label: "P01 simulated older boot service",
    platform: { os: "linux", arch: "x64", machine: "server" },
    serverVersion: "0.0.0-p01",
    orchestrationProtocolVersion: 1,
    capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" },
  };
  const auth = {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
    serverUpdateScope: "environment:maintain",
  };
  const bearer = NodeCrypto.randomBytes(32).toString("base64url");
  const tickets = new Map();
  let expiresAt = 0;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const allowed = (request) =>
    request.headers.host === `${HOST}:${server.address().port}` &&
    (request.headers.origin === undefined || request.headers.origin === clientOrigin);

  const serve = async (request, response) => {
    if (!allowed(request)) {
      return json(response, 403, { message: "Unexpected host or origin" });
    }
    response.setHeader("Access-Control-Allow-Origin", clientOrigin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Credentials", "true");
    if (request.method === "OPTIONS") {
      response
        .writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "authorization, b3, content-type, traceparent, x-t3-orchestration-protocol",
          "Access-Control-Allow-Private-Network": "true",
        })
        .end();
      return;
    }
    const route = `${request.method} ${request.url}`;
    if (route === `GET ${DESCRIPTOR_PATH}`) return json(response, 200, descriptor);
    if (route === `POST ${EXCHANGE_PATH}`) {
      const form = await exchangeForm(request);
      if (
        expiresAt ||
        form.get("subject_token") !== pairingCode ||
        form.get("grant_type") !== EXCHANGE_GRANT ||
        form.get("subject_token_type") !== BOOTSTRAP_TYPE ||
        form.get("requested_token_type") !== ACCESS_TYPE ||
        form.has("scope") ||
        request.headers.dpop !== undefined
      ) {
        return json(response, 401, unauthorized);
      }
      expiresAt = Date.now() + 3_600_000;
      observe({ event: "pairing-exchanged" });
      return json(response, 200, {
        access_token: bearer,
        issued_token_type: ACCESS_TYPE,
        token_type: "Bearer",
        expires_in: 3600,
        scope: SCOPES.join(" "),
      });
    }
    const authenticated =
      Date.now() < expiresAt && request.headers.authorization === `Bearer ${bearer}`;
    if (route === "GET /api/auth/session") {
      return json(response, 200, {
        authenticated,
        auth,
        ...(authenticated
          ? {
              scopes: SCOPES.slice(0, 2),
              permissions: SCOPES,
              sessionMethod: "bearer-access-token",
            }
          : {}),
      });
    }
    if (route === `POST ${TICKET_PATH}`) {
      if (!authenticated) return json(response, 401, unauthorized);
      const now = Date.now();
      for (const [ticket, expiry] of tickets) {
        if (expiry <= now) tickets.delete(ticket);
      }
      const ticket = NodeCrypto.randomBytes(32).toString("base64url");
      const expiry = now + 60_000;
      tickets.set(ticket, expiry);
      return json(response, 200, { ticket, expiresAt: new Date(expiry).toISOString() });
    }
    return json(response, 404, { message: "Route outside the fixture" });
  };

  const server = NodeHttp.createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) json(response, 400, { message: "Invalid fixture request" });
      else response.destroy();
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!allowed(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const url = URL.parse(request.url, `http://${HOST}`);
    if (url?.pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const ticket = url.searchParams.get("wsTicket");
    if (
      url.searchParams.has("orchestrationProtocol") ||
      request.headers["x-t3-orchestration-protocol"] !== undefined ||
      (tickets.get(ticket) ?? 0) <= Date.now()
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    tickets.delete(ticket);
    sockets.handleUpgrade(request, socket, head, (ws) => {
      observe({ event: "authenticated-bare-update-socket" });
      ws.on("error", () => ws.terminate());
      ws.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          ws.close(1008);
          return;
        }
        if (message?._tag === "Ping") {
          ws.send(JSON.stringify({ _tag: "Pong" }));
          return;
        }
        const requestId = message?.id;
        if (
          message?._tag !== "Request" ||
          message.tag !== UPDATE_METHOD ||
          (typeof requestId !== "string" && !(Number.isSafeInteger(requestId) && requestId >= 0)) ||
          message.payload?.targetVersion !== TARGET_VERSION
        ) {
          observe({
            event: "unexpected-update-frame",
            requestIdType: typeof requestId,
          });
          ws.close(1008);
          return;
        }
        observe({
          event: "simulated-update-refused",
          method: UPDATE_METHOD,
          targetVersion: TARGET_VERSION,
        });
        ws.send(
          JSON.stringify({
            _tag: "Exit",
            requestId,
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Fail", error: { _tag: "ServerSelfUpdateError", reason: REFUSAL } }],
            },
          }),
        );
      });
    });
  });
  server.listen(port, HOST);
  await NodeEvents.once(server, "listening");
  return {
    origin: `http://${HOST}:${server.address().port}`,
    close: () => {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const [clientOrigin, codeFile, port = "0", ...extra] = process.argv.slice(2);
    if (!clientOrigin || !codeFile || extra.length) {
      throw new Error("Expected a client origin, code file, and optional port");
    }
    const observe = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
    const fixture = await startFixture({
      clientOrigin,
      pairingCode: (await NodeFSP.readFile(codeFile, "utf8")).trim(),
      observe,
      port: Number(port),
    });
    observe({ event: "simulated-protocol-1-boot-service", origin: fixture.origin });
    process.once("SIGINT", () => void fixture.close());
    process.once("SIGTERM", () => void fixture.close());
  } catch {
    process.stderr.write(
      "Usage: node fixture.mjs <sail://app or loopback HTTP browser origin> <pairing code file> [port]\n",
    );
    process.exitCode = 1;
  }
}

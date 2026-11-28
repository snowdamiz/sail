import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { startFixture } from "./fixture.mjs";

NodeTest.test("a paired client can reach only the simulated update branch", async (t) => {
  const pairingCode = "PQRSTUVWXYZ2";
  const clientOrigin = "sail://app";
  const events = [];
  const fixture = await startFixture({
    clientOrigin,
    pairingCode,
    observe: (event) => events.push(event),
  });
  t.after(fixture.close);
  const request = (path, init) => fetch(fixture.origin + path, init);
  const descriptorPath = "/.well-known/t3/environment";
  const ticketPath = "/api/auth/websocket-ticket/rpc";
  const socketUrl = new URL("/ws", fixture.origin.replace("http:", "ws:"));

  const descriptorResponse = await request(descriptorPath, { headers: { Origin: clientOrigin } });
  NodeAssert.equal(descriptorResponse.status, 200);
  NodeAssert.equal(descriptorResponse.headers.get("access-control-allow-origin"), clientOrigin);
  const descriptor = await descriptorResponse.json();
  NodeAssert.equal(descriptor.orchestrationProtocolVersion, 1);
  NodeAssert.equal(descriptor.capabilities.serverSelfUpdate, "boot-service");
  NodeAssert.match(descriptor.label, /simulated/);
  const disallowed = await request(descriptorPath, { headers: { Origin: "https://example.test" } });
  NodeAssert.equal(disallowed.status, 403);
  NodeAssert.equal(disallowed.headers.has("access-control-allow-origin"), false);

  const exchange = (credential) =>
    request("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: credential,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    });
  NodeAssert.equal((await exchange("wrong")).status, 401);
  NodeAssert.equal((await request(ticketPath, { method: "POST" })).status, 401);
  const exchangeResponse = await exchange(pairingCode);
  NodeAssert.equal(exchangeResponse.status, 200);
  const session = await exchangeResponse.json();
  NodeAssert.equal(session.token_type, "Bearer");
  NodeAssert.equal((await exchange(pairingCode)).status, 401);
  const headers = { Authorization: `Bearer ${session.access_token}` };
  const state = await request("/api/auth/session", { headers }).then((response) => response.json());
  NodeAssert.equal(state.authenticated, true);
  NodeAssert.ok(state.permissions.includes("environment:maintain"));
  const ticketResponse = await request(ticketPath, { method: "POST", headers });
  NodeAssert.equal(ticketResponse.status, 200);
  const { ticket } = await ticketResponse.json();

  function open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      // The default WebSocket error can include the ticket-bearing URL.
      socket.addEventListener("error", () => reject(new Error("Fixture handshake rejected")), {
        once: true,
      });
    });
  }

  await NodeAssert.rejects(open(socketUrl), /handshake rejected/);
  socketUrl.searchParams.set("wsTicket", ticket);
  socketUrl.searchParams.set("orchestrationProtocol", "2");
  await NodeAssert.rejects(open(socketUrl), /handshake rejected/);
  NodeAssert.deepEqual(events, [{ event: "pairing-exchanged" }]);

  socketUrl.searchParams.delete("orchestrationProtocol");
  const socket = await open(socketUrl);
  t.after(() => socket.close());
  await NodeAssert.rejects(open(socketUrl), /handshake rejected/);
  const reply = new Promise((resolve) => {
    socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
  });
  socket.send(
    JSON.stringify({
      _tag: "Request",
      id: 1,
      tag: "server.updateServer",
      payload: { targetVersion: "0.1.17" },
      headers: [],
    }),
  );
  const result = await reply;
  NodeAssert.equal(result.requestId, 1);
  NodeAssert.equal(result.exit._tag, "Failure");
  NodeAssert.equal(result.exit.cause[0].error._tag, "ServerSelfUpdateError");
  NodeAssert.match(result.exit.cause[0].error.reason, /does not install updates/);
  NodeAssert.deepEqual(events, [
    { event: "pairing-exchanged" },
    { event: "authenticated-bare-update-socket" },
    { event: "simulated-update-refused", method: "server.updateServer", targetVersion: "0.1.17" },
  ]);
  NodeAssert.equal(
    (await request(descriptorPath).then((response) => response.json()))
      .orchestrationProtocolVersion,
    1,
  );
});

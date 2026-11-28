import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeFS from "node:fs";
const [backendPortText, databasePath] = process.argv.slice(2);
const backendPort = Number(backendPortText);
NodeAssert.ok(Number.isInteger(backendPort) && backendPort > 0 && backendPort <= 65535);
NodeAssert.ok(databasePath, "Pass the path to the isolated fixture database");
const fixture = JSON.parse(
  NodeFS.readFileSync(new URL("../../wire/incumbent-replay-v2.json", import.meta.url), "utf8"),
);
const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
const sockets = new Set();
let cut = null;
const runQuery = db.prepare(
  "select run_id,status from orchestration_v2_projection_runs where thread_id=?",
);
const messages = db.prepare(
  "select role,payload_json from orchestration_v2_projection_messages where thread_id=? order by created_at,message_id",
);
function record(threadId) {
  const rows = messages.all(threadId);
  return rows.map((row) => {
    const entry = JSON.parse(row.payload_json);
    return { role: row.role, text: entry.text, streaming: entry.streaming };
  });
}
function result(res, status, payload) {
  if (res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}
async function control(req, res, url) {
  const thread = url.searchParams.get("thread");
  NodeAssert.match(thread, /^latency-[0-9]{2}$/);
  const origin = "http://127.0.0.1:" + server.address().port;
  NodeAssert.equal(req.headers.origin, origin);
  if (url.pathname === "/__sail_latency/cut") {
    NodeAssert.equal(cut, null);
    const runs = runQuery.all(thread);
    NodeAssert.equal(runs.length, 1);
    NodeAssert.equal(runs[0].status, "running");
    const before = record(thread);
    NodeAssert.ok(
      before
        .filter((message) => message.role === "assistant")
        .some((message) => message.text.length > 0),
    );
    NodeAssert.ok(
      !before.some((message) => message.text === fixture.expected.messages.at(-1).text),
    );
    NodeAssert.ok(sockets.size > 0);
    cut = {
      thread,
      runId: runs[0].run_id,
      blockedAttempts: 0,
      openSockets: sockets.size,
      settled: false,
    };
    for (const client of sockets) client.destroy();
    return result(res, 200, { openSockets: cut.openSockets, before });
  }
  NodeAssert.ok(cut?.thread === thread);
  if (url.pathname === "/__sail_latency/wait") {
    const active = cut;
    for (let attempt = 0; attempt < 400 && !res.destroyed; attempt++) {
      const runs = runQuery.all(thread);
      NodeAssert.equal(runs.length, 1);
      NodeAssert.equal(runs[0].run_id, active.runId);
      if (runs[0].status === "completed") {
        const settled = record(thread);
        NodeAssert.deepEqual(settled, fixture.expected.messages);
        active.settled = true;
        return result(res, 200, {
          runCount: runs.length,
          settled,
          blockedAttempts: active.blockedAttempts,
        });
      }
      await NodeTimersPromises.setTimeout(25);
    }
    throw Error("Replay did not complete while disconnected");
  }
  NodeAssert.equal(url.pathname, "/__sail_latency/restore");
  NodeAssert.ok(cut.settled, "Check the complete transcript before restoring the connection");
  const observations = { blockedAttempts: cut.blockedAttempts };
  cut = null;
  return result(res, 200, observations);
}
const server = NodeHttp.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/__sail_latency/")) {
    if (req.method !== "POST") return result(res, 405, {});
    control(req, res, url).catch((error) => {
      process.stderr.write(error.message + "\n");
      result(res, 500, { error: error.message });
    });
    return;
  }
  const forwarded = NodeHttp.request(
    {
      host: "127.0.0.1",
      port: backendPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    },
  );
  forwarded.on("error", () => result(res, 503, {}));
  req.pipe(forwarded);
  res.on("close", () => forwarded.destroy());
});
server.on("upgrade", (req, client, head) => {
  if (new URL(req.url, "http://127.0.0.1").pathname !== "/ws") {
    client.destroy();
    return;
  }
  if (cut) {
    cut.blockedAttempts++;
    client.end(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    return;
  }
  const target = NodeNet.connect(backendPort, "127.0.0.1");
  sockets.add(client);
  const close = () => {
    sockets.delete(client);
    client.destroy();
    target.destroy();
  };
  client.on("error", close);
  client.on("close", close);
  target.on("error", close);
  target.on("close", close);
  target.once("connect", () => {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      headers.push(req.rawHeaders[i] + ": " + req.rawHeaders[i + 1]);
    target.write(req.method + " " + req.url + " HTTP/1.1\r\n" + headers.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) target.write(head);
    client.pipe(target);
    target.pipe(client);
  });
});
server.listen(0, "127.0.0.1", () =>
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"),
);

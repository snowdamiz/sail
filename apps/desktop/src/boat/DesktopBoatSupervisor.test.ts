// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off - Test fixture spawns a mock sail-boatd executable via SAIL_BOATD_PATH.
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWebLinks from "../app/DesktopWebLinks.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { BOAT_STATE_CHANNEL, BOAT_STATUS_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  DesktopBoatSupervisor,
  isSailInternalUrl,
  layer as DesktopBoatSupervisorLayer,
  parseBoatHandshakeLine,
  parseSseFrame,
  resolveBoatDaemonBinary,
} from "./DesktopBoatSupervisor.ts";

it("parses valid sail-boatd stdout handshake lines and ignores noise", () => {
  assert.deepEqual(
    parseBoatHandshakeLine('{"ready":true,"port":48123,"token":"abc123","mcpPort":47731}'),
    {
      ready: true,
      port: 48123,
      token: "abc123",
      mcpPort: 47731,
    },
  );
  assert.isNull(parseBoatHandshakeLine("2026-11-24 INFO starting"));
  assert.isNull(parseBoatHandshakeLine('{"ready":false,"port":48123,"token":"a","mcpPort":1}'));
  assert.isNull(parseBoatHandshakeLine('{"ready":true,"port":0,"token":"a","mcpPort":1}'));
  assert.isNull(parseBoatHandshakeLine('{"ready":true,"port":48123,"token":"","mcpPort":1}'));
});

it("parses SSE event frames including multiline data and ignores comments", () => {
  assert.deepEqual(parseSseFrame(': keepalive\nevent: state\ndata: {"machines":[]}'), {
    event: "state",
    data: '{"machines":[]}',
  });
  assert.deepEqual(parseSseFrame("data: line1\ndata: line2"), {
    event: "message",
    data: "line1\nline2",
  });
  assert.isNull(parseSseFrame(": ping only"));
});

it("classifies internal sail/t3code URLs vs external URLs", () => {
  assert.isTrue(isSailInternalUrl("sail://pair?token=123"));
  assert.isTrue(isSailInternalUrl("sail-dev://open?path=/tmp"));
  assert.isTrue(isSailInternalUrl("t3code://pair?token=123"));
  assert.isTrue(isSailInternalUrl("t3code-dev://open"));
  assert.isFalse(isSailInternalUrl("https://fly.io/dashboard"));
  assert.isFalse(isSailInternalUrl("not a url"));
});

it("resolves sail-boatd binary preferring explicit env override then packaged resources", () => {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sail-boat-bin-test-"));
  try {
    const resourcesDir = NodePath.join(tmpDir, "resources");
    const packagedBin = NodePath.join(resourcesDir, "sail-boat", "sail-boatd");
    const overrideBin = NodePath.join(tmpDir, "custom-sail-boatd");
    NodeFS.mkdirSync(NodePath.dirname(packagedBin), { recursive: true });
    NodeFS.writeFileSync(packagedBin, "#!/bin/sh\n");
    NodeFS.writeFileSync(overrideBin, "#!/bin/sh\n");

    assert.equal(
      resolveBoatDaemonBinary({
        envPath: overrideBin,
        isPackaged: true,
        resourcesPath: resourcesDir,
        dirname: tmpDir,
        platform: "darwin",
      }),
      overrideBin,
    );
    assert.equal(
      resolveBoatDaemonBinary({
        isPackaged: true,
        resourcesPath: resourcesDir,
        dirname: tmpDir,
        platform: "darwin",
      }),
      packagedBin,
    );
  } finally {
    NodeFS.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it.live(
  "supervises a mock sail-boatd process, proxies commands, and routes SSE desktop actions",
  () =>
    Effect.gen(function* () {
      const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sail-boat-supervisor-"));
      const scriptPath = NodePath.join(tmpDir, "mock-sail-boatd");
      const prevBin = process.env.SAIL_BOATD_PATH;

      NodeFS.writeFileSync(
        scriptPath,
        `#!${process.execPath}
const http = require("node:http");
const token = "test-secret-token";
let sseRes = null;
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + token) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  if (req.method === "GET" && req.url === "/api/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ setup: { ready: true }, machines: [], costs: { today: 0 }, sailHome: process.env.SAIL_HOME }));
    return;
  }
  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sseRes = res;
    res.write('event: state\\ndata: {"setup":{"ready":true},"machines":[]}\\n\\n');
    res.write('event: desktop_action\\ndata: {"type":"openUrl","url":"sail://pair?token=xyz"}\\n\\n');
    res.write('event: desktop_action\\ndata: {"type":"openUrl","url":"https://fly.io/auth"}\\n\\n');
    res.write('event: desktop_action\\ndata: {"type":"activate"}\\n\\n');
    return;
  }
  if (req.method === "POST" && req.url === "/api/command/ping") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { echo: JSON.parse(body || "{}") } }));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/command/shutdown") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    if (sseRes) sseRes.end();
    server.close(() => process.exit(0));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(JSON.stringify({ ready: true, port: addr.port, token, mcpPort: 47731 }) + "\\n");
});
`,
        { mode: 0o755 },
      );

      const sentEvents: Array<{ channel: string; payload: unknown }> = [];
      const webLinksReceived: string[] = [];
      const externalOpened: string[] = [];
      let activatedCount = 0;
      const sseActivated = yield* Deferred.make<void>();

      process.env.SAIL_BOATD_PATH = scriptPath;
      try {
        yield* Effect.gen(function* () {
          const supervisor = yield* DesktopBoatSupervisor;
          yield* supervisor.start;

          const status = yield* supervisor.getStatus;
          assert.equal(status.phase, "ready", status.error ?? undefined);
          assert.equal(status.mcpPort, 47731);
          assert.isNotNull(status.baseUrl);

          const state = (yield* supervisor.invoke("get_state")) as {
            setup: { ready: boolean };
            machines: unknown[];
            sailHome: string;
          };
          assert.equal(state.setup.ready, true);
          assert.equal(state.sailHome, tmpDir);

          const ping = (yield* supervisor.invoke("ping", { hello: "sail" })) as {
            echo: { hello: string };
          };
          assert.deepEqual(ping, { echo: { hello: "sail" } });

          yield* Deferred.await(sseActivated);

          assert.include(webLinksReceived, "sail://pair?token=xyz");
          assert.include(externalOpened, "https://fly.io/auth");
          assert.isAtLeast(activatedCount, 1);
          assert.isTrue(sentEvents.some((e) => e.channel === BOAT_STATUS_CHANNEL));
          assert.isTrue(sentEvents.some((e) => e.channel === BOAT_STATE_CHANNEL));

          yield* supervisor.stop;
          const stoppedStatus = yield* supervisor.getStatus;
          assert.equal(stoppedStatus.phase, "stopped");
        }).pipe(
          Effect.provide(DesktopBoatSupervisorLayer),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            platform: "darwin",
            isPackaged: false,
            isDevelopment: true,
            resourcesPath: tmpDir,
            dirname: tmpDir,
            stateDir: NodePath.join(tmpDir, "userdata"),
            baseDir: tmpDir,
            path: NodePath,
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
          Effect.provideService(ElectronWindow.ElectronWindow, {
            currentMainOrFirst: Effect.succeedSome({
              webContents: {
                isDestroyed: () => false,
                send: (channel: string, payload: unknown) => {
                  sentEvents.push({ channel, payload });
                },
              },
            }),
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
          Effect.provideService(DesktopWindow.DesktopWindow, {
            activate: Effect.sync(() => {
              activatedCount += 1;
            }).pipe(Effect.andThen(Deferred.succeed(sseActivated, undefined))),
          } as unknown as DesktopWindow.DesktopWindow["Service"]),
          Effect.provideService(DesktopWebLinks.DesktopWebLinks, {
            receive: (url: string) =>
              Effect.sync(() => {
                webLinksReceived.push(url);
              }),
          } as unknown as DesktopWebLinks.DesktopWebLinks["Service"]),
          Effect.provideService(ElectronShell.ElectronShell, {
            openExternal: (url: string) =>
              Effect.sync(() => {
                externalOpened.push(url);
              }),
          } as unknown as ElectronShell.ElectronShell["Service"]),
        );
      } finally {
        if (prevBin === undefined) {
          delete process.env.SAIL_BOATD_PATH;
        } else {
          process.env.SAIL_BOATD_PATH = prevBin;
        }
        NodeFS.rmSync(tmpDir, { recursive: true, force: true });
      }
    }),
);

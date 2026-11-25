// @effect-diagnostics nodeBuiltinImport:off -- Runs the real CLI server and finds it a free port.
// @effect-diagnostics globalFetch:off -- The requests run inside the browser page, with its cookie jar.
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { chromium } from "playwright-core";

const freePort = Effect.promise(
  () =>
    new Promise<number>((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          typeof address === "object" && address !== null
            ? resolve(address.port)
            : reject(new Error("no port")),
        );
      });
    }),
);

const servePairingUrl = Effect.fn("browserPairing.servePairingUrl")(function* (
  home: string,
  port: number,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { cwd: home, env: { HOME: home, SAIL_HOME: home, T3CODE_HOME: undefined } },
    ),
  );
  const pairingUrl = yield* Deferred.make<string>();
  // Both pipes stay drained: a full one would block the server's writes.
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      line.startsWith("Pairing URL: ")
        ? Deferred.succeed(pairingUrl, line.slice("Pairing URL: ".length))
        : Effect.void,
    ),
    Effect.forkScoped,
  );
  yield* child.stderr.pipe(Stream.runDrain, Effect.forkScoped);
  return yield* Effect.raceFirst(
    Deferred.await(pairingUrl),
    child.exitCode.pipe(
      Effect.flatMap((code) => Effect.die(new Error(`t3 serve exited with ${String(code)}`))),
    ),
  );
});

it.live("a browser carrying other servers' cookies for this host still pairs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-pairing-" }));
    const pairingUrl = new URL(yield* servePairingUrl(home, yield* freePort));
    const credential = new URLSearchParams(pairingUrl.hash.slice(1)).get("token");
    assert(credential !== null);

    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ headless: true })),
      (browser) => Effect.promise(() => browser.close()),
    );
    const context = yield* Effect.promise(() => browser.newContext());
    const page = yield* Effect.promise(() => context.newPage());
    yield* Effect.promise(() => page.goto(`${pairingUrl.origin}/.well-known/t3/environment`));
    yield* Effect.promise(() =>
      context.addCookies(
        Array.from({ length: 150 }, (_, index) => ({
          name: `t3_session_${String(40_000 + index)}_0123456789ab`,
          value: "s".repeat(680),
          url: pairingUrl.origin,
          httpOnly: true,
          sameSite: "Lax" as const,
        })),
      ),
    );
    const result = yield* Effect.promise(() =>
      page.evaluate(async (token) => {
        const exchange = await fetch("/api/auth/browser-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential: token }),
        }).catch(() => undefined);
        const session = await fetch("/api/auth/session").catch(() => undefined);
        return {
          exchangeStatus: exchange?.status,
          sessionStatus: session?.status,
          authenticated:
            session?.ok === true &&
            ((await session.json()) as { authenticated?: unknown }).authenticated === true,
        };
      }, credential),
    );
    assert.deepStrictEqual(result, {
      exchangeStatus: 200,
      sessionStatus: 200,
      authenticated: true,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

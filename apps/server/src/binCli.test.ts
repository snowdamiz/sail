// @effect-diagnostics nodeBuiltinImport:off -- Exercises the CLI's real stdout and stderr through a subprocess and an HTTP fixture.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

import { migrationManifest, runMigrations } from "./persistence/Migrations.ts";
import { holdServerOwnershipLock } from "./serverOwnership.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";

const runCli = (
  args: ReadonlyArray<string>,
  options: { readonly home: string; readonly env?: Record<string, string> },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)), ...args],
        {
          cwd: options.home,
          env: {
            HOME: options.home,
            SAIL_HOME: options.home,
            T3CODE_HOME: undefined,
            ...options.env,
          },
        },
      ),
    );
    return yield* Effect.all(
      {
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        exitCode: child.exitCode.pipe(Effect.map(Number)),
      },
      { concurrency: "unbounded" },
    );
  });

const TEST_ENVIRONMENT_ID = "bin-cli-test-environment";
const PUBLIC_URL = new URL("https://demo.fly.dev");

interface ServerRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
}

const listen = (server: NodeHttp.Server) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address !== null && typeof address !== "string");
      return address.port;
    }),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

const closedPort = Effect.scoped(listen(NodeHttp.createServer()));

const makeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-home-" }));
  yield* fs.makeDirectory(`${home}/userdata`);
  return home;
});

const recordServer = (
  home: string,
  input: {
    readonly port: number;
    readonly publicUrl?: URL;
    readonly ownerId?: string;
    readonly pid?: number;
    readonly startedAt?: string;
  },
) =>
  Effect.gen(function* () {
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined, publicUrl: input.publicUrl },
      port: input.port,
    });
    yield* persistServerRuntimeState({
      path: `${home}/userdata/server-runtime.json`,
      state: {
        ...state,
        ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
        ...(input.pid === undefined ? {} : { pid: input.pid }),
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      },
    });
  });

const withRunningServerHome = <A, E, R>(
  run: (
    home: string,
    requests: ReadonlyArray<ServerRequest>,
    port: number,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const home = yield* makeHome;
    const requests: Array<ServerRequest> = [];
    const port = yield* listen(
      NodeHttp.createServer((request, response) => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            environmentId: TEST_ENVIRONMENT_ID,
            label: "bin-cli-test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.1",
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            capabilities: { repositoryIdentity: true },
          }),
        );
      }),
    );
    yield* (yield* FileSystem.FileSystem).writeFileString(
      `${home}/userdata/environment-id`,
      `${TEST_ENVIRONMENT_ID}\n`,
    );
    yield* recordServer(home, { port, publicUrl: PUBLIC_URL });
    return yield* run(home, requests, port);
  });

const migrateDatabase = (home: string) => runCli(["auth", "pairing", "list", "--json"], { home });

const listPairingLinkIds = (home: string) =>
  runCli(["auth", "pairing", "list", "--json"], { home }).pipe(
    Effect.map(({ stdout, stderr, exitCode }) => {
      assert.strictEqual(exitCode, 0, stderr);
      return (JSON.parse(stdout) as ReadonlyArray<{ readonly id: string }>).map(({ id }) => id);
    }),
  );

const withOwnedServerHome = <A, E, R>(
  run: (home: string, requests: ReadonlyArray<ServerRequest>) => Effect.Effect<A, E, R>,
) =>
  withRunningServerHome((home, requests, port) =>
    Effect.gen(function* () {
      yield* migrateDatabase(home);
      yield* holdServerOwnershipLock(`${home}/userdata/server-runtime.json`);
      yield* recordServer(home, { port, publicUrl: PUBLIC_URL, ownerId: "running-server" });
      return yield* run(home, requests);
    }),
  );

it.live("keeps migration warnings out of JSON thread output", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-json-" });
    const stateDir = `${root}/userdata`;
    yield* fs.makeDirectory(stateDir);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const futureId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${futureId}, 'FutureMigration')
      `;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: `${stateDir}/statev2.sqlite` })));

    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = NodeHttp.createServer(async (request, response) => {
          let body = "";
          for await (const chunk of request) body += String(chunk);
          if (request.method === "DELETE") {
            response.writeHead(204).end();
            return;
          }
          const message = JSON.parse(body) as {
            id?: string;
            method: string;
            params?: { name: string };
          };
          if (message.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          const result =
            message.method === "initialize"
              ? { protocolVersion: "2025-06-18" }
              : {
                  structuredContent:
                    message.params?.name === "t3_project_list"
                      ? {
                          projects: [{ id: "project-1", title: "Test", workspaceRoot: root }],
                          nextCursor: null,
                        }
                      : {
                          projectId: "project-1",
                          currentThreadId: null,
                          threads: [],
                          nextCursor: null,
                          total: 0,
                        },
                };
          response.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "cli-json-test",
          });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        return server;
      }),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    yield* persistServerRuntimeState({
      path: `${stateDir}/server-runtime.json`,
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: address.port,
      }),
    });

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
          "thread",
          "list",
          "--project",
          "project-1",
          "--json",
          "--base-dir",
          root,
        ],
        { env: { T3CODE_HOME: root } },
      ),
    );
    const { stdout, stderr, exitCode } = yield* Effect.all(
      {
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        exitCode: child.exitCode,
      },
      { concurrency: "unbounded" },
    );
    assert.strictEqual(Number(exitCode), 0, stderr);
    assert.deepStrictEqual(JSON.parse(stdout), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("pair finds the server through SAIL_HOME and links to its public URL", () =>
  withRunningServerHome((home) =>
    Effect.gen(function* () {
      const { stdout, stderr, exitCode } = yield* runCli(["pair"], { home });
      assert.strictEqual(exitCode, 0, stderr);
      assert.match(stdout, /Pairing URL: https:\/\/demo\.fly\.dev\/pair#token=/);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("pairing create links to the running server's public URL", () =>
  withRunningServerHome((home) =>
    Effect.gen(function* () {
      const { stdout, stderr, exitCode } = yield* runCli(["auth", "pairing", "create", "--json"], {
        home,
      });
      assert.strictEqual(exitCode, 0, stderr);
      assert.match(JSON.parse(stdout).pairUrl, /^https:\/\/demo\.fly\.dev\/pair#token=/);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const assertExpiresIn = (expiresAt: string, ttlMs: number) =>
  DateTime.now.pipe(
    Effect.map((now) =>
      assert.isBelow(
        Math.abs(Date.parse(expiresAt) - DateTime.toEpochMillis(now) - ttlMs),
        60_000,
        expiresAt,
      ),
    ),
  );

it.live(
  "pairing create --require-running mints in this home while its server holds the lock, and sends the server nothing",
  () =>
    withOwnedServerHome((home, requests) =>
      Effect.gen(function* () {
        const create = (ttl: string) =>
          runCli(
            [
              "auth",
              "pairing",
              "create",
              "--json",
              "--require-running",
              "--scope",
              "orchestration:read",
              "--ttl",
              ttl,
            ],
            { home },
          );
        const hour = yield* create("1h");
        assert.strictEqual(hour.exitCode, 0, hour.stdout + hour.stderr);
        const minted = JSON.parse(hour.stdout);
        assert.match(minted.pairUrl, /^https:\/\/demo\.fly\.dev\/pair#token=\S+$/);
        assert.deepStrictEqual(minted.scopes, ["orchestration:read"]);
        yield* assertExpiresIn(minted.expiresAt, 60 * 60_000);
        const year = yield* create("400d");
        assert.strictEqual(year.exitCode, 0, year.stdout + year.stderr);
        const longLived = JSON.parse(year.stdout);
        yield* assertExpiresIn(longLived.expiresAt, 400 * 24 * 60 * 60_000);

        const instant = yield* create("0s");
        assert.notStrictEqual(instant.exitCode, 0);
        assert.strictEqual(instant.stdout, "");
        assert.match(instant.stderr, /--ttl must be longer than 0, so no pairing token was minted/);

        assert.sameMembers(yield* listPairingLinkIds(home), [minted.id, longLived.id]);
        assert.deepStrictEqual(requests, []);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const expectNothingMinted = (home: string, env?: Record<string, string>) =>
  Effect.gen(function* () {
    const refused = yield* runCli(["auth", "pairing", "create", "--json", "--require-running"], {
      home,
      ...(env === undefined ? {} : { env }),
    });
    assert.notStrictEqual(refused.exitCode, 0, refused.stdout);
    assert.strictEqual(refused.stdout, "");
    assert.match(refused.stderr, /no pairing token was minted/);
    assert.deepStrictEqual(yield* listPairingLinkIds(home), []);
    return refused.stderr;
  });

it.live("pairing create --require-running mints nothing when no server runs", () =>
  Effect.gen(function* () {
    const stderr = yield* expectNothingMinted(yield* makeHome);
    assert.match(stderr, /No running T3 Code server/);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "pairing create --require-running mints nothing once the recorded server lets go of the lock",
  () =>
    withRunningServerHome((home, requests, port) =>
      Effect.gen(function* () {
        yield* migrateDatabase(home);
        yield* recordServer(home, { port, publicUrl: PUBLIC_URL, ownerId: "stopped-server" });
        const stderr = yield* expectNothingMinted(home);
        assert.match(stderr, /No running T3 Code server owns/);
        assert.deepStrictEqual(requests, []);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "pairing create --require-running refuses a record from a server without the ownership lock",
  () =>
    withRunningServerHome((home, requests, port) =>
      Effect.gen(function* () {
        yield* migrateDatabase(home);
        for (const { route, pid, startedAt, env } of [
          {
            route: "PID 1, alive to kill(0) as EPERM",
            pid: 1,
            startedAt: DateTime.formatIso(yield* DateTime.now),
          },
          { route: "unreadable start time", pid: process.pid, startedAt: "not-a-valid-timestamp" },
          {
            route: "no ps to read the PID's start time",
            pid: process.pid,
            startedAt: "2020-01-01T00:00:00.000Z",
            env: { PATH: "/nonexistent" },
          },
        ]) {
          yield* recordServer(home, { port, publicUrl: PUBLIC_URL, pid, startedAt });
          const stderr = yield* expectNothingMinted(home, env);
          assert.match(stderr, /without the ownership lock/, route);
        }
        assert.deepStrictEqual(requests, []);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "pairing create --require-running reports a server still updating its database on stderr",
  () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      yield* holdServerOwnershipLock(`${home}/userdata/server-runtime.json`);
      yield* recordServer(home, { port: yield* closedPort, ownerId: "migrating-server" });
      const refused = yield* runCli(["auth", "pairing", "create", "--json", "--require-running"], {
        home,
      });
      assert.notStrictEqual(refused.exitCode, 0);
      assert.strictEqual(refused.stdout, "");
      assert.match(refused.stderr, /has not finished updating its database/);
      assert.match(refused.stderr, /no pairing token was minted/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("auth and doctor ignore mistyped pairing variables they do not use", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-home-" }));
    const run = (args: ReadonlyArray<string>, env: Record<string, string>) =>
      runCli(args, { home, env });

    const pairings = yield* run(["auth", "pairing", "list", "--json"], {
      SAIL_STARTUP_PAIRING: "bogus",
    });
    assert.strictEqual(pairings.exitCode, 0, pairings.stdout + pairings.stderr);
    assert.deepStrictEqual(JSON.parse(pairings.stdout), []);
    const sessions = yield* run(["auth", "session", "list", "--json"], {
      SAIL_PUBLIC_URL: "https://demo.fly.dev/subpath",
    });
    assert.strictEqual(sessions.exitCode, 0, sessions.stdout + sessions.stderr);
    assert.isArray(JSON.parse(sessions.stdout));
    const doctor = yield* run(["doctor"], { SAIL_PUBLIC_URL: "   " });
    assert.strictEqual(doctor.exitCode, 0, doctor.stdout + doctor.stderr);
    const created = yield* run(
      ["auth", "pairing", "create", "--json", "--base-url", "https://ok.example"],
      { SAIL_PUBLIC_URL: "not-a-url" },
    );
    assert.strictEqual(created.exitCode, 0, created.stdout + created.stderr);
    assert.match(JSON.parse(created.stdout).pairUrl, /^https:\/\/ok\.example\/pair#token=/);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("serve reports a mistyped SAIL_PUBLIC_URL on stderr", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-home-" }));
    const port = String(yield* closedPort);
    const served = yield* runCli(["serve", "--host", "127.0.0.1", "--port", port], {
      home,
      env: { SAIL_PUBLIC_URL: "https://demo.fly.dev/subpath" },
    });
    assert.notStrictEqual(served.exitCode, 0);
    assert.strictEqual(served.stdout, "");
    assert.match(served.stderr, /SAIL_PUBLIC_URL/);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

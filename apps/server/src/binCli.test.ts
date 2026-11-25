// @effect-diagnostics nodeBuiltinImport:off -- Exercises the CLI's real stdout and stderr through a subprocess and an HTTP fixture.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

import { migrationManifest, runMigrations } from "./persistence/Migrations.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";

const runCli = (args: ReadonlyArray<string>, options: { readonly home: string }) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)), ...args],
        // Outside any worktree, with HOME moved, so only SAIL_HOME can name the server's home.
        {
          cwd: options.home,
          env: { HOME: options.home, SAIL_HOME: options.home, T3CODE_HOME: undefined },
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

/** A home whose runtime record names a live server, with this process standing in for it. */
const withRunningServerHome = <A, E, R>(
  publicUrl: URL | undefined,
  run: (home: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-home-" }));
    yield* fs.makeDirectory(`${home}/userdata`);
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = NodeHttp.createServer((_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              environmentId: "bin-cli-test-environment",
              label: "bin-cli-test",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.1",
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
              capabilities: { repositoryIdentity: true },
            }),
          );
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
      path: `${home}/userdata/server-runtime.json`,
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined, publicUrl },
        port: address.port,
      }),
    });
    return yield* run(home);
  });

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
  withRunningServerHome(new URL("https://demo.fly.dev"), (home) =>
    Effect.gen(function* () {
      const { stdout, stderr, exitCode } = yield* runCli(["pair"], { home });
      assert.strictEqual(exitCode, 0, stderr);
      assert.match(stdout, /Pairing URL: https:\/\/demo\.fly\.dev\/pair#token=/);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("pairing create links to the running server's public URL", () =>
  withRunningServerHome(new URL("https://demo.fly.dev"), (home) =>
    Effect.gen(function* () {
      const { stdout, stderr, exitCode } = yield* runCli(
        ["auth", "pairing", "create", "--json", "--require-running"],
        { home },
      );
      assert.strictEqual(exitCode, 0, stderr);
      assert.match(JSON.parse(stdout).pairUrl, /^https:\/\/demo\.fly\.dev\/pair#token=/);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("pairing create --require-running mints nothing when no server runs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-home-" }));
    const refused = yield* runCli(["auth", "pairing", "create", "--json", "--require-running"], {
      home,
    });
    assert.notStrictEqual(refused.exitCode, 0);
    assert.strictEqual(refused.stdout, "");
    assert.match(refused.stderr, /No running T3 Code server/);
    const listed = yield* runCli(["auth", "pairing", "list", "--json"], { home });
    assert.strictEqual(listed.exitCode, 0, listed.stderr);
    assert.deepStrictEqual(JSON.parse(listed.stdout), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

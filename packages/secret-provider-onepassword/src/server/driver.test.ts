// @effect-diagnostics nodeBuiltinImport:off -- the fake `op` reads the template the driver wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";

import { OnePasswordAccount } from "../shared/definition.ts";
import { driver } from "./driver.ts";

const encoder = new TextEncoder();
const account = OnePasswordAccount.make("my.1password.com");

type OpResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
  readonly delay?: Duration.Input;
};

function fakeOp(
  answer: (
    args: ReadonlyArray<string>,
    options: { readonly env?: Readonly<Record<string, string>>; readonly extendEnv?: boolean },
  ) => OpResult,
) {
  const invocations: Array<ReadonlyArray<string>> = [];
  const envs: Array<Readonly<Record<string, string>> | undefined> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const { args, options } = command as unknown as {
            readonly args: ReadonlyArray<string>;
            readonly options?: {
              readonly env?: Readonly<Record<string, string>>;
              readonly extendEnv?: boolean;
            };
          };
          invocations.push(args);
          envs.push(options?.env);
          Deferred.doneUnsafe(spawned, Effect.void);
          const result = answer(args, options ?? {});
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: result.hang
              ? Effect.never
              : Effect.sleep(result.delay ?? 0).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(result.code ?? 0)),
                ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(result.stdout ?? "")),
            stderr: Stream.make(encoder.encode(result.stderr ?? "")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    NodeFileSystem.layer,
    NodeCrypto.layer,
  );
  return { layer, invocations, envs, spawned };
}

// Answers `op inject` by substituting each `{{ reference }}` in the template file it was handed.
const injectFrom =
  (secrets: Readonly<Record<string, string>>) =>
  (args: ReadonlyArray<string>): OpResult => {
    const template = NodeFS.readFileSync(args[args.indexOf("-i") + 1]!, "utf8");
    return { stdout: template.replace(/\{\{ (\S+) \}\}/g, (_, reference) => secrets[reference]!) };
  };

describe("1Password driver", () => {
  it.effect("creates an explicitly supplied item from an owner-only temporary template", () => {
    let path: string | undefined;
    const fixture = fakeOp((args) => {
      path = args.find((arg) => arg.startsWith("--template="))?.slice("--template=".length);
      if (path === undefined) throw new Error("Expected template");
      assert.equal(NodeFS.statSync(path).mode & 0o777, 0o600);
      assert.deepInclude(JSON.parse(NodeFS.readFileSync(path, "utf8")), {
        category: "PASSWORD",
        title: "Test key",
      });
      assert.equal(
        JSON.parse(NodeFS.readFileSync(path, "utf8")).fields[0].value,
        "synthetic-value",
      );
      assert.isFalse(args.some((arg) => arg.includes("synthetic-value")));
      return {
        stdout: JSON.stringify({
          id: "item-id",
          vault: { id: "vault-id" },
          fields: [{ value: "synthetic-value" }],
        }),
      };
    });
    return Effect.gen(function* () {
      if (!driver.saveItem) throw new Error("Expected an item writer");
      const reference = yield* driver.saveItem(
        { account },
        { vault: "Test vault", label: "Test key", value: "synthetic-value" },
      );
      assert.equal(reference, "op://vault-id/item-id/password");
      assert.isDefined(path);
      assert.isFalse(path !== undefined && NodeFS.existsSync(path));
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("reads one reference from the account", () => {
    const op = fakeOp(() => ({ stdout: "sk-live" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        "sk-live",
      ]);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "read",
          "--account=my.1password.com",
          "--no-newline",
          "op://Private/OpenAI/credential",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads a failed reference as undefined", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "[ERROR] account is locked" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        undefined,
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads every reference in a single call", () => {
    const op = fakeOp(
      injectFrom({
        "op://Private/OpenAI/credential": "sk-a",
        "op://Private/Anthropic/key": " sk-b\n",
      }),
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Anthropic/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", " sk-b\n"]);
      assert.strictEqual(op.invocations.length, 1);
      assert.deepStrictEqual(op.invocations[0]?.slice(0, 3), [
        "--cache=false",
        "inject",
        "--account=my.1password.com",
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("falls back to one read at a time when the batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, stderr: '[ERROR] could not resolve "op://Private/Gone/key"' }
        : args.at(-1) === "op://Private/Gone/key"
          ? { code: 1, stderr: "[ERROR] item not found" }
          : { stdout: "sk-a" },
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Gone/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", undefined]);
      assert.strictEqual(op.invocations.length, 3);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("does not read one at a time after the batch times out", () => {
    const op = fakeOp(() => ({ hang: true }));
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.forkChild);
      yield* Deferred.await(op.spawned);
      yield* TestClock.adjust("1 minute");

      assert.deepStrictEqual(yield* Fiber.join(reading), [undefined, undefined]);
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("gives up within the read timeout when a slow batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, delay: "40 seconds" }
        : { stdout: "sk-a", delay: "40 seconds" },
    );
    // Keeps the temp template off real disk I/O so the virtual clock alone drives the read.
    const templateFile = FileSystem.layerNoop({
      makeTempFileScoped: () => Effect.succeed("/template"),
      writeFileString: () => Effect.void,
    });
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.andThen(Clock.currentTimeMillis), Effect.forkChild);
      yield* TestClock.adjust("5 minutes");

      assert.isAtMost(yield* Fiber.join(reading), 45_000);
    }).pipe(Effect.provide(Layer.merge(op.layer, templateFile)));
  });

  it.effect("creates a multi-field API_CREDENTIAL item and returns per-field references", () => {
    let path: string | undefined;
    const fixture = fakeOp((args) => {
      path = args.find((arg) => arg.startsWith("--template="))?.slice("--template=".length);
      if (path === undefined) throw new Error("Expected template");
      assert.equal(NodeFS.statSync(path).mode & 0o777, 0o600);
      const parsed = JSON.parse(NodeFS.readFileSync(path, "utf8"));
      assert.equal(parsed.category, "API_CREDENTIAL");
      assert.equal(parsed.title, "AWS Prod");
      assert.equal(parsed.fields.length, 2);
      assert.equal(parsed.fields[0].value, "AKIA123");
      assert.equal(parsed.fields[1].value, "SECRET456");
      assert.isFalse(args.some((arg) => arg.includes("AKIA123") || arg.includes("SECRET456")));
      return {
        stdout: JSON.stringify({
          id: "aws-item-id",
          vault: { id: "eng-vault-id" },
          fields: [
            { id: "f1", label: "AWS_ACCESS_KEY_ID", value: "AKIA123" },
            { id: "f2", label: "AWS_SECRET_ACCESS_KEY", value: "SECRET456" },
          ],
        }),
      };
    });
    return Effect.gen(function* () {
      if (!driver.saveFields) throw new Error("Expected saveFields");
      const refs = yield* driver.saveFields(
        { account },
        {
          vault: "Engineering",
          label: "AWS Prod",
          fields: [
            { id: "AWS_ACCESS_KEY_ID", label: "AWS_ACCESS_KEY_ID", value: "AKIA123" },
            { id: "AWS_SECRET_ACCESS_KEY", label: "AWS_SECRET_ACCESS_KEY", value: "SECRET456" },
          ],
        },
      );
      assert.deepStrictEqual(refs, {
        AWS_ACCESS_KEY_ID: "op://eng-vault-id/aws-item-id/AWS_ACCESS_KEY_ID",
        AWS_SECRET_ACCESS_KEY: "op://eng-vault-id/aws-item-id/AWS_SECRET_ACCESS_KEY",
      });
      assert.isDefined(path);
      assert.isFalse(path !== undefined && NodeFS.existsSync(path));
    }).pipe(Effect.provide(fixture.layer));
  });
  it.effect("authenticates with OP_SERVICE_ACCOUNT_TOKEN without --account", () => {
    const op = fakeOp((args, options) => {
      assert.isFalse(args.some((arg) => arg.startsWith("--account=")));
      assert.equal(options.extendEnv, true);
      assert.equal(options.env?.OP_SERVICE_ACCOUNT_TOKEN, "ops_test_token_123");
      return { stdout: "sk-service-account" };
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* driver.read({ serviceAccountToken: "ops_test_token_123" }, [
          "op://Private/OpenAI/credential",
        ]),
        ["sk-service-account"],
      );
      assert.deepStrictEqual(op.invocations, [
        ["--cache=false", "read", "--no-newline", "op://Private/OpenAI/credential"],
      ]);
      assert.deepStrictEqual(op.envs, [{ OP_SERVICE_ACCOUNT_TOKEN: "ops_test_token_123" }]);
    }).pipe(Effect.provide(op.layer));
  });
});

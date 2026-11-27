import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

import { definition, type OnePasswordAccount } from "../shared/definition.ts";

const ONE_PASSWORD_BINARY = "op";
// Bounds a read long enough to reach for a fingerprint reader, short enough not to wedge a rebuild.
const READ_TIMEOUT = Duration.seconds(45);

// `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
const runOnePassword = Effect.fn("OnePasswordDriver.runOnePassword")(function* (
  args: ReadonlyArray<string>,
) {
  const spawnCommand = yield* resolveSpawnCommand(ONE_PASSWORD_BINARY, ["--cache=false", ...args]);
  return yield* spawnAndCollect(
    ONE_PASSWORD_BINARY,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, { shell: spawnCommand.shell }),
  );
});

// A secret is passed on verbatim; surrounding whitespace can be part of it.
const nonEmpty = (value: string) => (value.trim().length > 0 ? value : undefined);

const readOne = Effect.fn("OnePasswordDriver.readOne")(function* (
  account: OnePasswordAccount,
  reference: string,
) {
  const result = yield* runOnePassword(["read", `--account=${account}`, "--no-newline", reference]);
  if (result.code !== 0) {
    yield* Effect.logWarning("Could not read secret from 1Password", {
      stage: "read",
      exitCode: result.code,
    });
    return undefined;
  }
  return nonEmpty(result.stdout);
});

// One `op inject` costs one unlock for every reference in the template. `op` ignores piped stdin
// from Node, so the template goes through a temp file. A random separator after every reference
// keeps one secret from shifting the others, and leaves any trailing newline outside the values.
const readTogether = Effect.fn("OnePasswordDriver.readTogether")(function* (
  account: OnePasswordAccount,
  references: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const separator = `__t3-secret-${yield* (yield* SecureRandom.SecureRandom).uuidV4()}__`;
  const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-inject-" });
  yield* fileSystem.writeFileString(
    templatePath,
    references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
  );
  const result = yield* runOnePassword(["inject", `--account=${account}`, "-i", templatePath]);
  const values = result.stdout.split(separator);
  const trailing = values.pop();
  if (
    result.code !== 0 ||
    values.length !== references.length ||
    trailing === undefined ||
    trailing.trim().length > 0
  ) {
    yield* Effect.logWarning("Could not batch-read secrets from 1Password", {
      stage: "inject",
      exitCode: result.code,
      references: references.length,
    });
    return undefined;
  }
  return values.map(nonEmpty);
}, Effect.scoped);

const recover = <A, E extends { readonly _tag: string }, R>(
  stage: "read" | "inject",
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage, error: error._tag }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

const CreatedItem = Schema.Struct({
  id: Schema.String,
  vault: Schema.Struct({ id: Schema.String }),
});
const decodeCreatedItem = Schema.decodeUnknownOption(Schema.fromJsonString(CreatedItem));
const encodeItemTemplate = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      category: Schema.Literal("PASSWORD"),
      title: Schema.String,
      fields: Schema.Array(
        Schema.Struct({
          id: Schema.Literal("password"),
          label: Schema.Literal("password"),
          type: Schema.Literal("CONCEALED"),
          purpose: Schema.Literal("PASSWORD"),
          value: Schema.String,
        }),
      ),
    }),
  ),
);

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  saveItem: Effect.fn("OnePasswordDriver.saveItem")(function* ({ account }, input) {
    const result = yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const template = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-create-" });
      yield* fileSystem.chmod(template, 0o600);
      yield* fileSystem.writeFileString(
        template,
        yield* encodeItemTemplate({
          category: "PASSWORD",
          title: input.label,
          fields: [
            {
              id: "password",
              label: "password",
              type: "CONCEALED",
              purpose: "PASSWORD",
              value: input.value,
            },
          ],
        }),
      );
      const saved = yield* runOnePassword([
        "item",
        "create",
        `--account=${account}`,
        `--vault=${input.vault}`,
        `--template=${template}`,
        "--format=json",
      ]);
      if (saved.code !== 0) return undefined;
      const item = decodeCreatedItem(saved.stdout);
      if (Option.isNone(item)) return undefined;
      const reference = `op://${item.value.vault.id}/${item.value.id}/password`;
      return definition.isReference(reference) ? reference : undefined;
    }).pipe(
      Effect.scoped,
      Effect.catch(() => Effect.undefined),
      Effect.timeoutOption(READ_TIMEOUT),
    );
    return Option.getOrUndefined(result);
  }),
  read: Effect.fn("OnePasswordDriver.read")(function* ({ account }, references) {
    // One deadline covers the batch and the fallback; a reference not read by then is unreadable.
    const values: Array<string | undefined> = references.map(() => undefined);
    const outcome = yield* Effect.gen(function* () {
      if (references.length > 1) {
        const together = yield* recover("inject", readTogether(account, references));
        if (together !== undefined) return together;
      }
      yield* Effect.forEach(
        references,
        (reference, index) =>
          recover("read", readOne(account, reference)).pipe(
            Effect.map((value) => {
              values[index] = value;
            }),
          ),
        { discard: true },
      );
      return values;
    }).pipe(Effect.timeoutOption(READ_TIMEOUT));
    if (Option.isSome(outcome)) return outcome.value;
    yield* Effect.logWarning("1Password did not answer in time", {
      references: references.length,
    });
    return values;
  }),
});

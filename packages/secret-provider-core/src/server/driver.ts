import type { SecretProviderKind } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";

import type { SecretProviderDefinition } from "../shared/definition.ts";

/** What the server gives every driver. A driver builds anything else it needs itself. */
export type SecretProviderDriverServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | SecureRandom.SecureRandom;

export interface SecretProviderItemInput {
  readonly vault: string;
  readonly label: string;
  readonly value: string;
}

export interface SecretProviderFieldInput {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface SecretProviderFieldsItemInput {
  readonly vault: string;
  readonly label: string;
  readonly fields: ReadonlyArray<SecretProviderFieldInput>;
}

export interface SecretProviderDriver {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition;
  readonly saveItem?: (
    config: unknown,
    input: SecretProviderItemInput,
  ) => Effect.Effect<string | undefined, never, SecretProviderDriverServices>;
  readonly saveFields?: (
    config: unknown,
    input: SecretProviderFieldsItemInput,
  ) => Effect.Effect<
    Readonly<Record<string, string>> | undefined,
    never,
    SecretProviderDriverServices
  >;
  /**
   * Values in input order; `undefined` marks a reference that could not be read. `config` has
   * decoded with the definition's `configSchema` and every reference passed its `isReference`.
   */
  readonly read: (
    config: unknown,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string | undefined>, never, SecretProviderDriverServices>;
}

export const defineSecretProviderDriver = <Config>(driver: {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition<Config>;
  readonly saveItem?: (
    config: Config,
    input: SecretProviderItemInput,
  ) => Effect.Effect<string | undefined, never, SecretProviderDriverServices>;
  readonly saveFields?: (
    config: Config,
    input: SecretProviderFieldsItemInput,
  ) => Effect.Effect<
    Readonly<Record<string, string>> | undefined,
    never,
    SecretProviderDriverServices
  >;
  readonly read: (
    config: Config,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string | undefined>, never, SecretProviderDriverServices>;
}): SecretProviderDriver => {
  const isConfig = Schema.is(driver.definition.configSchema);
  const saveItem = driver.saveItem;
  const saveFields = driver.saveFields;
  return {
    kind: driver.kind,
    definition: driver.definition,
    ...(saveItem === undefined
      ? {}
      : {
          saveItem: (config: unknown, input: SecretProviderItemInput) =>
            isConfig(config) ? saveItem(config, input) : Effect.undefined,
        }),
    ...(saveFields === undefined
      ? {}
      : {
          saveFields: (config: unknown, input: SecretProviderFieldsItemInput) =>
            isConfig(config) ? saveFields(config, input) : Effect.undefined,
        }),
    read: (config, references) =>
      isConfig(config)
        ? driver.read(config, references)
        : Effect.succeed(references.map(() => undefined)),
  };
};

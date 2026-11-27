// Reads secrets that settings point at through a configured secret provider. Each read, including
// a failed one, is held for the server's life so rebuilds never re-prompt an unlock; `invalidate`
// (the Settings refresh) and a `fresh` read are the only ways to read again.
import type { SecretReference, ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type {
  SecretProviderDriver,
  SecretProviderDriverServices,
  SecretProviderFieldsItemInput,
  SecretProviderItemInput,
} from "./driver.ts";

export class SecretResolver extends Context.Service<
  SecretResolver,
  {
    /**
     * Values in input order; `undefined` marks a reference that could not be read. `fresh` asks the
     * provider again and returns what it answered, but an unreadable or empty answer does not
     * replace a value that is already held.
     */
    readonly read: (
      references: ReadonlyArray<SecretReference>,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ReadonlyArray<string | undefined>>;
    /** Forgets the given references, or every reference, so the next read asks the provider again. */
    readonly invalidate: (references?: ReadonlyArray<SecretReference>) => Effect.Effect<void>;
    /** The name the user gave a secret provider, or its id when it has none or is gone. */
    readonly label: (provider: SecretReference["provider"]) => Effect.Effect<string>;
    readonly saveItem?: (
      provider: SecretReference["provider"],
      input: SecretProviderItemInput,
    ) => Effect.Effect<SecretReference | undefined>;
    readonly saveFields?: (
      provider: SecretReference["provider"],
      input: SecretProviderFieldsItemInput,
    ) => Effect.Effect<Readonly<Record<string, SecretReference>> | undefined>;
  }
>()("@t3tools/secret-provider-core/server/SecretResolver") {}

const cacheKey = (reference: SecretReference) =>
  `${reference.provider}\u0000${reference.reference}`;

interface CachedSecret {
  // A provider whose config changed, such as another account, reads again.
  readonly config: string;
  readonly value: string | undefined;
}

const decodeConfigWith = Schema.decodeUnknownOption<Schema.Codec<unknown, unknown>>;

interface ReadablePlan {
  readonly driver: SecretProviderDriver;
  readonly config: unknown;
  readonly configKey: string;
}

export const make = Effect.fn("SecretResolver.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
  readonly secretProviders: Effect.Effect<ServerSettings["secretProviders"]>;
}) {
  const context = yield* Effect.context<SecretProviderDriverServices>();
  const driversByKind = new Map(
    options.drivers.map((driver) => [
      driver.kind,
      { driver, decodeConfig: decodeConfigWith(driver.definition.configSchema) },
    ]),
  );
  const cache = new Map<string, CachedSecret>();
  const semaphore = yield* Semaphore.make(1);

  // Only a provider this build can read is cached; anything else fails fast and is checked again
  // on the next read.
  const planFor = (
    providers: ServerSettings["secretProviders"],
    reference: SecretReference,
  ): ReadablePlan | undefined => {
    const provider = providers[reference.provider];
    const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
    if (provider === undefined || entry === undefined) return undefined;
    const { driver, decodeConfig } = entry;
    if (!driver.definition.isReference(reference.reference)) return undefined;
    const config = decodeConfig(provider.config);
    return Option.isNone(config)
      ? undefined
      : { driver, config: config.value, configKey: JSON.stringify(config.value) };
  };

  const isCached = (reference: SecretReference, plan: ReadablePlan) =>
    cache.get(cacheKey(reference))?.config === plan.configKey;

  const answer = (
    references: ReadonlyArray<SecretReference>,
    plans: ReadonlyArray<ReadablePlan | undefined>,
  ) =>
    references.map((reference, index) => {
      const plan = plans[index];
      return plan !== undefined && isCached(reference, plan)
        ? cache.get(cacheKey(reference))?.value
        : undefined;
    });

  // Cache hits answer without the lock, so a read waiting on an unlock never stalls a cached one.
  const read: SecretResolver["Service"]["read"] = Effect.fn("SecretResolver.read")(function* (
    references,
    readOptions,
  ) {
    const fresh = readOptions?.fresh === true;
    const providers = yield* options.secretProviders;
    const plans = references.map((reference) => planFor(providers, reference));
    const isMissing = (reference: SecretReference, index: number) => {
      const plan = plans[index];
      return plan !== undefined && (fresh || !isCached(reference, plan));
    };
    if (!references.some(isMissing)) return answer(references, plans);

    return yield* semaphore.withPermits(1)(
      Effect.gen(function* () {
        const wanted = new Map<
          string,
          {
            readonly plan: ReadablePlan;
            readonly byReference: Map<string, Array<SecretReference>>;
          }
        >();
        references.forEach((reference, index) => {
          const plan = plans[index];
          if (plan === undefined || !isMissing(reference, index)) return;
          const group = wanted.get(reference.provider) ?? { plan, byReference: new Map() };
          group.byReference.set(reference.reference, [
            ...(group.byReference.get(reference.reference) ?? []),
            reference,
          ]);
          wanted.set(reference.provider, group);
        });
        const answered = new Map<string, string | undefined>();
        for (const { plan, byReference } of wanted.values()) {
          const values = yield* plan.driver.read(plan.config, [...byReference.keys()]);
          [...byReference.values()].forEach((sameReference, index) => {
            const value = values[index];
            const readable = value !== undefined && value.trim() !== "";
            for (const reference of sameReference) {
              answered.set(cacheKey(reference), value);
              if (!fresh || readable || !isCached(reference, plan)) {
                cache.set(cacheKey(reference), { config: plan.configKey, value });
              }
            }
          });
        }
        return fresh
          ? references.map((reference) => answered.get(cacheKey(reference)))
          : answer(references, plans);
      }),
    );
  }, Effect.provideContext(context));

  const invalidate: SecretResolver["Service"]["invalidate"] = (references) =>
    semaphore.withPermits(1)(
      Effect.sync(() => {
        if (references === undefined) cache.clear();
        else for (const reference of references) cache.delete(cacheKey(reference));
      }),
    );

  const label: SecretResolver["Service"]["label"] = (provider) =>
    options.secretProviders.pipe(
      Effect.map(
        (providers) =>
          (Object.hasOwn(providers, provider) ? providers[provider]?.label.trim() : undefined) ||
          provider,
      ),
    );

  const saveItem = Effect.fn("SecretResolver.saveItem")(function* (
    providerId: SecretReference["provider"],
    input: SecretProviderItemInput,
  ) {
    const providers = yield* options.secretProviders;
    const provider = providers[providerId];
    const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
    if (provider === undefined || entry?.driver.saveItem === undefined) return undefined;
    const config = entry.decodeConfig(provider.config);
    if (Option.isNone(config)) return undefined;
    const reference = yield* entry.driver.saveItem(config.value, input);
    return reference !== undefined && entry.driver.definition.isReference(reference)
      ? { provider: providerId, reference }
      : undefined;
  }, Effect.provideContext(context));

  const saveFields = Effect.fn("SecretResolver.saveFields")(function* (
    providerId: SecretReference["provider"],
    input: SecretProviderFieldsItemInput,
  ) {
    if (input.fields.length === 0) return undefined;
    const providers = yield* options.secretProviders;
    const provider = providers[providerId];
    const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
    if (provider === undefined || entry === undefined) return undefined;
    const config = entry.decodeConfig(provider.config);
    if (Option.isNone(config)) return undefined;
    if (entry.driver.saveFields !== undefined) {
      const saved = yield* entry.driver.saveFields(config.value, input);
      if (saved === undefined) return undefined;
      const references: Record<string, SecretReference> = {};
      for (const field of input.fields) {
        const ref = Object.hasOwn(saved, field.id) ? saved[field.id] : undefined;
        if (ref === undefined || !entry.driver.definition.isReference(ref)) return undefined;
        references[field.id] = { provider: providerId, reference: ref };
      }
      return references;
    }
    if (entry.driver.saveItem === undefined) return undefined;
    const references: Record<string, SecretReference> = {};
    for (const field of input.fields) {
      const fieldTitle =
        input.fields.length === 1 ? input.label : `${input.label} (${field.label})`.slice(0, 100);
      const ref = yield* entry.driver.saveItem(config.value, {
        vault: input.vault,
        label: fieldTitle,
        value: field.value,
      });
      if (ref === undefined || !entry.driver.definition.isReference(ref)) return undefined;
      references[field.id] = { provider: providerId, reference: ref };
    }
    return references;
  }, Effect.provideContext(context));

  return SecretResolver.of({ read, invalidate, label, saveItem, saveFields });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(SecretResolver, make(options));

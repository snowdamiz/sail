import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as CliError from "effect/cli/CliError";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { holdServerOwnershipLock } from "../serverOwnership.ts";
import { mintForRunningServer } from "./auth.ts";

const layer = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cli-auth-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const activeLinkIds = EnvironmentAuth.EnvironmentAuth.pipe(
  Effect.flatMap((auth) => auth.listPairingLinks()),
  Effect.map((links) => links.map(({ id }) => id)),
);

it.effect("keeps a link minted while the home's server holds the ownership lock", () =>
  Effect.gen(function* () {
    const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
    yield* holdServerOwnershipLock(serverRuntimeStatePath);

    const issued = yield* mintForRunningServer({ scopes: ["orchestration:read"] });

    assert.deepStrictEqual(yield* activeLinkIds, [issued.id]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("revokes the link when the server stops before the link is kept", () =>
  Effect.gen(function* () {
    const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const serverLifetime = yield* Scope.make();
    yield* Scope.provide(serverLifetime)(holdServerOwnershipLock(serverRuntimeStatePath));
    const serverStopsWhileMinting = EnvironmentAuth.EnvironmentAuth.of({
      ...auth,
      createPairingLink: (input) =>
        auth
          .createPairingLink(input)
          .pipe(Effect.tap(() => Scope.close(serverLifetime, Exit.void))),
    });

    const error = yield* mintForRunningServer({ scopes: ["orchestration:read"] }).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, serverStopsWhileMinting),
      Effect.flip,
    );

    assert.match(error.message, /stopped before the pairing token was ready, so it was revoked/);
    assert.deepStrictEqual(yield* activeLinkIds, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("names the unprinted link when it cannot be revoked after the server stopped", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const serverGoneAndDatabaseBusy = EnvironmentAuth.EnvironmentAuth.of({
      ...auth,
      revokePairingLink: () =>
        Effect.fail(new EnvironmentAuth.ServerAuthPairingLinkRevocationError({ cause: "busy" })),
    });

    const error = yield* mintForRunningServer({ scopes: ["orchestration:read"] }).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, serverGoneAndDatabaseBusy),
      Effect.flip,
    );

    const { baseDir } = yield* ServerConfig.ServerConfig;
    const [unrevoked] = yield* activeLinkIds;
    assert.isDefined(unrevoked);
    assert.instanceOf(error, CliError.UserError);
    assert.include(error.message, `auth pairing revoke --base-dir ${baseDir} ${unrevoked}`);
  }).pipe(Effect.provide(layer)),
);

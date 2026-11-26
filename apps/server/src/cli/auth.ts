import {
  AuthAccessWriteScope,
  AuthRevokePairingLinkInput,
  AuthSessionId,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import {
  formatConnectDeviceList,
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import * as ServerConfig from "../config.ts";
import { authScopesFlag } from "./authScopes.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  HttpUrl,
  readRunningServer,
  recordedPublicUrl,
  resolveCliAuthConfig,
} from "./config.ts";
import { resolveHostCliCommand } from "./invocation.ts";
import * as RunningServer from "./runningServer.ts";
import { isServerOwnershipHeld } from "../serverOwnership.ts";

const withEnvironmentAuth = Effect.fn("auth.withEnvironmentAuth")(function* <A, E, R>(
  config: ServerConfig.ServerConfig["Service"],
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E, R>,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* run(environmentAuth);
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

const runWithEnvironmentAuth = Effect.fn("auth.runWithEnvironmentAuth")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E, R>,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, options);
  return yield* withEnvironmentAuth(config, run, options);
});

/** Access changes go through a running server, which applies them to its open connections. */
const changeAccess = <A, E, R, E2, R2>(change: {
  readonly viaServer: (client: RunningServer.ServerClient) => Effect.Effect<A, E, R>;
  readonly locally: Effect.Effect<A, E2, R2>;
}) => RunningServer.changeState({ scopes: [AuthAccessWriteScope], ...change });

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withSchema(HttpUrl),
  Flag.withDescription(
    "Public base URL used to print a ready `/pair#token=...` link. Defaults to the running server's --public-url.",
  ),
  Flag.optional,
);

const requireRunningFlag = Flag.Boolean("require-running").pipe(
  Flag.withDescription(
    "Mint nothing unless the runtime record names a live server and this T3 Code home's ownership lock is held both before the token is written and after it is stored.",
  ),
  Flag.withDefault(false),
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const notMinted = (reason: string, retry: string) =>
  new CliError.UserError({ cause: `${reason}, so no pairing token was minted. ${retry}` });

// Expiry is stored as ISO text and compared as text, so a year past 9999 sorts before today.
const LATEST_EXPIRY_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export const mintForRunningServer = Effect.fn("auth.mintForRunningServer")(function* (
  input: Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]>[0],
) {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const { baseDir, serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  const issued = yield* environmentAuth.createPairingLink(input);
  // The OS releases the lock when its holder exits, even on SIGKILL.
  if (isServerOwnershipHeld(serverRuntimeStatePath)) return issued;
  yield* environmentAuth.revokePairingLink(issued.id).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const { command } = yield* resolveHostCliCommand("auth pairing revoke", [
          "--base-dir",
          baseDir,
          issued.id,
        ]);
        return yield* new CliError.UserError({
          cause: `The T3 Code server for ${baseDir} stopped before the pairing token was ready, and revoking it failed. It was never printed; to remove it, run \`${command}\`.`,
        });
      }),
    ),
  );
  return yield* new CliError.UserError({
    cause: `The T3 Code server for ${baseDir} stopped before the pairing token was ready, so it was revoked. Start the server, then retry.`,
  });
});

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  requireRunning: requireRunningFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.ttl)) {
        const ttlMs = Duration.toMillis(flags.ttl.value);
        if (ttlMs < 1000 || (yield* Clock.currentTimeMillis) + ttlMs > LATEST_EXPIRY_MS) {
          return yield* notMinted(
            "--ttl must be at least 1 second and expire before the year 10000",
            "Pass a duration such as 5m or 1h.",
          );
        }
      }
      const options = { quietLogs: flags.json };
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, options);
      const running = yield* readRunningServer(config.serverRuntimeStatePath).pipe(
        Effect.provideService(References.MinimumLogLevel, flags.json ? "Error" : config.logLevel),
      );
      if (flags.requireRunning) {
        if (Option.isNone(running)) {
          return yield* notMinted(
            `No running T3 Code server owns ${config.baseDir}`,
            "Start the server, or wait until it is ready, then retry.",
          );
        }
        if (running.value.ownerId === undefined) {
          return yield* notMinted(
            `The T3 Code server recorded for ${config.baseDir} was started by a release without the ownership lock`,
            "Restart that server with this release, then retry.",
          );
        }
      }
      const recordedUrl = Option.getOrUndefined(running)?.publicUrl;
      const baseUrl = Option.isSome(flags.baseUrl)
        ? flags.baseUrl.value.href
        : recordedUrl === undefined
          ? undefined
          : yield* recordedPublicUrl(recordedUrl, config.baseDir);
      const label = Option.getOrElse(flags.label, () => "").trim();
      const request = {
        scopes: flags.scopes,
        subject: "one-time-token",
        ...(label.length > 0 ? { label } : {}),
        ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
      };
      const issued = yield* withEnvironmentAuth(
        config,
        (environmentAuth) =>
          flags.requireRunning
            ? mintForRunningServer(request)
            : environmentAuth.createPairingLink(request),
        options,
      ).pipe(
        Effect.catchTags({
          ServerOwnsDatabaseError: () =>
            Effect.fail(
              notMinted(
                `Another T3 Code process owns ${config.baseDir} and has not finished updating its database, or runs a different release than this CLI`,
                "Wait until the server is ready, or use the `t3` that matches it, then retry.",
              ),
            ),
        }),
      );
      yield* Console.log(
        formatIssuedPairingCredential(issued, {
          json: flags.json,
          ...(baseUrl === undefined ? {} : { baseUrl }),
        }),
      );
    }),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const pairingLinks = yield* environmentAuth.listPairingLinks({
            excludeSubjects: [EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT],
          });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(
    Argument.withDescription("Pairing credential id to revoke."),
    // Same schema the server applies, so both paths revoke the same id.
    Argument.withSchema(AuthRevokePairingLinkInput.fields.id),
  ),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const revoked = yield* changeAccess({
          viaServer: (client) =>
            client.auth
              .revokePairingLink({ headers: {}, payload: { id: flags.id } })
              .pipe(Effect.map((result) => result.revoked)),
          locally: environmentAuth.revokePairingLink(flags.id),
        });
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const connectDeviceListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List T3 Connect devices waiting for approval and those already trusted.",
  ),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const waiting = (yield* environmentAuth.listPairingLinks()).flatMap((link) =>
            link.connectDeviceRequest ? [link.connectDeviceRequest] : [],
          );
          const trusted = yield* environmentAuth.listConnectDevices();
          yield* Console.log(formatConnectDeviceList({ waiting, trusted }, { json: flags.json }));
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const verificationCodeArgument = Argument.String("code").pipe(
  Argument.withDescription("The code the device shows, such as `K7QM-2XFD`."),
);

const connectDeviceApproveCommand = Command.make("approve", {
  ...authLocationFlags,
  code: verificationCodeArgument,
}).pipe(
  Command.withDescription("Approve the waiting T3 Connect device that shows this code."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const [pairingLinkId, ...others] = yield* environmentAuth.connectRequestsShowingCode(
          flags.code,
        );
        // Two waiting devices that share a code are ambiguous; approve neither.
        const approved =
          pairingLinkId !== undefined &&
          others.length === 0 &&
          (yield* changeAccess({
            viaServer: (client) =>
              client.auth
                .approveConnectDevice({ headers: {}, payload: { pairingLinkId } })
                .pipe(Effect.map((result) => result.approved)),
            locally: environmentAuth.approveConnectDevice(pairingLinkId),
          }));
        yield* Console.log(
          approved
            ? `Approved ${flags.code}. The device connects on its next try.\n`
            : `No device waiting for approval shows ${flags.code}.\n`,
        );
      }),
    ),
  ),
);

const connectDeviceRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  code: verificationCodeArgument,
}).pipe(
  Command.withDescription("Stop trusting a T3 Connect device and end its sessions."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const [device, ...others] = yield* environmentAuth.connectDevicesShowingCode(flags.code);
        if (device === undefined) {
          return yield* Console.log(`No trusted device shows ${flags.code}.\n`);
        }
        if (others.length > 0) {
          return yield* Console.log(
            `More than one trusted device shows ${flags.code}; revoke it from a client.\n`,
          );
        }
        const { proofKeyThumbprint } = device;
        yield* changeAccess({
          viaServer: (client) =>
            client.auth
              .revokeConnectDevice({ headers: {}, payload: { proofKeyThumbprint } })
              .pipe(Effect.map((result) => result.revoked)),
          locally: environmentAuth.revokeConnectDevice(proofKeyThumbprint),
        });
        yield* Console.log(
          `Revoked ${flags.code}. If approval for new devices is off, it can connect again on its own.\n`,
        );
      }),
    ),
  ),
);

const connectDeviceCommand = Command.make("connect-device").pipe(
  Command.withDescription("Approve and revoke devices that reach this host through T3 Connect."),
  Command.withSubcommands([
    connectDeviceListCommand,
    connectDeviceApproveCommand,
    connectDeviceRevokeCommand,
  ]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a scoped bearer access token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.issueSession({
            scopes: flags.scopes,
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, {
              json: flags.json,
              tokenOnly: flags.tokenOnly,
            }),
          );
        }),
      {
        quietLogs: flags.json || flags.tokenOnly,
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const sessions = yield* environmentAuth.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.String("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription(
    "Revoke an active session. A T3 Connect device's session takes the device's trust and other sessions with it; if approval for new devices is off, the device can connect again on its own.",
  ),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const revoked = yield* changeAccess({
          viaServer: (client) =>
            client.auth
              .revokeClient({ headers: {}, payload: { sessionId: flags.sessionId } })
              .pipe(Effect.map((result) => result.revoked)),
          locally: environmentAuth.revokeClient(flags.sessionId),
        });
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand, connectDeviceCommand]),
);

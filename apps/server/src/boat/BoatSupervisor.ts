import {
  BoatError,
  type BoatDaemonStatus,
  type BoatEvent,
  type BoatInvokeInput,
  type BoatInvokeResult,
  BoatNotice,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { resolveEntryPath } from "../cli/invocation.ts";
import * as ServerConfig from "../config.ts";
import * as ServerActivation from "../serverActivation.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import * as BoatDaemonBinary from "./BoatDaemonBinary.ts";

const HANDSHAKE_TIMEOUT = Duration.seconds(15);
const SHUTDOWN_REQUEST_TIMEOUT = Duration.seconds(1);
const FORCE_KILL_AFTER = Duration.seconds(3);
const SSE_RECONNECT_DELAY = Duration.millis(1_500);
const DRAIN_TIMEOUT = Duration.seconds(1);
const DAEMON_LOG_MAX_BYTES = 1024 * 1024;
const DAEMON_LOG_BACKUPS = 2;
const RESTART_DELAY_CAP_SECONDS = 60;
const STAYED_UP = Duration.minutes(1);
const STATE_READ_TIMEOUT = Duration.seconds(1);
const BOAT_DAEMON_PROTOCOL_VERSION = 1;

const Handshake = Schema.Struct({
  ready: Schema.Literal(true),
  protocolVersion: Schema.optional(Schema.Unknown),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  token: Schema.NonEmptyString,
});
type Handshake = typeof Handshake.Type;
const StartupLine = Schema.Union([
  Handshake,
  Schema.Struct({ ready: Schema.Literal(false), error: Schema.String }),
]);
const decodeStartupLine = Schema.decodeUnknownOption(Schema.fromJsonString(StartupLine));

const CommandReply = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.optional(Schema.Unknown),
    openUrl: Schema.optional(Schema.NullOr(Schema.String)),
    userCode: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
const decodeCommandReply = Schema.decodeUnknownEffect(CommandReply);

const decodeStateEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeNotifyEvent = Schema.decodeUnknownOption(Schema.fromJsonString(BoatNotice));

const SavedBoatState = Schema.Struct({
  machines: Schema.optional(Schema.Array(Schema.Unknown)),
  doomed: Schema.optional(Schema.Array(Schema.Unknown)),
  pendingSandboxes: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeSavedBoatState = Schema.decodeUnknownOption(Schema.fromJsonString(SavedBoatState));

/** Saved machines, or deletions Boat has not confirmed, may still bill until the daemon runs. */
export const savedStateNeedsDaemon = (stateJson: string): boolean =>
  Option.match(decodeSavedBoatState(stateJson), {
    onNone: () => false,
    onSome: (state) =>
      [state.machines, state.doomed, state.pendingSandboxes].some(
        (records) => records !== undefined && records.length > 0,
      ),
  });

// SAIL_HOME would send a dev server's `t3` to `<base>/userdata`, which can be the live install.
const cliHomeEnvironment = (
  config: ServerConfig.ServerConfig["Service"],
  path: Path.Path,
): Readonly<Record<string, string | undefined>> => {
  const sailHomeOpensThisServersState =
    config.devUrl === undefined || config.stateDir === path.join(config.baseDir, "userdata");
  return sailHomeOpensThisServersState
    ? { SAIL_HOME: config.baseDir }
    : { SAIL_HOME: undefined, T3CODE_HOME: undefined, VITE_DEV_SERVER_URL: config.devUrl.href };
};

const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export const launcherScript = (input: {
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly entry: string | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): string => {
  const environment = Object.entries({
    ...input.environment,
    ...(input.entry === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
  });
  const command = [input.executable, ...(input.entry === undefined ? [] : [input.entry])];
  if (input.platform === "win32") {
    const cmdText = (value: string) => value.replaceAll("%", "%%");
    return [
      "@echo off",
      "setlocal EnableExtensions DisableDelayedExpansion",
      ...environment.map(([name, value]) => `set "${name}=${cmdText(value ?? "")}"`),
      `${command.map((part) => `"${cmdText(part)}"`).join(" ")} %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    ...environment.map(([name, value]) =>
      value === undefined ? `unset ${name}` : `export ${name}=${quoteShell(value)}`,
    ),
    `exec ${command.map(quoteShell).join(" ")} "$@"`,
    "",
  ].join("\n");
};

interface Daemon {
  readonly baseUrl: string;
  readonly token: string;
}

type Lifecycle =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Starting"; readonly ready: Deferred.Deferred<Daemon, BoatError> }
  | { readonly _tag: "Running"; readonly daemon: Daemon }
  | { readonly _tag: "Failed"; readonly message: string };

const statusOf = (lifecycle: Lifecycle): BoatDaemonStatus => {
  switch (lifecycle._tag) {
    case "Stopped":
      return { phase: "stopped", error: null };
    case "Starting":
      return { phase: "starting", error: null };
    case "Running":
      return { phase: "ready", error: null };
    case "Failed":
      return { phase: "error", error: lifecycle.message };
  }
};

// Effect's Node spawner names a signal exit only in the message of its error's cause.
const SIGNAL_EXIT = /^Process interrupted due to receipt of signal: '(SIG[A-Z0-9]+)'$/;

const describeExit = (exit: Exit.Exit<ChildProcessSpawner.ExitCode, PlatformError>): string =>
  Exit.match(exit, {
    onSuccess: (code) => `exit code ${String(code)}`,
    onFailure: (cause) =>
      Option.match(
        Option.flatMap(Cause.findErrorOption(cause), (error) =>
          error.cause instanceof Error
            ? Option.fromNullishOr(SIGNAL_EXIT.exec(error.cause.message)?.[1])
            : Option.none(),
        ),
        { onNone: () => "an unknown exit", onSome: (signal) => `signal ${signal}` },
      ),
  });

export const restartDelay = (crashesInARow: number): Duration.Duration =>
  Duration.seconds(Math.min(2 ** (crashesInARow - 1), RESTART_DELAY_CAP_SECONDS));

const SERVER_ENV_FORWARDED_TO_DAEMON = new Set([
  "SAIL_DEEP_LINK_SCHEME",
  "SAIL_APP_BUNDLE_ID",
  "SAIL_CLI_INSTALL_URL",
  "SAIL_MCP_PORT",
]);

const daemonInheritedEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        SERVER_ENV_FORWARDED_TO_DAEMON.has(name.toUpperCase()) ||
        // Electron apps the daemon opens through the OS would inherit it and run as plain Node.
        !/^(SAIL_|T3CODE_|ELECTRON_RUN_AS_NODE$)/i.test(name),
    ),
  );

export class BoatSupervisor extends Context.Service<
  BoatSupervisor,
  {
    readonly invoke: (input: BoatInvokeInput) => Effect.Effect<BoatInvokeResult, BoatError>;
    readonly events: Stream.Stream<BoatEvent>;
    readonly notices: Stream.Stream<BoatNotice>;
  }
>()("t3/boat/BoatSupervisor") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const httpServer = yield* HttpServer.HttpServer;
  const binary = yield* BoatDaemonBinary.BoatDaemonBinary;
  const hostEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const isExecutable = yield* HostProcess.IsExecutable;
  const executablePath = yield* HostProcess.ExecutablePath;
  const entryPath = isExecutable ? undefined : path.resolve(yield* resolveEntryPath);
  const serviceScope = yield* Effect.scope;

  const dataDir = hostEnvironment.SAIL_BOAT_DATA_DIR?.trim() || path.join(config.baseDir, "boat");
  const daemonLogPath = path.join(config.logsDir, "sail-boatd.log");
  const launcherPath = path.join(config.stateDir, "boat", platform === "win32" ? "t3.cmd" : "t3");
  const address = httpServer.address;
  const origin =
    typeof address === "string" || !("port" in address)
      ? undefined
      : `http://${loopbackUrlHostForAddress(address)}:${address.port}`;

  const hub = yield* PubSub.unbounded<BoatEvent>();
  const noticeHub = yield* PubSub.unbounded<BoatNotice>();
  const lifecycle = yield* SynchronizedRef.make<Lifecycle>({ _tag: "Stopped" });
  const latestState = yield* Ref.make(Option.none<unknown>());
  const crashesInARow = yield* Ref.make(0);
  const daemonLog = yield* makeAsyncRotatingFileSink({
    filePath: daemonLogPath,
    maxBytes: DAEMON_LOG_MAX_BYTES,
    maxFiles: DAEMON_LOG_BACKUPS,
  }).pipe(
    Effect.tapError((cause) => Effect.logWarning("sail-boatd will run without a log", { cause })),
    Effect.orElseSucceed(() => ({ write: (_: string) => Effect.void })),
  );

  const dataDirNeedsDaemon = fileSystem.readFileString(path.join(dataDir, "state.json")).pipe(
    Effect.map(savedStateNeedsDaemon),
    Effect.orElseSucceed(() => false),
  );

  const enter = (next: Lifecycle) =>
    (next._tag === "Running" ? Effect.void : Ref.set(latestState, Option.none())).pipe(
      Effect.andThen(PubSub.publish(hub, { _tag: "status", status: statusOf(next) })),
      Effect.as(next),
    );
  const transition = (next: Lifecycle) =>
    SynchronizedRef.updateEffect(lifecycle, () => enter(next));

  const authorized = (daemon: Daemon) =>
    HttpClientRequest.setHeaders({ authorization: `Bearer ${daemon.token}` });

  const writeLauncher = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(launcherPath), { recursive: true });
    yield* fileSystem.writeFileString(
      launcherPath,
      launcherScript({
        platform,
        executable: executablePath,
        entry: entryPath,
        environment: cliHomeEnvironment(config, path),
      }),
    );
    if (platform !== "win32") yield* fileSystem.chmod(launcherPath, 0o755);
  });

  const daemonCommand = Effect.gen(function* () {
    if (origin === undefined) {
      return yield* new BoatError({
        message: "This server listens on no TCP port, so sail-boatd cannot reach it.",
      });
    }
    const executable = yield* binary.resolve.pipe(
      Effect.mapError((error) => new BoatError({ message: error.message })),
    );
    yield* writeLauncher.pipe(
      Effect.mapError(
        () => new BoatError({ message: `Could not write the t3 launcher at ${launcherPath}.` }),
      ),
    );
    return ChildProcess.make(executable, [], {
      env: {
        ...daemonInheritedEnvironment(hostEnvironment),
        SAIL_HOME: config.baseDir,
        SAIL_DESKTOP_CLI: launcherPath,
        SAIL_DESKTOP_ORIGIN: origin,
        SAIL_BOAT_DATA_DIR: dataDir,
        SAIL_BOAT_CONTROL_PORT: "0",
        SAIL_BOATD_EXIT_ON_STDIN_EOF: "1",
      },
      extendEnv: false,
      stdin: { stream: "pipe", endOnDone: false },
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: FORCE_KILL_AFTER,
    });
  });

  const onDaemonEvent = Effect.fnUntraced(function* (event: Sse.Event) {
    if (event.event === "state") {
      const state = decodeStateEvent(event.data);
      if (Option.isNone(state)) return;
      yield* Ref.set(latestState, state);
      yield* PubSub.publish(hub, { _tag: "state", state: state.value });
    } else if (event.event === "notify") {
      const notice = decodeNotifyEvent(event.data);
      if (Option.isNone(notice)) return;
      yield* PubSub.publish(noticeHub, notice.value);
    }
  });

  const followEvents = (daemon: Daemon) =>
    HttpClient.withScope(httpClient)
      .execute(HttpClientRequest.get(`${daemon.baseUrl}/api/events`).pipe(authorized(daemon)))
      .pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.stream.pipe(
                Stream.decodeText(),
                Stream.pipeThroughChannel(Sse.decode()),
                Stream.runForEach(onDaemonEvent),
              )
            : Effect.void,
        ),
        Effect.scoped,
        Effect.tapCause((cause) =>
          Effect.logDebug("sail-boatd event stream closed; reconnecting", { cause }),
        ),
        Effect.ignore,
        Effect.andThen(Effect.sleep(SSE_RECONNECT_DELAY)),
        Effect.forever,
      );

  const requestShutdown = (daemon: Daemon) =>
    httpClient
      .execute(
        HttpClientRequest.post(`${daemon.baseUrl}/api/command/shutdown`).pipe(
          authorized(daemon),
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      )
      .pipe(Effect.ignore);

  const runDaemon = Effect.fn("BoatSupervisor.runDaemon")(function* (
    ready: Deferred.Deferred<Daemon, BoatError>,
  ) {
    const command = yield* daemonCommand;
    const child = yield* spawner
      .spawn(command)
      .pipe(
        Effect.mapError(
          (error) => new BoatError({ message: `sail-boatd could not start: ${error.message}` }),
        ),
      );
    const drained = (fiber: Fiber.Fiber<unknown>) =>
      Fiber.join(fiber).pipe(Effect.timeout(DRAIN_TIMEOUT), Effect.ignore);

    const stderrDrained = yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Effect.ignore(daemonLog.write(text))),
      Effect.ignore,
      Effect.forkScoped,
    );
    const exited = yield* child.exitCode.pipe(Effect.exit, Effect.forkScoped);
    // Runs before the scope stops the reader, so the log keeps what a dead daemon printed last.
    yield* Effect.addFinalizer((exit) =>
      Exit.hasInterrupts(exit)
        ? Effect.void
        : child.isRunning.pipe(
            Effect.orElseSucceed(() => true),
            Effect.flatMap((running) => (running ? Effect.void : drained(stderrDrained))),
          ),
    );

    const startup = yield* Deferred.make<Handshake, BoatError>();
    // Kept draining after the handshake so the daemon never blocks on a full stdout pipe.
    const stdoutDrained = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Option.match(decodeStartupLine(line), {
          onNone: () => Effect.void,
          onSome: (report) =>
            report.ready
              ? Deferred.succeed(startup, report)
              : // sail-boatd prints the error to stderr too, after this line, and then exits.
                drained(exited).pipe(
                  Effect.andThen(
                    Deferred.fail(
                      startup,
                      new BoatError({ message: `sail-boatd could not start: ${report.error}` }),
                    ),
                  ),
                ),
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* Fiber.join(exited).pipe(
      Effect.tap(() => drained(stdoutDrained)),
      Effect.flatMap((exit) =>
        Deferred.fail(
          startup,
          new BoatError({
            message: `sail-boatd exited before it was ready (${describeExit(exit)})`,
          }),
        ),
      ),
      Effect.forkScoped,
    );

    const greeting = yield* Deferred.await(startup).pipe(
      Effect.timeoutOrElse({
        duration: HANDSHAKE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new BoatError({
              message: `sail-boatd did not report ready within ${Duration.toSeconds(HANDSHAKE_TIMEOUT)} seconds`,
            }),
          ),
      }),
    );
    if (greeting.protocolVersion !== BOAT_DAEMON_PROTOCOL_VERSION) {
      return yield* new BoatError({
        message: `sail-boatd uses an incompatible protocol. Install a matching sail-boatd (protocol version ${BOAT_DAEMON_PROTOCOL_VERSION}) and retry.`,
      });
    }

    const daemon: Daemon = { baseUrl: `http://127.0.0.1:${greeting.port}`, token: greeting.token };
    // Runs before the spawner's own release, which sends SIGTERM and then SIGKILL.
    yield* Effect.addFinalizer((exit) =>
      Exit.hasInterrupts(exit)
        ? requestShutdown(daemon).pipe(
            Effect.andThen(Fiber.join(exited)),
            Effect.timeout(SHUTDOWN_REQUEST_TIMEOUT),
            Effect.ignore,
          )
        : Effect.void,
    );
    yield* transition({ _tag: "Running", daemon });
    yield* Deferred.succeed(ready, daemon);
    yield* Effect.logInfo("sail-boatd is ready", { port: greeting.port });
    yield* followEvents(daemon).pipe(Effect.forkScoped);
    const stayedUp = yield* Effect.sleep(STAYED_UP).pipe(
      Effect.andThen(Ref.set(crashesInARow, 0)),
      Effect.forkScoped,
    );

    const exit = yield* Fiber.join(exited);
    yield* Fiber.interrupt(stayedUp);
    return yield* new BoatError({
      message: `sail-boatd exited unexpectedly (${describeExit(exit)})`,
    });
  }, Effect.scoped);

  const supervise = (ready: Deferred.Deferred<Daemon, BoatError>): Effect.Effect<void, BoatError> =>
    runDaemon(ready).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || Cause.hasInterrupts(exit.cause)) {
          return Deferred.fail(
            ready,
            new BoatError({ message: "This server is shutting down." }),
          ).pipe(Effect.andThen(transition({ _tag: "Stopped" })));
        }
        const error = Option.getOrElse(
          Cause.findErrorOption(exit.cause),
          () => new BoatError({ message: "sail-boatd stopped for an unknown reason." }),
        );
        const failed: Lifecycle = { _tag: "Failed", message: error.message };
        return Effect.logWarning("sail-boatd is not running", {
          cause: exit.cause,
          log: daemonLogPath,
        }).pipe(
          Effect.andThen(transition(failed)),
          Effect.andThen(Deferred.isDone(ready)),
          // A failed start waits for Retry, so a server refused another's data dir never takes it.
          Effect.flatMap((crashed) => (crashed ? restartIfNeeded(failed) : Effect.void)),
          Effect.andThen(Deferred.fail(ready, error)),
        );
      }),
      Effect.withSpan("BoatSupervisor.supervise", { root: true }),
    );

  const start = Effect.gen(function* () {
    const ready = yield* Deferred.make<Daemon, BoatError>();
    const next = yield* enter({ _tag: "Starting", ready });
    yield* Effect.forkIn(supervise(ready), serviceScope);
    return [Deferred.await(ready), next] as const;
  });

  const startIf = (shouldStart: (current: Lifecycle) => boolean) =>
    SynchronizedRef.updateEffect(lifecycle, (current) =>
      shouldStart(current) ? Effect.map(start, ([, next]) => next) : Effect.succeed(current),
    );

  const startIfStopped = startIf((current) => current._tag === "Stopped");

  const restartLater = Effect.fnUntraced(function* (failed: Lifecycle) {
    yield* Effect.sleep(restartDelay(yield* Ref.updateAndGet(crashesInARow, (n) => n + 1)));
    yield* startIf((current) => current === failed);
  });

  const restartIfNeeded = (failed: Lifecycle) =>
    dataDirNeedsDaemon.pipe(
      Effect.timeoutOrElse({ duration: STATE_READ_TIMEOUT, orElse: () => Effect.succeed(true) }),
      Effect.flatMap((needed) =>
        needed
          ? Effect.forkIn(restartLater(failed), serviceScope, { startImmediately: true })
          : Effect.void,
      ),
    );

  const ensureStarted = SynchronizedRef.modifyEffect(lifecycle, (current) => {
    switch (current._tag) {
      case "Running":
        return Effect.succeed([Effect.succeed(current.daemon), current] as const);
      case "Starting":
        return Effect.succeed([Deferred.await(current.ready), current] as const);
      case "Stopped":
      case "Failed":
        return start;
    }
  });

  const send = Effect.fn("BoatSupervisor.send")(function* (daemon: Daemon, input: BoatInvokeInput) {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(`${daemon.baseUrl}/api/command/${input.command}`).pipe(
          authorized(daemon),
          HttpClientRequest.bodyJsonUnsafe(input.args ?? {}),
        ),
      )
      .pipe(
        Effect.mapError(
          () => new BoatError({ message: `sail-boatd did not answer ${input.command}.` }),
        ),
      );
    return yield* response.json.pipe(
      Effect.flatMap(decodeCommandReply),
      Effect.mapError(
        () =>
          new BoatError({
            message: `sail-boatd answered ${input.command} with HTTP ${response.status}.`,
          }),
      ),
    );
  });

  const outlivingCaller = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.forkIn(effect, serviceScope).pipe(Effect.flatMap(Fiber.join));

  const invoke = Effect.fn("BoatSupervisor.invoke")(function* (input: BoatInvokeInput) {
    const daemon = yield* Effect.flatten(ensureStarted);
    const reply = yield* outlivingCaller(send(daemon, input));
    if (!reply.ok) return yield* new BoatError({ message: reply.error });
    return {
      data: reply.data ?? null,
      ...(reply.openUrl ? { openUrl: reply.openUrl } : {}),
      ...(reply.userCode ? { userCode: reply.userCode } : {}),
    } satisfies BoatInvokeResult;
  });

  const subscribeWithCurrentStatus = SynchronizedRef.modifyEffect(lifecycle, (current) =>
    PubSub.subscribe(hub).pipe(
      Effect.map((subscription) => [[subscription, statusOf(current)] as const, current]),
    ),
  );

  const events: BoatSupervisor["Service"]["events"] = Stream.unwrap(
    Effect.gen(function* () {
      const [subscription, status] = yield* subscribeWithCurrentStatus;
      const state = yield* Ref.get(latestState);
      // A failed daemon waits for a command such as Retry, so a page that reconnects never retries.
      yield* startIfStopped;
      return Stream.concat(
        Stream.fromIterable<BoatEvent>([
          { _tag: "status", status },
          ...Option.toArray(
            Option.map(state, (value) => ({ _tag: "state" as const, state: value })),
          ),
        ]),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  yield* ServerActivation.forkParked(
    dataDirNeedsDaemon.pipe(
      Effect.flatMap((needed) => (needed ? startIfStopped : Effect.void)),
      Effect.ignore,
    ),
  );

  return BoatSupervisor.of({ invoke, events, notices: Stream.fromPubSub(noticeHub) });
});

export const layer = Layer.effect(BoatSupervisor, make);

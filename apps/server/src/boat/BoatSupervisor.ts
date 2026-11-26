import {
  BoatError,
  type BoatDaemonStatus,
  type BoatEvent,
  type BoatInvokeInput,
  type BoatInvokeResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
const STDERR_DRAIN_TIMEOUT = Duration.seconds(1);
const STDERR_TAIL_LINES = 5;

const Handshake = Schema.Struct({
  ready: Schema.Literal(true),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  token: Schema.NonEmptyString,
});
type Handshake = typeof Handshake.Type;
const decodeHandshake = Schema.decodeUnknownOption(Schema.fromJsonString(Handshake));

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
const decodeNotifyEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String, body: Schema.String })),
);

/** The records in `state.json` that the daemon's reaper still has to act on. */
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

/**
 * The daemon's `t3` must open this server's database. An implicit home in dev mode keeps its
 * state in `dev/`, which an explicit SAIL_HOME would move to `userdata/`, the live install.
 */
const cliHomeEnvironment = (
  config: ServerConfig.ServerConfig["Service"],
  path: Path.Path,
): Readonly<Record<string, string | undefined>> =>
  config.devUrl === undefined || config.stateDir === path.join(config.baseDir, "userdata")
    ? { SAIL_HOME: config.baseDir }
    : { SAIL_HOME: undefined, T3CODE_HOME: undefined, VITE_DEV_SERVER_URL: config.devUrl.href };

const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

const launcherScript = (input: {
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
    return [
      "@echo off",
      "setlocal EnableExtensions DisableDelayedExpansion",
      ...environment.map(([name, value]) => `set "${name}=${value ?? ""}"`),
      `${command.map((part) => `"${part}"`).join(" ")} %*`,
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

const describeExit = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.match(exit, {
    onSuccess: (code) => `exit code ${String(code)}`,
    // Effect's spawner names a signal exit only in its error text.
    onFailure: (cause) => {
      const text = Cause.prettyErrors(cause)
        .map((error) => error.message)
        .join(" ");
      const signal = /signal: '([A-Z0-9]+)'/.exec(text)?.[1];
      return signal === undefined ? "an unknown exit" : `signal ${signal}`;
    },
  });

export class BoatSupervisor extends Context.Service<
  BoatSupervisor,
  {
    /** Starts the daemon if needed, then runs one command on it. */
    readonly invoke: (input: BoatInvokeInput) => Effect.Effect<BoatInvokeResult, BoatError>;
    /** Starts the daemon if needed; begins with the current status and the latest state. */
    readonly events: Stream.Stream<BoatEvent>;
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

  const dataDir = path.join(config.baseDir, "boat");
  const launcherPath = path.join(config.stateDir, "boat", platform === "win32" ? "t3.cmd" : "t3");
  const address = httpServer.address;
  const origin =
    typeof address === "string" || !("port" in address)
      ? undefined
      : `http://${loopbackUrlHostForAddress(address)}:${address.port}`;

  const hub = yield* PubSub.unbounded<BoatEvent>();
  const lifecycle = yield* SynchronizedRef.make<Lifecycle>({ _tag: "Stopped" });
  const latestState = yield* Ref.make(Option.none<unknown>());

  const enter = (next: Lifecycle) =>
    PubSub.publish(hub, { _tag: "status", status: statusOf(next) }).pipe(Effect.as(next));
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
        ...hostEnvironment,
        SAIL_HOME: config.baseDir,
        SAIL_DESKTOP_CLI: launcherPath,
        SAIL_DESKTOP_ORIGIN: origin,
        SAIL_BOAT_DATA_DIR: dataDir,
        SAIL_BOAT_CONTROL_PORT: "0",
      },
      extendEnv: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: FORCE_KILL_AFTER,
    });
  });

  // Per-event work shares the event stream's span.
  const onDaemonEvent = Effect.fnUntraced(function* (event: Sse.Event) {
    if (event.event === "state") {
      const state = decodeStateEvent(event.data);
      if (Option.isNone(state)) return;
      yield* Ref.set(latestState, state);
      yield* PubSub.publish(hub, { _tag: "state", state: state.value });
    } else if (event.event === "notify") {
      const notice = decodeNotifyEvent(event.data);
      if (Option.isNone(notice)) return;
      yield* PubSub.publish(hub, { _tag: "notify", ...notice.value });
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

  /** One daemon process from spawn to exit; it fails with the reason it is no longer running. */
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

    const stderrLines = yield* Ref.make<ReadonlyArray<string>>([]);
    const stderrDrained = yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Ref.update(stderrLines, (lines) => [...lines.slice(1 - STDERR_TAIL_LINES), line]),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const stderrTail = Fiber.join(stderrDrained).pipe(
      Effect.timeout(STDERR_DRAIN_TIMEOUT),
      Effect.ignore,
      Effect.andThen(Ref.get(stderrLines)),
      Effect.map((lines) => (lines.length === 0 ? "" : `: ${lines.join(" | ")}`)),
    );

    const handshake = yield* Deferred.make<Handshake>();
    // Kept draining after the handshake so the daemon never blocks on a full stdout pipe.
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Option.match(decodeHandshake(line), {
          onNone: () => Effect.void,
          onSome: (greeting) => Deferred.succeed(handshake, greeting),
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const exited = yield* child.exitCode.pipe(Effect.exit, Effect.forkScoped);

    const greeting = yield* Deferred.await(handshake).pipe(
      Effect.raceFirst(
        Fiber.join(exited).pipe(
          Effect.flatMap((exit) =>
            stderrTail.pipe(
              Effect.flatMap((tail) =>
                Effect.fail(
                  new BoatError({
                    message: `sail-boatd exited before it was ready (${describeExit(exit)})${tail}`,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.timeoutOrElse({
        duration: HANDSHAKE_TIMEOUT,
        orElse: () =>
          stderrTail.pipe(
            Effect.flatMap((tail) =>
              Effect.fail(
                new BoatError({
                  message: `sail-boatd did not report ready within ${Duration.toSeconds(HANDSHAKE_TIMEOUT)} seconds${tail}`,
                }),
              ),
            ),
          ),
      }),
    );

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

    const exit = yield* Fiber.join(exited);
    return yield* new BoatError({
      message: `sail-boatd exited unexpectedly (${describeExit(exit)})${yield* stderrTail}`,
    });
  }, Effect.scoped);

  const supervise = (ready: Deferred.Deferred<Daemon, BoatError>) =>
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
        return Deferred.fail(ready, error).pipe(
          Effect.andThen(transition({ _tag: "Failed", message: error.message })),
          Effect.andThen(Effect.logWarning("sail-boatd is not running", { cause: exit.cause })),
        );
      }),
    );

  /** Starts the daemon unless one is starting or running; the result waits for it to be ready. */
  const kick = SynchronizedRef.modifyEffect(lifecycle, (current) => {
    switch (current._tag) {
      case "Running":
        return Effect.succeed([Effect.succeed(current.daemon), current] as const);
      case "Starting":
        return Effect.succeed([Deferred.await(current.ready), current] as const);
      case "Stopped":
      case "Failed":
        return Effect.gen(function* () {
          const ready = yield* Deferred.make<Daemon, BoatError>();
          const next = yield* enter({ _tag: "Starting", ready });
          yield* Effect.forkIn(supervise(ready), serviceScope);
          return [Deferred.await(ready), next] as const;
        });
    }
  });

  const invoke = Effect.fn("BoatSupervisor.invoke")(function* (input: BoatInvokeInput) {
    const daemon = yield* Effect.flatten(kick);
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
    const reply = yield* response.json.pipe(
      Effect.flatMap(decodeCommandReply),
      Effect.mapError(
        () =>
          new BoatError({
            message: `sail-boatd answered ${input.command} with HTTP ${response.status}.`,
          }),
      ),
    );
    if (!reply.ok) return yield* new BoatError({ message: reply.error });
    return {
      data: reply.data ?? null,
      ...(reply.openUrl ? { openUrl: reply.openUrl } : {}),
      ...(reply.userCode ? { userCode: reply.userCode } : {}),
    } satisfies BoatInvokeResult;
  });

  const events: BoatSupervisor["Service"]["events"] = Stream.unwrap(
    Effect.gen(function* () {
      // Under the lifecycle lock, so no status change lands between the snapshot and the subscription.
      const [subscription, status] = yield* SynchronizedRef.modifyEffect(lifecycle, (current) =>
        PubSub.subscribe(hub).pipe(
          Effect.map((subscription) => [[subscription, statusOf(current)] as const, current]),
        ),
      );
      const state = yield* Ref.get(latestState);
      yield* Effect.asVoid(kick);
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

  // A standby server must not run a second daemon on the same Boat data dir.
  yield* ServerActivation.forkParked(
    fileSystem.readFileString(path.join(dataDir, "state.json")).pipe(
      Effect.map(savedStateNeedsDaemon),
      Effect.orElseSucceed(() => false),
      Effect.flatMap((needed) => (needed ? Effect.flatten(kick) : Effect.void)),
      Effect.ignore,
    ),
  );

  return BoatSupervisor.of({ invoke, events });
});

export const layer = Layer.effect(BoatSupervisor, make);

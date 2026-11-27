import { acquireBoatCliAccess } from "./boatLifecycle.ts";
import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { ServerAdmission } from "../serverAdmission.ts";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import {
  pinnedRuntimePaths,
  pinnedRuntimeVersionsDir,
  readPosixLauncherTarget,
  writePosixLauncher,
} from "./pinnedRuntime.ts";
import {
  decodeServiceLauncherContext,
  decodeServiceLauncherParentMessage,
  sameMaintenanceFence,
  sameMaintenancePeer,
  type MaintenanceFence,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
  type SupportedLauncherProtocol,
} from "./serviceProtocol.ts";
import { RESTORE_OOMD_WATCH_SCRIPT } from "./userManagerOom.ts";

export class ServiceLauncherClientError extends Schema.TaggedError<ServiceLauncherClientError>()(
  "ServiceLauncherClientError",
  {
    operation: Schema.Literals([
      "decode-context",
      "maintenance-identity",
      "version-mismatch",
      "unmanaged",
      "send",
      "disconnect",
      "timeout",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "decode-context":
        return "The service launcher supplied invalid startup context.";
      case "maintenance-identity":
        return "The server does not match the launcher's maintenance installation.";
      case "version-mismatch":
        return "The service launcher started a different t3 version.";
      case "unmanaged":
        return "This server is not managed by the launcher.";
      case "send":
        return "Could not send a request to the service launcher.";
      case "disconnect":
        return "The service launcher disconnected before acknowledging the request.";
      case "timeout":
        return "The service launcher did not respond within 30 seconds.";
    }
  }
}

export class ServiceLauncherRejectedError extends Schema.TaggedError<ServiceLauncherRejectedError>()(
  "ServiceLauncherRejectedError",
  {
    targetVersion: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

interface ServiceLauncherProcess {
  readonly connected: boolean;
  readonly hasLauncherIpc?: boolean;
  readonly send: (
    message: ServiceLauncherChildMessage,
    callback?: (error: Error | null) => void,
  ) => boolean;
  readonly on: (
    event: "message" | "disconnect",
    listener: (...args: ReadonlyArray<unknown>) => void,
  ) => void;
  readonly off: (
    event: "message" | "disconnect",
    listener: (...args: ReadonlyArray<unknown>) => void,
  ) => void;
}

const launchedWithIpc = process.send !== undefined;

export const ServiceLauncherHostProcess = Context.Reference<ServiceLauncherProcess>(
  "t3/cloud/serviceLauncherHostProcess",
  {
    defaultValue: () => ({
      hasLauncherIpc: launchedWithIpc,
      get connected() {
        return process.connected && process.send !== undefined;
      },
      send: (message, callback) => {
        if (process.send === undefined) return false;
        return callback === undefined ? process.send(message) : process.send(message, callback);
      },
      on: (event, listener) => {
        process.on(event, listener);
      },
      off: (event, listener) => {
        process.off(event, listener);
      },
    }),
  },
);

interface MaintenanceIdentity {
  readonly baseDir: string;
  readonly dbPath: string;
  readonly environmentId: string;
}

export class ServiceLauncherClient extends Context.Service<
  ServiceLauncherClient,
  {
    readonly managed: boolean;
    /** The supervising launcher's protocol. A remote update never replaces the launcher,
        so it can be older than this runtime's own. */
    readonly protocol: SupportedLauncherProtocol | undefined;
    readonly requestUpdate: (input: {
      readonly targetVersion: string;
      readonly dbPath: string;
    }) => Effect.Effect<string, ServiceLauncherClientError | ServiceLauncherRejectedError>;
    /** Owned `t3` launchers move to the new runtime only when this start commits the trial. */
    readonly prepareTrial: (input: {
      readonly baseDir: string;
      readonly maintenanceIdentity?: MaintenanceIdentity;
    }) => Effect.Effect<ServerSelfUpdateOutcome | undefined, ServiceLauncherClientError>;
    readonly maintenanceReady?: (
      identity: MaintenanceIdentity,
      reconcileSealed: Effect.Effect<void>,
      resumeAfterMaintenance?: Effect.Effect<void>,
    ) => Effect.Effect<void, ServiceLauncherClientError, Scope.Scope>;
  }
>()("t3/cloud/serviceLauncherClient") {}

const resolveStartup = Effect.fn("cloud.service_launcher_client.resolve_startup")(
  function* (options?: { readonly currentVersion?: string }) {
    const host = yield* ServiceLauncherHostProcess;
    const environment = yield* HostProcess.Environment;
    const currentVersion = options?.currentVersion ?? packageJson.version;
    // IPC channels are not inherited; without one, launcher context belongs to an ancestor.
    const inherited = environment[SERVICE_LAUNCHER_CONTEXT_ENV];
    const decoded = inherited === undefined ? undefined : decodeServiceLauncherContext(inherited);
    if (!host.connected && host.hasLauncherIpc === true && decoded?.maintenancePeer !== undefined) {
      return yield* new ServiceLauncherClientError({ operation: "disconnect" });
    }
    const rawContext = host.connected ? inherited : undefined;
    const context = host.connected ? decoded : undefined;

    if (rawContext !== undefined && context === undefined) {
      return yield* new ServiceLauncherClientError({ operation: "decode-context" });
    }
    if (context !== undefined && context.childVersion !== currentVersion) {
      return yield* new ServiceLauncherClientError({ operation: "version-mismatch" });
    }

    const managed = context !== undefined;

    return { host, context, managed };
  },
);

export const claimUnmanagedBoatStart = Effect.fn("cloud.service_launcher_client.claim_boat_start")(
  function* (baseDir: string) {
    const { managed } = yield* resolveStartup();
    return managed
      ? () => {}
      : yield* Effect.try({
          try: () => acquireBoatCliAccess(baseDir),
          catch: (cause) =>
            new ServiceLauncherClientError({ operation: "maintenance-identity", cause }),
        });
  },
);

export const verifyServiceMaintenanceHome = Effect.fn("cloud.service_launcher_client.verify_home")(
  function* (config: {
    readonly baseDir: string;
    readonly dbPath: string;
    readonly environmentIdPath: string;
  }) {
    const { context } = yield* resolveStartup();
    const peer = context?.maintenancePeer;
    if (peer === undefined) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = path.join(peer.baseDir, "userdata");
    const realPath = (file: string) =>
      fs.realPath(file).pipe(Effect.orElseSucceed(() => undefined));
    if (
      config.baseDir !== peer.baseDir ||
      (yield* realPath(config.baseDir)) !== peer.baseDir ||
      config.dbPath !== path.join(stateDir, "statev2.sqlite") ||
      (yield* realPath(config.dbPath)) !== config.dbPath ||
      config.environmentIdPath !== path.join(stateDir, "environment-id") ||
      (yield* realPath(config.environmentIdPath)) !== config.environmentIdPath ||
      (yield* fs
        .readFileString(config.environmentIdPath)
        .pipe(Effect.orElseSucceed(() => ""))).trim() !== peer.environmentId
    ) {
      return yield* new ServiceLauncherClientError({ operation: "maintenance-identity" });
    }
  },
);

export const resolveServiceLauncherMode = Effect.fn("cloud.service_launcher_client.resolve_mode")(
  function* () {
    const { managed } = yield* resolveStartup();
    return { managed };
  },
);

export const repointLaunchers = Effect.fn("cloud.service_launcher_client.repoint_launchers")(
  function* (input: { readonly baseDir: string; readonly targetVersion: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    if (platform !== "linux" && platform !== "darwin") return;
    const installBinDir =
      environment["T3CODE_INSTALL_BIN_DIR"] ||
      (environment["HOME"] ? path.join(environment["HOME"], ".local", "bin") : undefined);
    const candidates = new Set<string>();
    if (installBinDir !== undefined) candidates.add(path.join(installBinDir, "t3"));
    const searchPath = environment["PATH"] ?? "";
    const cwd = yield* HostProcess.WorkingDirectory;
    for (const directory of searchPath.split(":")) {
      // Like the shell, an empty entry of a nonempty PATH is the working directory.
      if (directory.length === 0 && searchPath.length === 0) continue;
      const candidate = path.join(directory || cwd, "t3");
      if (directory.length === 0) {
        // The shell passes over a working-directory entry it cannot run and keeps searching.
        const info = yield* fs.stat(candidate).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File" || (info.value.mode & 0o111) === 0) {
          continue;
        }
        candidates.add(candidate);
        break;
      }
      if (
        yield* fs.exists(candidate).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not check the t3 command on PATH", {
              launchedAs: candidate,
              cause,
            }).pipe(Effect.as(false)),
          ),
        )
      ) {
        candidates.add(candidate);
        break;
      }
    }
    const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
    const target = pinnedRuntimePaths(path, input.baseDir, input.targetVersion, platform);
    for (const launchedAs of candidates) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const linkTarget = yield* fs.readLink(launchedAs).pipe(
            Effect.asSome,
            Effect.catchIf(
              (error) =>
                error.reason._tag === "NotFound" ||
                (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EINVAL",
              () => Effect.succeedNone,
            ),
          );
          // A legacy symlink, or the script install.sh and `t3 update` write.
          const current = Option.isSome(linkTarget)
            ? path.resolve(path.dirname(launchedAs), linkTarget.value)
            : yield* readPosixLauncherTarget(launchedAs);
          if (current === undefined) return;
          const relative = path.relative(versionsDir, current);
          if (
            relative.length === 0 ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            return;
          yield* writePosixLauncher({
            launcher: launchedAs,
            executable: target.entryPath,
            exclusive: false,
          });
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not move the t3 command to the updated version", {
                launchedAs,
                cause,
              }),
        ),
      );
    }
  },
);

/** Completes when the launcher asks this server to stop, which Windows cannot signal. */
export const awaitServiceLauncherStop = Effect.fn("cloud.service_launcher_client.await_stop")(
  function* (options?: { readonly currentVersion?: string }) {
    const startup = yield* resolveStartup(options).pipe(
      Effect.catch((error) => (error.operation === "disconnect" ? Effect.interrupt : Effect.never)),
    );
    if (!startup.managed) return yield* Effect.never;
    const { host, context } = startup;
    return yield* Effect.callback<void>((resume) => {
      const onMessage = (...args: ReadonlyArray<unknown>) => {
        if (decodeServiceLauncherParentMessage(args[0])?.type === "stop") resume(Effect.void);
      };
      const onDisconnect = () => resume(Effect.void);
      host.on("message", onMessage);
      if (context?.maintenancePeer !== undefined) {
        host.on("disconnect", onDisconnect);
        if (!host.connected) onDisconnect();
      }
      return Effect.sync(() => {
        host.off("message", onMessage);
        host.off("disconnect", onDisconnect);
      });
    });
  },
);

export const make = Effect.fn("cloud.service_launcher_client.make")(function* (options?: {
  readonly currentVersion?: string;
}) {
  const { host, context, managed } = yield* resolveStartup(options);
  // prepareTrial runs later, outside whatever context built the client.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The launcher that commits a remote update is the old one; its reload after commit
  // keeps oomd's watch only if the policy is mirrored before it.
  const keepOomdWatch =
    platform === "linux"
      ? spawner
          .exitCode(
            ChildProcess.make("/bin/sh", ["-c", RESTORE_OOMD_WATCH_SCRIPT], {
              env: environment,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(Effect.timeout("30 seconds"), Effect.ignore)
      : Effect.void;

  const exchange = (
    message: ServiceLauncherChildMessage,
    accept: (reply: ServiceLauncherParentMessage) => boolean,
  ) =>
    Effect.callback<ServiceLauncherParentMessage, ServiceLauncherClientError>((resume) => {
      if (!managed) {
        resume(Effect.fail(new ServiceLauncherClientError({ operation: "unmanaged" })));
        return;
      }

      let settled = false;
      const cleanup = () => {
        host.off("message", onMessage);
        host.off("disconnect", onDisconnect);
      };
      const settle = (
        effect: Effect.Effect<ServiceLauncherParentMessage, ServiceLauncherClientError>,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const onMessage = (...args: ReadonlyArray<unknown>) => {
        const reply = decodeServiceLauncherParentMessage(args[0]);
        if (reply !== undefined && accept(reply)) settle(Effect.succeed(reply));
      };
      const onDisconnect = () =>
        settle(Effect.fail(new ServiceLauncherClientError({ operation: "disconnect" })));

      host.on("message", onMessage);
      host.on("disconnect", onDisconnect);
      try {
        host.send(message, (error) => {
          if (error !== null) {
            settle(
              Effect.fail(new ServiceLauncherClientError({ operation: "send", cause: error })),
            );
          }
        });
      } catch (cause) {
        settle(Effect.fail(new ServiceLauncherClientError({ operation: "send", cause })));
      }

      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(new ServiceLauncherClientError({ operation: "timeout" })),
      }),
    );

  const requestUpdate = (input: { readonly targetVersion: string; readonly dbPath: string }) =>
    exchange(
      { type: "request-update", ...input },
      (reply) => reply.type === "update-accepted" || reply.type === "update-rejected",
    ).pipe(
      Effect.flatMap((reply) =>
        reply.type === "update-accepted"
          ? Effect.succeed(reply.updateId)
          : reply.type === "update-rejected"
            ? Effect.fail(
                new ServiceLauncherRejectedError({
                  targetVersion: input.targetVersion,
                  reason: reply.reason,
                }),
              )
            : Effect.die("service launcher returned an impossible update response"),
      ),
    );

  const pending = context?.update?.status === "pending" ? context.update : undefined;
  const outcome =
    context?.update === undefined || context.update.status === "pending"
      ? undefined
      : context.update;
  const peer = context?.maintenancePeer;
  const fence = context?.maintenanceFence;
  const verifyIdentity = Effect.fn("cloud.service_launcher_client.verify_identity")(function* (
    identity: MaintenanceIdentity | undefined,
  ) {
    if (peer === undefined) return;
    const realPath = (file: string) =>
      fs.realPath(file).pipe(Effect.orElseSucceed(() => undefined));
    if (
      identity?.environmentId !== peer.environmentId ||
      identity.dbPath !== path.join(identity.baseDir, "userdata", "statev2.sqlite") ||
      (yield* realPath(identity.baseDir)) !== peer.baseDir ||
      (yield* realPath(identity.dbPath)) !== path.join(peer.baseDir, "userdata", "statev2.sqlite")
    ) {
      return yield* new ServiceLauncherClientError({ operation: "maintenance-identity" });
    }
  });

  const reconcileShellLaunchers = (baseDir: string, targetVersion: string) =>
    repointLaunchers({ baseDir, targetVersion }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(HostProcess.Platform, platform),
    );

  const prepareTrial = Effect.fn("cloud.service_launcher_client.prepare_trial")(function* (input: {
    readonly baseDir: string;
    readonly maintenanceIdentity?: MaintenanceIdentity;
  }) {
    yield* verifyIdentity(input.maintenanceIdentity);
    if (pending === undefined) return outcome;
    yield* keepOomdWatch;
    if (fence !== undefined && peer !== undefined) {
      yield* exchange(
        { type: "maintenance-prepared", fence, peer },
        (reply) =>
          reply.type === "maintenance-committed" &&
          sameMaintenancePeer(reply.peer, peer) &&
          sameMaintenanceFence(reply.fence, fence),
      );
    } else {
      yield* exchange(
        { type: "prepared", updateId: pending.id },
        (reply) => reply.type === "committed" && reply.updateId === pending.id,
      );
    }
    if (fence === undefined) yield* reconcileShellLaunchers(input.baseDir, pending.targetVersion);
    return {
      id: pending.id,
      fromVersion: pending.fromVersion,
      targetVersion: pending.targetVersion,
      status: "committed" as const,
    };
  });

  const send = (message: ServiceLauncherChildMessage) =>
    Effect.callback<void, ServiceLauncherClientError>((resume) => {
      try {
        host.send(message, (error) =>
          resume(
            error === null
              ? Effect.void
              : Effect.fail(new ServiceLauncherClientError({ operation: "send", cause: error })),
          ),
        );
      } catch (cause) {
        resume(Effect.fail(new ServiceLauncherClientError({ operation: "send", cause })));
      }
    });

  const maintenanceReady = Effect.fn("cloud.service_launcher_client.maintenance_ready")(function* (
    identity: MaintenanceIdentity,
    reconcileSealed: Effect.Effect<void>,
    resumeAfterMaintenance: Effect.Effect<void> = Effect.void,
  ) {
    if (peer === undefined) return;
    const admission = yield* ServerAdmission;
    if (admission === undefined) return;
    yield* verifyIdentity(identity);
    const commands = yield* Queue.unbounded<
      Extract<
        ServiceLauncherParentMessage,
        {
          readonly type: "maintenance-drain" | "maintenance-abort";
        }
      >
    >();
    const onMessage = (value: unknown) => {
      const command = decodeServiceLauncherParentMessage(value);
      if (
        (command?.type === "maintenance-drain" || command?.type === "maintenance-abort") &&
        sameMaintenancePeer(command.fence.incumbent, peer)
      )
        Queue.offerUnsafe(commands, command);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => host.on("message", onMessage)),
      () => Effect.sync(() => host.off("message", onMessage)),
    );

    let current: { readonly fence: MaintenanceFence; readonly token: symbol } | undefined;
    const retired = new Set<string>();
    const sealGate = yield* Semaphore.make(1);
    yield* Effect.forever(
      Effect.gen(function* () {
        const command = yield* Queue.take(commands);
        if (command.type === "maintenance-abort") {
          if (current !== undefined && !sameMaintenanceFence(current.fence, command.fence)) return;
          const attempt = current;
          current = undefined;
          if (attempt !== undefined) {
            yield* sealGate.withPermit(
              resumeAfterMaintenance.pipe(Effect.andThen(admission.abort(attempt.token))),
            );
          }
          retired.add(command.fence.updateId);
          yield* send({ type: "maintenance-aborted", fence: command.fence }).pipe(
            Effect.timeoutOption("1 second"),
            Effect.ignore,
          );
          return;
        }
        if (current !== undefined || retired.has(command.fence.updateId)) return;
        const attempt = { fence: command.fence, token: Symbol() };
        current = attempt;
        yield* Effect.gen(function* () {
          const result = yield* admission.drain(attempt.token, command.budgetMs);
          yield* sealGate.withPermit(
            Effect.gen(function* () {
              if (current !== attempt) return;
              const confirmed =
                result.kind === "sealed" &&
                (yield* admission.confirmSeal(attempt.token, reconcileSealed).pipe(
                  Effect.timeout(command.budgetMs),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to reconcile sealed server for maintenance", {
                      cause,
                    }).pipe(Effect.as(false)),
                  ),
                ));
              if (current !== attempt) return;
              yield* send({
                type: confirmed ? "maintenance-sealed" : "maintenance-deferred",
                fence: attempt.fence,
              }).pipe(Effect.timeoutOption("1 second"), Effect.ignore);
            }),
          );
        }).pipe(Effect.forkScoped({ startImmediately: true }));
      }),
    ).pipe(Effect.forkScoped);
    if (fence !== undefined)
      yield* reconcileShellLaunchers(identity.baseDir, fence.release.version);
    const censusComplete = admission.producerInventoryComplete;
    yield* send({
      type: "maintenance-ready",
      peer,
      ...(fence === undefined ? {} : { fence }),
      ...(censusComplete ? { censusComplete: true } : {}),
    });
  });

  return ServiceLauncherClient.of({
    managed,
    protocol: context?.protocol,
    requestUpdate,
    prepareTrial,
    maintenanceReady,
  });
});

export const layer = Layer.effect(ServiceLauncherClient, make());

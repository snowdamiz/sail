// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalJsonInEffect:off - Supervises the local sail-boatd sidecar process, stdout JSON handshake, and loopback SSE/HTTP bridge.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";
import type { DesktopBoatStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopCliShim from "../app/DesktopCliShim.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopWebLinks from "../app/DesktopWebLinks.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { BOAT_STATE_CHANNEL, BOAT_STATUS_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const SSE_RECONNECT_DELAY_MS = 1_500;
const SAIL_INTERNAL_SCHEMES = new Set(["sail:", "sail-dev:", "t3code:", "t3code-dev:"]);

export class DesktopBoatError extends Schema.TaggedError<DesktopBoatError>()("DesktopBoatError", {
  message: Schema.String,
}) {}

interface BoatHandshake {
  readonly ready: true;
  readonly port: number;
  readonly token: string;
  readonly mcpPort: number;
}

interface RunningDaemon {
  readonly child: NodeChildProcess.ChildProcessByStdio<
    null,
    NodeStream.Readable,
    NodeStream.Readable
  >;
  readonly baseUrl: string;
  readonly token: string;
  readonly mcpPort: number;
  readonly sseAbort: AbortController;
}

export interface DesktopBoatSupervisorService {
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly getStatus: Effect.Effect<DesktopBoatStatus>;
  readonly invoke: (command: string, args?: unknown) => Effect.Effect<unknown, DesktopBoatError>;
}

export class DesktopBoatSupervisor extends Context.Service<
  DesktopBoatSupervisor,
  DesktopBoatSupervisorService
>()("@t3tools/desktop/boat/DesktopBoatSupervisor") {}

export function resolveBoatDaemonBinary(input: {
  readonly envPath?: string | undefined;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly dirname: string;
  readonly platform: NodeJS.Platform;
}): string | null {
  const binaryName = input.platform === "win32" ? "sail-boatd.exe" : "sail-boatd";
  const candidates: string[] = [];
  if (input.envPath?.trim()) {
    candidates.push(input.envPath.trim());
  }
  if (input.isPackaged) {
    candidates.push(NodePath.join(input.resourcesPath, "sail-boat", binaryName));
  }
  // Dev / repo checkout fallbacks relative to apps/desktop/dist-electron or apps/desktop/src/boat
  for (const rel of [
    "../../native/sail-boat/target/release",
    "../../../native/sail-boat/target/release",
    "../../../../native/sail-boat/target/release",
    "../../native/sail-boat/target/debug",
    "../../../native/sail-boat/target/debug",
    "../../../../native/sail-boat/target/debug",
  ]) {
    candidates.push(NodePath.resolve(input.dirname, rel, binaryName));
  }
  for (const candidate of candidates) {
    try {
      if (NodeFS.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep searching
    }
  }
  return null;
}

export function parseBoatHandshakeLine(line: string): BoatHandshake | null {
  try {
    const parsed = JSON.parse(line) as Partial<BoatHandshake>;
    if (
      parsed &&
      parsed.ready === true &&
      typeof parsed.port === "number" &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      typeof parsed.mcpPort === "number"
    ) {
      return {
        ready: true,
        port: parsed.port,
        token: parsed.token,
        mcpPort: parsed.mcpPort,
      };
    }
  } catch {
    // ignore non-JSON lines
  }
  return null;
}

export function isSailInternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return SAIL_INTERNAL_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function parseSseFrame(rawFrame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of rawFrame.split(/\r?\n/)) {
    if (rawLine.startsWith(":")) continue;
    if (rawLine.startsWith("event:")) {
      event = rawLine.slice("event:".length).trim();
    } else if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

async function invokeDaemonHttp(
  daemon: RunningDaemon,
  command: string,
  args: unknown,
): Promise<unknown> {
  if (command === "get_state") {
    const response = await fetch(`${daemon.baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    if (!response.ok) {
      throw new Error(`get_state failed with HTTP ${response.status}`);
    }
    return await response.json();
  }
  const response = await fetch(`${daemon.baseUrl}/api/command/${encodeURIComponent(command)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args ?? {}),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    data?: unknown;
    error?: string;
  };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${command} failed with HTTP ${response.status}`);
  }
  return payload.data;
}

const { logInfo, logWarning } = makeComponentLogger("desktop-boat");

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
  const shell = yield* ElectronShell.ElectronShell;
  const context = yield* Effect.context<
    | ElectronWindow.ElectronWindow
    | DesktopWindow.DesktopWindow
    | DesktopWebLinks.DesktopWebLinks
    | ElectronShell.ElectronShell
  >();
  const runPromise = Effect.runPromiseWith(context);

  let status: DesktopBoatStatus = {
    phase: "stopped",
    baseUrl: null,
    mcpPort: null,
    error: null,
  };
  let running: RunningDaemon | null = null;
  let startingPromise: Promise<RunningDaemon> | null = null;
  let stopped = false;

  const isDaemonActive = (daemon: RunningDaemon) =>
    !daemon.sseAbort.signal.aborted && running === daemon && !stopped;

  const broadcast = (channel: string, payload: unknown) => {
    void runPromise(
      Effect.gen(function* () {
        const win = yield* electronWindow.currentMainOrFirst;
        if (Option.isSome(win) && !win.value.webContents.isDestroyed()) {
          win.value.webContents.send(channel, payload);
        }
      }).pipe(Effect.ignore),
    );
  };

  const setStatus = (next: DesktopBoatStatus) => {
    status = next;
    broadcast(BOAT_STATUS_CHANNEL, next);
  };

  const handleDesktopAction = (rawData: string) => {
    let parsed: { type?: unknown; url?: unknown };
    try {
      parsed = JSON.parse(rawData) as { type?: unknown; url?: unknown };
    } catch {
      return;
    }
    if (parsed.type === "activate") {
      void runPromise(desktopWindow.activate.pipe(Effect.ignore));
      return;
    }
    if (parsed.type === "openUrl" && typeof parsed.url === "string") {
      const targetUrl = parsed.url;
      if (isSailInternalUrl(targetUrl)) {
        void runPromise(webLinks.receive(targetUrl).pipe(Effect.ignore));
      } else {
        void runPromise(shell.openExternal(targetUrl).pipe(Effect.ignore));
      }
    }
  };

  const consumeSseLoop = async (daemon: RunningDaemon) => {
    while (isDaemonActive(daemon)) {
      try {
        const response = await fetch(`${daemon.baseUrl}/api/events`, {
          headers: { Authorization: `Bearer ${daemon.token}` },
          signal: daemon.sseAbort.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`SSE stream returned HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (isDaemonActive(daemon)) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const parsed = parseSseFrame(frame);
            if (!parsed) continue;
            if (parsed.event === "state") {
              try {
                broadcast(BOAT_STATE_CHANNEL, JSON.parse(parsed.data));
              } catch {
                // ignore malformed state frame
              }
            } else if (parsed.event === "desktop_action") {
              handleDesktopAction(parsed.data);
            }
          }
        }
      } catch (cause) {
        if (!isDaemonActive(daemon)) return;
        void runPromise(
          logWarning("sail-boatd SSE stream disconnected; reconnecting", {
            cause: cause instanceof Error ? cause.message : String(cause),
          }).pipe(Effect.ignore),
        );
        await new Promise((resolve) => setTimeout(resolve, SSE_RECONNECT_DELAY_MS));
      }
    }
  };

  const spawnDaemon = async (): Promise<RunningDaemon> => {
    stopped = false;
    setStatus({ phase: "starting", baseUrl: null, mcpPort: null, error: null });

    const binary = resolveBoatDaemonBinary({
      envPath: process.env.SAIL_BOATD_PATH,
      isPackaged: environment.isPackaged,
      resourcesPath: environment.resourcesPath,
      dirname: environment.dirname,
      platform: environment.platform,
    });
    if (!binary) {
      const error =
        "sail-boatd binary not found. Build native/sail-boat with `cargo build --release --manifest-path native/sail-boat/Cargo.toml`.";
      setStatus({ phase: "error", baseUrl: null, mcpPort: null, error });
      throw new Error(error);
    }

    const cliShim = DesktopCliShim.launcherPath(environment);
    const hasCliShim = NodeFS.existsSync(cliShim);
    const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
    const child = NodeChildProcess.spawn(binary, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SAIL_HOME: environment.stateDir,
        SAIL_DEEP_LINK_SCHEME: scheme,
        SAIL_APP_BUNDLE_ID: environment.isDevelopment ? "com.sail.desktop.dev" : "com.sail.desktop",
        SAIL_BOAT_CONTROL_PORT: "0",
        ...(hasCliShim ? { SAIL_DESKTOP_CLI: cliShim } : {}),
      },
    });

    const stderrLines: string[] = [];
    const stderrReader = NodeReadline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => {
      if (stderrLines.length > 30) stderrLines.shift();
      stderrLines.push(line);
    });

    const handshake = await new Promise<BoatHandshake>((resolve, reject) => {
      let settled = false;
      const stdoutReader = NodeReadline.createInterface({ input: child.stdout });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stdoutReader.close();
        try {
          child.kill("SIGTERM");
        } catch {}
        reject(
          new Error(`Timed out waiting for sail-boatd ready handshake (${STARTUP_TIMEOUT_MS}ms).`),
        );
      }, STARTUP_TIMEOUT_MS);

      const finishError = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdoutReader.close();
        reject(new Error(message));
      };

      stdoutReader.on("line", (line) => {
        const parsed = parseBoatHandshakeLine(line);
        if (!parsed || settled) return;
        settled = true;
        clearTimeout(timer);
        stdoutReader.close();
        resolve(parsed);
      });
      child.once("error", (err) => finishError(`Failed to spawn sail-boatd: ${err.message}`));
      child.once("exit", (code, signal) => {
        const tail = stderrLines.slice(-5).join(" | ");
        finishError(
          `sail-boatd exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})${tail ? `: ${tail}` : ""}`,
        );
      });
    });

    const daemon: RunningDaemon = {
      child,
      baseUrl: `http://127.0.0.1:${handshake.port}`,
      token: handshake.token,
      mcpPort: handshake.mcpPort,
      sseAbort: new AbortController(),
    };
    running = daemon;
    setStatus({
      phase: "ready",
      baseUrl: daemon.baseUrl,
      mcpPort: daemon.mcpPort,
      error: null,
    });
    void runPromise(
      logInfo("sail-boatd started", {
        port: handshake.port,
        mcpPort: handshake.mcpPort,
        binary,
      }).pipe(Effect.ignore),
    );

    child.once("exit", (code, signal) => {
      stderrReader.close();
      daemon.sseAbort.abort();
      if (running === daemon) {
        running = null;
        if (stopped) {
          setStatus({ phase: "stopped", baseUrl: null, mcpPort: null, error: null });
        } else {
          setStatus({
            phase: "error",
            baseUrl: null,
            mcpPort: null,
            error: `sail-boatd exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          });
        }
      }
    });

    void consumeSseLoop(daemon);
    return daemon;
  };

  const ensureRunning = async (): Promise<RunningDaemon> => {
    if (running) return running;
    if (!startingPromise) {
      startingPromise = spawnDaemon().finally(() => {
        startingPromise = null;
      });
    }
    return startingPromise;
  };

  const stopDaemon = async () => {
    stopped = true;
    const daemon = running;
    running = null;
    if (!daemon) {
      setStatus({ phase: "stopped", baseUrl: null, mcpPort: null, error: null });
      return;
    }
    daemon.sseAbort.abort();
    try {
      await fetch(`${daemon.baseUrl}/api/command/shutdown`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(1_000),
      });
    } catch {
      // fall through to signal termination
    }
    if (daemon.child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            daemon.child.kill("SIGKILL");
          } catch {}
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
        daemon.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          daemon.child.kill("SIGTERM");
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    setStatus({ phase: "stopped", baseUrl: null, mcpPort: null, error: null });
  };

  const invoke = Effect.fn("DesktopBoatSupervisor.invoke")(function* (
    command: string,
    args?: unknown,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const daemon = await ensureRunning();
        return await invokeDaemonHttp(daemon, command, args);
      },
      catch: (cause) =>
        new DesktopBoatError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  });

  return DesktopBoatSupervisor.of({
    start: Effect.promise(() =>
      ensureRunning().catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setStatus({ phase: "error", baseUrl: null, mcpPort: null, error: message });
        void runPromise(logWarning("sail-boatd failed to start", { message }).pipe(Effect.ignore));
      }),
    ).pipe(Effect.asVoid),
    stop: Effect.promise(() => stopDaemon()),
    getStatus: Effect.sync(() => status),
    invoke,
  });
});

export const layer = Layer.effect(DesktopBoatSupervisor, make);

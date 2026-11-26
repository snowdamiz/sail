#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The entrypoint's fallback when a run sets neither SAIL_PUBLIC_URL nor FLY_APP_NAME. */
const DEFAULT_PUBLIC_URL = "http://localhost:8080";
const READY_LINE = "T3 Code server is ready.";
const TOKEN_IN_LOGS = /pairing ?url:|token:|#token=/i;
const NOT_RUNNING_YET = "No running T3 Code server owns";
const PLANT_DIRS = ["/data/home/.local/bin", "/opt/npm-global/bin"];
const PLANTED_COMMANDS = ["t3", "id", "install", "mkdir", "setpriv", "env", "node", "sh", "ps"];
const PLANTED_LOG = "/data/home/.sail-smoke-planted";
const NATIVE_EXTERNALS_PROBE = `
const fff = await import("@ff-labs/fff-node");
if (!fff.binaryExists()) throw new Error("fff has no native library for this platform");
const pty = await import("node-pty");
const child = (pty.spawn ?? pty.default.spawn)("/bin/echo", ["pty-ok"], {});
let output = "";
child.onData((data) => { output += data; });
await new Promise((resolve) => child.onExit(resolve));
if (!output.includes("pty-ok")) throw new Error("node-pty printed " + JSON.stringify(output));
`;

export class SmokeDockerImageError extends Schema.TaggedError<SmokeDockerImageError>()(
  "SmokeDockerImageError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.step}: ${this.detail}`;
  }
}

const IssuedPairing = Schema.Struct({
  credential: Schema.String,
  pairUrl: Schema.String,
});
const decodeIssuedPairing = Schema.decodeEffect(Schema.fromJsonString(IssuedPairing));
const EnvironmentDescriptor = Schema.Struct({
  platform: Schema.Struct({ os: Schema.String, arch: Schema.String }),
});
const BrowserSession = Schema.Struct({ authenticated: Schema.Literal(true) });
const SessionState = Schema.Struct({ authenticated: Schema.Boolean });

const fail = (step: string, detail: string) => new SmokeDockerImageError({ step, detail });

export const redactTokens = (text: string) =>
  text.replace(/(pairing ?url:\s*\S*?#token=|#token=|token[:=]\s*)[^\s&"']+/gi, "$1<redacted>");

const docker = Effect.fn("smoke-docker-image.docker")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("docker", args, { stdout: "pipe", stderr: "pipe" }),
  );
  const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
    stream.pipe(Stream.decodeText(), Stream.mkString);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [text(child.stdout), text(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  if (Number(exitCode) !== 0) {
    return yield* fail(
      `docker ${args[0]}`,
      redactTokens(stderr.trim() || stdout.trim()) || `exited with code ${exitCode}`,
    );
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}, Effect.scoped);

const startContainer = Effect.fn("smoke-docker-image.startContainer")(function* (input: {
  readonly image: string;
  readonly platform: Option.Option<string>;
}) {
  const suffix = `${yield* Clock.currentTimeMillis}-${yield* Random.nextIntBetween(0, 1e6)}`;
  const volume = yield* Effect.acquireRelease(
    docker(["volume", "create", `sail-smoke-${suffix}`]).pipe(Effect.map((out) => out.stdout)),
    (name) => docker(["volume", "rm", "--force", name]).pipe(Effect.ignore),
  );
  const startedAt = yield* Clock.currentTimeMillis;
  const id = yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--name",
      `sail-smoke-${suffix}`,
      ...Option.match(input.platform, { onNone: () => [], onSome: (p) => ["--platform", p] }),
      "--publish",
      "127.0.0.1::8080",
      "--volume",
      `${volume}:/data`,
      input.image,
    ]).pipe(Effect.map((out) => out.stdout)),
    (container) => docker(["rm", "--force", "--volumes", container]).pipe(Effect.ignore),
  );
  return { id, startedAt };
});

const publishedOrigin = Effect.fn("smoke-docker-image.publishedOrigin")(function* (id: string) {
  const published = (yield* docker(["port", id, "8080/tcp"])).stdout.split("\n")[0] ?? "";
  if (published === "") return yield* fail("docker port", "port 8080 is not published");
  return `http://${published}`;
});

/** Retries `attempt` until it succeeds, stopping at once on an error `retryable` rejects. */
const within = <A, E extends { readonly message: string }, R>(
  step: string,
  timeoutSeconds: number,
  attempt: Effect.Effect<A, E, R>,
  retryable: (error: E) => boolean,
) =>
  attempt.pipe(
    Effect.retry({ schedule: Schedule.spaced("250 millis"), while: retryable }),
    Effect.timeoutOrElse({
      duration: `${timeoutSeconds} seconds`,
      orElse: () => Effect.fail(fail(step, `not done within ${timeoutSeconds} seconds`)),
    }),
  );

const waitForApp = Effect.fn("smoke-docker-image.waitForApp")(function* (
  id: string,
  timeoutSeconds: number,
) {
  const client = yield* HttpClient.HttpClient;
  const origin = yield* publishedOrigin(id);
  yield* within(
    "GET /",
    timeoutSeconds,
    Effect.gen(function* () {
      const state = (yield* docker(["inspect", "--format", "{{.State.Status}}", id])).stdout;
      if (state !== "running") return yield* fail("container", `is ${state}, not running`);
      yield* client.get(`${origin}/`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError((error) => fail("GET /", error.message)),
      );
    }),
    (error) => error._tag === "SmokeDockerImageError" && error.step === "GET /",
  );
  return origin;
});

const expectServerRunsAsSail = Effect.fn("smoke-docker-image.expectServerRunsAsSail")(function* (
  id: string,
) {
  const users = (yield* docker(["exec", id, "/bin/ps", "-o", "user=", "--ppid", "1"])).stdout
    .split("\n")
    .map((user) => user.trim())
    .filter((user) => user !== "");
  if (users.length === 0 || users.some((user) => user !== "sail")) {
    return yield* fail("server user", `PID 1's children run as ${users.join(", ") || "nobody"}`);
  }
});

const pair = Effect.fn("smoke-docker-image.pair")(function* (
  container: string,
  origin: string,
  timeoutSeconds: number,
) {
  const client = yield* HttpClient.HttpClient;
  const issued = yield* within(
    "t3 auth pairing create",
    timeoutSeconds,
    docker([
      "exec",
      "--user",
      "sail",
      container,
      "t3",
      "auth",
      "pairing",
      "create",
      "--json",
      "--require-running",
    ]),
    (error) => error._tag === "SmokeDockerImageError" && error.detail.includes(NOT_RUNNING_YET),
  ).pipe(
    Effect.flatMap((out) => decodeIssuedPairing(out.stdout)),
    Effect.mapError((error) => fail("t3 auth pairing create", redactTokens(error.message))),
  );
  const link = yield* Effect.try({
    try: () => new URL(issued.pairUrl),
    catch: () => fail("pairing link", "pairUrl is not a URL"),
  });
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  if (`${link.origin}${link.pathname}` !== `${DEFAULT_PUBLIC_URL}/pair`) {
    return yield* fail("pairing link", `points at ${link.origin}${link.pathname}`);
  }
  if (token !== issued.credential) {
    return yield* fail("pairing link", "does not carry the issued token");
  }

  const redeemed = yield* HttpClientRequest.post(`${origin}/api/auth/browser-session`).pipe(
    HttpClientRequest.setHeader("origin", origin),
    HttpClientRequest.bodyJson({ credential: token }),
    Effect.flatMap(client.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
  );
  yield* HttpClientResponse.schemaBodyJson(BrowserSession)(redeemed);
  const session = yield* HttpClientRequest.get(`${origin}/api/auth/session`).pipe(
    HttpClientRequest.setHeader("cookie", Cookies.toCookieHeader(redeemed.cookies)),
    client.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionState)),
  );
  if (!session.authenticated) {
    return yield* fail("GET /api/auth/session", "the redeemed cookie is not signed in");
  }
  return issued.credential;
});

const expectProductionIcons = Effect.fn("smoke-docker-image.expectProductionIcons")(function* (
  origin: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const developmentIcon = yield* fs.readFile(
    path.join(repoRoot, "assets/dev/blueprint-web-favicon.ico"),
  );
  const served = new Uint8Array(
    yield* client.get(`${origin}/favicon.ico`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.arrayBuffer),
    ),
  );
  if (
    served.length === developmentIcon.length &&
    served.every((byte, index) => byte === developmentIcon[index])
  ) {
    return yield* fail("web client", "/favicon.ico is the development icon");
  }
});

/** A sail-writable command the image runs as root would let an agent take over the container. */
const expectRootIgnoresSailCommands = Effect.fn("smoke-docker-image.expectRootIgnoresSailCommands")(
  function* (id: string, timeoutSeconds: number) {
    const plant = PLANT_DIRS.flatMap((dir) =>
      PLANTED_COMMANDS.map(
        (command) =>
          `mkdir -p ${dir} && printf '#!/bin/sh\\necho "$(/usr/bin/id -u) $0" >> ${PLANTED_LOG}\\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin exec ${command} "$@"\\n' > ${dir}/${command} && chmod +x ${dir}/${command}`,
      ),
    ).join(" && ");
    yield* docker(["exec", "--user", "sail", id, "/bin/sh", "-c", plant]);
    yield* docker(["restart", "-t", "30", id]);
    yield* waitForApp(id, timeoutSeconds);
    yield* expectServerRunsAsSail(id);
    yield* docker(["exec", id, "id", "-u"]);
    yield* docker(["exec", id, "t3", "--version"]);
    yield* docker(["exec", id, "sh", "-lc", "id -u"]);
    const ranAsRoot = (yield* docker([
      "exec",
      id,
      "/bin/sh",
      "-c",
      `/bin/cat ${PLANTED_LOG} || true`,
    ])).stdout
      .split("\n")
      .filter((line) => line.startsWith("0 "));
    if (ranAsRoot.length > 0) {
      return yield* fail("root commands", `root ran sail-writable ${ranAsRoot.join(", ")}`);
    }
    for (const shell of [
      ["sh", "-lc"],
      ["bash", "-ic"],
    ]) {
      const home = (yield* docker(["exec", id, ...shell, "echo $HOME"])).stdout.split("\n").at(-1);
      if (home !== "/root") {
        return yield* fail("root shells", `${shell.join(" ")} runs root with HOME=${home}`);
      }
    }
  },
);

export const smokeDockerImage = Effect.fn("smokeDockerImage")(function* (input: {
  readonly image: string;
  readonly platform: Option.Option<string>;
  readonly timeoutSeconds: number;
}) {
  const client = yield* HttpClient.HttpClient;
  const container = yield* startContainer(input);
  yield* Effect.gen(function* () {
    const origin = yield* waitForApp(container.id, input.timeoutSeconds);
    const readySeconds = ((yield* Clock.currentTimeMillis) - container.startedAt) / 1000;
    yield* Console.log(`GET / returned 200 ${readySeconds.toFixed(1)} s after docker run.`);

    const descriptor = yield* client
      .get(`${origin}/.well-known/t3/environment`)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(EnvironmentDescriptor)));
    yield* Console.log(`Environment: ${descriptor.platform.os} ${descriptor.platform.arch}.`);
    yield* expectServerRunsAsSail(container.id);
    yield* expectProductionIcons(origin);

    const credential = yield* pair(container.id, origin, input.timeoutSeconds);
    yield* Console.log(
      "A pairing link from t3 auth pairing create redeemed to a signed-in session.",
    );

    yield* within(
      "ready line",
      input.timeoutSeconds,
      docker(["logs", container.id]).pipe(
        Effect.flatMap((logs) =>
          `${logs.stdout}\n${logs.stderr}`.includes(READY_LINE)
            ? Effect.void
            : Effect.fail(fail("ready line", `the logs lack "${READY_LINE}"`)),
        ),
      ),
      (error) => error._tag === "SmokeDockerImageError" && error.step === "ready line",
    );
    const logs = yield* docker(["logs", container.id]);
    const output = `${logs.stdout}\n${logs.stderr}`;
    if (output.includes(credential) || TOKEN_IN_LOGS.test(output)) {
      return yield* fail("logs", "the container logs carry a pairing token");
    }

    yield* docker([
      "exec",
      "--user",
      "sail",
      "--workdir",
      "/opt/sail/server",
      container.id,
      "node",
      "--input-type=module",
      "--eval",
      NATIVE_EXTERNALS_PROBE,
    ]);
    yield* Console.log("node-pty ran a command in a PTY, and fff found its native library.");

    yield* expectRootIgnoresSailCommands(container.id, input.timeoutSeconds);
    yield* Console.log(
      "After a restart, root ran no command sail planted on PATH, and root shells use /root.",
    );
  }).pipe(
    Effect.tapError(() =>
      docker(["logs", "--tail", "200", container.id]).pipe(
        Effect.flatMap((logs) => Console.error(redactTokens(`${logs.stdout}\n${logs.stderr}`))),
        Effect.ignore,
      ),
    ),
  );
  yield* Console.log(`Smoke passed for ${input.image}.`);
}, Effect.scoped);

const command = Command.make(
  "smoke-docker-image",
  {
    image: Flag.String("image").pipe(
      Flag.withDescription("Image to run, such as sail-server:abc1234."),
    ),
    platform: Flag.String("platform").pipe(
      Flag.withDescription("Platform to run, such as linux/amd64 for an emulated image."),
      Flag.optional,
    ),
    timeoutSeconds: Flag.Int("timeout-seconds").pipe(
      Flag.withDescription("Seconds to wait for each readiness step."),
      Flag.withDefault(120),
    ),
  },
  smokeDockerImage,
).pipe(
  Command.withDescription("Run a server image on a fresh volume, then pair a client with it."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}

#!/usr/bin/env node
/** Proves a server image serves the app, keeps tokens out of its logs, and pairs a client. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
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

/** What the image's entrypoint advertises when the run sets neither SAIL_PUBLIC_URL nor FLY_APP_NAME. */
export const DEFAULT_PUBLIC_URL = "http://localhost:8080";
const READY_LINE = "T3 Code server is ready.";
const TOKEN_IN_LOGS = /pairingUrl:|Token:|#token=/;

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
    return yield* fail(`docker ${args[0]}`, stderr.trim() || `exited with code ${exitCode}`);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}, Effect.scoped);

/** Removed by id on every exit, so a failed smoke leaves no container or volume behind. */
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
  const published = (yield* docker(["port", id, "8080/tcp"])).stdout.split("\n")[0] ?? "";
  return { id, startedAt, origin: `http://${published}` };
});

const waitForApp = Effect.fn("smoke-docker-image.waitForApp")(function* (
  origin: string,
  timeoutSeconds: number,
) {
  const client = yield* HttpClient.HttpClient;
  yield* client.get(`${origin}/`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.timeoutOrElse({
      duration: `${timeoutSeconds} seconds`,
      orElse: () => Effect.fail(fail("GET /", `no 200 within ${timeoutSeconds} seconds`)),
    }),
  );
});

const pair = Effect.fn("smoke-docker-image.pair")(function* (container: string, origin: string) {
  const client = yield* HttpClient.HttpClient;
  const issued = yield* docker([
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
  ]).pipe(
    Effect.flatMap((out) => decodeIssuedPairing(out.stdout)),
    Effect.mapError((error) => fail("t3 auth pairing create", error.message)),
  );
  const link = new URL(issued.pairUrl);
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  if (`${link.origin}/pair` !== `${DEFAULT_PUBLIC_URL}/pair` || token !== issued.credential) {
    return yield* fail("pairing link", `${link.origin}${link.pathname} does not carry the token`);
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
});

export const smokeDockerImage = Effect.fn("smokeDockerImage")(function* (input: {
  readonly image: string;
  readonly platform: Option.Option<string>;
  readonly timeoutSeconds: number;
}) {
  const client = yield* HttpClient.HttpClient;
  const container = yield* startContainer(input);
  yield* Effect.gen(function* () {
    yield* waitForApp(container.origin, input.timeoutSeconds);
    const readySeconds = ((yield* Clock.currentTimeMillis) - container.startedAt) / 1000;
    yield* Console.log(`GET / returned 200 ${readySeconds.toFixed(1)} s after docker run.`);

    const descriptor = yield* client
      .get(`${container.origin}/.well-known/t3/environment`)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(EnvironmentDescriptor)));
    yield* Console.log(`Environment: ${descriptor.platform.os} ${descriptor.platform.arch}.`);

    const serverUser = (yield* docker(["exec", container.id, "ps", "-o", "user=", "--ppid", "1"]))
      .stdout;
    if (serverUser !== "sail") {
      return yield* fail("server user", `the server runs as ${serverUser || "nobody"}, not sail`);
    }

    yield* pair(container.id, container.origin);
    yield* Console.log(
      "A pairing link from t3 auth pairing create redeemed to a signed-in session.",
    );

    const logs = yield* docker(["logs", container.id]);
    const output = `${logs.stdout}\n${logs.stderr}`;
    if (!output.includes(READY_LINE)) {
      return yield* fail("logs", `the container logs lack "${READY_LINE}"`);
    }
    if (TOKEN_IN_LOGS.test(output)) {
      return yield* fail("logs", "the container logs carry a pairing token");
    }
  }).pipe(
    Effect.tapError(() =>
      docker(["logs", "--tail", "200", container.id]).pipe(
        Effect.flatMap((logs) => Console.error(`${logs.stdout}\n${logs.stderr}`)),
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
      Flag.withDescription("Seconds to wait for GET / after docker run."),
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

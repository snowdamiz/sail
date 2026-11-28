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
import * as Ref from "effect/Ref";
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

import { resolveDesktopWebAssetBrand } from "./build-desktop-artifact.ts";
import { resolveWebIconOverrides } from "./lib/brand-assets.ts";

/** The entrypoint's fallback when a run sets neither SAIL_PUBLIC_URL nor FLY_APP_NAME. */
const DEFAULT_PUBLIC_URL = "http://localhost:8080";
const READY_LINE = "T3 Code server is ready.";
const TOKEN_IN_LOGS = /pairing ?url:|token:|#token=/i;
const NOT_RUNNING_YET = "No running T3 Code server owns";
const PLANT_DIRS = ["/data/home/.local/bin"];
const PLANTED_COMMANDS = [
  "t3",
  "id",
  "install",
  "mkdir",
  "setpriv",
  "env",
  "node",
  "sh",
  "ps",
  "sail-smoke-probe",
];
const PLANTED_LOG = "/data/home/.sail-smoke-planted";
const REMOVED_AGENT_CLIS = ["claude", "codex", "opencode"];
const NO_NEW_PRIVS = /^NoNewPrivs:[ \t]+1$/m;
const T3_PRIVILEGE_PROBE = `--import=data:text/javascript,${encodeURIComponent(
  `import { readFileSync } from "node:fs";
  process.stderr.write(readFileSync("/proc/self/status", "utf8").match(/^NoNewPrivs:.*$/m)[0] + "\\n");`,
)}`;
const NATIVE_EXTERNALS_PROBE = `
const { FileFinder } = await import("@ff-labs/fff-node");
const finder = FileFinder.create({ basePath: "/opt/sail/server" });
if (!finder.ok) throw new Error("fff did not load: " + String(finder.error));
finder.value.destroy();
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
  serverVersion: Schema.String,
});
const BrowserSession = Schema.Struct({ authenticated: Schema.Literal(true) });
const SessionState = Schema.Struct({ authenticated: Schema.Boolean });

const fail = (step: string, detail: string) => new SmokeDockerImageError({ step, detail });

export const redactTokens = (text: string, secrets: ReadonlyArray<string> = []) =>
  secrets.reduce(
    (redacted, secret) => (secret === "" ? redacted : redacted.replaceAll(secret, "<redacted>")),
    text.replace(
      /(pairing ?url:\s*\S*?#token=|#token=|["']?(?:token|credential)["']?\s*[:=]\s*["']?)[^\s&"',}]+/gi,
      "$1<redacted>",
    ),
  );

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

const LOCAL_CONTEXT_FILES = [
  ".env",
  ".env.local",
  ".env.production.local",
  ".envrc",
  ".npmrc",
  ".gemini/settings.json",
  ".DS_Store",
  ".agents/config.json",
  ".claude/settings.local.json",
  ".cursor/settings.json",
  ".idea/workspace.xml",
  ".vscode/settings.json",
  ".t3/state.sqlite",
  ".gstack/state.json",
  ".plans/local.md",
  ".audit/local.md",
  ".logs/local.log",
  ".generated/state.json",
  ".android-cache/state.json",
];

export const expectCleanBuildContext = Effect.fn("smoke-docker-image.expectCleanBuildContext")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "sail-smoke-context-" });
    const context = path.join(temp, "context");
    const output = path.join(temp, "output");
    const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const excluded = ["", "apps/web/", "apps/server/"].flatMap((prefix) =>
      LOCAL_CONTEXT_FILES.map((file) => prefix + file),
    );
    const included = ["package.json", ".env.example", "apps/web/.env.example"];
    for (const file of [...excluded, ...included]) {
      const target = path.join(context, file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, "synthetic fixture");
    }
    yield* fs.copyFile(path.join(root, ".dockerignore"), path.join(context, ".dockerignore"));
    yield* fs.writeFileString(path.join(context, "Dockerfile"), "FROM scratch\nCOPY . /context\n");
    yield* docker(["buildx", "build", "--output", `type=local,dest=${output}`, context]);
    const leaked = yield* Effect.filter(excluded, (file) =>
      fs.exists(path.join(output, "context", file)),
    );
    if (leaked.length > 0) {
      return yield* fail("build context", `included local files: ${leaked.join(", ")}`);
    }
    for (const file of included) {
      if (!(yield* fs.exists(path.join(output, "context", file)))) {
        return yield* fail("build context", `excluded build input ${file}`);
      }
    }
    yield* Console.log("Docker excluded local state and credential files at every tested depth.");
  },
  Effect.scoped,
);

const expectCleanRuntime = Effect.fn("smoke-docker-image.expectCleanRuntime")(function* (
  image: string,
  platform: Option.Option<string>,
) {
  const result = yield* docker([
    "run",
    "--rm",
    ...Option.match(platform, { onNone: () => [], onSome: (p) => ["--platform", p] }),
    "--entrypoint",
    "/usr/bin/find",
    image,
    "/root",
    "/tmp",
    "-maxdepth",
    "5",
    "(",
    "-name",
    "node-compile-cache",
    "-o",
    "-name",
    "opencode",
    ")",
    "-print",
  ]);
  if (result.stdout !== "") {
    return yield* fail("runtime leftovers", result.stdout);
  }
});

const startContainer = Effect.fn("smoke-docker-image.startContainer")(function* (input: {
  readonly image: string;
  readonly platform: Option.Option<string>;
  readonly preownedHome?: string;
  readonly user?: "sail";
}) {
  const suffix = `${yield* Clock.currentTimeMillis}-${yield* Random.nextIntBetween(0, 1e6)}`;
  const volume = yield* Effect.acquireRelease(
    docker(["volume", "create", `sail-smoke-${suffix}`]).pipe(Effect.map((out) => out.stdout)),
    (name) => docker(["volume", "rm", "--force", name]).pipe(Effect.ignore),
  );
  const platformArgs = Option.match(input.platform, {
    onNone: () => [],
    onSome: (p) => ["--platform", p],
  });
  if (input.preownedHome !== undefined || input.user === "sail") {
    yield* docker([
      "run",
      "--rm",
      ...platformArgs,
      "--volume",
      `${volume}:/data`,
      "--entrypoint",
      "/usr/bin/chown",
      input.image,
      "1000:1000",
      "/data",
    ]);
  }
  const startedAt = yield* Clock.currentTimeMillis;
  const id = yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--name",
      `sail-smoke-${suffix}`,
      ...platformArgs,
      ...(input.user === undefined ? [] : ["--user", input.user]),
      ...(input.preownedHome === undefined ? [] : ["--env", `SAIL_HOME=${input.preownedHome}`]),
      "--publish",
      "127.0.0.1::8080",
      "--volume",
      `${volume}:/data`,
      input.image,
    ]).pipe(Effect.map((out) => out.stdout)),
    (container) => docker(["rm", "--force", "--volumes", container]).pipe(Effect.ignore),
  );
  return { id, startedAt, volume, platformArgs };
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

const expectDataOwnership = Effect.fn("smoke-docker-image.expectDataOwnership")(function* (
  id: string,
  sailHome: string,
) {
  const paths = ["/data", "/data/home", sailHome];
  for (const path of paths) {
    const owner = (yield* docker(["exec", id, "/usr/bin/stat", "-c", "%u:%g", path])).stdout;
    if (owner !== "1000:1000") {
      return yield* fail("volume ownership", `${path} is owned by ${owner}, not sail`);
    }
  }
});

const expectNoNewPrivs = Effect.fn("smoke-docker-image.expectNoNewPrivs")(function* (id: string) {
  for (const user of ["root", "sail"]) {
    const asSail = yield* docker([
      "exec",
      "--user",
      user,
      id,
      "as-sail",
      "/usr/bin/grep",
      "^NoNewPrivs:",
      "/proc/self/status",
    ]);
    if (!NO_NEW_PRIVS.test(asSail.stdout)) {
      return yield* fail("privilege drop", `as-sail invoked by ${user} did not set no-new-privs`);
    }
    const t3 = yield* docker([
      "exec",
      "--user",
      user,
      "--env",
      `NODE_OPTIONS=${T3_PRIVILEGE_PROBE}`,
      id,
      "t3",
      "--version",
    ]);
    if (!NO_NEW_PRIVS.test(t3.stderr)) {
      return yield* fail("privilege drop", `t3 invoked by ${user} did not set no-new-privs`);
    }
  }
  const pids = (yield* docker(["exec", id, "/bin/ps", "-o", "pid=", "--ppid", "1"])).stdout
    .split(/\s+/)
    .filter((pid) => pid !== "");
  for (const pid of pids) {
    const serverStatus = (yield* docker([
      "exec",
      id,
      "/usr/bin/grep",
      "^NoNewPrivs:",
      `/proc/${pid}/status`,
    ])).stdout;
    if (!NO_NEW_PRIVS.test(serverStatus)) {
      return yield* fail("privilege drop", `server PID ${pid} did not inherit no-new-privs`);
    }
  }
});

const expectSignedInSession = Effect.fn("smoke-docker-image.expectSignedInSession")(function* (
  origin: string,
  cookie: string,
) {
  const client = yield* HttpClient.HttpClient;
  const session = yield* HttpClientRequest.get(`${origin}/api/auth/session`).pipe(
    HttpClientRequest.setHeader("cookie", cookie),
    client.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionState)),
  );
  if (!session.authenticated) {
    return yield* fail("GET /api/auth/session", "the redeemed cookie is not signed in");
  }
});

const pair = Effect.fn("smoke-docker-image.pair")(function* (
  container: string,
  origin: string,
  timeoutSeconds: number,
  secrets: Ref.Ref<ReadonlyArray<string>>,
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
    Effect.flatMap((out) =>
      decodeIssuedPairing(out.stdout).pipe(
        Effect.mapError(() => fail("t3 auth pairing create", "printed no pairing JSON")),
      ),
    ),
  );
  yield* Ref.set(secrets, [issued.credential]);
  const link = yield* Effect.try({
    try: () => new URL(issued.pairUrl),
    catch: () => fail("pairing link", "pairUrl is not a URL"),
  });
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  if (`${link.origin}${link.pathname}` !== `${DEFAULT_PUBLIC_URL}/pair`) {
    return yield* fail("pairing link", `is not on ${DEFAULT_PUBLIC_URL}/pair`);
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
  const cookie = Cookies.toCookieHeader(redeemed.cookies);
  yield* Ref.set(secrets, [issued.credential, cookie]);
  yield* expectSignedInSession(origin, cookie);
  return { credential: issued.credential, cookie };
});

/** Desktop releases brand the web client from the version; the image must match that rule. */
const expectReleaseIcons = Effect.fn("smoke-docker-image.expectReleaseIcons")(function* (
  origin: string,
  serverVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const brand = resolveDesktopWebAssetBrand(serverVersion);
  for (const icon of resolveWebIconOverrides(brand, ".")) {
    const expected = yield* fs.readFile(path.join(repoRoot, icon.sourceRelativePath));
    const served = new Uint8Array(
      yield* client.get(new URL(icon.targetRelativePath, `${origin}/`).href).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
      ),
    );
    if (
      served.length !== expected.length ||
      served.some((byte, index) => byte !== expected[index])
    ) {
      return yield* fail("web client", `${icon.targetRelativePath} is not the ${brand} icon`);
    }
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
    for (const name of REMOVED_AGENT_CLIS) {
      yield* docker(["exec", id, "/bin/sh", "-c", `test ! -e /usr/local/bin/${name}`]);
    }
    yield* docker([
      "exec",
      id,
      "/bin/sh",
      "-c",
      'sail-smoke-probe; touch "$HOME/.sail-smoke-root-home"',
    ]);
    yield* docker(["exec", id, "bash", "-ic", "sail-smoke-probe; true"]);
    const planted = (yield* docker([
      "exec",
      id,
      "/bin/sh",
      "-c",
      `/bin/cat ${PLANTED_LOG} || true`,
    ])).stdout.split("\n");
    const ranAsRoot = planted.filter((line) => line.startsWith("0 "));
    if (ranAsRoot.length > 0) {
      return yield* fail("root commands", `root ran sail-writable ${ranAsRoot.join(", ")}`);
    }
    const notSails = (yield* docker([
      "exec",
      id,
      "/usr/bin/find",
      "/data/home",
      "-xdev",
      "!",
      "-user",
      "sail",
    ])).stdout;
    if (notSails !== "") {
      return yield* fail(
        "root commands",
        `left files sail does not own: ${notSails.replace(/\n/g, ", ")}`,
      );
    }
    for (const user of [["--user", "sail"], []]) {
      const status = (yield* docker([
        "exec",
        ...user,
        id,
        "as-sail",
        "/usr/bin/grep",
        "^NoNewPrivs:",
        "/proc/self/status",
      ])).stdout;
      if (!NO_NEW_PRIVS.test(status)) {
        return yield* fail("as-sail", "as-sail did not set no-new-privs");
      }
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

interface SmokeInput {
  readonly image: string;
  readonly platform: Option.Option<string>;
  readonly timeoutSeconds: number;
}

const logContainerFailure = Effect.fn("smoke-docker-image.logContainerFailure")(
  function* (id: string, secrets: ReadonlyArray<string>) {
    const logs = yield* docker(["logs", "--tail", "200", id]);
    yield* Console.error(redactTokens(`${logs.stdout}\n${logs.stderr}`, secrets));
  },
  (effect) => Effect.ignore(effect),
);

const smokeFreshVolume = Effect.fn("smoke-docker-image.smokeFreshVolume")(function* (
  input: SmokeInput,
) {
  const client = yield* HttpClient.HttpClient;
  const secrets = yield* Ref.make<ReadonlyArray<string>>([]);
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
    yield* expectDataOwnership(container.id, "/data/sail");
    yield* expectNoNewPrivs(container.id);
    yield* expectReleaseIcons(origin, descriptor.serverVersion);

    const { credential, cookie } = yield* pair(container.id, origin, input.timeoutSeconds, secrets);
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
    yield* Console.log("node-pty ran a command in a PTY, and fff loaded its native library.");

    yield* docker([
      "exec",
      container.id,
      "/usr/bin/chown",
      "--no-dereference",
      "root:root",
      "/data",
    ]);
    yield* docker(["restart", "-t", "30", container.id]);
    const restartedOrigin = yield* waitForApp(container.id, input.timeoutSeconds);
    yield* expectDataOwnership(container.id, "/data/sail");
    yield* expectSignedInSession(restartedOrigin, cookie);
    yield* Console.log(
      "An existing volume with a root-owned mount retained its signed-in session after restart.",
    );

    yield* expectRootIgnoresSailCommands(container.id, input.timeoutSeconds);
    yield* Console.log(
      "After a restart, root ran no command sail planted on PATH, and root shells use /root.",
    );
  }).pipe(
    Effect.catch((error) =>
      Ref.get(secrets).pipe(
        Effect.flatMap((issued) => Effect.fail(fail("smoke", redactTokens(error.message, issued)))),
      ),
    ),
    Effect.tapError(() =>
      Ref.get(secrets).pipe(Effect.flatMap((issued) => logContainerFailure(container.id, issued))),
    ),
  );
}, Effect.scoped);

const smokePreownedVolume = Effect.fn("smoke-docker-image.smokePreownedVolume")(function* (
  input: SmokeInput,
) {
  const preownedHome = "/data/home/sail";
  const { id, volume, platformArgs } = yield* startContainer({ ...input, preownedHome });
  const expectReady = Effect.gen(function* () {
    yield* waitForApp(id, input.timeoutSeconds);
    yield* expectServerRunsAsSail(id);
    yield* docker([
      "exec",
      "--user",
      "sail",
      id,
      "/usr/bin/test",
      "-s",
      `${preownedHome}/userdata/statev2.sqlite`,
    ]);
  });
  yield* Effect.gen(function* () {
    yield* expectReady;
    yield* expectDataOwnership(id, preownedHome);
    const marker = `${preownedHome}/.smoke-persistence`;
    yield* docker([
      "exec",
      id,
      "/usr/bin/install",
      "-o",
      "2000",
      "-g",
      "1000",
      "-m",
      "0640",
      "/dev/null",
      marker,
    ]);
    yield* docker(["exec", id, "/usr/bin/chown", "2000:1000", preownedHome]);
    yield* docker(["exec", id, "/usr/bin/chmod", "0770", preownedHome]);
    yield* docker(["restart", "-t", "30", id]);
    yield* expectReady;
    const metadata = (yield* docker([
      "exec",
      id,
      "/usr/bin/stat",
      "-c",
      "%u:%g %a",
      marker,
      preownedHome,
    ])).stdout;
    if (metadata !== "2000:1000 640\n2000:1000 770") {
      return yield* fail(
        "volume metadata",
        `restart changed the file or directory metadata: ${metadata.replace("\n", ", ")}`,
      );
    }
    yield* Console.log(
      "A volume with nested SAIL_HOME preserved existing file ownership and directory metadata across restart.",
    );

    const target = "/data/.smoke-root-owned";
    yield* docker(["stop", "-t", "30", id]);
    yield* docker([
      "run",
      "--rm",
      ...platformArgs,
      "--volume",
      `${volume}:/data`,
      "--entrypoint",
      "/bin/sh",
      input.image,
      "-ec",
      '/usr/bin/install -d -m 0755 "$1"; /usr/bin/mv -T "$2" "$2.saved"; /usr/bin/ln -sT "$1" "$2"',
      "sh",
      target,
      preownedHome,
    ]);
    yield* docker(["start", id]);
    const exit = (yield* docker(["wait", id]).pipe(
      Effect.timeout(`${input.timeoutSeconds} seconds`),
    )).stdout;
    if (exit !== "1") {
      return yield* fail(
        "volume symlink",
        `expected startup to refuse the root-owned state directory (exit ${exit})`,
      );
    }
    const targetMetadata = (yield* docker([
      "run",
      "--rm",
      ...platformArgs,
      "--volume",
      `${volume}:/data:ro`,
      "--entrypoint",
      "/usr/bin/stat",
      input.image,
      "-c",
      "%u:%g %a",
      target,
    ])).stdout;
    if (targetMetadata !== "0:0 755") {
      return yield* fail(
        "volume symlink",
        `restart changed the target metadata to ${targetMetadata}`,
      );
    }
    yield* Console.log(
      "Startup refused the symlink to a root-owned SAIL_HOME and preserved its target metadata.",
    );
  }).pipe(Effect.tapError(() => logContainerFailure(id, [])));
}, Effect.scoped);

const smokeSailUser = Effect.fn("smoke-docker-image.smokeSailUser")(function* (input: SmokeInput) {
  const { id } = yield* startContainer({ ...input, user: "sail" });
  yield* Effect.gen(function* () {
    yield* waitForApp(id, input.timeoutSeconds);
    yield* expectServerRunsAsSail(id);
    yield* expectNoNewPrivs(id);
    yield* Console.log("The server retained no-new-privs when launched with --user sail.");
  }).pipe(Effect.tapError(() => logContainerFailure(id, [])));
}, Effect.scoped);

export const smokeDockerImage = Effect.fn("smokeDockerImage")(function* (input: SmokeInput) {
  yield* expectCleanBuildContext();
  yield* expectCleanRuntime(input.image, input.platform);
  yield* smokeFreshVolume(input);
  yield* smokePreownedVolume(input);
  yield* smokeSailUser(input);
  yield* Console.log(`Smoke passed for ${input.image}.`);
});

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

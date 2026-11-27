// @effect-diagnostics nodeBuiltinImport:off globalConsole:off extendsNativeError:off - A plain Node CLI that lets a fixture container drive the computer-side fake `boat`.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { caddyContainer, caddyDir } from "../lib/caddy.ts";
import { docker, DockerError, NETWORK } from "../lib/docker.ts";
import { standInHome } from "../lib/state.ts";

const BOAT = NodePath.join(import.meta.dirname, "boat");
/** The fake `boat` this relay runs keeps its records here; callers cannot move it. */
const HOME = standInHome("boat", "FAKE_BOAT_HOME");
const CLIENT = NodePath.join(import.meta.dirname, "relay-client.ts");
const HOSTS_MARKER = "# fake-boat-relay";

/** The FAKE_ variables a caller may set; the relay's own home and image always win. */
const CALLER_ENV = /^(FAKE_AUTH_[A-Z_]+|FAKE_BOAT_PLAN|FAKE_BOAT_HOST_SCHEME)$/;
const GLOBAL_FLAG = "--json";
const REMOTE_PATH = /^bx-[0-9a-f]{12}:./;

/** What `relay-client.ts` sends. `file` carries the local side of an `scp`. */
interface RelayRequest {
  readonly container: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** The `scp` argument the relay replaces with a path of its own. */
  readonly local?: { readonly index: number; readonly file: Upload | Download };
}

interface Upload {
  readonly kind: "upload";
  readonly name: string;
  readonly mode: number;
  readonly base64: string;
}

interface Download {
  readonly kind: "download";
}

interface RelayResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly file?: string;
}

class RequestError extends Error {
  readonly code: string;
  constructor(message: string, code = "bad_request") {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Where the host `boat` reads its command words: every argument but `--json`. */
const words = (argv: ReadonlyArray<string>) =>
  argv.flatMap((arg, index) => (arg === GLOBAL_FLAG ? [] : [index]));

const subcommand = (argv: ReadonlyArray<string>) => argv[words(argv)[0] ?? -1];

function parseFile(value: unknown): Upload | Download | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RequestError("file must be an object");
  const { kind, name, mode, base64 } = value;
  if (kind === "download") return { kind };
  if (
    kind !== "upload" ||
    typeof name !== "string" ||
    name !== NodePath.basename(name) ||
    name === "" ||
    name === "." ||
    name === ".." ||
    typeof mode !== "number" ||
    typeof base64 !== "string"
  )
    throw new RequestError("file must be an upload with name, mode, and base64, or a download");
  return { kind, name, mode: mode & 0o777, base64 };
}

/**
 * Finds the local side of `scp <local> <id>:<path>` or `scp <id>:<path> <local>`, which the relay
 * fills with a path of its own, so a caller never names a path on this computer.
 */
function localSlot(
  argv: ReadonlyArray<string>,
  file: Upload | Download | undefined,
): RelayRequest["local"] {
  if (subcommand(argv) !== "scp") {
    if (file) throw new RequestError("only scp carries a file");
    return undefined;
  }
  const refuse = () =>
    new RequestError(
      "the relay copies only scp <local> <id>:<path> or scp <id>:<path> <local>, sent by its client",
      "invalid_arguments",
    );
  const [, from, to, ...extra] = words(argv);
  if (from === undefined || to === undefined || extra.length > 0) throw refuse();
  const remote = (index: number) => REMOTE_PATH.test(argv[index] ?? "");
  if (file?.kind === "upload" && remote(to) && !remote(from)) return { index: from, file };
  if (file?.kind === "download" && remote(from) && !remote(to)) return { index: to, file };
  throw refuse();
}

function parseRequest(body: string): RelayRequest {
  const value: unknown = JSON.parse(body);
  if (!isRecord(value)) throw new RequestError("request must be an object");
  const { container, argv, env } = value;
  if (typeof container !== "string" || container === "")
    throw new RequestError("container is required");
  if (!isStrings(argv)) throw new RequestError("argv must be strings");
  // The fake `boat` also runs its own background work from a leading flag; callers name commands.
  if (subcommand(argv)?.startsWith("-"))
    throw new RequestError("the relay runs boat subcommands only", "invalid_arguments");
  if (!isRecord(env)) throw new RequestError("env must be an object");
  const callerEnv = Object.entries(env).filter(
    (entry): entry is [string, string] => CALLER_ENV.test(entry[0]) && typeof entry[1] === "string",
  );
  const local = localSlot(argv, parseFile(value.file));
  return { container, argv, env: Object.fromEntries(callerEnv), ...(local ? { local } : {}) };
}

/** Another lane may remove its site between the listing and the read. */
function readIfPresent(file: string): string {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

/** The fake removes a sandbox's directory when it deletes the sandbox, maybe mid-read. */
function listDir(dir: string): ReadonlyArray<string> {
  try {
    return NodeFS.readdirSync(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Hosts the fake `boat` in `home` published, read from their Caddy site files, which the caller's
 * own DNS sends to itself. `home/hosts/<sandbox>/<port>` is how the fake records each one.
 */
export function publishedHosts(sites: string, home: string): ReadonlyArray<string> {
  const hosted = NodePath.join(home, "hosts");
  const hosts = listDir(hosted)
    .flatMap((sandbox) =>
      listDir(NodePath.join(hosted, sandbox)).map((port) => `boat-${sandbox}-${port}.caddy`),
    )
    .flatMap((file) => {
      const address = readIfPresent(NodePath.join(sites, file)).split("{")[0] ?? "";
      return address.split(",").map((part) => part.trim().replace(/^[a-z]+:\/\//, ""));
    })
    .filter((host) => host !== "");
  return [...new Set(hosts)].toSorted();
}

const SYNC_HOSTS = `want=$(cat)
have=$(grep -F ' ${HOSTS_MARKER}' /etc/hosts || true)
[ "$want" = "$have" ] && exit 0
kept=$(grep -vF ' ${HOSTS_MARKER}' /etc/hosts || true)
{ printf '%s\\n' "$kept"; [ -z "$want" ] || printf '%s\\n' "$want"; } > /etc/hosts`;

/** Caddy's address on the fixtures network, or nothing while no Caddy runs. */
function caddyAddress(): string {
  try {
    return docker(
      [
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`,
        caddyContainer(),
      ],
      { timeoutMs: 30_000 },
    ).trim();
  } catch (error) {
    if (error instanceof DockerError && /no such/i.test(error.stderr)) return "";
    throw error;
  }
}

/** What each container's /etc/hosts last got, by container and start time, since Docker resets it at start. */
const synced = new Map<string, string>();

/**
 * Points every published host at Caddy inside `container`, writing only when that changed. Docker
 * bind-mounts /etc/hosts, so it is rewritten in place. Runs synchronously, which keeps two
 * requests from interleaving the rewrite.
 */
function syncHosts(container: string): void {
  const [networks = "{}", started = ""] = docker(
    ["inspect", "--format", "{{json .NetworkSettings.Networks}}\n{{.State.StartedAt}}", container],
    { timeoutMs: 30_000 },
  )
    .trim()
    .split("\n");
  if (!(NETWORK in (JSON.parse(networks) as Record<string, unknown>)))
    throw new RequestError(`${container} is not on the ${NETWORK} network`);
  const caddyIp = caddyAddress();
  const want = (
    caddyIp
      ? publishedHosts(NodePath.join(caddyDir(), "sites"), HOME).map(
          (host) => `${caddyIp}\t${host} ${HOSTS_MARKER}`,
        )
      : []
  ).join("\n");
  const key = `${container} ${started}`;
  if (synced.get(key) === want) return;
  docker(["exec", "-i", "-u", "0", container, "sh", "-c", SYNC_HOSTS], {
    input: want,
    timeoutMs: 60_000,
  });
  synced.set(key, want);
}

function runBoat(
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  cwd: string,
  abort: AbortSignal,
): Promise<RelayResponse> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(BOAT, argv, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      signal: abort,
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => stderr.push(Buffer.from(`${error.message}\n`)));
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
  });
}

const failure = (code: string, error: string): RelayResponse => ({
  exitCode: 1,
  stdout: "",
  stderr: `${JSON.stringify({ code, error })}\n`,
});

async function relay(request: RelayRequest, abort: AbortSignal): Promise<RelayResponse> {
  const sub = subcommand(request.argv);
  if (sub === "forward")
    return failure(
      "unsupported",
      "boat forward is not relayed; remote clients sign in by link and code",
    );
  syncHosts(request.container);
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-relay-"));
  try {
    const argv = [...request.argv];
    const { local } = request;
    const downloaded = NodePath.join(work, "download");
    if (local?.file.kind === "upload") {
      const { name, mode, base64 } = local.file;
      const path = NodePath.join(work, name);
      NodeFS.writeFileSync(path, Buffer.from(base64, "base64"), { mode });
      NodeFS.chmodSync(path, mode);
      argv[local.index] = path;
    } else if (local) {
      argv[local.index] = downloaded;
    }
    const result = await runBoat(argv, request.env, work, abort);
    if (sub === "host") syncHosts(request.container);
    if (local?.file.kind !== "download" || result.exitCode !== 0) return result;
    return { ...result, file: NodeFS.readFileSync(downloaded).toString("base64") };
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
}

/** What `install` gives one container, so a request it sends can name no other container. */
const containerToken = (token: string, container: string) =>
  NodeCrypto.createHmac("sha256", token).update(container).digest("hex");

/** The container a request names, read before anything else so it decides which token counts. */
function namedContainer(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && typeof value.container === "string" ? value.container : undefined;
  } catch {
    return undefined;
  }
}

function authorized(incoming: NodeHttp.IncomingMessage, token: string, body: string): boolean {
  const container = namedContainer(body);
  if (container === undefined) return false;
  const sent = Buffer.from(incoming.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${containerToken(token, container)}`);
  return sent.length === expected.length && NodeCrypto.timingSafeEqual(sent, expected);
}

function serve(flags: Flags): Promise<never> {
  const host = flags.get("host") ?? "127.0.0.1";
  const port = Number(flags.get("port") ?? "0");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new UsageError("--port needs a port number");
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const server = NodeHttp.createServer((incoming, outgoing) => {
    const chunks: Array<Buffer> = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const abort = new AbortController();
      outgoing.on("close", () => {
        if (!outgoing.writableFinished) abort.abort();
      });
      const answer = (status: number, body: RelayResponse) =>
        outgoing
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      const body = Buffer.concat(chunks).toString();
      if (!authorized(incoming, token, body)) {
        answer(
          401,
          failure("unauthorized", "send the token relay.ts install wrote for this container"),
        );
        return;
      }
      if (incoming.method !== "POST" || incoming.url !== "/run") {
        answer(404, failure("not_found", "POST /run"));
        return;
      }
      let request: RelayRequest;
      try {
        request = parseRequest(body);
      } catch (error) {
        const code = error instanceof RequestError ? error.code : "bad_request";
        answer(400, failure(code, error instanceof Error ? error.message : String(error)));
        return;
      }
      relay(request, abort.signal).then(
        (result) => answer(200, result),
        (error: unknown) =>
          answer(
            200,
            failure("relay_failed", error instanceof Error ? error.message : String(error)),
          ),
      );
    });
  });
  return new Promise((_, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) return;
      const shown = address.address.includes(":") ? `[${address.address}]` : address.address;
      console.log(`boat-relay: http://${shown}:${address.port} token=${token}`);
    });
  });
}

function install(flags: Flags): void {
  const container = flags.get("container");
  const relayUrl = flags.get("relay");
  const token = flags.get("token");
  if (!container || !relayUrl || !token)
    throw new UsageError("install needs --container, --relay, and the --token serve printed");
  const parsed = new URL(relayUrl);
  if (parsed.protocol !== "http:") throw new UsageError("--relay must be an http:// URL");
  const user = flags.get("user");
  const as = user === undefined ? [] : ["-u", user];
  const shell = (script: string, args: ReadonlyArray<string> = [], input = "") =>
    docker(["exec", "-i", ...as, container, "sh", "-c", script, "sh", ...args], { input });
  const node = shell("command -v node || true").trim();
  if (!node.startsWith("/")) throw new UsageError(`${container} has no node on PATH`);
  const write = (name: string, mode: string, body: string) =>
    shell(
      'd="$HOME/.ascii/bin" && mkdir -p "$d" && cat > "$d/.$1.tmp" && chmod "$2" "$d/.$1.tmp" && mv -f "$d/.$1.tmp" "$d/$1"',
      [name, mode],
      body,
    );
  const origin = parsed.href.replace(/\/$/, "");
  const config = { relay: origin, container, token: containerToken(token, container) };
  write("relay.json", "600", `${JSON.stringify(config, null, 2)}\n`);
  write("relay-client.ts", "644", NodeFS.readFileSync(CLIENT, "utf8"));
  write("boat", "755", `#!/bin/sh\nexec ${node} "$(dirname "$0")/relay-client.ts" "$@"\n`);
  console.log(`boat-relay: installed ${shell('printf %s "$HOME"')}/.ascii/bin/boat`);
}

class UsageError extends Error {}

type Flags = ReadonlyMap<string, string>;

const COMMANDS: Readonly<
  Record<string, { readonly flags: ReadonlyArray<string>; readonly run: (flags: Flags) => unknown }>
> = {
  serve: { flags: ["port", "host"], run: serve },
  install: { flags: ["container", "relay", "token", "user"], run: install },
};

function parseFlags(args: ReadonlyArray<string>, allowed: ReadonlyArray<string>): Flags {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    const name = match?.[1];
    if (!match || name === undefined || !allowed.includes(name))
      throw new UsageError(`unknown argument ${arg}`);
    const value = match[2] ?? args[++index];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return flags;
}

if (import.meta.main) {
  const [name = "", ...rest] = process.argv.slice(2);
  const command = COMMANDS[name];
  try {
    if (!command)
      throw new UsageError(`usage: relay.ts <${Object.keys(COMMANDS).join("|")}> [flags]`);
    await command.run(parseFlags(rest, command.flags));
  } catch (error) {
    console.error(`boat-relay: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

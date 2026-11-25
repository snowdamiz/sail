// @effect-diagnostics nodeBuiltinImport:off globalConsole:off extendsNativeError:off - A plain Node CLI that lets a fixture container drive the computer-side fake `boat`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CADDY_CONTAINER, caddyDir } from "../lib/caddy.ts";
import { docker, exists, inspect, NETWORK } from "../lib/docker.ts";

const BOAT = NodePath.join(import.meta.dirname, "boat");
const CLIENT = NodePath.join(import.meta.dirname, "relay-client.ts");
const HOSTS_MARKER = "# fake-boat-relay";

/** What `relay-client.ts` sends. `file` names the argv slot that holds a local path. */
interface RelayRequest {
  readonly container: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly file?: Upload | Download;
}

interface Upload {
  readonly kind: "upload";
  readonly argIndex: number;
  readonly name: string;
  readonly mode: number;
  readonly base64: string;
}

interface Download {
  readonly kind: "download";
  readonly argIndex: number;
}

interface RelayResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly file?: string;
}

class RequestError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function parseFile(value: unknown, argc: number): Upload | Download | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RequestError("file must be an object");
  const { kind, argIndex } = value;
  if (
    typeof argIndex !== "number" ||
    !Number.isInteger(argIndex) ||
    argIndex < 0 ||
    argIndex >= argc
  )
    throw new RequestError("file.argIndex must name an argv slot");
  if (kind === "download") return { kind, argIndex };
  const { name, mode, base64 } = value;
  if (
    kind !== "upload" ||
    typeof name !== "string" ||
    name !== NodePath.basename(name) ||
    name === "" ||
    name === ".." ||
    typeof mode !== "number" ||
    typeof base64 !== "string"
  )
    throw new RequestError("file must be an upload with name, mode, and base64, or a download");
  return { kind, argIndex, name, mode: mode & 0o777, base64 };
}

function parseRequest(body: string): RelayRequest {
  const value: unknown = JSON.parse(body);
  if (!isRecord(value)) throw new RequestError("request must be an object");
  const { container, argv, env } = value;
  if (typeof container !== "string" || container === "")
    throw new RequestError("container is required");
  if (!isStrings(argv)) throw new RequestError("argv must be strings");
  if (!isRecord(env)) throw new RequestError("env must be an object");
  const fakeEnv = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      entry[0].startsWith("FAKE_") && typeof entry[1] === "string",
  );
  const file = parseFile(value.file, argv.length);
  return { container, argv, env: Object.fromEntries(fakeEnv), ...(file ? { file } : {}) };
}

const subcommand = (argv: ReadonlyArray<string>) => argv.find((arg) => !arg.startsWith("-"));

/** Hosts from the fake `boat`'s Caddy site files, which the caller's own DNS sends to itself. */
export function publishedHosts(sites: string): ReadonlyArray<string> {
  const files = NodeFS.existsSync(sites) ? NodeFS.readdirSync(sites) : [];
  const hosts = files
    .filter((file) => file.startsWith("boat-") && file.endsWith(".caddy"))
    .flatMap((file) => {
      const address = NodeFS.readFileSync(NodePath.join(sites, file), "utf8").split("{")[0] ?? "";
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

/**
 * Points every published host at Caddy inside `container`. Docker bind-mounts /etc/hosts, so it is
 * rewritten in place. Runs synchronously, which keeps two requests from interleaving the rewrite.
 */
function syncHosts(container: string): void {
  const networks = inspect<Record<string, unknown>>(container, ".NetworkSettings.Networks");
  if (!(NETWORK in networks))
    throw new RequestError(`${container} is not on the ${NETWORK} network`);
  const caddyIp = exists("container", CADDY_CONTAINER)
    ? inspect<string>(CADDY_CONTAINER, `(index .NetworkSettings.Networks "${NETWORK}").IPAddress`)
    : "";
  const lines = caddyIp
    ? publishedHosts(NodePath.join(caddyDir(), "sites")).map(
        (host) => `${caddyIp}\t${host} ${HOSTS_MARKER}`,
      )
    : [];
  docker(["exec", "-i", "-u", "0", container, "sh", "-c", SYNC_HOSTS], {
    input: lines.join("\n"),
    timeoutMs: 30_000,
  });
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
    const file = request.file;
    if (file?.kind === "upload") {
      const local = NodePath.join(work, file.name);
      NodeFS.writeFileSync(local, Buffer.from(file.base64, "base64"), { mode: file.mode });
      NodeFS.chmodSync(local, file.mode);
      argv[file.argIndex] = local;
    }
    const downloaded = NodePath.join(work, "download");
    if (file?.kind === "download") argv[file.argIndex] = downloaded;
    const result = await runBoat(argv, request.env, work, abort);
    if (sub === "host") syncHosts(request.container);
    if (file?.kind !== "download" || result.exitCode !== 0) return result;
    return { ...result, file: NodeFS.readFileSync(downloaded).toString("base64") };
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
}

function serve(flags: Flags): Promise<never> {
  const host = flags.get("host") ?? "127.0.0.1";
  const port = Number(flags.get("port") ?? "0");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new UsageError("--port needs a port number");
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
      if (incoming.method !== "POST" || incoming.url !== "/run") {
        answer(404, failure("not_found", "POST /run"));
        return;
      }
      let request: RelayRequest;
      try {
        request = parseRequest(Buffer.concat(chunks).toString());
      } catch (error) {
        answer(400, failure("bad_request", error instanceof Error ? error.message : String(error)));
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
      console.log(`boat-relay: http://${shown}:${address.port}`);
    });
  });
}

function install(flags: Flags): void {
  const container = flags.get("container");
  const relayUrl = flags.get("relay");
  if (!container || !relayUrl) throw new UsageError("install needs --container and --relay");
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
  write("relay.json", "644", `${JSON.stringify({ relay: origin, container }, null, 2)}\n`);
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
  install: { flags: ["container", "relay", "user"], run: install },
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

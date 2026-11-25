// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Installed as `~/.ascii/bin/boat` in a fixture container and run on that container's own Node, so it imports nothing from the repo.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

interface Config {
  readonly relay: string;
  readonly container: string;
}

interface RelayResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly file?: string;
}

type FileSlot =
  | {
      readonly kind: "upload";
      readonly argIndex: number;
      readonly name: string;
      readonly mode: number;
      readonly base64: string;
    }
  | { readonly kind: "download"; readonly argIndex: number };

const REMOTE_PATH = /^[\w-]+:/;

function fail(code: string, error: string): never {
  console.error(JSON.stringify({ code, error }));
  process.exit(1);
}

function readConfig(): Config {
  const file = NodePath.join(import.meta.dirname, "relay.json");
  const value: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("relay" in value) ||
    !("container" in value) ||
    typeof value.relay !== "string" ||
    typeof value.container !== "string"
  )
    fail("relay_misconfigured", `${file} needs relay and container`);
  return { relay: value.relay, container: value.container };
}

/** `scp <local> <id>:<path>` sends the file; `scp <id>:<path> <local>` asks for it back. */
function fileSlot(argv: ReadonlyArray<string>, sub: number): FileSlot | undefined {
  if (argv[sub] !== "scp") return undefined;
  const from = argv[sub + 1];
  const to = argv[sub + 2];
  if (from === undefined || to === undefined) return undefined;
  if (REMOTE_PATH.test(to) && !REMOTE_PATH.test(from)) {
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.statSync(from);
    } catch (error) {
      fail("invalid_arguments", error instanceof Error ? error.message : String(error));
    }
    if (!stat.isFile()) fail("invalid_arguments", `${from} is not a file`);
    return {
      kind: "upload",
      argIndex: sub + 1,
      name: NodePath.basename(from),
      mode: stat.mode & 0o777,
      base64: NodeFS.readFileSync(from).toString("base64"),
    };
  }
  if (REMOTE_PATH.test(from) && !REMOTE_PATH.test(to))
    return { kind: "download", argIndex: sub + 2 };
  return undefined;
}

function post(url: URL, body: string): Promise<RelayResponse> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      url,
      { method: "POST", headers: { "content-type": "application/json" } },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()) as RelayResponse);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

const argv = process.argv.slice(2);
const sub = argv.findIndex((arg) => !arg.startsWith("-"));
if (argv[sub] === "forward")
  fail(
    "unsupported",
    "boat forward is not relayed: a server off the computer signs in to agents with a link and a code (W11), not a forwarded localhost callback",
  );
const config = readConfig();
const slot = fileSlot(argv, sub);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[0].startsWith("FAKE_") && entry[1] !== undefined,
  ),
);

let result: RelayResponse;
try {
  result = await post(
    new URL("/run", config.relay),
    JSON.stringify({ container: config.container, argv, env, file: slot }),
  );
} catch (error) {
  fail(
    "relay_unreachable",
    `${config.relay}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (slot?.kind === "download" && result.exitCode === 0 && result.file !== undefined) {
  const local = argv[slot.argIndex] ?? "";
  const remote = argv[slot.argIndex - 1] ?? "";
  const isDir = NodeFS.existsSync(local) && NodeFS.statSync(local).isDirectory();
  NodeFS.writeFileSync(
    isDir ? NodePath.join(local, NodePath.basename(remote.replace(REMOTE_PATH, ""))) : local,
    Buffer.from(result.file, "base64"),
  );
}
process.exitCode = result.exitCode;

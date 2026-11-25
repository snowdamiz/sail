// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Installed as `~/.ascii/bin/boat` in a fixture container and run on that container's own Node, so it imports nothing from the repo.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

interface Config {
  readonly relay: string;
  readonly container: string;
  readonly token: string;
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
      readonly name: string;
      readonly mode: number;
      readonly base64: string;
    }
  | { readonly kind: "download" };

/** The FAKE_ variables the relay takes from a caller. */
const CALLER_ENV = /^(FAKE_AUTH_[A-Z_]+|FAKE_BOAT_PLAN|FAKE_BOAT_HOST_SCHEME)$/;
const REMOTE_PATH = /^bx-[0-9a-f]{12}:./;

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
    !("token" in value) ||
    typeof value.relay !== "string" ||
    typeof value.container !== "string" ||
    typeof value.token !== "string"
  )
    fail("relay_misconfigured", `${file} needs relay, container, and token`);
  return { relay: value.relay, container: value.container, token: value.token };
}

const argv = process.argv.slice(2);

/** The host `boat` reads its command words from every argument but `--json`, wherever it sits. */
const words = argv.flatMap((arg, index) => (arg === "--json" ? [] : [index]));
const [sub = -1, from = -1, to = -1, ...extra] = words;

/** `scp <local> <id>:<path>` sends the file; `scp <id>:<path> <local>` asks for it back. */
function fileSlot(): FileSlot | undefined {
  if (argv[sub] !== "scp" || from === -1 || to === -1 || extra.length > 0) return undefined;
  const local = argv[from] ?? "";
  const remote = (index: number) => REMOTE_PATH.test(argv[index] ?? "");
  if (remote(to) && !remote(from)) {
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.statSync(local);
    } catch (error) {
      fail("invalid_arguments", error instanceof Error ? error.message : String(error));
    }
    if (!stat.isFile()) fail("invalid_arguments", `${local} is not a file`);
    return {
      kind: "upload",
      name: NodePath.basename(local),
      mode: stat.mode & 0o777,
      base64: NodeFS.readFileSync(local).toString("base64"),
    };
  }
  if (remote(from) && !remote(to)) return { kind: "download" };
  return undefined;
}

function post(url: URL, token: string, body: string): Promise<RelayResponse> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      },
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

if (argv[sub] === "forward")
  fail(
    "unsupported",
    "boat forward is not relayed: a server off the computer signs in to agents with a link and a code (W11), not a forwarded localhost callback",
  );
const config = readConfig();
const slot = fileSlot();
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => CALLER_ENV.test(entry[0]) && entry[1] !== undefined,
  ),
);

let result: RelayResponse;
try {
  result = await post(
    new URL("/run", config.relay),
    config.token,
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
  const local = argv[to] ?? "";
  const remote = argv[from] ?? "";
  const isDir = NodeFS.existsSync(local) && NodeFS.statSync(local).isDirectory();
  NodeFS.writeFileSync(
    isDir ? NodePath.join(local, NodePath.basename(remote.replace(REMOTE_PATH, ""))) : local,
    Buffer.from(result.file, "base64"),
  );
}
process.exitCode = result.exitCode;

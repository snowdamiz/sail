// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A fixture HTTP server that stands in for GitHub Releases.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const USAGE = `Usage:
  node scripts/fixtures/release-mirror.ts --dir <dir> [--port <n>] [--host <addr>]

Serves every t3-<version>-<platform>-<arch>.tar.gz in <dir> the way GitHub Releases does:
  /v<version>/<archive>, /v<version>/SHA256SUMS, and an install.sh at /install.sh and
  /v<version>/install.sh whose default release URL is the origin the request used.

  curl -fsSL http://host.docker.internal:<port>/install.sh | T3CODE_VERSION=<v> sh

--host defaults to 127.0.0.1, which Docker Desktop containers reach as host.docker.internal.
On Linux, run containers with --add-host=host.docker.internal:host-gateway and start the
mirror with --host 0.0.0.0 (or the docker bridge address), since the gateway is not loopback.`;

const INSTALLER_PATH = NodePath.resolve(import.meta.dirname, "../install.sh");
const BASE_URL_LINE = /^base_url="\$\{T3CODE_RELEASE_BASE_URL:-.*\}"$/m;
const ARCHIVE_NAME = /^t3-(?<version>.+)-(?:darwin|linux)-(?:arm64|x64)\.tar\.gz$/;
const SHELL_SAFE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

interface Archive {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}

type Route =
  | { readonly kind: "installer"; readonly version?: string }
  | { readonly kind: "checksums"; readonly version: string }
  | { readonly kind: "archive"; readonly version: string; readonly name: string };

function parseRoute(pathname: string): Route | undefined {
  if (pathname === "/install.sh") return { kind: "installer" };
  const match = /^\/v(?<version>[^/]+)\/(?<file>[^/]+)$/.exec(pathname);
  const version = match?.groups?.version;
  const file = match?.groups?.file;
  if (version === undefined || file === undefined) return undefined;
  if (file === "install.sh") return { kind: "installer", version };
  if (file === "SHA256SUMS") return { kind: "checksums", version };
  return { kind: "archive", version, name: file };
}

function listArchives(dir: string): ReadonlyArray<Archive> {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const version = entry.isFile() ? ARCHIVE_NAME.exec(entry.name)?.groups?.version : undefined;
    return version === undefined
      ? []
      : [{ name: entry.name, version, path: NodePath.join(dir, entry.name) }];
  });
}

function rewriteInstaller(source: string, origin: string): string {
  return source.replace(BASE_URL_LINE, `base_url="\${T3CODE_RELEASE_BASE_URL:-${origin}}"`);
}

export interface MirrorOptions {
  readonly dir: string;
  readonly port?: number | undefined;
  readonly host?: string | undefined;
}

export interface Mirror {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export async function startMirror(options: MirrorOptions): Promise<Mirror> {
  const dir = NodePath.resolve(options.dir);
  const installer = NodeFS.readFileSync(INSTALLER_PATH, "utf8");
  if (!BASE_URL_LINE.test(installer)) throw new Error(`${INSTALLER_PATH} has no base_url default`);
  const digests = new Map<string, { readonly key: string; readonly digest: string }>();
  const digestOf = (archive: Archive) => {
    const stat = NodeFS.statSync(archive.path);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = digests.get(archive.path);
    if (cached?.key === key) return cached.digest;
    const digest = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(archive.path))
      .digest("hex");
    digests.set(archive.path, { key, digest });
    return digest;
  };

  const server = NodeHttp.createServer((request, response) => {
    const send = (status: number, body: string, type = "text/plain; charset=utf-8") =>
      response.writeHead(status, { "content-type": type }).end(body);
    if (request.method !== "GET" && request.method !== "HEAD")
      return send(405, "method not allowed\n");
    const route = parseRoute(new URL(request.url ?? "/", "http://mirror").pathname);
    const archives = route === undefined ? [] : listArchives(dir);
    const forVersion = archives.filter((archive) => archive.version === route?.version);
    if (route === undefined || (route.version !== undefined && forVersion.length === 0)) {
      return send(404, "not found\n");
    }
    switch (route.kind) {
      case "installer": {
        const host = request.headers.host ?? "";
        if (!SHELL_SAFE_HOST.test(host)) return send(400, "bad Host header\n");
        return send(200, rewriteInstaller(installer, `http://${host}`), "text/x-shellscript");
      }
      case "checksums":
        return send(
          200,
          forVersion.map((archive) => `${digestOf(archive)}  ${archive.name}\n`).join(""),
        );
      case "archive": {
        const archive = forVersion.find((candidate) => candidate.name === route.name);
        if (archive === undefined) return send(404, "not found\n");
        response.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": NodeFS.statSync(archive.path).size,
        });
        if (request.method === "HEAD") return response.end();
        NodeFS.createReadStream(archive.path)
          .on("error", () => response.destroy())
          .pipe(response);
      }
    }
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${urlHost}:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: {
      dir: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) return console.log(USAGE);
  const port = values.port === undefined ? 0 : Number(values.port);
  if (values.dir === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(USAGE);
    process.exit(2);
  }
  const mirror = await startMirror({ dir: values.dir, port, host: values.host });
  console.log(`release-mirror: ${mirror.url}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`release-mirror: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

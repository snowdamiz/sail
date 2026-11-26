// @effect-diagnostics nodeBuiltinImport:off - Local stand-ins drive the Docker CLI directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { docker, ensureNetwork, exists, FIXTURE_LABEL, inspect, NETWORK } from "./docker.ts";
import { fixturesRoot } from "./state.ts";

export const CADDY_CONTAINER = "sail-fixtures-caddy";
const CADDY_IMAGE = "caddy:2";
const CONFIG_DIR = "/etc/caddy";
export const DOMAIN = "localtest.me";
export const AUTH_HOST = `auth.${DOMAIN}`;
const AUTH_LOG = "auth-access.log";
const RESERVED_HOSTS: ReadonlySet<string> = new Set([DOMAIN, AUTH_HOST]);
export const isReservedHost = (host: string) => RESERVED_HOSTS.has(host);

/**
 * Sign-in pages for the fake `boat`, `claude`, and `codex`. A device code counts as approved once
 * its `/approve` URL shows up in the access log, which the fakes read. Query values are echoed into
 * HTML, so anything that could break out of an attribute is refused.
 */
const AUTH_SITE = `${AUTH_HOST} {
	tls internal
	log {
		output file ${CONFIG_DIR}/${AUTH_LOG} {
			roll_disabled
		}
		format json
	}
	header Content-Type "text/html; charset=utf-8"
	route {
		@unsafe vars_regexp {http.request.uri.query} (?i)(%3C|%3E|%22|%27|%60|<|>)
		respond @unsafe 400
		@authorize path /claude/authorize /codex/authorize
		respond @authorize \`<!doctype html><title>Fake sign-in</title><h1>Fake sign-in</h1><p><a id="authorize" href="{http.request.uri.query.redirect_uri}?code=fake-code&state={http.request.uri.query.state}">Authorize</a></p>\`
		respond /claude/code/callback \`<!doctype html><title>Fake sign-in code</title><h1>Paste this code into Claude Code</h1><pre id="code">{http.request.uri.query.code}#{http.request.uri.query.state}</pre>\`
		@approve path_regexp approve ^/(boat|codex)/device/approve$
		respond @approve \`<!doctype html><title>Device approved</title><h1>Approved</h1><p>Code <code id="code">{http.request.uri.query.code}</code> is approved. Return to the app.</p>\`
		@device path_regexp device ^/(boat|codex)/device$
		respond @device \`<!doctype html><title>Fake device sign-in</title><h1>Fake device sign-in</h1><form action="{http.request.uri.path}/approve"><label>Code <input id="code" name="code" value="{http.request.uri.query.code}"></label> <button id="approve">Approve</button></form>\`
		respond 404
	}
}
`;

/**
 * Lanes at different revisions share this file, so it carries a version: bump it with every
 * change, and keep each version a superset of the last. A lane never replaces a newer one.
 */
export const CADDYFILE_VERSION = 1;
const VERSION_LINE = /^# sail-fixtures Caddyfile v(\d+)\n/;

export const CADDYFILE = `# sail-fixtures Caddyfile v${CADDYFILE_VERSION}
{
	admin localhost:2019
	local_certs
	skip_install_trust
	pki {
		ca local {
			root {
				cert ${CONFIG_DIR}/ca/root.crt
				key ${CONFIG_DIR}/ca/root.key
			}
		}
	}
}

${AUTH_SITE}
import sites/*.caddy
`;

/** One fixed place, so a test's temp home can never become the directory every lane serves from. */
export function caddyDir(): string {
  return NodePath.join(fixturesRoot(), "caddy");
}

/** Caddy's JSON access log for the sign-in pages, which the fakes read to see approvals. */
export function authLogPath(): string {
  return NodePath.join(caddyDir(), AUTH_LOG);
}

function port(name: string, fallback: number): string {
  return process.env[name] ?? String(fallback);
}

/**
 * Bump with every change to how the root is made. A lane at an older revision keeps whatever
 * root it finds, so a newer root is never replaced by an older one.
 */
export const CA_VERSION = 2;

/** Permits `localtest.me` names only. Excluding every IP keeps the root from vouching for one. */
const NAME_CONSTRAINTS = `critical,permitted;DNS:${DOMAIN},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:::/::`;

function caVersion(ca: string): number {
  try {
    return Number(NodeFS.readFileSync(NodePath.join(ca, "version"), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** True when it made a new root, whose certificates replace every one the old root issued. */
export function ensureRootCa(dir: string): boolean {
  const ca = NodePath.join(dir, "ca");
  if (caVersion(ca) >= CA_VERSION) return false;
  const staging = NodeFS.mkdtempSync(NodePath.join(dir, "ca-"));
  const openssl = NodeChildProcess.spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      NodePath.join(staging, "root.key"),
      "-out",
      NodePath.join(staging, "root.crt"),
      "-days",
      "3650",
      "-subj",
      "/CN=Sail fixtures local CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-addext",
      `nameConstraints=${NAME_CONSTRAINTS}`,
    ],
    { encoding: "utf8" },
  );
  if (openssl.status !== 0) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    throw new Error(`openssl could not make the fixture CA: ${openssl.stderr}`);
  }
  NodeFS.writeFileSync(NodePath.join(staging, "version"), `${CA_VERSION}\n`);
  const retired = `${staging}-retired`;
  try {
    NodeFS.renameSync(ca, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  NodeFS.rmSync(retired, { recursive: true, force: true });
  try {
    NodeFS.renameSync(staging, ca);
    return true;
  } catch {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

/** Another revision may have started Caddy from another directory; that one is left alone. */
function refuseAnotherDirectory(dir: string): void {
  const mounts = inspect<ReadonlyArray<{ readonly Source: string; readonly Destination: string }>>(
    CADDY_CONTAINER,
    ".Mounts",
  );
  const served = mounts.find((mount) => mount.Destination === CONFIG_DIR)?.Source;
  if (served !== undefined && samePath(served, dir)) return;
  throw new Error(
    `${CADDY_CONTAINER} serves ${served ?? "no config directory"}, not ${dir}. Every lane shares it, so it is left running; remove it by hand (docker rm --force ${CADDY_CONTAINER}) once no lane uses it.`,
  );
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return NodeFS.realpathSync(a) === NodeFS.realpathSync(b);
  } catch {
    return false;
  }
}

/** True when `text` is a Caddyfile older than this checkout's, which `ensureCaddy` upgrades. */
export const isOlderCaddyfile = (text: string) =>
  Number(VERSION_LINE.exec(text)?.[1] ?? 0) < CADDYFILE_VERSION;

export function ensureCaddy(): void {
  ensureNetwork();
  const dir = caddyDir();
  NodeFS.mkdirSync(NodePath.join(dir, "sites"), { recursive: true });
  if (exists("container", CADDY_CONTAINER)) refuseAnotherDirectory(dir);
  // A bind mount of a missing file would become a directory.
  NodeFS.appendFileSync(authLogPath(), "");
  // Certificates the old root issued sit in Caddy's data volume, so a new root starts it fresh.
  if (ensureRootCa(dir)) {
    if (exists("container", CADDY_CONTAINER)) docker(["rm", "--force", CADDY_CONTAINER]);
    docker(["volume", "rm", "--force", `${CADDY_CONTAINER}-data`]);
  }
  const caddyfile = NodePath.join(dir, "Caddyfile");
  createWhole(caddyfile, CADDYFILE);
  if (!exists("container", CADDY_CONTAINER)) {
    try {
      docker([
        "run",
        "--detach",
        "--name",
        CADDY_CONTAINER,
        "--label",
        `${FIXTURE_LABEL}=caddy`,
        "--network",
        NETWORK,
        "--restart",
        "unless-stopped",
        "--memory",
        "128m",
        "--publish",
        `127.0.0.1:${port("SAIL_FIXTURES_HTTPS_PORT", 443)}:443`,
        "--publish",
        `127.0.0.1:${port("SAIL_FIXTURES_HTTP_PORT", 80)}:80`,
        "--volume",
        `${dir}:${CONFIG_DIR}`,
        "--volume",
        `${CADDY_CONTAINER}-data:/data`,
        CADDY_IMAGE,
        "caddy",
        "run",
        "--config",
        `${CONFIG_DIR}/Caddyfile`,
        "--adapter",
        "caddyfile",
      ]);
    } catch (error) {
      if (!exists("container", CADDY_CONTAINER)) throw error;
    }
  } else if (!inspect<boolean>(CADDY_CONTAINER, ".State.Running")) {
    docker(["start", CADDY_CONTAINER]);
  }
  waitForAdmin();
  if (isOlderCaddyfile(NodeFS.readFileSync(caddyfile, "utf8")))
    changeAndReload("Caddyfile", {
      kind: "upgrade",
      body: CADDYFILE,
      version: CADDYFILE_VERSION,
    });
}

function waitForAdmin(): void {
  for (let attempt = 0; ; attempt++) {
    try {
      docker([
        "exec",
        CADDY_CONTAINER,
        "wget",
        "-q",
        "-O",
        "/dev/null",
        "http://127.0.0.1:2019/config/",
      ]);
      return;
    } catch (error) {
      if (attempt >= 100) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** Caddy reads the file the moment its container starts, so it appears whole or not at all. */
function createWhole(file: string, body: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, body);
  try {
    NodeFS.linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

export function publicUrl(host: string, scheme: "https" | "http" = "https"): string {
  const published = docker(["port", CADDY_CONTAINER, scheme === "https" ? "443/tcp" : "80/tcp"])
    .trim()
    .split("\n")[0]
    ?.split(":")
    .pop();
  const standard = scheme === "https" ? "443" : "80";
  return `${scheme}://${host}${published === standard || !published ? "" : `:${published}`}`;
}

export interface Site {
  readonly id: string;
  readonly host: string;
  readonly upstream: string;
  readonly plainHttp?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Relative to the config directory, which the host and the container see at different paths. */
function siteFile(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`bad site id: ${id}`);
  return `sites/${id}.caddy`;
}

export function publishSite(site: Site): string {
  if (isReservedHost(site.host)) throw new Error(`${site.host} is reserved for the fixtures`);
  ensureCaddy();
  const address = site.plainHttp ? `http://${site.host}, https://${site.host}` : site.host;
  const headers = Object.entries(site.headers ?? {})
    .map(([name, value]) => `\t\theader_up ${name} "${value}"\n`)
    .join("");
  const body = `${address} {\n\ttls internal\n\treverse_proxy ${site.upstream} {\n${headers}\t}\n}\n`;
  changeAndReload(siteFile(site.id), { kind: "put", body });
  return publicUrl(site.host);
}

export function removeSite(id: string): void {
  if (!exists("container", CADDY_CONTAINER)) return;
  const file = siteFile(id);
  if (!NodeFS.existsSync(NodePath.join(caddyDir(), file))) return;
  refuseAnotherDirectory(caddyDir());
  changeAndReload(file, { kind: "delete" });
}

type Change =
  | { readonly kind: "put"; readonly body: string }
  | { readonly kind: "delete" }
  | { readonly kind: "upgrade"; readonly body: string; readonly version: number };

/**
 * `$1` is a path under the config directory, `$2` the change, `$3` the version an upgrade brings.
 * The old file is kept until Caddy accepts the new config, and put back if it refuses.
 */
const CHANGE_AND_RELOAD = `cd ${CONFIG_DIR} || exit 1
key=$(printf %s "$1" | tr / _)
next=".next-$key"
saved=".saved-$key"
case "$2" in
  delete) [ -e "$1" ] || exit 0 ;;
  upgrade)
    stamp=$(head -n 1 "$1")
    case "$stamp" in "# sail-fixtures Caddyfile v"*) have=$(printf %s "$stamp" | tr -cd 0-9) ;; *) have=0 ;; esac
    [ "$have" -lt "$3" ] || exit 0
    cat > "$next" || exit 1 ;;
  put) cat > "$next" || exit 1 ;;
  *) exit 2 ;;
esac
rm -f "$saved"
if [ -e "$1" ]; then cp -p "$1" "$saved" || exit 1; fi
if [ "$2" = delete ]; then rm "$1"; else mv "$next" "$1"; fi || exit 1
if caddy reload --config Caddyfile --adapter caddyfile; then rm -f "$saved"; exit 0; fi
if [ -e "$saved" ]; then mv "$saved" "$1"; else rm -f "$1"; fi
exit 1`;

/**
 * Every config change runs whole under one lock inside the container, so no reload ever reads
 * a file Caddy refused or lands an older set of sites after a newer one.
 */
function changeAndReload(file: string, change: Change): void {
  docker(
    [
      "exec",
      "--interactive",
      CADDY_CONTAINER,
      "flock",
      "/data/reload.lock",
      "sh",
      "-c",
      CHANGE_AND_RELOAD,
      "sh",
      file,
      change.kind,
      change.kind === "upgrade" ? String(change.version) : "",
    ],
    { input: change.kind === "delete" ? "" : change.body },
  );
}

export function rootCertPath(): string {
  return NodePath.join(caddyDir(), "ca", "root.crt");
}

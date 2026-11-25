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

const CADDYFILE = `{
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

function ensureRootCa(dir: string): boolean {
  const ca = NodePath.join(dir, "ca");
  if (NodeFS.existsSync(NodePath.join(ca, "root.crt"))) return false;
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
      `nameConstraints=critical,permitted;DNS:${DOMAIN}`,
    ],
    { encoding: "utf8" },
  );
  if (openssl.status !== 0)
    throw new Error(`openssl could not make the fixture CA: ${openssl.stderr}`);
  try {
    NodeFS.renameSync(staging, ca);
    return true;
  } catch {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

export function ensureCaddy(): void {
  ensureNetwork();
  const dir = caddyDir();
  NodeFS.mkdirSync(NodePath.join(dir, "sites"), { recursive: true });
  // A bind mount of a missing file would become a directory.
  NodeFS.appendFileSync(authLogPath(), "");
  // Certificates the old root issued sit in Caddy's data volume, so a new root starts it fresh.
  if (ensureRootCa(dir)) {
    if (exists("container", CADDY_CONTAINER)) docker(["rm", "--force", CADDY_CONTAINER]);
    docker(["volume", "rm", "--force", `${CADDY_CONTAINER}-data`]);
  }
  const caddyfile = NodePath.join(dir, "Caddyfile");
  const configChanged =
    !NodeFS.existsSync(caddyfile) || NodeFS.readFileSync(caddyfile, "utf8") !== CADDYFILE;
  if (configChanged) writeAtomically(caddyfile, CADDYFILE);
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
  } else if (configChanged) {
    reload();
  }
  waitForAdmin();
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

function writeAtomically(file: string, body: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, body);
  NodeFS.renameSync(temporary, file);
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

function siteFile(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`bad site id: ${id}`);
  return NodePath.join(caddyDir(), "sites", `${id}.caddy`);
}

export function publishSite(site: Site): string {
  if (RESERVED_HOSTS.has(site.host)) throw new Error(`${site.host} is reserved for the fixtures`);
  ensureCaddy();
  const address = site.plainHttp ? `http://${site.host}, https://${site.host}` : site.host;
  const headers = Object.entries(site.headers ?? {})
    .map(([name, value]) => `\t\theader_up ${name} "${value}"\n`)
    .join("");
  const body = `${address} {\n\ttls internal\n\treverse_proxy ${site.upstream} {\n${headers}\t}\n}\n`;
  const file = siteFile(site.id);
  const previous = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : undefined;
  writeAtomically(file, body);
  try {
    reload();
  } catch (error) {
    // A file Caddy refuses would break every later reload, for every lane.
    if (previous === undefined) NodeFS.rmSync(file);
    else writeAtomically(file, previous);
    throw error;
  }
  return publicUrl(site.host);
}

export function removeSite(id: string): void {
  if (!exists("container", CADDY_CONTAINER)) return;
  const file = siteFile(id);
  if (!NodeFS.existsSync(file)) return;
  NodeFS.rmSync(file);
  reload();
}

/** Serialized inside the container, so a reload that read older site files never lands last. */
function reload(): void {
  docker([
    "exec",
    CADDY_CONTAINER,
    "flock",
    "/data/reload.lock",
    "caddy",
    "reload",
    "--config",
    `${CONFIG_DIR}/Caddyfile`,
    "--adapter",
    "caddyfile",
  ]);
}

export function rootCertPath(): string {
  return NodePath.join(caddyDir(), "ca", "root.crt");
}

// @effect-diagnostics nodeBuiltinImport:off - Local stand-ins drive the Docker CLI directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { docker, ensureNetwork, exists, FIXTURE_LABEL, inspect, NETWORK } from "./docker.ts";

/**
 * One Caddy container fronts every stand-in on this computer, so parallel lanes share ports
 * 443 and 80. Each published host is one file in `sites/`: writers never edit a shared file.
 */
export const CADDY_CONTAINER = "sail-fixtures-caddy";
const CADDY_IMAGE = "caddy:2";
const CONFIG_DIR = "/etc/caddy";
export const DOMAIN = "localtest.me";

/** Sign-in pages for the fake `boat`, `claude`, and `codex`. Query values are echoed as-is. */
const AUTH_SITE = `auth.${DOMAIN} {
	tls internal
	header Content-Type "text/html; charset=utf-8"
	@authorize path /claude/authorize /codex/authorize
	handle @authorize {
		respond \`<!doctype html><title>Fake sign-in</title><h1>Fake sign-in</h1><p><a id="authorize" href="{http.request.uri.query.redirect_uri}?code=fake-code&state={http.request.uri.query.state}">Authorize</a></p>\`
	}
	handle /claude/code/callback {
		respond \`<!doctype html><title>Fake sign-in code</title><h1>Paste this code into Claude Code</h1><pre id="code">{http.request.uri.query.code}#{http.request.uri.query.state}</pre>\`
	}
	@device path /codex/device /boat/device
	handle @device {
		respond \`<!doctype html><title>Fake device sign-in</title><h1>Fake device sign-in</h1><p>Code <code id="code">{http.request.uri.query.code}</code> is approved on its own.</p>\`
	}
	respond 404
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

function defaultDir(): string {
  const state = process.env.XDG_STATE_HOME ?? NodePath.join(NodeOS.homedir(), ".local", "state");
  return NodePath.join(
    process.env.SAIL_FIXTURES_HOME ?? NodePath.join(state, "sail-fixtures"),
    "caddy",
  );
}

/** The running container's config mount wins, so every caller edits the files it serves. */
export function caddyDir(): string {
  if (!exists("container", CADDY_CONTAINER)) return defaultDir();
  const mounts = inspect<ReadonlyArray<{ Source: string; Destination: string }>>(
    CADDY_CONTAINER,
    ".Mounts",
  );
  return mounts.find((m) => m.Destination === CONFIG_DIR)?.Source ?? defaultDir();
}

function port(name: string, fallback: number): string {
  return process.env[name] ?? String(fallback);
}

/**
 * A root that can sign only `localtest.me` names, so trusting it once (for a browser lane) cannot
 * vouch for any other site. Built in a temp dir and renamed into place, so racing callers agree.
 */
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
  // Certificates the old root issued sit in Caddy's data volume, so a new root starts it fresh.
  if (ensureRootCa(dir) && exists("container", CADDY_CONTAINER)) {
    docker(["rm", "--force", CADDY_CONTAINER]);
    docker(["volume", "rm", `${CADDY_CONTAINER}-data`]);
  }
  const caddyfile = NodePath.join(dir, "Caddyfile");
  const configChanged =
    !NodeFS.existsSync(caddyfile) || NodeFS.readFileSync(caddyfile, "utf8") !== CADDYFILE;
  if (configChanged) NodeFS.writeFileSync(caddyfile, CADDYFILE);
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
}

/** `https://<host>`, with the published port when it is not 443. */
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
  /** Stable file name, so republishing replaces the route. */
  readonly id: string;
  readonly host: string;
  /** `<container>:<port>` on the shared network. */
  readonly upstream: string;
  /** Also serve plain HTTP instead of redirecting it to HTTPS. */
  readonly plainHttp?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

function siteFile(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`bad site id: ${id}`);
  return NodePath.join(caddyDir(), "sites", `${id}.caddy`);
}

export function publishSite(site: Site): string {
  ensureCaddy();
  const address = site.plainHttp ? `http://${site.host}, https://${site.host}` : site.host;
  const headers = Object.entries(site.headers ?? {})
    .map(([name, value]) => `\t\theader_up ${name} "${value}"\n`)
    .join("");
  const body = `${address} {\n\ttls internal\n\treverse_proxy ${site.upstream} {\n${headers}\t}\n}\n`;
  const file = siteFile(site.id);
  NodeFS.writeFileSync(`${file}.tmp`, body);
  NodeFS.renameSync(`${file}.tmp`, file);
  reload();
  return publicUrl(site.host);
}

export function removeSite(id: string): void {
  if (!exists("container", CADDY_CONTAINER)) return;
  const file = siteFile(id);
  if (!NodeFS.existsSync(file)) return;
  NodeFS.rmSync(file);
  reload();
}

function reload(): void {
  docker([
    "exec",
    CADDY_CONTAINER,
    "caddy",
    "reload",
    "--config",
    `${CONFIG_DIR}/Caddyfile`,
    "--adapter",
    "caddyfile",
  ]);
}

/** The fixture CA's root, for `curl --cacert`, `NODE_EXTRA_CA_CERTS`, and a one-time trust. */
export function rootCertPath(): string {
  return NodePath.join(caddyDir(), "ca", "root.crt");
}

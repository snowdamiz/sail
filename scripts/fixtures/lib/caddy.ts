// @effect-diagnostics nodeBuiltinImport:off - Local stand-ins drive the Docker CLI directly.
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
const ROOT_CERT = "/data/caddy/pki/authorities/local/root.crt";
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

export function ensureCaddy(): void {
  ensureNetwork();
  if (!exists("container", CADDY_CONTAINER)) {
    const dir = defaultDir();
    NodeFS.mkdirSync(NodePath.join(dir, "sites"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "Caddyfile"), CADDYFILE);
    NodeFS.rmSync(NodePath.join(dir, "root.crt"), { force: true });
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
  }
  if (!inspect<boolean>(CADDY_CONTAINER, ".State.Running")) docker(["start", CADDY_CONTAINER]);
  exportRootCert();
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

/** Caddy's local root, for `curl --cacert` and `NODE_EXTRA_CA_CERTS`. */
export function rootCertPath(): string {
  return NodePath.join(caddyDir(), "root.crt");
}

function exportRootCert(): void {
  const target = rootCertPath();
  if (NodeFS.existsSync(target)) return;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      NodeFS.writeFileSync(target, docker(["exec", CADDY_CONTAINER, "cat", ROOT_CERT]));
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new Error(`Caddy never wrote its root certificate to ${ROOT_CERT}`);
}

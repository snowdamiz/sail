// @effect-diagnostics nodeBuiltinImport:off - Local stand-ins drive the Docker CLI directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  docker,
  DockerError,
  dockerSucceeds,
  ensureNetwork,
  FIXTURE_LABEL,
  inspect,
  NETWORK,
} from "./docker.ts";
import { fixturesRoot, withLock } from "./state.ts";

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

/**
 * A test's own Caddy, so replacing one never touches the Caddy every lane shares: its own container,
 * directory, data volumes, and published ports. Only host-side clients reach it, since a sandbox
 * reaches Caddy on port 443 and this one publishes on ports Docker picks.
 */
function instance(): string | undefined {
  const name = process.env.SAIL_FIXTURES_CADDY_INSTANCE;
  if (name && !/^[a-z0-9][a-z0-9-]*$/.test(name))
    throw new Error(`bad SAIL_FIXTURES_CADDY_INSTANCE: ${name}`);
  return name || undefined;
}

export function caddyContainer(): string {
  const name = instance();
  return name ? `${CADDY_CONTAINER}-${name}` : CADDY_CONTAINER;
}

/** One fixed place, so a test's temp home can never become the directory every lane serves from. */
export function caddyDir(): string {
  const name = instance();
  return NodePath.join(fixturesRoot(), name ? `caddy-${name}` : "caddy");
}

/** Caddy's JSON access log for the sign-in pages, which the fakes read to see approvals. */
export function authLogPath(): string {
  return NodePath.join(caddyDir(), AUTH_LOG);
}

/** A test's own Caddy publishes on ports Docker picks unless told otherwise. */
function port(name: string, fallback: number): string {
  return process.env[name] ?? (instance() ? "" : String(fallback));
}

/**
 * Bump with every change to how the root is made. A lane at an older revision keeps whatever
 * root it finds, so a newer root is never replaced by an older one. Version 3 is version 2 re-issued
 * on the same key, so a copy of the version 2 root still verifies, and under LibreSSL still lets
 * that key vouch for names that merely end in `localtest.me`, until whoever kept it deletes it.
 */
export const CA_VERSION = 3;

/**
 * Names under `.localtest.me` only, where every fixture host is; LibreSSL reads `DNS:localtest.me`
 * as a plain suffix that `evil-localtest.me` matches. Excluding every IP keeps the root from vouching
 * for one.
 */
const NAME_CONSTRAINTS = `critical,permitted;DNS:.${DOMAIN},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:::/::`;

interface Ca {
  readonly version: number;
  readonly fingerprint: string;
}

/** The root on disk, or nothing unless its key is there too. Version 1 wrote no version file. */
function readCa(dir: string): Ca | undefined {
  const ca = NodePath.join(dir, "ca");
  if (!["root.crt", "root.key"].every((file) => NodeFS.existsSync(NodePath.join(ca, file))))
    return undefined;
  let version = 1;
  try {
    version = Number(NodeFS.readFileSync(NodePath.join(ca, "version"), "utf8").trim()) || 1;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return { version, fingerprint: fingerprint(dir) };
}

/**
 * Held while anything changes the root, the container serving it, or its config, for up to 5
 * minutes, so a replacement never cuts off another lane's reload.
 */
function withCaddyLock<T>(dir: string, run: () => T): T {
  return withLock(NodePath.join(dir, "caddy.lock"), run);
}

/**
 * A new root on `key` when there is one, so anything that trusts the old root still verifies what
 * the new one signs, and a lane that read the root before an upgrade keeps working after it.
 */
function makeRoot(dir: string, key: string | undefined): string {
  const staging = NodeFS.mkdtempSync(NodePath.join(dir, "ca-"));
  const keyout = NodePath.join(staging, "root.key");
  if (key) NodeFS.copyFileSync(key, keyout);
  const newKey = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout"];
  const openssl = NodeChildProcess.spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      ...(key ? ["-key"] : newKey),
      keyout,
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
  return staging;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * The caller holds the Caddy lock. Version 2's only flaw is its DNS constraint, so it is re-issued
 * on its key one file at a time, and a reader never finds the root missing; a crash part way just
 * re-issues it again. Anything else gets a new key in a new directory.
 */
function rotateRoot(dir: string, from: Ca | undefined): void {
  const ca = NodePath.join(dir, "ca");
  if (from?.version === 2) {
    const staging = makeRoot(dir, NodePath.join(ca, "root.key"));
    NodeFS.renameSync(NodePath.join(staging, "root.crt"), NodePath.join(ca, "root.crt"));
    NodeFS.renameSync(NodePath.join(staging, "version"), NodePath.join(ca, "version"));
    NodeFS.rmSync(staging, { recursive: true, force: true });
    return;
  }
  const staging = makeRoot(dir, undefined);
  const retired = `${staging}-retired`;
  let hadRoot = true;
  try {
    NodeFS.renameSync(ca, retired);
  } catch (error) {
    if (!isMissing(error)) {
      NodeFS.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    hadRoot = false;
  }
  try {
    NodeFS.renameSync(staging, ca);
  } catch (error) {
    if (hadRoot) NodeFS.renameSync(retired, ca);
    NodeFS.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  NodeFS.rmSync(retired, { recursive: true, force: true });
}

/** A process killed between `rotateRoot`'s two renames left its old root aside; it goes back. */
function recoverRetired(dir: string): void {
  if (NodeFS.existsSync(NodePath.join(dir, "ca"))) return;
  const retired = NodeFS.readdirSync(dir).find(
    (name) =>
      /^ca-.+-retired$/.test(name) &&
      ["root.crt", "root.key"].every((file) => NodeFS.existsSync(NodePath.join(dir, name, file))),
  );
  if (retired) NodeFS.renameSync(NodePath.join(dir, retired), NodePath.join(dir, "ca"));
}

/** True when it made a new root, whatever other homes serve: only tests call it, on their own `dir`. */
export function ensureRootCa(dir: string): boolean {
  return withCaddyLock(dir, () => {
    recoverRetired(dir);
    const ca = readCa(dir);
    if (ca && ca.version >= CA_VERSION) return false;
    rotateRoot(dir, ca);
    return true;
  });
}

function fingerprint(dir: string): string {
  const root = NodeFS.readFileSync(NodePath.join(dir, "ca", "root.crt"));
  return NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
}

/** Names the root on disk, which the running Caddy must have started with. */
export function rootFingerprint(dir = caddyDir()): string {
  return withCaddyLock(dir, () => fingerprint(dir));
}

export const ROOT_LABEL = `${FIXTURE_LABEL}.root`;

interface Served {
  readonly id: string;
  readonly config: string | undefined;
  readonly data: string | undefined;
  readonly root: string | undefined;
  readonly running: boolean;
}

/** What the Caddy container runs with, or nothing when there is none. */
function served(): Served | undefined {
  let state: {
    readonly Id: string;
    readonly Mounts: ReadonlyArray<{
      readonly Source: string;
      readonly Destination: string;
      readonly Name?: string;
    }>;
    readonly Config: { readonly Labels: Readonly<Record<string, string>> | null };
    readonly State: { readonly Running: boolean };
  };
  try {
    state = inspect(caddyContainer(), ".");
  } catch (error) {
    if (isNoSuch(error)) return undefined;
    throw error;
  }
  const at = (destination: string) =>
    state.Mounts.find((mount) => mount.Destination === destination);
  return {
    id: state.Id,
    config: at(CONFIG_DIR)?.Source,
    data: at("/data")?.Name,
    root: state.Config.Labels?.[ROOT_LABEL],
    running: state.State.Running,
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isNoSuch = (error: unknown) => error instanceof DockerError && /no such/i.test(error.stderr);

/** Another revision may have started Caddy from another directory; that one is left alone. */
function refuseAnotherDirectory(running: Served, dir: string): void {
  if (running.config !== undefined && samePath(running.config, dir)) return;
  throw new Error(
    `${caddyContainer()} serves ${running.config ?? "no config directory"}, not ${dir}. Every lane shares it, so it is left running; remove it by hand (docker rm --force ${caddyContainer()}) once no lane uses it.`,
  );
}

/** Docker Desktop sometimes reports a host bind mount by its VM path, under `/host_mnt`. */
const hostPath = (path: string) => path.replace(/^\/host_mnt(?=\/)/, "");

function samePath(served: string, dir: string): boolean {
  const host = hostPath(served);
  if (host === dir) return true;
  try {
    return NodeFS.realpathSync(host) === NodeFS.realpathSync(dir);
  } catch {
    return false;
  }
}

/** True when `text` is a Caddyfile older than this checkout's, which `ensureCaddy` upgrades. */
export const isOlderCaddyfile = (text: string) =>
  Number(VERSION_LINE.exec(text)?.[1] ?? 0) < CADDYFILE_VERSION;

const dataVolume = (root: string) => `${caddyContainer()}-data-${root}`;

const HOME_LINE = /^# sail-fixture home (\S+)(?: container (\S+))?$/m;

/**
 * Sites another home publishes that something may still be using. Only a site whose container is
 * gone is provably idle. A site without a home line came from an older revision: it counts as
 * another home's, idle only when its upstream names a fixture container that is gone.
 */
function othersServing(dir: string, home: string): ReadonlyArray<string> {
  const sites = NodePath.join(dir, "sites");
  const files = NodeFS.readdirSync(sites).filter((file) => file.endsWith(".caddy"));
  if (files.length === 0) return [];
  const containers = new Set(docker(["ps", "--all", "--format", "{{.Names}}"]).split("\n"));
  return files.filter((file) => {
    let body: string;
    try {
      body = NodeFS.readFileSync(NodePath.join(sites, file), "utf8");
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    const line = HOME_LINE.exec(body);
    if (line?.[1] === home) return false;
    const upstream = /reverse_proxy\s+([^\s:{]+)/.exec(body)?.[1];
    const container = line?.[2] ?? (upstream?.startsWith("sail-") ? upstream : undefined);
    return !(container && !containers.has(container));
  });
}

/** Sets up the config directory, which Caddy reads the moment its container starts. */
function prepare(): string {
  ensureNetwork();
  const dir = caddyDir();
  NodeFS.mkdirSync(NodePath.join(dir, "sites"), { recursive: true });
  // A bind mount of a missing file would become a directory.
  NodeFS.appendFileSync(authLogPath(), "");
  createWhole(NodePath.join(dir, "Caddyfile"), CADDYFILE);
  return dir;
}

/** Starts the Caddy that serves `home`'s sites, if it is not running already. */
export function ensureCaddy(home: string): void {
  const dir = prepare();
  withCaddyLock(dir, () => ready(dir, home));
}

function ready(dir: string, home: string): void {
  reconcile(dir, home);
  if (isOlderCaddyfile(NodeFS.readFileSync(NodePath.join(dir, "Caddyfile"), "utf8")))
    changeAndReload("Caddyfile", { kind: "upgrade", body: CADDYFILE, version: CADDYFILE_VERSION });
}

/**
 * Runs Caddy on the root that is on disk. Other homes' clients trust the root they read when they
 * started, so a newer root waits until no other home serves a site, and a Caddy on another root
 * that other homes serve through is refused rather than replaced. Each root gets its own data
 * volume, since the certificates the old root issued are kept there. The caller holds the lock.
 */
function reconcile(dir: string, home: string): void {
  recoverRetired(dir);
  const seen = served();
  if (seen) refuseAnotherDirectory(seen, dir);
  const ca = readCa(dir);
  if (seen?.running && ca && ca.version >= CA_VERSION && seen.root === ca.fingerprint) return;
  const upgrade = !ca || ca.version < CA_VERSION;
  const replacing = !seen || upgrade || seen.root !== ca?.fingerprint;
  const others = [
    ...othersServing(dir, home),
    ...(seen?.running && replacing && !reloadsSettle(seen.id)
      ? [`a reload inside ${caddyContainer()}`]
      : []),
  ];
  const rotate = !ca || (upgrade && others.length === 0);
  if (seen && ca && !rotate && seen.root === ca.fingerprint) {
    if (!seen.running) {
      docker(["start", seen.id]);
      waitForAdmin();
    }
    return;
  }
  if (seen?.running && others.length > 0)
    throw new Error(
      `${caddyContainer()} runs on root ${seen.root ?? "unknown"} and the root on disk is ${ca?.fingerprint ?? "missing"}, but other homes still serve ${others.join(", ")} through it. Replacing it would cut them off; remove those sites or their containers, then try again.`,
    );
  // The old container goes before the root changes, so a failure here leaves the two matching.
  if (seen) {
    try {
      docker(["rm", "--force", seen.id]);
    } catch (error) {
      if (!isNoSuch(error)) throw error;
    }
  }
  if (rotate) rotateRoot(dir, ca);
  const root = fingerprint(dir);
  if (seen?.data && seen.data !== dataVolume(root)) dockerSucceeds(["volume", "rm", seen.data]);
  const name = caddyContainer();
  try {
    docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `${FIXTURE_LABEL}=${instance() ? "caddy-instance" : "caddy"}`,
      "--label",
      `${ROOT_LABEL}=${root}`,
      "--network",
      NETWORK,
      "--restart",
      // Docker Desktop can show a root just replaced on the host as missing for a moment.
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
      `${dataVolume(root)}:/data`,
      CADDY_IMAGE,
      "caddy",
      "run",
      "--config",
      `${CONFIG_DIR}/Caddyfile`,
      "--adapter",
      "caddyfile",
    ]);
  } catch (error) {
    // A lane at an older revision may have started the very same Caddy meanwhile.
    const now = served();
    if (!(now?.root === root && now.config !== undefined && samePath(now.config, dir))) throw error;
  }
  waitForAdmin();
}

/**
 * Lanes at older revisions reload under only the lock inside the container, so a replacement
 * first waits, for up to 30 seconds, until no such reload runs or waits there.
 */
function reloadsSettle(id: string): boolean {
  const count = "ps -o args | grep -c '^flock /data/reload.lock' || true";
  for (let attempt = 0; attempt < 150; attempt++) {
    let running: string;
    try {
      running = docker(["exec", id, "sh", "-c", count]);
    } catch (error) {
      // Nothing reloads inside a container that is not running.
      if (error instanceof DockerError && /not running|is restarting|no such/i.test(error.stderr))
        return true;
      throw error;
    }
    if (Number(running.trim()) === 0) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return false;
}

function waitForAdmin(): void {
  for (let attempt = 0; ; attempt++) {
    try {
      docker([
        "exec",
        caddyContainer(),
        "wget",
        "-q",
        "-O",
        "/dev/null",
        "http://127.0.0.1:2019/config/",
      ]);
      return;
    } catch (error) {
      if (attempt >= 100) {
        const logs = NodeChildProcess.spawnSync(
          "docker",
          ["logs", "--tail", "5", caddyContainer()],
          {
            encoding: "utf8",
          },
        );
        throw new Error(
          `${caddyContainer()} never answered on its admin API: ${errorText(error)}\n${logs.stdout}${logs.stderr}`,
        );
      }
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
  const published = docker(["port", caddyContainer(), scheme === "https" ? "443/tcp" : "80/tcp"])
    .trim()
    .split("\n")[0]
    ?.split(":")
    .pop();
  const standard = scheme === "https" ? "443" : "80";
  return `${scheme}://${host}${published === standard || !published ? "" : `:${published}`}`;
}

export interface Site {
  readonly id: string;
  /** The `homeId` of the fake that publishes it. */
  readonly home: string;
  /** The container behind `upstream`; once it is gone, nobody can be using the site. */
  readonly container: string;
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
  // Caddy issues for any address, so this keeps it to the names the root is meant to sign.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.localtest\.me$/.test(site.host))
    throw new Error(
      `${site.host} is not a name under ${DOMAIN}, the only names the fixtures serve`,
    );
  const address = site.plainHttp ? `http://${site.host}, https://${site.host}` : site.host;
  const headers = Object.entries(site.headers ?? {})
    .map(([name, value]) => `\t\theader_up ${name} "${value}"\n`)
    .join("");
  const body = `${address} {\n\ttls internal\n\treverse_proxy ${site.upstream} {\n${headers}\t}\n}\n# sail-fixture home ${site.home} container ${site.container}\n`;
  const dir = prepare();
  const url = withCaddyLock(dir, () => {
    ready(dir, site.home);
    changeAndReload(siteFile(site.id), { kind: "put", body });
    return publicUrl(site.host);
  });
  waitForCertificate(site.host, url);
  return url;
}

/**
 * Caddy obtains a new site's certificate after its reload returns, slowly at load 90, while a Fly
 * app's URL verifies once `fly deploy` returns. Any HTTP answer over verified TLS will do.
 */
function waitForCertificate(host: string, url: string): void {
  const port = new URL(url).port || "443";
  const curl = [
    "--silent",
    "--output",
    "/dev/null",
    "--max-time",
    "10",
    "--cacert",
    rootCertPath(),
  ].concat(["--resolve", `${host}:${port}:127.0.0.1`, `https://${host}:${port}/`]);
  for (let attempt = 0; ; attempt++) {
    if (NodeChildProcess.spawnSync("curl", curl).status === 0) return;
    if (attempt >= 300)
      throw new Error(`${caddyContainer()} never served a certificate for ${host}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

export function removeSite(id: string): void {
  const dir = caddyDir();
  const file = siteFile(id);
  if (!NodeFS.existsSync(NodePath.join(dir, file))) return;
  withCaddyLock(dir, () => {
    const running = served();
    if (!running?.running) {
      NodeFS.rmSync(NodePath.join(dir, file), { force: true });
      return;
    }
    refuseAnotherDirectory(running, dir);
    changeAndReload(file, { kind: "delete" });
  });
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
 * The caller holds the Caddy lock. Lanes at older revisions take only the lock inside the container,
 * so a change runs whole under both, and no reload reads a file Caddy refused or lands an older set
 * of sites after a newer one.
 */
function changeAndReload(file: string, change: Change): void {
  docker(
    [
      "exec",
      "--interactive",
      caddyContainer(),
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

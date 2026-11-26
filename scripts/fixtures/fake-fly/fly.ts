// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off globalDate:off globalTimers:off - A stand-in `fly` CLI that drives the Docker CLI directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  caddyContainer,
  DOMAIN,
  ensureCaddy,
  isReservedHost,
  publicUrl,
  publishSite,
  removeSite,
} from "../lib/caddy.ts";
import { docker, DockerError, exists, FIXTURE_LABEL, NETWORK } from "../lib/docker.ts";
import {
  canonicalPath,
  createJsonExclusive,
  homeId,
  logCall,
  nameOwner,
  readJson,
  releaseName,
  reserveName,
  standInHome,
  writeJsonAtomic,
} from "../lib/state.ts";
import {
  type DeployConfig,
  durationMs,
  EMPTY_CONFIG,
  type HttpService,
  type Mount,
  parseConfigFile,
  type StopConfig,
} from "./config.ts";

class FlyError extends Error {}

type FlagKind = "bool" | "string" | "list" | "int";
interface FlagSpec {
  readonly name: string;
  readonly short?: string;
  readonly kind: FlagKind;
  readonly help: string;
}
type FlagValue = string | boolean | ReadonlyArray<string>;

const flag = (name: string, kind: FlagKind, help: string, short?: string): FlagSpec =>
  short === undefined ? { name, kind, help } : { name, kind, help, short };

const APP = flag("app", "string", "Application name", "a");
const CONFIG = flag("config", "string", "Path to application configuration file", "c");
const JSON_OUT = flag("json", "bool", "JSON output", "j");
const YES = flag("yes", "bool", "Accept all confirmations", "y");
const ORG = flag("org", "string", "The target Fly.io organization", "o");
const REGION = flag("region", "string", "The target region", "r");
const GLOBAL_FLAGS = [
  flag("access-token", "string", "Fly API Access Token", "t"),
  flag("debug", "bool", "Print additional logs and traces"),
  flag("verbose", "bool", "Verbose output"),
  flag("help", "bool", "help", "h"),
];

interface Ctx {
  readonly args: ReadonlyArray<string>;
  readonly flags: ReadonlyMap<string, FlagValue>;
}

interface Command {
  readonly path: ReadonlyArray<string>;
  readonly aliases?: ReadonlyArray<string>;
  readonly short: string;
  readonly flags: ReadonlyArray<FlagSpec>;
  readonly args: readonly [min: number, max: number];
  readonly mutating: boolean;
  readonly session: boolean;
  readonly run: (ctx: Ctx) => number | Promise<number>;
}

const GROUP_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  apps: ["app"],
  volumes: ["volume", "vol", "v"],
  "volumes snapshots": ["snapshot", "snaps"],
  machine: ["machines", "m"],
  image: ["img"],
};

const str = (ctx: Ctx, name: string): string | undefined => {
  const value = ctx.flags.get(name);
  return typeof value === "string" ? value : undefined;
};
const bool = (ctx: Ctx, name: string): boolean => ctx.flags.get(name) === true;
const list = (ctx: Ctx, name: string): ReadonlyArray<string> => {
  const value = ctx.flags.get(name);
  return Array.isArray(value) ? value : [];
};
const int = (ctx: Ctx, name: string, fallback: number): number => {
  const value = str(ctx, name);
  return value === undefined ? fallback : Number(value);
};

function out(text: string): void {
  process.stdout.write(text);
}
function err(text: string): void {
  process.stderr.write(text);
}
/** Go's `encoding/json`, which escapes these characters inside strings. */
const goJson = (value: unknown, indent?: number) =>
  JSON.stringify(value, null, indent).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** flyctl's `render.JSON`: four-space indent, one value per line. */
function printJson(value: unknown): void {
  out(`${goJson(value, 4)}\n`);
}

const HOME = standInHome("fly", "FAKE_FLY_HOME");
const HOME_ID = homeId(HOME);
const HOME_LABEL = `${FIXTURE_LABEL}.home`;
const APP_LABEL = `${FIXTURE_LABEL}.fly-app`;
const APP_NAMES = "fly-app";

type Kind = "apps" | "machines" | "volumes" | "snapshots";

interface AppRecord {
  readonly name: string;
  readonly createdAt: string;
  readonly releaseVersion: number;
  readonly deployedAt?: string;
  readonly config?: DeployConfig;
}

interface ImageRef {
  readonly registry: string;
  readonly repository: string;
  readonly tag: string;
  readonly digest: string;
  readonly labels: Readonly<Record<string, string>>;
}

interface MachineRecord {
  readonly id: string;
  readonly app: string;
  readonly name: string;
  readonly region: string;
  readonly privateIp: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: string;
  readonly imageRef: ImageRef;
  readonly config: MachineConfigJson;
  readonly builtTag?: string;
}

interface VolumeRecord {
  readonly id: string;
  readonly app: string;
  readonly name: string;
  readonly sizeGb: number;
  readonly region: string;
  readonly zone: string;
  readonly createdAt: string;
}

interface SnapshotRecord {
  readonly id: string;
  readonly app: string;
  readonly volumeId: string;
  readonly sizeBytes: number;
  readonly volumeSizeBytes: number;
  readonly digest: string;
  readonly createdAt: string;
  /** Fixed when the copy finishes, so neither a slow copy nor a reader's env can shorten it. */
  readonly readyAt: string;
}

function recordPath(kind: Kind, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new FlyError(`invalid id: ${id}`);
  return NodePath.join(HOME, kind, `${id}.json`);
}

function read<T>(kind: Kind, id: string): T | undefined {
  return readJson<T>(recordPath(kind, id));
}

function all<T extends { readonly createdAt: string }>(kind: Kind): Array<T> {
  const dir = NodePath.join(HOME, kind);
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const record = read<T>(kind, file.slice(0, -".json".length));
      return record ? [record] : [];
    })
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function write(kind: Kind, id: string, value: unknown): void {
  writeJsonAtomic(recordPath(kind, id), value);
}

function remove(kind: Kind, id: string): void {
  NodeFS.rmSync(recordPath(kind, id), { force: true });
}

const SIGNED_OUT = () => NodePath.join(HOME, "signed-out");

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const ALNUM = `ABCDEFGHIJKLMNOPQRSTUVWXYZ${LOWER_ALNUM}`;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomFrom(alphabet: string, length: number): string {
  return Array.from({ length }, () => alphabet[NodeCrypto.randomInt(alphabet.length)]).join("");
}

/** The tag `deploy` gives a build: `deployment-` and a ULID, so an alias someone added is kept. */
const BUILD_TAG = /:deployment-[0-9A-HJKMNP-TV-Z]{26}$/;

function ulid(): string {
  let time = Date.now();
  let prefix = "";
  for (let i = 0; i < 10; i++) {
    prefix = CROCKFORD[time % 32] + prefix;
    time = Math.floor(time / 32);
  }
  return prefix + randomFrom(CROCKFORD, 16);
}

const ADJECTIVES = ["quiet", "bold", "misty", "late", "rough", "fragrant", "young", "silent"];
const NOUNS = ["snow", "river", "field", "sky", "moon", "dust", "forest", "wave"];
const friendlyName = () =>
  `${ADJECTIVES[NodeCrypto.randomInt(ADJECTIVES.length)]}-${NOUNS[NodeCrypto.randomInt(NOUNS.length)]}-${NodeCrypto.randomInt(1000, 10000)}`;

const hex = (bytes: number) => NodeCrypto.randomBytes(bytes).toString("hex");
const now = () => new Date().toISOString();
const flapsTime = (iso: string) => iso.replace(/\.\d+Z$/, "Z");

const containerName = (app: string) => `sail-fly-${app}`;
/** A bluegreen deploy's machines while they swap; app names have no `_`, so no app's name collides. */
const swapName = (app: string, color: "green" | "blue") => `${containerName(app)}_${color}`;
const volumeName = (id: string) => `sail-fly-vol-${id}`;
const snapshotName = (id: string) => `sail-fly-snap-${id}`;
const siteId = (app: string) => `fly-${app}`;
const appHost = (app: string) => `${app}.${DOMAIN}`;

type Ownership = "absent" | "mine" | "foreign";

/** Docker names are global, so a home touches only what carries its own label. */
function ownership(kind: "container" | "volume", name: string): Ownership {
  const labels = kind === "container" ? ".Config.Labels" : ".Labels";
  try {
    const owner = docker([
      kind,
      "inspect",
      "--format",
      `{{index ${labels} "${HOME_LABEL}"}}`,
      name,
    ]);
    return owner.trim() === HOME_ID ? "mine" : "foreign";
  } catch (error) {
    if (error instanceof DockerError && /no such/i.test(error.stderr)) return "absent";
    throw error;
  }
}

function refuseForeign(kind: "container" | "volume", name: string): void {
  if (ownership(kind, name) === "foreign")
    throw new FlyError(`${kind} ${name} belongs to another fake fly home; refusing to touch it`);
}

/** Reservations made before homes were canonical hold another spelling of the same path. */
function nameIsMine(app: string): boolean {
  const owner = nameOwner(APP_NAMES, app);
  return owner === undefined || canonicalPath(owner) === HOME;
}

interface LoadedConfig {
  readonly file: string | undefined;
  readonly dir: string;
  readonly config: DeployConfig;
}

/** `workingDirectory` is `fly deploy`'s argument: where it looks for `fly.toml` and builds. */
function loadConfig(ctx: Ctx, workingDirectory?: string): LoadedConfig {
  const explicit = str(ctx, "config");
  const candidate = explicit
    ? NodePath.resolve(explicit)
    : NodePath.join(workingDirectory ?? process.cwd(), "fly.toml");
  const file = NodeFS.existsSync(candidate)
    ? NodeFS.statSync(candidate).isDirectory()
      ? NodePath.join(candidate, "fly.toml")
      : candidate
    : undefined;
  if (explicit && (!file || !NodeFS.existsSync(file)))
    throw new FlyError(`failed loading app config from ${candidate}: no such file or directory`);
  if (!file)
    return { file: undefined, dir: workingDirectory ?? process.cwd(), config: EMPTY_CONFIG };
  return {
    file,
    dir: workingDirectory ?? NodePath.dirname(file),
    config: parseConfigFile(file),
  };
}

function appNameOf(ctx: Ctx): string | undefined {
  const fromFlag = str(ctx, "app") ?? process.env.FLY_APP;
  if (fromFlag) return fromFlag;
  return loadConfig(ctx).config.app;
}

function requireAppName(ctx: Ctx): string {
  const name = appNameOf(ctx);
  if (!name)
    throw new FlyError(
      "the config for your app is missing an app name, add an app field to the fly.toml file or specify with the -a flag",
    );
  return name;
}

function requireApp(name: string): AppRecord {
  const app = read<AppRecord>("apps", name);
  if (!app) throw new FlyError(`Could not find App "${name}"`);
  return app;
}

interface ContainerState {
  readonly Status: string;
  readonly Running: boolean;
  readonly Paused: boolean;
  readonly Restarting: boolean;
  readonly ExitCode: number;
}

function containerState(name: string): ContainerState | undefined {
  try {
    const parsed: unknown = JSON.parse(
      docker(["container", "inspect", "--format", "{{json .State}}", name]),
    );
    if (typeof parsed !== "object" || parsed === null || !("Status" in parsed)) return undefined;
    return parsed as ContainerState;
  } catch {
    return undefined;
  }
}

function machineState(machine: MachineRecord): "started" | "stopped" {
  const state = containerState(containerName(machine.app));
  return state && (state.Running || state.Restarting) ? "started" : "stopped";
}

const machineOf = (app: string): MachineRecord | undefined =>
  all<MachineRecord>("machines").find((machine) => machine.app === app);

const attachedMachine = (volumeId: string): MachineRecord | undefined =>
  all<MachineRecord>("machines").find((machine) =>
    machine.config.mounts?.some((mount) => mount.volume === volumeId),
  );

const GO_ZERO_TIME = "0001-01-01T00:00:00Z";
const ORG_NAME = "Fake User";
const EMAIL = "fake@localtest.me";

const zeroImageVersion = () => ({ Registry: "", Repository: "", Tag: "", Version: "", Digest: "" });

function releaseJson(createdAt: string) {
  return {
    ID: "",
    Version: 0,
    Stable: false,
    InProgress: false,
    Reason: "",
    Description: "",
    Status: "",
    DeploymentStrategy: "",
    Metadata: null,
    User: { ID: "", Name: "", Email: "", EnablePaidHobby: false },
    EvaluationID: "",
    CreatedAt: createdAt,
    ImageRef: "",
  };
}

function organizationJson() {
  return {
    ID: "",
    InternalNumericID: "",
    Name: ORG_NAME,
    RemoteBuilderImage: "",
    RemoteBuilderApp: null,
    Slug: "personal",
    RawSlug: "",
    Type: "",
    PaidPlan: false,
    Billable: false,
    Settings: null,
    AllowedReplaySourceOrgSlugs: null,
    AllowAllCrossNetworkReplays: false,
    WireGuardPeer: null,
    WireGuardPeers: { Nodes: null, Edges: null },
    DelegatedWireGuardTokens: { Nodes: null, Edges: null },
    LoggedCertificates: null,
  };
}

function appStatus(app: AppRecord): "pending" | "deployed" | "suspended" {
  const machine = machineOf(app.name);
  if (!machine) return "pending";
  return machineState(machine) === "started" ? "deployed" : "suspended";
}

function appJson(app: AppRecord) {
  const status = appStatus(app);
  return {
    ID: app.name,
    InternalNumericID: 0,
    Name: app.name,
    State: "",
    Status: status,
    Deployed: status === "deployed",
    Hostname: "",
    AppURL: "",
    Version: 0,
    NetworkID: 0,
    Network: "",
    Release: null,
    Organization: organizationJson(),
    Secrets: null,
    CurrentRelease: app.deployedAt ? releaseJson(app.deployedAt) : null,
    Releases: { Nodes: null },
    IPAddresses: { Nodes: null },
    EgressIpAddresses: { Nodes: null },
    SharedIPAddress: "",
    CNAMETarget: "",
    IPAddress: null,
    Certificates: { Nodes: null },
    Certificate: {
      ID: "",
      AcmeDNSConfigured: false,
      AcmeALPNConfigured: false,
      Configured: false,
      CertificateAuthority: "",
      CreatedAt: GO_ZERO_TIME,
      DNSProvider: "",
      DNSValidationInstructions: "",
      DNSValidationHostname: "",
      DNSValidationTarget: "",
      Hostname: "",
      Source: "",
      ClientStatus: "",
      IsApex: false,
      IsWildcard: false,
      ValidationErrors: null,
      Issued: { Nodes: null },
    },
    PostgresAppRole: null,
    Image: null,
    ImageUpgradeAvailable: false,
    ImageVersionTrackingEnabled: false,
    ImageDetails: zeroImageVersion(),
    LatestImageDetails: zeroImageVersion(),
    PlatformVersion: "",
    Machines: { Nodes: null },
    CurrentLock: null,
  };
}

function volumeJson(volume: VolumeRecord) {
  return {
    id: volume.id,
    name: volume.name,
    state: "created",
    size_gb: volume.sizeGb,
    region: volume.region,
    zone: volume.zone,
    encrypted: true,
    attached_machine_id: attachedMachine(volume.id)?.id ?? null,
    attached_alloc_id: null,
    created_at: volume.createdAt,
    host_dedication_id: "",
    snapshot_retention: 5,
    auto_backup_enabled: true,
    host_status: "ok",
  };
}

const MAX_SNAPSHOT_SECS = 7 * 24 * 3600;

function snapshotSeconds(): number {
  const text = process.env.FAKE_FLY_SNAPSHOT_SECS ?? "3";
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) > MAX_SNAPSHOT_SECS)
    throw new FlyError(
      `FAKE_FLY_SNAPSHOT_SECS must be a number of seconds up to ${MAX_SNAPSHOT_SECS}, got "${text}"`,
    );
  return Number(text);
}

/** Real Fly only schedules a snapshot; this one reads as pending until `readyAt`. */
const isPending = (snapshot: SnapshotRecord) => Date.now() < Date.parse(snapshot.readyAt);

/** A pending snapshot has no id, size, or digest yet; flyctl prints its id as `(pending)`. */
function snapshotJson(snapshot: SnapshotRecord) {
  const pending = isPending(snapshot);
  return {
    id: pending ? "" : snapshot.id,
    size: pending ? 0 : snapshot.sizeBytes,
    volume_size: snapshot.volumeSizeBytes,
    digest: pending ? "" : snapshot.digest,
    created_at: snapshot.createdAt,
    status: pending ? "pending" : "created",
    retention_days: 5,
  };
}

interface MachineMountJson {
  readonly encrypted: boolean;
  readonly path: string;
  readonly size_gb: number;
  readonly volume: string;
  readonly name: string;
}

interface MachineConfigJson {
  readonly env: Readonly<Record<string, string>>;
  readonly init: Readonly<Record<string, never>>;
  readonly guest: { readonly cpu_kind: string; readonly cpus: number; readonly memory_mb: number };
  readonly metadata: Readonly<Record<string, string>>;
  readonly mounts?: ReadonlyArray<MachineMountJson>;
  readonly services?: ReadonlyArray<unknown>;
  readonly stop_config?: StopConfig;
  readonly image: string;
  readonly restart: { readonly policy: string; readonly max_retries: number };
}

function imageRefJson(ref: ImageRef) {
  return {
    registry: ref.registry,
    repository: ref.repository,
    tag: ref.tag,
    digest: ref.digest,
    ...(Object.keys(ref.labels).length > 0 ? { labels: ref.labels } : {}),
  };
}

function machineJson(machine: MachineRecord) {
  return {
    id: machine.id,
    name: machine.name,
    state: machineState(machine),
    region: machine.region,
    image_ref: imageRefJson(machine.imageRef),
    instance_id: machine.version,
    version: machine.version,
    private_ip: machine.privateIp,
    created_at: machine.createdAt,
    updated_at: machine.updatedAt,
    config: machine.config,
    events: [
      {
        type: "start",
        status: "started",
        source: "flyd",
        timestamp: Date.parse(machine.updatedAt),
      },
      {
        type: "launch",
        status: "created",
        source: "user",
        timestamp: Date.parse(machine.updatedAt),
      },
    ],
    host_status: "ok",
    cordoned: false,
  };
}

const fullImageRef = (ref: ImageRef) => `${ref.registry}/${ref.repository}:${ref.tag}`;

const FLY_VERSION = "fly.version";

/** fly-go's `Machine.ImageRefWithVersion`, which the text views print. */
function imageRefWithVersion(ref: ImageRef): string {
  const version = ref.labels[FLY_VERSION];
  return `${ref.repository}:${ref.tag}${version ? ` (${version})` : ""}`;
}

function table(headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    `${cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("\t")
      .trimEnd()}\n`;
  out(line(headers.map((header) => header.toUpperCase())));
  for (const row of rows) out(line(row));
}

function verticalTable(title: string, entries: ReadonlyArray<readonly [string, string]>): void {
  const width = Math.max(...entries.map(([key]) => key.length));
  out(`${title}\n`);
  for (const [key, value] of entries) out(`  ${key.padEnd(width)} = ${value}\n`);
  out("\n");
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function confirm(question: string): boolean {
  if (!process.stdin.isTTY)
    throw new FlyError("yes flag must be specified when not running interactively");
  err(`? ${question} (y/N) `);
  const buffer = Buffer.alloc(256);
  const length = NodeFS.readSync(0, buffer, 0, buffer.length, null);
  return /^y(es)?$/i.test(buffer.subarray(0, length).toString("utf8").trim());
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createDockerVolume(name: string, kind: string, app: string): void {
  refuseForeign("volume", name);
  docker([
    "volume",
    "create",
    "--label",
    `${FIXTURE_LABEL}=${kind}`,
    "--label",
    `${APP_LABEL}=${app}`,
    "--label",
    `${HOME_LABEL}=${HOME_ID}`,
    name,
  ]);
}

/** Copies into a fresh Docker volume, which a failed copy removes again. */
function copyIntoNewVolume(from: string, to: string, kind: string, app: string): number {
  createDockerVolume(to, kind, app);
  try {
    return copyVolume(from, to);
  } catch (error) {
    removeDockerVolume(to);
    throw error;
  }
}

function copyVolume(from: string, to: string): number {
  const kib = docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--memory",
    "128m",
    "--label",
    `${FIXTURE_LABEL}=fly-volume-copy`,
    "--label",
    `${HOME_LABEL}=${HOME_ID}`,
    "--volume",
    `${from}:/from:ro`,
    "--volume",
    `${to}:/to`,
    "caddy:2",
    "sh",
    "-c",
    "cp -a /from/. /to/ && du -sk /to | cut -f1",
  ]).trim();
  return Number(kib) * 1024;
}

function removeDockerVolume(name: string): void {
  if (ownership("volume", name) === "mine") docker(["volume", "rm", "--force", name]);
}

const VOLUME_NAME = /^[a-z0-9_]{1,30}$/;

function newVolume(
  app: string,
  name: string,
  region: string,
  size: number,
  snapshot?: SnapshotRecord,
): VolumeRecord {
  if (!VOLUME_NAME.test(name))
    throw new FlyError(
      `failed creating volume: Name can only contain lowercase letters, numbers, and underscores, and be at most 30 characters`,
    );
  if (size < 1) throw new FlyError("failed creating volume: size_gb must be at least 1");
  const volume: VolumeRecord = {
    id: `vol_${randomFrom(LOWER_ALNUM, 16)}`,
    app,
    name,
    sizeGb: Math.max(size, snapshot ? Math.ceil(snapshot.volumeSizeBytes / 1024 ** 3) : 0),
    region,
    zone: hex(2),
    createdAt: now(),
  };
  if (snapshot)
    copyIntoNewVolume(snapshotName(snapshot.id), volumeName(volume.id), "fly-volume", app);
  else createDockerVolume(volumeName(volume.id), "fly-volume", app);
  write("volumes", volume.id, volume);
  return volume;
}

function destroyMachineContainer(name: string): void {
  if (ownership("container", name) === "mine") docker(["rm", "--force", "--volumes", name]);
}

const DEFAULT_STOP = { signal: "SIGINT", timeout: "5s" } as const;

/** How Fly stops a machine before it replaces it: `kill_signal`, then `kill_timeout` to exit. */
function stopMachineContainer(name: string, stop: StopConfig | undefined): void {
  if (ownership("container", name) !== "mine") return;
  const seconds = Math.ceil((durationMs(stop?.timeout ?? DEFAULT_STOP.timeout) ?? 5000) / 1000);
  docker(
    ["stop", "--signal", stop?.signal ?? DEFAULT_STOP.signal, "--timeout", String(seconds), name],
    { timeoutMs: (seconds + 30) * 1000 },
  );
}

/**
 * By label, so a deploy that failed after its build leaves nothing behind either, and by the
 * builds' own tags, so a tag someone else put on the image keeps it.
 */
function removeBuiltImages(app: string, recordedTag: string | undefined): void {
  const tags = docker([
    "image",
    "ls",
    "--filter",
    `label=${HOME_LABEL}=${HOME_ID}`,
    "--filter",
    `label=${APP_LABEL}=${app}`,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ])
    .split("\n")
    .filter((tag) => tag.startsWith(`registry.fly.io/${app}:`) && BUILD_TAG.test(tag));
  for (const tag of new Set([...tags, recordedTag])) removeBuiltTag(tag);
}

function removeBuiltTag(tag: string | undefined): void {
  if (!tag) return;
  try {
    docker(["image", "rm", tag]);
  } catch {
    // A tag still used by a container stays until the next deploy or destroy.
  }
}

function whoami(ctx: Ctx): number {
  if (bool(ctx, "json")) printJson({ email: EMAIL });
  else out(`${EMAIL}\n`);
  return 0;
}

function login(): number {
  NodeFS.rmSync(SIGNED_OUT(), { force: true });
  out(`successfully logged in as ${EMAIL}\n`);
  return 0;
}

function logout(): number {
  NodeFS.mkdirSync(HOME, { recursive: true });
  NodeFS.writeFileSync(SIGNED_OUT(), "");
  out("Session removed\n");
  return 0;
}

const APP_NAME = /^[a-z0-9][a-z0-9-]*$/;

function requireOrg(ctx: Ctx): void {
  const org = str(ctx, "org");
  if (org !== undefined && org !== "personal") throw new FlyError(`organization ${org} not found`);
}

function appsCreate(ctx: Ctx): number {
  requireOrg(ctx);
  const name =
    ctx.args[0] ?? str(ctx, "name") ?? (bool(ctx, "generate-name") ? friendlyName() : undefined);
  if (!name)
    throw new FlyError("name argument or flag must be specified when not running interactively");
  if (!APP_NAME.test(name) || name.length > 63)
    throw new FlyError(
      "Validation failed: Name can only contain lowercase letters, numbers, and dashes",
    );
  // The fixtures' own pages hold these hosts, so a deploy could never publish the app.
  if (isReservedHost(appHost(name)))
    throw new FlyError("Validation failed: Name has already been taken");
  const app: AppRecord = { name, createdAt: now(), releaseVersion: 0 };
  if (!reserveName(APP_NAMES, name, HOME) || !createJsonExclusive(recordPath("apps", name), app))
    throw new FlyError("Validation failed: Name has already been taken");
  if (bool(ctx, "json")) printJson(appJson(app));
  else out(`New app created: ${name}\n`);
  return 0;
}

function appsList(ctx: Ctx): number {
  requireOrg(ctx);
  const apps = all<AppRecord>("apps").toSorted((a, b) => a.name.localeCompare(b.name));
  if (bool(ctx, "json")) {
    printJson(apps.map(appJson));
    return 0;
  }
  if (bool(ctx, "quiet")) {
    for (const app of apps) out(`${app.name}\n`);
    return 0;
  }
  if (apps.length === 0) {
    out("No apps found\n");
    return 0;
  }
  table(
    ["Name", "Owner", "Status", "Latest Deploy"],
    apps.map((app) => [app.name, "personal", appStatus(app), relativeTime(app.deployedAt)]),
  );
  return 0;
}

function destroyApp(name: string): void {
  if (!nameIsMine(name))
    throw new FlyError(`app ${name} belongs to another fake fly home; refusing to destroy it`);
  const machine = machineOf(name);
  for (const container of [containerName(name), swapName(name, "green"), swapName(name, "blue")])
    destroyMachineContainer(container);
  removeBuiltImages(name, machine?.builtTag);
  if (machine) remove("machines", machine.id);
  for (const volume of all<VolumeRecord>("volumes").filter((v) => v.app === name)) {
    removeDockerVolume(volumeName(volume.id));
    remove("volumes", volume.id);
  }
  for (const snapshot of all<SnapshotRecord>("snapshots").filter((s) => s.app === name)) {
    removeDockerVolume(snapshotName(snapshot.id));
    remove("snapshots", snapshot.id);
  }
  removeSite(siteId(name));
  remove("apps", name);
  releaseName(APP_NAMES, name, HOME);
}

function appsDestroy(ctx: Ctx): number {
  for (const name of ctx.args) {
    requireApp(name);
    if (!bool(ctx, "yes")) {
      err("Destroying an app is not reversible.\n");
      if (!confirm(`Destroy app ${name}?`)) continue;
    }
    destroyApp(name);
    out(`Destroyed app ${name}\n`);
  }
  return 0;
}

function regionFor(ctx: Ctx, config: DeployConfig): string {
  const region = str(ctx, "region") ?? process.env.FLY_REGION ?? config.primaryRegion;
  if (!region) throw new FlyError("region must be specified when not running interactively");
  return region;
}

function printVolume(volume: VolumeRecord): void {
  const json = volumeJson(volume);
  verticalTable("", [
    ["ID", json.id],
    ["Name", json.name],
    ["App", volume.app],
    ["Region", json.region],
    ["Zone", json.zone],
    ["Size GB", String(json.size_gb)],
    ["Encrypted", String(json.encrypted)],
    ["Created at", json.created_at],
    ["Snapshot retention", "5"],
    ["Scheduled snapshots", "true"],
  ]);
}

function volumesCreate(ctx: Ctx): number {
  const appName = requireAppName(ctx);
  requireApp(appName);
  const name = ctx.args[0] ?? "";
  const count = int(ctx, "count", 1);
  if (int(ctx, "size", 1) < 1)
    throw new FlyError("failed creating volume: size_gb must be at least 1");
  if (
    !bool(ctx, "yes") &&
    count <= 1 &&
    !all<VolumeRecord>("volumes").some((v) => v.app === appName && v.name === name)
  ) {
    err(
      "Warning! Every volume is pinned to a specific physical host. You should create two or more volumes per application to avoid downtime. Learn more at https://fly.io/docs/volumes/overview/\n",
    );
    if (!confirm("Do you still want to use the volumes feature?")) return 0;
  }
  const region = regionFor(ctx, loadConfig(ctx).config);
  const snapshotId = str(ctx, "snapshot-id");
  const snapshot = snapshotId ? read<SnapshotRecord>("snapshots", snapshotId) : undefined;
  if (snapshotId && (!snapshot || snapshot.app !== appName))
    throw new FlyError(`failed creating volume: snapshot ${snapshotId} not found`);
  if (snapshot && isPending(snapshot))
    throw new FlyError(`failed creating volume: snapshot ${snapshot.id} is still pending`);
  for (let i = 0; i < count; i++) {
    const volume = newVolume(appName, name, region, int(ctx, "size", 1), snapshot);
    if (bool(ctx, "json")) printJson(volumeJson(volume));
    else printVolume(volume);
  }
  return 0;
}

function volumesList(ctx: Ctx): number {
  if (bool(ctx, "all"))
    throw new FlyError("fake fly keeps no destroyed volumes, so it cannot list them with --all");
  const appName = requireAppName(ctx);
  requireApp(appName);
  const volumes = all<VolumeRecord>("volumes").filter((v) => v.app === appName);
  if (bool(ctx, "json")) {
    printJson(volumes.map(volumeJson));
    return 0;
  }
  table(
    ["ID", "State", "Name", "Size", "Region", "Zone", "Encrypted", "Attached VM", "Created At"],
    volumes.map((volume) => [
      volume.id,
      "created",
      volume.name,
      `${volume.sizeGb}GB`,
      volume.region,
      volume.zone,
      "true",
      attachedMachine(volume.id)?.id ?? "",
      relativeTime(volume.createdAt),
    ]),
  );
  return 0;
}

function findVolume(ctx: Ctx, id: string): VolumeRecord {
  const volume = read<VolumeRecord>("volumes", id);
  const appName = appNameOf(ctx);
  if (!volume || (appName && volume.app !== appName))
    throw new FlyError(`failed retrieving volume: volume ${id} not found`);
  return volume;
}

function volumesDestroy(ctx: Ctx): number {
  const volumes = ctx.args.map((id) => findVolume(ctx, id));
  for (const volume of volumes) {
    const machine = attachedMachine(volume.id);
    if (machine)
      throw new FlyError(
        `failed destroying volume: volume ${volume.id} is attached to machine ${machine.id}`,
      );
  }
  if (!bool(ctx, "yes")) {
    err("Deleting a volume is not reversible.\n");
    if (!confirm(`Destroy ${volumes.length} volume(s)?`)) return 0;
  }
  for (const volume of volumes) {
    removeDockerVolume(volumeName(volume.id));
    remove("volumes", volume.id);
    out(`Destroyed volume ID: ${volume.id} name: ${volume.name}\n`);
  }
  return 0;
}

function snapshotsCreate(ctx: Ctx): number {
  const volume = findVolume(ctx, ctx.args[0] ?? "");
  const delayMs = snapshotSeconds() * 1000;
  const machine = attachedMachine(volume.id);
  const id = `vs_${randomFrom(ALNUM, 20)}`;
  const createdAt = now();
  let paused = false;
  let sizeBytes: number;
  try {
    if (machine && containerState(containerName(machine.app))?.Running === true) {
      docker(["pause", containerName(machine.app)]);
      paused = true;
    }
    sizeBytes = copyIntoNewVolume(
      volumeName(volume.id),
      snapshotName(id),
      "fly-snapshot",
      volume.app,
    );
  } finally {
    if (paused && machine) docker(["unpause", containerName(machine.app)]);
  }
  write("snapshots", id, {
    id,
    app: volume.app,
    volumeId: volume.id,
    sizeBytes,
    volumeSizeBytes: volume.sizeGb * 1024 ** 3,
    digest: hex(32),
    createdAt,
    readyAt: new Date(Date.now() + delayMs).toISOString(),
  } satisfies SnapshotRecord);
  out(`Scheduled to snapshot volume ${volume.id}\n`);
  return 0;
}

function snapshotsList(ctx: Ctx): number {
  const volumeId = ctx.args[0] ?? "";
  const volume = read<VolumeRecord>("volumes", volumeId);
  const appName = appNameOf(ctx) ?? volume?.app;
  const snapshots = all<SnapshotRecord>("snapshots").filter(
    (s) => s.volumeId === volumeId && s.app === appName,
  );
  if (snapshots.length === 0 && (volume === undefined || volume.app !== appName))
    throw new FlyError(`failed retrieving snapshots: volume ${volumeId} not found`);
  if (bool(ctx, "json")) {
    printJson(snapshots.map(snapshotJson));
    return 0;
  }
  if (snapshots.length === 0) {
    err(`No snapshots available for volume ${volumeId}\n`);
    return 0;
  }
  out("Snapshots\n");
  table(
    ["ID", "Status", "Stored Size", "Vol Size", "Created At", "Retention Days"],
    snapshots
      .map(snapshotJson)
      .map((s) => [
        s.id || "(pending)",
        s.status,
        `${s.size} B`,
        `${s.volume_size / 1024 ** 3} GiB`,
        relativeTime(s.created_at),
        "5",
      ]),
  );
  return 0;
}

interface LocalImage {
  readonly id: string;
  readonly repoDigests: ReadonlyArray<string>;
  readonly labels: Readonly<Record<string, string>>;
}

function localImage(ref: string): LocalImage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(docker(["image", "inspect", "--format", "{{json .}}", ref]));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { Id?: unknown; RepoDigests?: unknown; Config?: { Labels?: unknown } };
  const labels = record.Config?.Labels;
  return {
    id: typeof record.Id === "string" ? record.Id : "",
    repoDigests: Array.isArray(record.RepoDigests)
      ? record.RepoDigests.filter((d): d is string => typeof d === "string")
      : [],
    // The fixture's own labels mark what it built; a real build reports only the Dockerfile's.
    labels:
      typeof labels === "object" && labels !== null
        ? Object.fromEntries(
            Object.entries(labels).filter(
              (e): e is [string, string] =>
                typeof e[1] === "string" && !e[0].startsWith(FIXTURE_LABEL),
            ),
          )
        : {},
  };
}

/** Splits `[registry/]repository[:tag][@digest]` the way Fly's image resolver reports it. */
function remoteRef(ref: string, image: LocalImage): ImageRef {
  const [name = "", pinned] = ref.split("@");
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const repoPath = colon > slash ? name.slice(0, colon) : name;
  const tag = colon > slash ? name.slice(colon + 1) : "latest";
  const [first = "", ...rest] = repoPath.split("/");
  const hasRegistry = rest.length > 0 && (/[.:]/.test(first) || first === "localhost");
  const repository = hasRegistry
    ? rest.join("/")
    : rest.length > 0
      ? repoPath
      : `library/${repoPath}`;
  const digest =
    pinned ??
    image.repoDigests.find((d) => d.startsWith(`${repoPath}@`))?.split("@")[1] ??
    image.id;
  return {
    registry: hasRegistry ? first : "docker-hub-mirror.fly.io",
    repository,
    tag,
    digest,
    labels: image.labels,
  };
}

interface ResolvedImage {
  readonly run: string;
  readonly ref: ImageRef;
  readonly builtTag?: string;
}

function findLocally(ref: string): LocalImage | undefined {
  out(`Searching for image '${ref}' locally...\n`);
  return localImage(ref);
}

/**
 * The daemon flyctl's `newDockerClientFactory` picks (imgsrc/docker.go:184-202). Depot, its default
 * builder, keeps `env.IsCI` from preferring the local daemon (`NewDockerDaemonType`), so only
 * `--local-only` reaches it.
 */
function dockerDaemon(ctx: Ctx): "local" | "remote" | "none" {
  if (!bool(ctx, "local-only")) return "remote";
  return bool(ctx, "remote-only") ? "none" : "local";
}

function resolveImage(ctx: Ctx, appName: string, loaded: LoadedConfig): ResolvedImage {
  const requested = str(ctx, "image") ?? loaded.config.buildImage;
  const deployment = `deployment-${ulid()}`;
  const daemon = dockerDaemon(ctx);
  out("==> Building image\n");
  if (!requested) {
    if (daemon === "none")
      throw new FlyError(
        "failed to fetch an image or build from source: docker is unavailable to build the deployment image",
      );
    const dockerfile = NodePath.resolve(
      loaded.dir,
      str(ctx, "dockerfile") ?? loaded.config.dockerfile ?? "Dockerfile",
    );
    if (!NodeFS.existsSync(dockerfile))
      throw new FlyError(
        "app does not have a Dockerfile or buildpacks configured. See https://fly.io/docs/reference/configuration/#the-build-section",
      );
    const tag = `registry.fly.io/${appName}:${deployment}`;
    const buildArgs = list(ctx, "build-arg").flatMap((arg) => ["--build-arg", arg]);
    const labels = [
      `${FIXTURE_LABEL}=fly-image`,
      `${APP_LABEL}=${appName}`,
      `${HOME_LABEL}=${HOME_ID}`,
    ];
    const build = NodeChildProcess.spawnSync(
      "docker",
      [
        "build",
        "--tag",
        tag,
        "--file",
        dockerfile,
        ...labels.flatMap((label) => ["--label", label]),
        ...buildArgs,
        loaded.dir,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (build.status !== 0) throw new FlyError("failed to fetch an image or build from source");
    const image = localImage(tag);
    if (!image) throw new FlyError(`failed to find built image ${tag}`);
    out(`image: ${tag}\n`);
    return {
      run: tag,
      builtTag: tag,
      ref: {
        registry: "registry.fly.io",
        repository: appName,
        tag: deployment,
        digest: image.id,
        labels: image.labels,
      },
    };
  }
  // flyctl's no-daemon factory is not remote, so its local resolver runs and fails first.
  if (daemon === "none")
    throw new FlyError("failed to fetch an image or build from source: no docker daemon available");
  const local = daemon === "local" ? findLocally(requested) : undefined;
  if (local) {
    out(`image found: ${local.id}\n`);
    return {
      run: local.id,
      ref: {
        registry: "registry.fly.io",
        repository: appName,
        tag: deployment,
        digest: local.id,
        labels: local.labels,
      },
    };
  }
  out(`Searching for image '${requested}' remotely...\n`);
  const pull = NodeChildProcess.spawnSync("docker", ["pull", "--quiet", requested], {
    encoding: "utf8",
  });
  const pulled = pull.status === 0 ? localImage(requested) : undefined;
  if (!pulled)
    throw new FlyError(
      `failed to fetch an image or build from source: could not find image "${requested}": ${pull.stderr.trim()}`,
    );
  out(`image found: ${pulled.id}\n`);
  return { run: pulled.id, ref: remoteRef(requested, pulled) };
}

function chooseVolume(
  appName: string,
  mount: Mount,
  region: string,
  previous: MachineRecord | undefined,
): VolumeRecord {
  const kept = previous?.config.mounts?.[0]?.volume;
  const keptVolume = kept ? read<VolumeRecord>("volumes", kept) : undefined;
  if (keptVolume && keptVolume.name === mount.source) return keptVolume;
  const free = all<VolumeRecord>("volumes").find(
    (v) =>
      v.app === appName &&
      v.name === mount.source &&
      v.region === region &&
      (!attachedMachine(v.id) || attachedMachine(v.id)?.id === previous?.id),
  );
  if (free) return free;
  const size = mount.initialSizeGb ?? 1;
  out(
    `Creating a ${size} GB volume named '${mount.source}' for process group 'app'. Use 'fly vol extend' to increase its size\n`,
  );
  return newVolume(appName, mount.source, region, size);
}

interface Probe {
  readonly url: string;
  readonly wget: ReadonlyArray<string>;
  /** With no check configured, any HTTP answer shows the app is up. */
  readonly anyAnswer: boolean;
}

/** The requests Fly Proxy makes for each check, refused up front when this fake cannot make them. */
function healthProbes(container: string, http: HttpService | undefined): ReadonlyArray<Probe> {
  const base = `http://${container}:${http?.internalPort ?? 8080}`;
  if (!http || http.checks.length === 0)
    return [{ url: `${base}/`, wget: ["-T", "2", `${base}/`], anyAnswer: true }];
  return http.checks.map((check) => {
    const path = check.path ?? "/";
    if (check.method !== undefined && check.method.toUpperCase() !== "GET")
      throw new FlyError(
        `fake fly sends checks only as GET, but the check of ${path} uses ${check.method}`,
      );
    if (check.protocol !== undefined && check.protocol !== "http")
      throw new FlyError(
        `fake fly sends checks only over http, but the check of ${path} uses ${check.protocol}`,
      );
    // Fly raises a check timeout under 1s and lowers one over 1m (flyctl's validation warns so).
    const seconds = Math.min(
      60,
      Math.max(1, Math.ceil((durationMs(check.timeout ?? "2s") ?? 2000) / 1000)),
    );
    const headers = (check.headers ?? []).flatMap((header) =>
      header.values.flatMap((value) => ["--header", `${header.name}: ${value}`]),
    );
    const url = `${base}${path}`;
    return {
      url,
      wget: ["-T", String(seconds), ...headers, url],
      anyAnswer: false,
    };
  });
}

function probePasses(probe: Probe): boolean {
  try {
    docker(["exec", caddyContainer(), "wget", "-q", "-O", "/dev/null", ...probe.wget]);
    return true;
  } catch (error) {
    const answered = error instanceof DockerError && /server returned error/.test(error.stderr);
    return answered && probe.anyAnswer;
  }
}

/** Each probe is a `docker exec`, so rounds with no pause at all would load the shared Docker VM. */
const HEALTH_POLL_MS = 200;

/** As flyctl does, waits until every check passes in the same round. */
function waitForHealthy(
  container: string,
  machine: MachineRecord,
  probes: ReadonlyArray<Probe>,
  ms: number,
): void {
  const deadline = Date.now() + ms;
  for (;;) {
    const failing = probes.find((probe) => !probePasses(probe));
    if (!failing) return;
    const state = containerState(container);
    if (state && !state.Running && !state.Restarting && state.Status === "exited") {
      const logs = NodeChildProcess.spawnSync("docker", ["logs", "--tail", "20", container], {
        encoding: "utf8",
      });
      err(`${logs.stdout}${logs.stderr}`);
      throw new FlyError(`Smoke checks for ${machine.id} failed: the app appears to be crashing`);
    }
    if (Date.now() > deadline)
      throw new FlyError(
        `timeout reached waiting for machine ${machine.id} to become healthy at ${failing.url}`,
      );
    sleepSync(HEALTH_POLL_MS);
  }
}

/**
 * Real Fly leaves this unset and the image derives `<app>.fly.dev`, which does not exist here.
 * It goes only into the container, so the machine config matches what real Fly reports.
 */
function localPublicUrl(
  env: Readonly<Record<string, string>>,
  url: string,
): Readonly<Record<string, string>> {
  return env.SAIL_PUBLIC_URL ? {} : { SAIL_PUBLIC_URL: url };
}

/** flyctl's `cmdutil.ParseKVStringsToMap`, behind `--env`. */
function parseEnv(pairs: ReadonlyArray<string>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    pairs.map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 1)
        throw new FlyError(
          `failed parsing environment: '${pair}': must be in the format NAME=VALUE`,
        );
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
}

const STRATEGIES = ["canary", "rolling", "immediate", "bluegreen"];

/** flyctl's `validateDeploySection` on a strategy; this fake replaces its one machine in place for each. */
function validateStrategy(
  strategy: string,
  config: DeployConfig,
  file: string | undefined,
  print: (text: string) => void,
): void {
  const problems = [
    ...(STRATEGIES.includes(strategy)
      ? []
      : [
          `unsupported deployment strategy '${strategy}'; Apps v2 supports the following strategies: ${STRATEGIES.join(", ")}`,
        ]),
    ...(strategy === "canary" && config.mounts.length > 0
      ? ["error canary deployment strategy is not supported when using mounted volumes"]
      : []),
  ];
  if (problems.length === 0) return;
  print(`Validating ${file ?? ""}\n${problems.join("")}\n   ✘invalid app configuration\n`);
  throw new FlyError("App configuration is not valid");
}

/**
 * flyctl's `blueGreen.Deploy` for this fake's one machine: green starts beside blue and takes
 * blue's container name, and with it the Caddy route, once its checks pass.
 */
function replaceBlueWithGreen(
  blue: MachineRecord,
  green: MachineRecord,
  http: HttpService | undefined,
  waitMs: number,
  start: (container: string) => void,
): void {
  err("\nVerifying if app can be safely deployed \n");
  if (!http || http.checks.length === 0) {
    err(
      `\n[WARN] Machine ${blue.id} [app] doesn't have healthchecks setup. We won't check its health.`,
    );
    err(
      "\n\nYou need to define at least 1 check in order to use blue-green deployments. Refer to https://fly.io/docs/reference/configuration/#services-tcp_checks\n",
    );
    throw new FlyError("app not in valid state for bluegreen deployments");
  }
  const live = containerName(blue.app);
  const greenName = swapName(blue.app, "green");
  const blueName = swapName(blue.app, "blue");
  for (const leftover of [greenName, blueName]) destroyMachineContainer(leftover);
  err("\nCreating green machines\n");
  start(greenName);
  err(`  Created machine ${green.id} [app]\n\nWaiting for all green machines to be healthy\n`);
  try {
    waitForHealthy(greenName, green, healthProbes(greenName, http), waitMs);
  } catch (error) {
    destroyMachineContainer(greenName);
    err(`\nRolling back failed deployment\n  Deleted machine ${green.id} [app]\n`);
    throw error instanceof FlyError
      ? new FlyError("wait timeout\ncould not get all green machines to be healthy")
      : error;
  }
  write("machines", green.id, green);
  remove("machines", blue.id);
  if (ownership("container", live) === "mine") docker(["rename", live, blueName]);
  docker(["rename", greenName, live]);
  err("\nStopping all blue machines\n");
  stopMachineContainer(blueName, blue.config.stop_config);
  err("\nDestroying all blue machines\n");
  destroyMachineContainer(blueName);
  err("\nDeployment Complete\n");
}

function deploy(ctx: Ctx): number {
  const workingDirectory = ctx.args[0] === undefined ? undefined : NodePath.resolve(ctx.args[0]);
  const loaded = loadConfig(ctx, workingDirectory);
  const appName = str(ctx, "app") || process.env.FLY_APP || loaded.config.app;
  if (!appName)
    throw new FlyError(
      "the config for your app is missing an app name, add an app field to the fly.toml file or specify with the -a flag",
    );
  const app = requireApp(appName);
  const waitText = str(ctx, "wait-timeout") ?? "5m0s";
  const waitMs = durationMs(waitText);
  if (waitMs === undefined) throw new FlyError(`invalid duration "${waitText}" for --wait-timeout`);
  if (!reserveName(APP_NAMES, appName, HOME))
    throw new FlyError(`app ${appName} belongs to another fake fly home`);
  refuseForeign("container", containerName(appName));
  out("==> Verifying app config\n");
  const config = loaded.file ? loaded.config : (app.config ?? EMPTY_CONFIG);
  const extraEnv = parseEnv(list(ctx, "env"));
  // flyctl checks the fly.toml strategy before `--strategy` replaces it (deploy.go:773, machines.go:853-858).
  if (config.deployStrategy) validateStrategy(config.deployStrategy, config, loaded.file, out);
  const strategy = str(ctx, "strategy") || config.deployStrategy || "rolling";
  validateStrategy(strategy, config, loaded.file, err);
  out(`--> Verified app config\n`);
  const http = config.http;
  const probes = healthProbes(containerName(appName), http);
  const previous = machineOf(appName);
  const blueGreen = previous !== undefined && strategy === "bluegreen";
  if (blueGreen && config.mounts.length > 0)
    throw new FlyError("fake fly does not model bluegreen deploys of an app with [[mounts]]");
  if (ctx.flags.get("ha") !== false)
    err("fake fly: runs one machine per app; real Fly adds a standby machine unless --ha=false\n");
  const image = resolveImage(ctx, appName, loaded);
  const kept = blueGreen ? undefined : previous;
  const region = str(ctx, "primary-region") ?? config.primaryRegion ?? previous?.region ?? "iad";
  const machineId = kept?.id ?? hex(7);
  const version = ulid();
  const releaseVersion = app.releaseVersion + 1;
  const memory = config.memoryMb ?? 2048;
  const port = http?.internalPort ?? 8080;
  ensureCaddy(HOME_ID);
  const url = publicUrl(appHost(appName));

  out(`Watch your deployment at https://fly.io/apps/${appName}/monitoring\n\n`);
  out(
    previous
      ? `This deployment will:\n * update 1 "app" machine\n\n`
      : `This deployment will:\n * create 1 "app" machine\n\nNo machines in group app, launching a new machine\n`,
  );

  const mount = config.mounts[0];
  const volume = mount ? chooseVolume(appName, mount, region, previous) : undefined;
  const env = {
    ...config.env,
    ...extraEnv,
    FLY_PROCESS_GROUP: "app",
    PRIMARY_REGION: region,
  };
  const machineConfig: MachineConfigJson = {
    env,
    init: {},
    guest: { cpu_kind: config.cpuKind ?? "shared", cpus: config.cpus ?? 1, memory_mb: memory },
    metadata: {
      fly_flyctl_version: "0.4.123",
      fly_platform_version: "v2",
      fly_process_group: "app",
      fly_release_id: randomFrom(ALNUM, 13),
      fly_release_version: String(releaseVersion),
    },
    ...(mount && volume
      ? {
          mounts: [
            {
              encrypted: true,
              path: mount.destination,
              size_gb: volume.sizeGb,
              volume: volume.id,
              name: volume.name,
            },
          ],
        }
      : {}),
    ...(http
      ? {
          services: [
            {
              protocol: "tcp",
              internal_port: http.internalPort,
              ...(http.autostop === undefined ? {} : { autostop: http.autostop }),
              ...(http.autostart === undefined ? {} : { autostart: http.autostart }),
              ...(http.minMachinesRunning === undefined
                ? {}
                : { min_machines_running: http.minMachinesRunning }),
              ports: [
                { port: 80, handlers: ["http"], ...(http.forceHttps ? { force_https: true } : {}) },
                { port: 443, handlers: ["http", "tls"] },
              ],
              ...(http.checks.length > 0 ? { checks: http.checks } : {}),
              force_instance_key: null,
            },
          ],
        }
      : {}),
    image: fullImageRef(image.ref),
    restart: { policy: "on-failure", max_retries: 10 },
    ...(config.stop ? { stop_config: config.stop } : {}),
  };
  const timestamp = flapsTime(now());
  const machine: MachineRecord = {
    id: machineId,
    app: appName,
    name: kept?.name ?? friendlyName(),
    region,
    privateIp: kept?.privateIp ?? `fdaa:0:${hex(2)}:a7b:${hex(2)}:${hex(2)}:${hex(2)}:2`,
    createdAt: kept?.createdAt ?? timestamp,
    updatedAt: timestamp,
    version,
    imageRef: image.ref,
    config: machineConfig,
    ...(image.builtTag ? { builtTag: image.builtTag } : {}),
  };
  const runtimeEnv = {
    ...env,
    FLY_APP_NAME: appName,
    FLY_MACHINE_ID: machineId,
    FLY_REGION: region,
    FLY_IMAGE_REF: fullImageRef(image.ref),
    FLY_MACHINE_VERSION: version,
    FLY_VM_MEMORY_MB: String(memory),
    ...localPublicUrl(env, url),
  };

  const start = (container: string) =>
    docker([
      "run",
      "--detach",
      "--name",
      container,
      "--hostname",
      machineId,
      "--network",
      NETWORK,
      "--label",
      `${FIXTURE_LABEL}=fly-machine`,
      "--label",
      `${APP_LABEL}=${appName}`,
      "--label",
      `${HOME_LABEL}=${HOME_ID}`,
      "--restart",
      "on-failure",
      "--memory",
      `${memory}m`,
      ...Object.entries(runtimeEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ...(mount && volume ? ["--volume", `${volumeName(volume.id)}:${mount.destination}`] : []),
      image.run,
    ]);

  if (previous) out(`Updating existing machines in '${appName}' with ${strategy} strategy\n`);
  if (blueGreen) replaceBlueWithGreen(previous, machine, http, waitMs, start);
  else {
    if (previous) stopMachineContainer(containerName(appName), previous.config.stop_config);
    destroyMachineContainer(containerName(appName));
    write("machines", machine.id, machine);
    start(containerName(appName));
  }
  if (previous?.builtTag && previous.builtTag !== image.builtTag) removeBuiltTag(previous.builtTag);
  write("apps", appName, {
    ...app,
    releaseVersion,
    deployedAt: now(),
    config,
  } satisfies AppRecord);
  publishSite({
    id: siteId(appName),
    home: HOME_ID,
    host: appHost(appName),
    upstream: `${containerName(appName)}:${port}`,
    plainHttp: http !== undefined && !http.forceHttps,
    headers: {
      "Fly-Forwarded-Proto": "{http.request.scheme}",
      "Fly-Forwarded-Port": "{http.request.local.port}",
      "X-Forwarded-Port": "{http.request.local.port}",
      "Fly-Client-IP": "{remote_host}",
    },
  });
  if (!blueGreen) {
    out(`Machine ${machineId} [app] ${previous ? "update" : "launch"} started\n`);
    if (!bool(ctx, "detach")) {
      // flyctl's `immediate` skips smoke and health checks (machines_deploymachinesapp.go:712-718, 1211-1214).
      if (strategy !== "immediate") {
        out(`Waiting for ${machineId} to become healthy (started)\n`);
        waitForHealthy(containerName(appName), machine, probes, waitMs);
      }
      out(`Machine ${machineId} [app] ${previous ? "update" : "launch"} succeeded\n`);
    }
  }
  out(`\nVisit your newly deployed app at ${url}/\n`);
  return 0;
}

function requireMachine(appName: string, id?: string): MachineRecord {
  const machine = machineOf(appName);
  if (id !== undefined && machine?.id !== id)
    throw new FlyError(`failed to get machine ${id}: machine not found`);
  if (!machine) throw new FlyError(`app ${appName} has no machines`);
  return machine;
}

/** flyctl runs `-C` without a shell: split into words, honoring quotes, with no expansion. */
function splitWords(command: string): Array<string> {
  const words: Array<string> = [];
  let word: string | undefined;
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && /["\\$`]/.test(command[i + 1] ?? ""))
        word = (word ?? "") + (command[++i] ?? "");
      else word = (word ?? "") + c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\") {
      word = (word ?? "") + (command[++i] ?? "");
    } else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + c;
  }
  if (quote) throw new FlyError(`invalid command: unterminated ${quote} quote`);
  if (word !== undefined) words.push(word);
  return words;
}

const LOGIN_SHELL =
  'cd ~ 2>/dev/null; s=$(awk -F: -v u="$(id -un)" \'$1==u{print $7}\' /etc/passwd 2>/dev/null); exec "${s:-/bin/sh}" -l';

/** flyctl's `selectMachine` for `ssh console`, with `--machine` and `--region`. */
function sshMachine(ctx: Ctx, appName: string): MachineRecord {
  const machines = all<MachineRecord>("machines").filter((m) => m.app === appName);
  const id = str(ctx, "machine");
  const requested = id ? machines.find((m) => m.id === id) : undefined;
  if (id && !requested) {
    const owner = read<MachineRecord>("machines", id)?.app;
    throw new FlyError(
      owner
        ? `machine ${id} belongs to app ${owner}, not selected app ${appName}`
        : `machine ${id} was not found in app ${appName}`,
    );
  }
  const started = machines.filter((m) => machineState(m) === "started");
  if (requested && !started.includes(requested)) throw new FlyError(`machine ${id} is not started`);
  if (started.length === 0)
    throw new FlyError(
      `app ${appName} has no started VMs.\nIt may be unhealthy or not have been deployed yet.\nTry the following command to verify:\n\nfly status`,
    );
  const region = str(ctx, "region");
  const [first] = region ? started.filter((m) => m.region === region) : started;
  if (!first) throw new FlyError(`app ${appName} has no VMs in region ${region}`);
  if (requested && region && requested.region !== region)
    throw new FlyError(
      `machine ${id} is in region ${requested.region}, not selected region ${region}`,
    );
  return requested ?? first;
}

function sshConsole(ctx: Ctx): number {
  const appName = requireAppName(ctx);
  requireApp(appName);
  const machine = sshMachine(ctx, appName);
  const command = str(ctx, "command");
  if (!bool(ctx, "quiet")) err(`Connecting to ${machine.privateIp}... complete\n`);
  const tty = process.stdin.isTTY && (bool(ctx, "pty") || command === undefined);
  const words = command === undefined ? ["sh", "-c", LOGIN_SHELL] : splitWords(command);
  const result = NodeChildProcess.spawnSync(
    "docker",
    [
      "exec",
      "--interactive",
      ...(tty ? ["--tty"] : []),
      "--user",
      str(ctx, "user") ?? "root",
      containerName(appName),
      ...words,
    ],
    { stdio: "inherit" },
  );
  return result.status ?? 1;
}

let activeChild: NodeChildProcess.ChildProcess | undefined;

/** Docker trims trailing zeros from nanoseconds; pad them so timestamps compare as strings. */
const sortableTime = (ts: string) =>
  ts.replace(
    /(\.\d+)?Z$/,
    (_, fraction: string | undefined) => `${(fraction ?? ".").padEnd(10, "0")}Z`,
  );

/**
 * `docker logs` writes the app's stderr to its own stderr, beside Docker's errors, such as one for a
 * container a redeploy just removed; only the app's lines carry a timestamp.
 */
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;

function streamLogs(
  args: ReadonlyArray<string>,
  onLine: (timestamp: string, message: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(
      "sh",
      ["-c", 'exec docker logs "$@" 2>&1', "sh", ...args],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    activeChild = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const [, timestamp, message] = LOG_LINE.exec(line) ?? [];
        if (timestamp !== undefined) onLine(timestamp, message ?? "");
      }
    });
    child.on("close", () => {
      activeChild = undefined;
      resolve();
    });
  });
}

/** flyctl's `logs.LogEntry` for a line the app wrote; only `meta`'s `status_code` has a JSON tag. */
function logEntry(machine: MachineRecord, timestamp: string, message: string) {
  return {
    level: "info",
    instance: machine.id,
    message,
    region: machine.region,
    timestamp,
    meta: {
      Instance: machine.id,
      Region: machine.region,
      Event: { Provider: "app" },
      HTTP: { Request: { ID: "", Method: "", Version: "" }, Response: { status_code: 0 } },
      Error: { Code: 0, Message: "" },
      URL: { Full: "" },
    },
  };
}

async function logs(ctx: Ctx): Promise<number> {
  const appName = requireAppName(ctx);
  requireApp(appName);
  const json = bool(ctx, "json");
  const machineFilter = str(ctx, "machine");
  // flyctl drops the region, flag or FLY_REGION, once a machine is named.
  const regionFilter = machineFilter ? undefined : str(ctx, "region") || process.env.FLY_REGION;
  const print = (machine: MachineRecord) => (timestamp: string, message: string) => {
    if (json) printJson(logEntry(machine, timestamp, message));
    else out(`${timestamp} app[${machine.id}] ${machine.region} [info] ${message}\n`);
  };
  const matches = (machine: MachineRecord) =>
    (!machineFilter || machine.id === machineFilter) &&
    (!regionFilter || machine.region === regionFilter);

  if (bool(ctx, "no-tail")) {
    const machine = machineOf(appName);
    if (machine && matches(machine) && exists("container", containerName(appName)))
      await streamLogs(["--timestamps", containerName(appName)], print(machine));
    return 0;
  }

  let followed = "";
  let last = "";
  while (read<AppRecord>("apps", appName)) {
    const machine = machineOf(appName);
    const containerId = machine
      ? docker([
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `name=^${containerName(appName)}$`,
        ]).trim()
      : "";
    if (machine && containerId && matches(machine)) {
      const resumed = containerId === followed && last !== "";
      if (!resumed) last = "";
      const emit = print(machine);
      await streamLogs(
        ["--timestamps", "--follow", ...(resumed ? ["--since", last] : []), containerId],
        (timestamp, message) => {
          const sortable = sortableTime(timestamp);
          if (sortable <= last) return;
          last = sortable;
          emit(timestamp, message);
        },
      );
      followed = containerId;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return 0;
}

function imageShow(ctx: Ctx): number {
  const appName = requireAppName(ctx);
  requireApp(appName);
  const json = bool(ctx, "json");
  const entry = (machine: MachineRecord) => {
    const ref = machine.imageRef;
    const labels = Object.keys(ref.labels).length > 0 ? ref.labels : undefined;
    return {
      MachineID: machine.id,
      Registry: ref.registry,
      Repository: ref.repository,
      Tag: ref.tag,
      Version: ref.labels[FLY_VERSION] || "N/A",
      Digest: ref.digest,
      Labels: labels
        ? json
          ? goJson(labels)
          : Object.entries(labels)
              .map(([key, value]) => `${key}=${value}`)
              .join("")
        : "",
    };
  };
  const id = ctx.args[0];
  if (id !== undefined) {
    const machine = requireMachine(appName, id);
    if (json) printJson(entry(machine));
    else {
      verticalTable(
        "Image Details",
        Object.entries(entry(machine)).filter(([key]) => key !== "MachineID"),
      );
    }
    return 0;
  }
  const machines = all<MachineRecord>("machines").filter((m) => m.app === appName);
  if (json) {
    printJson(machines.length > 0 ? machines.map(entry) : null);
    return 0;
  }
  out("Image Details\n");
  table(
    ["Machine ID", "Registry", "Repository", "Tag", "Version", "Digest", "Labels"],
    machines.map((m) => Object.values(entry(m))),
  );
  return 0;
}

/** flyctl's `selectOneMachine`: an app name when one is given, else the machine's own app. */
function statusMachine(ctx: Ctx): MachineRecord {
  const id = ctx.args[0];
  const named = appNameOf(ctx);
  if (id === undefined) {
    if (!named) throw new FlyError("a machine ID or an app name is required");
    if (!process.stdin.isTTY)
      throw new FlyError("a machine ID must be specified when not running interactively");
    throw new FlyError("fake fly does not prompt for a machine; pass its ID");
  }
  const machine = read<MachineRecord>("machines", id);
  if (!named && !machine)
    throw new FlyError(
      `could not get machine from GraphQL to determine app name: machine ${id} not found`,
    );
  const appName = named ?? machine?.app ?? "";
  requireApp(appName);
  if (machine?.app !== appName)
    throw new FlyError(`machine ${id} was not found in app '${appName}'`);
  return machine;
}

function machineStatus(ctx: Ctx): number {
  const machine = statusMachine(ctx);
  const config = machine.config;
  if (bool(ctx, "display-config")) {
    out(`${goJson(config, 2)}\n`);
    return 0;
  }
  const state = machineState(machine);
  out(
    `Machine ID: ${machine.id}\nVersion: ${machine.version}\nState: ${state}\nHostStatus: ok\n\n`,
  );
  verticalTable("VM", [
    ["ID", machine.id],
    ["Version", machine.version],
    ["State", state],
    ["Image", imageRefWithVersion(machine.imageRef)],
    ["Name", machine.name],
    ["Private IP", machine.privateIp],
    ["Region", machine.region],
    ["Process Group", "app"],
    ["CPU Kind", config.guest.cpu_kind],
    ["vCPUs", String(config.guest.cpus)],
    ["Memory", String(config.guest.memory_mb)],
    ["Created", machine.createdAt],
    ["Updated", machine.updatedAt],
    ["Entrypoint", ""],
    ["Command", ""],
    ...(config.mounts?.[0] ? [["Volume", config.mounts[0].volume] as const] : []),
  ]);
  out("Event Logs\n");
  table(
    ["State", "Event", "Source", "Timestamp", "Info"],
    [
      ["started", "start", "flyd", machine.updatedAt, ""],
      ["created", "launch", "user", machine.updatedAt, ""],
    ],
  );
  return 0;
}

function machineList(ctx: Ctx): number {
  const appName = requireAppName(ctx);
  requireApp(appName);
  const machines = all<MachineRecord>("machines").filter((m) => m.app === appName);
  if (bool(ctx, "json")) {
    printJson(machines.map(machineJson));
    return 0;
  }
  if (bool(ctx, "quiet")) {
    for (const machine of machines) out(`${machine.id}\n`);
    return 0;
  }
  if (machines.length === 0) {
    out(`No machines are available on this app ${appName}\n`);
    return 0;
  }
  out(`${machines.length} machines have been retrieved from app ${appName}.\n\n`);
  table(
    ["ID", "Name", "State", "Region", "Image", "IP Address", "Volume", "Created", "Last Updated"],
    machines.map((m) => [
      m.id,
      m.name,
      machineState(m),
      m.region,
      imageRefWithVersion(m.imageRef),
      m.privateIp,
      m.config.mounts?.[0]?.volume ?? "",
      m.createdAt,
      m.updatedAt,
    ]),
  );
  return 0;
}

/** The map flyctl's `renderMachineJSONStatus` prints; real `Hostname` is `<app>.fly.dev`. */
function statusJson(app: AppRecord) {
  const status = appStatus(app);
  const { ID, InternalNumericID, Name, Slug, RawSlug, PaidPlan } = organizationJson();
  return {
    ID: app.name,
    Name: app.name,
    Deployed: status === "deployed",
    Status: status,
    Hostname: appHost(app.name),
    Version: app.releaseVersion,
    AppURL: exists("container", caddyContainer())
      ? publicUrl(appHost(app.name))
      : `https://${appHost(app.name)}`,
    Organization: { ID, InternalNumericID, Name, Slug, RawSlug, PaidPlan },
    PlatformVersion: "machines",
    Machines: all<MachineRecord>("machines")
      .filter((m) => m.app === app.name)
      .toSorted((a, b) => b.id.localeCompare(a.id))
      .map(machineJson),
  };
}

function status(ctx: Ctx): number {
  const app = requireApp(requireAppName(ctx));
  const json = statusJson(app);
  if (bool(ctx, "json")) {
    printJson(json);
    return 0;
  }
  const machines = all<MachineRecord>("machines").filter((m) => m.app === app.name);
  const image = machines[0] ? imageRefWithVersion(machines[0].imageRef) : "";
  verticalTable("App", [
    ["Name", json.Name],
    ["Owner", json.Organization.Slug],
    ["Hostname", json.Hostname],
    ["Image", image],
  ]);
  if (machines.length === 0) return 0;
  out("Machines\n");
  table(
    ["Process", "ID", "Version", "Region", "State", "Role", "Checks", "Last Updated"],
    machines.map((m) => [
      "app",
      m.id,
      m.config.metadata.fly_release_version ?? "",
      m.region,
      machineState(m),
      "",
      "",
      m.updatedAt,
    ]),
  );
  return 0;
}

function machineDestroy(ctx: Ctx): number {
  const appName = appNameOf(ctx);
  for (const id of ctx.args) {
    const machine = read<MachineRecord>("machines", id);
    if (!machine || (appName && machine.app !== appName))
      throw new FlyError(`could not get machine ${id}: machine not found`);
    const state = machineState(machine);
    if (state === "started" && !bool(ctx, "force"))
      throw new FlyError(`machine ${id} currently started, either stop first or use --force flag`);
    out(`machine ${id} was found and is currently in ${state} state, attempting to destroy...\n`);
    destroyMachineContainer(containerName(machine.app));
    removeBuiltTag(machine.builtTag);
    remove("machines", id);
    out(`${id} has been destroyed\n`);
  }
  return 0;
}

const COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["auth", "whoami"],
    short: "Show the currently authenticated user",
    flags: [JSON_OUT],
    args: [0, 0],
    mutating: false,
    session: true,
    run: whoami,
  },
  {
    path: ["auth", "login"],
    short: "Log in a user",
    flags: [],
    args: [0, 0],
    mutating: true,
    session: false,
    run: login,
  },
  {
    path: ["auth", "logout"],
    short: "Logs out the currently logged in user",
    flags: [],
    args: [0, 0],
    mutating: true,
    session: false,
    run: logout,
  },
  {
    path: ["apps", "create"],
    short: "Create a new application.",
    flags: [
      flag("name", "string", "The app name to use"),
      ORG,
      JSON_OUT,
      YES,
      flag("generate-name", "bool", "Generate an app name"),
    ],
    args: [0, 1],
    mutating: true,
    session: true,
    run: appsCreate,
  },
  {
    path: ["apps", "list"],
    aliases: ["ls"],
    short: "List applications.",
    flags: [JSON_OUT, ORG, flag("quiet", "bool", "Only list app names", "q")],
    args: [0, 0],
    mutating: false,
    session: true,
    run: appsList,
  },
  {
    path: ["apps", "destroy"],
    aliases: ["delete", "remove", "rm"],
    short: "Permanently destroy one or more apps.",
    flags: [YES],
    args: [1, Infinity],
    mutating: true,
    session: true,
    run: appsDestroy,
  },
  {
    path: ["volumes", "create"],
    short: "Create a new volume for an app.",
    flags: [
      APP,
      CONFIG,
      REGION,
      flag("size", "int", "The size of volume in gigabytes", "s"),
      YES,
      JSON_OUT,
      flag("snapshot-id", "string", "Create the volume from the specified snapshot"),
      flag("count", "int", "The number of volumes to create", "n"),
    ],
    args: [1, 1],
    mutating: true,
    session: true,
    run: volumesCreate,
  },
  {
    path: ["volumes", "list"],
    aliases: ["ls"],
    short: "List the volumes associated with an app.",
    flags: [
      APP,
      CONFIG,
      JSON_OUT,
      flag("all", "bool", "Show all volumes including those in destroyed states"),
    ],
    args: [0, 0],
    mutating: false,
    session: true,
    run: volumesList,
  },
  {
    path: ["volumes", "destroy"],
    aliases: ["delete", "rm"],
    short: "Destroy one or more volumes.",
    flags: [APP, CONFIG, YES],
    args: [1, Infinity],
    mutating: true,
    session: true,
    run: volumesDestroy,
  },
  {
    path: ["volumes", "snapshots", "create"],
    short: "Create a volume snapshot.",
    flags: [APP, JSON_OUT],
    args: [1, 1],
    mutating: true,
    session: true,
    run: snapshotsCreate,
  },
  {
    path: ["volumes", "snapshots", "list"],
    aliases: ["ls"],
    short: "List snapshots associated with the specified volume.",
    flags: [APP, JSON_OUT],
    args: [1, 1],
    mutating: false,
    session: true,
    run: snapshotsList,
  },
  {
    path: ["status"],
    short: `Show app status. This fake's Hostname is <app>.${DOMAIN} where real Fly's is <app>.fly.dev.`,
    flags: [APP, CONFIG, JSON_OUT],
    args: [0, 0],
    mutating: false,
    session: true,
    run: status,
  },
  {
    path: ["deploy"],
    short: `Deploy Fly applications. This fake runs one machine per app, and sets SAIL_PUBLIC_URL=https://<app>.${DOMAIN} in the machine's runtime environment (not its config) unless the config or --env sets it.`,
    flags: [
      APP,
      flag("image", "string", "The Docker image to deploy", "i"),
      CONFIG,
      flag("ha", "bool", "Create spare machines that increases app availability"),
      YES,
      flag("env", "list", "Set of environment variables in the form of NAME=VALUE pairs", "e"),
      flag("detach", "bool", "Return immediately instead of monitoring deployment progress"),
      flag("now", "bool", "Deploy now without confirmation"),
      flag("strategy", "string", "The strategy for replacing running instances"),
      flag("wait-timeout", "string", "Time duration to wait for machines to become healthy"),
      flag("primary-region", "string", "Override primary region in fly.toml configuration"),
      flag("local-only", "bool", "Perform builds locally using docker"),
      flag("remote-only", "bool", "Perform builds on a remote builder instance"),
      flag("dockerfile", "string", "Path to a Dockerfile"),
      flag("build-arg", "list", "Set of build time variables in the form of NAME=VALUE pairs"),
    ],
    args: [0, 1],
    mutating: true,
    session: true,
    run: deploy,
  },
  {
    path: ["ssh", "console"],
    short: "Connect to a running instance of the current app.",
    flags: [
      APP,
      CONFIG,
      flag("user", "string", 'Unix username to connect as (default "root")', "u"),
      flag("command", "string", "command to run on SSH session", "C"),
      flag("pty", "bool", "Allocate a pseudo-terminal"),
      flag("quiet", "bool", "Don't print progress indicators for WireGuard", "q"),
      flag("select", "bool", "select available instances", "s"),
      flag("machine", "string", "Run the console in the existing machine with the specified ID"),
      REGION,
    ],
    args: [0, 0],
    mutating: false,
    session: true,
    run: sshConsole,
  },
  {
    path: ["logs"],
    short: "View app logs",
    flags: [
      APP,
      CONFIG,
      flag("no-tail", "bool", "Do not continually stream logs", "n"),
      JSON_OUT,
      flag("machine", "string", "Filter by machine ID", "m"),
      REGION,
    ],
    args: [0, 0],
    mutating: false,
    session: true,
    run: logs,
  },
  {
    path: ["image", "show"],
    short: "Show image details.",
    flags: [APP, CONFIG, JSON_OUT],
    args: [0, 1],
    mutating: false,
    session: true,
    run: imageShow,
  },
  {
    path: ["machine", "status"],
    short: "Show current status of a running machine",
    flags: [APP, CONFIG, flag("display-config", "bool", "Display the machine config as JSON", "d")],
    args: [0, 1],
    mutating: false,
    session: true,
    run: machineStatus,
  },
  {
    path: ["machine", "list"],
    aliases: ["ls"],
    short: "List Fly machines",
    flags: [APP, CONFIG, JSON_OUT, flag("quiet", "bool", "Only list machine ids", "q")],
    args: [0, 0],
    mutating: false,
    session: true,
    run: machineList,
  },
  {
    path: ["machine", "destroy"],
    aliases: ["remove", "rm"],
    short: "Destroy Fly machines",
    flags: [
      APP,
      CONFIG,
      flag("force", "bool", "force kill machine regardless of current state", "f"),
    ],
    args: [1, Infinity],
    mutating: true,
    session: true,
    run: machineDestroy,
  },
];

type Resolved =
  | { readonly kind: "command"; readonly command: Command; readonly depth: number }
  | { readonly kind: "group"; readonly path: ReadonlyArray<string> }
  | { readonly kind: "unknown"; readonly word: string; readonly path: ReadonlyArray<string> };

/**
 * Cobra finds the command before it parses flags: a group knows only the global flags, and any
 * other flag before a word is assumed to take a value unless written `--flag=value`.
 */
function takesValue(token: string): boolean {
  if (token.includes("=")) return false;
  if (token.startsWith("--"))
    return GLOBAL_FLAGS.find((s) => s.name === token.slice(2))?.kind !== "bool";
  return token.length === 2 && GLOBAL_FLAGS.find((s) => s.short === token[1])?.kind !== "bool";
}

function resolve(argv: ReadonlyArray<string>): Resolved {
  const path: Array<string> = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (word === "--") break;
    if (word.startsWith("-") && word.length > 1) {
      if (takesValue(word)) i++;
      continue;
    }
    const below = COMMANDS.filter((c) => path.every((segment, j) => c.path[j] === segment));
    const match = below.find((c) => {
      const segment = c.path[path.length];
      if (segment === undefined) return false;
      if (segment === word) return true;
      const isLeaf = c.path.length === path.length + 1;
      const aliases = isLeaf
        ? (c.aliases ?? [])
        : (GROUP_ALIASES[[...path, segment].join(" ")] ?? []);
      return aliases.includes(word);
    });
    const segment = match?.path[path.length];
    if (!match || segment === undefined) return { kind: "unknown", word, path };
    path.push(segment);
    if (match.path.length === path.length)
      return { kind: "command", command: match, depth: path.length };
  }
  return { kind: "group", path };
}

function parseBool(value: string, name: string): boolean {
  if (/^(1|t|true|TRUE|True)$/.test(value)) return true;
  if (/^(0|f|false|FALSE|False)$/.test(value)) return false;
  throw new FlyError(
    `invalid argument "${value}" for "${name}" flag: strconv.ParseBool: parsing "${value}": invalid syntax`,
  );
}

function parseFlags(
  argv: ReadonlyArray<string>,
  specs: ReadonlyArray<FlagSpec>,
): { flags: Map<string, FlagValue>; positionals: Array<string> } {
  const flags = new Map<string, FlagValue>();
  const positionals: Array<string> = [];
  const set = (spec: FlagSpec, value: string | boolean) => {
    const label = spec.short ? `-${spec.short}, --${spec.name}` : `--${spec.name}`;
    if (spec.kind === "list") {
      const previous = flags.get(spec.name);
      flags.set(spec.name, [...(Array.isArray(previous) ? previous : []), String(value)]);
    } else if (spec.kind === "int" && !/^-?\d+$/.test(String(value))) {
      throw new FlyError(
        `invalid argument "${String(value)}" for "${label}" flag: strconv.ParseInt: parsing "${String(value)}": invalid syntax`,
      );
    } else flags.set(spec.name, value);
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      const inline = eq < 0 ? undefined : token.slice(eq + 1);
      const spec = specs.find((s) => s.name === name);
      if (!spec) throw new FlyError(`unknown flag: --${name}`);
      if (spec.kind === "bool")
        set(spec, inline === undefined ? true : parseBool(inline, `--${name}`));
      else {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new FlyError(`flag needs an argument: --${name}`);
        set(spec, value);
      }
    } else if (token.startsWith("-") && token.length > 1) {
      for (let j = 1; j < token.length; j++) {
        const letter = token[j] ?? "";
        const spec = specs.find((s) => s.short === letter);
        if (!spec) throw new FlyError(`unknown shorthand flag: '${letter}' in ${token}`);
        if (spec.kind === "bool") {
          if (token[j + 1] === "=") {
            set(spec, parseBool(token.slice(j + 2), `-${letter}`));
            break;
          }
          set(spec, true);
          continue;
        }
        let value: string | undefined = token.slice(j + 1).replace(/^=/, "");
        if (value === "") value = argv[++i];
        if (value === undefined)
          throw new FlyError(`flag needs an argument: '${letter}' in -${letter}`);
        set(spec, value);
        break;
      }
    } else positionals.push(token);
  }
  return { flags, positionals };
}

function printHelp(path: ReadonlyArray<string>, command?: Command): void {
  const name = ["fly", ...path].join(" ");
  if (command) {
    out(`${command.short}\n\nUsage:\n  ${name} [flags]\n\nFlags:\n`);
    for (const spec of [...command.flags, ...GLOBAL_FLAGS]) {
      const short = spec.short ? `-${spec.short}, ` : "    ";
      out(`  ${short}--${spec.name}${spec.kind === "bool" ? "" : ` ${spec.kind}`}\t${spec.help}\n`);
    }
    return;
  }
  const children = [
    ...new Set(
      COMMANDS.filter((c) => path.every((segment, i) => c.path[i] === segment)).map(
        (c) => c.path[path.length] ?? "",
      ),
    ),
  ];
  out(`Usage:\n  ${name} [command]\n\nAvailable Commands:\n`);
  for (const child of children) out(`  ${child}\n`);
  out(
    `\nThis fake does not implement any other ${name} command and fails on one, where flyctl prints this help.\n`,
  );
  out(`\nUse "${name} [command] --help" for more information about a command.\n`);
}

function argsError(count: number, [min, max]: readonly [number, number]): string | undefined {
  if (min === max && count !== min) return `accepts ${min} arg(s), received ${count}`;
  if (count < min) return `requires at least ${min} arg(s), only received ${count}`;
  if (count > max)
    return min === 0
      ? `accepts at most ${max} arg(s), received ${count}`
      : `accepts between ${min} and ${max} arg(s), received ${count}`;
  return undefined;
}

const signedIn = (flags: ReadonlyMap<string, FlagValue>) =>
  flags.has("access-token") ||
  Boolean(process.env.FLY_API_TOKEN || process.env.FLY_ACCESS_TOKEN) ||
  !NodeFS.existsSync(SIGNED_OUT());

let mutating = false;
let logged = false;

/**
 * Masks the access token wherever cobra would read it, bundled shorthands such as `-jtTOKEN`
 * included, using the flags of the command the words name. Unknown letters count as booleans,
 * so a token after one is still masked.
 */
function redactedArgv(argv: ReadonlyArray<string>): Array<string> {
  const resolved = resolve(argv);
  const specs =
    resolved.kind === "command" ? [...resolved.command.flags, ...GLOBAL_FLAGS] : GLOBAL_FLAGS;
  const redacted = [...argv];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--") break;
    if (token.startsWith("--")) {
      const [name = "", ...inline] = token.slice(2).split("=");
      const spec = specs.find((s) => s.name === name);
      const secret = spec?.name === "access-token";
      if (inline.length > 0) {
        if (secret) redacted[i] = `--${name}=<redacted>`;
      } else if (spec !== undefined && spec.kind !== "bool") {
        if (secret && i + 1 < argv.length) redacted[i + 1] = "<redacted>";
        i++;
      }
      continue;
    }
    if (!token.startsWith("-") || token.length < 2) continue;
    for (let j = 1; j < token.length; j++) {
      const spec = specs.find((s) => s.short === token[j]);
      if (spec === undefined || spec.kind === "bool") {
        if (token[j + 1] === "=") break;
        continue;
      }
      const glued = j + 1 < token.length;
      if (spec.name === "access-token") {
        if (glued)
          redacted[i] = `${token.slice(0, token[j + 1] === "=" ? j + 2 : j + 1)}<redacted>`;
        else if (i + 1 < argv.length) redacted[i + 1] = "<redacted>";
      }
      if (!glued) i++;
      break;
    }
  }
  return redacted;
}

function recordCall(exitCode: number): void {
  if (logged) return;
  logged = true;
  logCall(HOME, { argv: redactedArgv(process.argv.slice(2)), mutating, exitCode });
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const resolved = resolve(argv);
  if (resolved.kind === "unknown" && resolved.path.length === 0) {
    err(`Error: unknown command "${resolved.word}" for "fly"\nRun 'fly --help' for usage.\n`);
    return 1;
  }
  if (resolved.kind === "unknown") {
    if (argv.includes("--help") || argv.includes("-h")) {
      printHelp(resolved.path);
      return 0;
    }
    throw new FlyError(
      `fake fly does not implement "${["fly", ...resolved.path, resolved.word].join(" ")}"`,
    );
  }
  if (resolved.kind === "group") {
    parseFlags(argv, GLOBAL_FLAGS);
    printHelp(resolved.path);
    return 0;
  }
  const { command, depth } = resolved;
  const parsed = parseFlags(argv, [...command.flags, ...GLOBAL_FLAGS]);
  if (parsed.flags.get("help") === true) {
    printHelp(command.path, command);
    return 0;
  }
  mutating = command.mutating;
  const args = parsed.positionals.slice(depth);
  const problem = argsError(args.length, command.args);
  if (problem) throw new FlyError(problem);
  if (command.session && !signedIn(parsed.flags))
    throw new FlyError(
      `no access token available. Please login with '${NodePath.join(import.meta.dirname, "fly")} auth login' (fake fly)`,
    );
  return command.run({ args, flags: parsed.flags });
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    activeChild?.kill("SIGTERM");
    recordCall(code);
    process.exit(code);
  });
}

let exitCode: number;
try {
  exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof FlyError) err(`Error: ${error.message}\n`);
  else if (error instanceof DockerError) err(`Error: ${error.message}\n`);
  else err(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
}
recordCall(exitCode);
process.exitCode = exitCode;

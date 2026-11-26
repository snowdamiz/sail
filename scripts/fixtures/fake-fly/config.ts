// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off - Reads `fly.toml` from disk for the stand-in `fly` CLI.
import * as NodeFS from "node:fs";
import { parse as parseTomlText, TomlError } from "smol-toml";

class ConfigError extends Error {}

type Raw = ReturnType<typeof parseTomlText>;
type RawValue = Raw[string];

export interface Mount {
  readonly source: string;
  readonly destination: string;
  readonly initialSizeGb: number | undefined;
}

export interface HttpService {
  readonly internalPort: number;
  readonly forceHttps: boolean;
  readonly autostop: boolean | "suspend" | undefined;
  readonly autostart: boolean | undefined;
  readonly minMachinesRunning: number | undefined;
  readonly checkPath: string | undefined;
}

export interface StopConfig {
  readonly signal?: string;
  readonly timeout?: string;
}

export interface DeployConfig {
  readonly app: string | undefined;
  readonly primaryRegion: string | undefined;
  readonly stop: StopConfig | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly mounts: ReadonlyArray<Mount>;
  readonly http: HttpService | undefined;
  readonly memoryMb: number | undefined;
  readonly cpus: number | undefined;
  readonly cpuKind: string | undefined;
  readonly buildImage: string | undefined;
  readonly dockerfile: string | undefined;
}

export const EMPTY_CONFIG: DeployConfig = {
  app: undefined,
  primaryRegion: undefined,
  stop: undefined,
  env: {},
  mounts: [],
  http: undefined,
  memoryMb: undefined,
  cpus: undefined,
  cpuKind: undefined,
  buildImage: undefined,
  dockerfile: undefined,
};

const GO_DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Go's `time.ParseDuration`, minus signs and the bare `0`, which nothing here passes. */
export function durationMs(text: string): number | undefined {
  if (!GO_DURATION.test(text)) return undefined;
  let total = 0;
  for (const [, amount, , unit] of text.matchAll(/(\d+(\.\d+)?)(ns|us|µs|ms|s|m|h)/g))
    total += Number(amount) * (DURATION_UNIT_MS[unit ?? ""] ?? 0);
  return total;
}

/** Go's `Duration.String` for whole seconds, as flyctl writes an integer `kill_timeout`. */
function secondsAsGoDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? `${h}h` : ""}${h || m ? `${m}m` : ""}${s}s`;
}

const GO_FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * docker/go-units v0.5.0 `parseSize`, behind `FromHumanSize` (decimal) and `RAMInBytes` (binary):
 * the number ends at the last digit, dot, or space, and the suffix is `b`, or a unit letter
 * alone or followed by `b` or `ib`.
 */
function humanBytes(text: string, base: 1000 | 1024): number | undefined {
  const sep = Math.max(...[..."0123456789. "].map((c) => text.lastIndexOf(c)));
  if (sep < 0) return undefined;
  const number = text.slice(0, text[sep] === " " ? sep : sep + 1);
  const suffix = text.slice(sep + 1).toLowerCase();
  if (!GO_FLOAT.test(number) || Number(number) < 0) return undefined;
  if (suffix === "" || suffix === "b") return Math.trunc(Number(number));
  const power = "kmgtp".indexOf(suffix[0] ?? "") + 1;
  if (power === 0 || !["", "b", "ib"].includes(suffix.slice(1))) return undefined;
  return Math.trunc(Number(number) * base ** power);
}

/**
 * flyctl's `helpers.ParseSize`: a bare integer is already in `unit`, else a human size. Go's
 * `strconv` refuses a number out of range, which JavaScript reads as `Infinity`.
 */
function parseSize(text: string, base: 1000 | 1024, unit: number): number | undefined {
  const size = /^[+-]?\d+$/.test(text) ? Number(text) : humanBytes(text, base);
  if (size === undefined || !Number.isFinite(size)) return undefined;
  return /^[+-]?\d+$/.test(text) ? size : Math.floor(size / unit);
}

const STOP_SIGNALS = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGKILL",
  "SIGUSR1",
  "SIGUSR2",
  "SIGTERM",
]);

/** smol-toml gives tables a null prototype and dates as `Date`s (the legacy default). */
const isRawTable = (value: RawValue): value is Raw =>
  typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

/** Reads `fly.toml` the way flyctl's patches and JSON decode do, failing on what they reject. */
function configReader(file: string) {
  const fail = (message: string) =>
    new ConfigError(`failed loading app config from ${file}: ${message}`);
  const invalid = (message: string) =>
    new ConfigError(`App configuration is not valid: ${message}`);
  const typeName = (value: RawValue) =>
    Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
  const mismatch = (path: string, goType: string, value: RawValue) =>
    fail(
      `json: cannot unmarshal ${typeName(value)} into Go struct field ${path} of type ${goType}`,
    );
  const table = (value: RawValue | undefined, path: string): Raw => {
    if (value === undefined) return {};
    if (!isRawTable(value)) throw mismatch(path, "struct", value);
    return value;
  };
  return {
    fail,
    invalid,
    table,
    /** flyctl's `ensureArrayOfMap`: one table or an array of them. */
    tables: (value: RawValue | undefined, path: string): ReadonlyArray<Raw> =>
      value === undefined
        ? []
        : (Array.isArray(value) ? value : [value]).map((item) => table(item, path)),
    string: (value: RawValue | undefined, path: string): string | undefined => {
      if (value === undefined || typeof value === "string") return value;
      throw mismatch(path, "string", value);
    },
    bool: (value: RawValue | undefined, path: string): boolean | undefined => {
      if (value === undefined || typeof value === "boolean") return value;
      throw mismatch(path, "bool", value);
    },
    int: (value: RawValue | undefined, path: string): number | undefined => {
      if (value === undefined) return undefined;
      if (typeof value === "number" && Number.isInteger(value)) return value;
      throw mismatch(path, "int", value);
    },
    /** flyctl's `castToString`, for fields it takes as either a number or a string. */
    castString: (value: RawValue | undefined, path: string): string | undefined => {
      if (value === undefined || typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      throw mismatch(path, "string", value);
    },
  };
}

function toDeployConfig(toml: Raw, file: string): DeployConfig {
  const field = configReader(file);
  const env = Object.fromEntries(
    Object.entries(field.table(toml.env, "env")).map(([key, value]) => [
      key,
      field.castString(value, `env.${key}`) ?? "",
    ]),
  );

  const mounts = field.tables(toml.mounts, "mounts").map((mount) => {
    const source = field.string(mount.source, "Mount.mounts.source") ?? "";
    const raw = field.castString(mount.initial_size, "Mount.mounts.initial_size") || undefined;
    const initialSizeGb = raw === undefined ? undefined : parseSize(raw, 1000, 1000 ** 3);
    if (raw !== undefined && initialSizeGb === undefined)
      throw field.invalid(
        `mount '${source}' with initial_size '${raw}' will fail because of: invalid size: invalid size: '${raw}'`,
      );
    if (initialSizeGb !== undefined && initialSizeGb < 1)
      throw field.invalid(
        `mount '${source}' has an initial_size '${raw}' value which is smaller than 1GB`,
      );
    return {
      source,
      destination: field.string(mount.destination, "Mount.mounts.destination") ?? "",
      initialSizeGb,
    };
  });

  const httpTable =
    toml.http_service === undefined ? undefined : field.table(toml.http_service, "http_service");
  const http = httpTable && {
    internalPort:
      field.int(httpTable.internal_port, "HTTPService.http_service.internal_port") ?? 8080,
    forceHttps: field.bool(httpTable.force_https, "HTTPService.http_service.force_https") ?? false,
    autostop: autostop(httpTable.auto_stop_machines, field.fail),
    autostart: field.bool(
      httpTable.auto_start_machines,
      "HTTPService.http_service.auto_start_machines",
    ),
    minMachinesRunning: field.int(
      httpTable.min_machines_running,
      "HTTPService.http_service.min_machines_running",
    ),
    checkPath: field
      .tables(httpTable.checks, "http_service.checks")
      .map(
        (check) => field.string(check.path, "ServiceHTTPCheck.http_service.checks.path") ?? "/",
      )[0],
  };

  const vm = field.tables(toml.vm, "vm")[0] ?? {};
  const sizeName = field.string(vm.size, "Compute.vm.size");
  const size =
    sizeName === undefined ? undefined : /^(shared|performance)-cpu-(\d+)x$/.exec(sizeName);
  if (size === null) throw field.invalid(`invalid size "${sizeName}"`);
  const memoryText = field.castString(vm.memory, "Compute.vm.memory") || undefined;
  const memoryMb = memoryText === undefined ? undefined : parseSize(memoryText, 1024, 1024 ** 2);
  if (memoryText !== undefined && memoryMb === undefined)
    throw field.invalid(`vm.memory: invalid size: invalid size: '${memoryText}'`);
  if (memoryMb === 0) throw field.invalid("memory cannot be zero");
  const memory = memoryMb ?? field.int(vm.memory_mb, "Compute.vm.memory_mb");
  // flyctl passes a negative size on; the Machines API is what refuses it.
  if (memory !== undefined && memory < 0)
    throw field.invalid(`vm.memory: ${memory} MB is not a valid memory size`);

  const killSignal = field.string(toml.kill_signal, "Config.kill_signal");
  if (killSignal !== undefined && !STOP_SIGNALS.has(killSignal))
    throw field.invalid(
      `kill_signal '${killSignal}' is not one of ${[...STOP_SIGNALS].join(", ")}`,
    );
  const killTimeout = killTimeoutText(toml.kill_timeout, field.fail);

  const build = field.table(toml.build, "build");
  return {
    app: field.string(toml.app, "Config.app"),
    primaryRegion: field.string(toml.primary_region, "Config.primary_region"),
    stop:
      killSignal === undefined && killTimeout === undefined
        ? undefined
        : {
            ...(killTimeout === undefined ? {} : { timeout: killTimeout }),
            ...(killSignal === undefined ? {} : { signal: killSignal }),
          },
    env,
    mounts,
    http,
    memoryMb: memory,
    cpus: field.int(vm.cpus, "Compute.vm.cpus") ?? (size ? Number(size[2]) : undefined),
    cpuKind: field.string(vm.cpu_kind, "Compute.vm.cpu_kind") ?? size?.[1],
    buildImage: field.string(build.image, "Build.build.image"),
    dockerfile: field.string(build.dockerfile, "Build.build.dockerfile"),
  };
}

/** fly-go's `MachineAutostop`: a bool, or `off`, `stop`, or `suspend`. */
function autostop(
  value: RawValue | undefined,
  fail: (message: string) => ConfigError,
): boolean | "suspend" | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  if (value === "off") return false;
  if (value === "stop") return true;
  if (value === "suspend") return "suspend";
  throw fail(`http_service.auto_stop_machines: invalid autostop value ${JSON.stringify(value)}`);
}

/** flyctl's `_castDuration`: an integer counts seconds, a string is a Go duration. */
function killTimeoutText(
  value: RawValue | undefined,
  fail: (message: string) => ConfigError,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0)
    return secondsAsGoDuration(value);
  if (typeof value === "string" && durationMs(value) !== undefined) return value;
  throw fail(`kill_timeout: time: invalid duration ${JSON.stringify(String(value))}`);
}

export function parseConfigFile(file: string): DeployConfig {
  let toml: Raw;
  try {
    toml = parseTomlText(NodeFS.readFileSync(file, "utf8"), { integersAsBigInt: false });
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    throw new ConfigError(
      `failed loading app config from ${file}: row ${error.line} column ${error.column}\n${error.message}`,
    );
  }
  return toDeployConfig(toml, file);
}

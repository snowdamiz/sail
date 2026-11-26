// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off - Local stand-ins are plain Node CLIs that drive the Docker CLI directly.
import * as NodeChildProcess from "node:child_process";

export const NETWORK = "sail-fixtures";
export const FIXTURE_LABEL = "sail-fixture";

/** Lanes share one 8 GB Docker VM at load 40 to 80, where a step quick on a quiet machine takes minutes. */
export const DOCKER_TEST_TIMEOUT_MS = 480_000;

export class DockerError extends Error {
  readonly status: number | null;
  readonly stderr: string;
  constructor(args: ReadonlyArray<string>, status: number | null, stderr: string) {
    super(`docker ${args[0] ?? ""} failed (${status}): ${stderr.trim()}`);
    this.status = status;
    this.stderr = stderr;
  }
}

export interface DockerOptions {
  readonly input?: string;
  readonly timeoutMs?: number;
}

export function docker(args: ReadonlyArray<string>, options: DockerOptions = {}): string {
  const result = NodeChildProcess.spawnSync("docker", args, {
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new DockerError(args, null, result.error.message);
  if (result.status !== 0) throw new DockerError(args, result.status, result.stderr);
  return result.stdout;
}

export function dockerSucceeds(args: ReadonlyArray<string>): boolean {
  return NodeChildProcess.spawnSync("docker", args, { stdio: "ignore" }).status === 0;
}

export function hasDocker(): boolean {
  return dockerSucceeds(["info", "--format", "{{.ServerVersion}}"]);
}

export function exists(kind: "container" | "network" | "volume" | "image", name: string): boolean {
  return dockerSucceeds([kind, "inspect", name]);
}

export function ensureNetwork(): void {
  if (exists("network", NETWORK)) return;
  try {
    docker(["network", "create", "--label", `${FIXTURE_LABEL}=network`, NETWORK]);
  } catch (error) {
    if (!exists("network", NETWORK)) throw error;
  }
}

export function inspect<T>(name: string, format: string): T {
  return JSON.parse(docker(["inspect", "--format", `{{json ${format}}}`, name])) as T;
}

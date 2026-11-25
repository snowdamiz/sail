export const OUTBOX_DIR = "/var/lib/fake-boat/outbox";
export const ID_FILE = "id";
export const CALL_LOG = "calls.jsonl";
const REQUEST_SUFFIX = ".snapshot.json";

/** Boat takes lowercase letters, digits and dashes (`native/sail-boat/src/machine/provision.rs`). */
export const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

export interface SnapshotRequest {
  readonly sandboxId: string;
  readonly name: string;
  readonly requestedAt: string;
}

export function requestFile(name: string): string {
  return `${name}${REQUEST_SUFFIX}`;
}

export function isRequestFile(file: string): boolean {
  return file.endsWith(REQUEST_SUFFIX);
}

export function parseRequest(text: string): SnapshotRequest {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("sandboxId" in value) ||
    !("name" in value) ||
    !("requestedAt" in value) ||
    typeof value.sandboxId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.requestedAt !== "string" ||
    !SNAPSHOT_NAME.test(value.name)
  ) {
    throw new Error(`bad snapshot request: ${text}`);
  }
  return { sandboxId: value.sandboxId, name: value.name, requestedAt: value.requestedAt };
}

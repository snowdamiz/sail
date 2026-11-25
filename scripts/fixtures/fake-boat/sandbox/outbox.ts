export const OUTBOX_DIR = "/var/lib/fake-boat/outbox";
export const LIFETIME_DIR = "/var/lib/fake-boat/lifetime";
export const AUTH_LOG = "/var/lib/fake-boat/auth-access.log";
export const ID_FILE = "id";
export const CALL_LOG = "calls.jsonl";
export const DEADLINE_FILE = "deadline";

const PENDING = ".snapshot.json";
const CLAIMED = ".snapshot.claimed-";
const FAILED = ".snapshot.failed";

/**
 * Boat takes lowercase letters, digits and dashes (`native/sail-boat/src/machine/provision.rs`).
 * 115 keeps `<home id>-<name>` within Docker's 128-character tag.
 */
export const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,114}$/;

export interface SnapshotRequest {
  readonly sandboxId: string;
  readonly name: string;
  readonly requestedAt: string;
}

/** A request's file moves pending → claimed by one worker → gone, or failed with the reason. */
export type RequestFile =
  | { readonly stage: "pending"; readonly base: string }
  | { readonly stage: "claimed"; readonly base: string; readonly pid: number }
  | { readonly stage: "failed"; readonly base: string };

export function requestFile(file: RequestFile): string {
  switch (file.stage) {
    case "pending":
      return `${file.base}${PENDING}`;
    case "claimed":
      return `${file.base}${CLAIMED}${file.pid}`;
    case "failed":
      return `${file.base}${FAILED}`;
  }
}

export function parseRequestFile(name: string): RequestFile | undefined {
  if (name.endsWith(PENDING)) return { stage: "pending", base: name.slice(0, -PENDING.length) };
  if (name.endsWith(FAILED)) return { stage: "failed", base: name.slice(0, -FAILED.length) };
  const claimed = name.lastIndexOf(CLAIMED);
  const pid = Number(name.slice(claimed + CLAIMED.length));
  if (claimed > 0 && Number.isInteger(pid) && pid > 0) {
    return { stage: "claimed", base: name.slice(0, claimed), pid };
  }
  return undefined;
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

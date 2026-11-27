// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Fake sign-ins for the fake boat, claude, and codex CLIs, which run on plain Node.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { isObject } from "./jsonl.ts";
import { AUTH_ORIGIN_FILE, READONLY_DIR } from "./outbox.ts";

const DEFAULT_AUTH_ORIGIN = "https://auth.localtest.me";
export const FAKE_IDENTITY = "fake-user@localtest.me";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const APPROVAL_POLL_MS = 250;

/**
 * The sign-in pages' origin, which the host `boat` writes into the sandbox's read-only mount, so a
 * CLI any process starts sees it. FAKE_AUTH_ORIGIN stands in for it on this computer.
 */
export function authOrigin(): string {
  return process.env.FAKE_AUTH_ORIGIN || hostOrigin() || DEFAULT_AUTH_ORIGIN;
}

function hostOrigin(): string | undefined {
  const text = readFrom(NodePath.join(READONLY_DIR, AUTH_ORIGIN_FILE), 0);
  if (text === undefined) return undefined;
  const origin: unknown = JSON.parse(text.toString("utf8"));
  return typeof origin === "string" ? origin : undefined;
}

type DeviceKind = "boat" | "codex";

export interface DeviceCode {
  readonly kind: DeviceKind;
  readonly code: string;
  readonly issuedAtMs: number;
  /** Set only by FAKE_AUTH_APPROVE_SECS; otherwise only the sign-in page approves the code. */
  readonly approveAtMs: number | null;
  readonly expiresAtMs: number;
}

type Approval = "approved" | "expired" | "cancelled";

function seconds(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be seconds, got ${raw}`);
  return value;
}

export function issueDeviceCode(kind: DeviceKind): DeviceCode {
  const issuedAt = Date.now();
  const approve =
    process.env.FAKE_AUTH_APPROVE_SECS === "never" ? undefined : seconds("FAKE_AUTH_APPROVE_SECS");
  return {
    kind,
    code: userCode(),
    issuedAtMs: issuedAt,
    approveAtMs: approve === undefined ? null : issuedAt + approve * 1000,
    expiresAtMs: issuedAt + (seconds("FAKE_AUTH_CODE_TTL_SECS") ?? 900) * 1000,
  };
}

function readFrom(file: string, offset: number): Buffer | undefined {
  let fd: number;
  try {
    fd = NodeFS.openSync(file, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const chunk = Buffer.alloc(Math.max(0, NodeFS.fstatSync(fd).size - offset));
    return chunk.subarray(0, NodeFS.readSync(fd, chunk, 0, chunk.length, offset));
  } finally {
    NodeFS.closeSync(fd);
  }
}

function approves(line: string, device: DeviceCode): boolean {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isObject(entry) || entry.status !== 200 || !isObject(entry.request)) return false;
  const { uri } = entry.request;
  if (typeof uri !== "string") return false;
  if (typeof entry.ts === "number" && entry.ts * 1000 > device.expiresAtMs) return false;
  const url = new URL(uri, DEFAULT_AUTH_ORIGIN);
  return (
    url.pathname === `/${device.kind}/device/approve` &&
    url.searchParams.get("code") === device.code
  );
}

/** Reads Caddy's access log for the sign-in pages only as far as it grew since the last look. */
function approvalWatcher(authLog: string, device: DeviceCode): () => boolean {
  let offset = 0;
  let partial = "";
  return () => {
    const fresh = readFrom(authLog, offset);
    if (!fresh) return false;
    offset += fresh.length;
    const lines = `${partial}${fresh.toString("utf8")}`.split("\n");
    partial = lines.pop() ?? "";
    return lines.some((line) => approves(line, device));
  };
}

/**
 * Until someone approves the code on the sign-in page (its `/approve` request in `authLog`), it
 * expires, or `stillCurrent` says a logout or a newer attempt replaced it.
 */
export async function waitForApproval(
  device: DeviceCode,
  authLog: string,
  stillCurrent: () => boolean = () => true,
): Promise<Approval> {
  const approvedOnPage = approvalWatcher(authLog, device);
  for (;;) {
    if (!stillCurrent()) return "cancelled";
    if (approvedOnPage()) return "approved";
    const now = Date.now();
    if (now >= device.expiresAtMs) return "expired";
    if (device.approveAtMs !== null && now >= device.approveAtMs) return "approved";
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_MS));
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function userCode(): string {
  const chars = [...NodeCrypto.randomBytes(8)].map((byte) => CODE_ALPHABET[byte % 32]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function fakeToken(prefix: string): string {
  return `${prefix}-${NodeCrypto.randomBytes(24).toString("base64url")}`;
}

export interface CallbackLogin {
  /** 0 picks a free port. */
  readonly port: number;
  readonly path: string;
  readonly browserUrl: (redirectUri: string, state: string) => string;
  readonly announce: (state: string, port: number) => void;
  /** Accept `<code>#<state>` on stdin, as the Claude CLI does. */
  readonly acceptPaste: boolean;
}

export async function callbackLogin(login: CallbackLogin): Promise<string> {
  const state = NodeCrypto.randomBytes(32).toString("base64url");
  let finish: (code: string) => void = () => {};
  const done = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const code = url.searchParams.get("code");
    if (url.pathname !== login.path || !code || url.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/plain" }).end("Invalid sign-in callback\n");
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><title>Signed in</title><h1>Signed in. You can close this tab.</h1>");
    finish(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(login.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : login.port;
  const redirectUri = `http://localhost:${port}${login.path}`;
  const browser = process.env.BROWSER;
  if (browser) {
    const child = NodeChildProcess.spawn(browser, [login.browserUrl(redirectUri, state)], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  }
  login.announce(state, port);
  const lines = login.acceptPaste ? NodeReadline.createInterface({ input: process.stdin }) : null;
  lines?.on("line", (line) => {
    const [code, pastedState] = line.trim().split("#");
    if (code && pastedState === state) finish(code);
    else if (line.trim() !== "")
      process.stdout.write("Invalid code\nPaste code here if prompted > ");
  });
  const timer = setTimeout(() => finish(""), LOGIN_TIMEOUT_MS);
  const code = await done;
  clearTimeout(timer);
  lines?.close();
  process.stdin.destroy();
  server.close();
  server.closeAllConnections();
  if (!code) throw new Error("Login timed out after 10 minutes");
  return code;
}

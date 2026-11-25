// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Fake sign-ins for the fake boat, claude, and codex CLIs, which run on plain Node.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeReadline from "node:readline";

export const AUTH_ORIGIN = "https://auth.localtest.me";
export const FAKE_IDENTITY = "fake-user@localtest.me";
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface DeviceCodeSchedule {
  readonly approveAtMs: number | null;
  readonly expiresAtMs: number;
}

function seconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be seconds, got ${raw}`);
  return value;
}

export function deviceCodeSchedule(issuedAt: number): DeviceCodeSchedule {
  const approve = process.env.FAKE_AUTH_APPROVE_SECS;
  return {
    approveAtMs:
      approve === "never" ? null : issuedAt + seconds("FAKE_AUTH_APPROVE_SECS", 3) * 1000,
    expiresAtMs: issuedAt + seconds("FAKE_AUTH_CODE_TTL_SECS", 900) * 1000,
  };
}

export async function waitForApproval(
  schedule: DeviceCodeSchedule,
): Promise<"approved" | "expired"> {
  const { approveAtMs, expiresAtMs } = schedule;
  if (Date.now() >= expiresAtMs) return "expired";
  const approves = approveAtMs !== null && approveAtMs < expiresAtMs;
  const until = approves ? approveAtMs : expiresAtMs;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
  return approves ? "approved" : "expired";
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function userCode(): string {
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

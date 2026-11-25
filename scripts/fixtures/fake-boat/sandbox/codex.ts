// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - A plain Node fake of the Codex CLI inside the fake Boat sandbox.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AUTH_ORIGIN,
  callbackLogin,
  deviceCodeSchedule,
  FAKE_IDENTITY,
  fakeToken,
  userCode,
  waitForApproval,
} from "./auth.ts";
import { type CommandSpec, parse, UsageError } from "./cli.ts";
import { type JsonObject, serveJsonLines } from "./jsonl.ts";

const VERSION = "0.200.0";
const CALLBACK_PORT = 1455;

interface Command extends CommandSpec {
  readonly run: (flags: ReadonlyMap<string, string | true>) => Promise<number> | number;
}

function codexHome(): string {
  return NodePath.resolve(process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex"));
}

function authPath(): string {
  return NodePath.join(codexHome(), "auth.json");
}

function signIn(): void {
  const file = authPath();
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeToken("fake-id"),
      access_token: fakeToken("fake-access"),
      refresh_token: fakeToken("fake-refresh"),
      account_id: "fake-account",
    },
    last_refresh: new Date().toISOString(),
  };
  NodeFS.writeFileSync(file, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

function authorizeUrl(redirectUri: string, state: string): string {
  const query = new URLSearchParams({ response_type: "code", redirect_uri: redirectUri, state });
  return `${AUTH_ORIGIN}/codex/authorize?${query.toString()}`;
}

async function deviceLogin(): Promise<number> {
  const code = userCode();
  const schedule = deviceCodeSchedule(Date.now());
  const minutes = Math.round((schedule.expiresAtMs - Date.now()) / 60_000);
  console.log(`Welcome to Codex [v${VERSION}]\nOpenAI's command-line coding agent\n`);
  console.log("Follow these steps to sign in with ChatGPT using device code authorization:\n");
  console.log("1. Open this link in your browser and sign in to your account");
  console.log(`   ${AUTH_ORIGIN}/codex/device?code=${code}\n`);
  console.log(`2. Enter this one-time code (expires in ${minutes} minutes)\n   ${code}\n`);
  console.log("Device codes are a common phishing target. Never share this code.\n");
  if ((await waitForApproval(schedule)) === "expired") {
    console.error("Error logging in with device code: device code expired");
    return 1;
  }
  signIn();
  console.log("Successfully logged in");
  return 0;
}

async function browserLogin(): Promise<number> {
  await callbackLogin({
    port: CALLBACK_PORT,
    path: "/auth/callback",
    browserUrl: authorizeUrl,
    acceptPaste: false,
    announce: (state, port) => {
      console.log(`Starting local login server on http://localhost:${port}.`);
      console.log("If your browser did not open, navigate to this URL to authenticate:\n");
      console.log(authorizeUrl(`http://localhost:${port}/auth/callback`, state));
    },
  });
  signIn();
  console.log("Successfully logged in");
  return 0;
}

type RpcFrame =
  | { readonly kind: "request"; readonly id: string | number; readonly method: string }
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "response" };

function parseRpcFrame(message: JsonObject): RpcFrame {
  const { id, method } = message;
  if (typeof method !== "string") return { kind: "response" };
  if (id === undefined) return { kind: "notification", method };
  if (typeof id !== "string" && typeof id !== "number") {
    throw new Error(`malformed JSON-RPC request: ${JSON.stringify(message)}`);
  }
  return { kind: "request", id, method };
}

const RPC_RESULTS: ReadonlyMap<string, () => JsonObject> = new Map<string, () => JsonObject>([
  [
    "initialize",
    () => ({
      codexHome: codexHome(),
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: `codex_cli_rs/${VERSION} (fake)`,
    }),
  ],
  [
    "account/read",
    () =>
      NodeFS.existsSync(authPath())
        ? {
            account: { type: "chatgpt", email: FAKE_IDENTITY, planType: "pro" },
            requiresOpenaiAuth: true,
          }
        : { account: null, requiresOpenaiAuth: true },
  ],
  ["skills/list", () => ({ data: [] })],
  ["model/list", () => ({ data: [], nextCursor: null })],
]);

const METHOD_NOT_FOUND = -32601;

function primeModelsCache(): void {
  if (!NodeFS.existsSync(authPath())) return;
  const cache = { fetched_at: new Date().toISOString(), models: [] };
  NodeFS.writeFileSync(NodePath.join(codexHome(), "models_cache.json"), JSON.stringify(cache));
}

async function appServer(): Promise<number> {
  primeModelsCache();
  let initialized = false;
  await serveJsonLines((message) => {
    const frame = parseRpcFrame(message);
    if (frame.kind !== "request") return [];
    const result = RPC_RESULTS.get(frame.method);
    const allowed = initialized || frame.method === "initialize";
    if (!result || !allowed) {
      const reason = allowed ? `fake codex does not support ${frame.method}` : "Not initialized";
      return [{ id: frame.id, error: { code: METHOD_NOT_FOUND, message: reason } }];
    }
    initialized = true;
    return [{ id: frame.id, result: result() }];
  });
  return 0;
}

const TABLE: ReadonlyArray<Command> = [
  {
    path: ["--version"],
    run: () => {
      console.log(`codex-cli ${VERSION}`);
      return 0;
    },
  },
  {
    path: ["app-server"],
    flags: { help: "boolean", c: "string" },
    run: (flags) => {
      if (!flags.has("help")) return appServer();
      console.log("Usage: codex app-server [OPTIONS]");
      return 0;
    },
  },
  {
    path: ["login"],
    flags: { "device-auth": "boolean" },
    run: (flags) => (flags.has("device-auth") ? deviceLogin() : browserLogin()),
  },
  {
    path: ["login", "status"],
    run: () => {
      const loggedIn = NodeFS.existsSync(authPath());
      console.log(loggedIn ? "Logged in using ChatGPT" : "Not logged in");
      return loggedIn ? 0 : 1;
    },
  },
  {
    path: ["logout"],
    run: () => {
      const loggedIn = NodeFS.existsSync(authPath());
      NodeFS.rmSync(authPath(), { force: true });
      console.log(loggedIn ? "Successfully logged out" : "Not logged in");
      return 0;
    },
  },
];

async function main(argv: ReadonlyArray<string>): Promise<number> {
  try {
    const invocation = parse(TABLE, argv);
    return await invocation.command.run(invocation.flags);
  } catch (error) {
    const prefix = error instanceof UsageError ? "fake codex does not support this: " : "";
    console.error(`${prefix}${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));

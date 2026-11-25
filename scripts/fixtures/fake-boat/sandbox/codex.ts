// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - A plain Node fake of the Codex CLI inside the fake Boat sandbox.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AUTH_ORIGIN,
  callbackLogin,
  deviceCodeSchedule,
  fakeToken,
  userCode,
  waitForApproval,
} from "./auth.ts";
import { type CommandSpec, parse, UsageError } from "./cli.ts";

/** Matches `CodexInstallation.ts`'s `^codex-cli (\d+\.\d+\.\d+)$` and every manifest `minVersion`. */
const VERSION = "0.200.0";
const CALLBACK_PORT = 1455;

interface Command extends CommandSpec {
  readonly run: (flags: ReadonlyMap<string, string | true>) => Promise<number> | number;
}

function authPath(): string {
  const home = process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
  return NodePath.join(home, "auth.json");
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
  const minutes = Math.round((schedule.expiresAt - Date.now()) / 60_000);
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

const TABLE: ReadonlyArray<Command> = [
  {
    path: ["--version"],
    run: () => {
      console.log(`codex-cli ${VERSION}`);
      return 0;
    },
  },
  {
    // T3's installation probe only checks that this exits 0; it never starts the app server.
    path: ["app-server"],
    flags: { help: "boolean" },
    run: (flags) => {
      if (!flags.has("help")) throw new Error("fake codex has no app server");
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

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - A plain Node fake of the Claude Code CLI inside the fake Boat sandbox.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AUTH_ORIGIN, callbackLogin, FAKE_IDENTITY, fakeToken } from "./auth.ts";
import { type CommandSpec, parse, UsageError } from "./cli.ts";

/** Newer than every `minVersion` in `apps/server/src/provider/model-manifest.json`. */
const VERSION = "2.1.400";
const MANUAL_REDIRECT = `${AUTH_ORIGIN}/claude/code/callback`;

interface Command extends CommandSpec {
  readonly run: (flags: ReadonlyMap<string, string | true>) => Promise<number> | number;
}

function credentialsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude");
  return NodePath.join(dir, ".credentials.json");
}

function signedIn(): boolean {
  return NodeFS.existsSync(credentialsPath());
}

function authorizeUrl(redirectUri: string, state: string): string {
  const query = new URLSearchParams({ code: "true", redirect_uri: redirectUri, state });
  return `${AUTH_ORIGIN}/claude/authorize?${query.toString()}`;
}

const TABLE: ReadonlyArray<Command> = [
  {
    path: ["--version"],
    run: () => {
      console.log(`${VERSION} (Claude Code)`);
      return 0;
    },
  },
  {
    path: ["auth", "status"],
    flags: { json: "boolean", text: "boolean" },
    run: (flags) => {
      const loggedIn = signedIn();
      if (flags.has("text")) {
        console.log(
          loggedIn
            ? `Logged in using Claude account (${FAKE_IDENTITY})`
            : "Not logged in. Run claude auth login to authenticate.",
        );
      } else {
        const status = loggedIn
          ? { loggedIn, authMethod: "claude.ai", apiProvider: "firstParty", email: FAKE_IDENTITY }
          : { loggedIn, authMethod: "none", apiProvider: "firstParty" };
        console.log(JSON.stringify(status, null, 2));
      }
      return loggedIn ? 0 : 1;
    },
  },
  {
    path: ["auth", "login"],
    run: async () => {
      await callbackLogin({
        port: 0,
        path: "/callback",
        browserUrl: authorizeUrl,
        acceptPaste: true,
        announce: (state) => {
          console.log("Opening browser to sign in…");
          console.log("Browser didn't open? Use the url below to sign in (c to copy)\n");
          console.log(`${authorizeUrl(MANUAL_REDIRECT, state)}\n`);
          process.stdout.write("Paste code here if prompted > ");
        },
      });
      const file = credentialsPath();
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      const oauth = {
        accessToken: fakeToken("sk-ant-oat01-fake"),
        refreshToken: fakeToken("sk-ant-ort01-fake"),
        expiresAt: Date.now() + 365 * 24 * 3600_000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
      };
      NodeFS.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }), { mode: 0o600 });
      console.log("\nLogin successful.");
      return 0;
    },
  },
  {
    path: ["auth", "logout"],
    run: () => {
      NodeFS.rmSync(credentialsPath(), { force: true });
      console.log("Successfully logged out from your Anthropic account.");
      return 0;
    },
  },
];

async function main(argv: ReadonlyArray<string>): Promise<number> {
  try {
    const invocation = parse(TABLE, argv);
    return await invocation.command.run(invocation.flags);
  } catch (error) {
    const prefix = error instanceof UsageError ? "fake claude does not support this: " : "";
    console.error(`${prefix}${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));

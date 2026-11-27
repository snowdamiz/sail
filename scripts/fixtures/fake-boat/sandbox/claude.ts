// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - A plain Node fake of the Claude Code CLI inside the fake Boat sandbox.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { authOrigin, callbackLogin, FAKE_IDENTITY, fakeToken } from "./auth.ts";
import { type CommandSpec, parse, UsageError } from "./cli.ts";
import { isObject, type JsonObject, serveJsonLines } from "./jsonl.ts";

const VERSION = "2.1.400";

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

function subscriptionType(): string | null {
  if (!signedIn()) return null;
  const file: unknown = JSON.parse(NodeFS.readFileSync(credentialsPath(), "utf8"));
  const oauth = isObject(file) ? file.claudeAiOauth : undefined;
  const type = isObject(oauth) ? oauth.subscriptionType : undefined;
  if (typeof type !== "string") throw new Error(`no subscriptionType in ${credentialsPath()}`);
  return type;
}

const SIGNED_OUT_ACCOUNT: JsonObject = { tokenSource: "none", apiProvider: "firstParty" };

function account(): JsonObject {
  const subscription = subscriptionType();
  return subscription === null
    ? SIGNED_OUT_ACCOUNT
    : {
        email: FAKE_IDENTITY,
        subscriptionType: subscription,
        tokenSource: "claude.ai",
        apiProvider: "firstParty",
      };
}

type SdkFrame =
  | { readonly kind: "control"; readonly requestId: string; readonly subtype: string }
  | { readonly kind: "user" }
  | { readonly kind: "ignored" };

function parseSdkFrame(message: JsonObject): SdkFrame {
  if (message.type === "user") return { kind: "user" };
  if (message.type !== "control_request") return { kind: "ignored" };
  const { request_id: requestId, request } = message;
  if (typeof requestId !== "string" || !isObject(request) || typeof request.subtype !== "string") {
    throw new Error(`malformed control_request: ${JSON.stringify(message)}`);
  }
  return { kind: "control", requestId, subtype: request.subtype };
}

const CONTROL_RESPONSES: ReadonlyMap<string, () => JsonObject> = new Map([
  [
    "initialize",
    () => ({
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [],
      account: account(),
    }),
  ],
]);

const SESSION_ID = NodeCrypto.randomUUID();

function refuseTurn(): JsonObject {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors: ["fake claude cannot run turns"],
    session_id: SESSION_ID,
    uuid: NodeCrypto.randomUUID(),
  };
}

function answerSdk(message: JsonObject): ReadonlyArray<JsonObject> {
  const frame = parseSdkFrame(message);
  if (frame.kind === "user") return [refuseTurn()];
  if (frame.kind === "ignored") return [];
  const respond = CONTROL_RESPONSES.get(frame.subtype);
  const response = respond
    ? { subtype: "success", request_id: frame.requestId, response: respond() }
    : {
        subtype: "error",
        request_id: frame.requestId,
        error: `fake claude does not support ${frame.subtype}`,
      };
  return [{ type: "control_response", response }];
}

function authorizeUrl(redirectUri: string, state: string): string {
  const query = new URLSearchParams({ code: "true", redirect_uri: redirectUri, state });
  return `${authOrigin()}/claude/authorize?${query.toString()}`;
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
    // The Agent SDK always leads with these (`ProcessTransport.initialize` in its `core.mjs`).
    path: ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"],
    flags: {
      "setting-sources": "string",
      "strict-mcp-config": "boolean",
      "no-session-persistence": "boolean",
      settings: "string",
    },
    run: async () => {
      await serveJsonLines(answerSdk);
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
          console.log(`${authorizeUrl(`${authOrigin()}/claude/code/callback`, state)}\n`);
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

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A fixture CLI that patches a T3 home on this computer or in a container.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { docker, inspect } from "./lib/docker.ts";

const USAGE = `Usage:
  node scripts/fixtures/replay-provider.ts --home <T3 home>
  node scripts/fixtures/replay-provider.ts --container <name-or-id> [--home <path>] [--user <user>]

Installs the free Replay ACP agent (model "showcase") into <home>/replay-fixture and upserts
the "replayFixture" provider instance in <home>/userdata/settings.json. A running server picks
the change up from its settings watcher, so no restart is needed.

In a container, --home defaults to its SAIL_HOME, else T3CODE_HOME, else $HOME/.sail (the
order the server reads), and --user to its configured user. Fake Fly machines are named
sail-fly-<app>; fake Boat sandboxes are sail-boat-<id> with --user user --home ~/.t3.`;

const SERVER_ROOT = NodePath.resolve(import.meta.dirname, "../../apps/server");
const AGENT = "scripts/dev-replay-agent.ts";
const FIXTURE_DIR = "replay-fixture";

interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

/** What the apply program receives on stdin; it runs with the target's own node. */
interface ApplyInput {
  readonly home: string;
  readonly files: ReadonlyArray<FixtureFile>;
  readonly commandPath: string;
}

// Plain JS so the same program runs here and inside a container, as the user that owns the home.
const APPLY_PROGRAM = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const home = input.home.replace(/^~(?=\/|$)/, process.env.HOME);
const root = path.join(home, ${JSON.stringify(FIXTURE_DIR)});
const changed = [];
const writeAtomically = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + process.pid;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
};
for (const file of input.files) {
  const target = path.join(root, file.path);
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === file.content) continue;
  writeAtomically(target, file.content);
  changed.push(target);
}
const agentPath = path.join(root, ${JSON.stringify(AGENT)});
const settingsLink = path.join(home, "userdata", "settings.json");
const settingsPath = fs.existsSync(settingsLink) ? fs.realpathSync(settingsLink) : settingsLink;
const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
const settings = raw.trim() === "" ? {} : JSON.parse(raw);
const instances = settings.providerInstances ?? {};
const existing = instances.replayFixture;
const existingConfig = existing?.config;
const instance = {
  displayName: "Replay (fixture)",
  ...existing,
  driver: "acpRegistry",
  config: { ...existingConfig, source: "local", commandPath: input.commandPath, commandArgs: [agentPath] },
};
if (JSON.stringify(instance) !== JSON.stringify(existing)) {
  const next = { ...settings, providerInstances: { ...instances, replayFixture: instance } };
  writeAtomically(settingsPath, JSON.stringify(next, null, 2) + "\n");
  changed.push(settingsPath);
}
process.stdout.write(JSON.stringify({ agentPath, settingsPath: settingsLink, changed }));
`;

interface ApplyResult {
  readonly agentPath: string;
  readonly settingsPath: string;
  readonly changed: ReadonlyArray<string>;
}

// The agent lives in the server package, outside this tsconfig, so load its list at runtime.
async function scenarioFiles(agentPath: string): Promise<ReadonlyArray<string>> {
  const agent: unknown = await import(agentPath);
  const scenarios =
    typeof agent === "object" && agent !== null && "SCENARIOS" in agent
      ? agent.SCENARIOS
      : undefined;
  if (!Array.isArray(scenarios)) throw new Error(`${agentPath} exports no SCENARIOS`);
  return scenarios.map((scenario: unknown) => {
    if (
      typeof scenario !== "object" ||
      scenario === null ||
      !("file" in scenario) ||
      typeof scenario.file !== "string"
    ) {
      throw new Error(`${agentPath} has a scenario without a file`);
    }
    return scenario.file;
  });
}

async function fixtureFiles(): Promise<ReadonlyArray<FixtureFile>> {
  const agentPath = NodePath.join(SERVER_ROOT, AGENT);
  const paths = [
    AGENT,
    ...(await scenarioFiles(agentPath)).map((file) =>
      NodePath.relative(SERVER_ROOT, NodePath.resolve(NodePath.dirname(agentPath), file)),
    ),
  ];
  return paths.map((path) => {
    if (path.startsWith("..")) throw new Error(`${path} is outside ${SERVER_ROOT}`);
    return { path, content: NodeFS.readFileSync(NodePath.join(SERVER_ROOT, path), "utf8") };
  });
}

function parseResult(stdout: string): ApplyResult {
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("agentPath" in parsed && typeof parsed.agentPath === "string") ||
    !("settingsPath" in parsed && typeof parsed.settingsPath === "string") ||
    !("changed" in parsed && Array.isArray(parsed.changed))
  ) {
    throw new Error(`Unexpected apply output: ${stdout}`);
  }
  return {
    agentPath: parsed.agentPath,
    settingsPath: parsed.settingsPath,
    changed: parsed.changed.map(String),
  };
}

async function applyLocally(home: string): Promise<ApplyResult> {
  const input: ApplyInput = {
    home: NodePath.resolve(home),
    files: await fixtureFiles(),
    commandPath: process.execPath,
  };
  const result = NodeChildProcess.spawnSync(process.execPath, ["-e", APPLY_PROGRAM], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`apply failed: ${result.stderr}`);
  return parseResult(result.stdout);
}

function containerEnv(container: string): ReadonlyMap<string, string> {
  const entries = inspect<ReadonlyArray<string> | null>(container, ".Config.Env") ?? [];
  return new Map(
    entries.map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
    }),
  );
}

async function applyInContainer(
  container: string,
  home: string | undefined,
  user: string | undefined,
): Promise<ApplyResult> {
  const execUser = user ?? (inspect<string>(container, ".Config.User") || "root");
  const env = containerEnv(container);
  const targetHome = home ?? env.get("SAIL_HOME") ?? env.get("T3CODE_HOME") ?? "~/.sail";
  const commandPath = docker([
    "exec",
    "-u",
    execUser,
    container,
    "sh",
    "-lc",
    "command -v node",
  ]).trim();
  if (commandPath === "") throw new Error(`No node on ${container}'s login PATH`);
  const input: ApplyInput = { home: targetHome, files: await fixtureFiles(), commandPath };
  const stdout = docker(
    ["exec", "-i", "-u", execUser, container, commandPath, "-e", APPLY_PROGRAM],
    { input: JSON.stringify(input) },
  );
  return parseResult(stdout);
}

async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: {
      home: { type: "string" },
      container: { type: "string" },
      user: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) return console.log(USAGE);
  if (values.container === undefined && (values.home === undefined || values.user !== undefined)) {
    console.error(USAGE);
    process.exit(2);
  }
  const result =
    values.container === undefined
      ? await applyLocally(values.home ?? "")
      : await applyInContainer(values.container, values.home, values.user);
  if (result.changed.length === 0) {
    console.log(`replay-provider: unchanged (${result.settingsPath})`);
  } else {
    for (const path of result.changed) console.log(`replay-provider: wrote ${path}`);
  }
  console.log(`replay-provider: instance replayFixture runs ${result.agentPath}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`replay-provider: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

// @effect-diagnostics nodeBuiltinImport:off - Runs the replay-provider script and the agent it installs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  docker,
  dockerSucceeds,
  FIXTURE_LABEL,
  hasDocker,
  DOCKER_TEST_TIMEOUT_MS,
} from "./lib/docker.ts";
import { PLAIN_JS_APPLY_PROGRAM } from "./replay-provider.ts";

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Docker work on the VM every lane shares, not a hidden wait.
vi.setConfig({ testTimeout: DOCKER_TEST_TIMEOUT_MS, hookTimeout: DOCKER_TEST_TIMEOUT_MS });

const SCRIPT = NodePath.join(import.meta.dirname, "replay-provider.ts");
const NODE_IMAGE = "node:26.13.1-bookworm-slim";

interface Settings {
  readonly providerInstances?: Readonly<
    Record<
      string,
      {
        readonly displayName?: string;
        readonly driver?: string;
        readonly enabled?: boolean;
        readonly config?: { readonly commandArgs?: ReadonlyArray<string> };
      }
    >
  >;
}

const install = (home: string) =>
  NodeChildProcess.spawnSync(process.execPath, [SCRIPT, "--home", home], { encoding: "utf8" });

const readSettings = (home: string): Settings =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(home, "userdata", "settings.json"), "utf8"));

/** One JSON-RPC exchange with the installed agent, run from its new home. */
async function initialize(agentPath: string): Promise<unknown> {
  const agent = NodeChildProcess.spawn(process.execPath, [agentPath], {
    cwd: NodeOS.tmpdir(),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = NodeReadline.createInterface({ input: agent.stdout });
  agent.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
  );
  for await (const line of lines) {
    const message = JSON.parse(line) as { readonly id?: number; readonly result?: unknown };
    if (message.id === 1) {
      agent.kill();
      return message.result;
    }
  }
  throw new Error("the replay agent closed without answering initialize");
}

describe("replay provider", () => {
  let home: string;

  beforeAll(() => {
    home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-replay-provider-"));
    NodeFS.mkdirSync(NodePath.join(home, "userdata"));
    NodeFS.writeFileSync(
      NodePath.join(home, "userdata", "settings.json"),
      JSON.stringify({ providerInstances: { other: { driver: "codex" } } }),
    );
  });

  afterAll(() => NodeFS.rmSync(home, { recursive: true, force: true }));

  it("installs a replay agent that runs outside the repo and registers it once", async () => {
    const first = install(home);
    expect(first.status, first.stderr).toBe(0);
    const instance = readSettings(home).providerInstances?.replayFixture;
    expect(instance?.displayName).toBe("Replay (fixture)");
    expect(instance?.driver).toBe("acpRegistry");
    const agentPath = instance?.config?.commandArgs?.[0] ?? "";
    expect(agentPath.startsWith(NodePath.join(home, "replay-fixture"))).toBe(true);
    expect(readSettings(home).providerInstances?.other).toEqual({ driver: "codex" });
    expect(await initialize(agentPath)).toMatchObject({ agentInfo: { name: "t3-dev-replay" } });

    const second = install(home);
    expect(second.stdout).toContain("unchanged");
  });

  it("keeps a user's edit to the instance on a rerun", () => {
    const settings = readSettings(home);
    const edited = {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        replayFixture: { ...settings.providerInstances?.replayFixture, enabled: false },
      },
    };
    NodeFS.writeFileSync(NodePath.join(home, "userdata", "settings.json"), JSON.stringify(edited));
    expect(install(home).status).toBe(0);
    expect(readSettings(home).providerInstances?.replayFixture?.enabled).toBe(false);
  });
});

describe("replay provider's T3 home in a container", () => {
  let root: string;

  beforeAll(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-replay-home-"));
  });

  afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

  /** Runs the program `--container` runs, with `env` standing in for the container's. */
  const resolve = (name: string, env: Readonly<Record<string, string>>) => {
    const cwd = NodePath.join(root, name);
    const home = NodePath.join(cwd, "home");
    NodeFS.mkdirSync(home, { recursive: true });
    const ran = NodeChildProcess.spawnSync(process.execPath, ["-e", PLAIN_JS_APPLY_PROGRAM], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
      input: JSON.stringify({ files: [], commandPath: process.execPath }),
      encoding: "utf8",
    });
    const written =
      ran.status === 0
        ? NodePath.dirname(
            NodePath.dirname((JSON.parse(ran.stdout) as { settingsPath: string }).settingsPath),
          )
        : undefined;
    return { cwd, home, status: ran.status, stderr: ran.stderr, written };
  };

  it("reads SAIL_HOME, then T3CODE_HOME, as the server does, an empty one counting as unset", () => {
    const t3Home = NodePath.join(root, "t3-from-env");
    const unused = NodePath.join(root, "t3-unused");
    expect(resolve("empty-sail", { SAIL_HOME: "", T3CODE_HOME: t3Home }).written).toBe(t3Home);

    const blank = resolve("blank-sail", { SAIL_HOME: "  ", T3CODE_HOME: unused });
    expect(blank.written, "a blank SAIL_HOME is set, and resolves to ~/.sail").toBe(
      NodePath.join(blank.home, ".sail"),
    );
    expect(NodeFS.existsSync(unused)).toBe(false);

    const tilde = resolve("tilde", { SAIL_HOME: " ~/sail-home " });
    expect(tilde.written).toBe(NodePath.join(tilde.home, "sail-home"));

    const neither = resolve("neither", { T3CODE_HOME: "" });
    expect(neither.written).toBe(NodePath.join(neither.home, ".sail"));
  });

  it("refuses to guess a home when HOME is empty and the path needs it", () => {
    const empty = resolve("empty-home", { HOME: "" });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("HOME is empty");
    expect(NodeFS.readdirSync(empty.cwd)).toEqual(["home"]);

    const absolute = NodePath.join(root, "absolute-sail");
    expect(resolve("absolute", { HOME: "", SAIL_HOME: absolute }).written).toBe(absolute);
  });
});

describe.skipIf(!hasDocker())("replay provider --container", () => {
  const container = `sail-replay-test-${process.pid}`;

  beforeAll(() => {
    docker([
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      `${FIXTURE_LABEL}=replay-test`,
      "--memory",
      "256m",
      "--env",
      "SAIL_HOME=",
      "--env",
      "T3CODE_HOME=/home/node/t3-from-env",
      NODE_IMAGE,
      "sleep",
      "infinity",
    ]);
  });

  afterAll(() => {
    dockerSucceeds(["rm", "--force", container]);
  });

  it("installs into the home the container's server would use", () => {
    const ran = NodeChildProcess.spawnSync(
      process.execPath,
      [SCRIPT, "--container", container, "--user", "node"],
      { encoding: "utf8" },
    );
    expect(ran.status, ran.stderr).toBe(0);
    const settings = docker([
      "exec",
      container,
      "cat",
      "/home/node/t3-from-env/userdata/settings.json",
    ]);
    expect(JSON.parse(settings)).toMatchObject({
      providerInstances: { replayFixture: { driver: "acpRegistry" } },
    });
  });
});

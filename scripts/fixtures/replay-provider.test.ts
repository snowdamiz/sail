// @effect-diagnostics nodeBuiltinImport:off - Runs the replay-provider script and the agent it installs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.join(import.meta.dirname, "replay-provider.ts");

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

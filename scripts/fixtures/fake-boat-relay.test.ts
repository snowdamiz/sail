// @effect-diagnostics nodeBuiltinImport:off - Drives the fake boat relay from a real container on the fixtures network.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { removeSite } from "./lib/caddy.ts";
import {
  docker,
  dockerSucceeds,
  ensureNetwork,
  FIXTURE_LABEL,
  hasDocker,
  inspect,
  NETWORK,
} from "./lib/docker.ts";

const RELAY = NodePath.join(import.meta.dirname, "fake-boat", "relay.ts");
const NODE_IMAGE = "node:26.13.1-bookworm-slim";
const WEB_PORT = 8124;
const WEB_BODY = "hello through the relay\n";
const SANDBOX_ID = /^bx-[0-9a-f]{12}$/;
const POLL = { timeout: 30_000, interval: 500 };
const MARKER = "# fake-boat-relay";
const BOAT = "/home/node/.ascii/bin/boat";

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: ReadonlyArray<string>, input?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      command,
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ status: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
    child.stdin?.end(input);
  });
}

function lastJson<T>(text: string): T {
  const line = text
    .split("\n")
    .filter((entry) => entry.trim().startsWith("{"))
    .at(-1);
  if (line === undefined) throw new Error(`no JSON in: ${text}`);
  return JSON.parse(line) as T;
}

/** Docker Desktop reaches the computer's loopback by name; native Docker reaches it at the network's gateway. */
function relayAddress(): { readonly bind: string; readonly seen: string } {
  if (docker(["info", "--format", "{{.OperatingSystem}}"]).includes("Docker Desktop"))
    return { bind: "127.0.0.1", seen: "host.docker.internal" };
  const gateway = inspect<string>(NETWORK, "(index .IPAM.Config 0).Gateway");
  return { bind: gateway, seen: gateway };
}

describe.skipIf(!hasDocker())("fake boat relay", () => {
  const container = `sail-relay-test-${NodeCrypto.randomBytes(3).toString("hex")}`;
  let home: string;
  let relayUrl: string;
  let relay: NodeChildProcess.ChildProcess | undefined;
  let sandbox = "";
  let hostname = "";

  const inside = (args: ReadonlyArray<string>, input?: string) =>
    run("docker", ["exec", "-i", "-u", "node", container, ...args], input);
  const boat = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
    run("docker", [
      "exec",
      "-u",
      "node",
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      container,
      BOAT,
      "--json",
      ...args,
    ]);
  const ok = async (args: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) => {
    const ran = await boat(args, env);
    expect(ran.status, `boat ${args.join(" ")}: ${ran.stderr}`).toBe(0);
    return ran;
  };
  const exec = async (script: string) =>
    lastJson<{ exitCode: number; stdout: string }>(
      (await ok(["exec", sandbox, "--timeout", "60", "--", "bash", "-lc", script])).stdout,
    );
  const relayedHosts = async () =>
    (await inside(["cat", "/etc/hosts"])).stdout
      .split("\n")
      .filter((line) => line.endsWith(MARKER));
  const fetchInside = async (url: string) =>
    (
      await inside([
        "node",
        "-e",
        `fetch(${JSON.stringify(url)}).then((r) => r.text()).then((t) => process.stdout.write(t), (e) => process.stdout.write(String(e.cause ?? e)))`,
      ])
    ).stdout;

  beforeAll(async () => {
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fake-boat-relay-test-"));
    ensureNetwork();
    const address = relayAddress();
    const inherited = Object.entries(process.env).filter(
      ([key]) => !key.startsWith("FAKE_BOAT_") && !key.startsWith("FAKE_AUTH_"),
    );
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(inherited),
      FAKE_BOAT_HOME: home,
      FAKE_AUTH_APPROVE_SECS: "1",
    };
    if (process.env.FAKE_BOAT_IMAGE) env.FAKE_BOAT_IMAGE = process.env.FAKE_BOAT_IMAGE;
    const started = NodeChildProcess.spawn("node", [RELAY, "serve", "--host", address.bind], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    relay = started;
    const line = await new Promise<string>((resolve, reject) => {
      NodeReadline.createInterface({ input: started.stdout }).once("line", resolve);
      started.once("exit", (code) => reject(new Error(`relay exited (${code})`)));
    });
    const port = /^boat-relay: http:\/\/[^ ]+:(\d+)$/.exec(line)?.[1];
    if (!port) throw new Error(`unexpected relay banner: ${line}`);
    relayUrl = `http://${address.seen}:${port}`;
    docker([
      "run",
      "--detach",
      "--name",
      container,
      "--network",
      NETWORK,
      "--label",
      `${FIXTURE_LABEL}=relay-test`,
      "--memory",
      "256m",
      NODE_IMAGE,
      "sleep",
      "infinity",
    ]);
  });

  afterAll(async () => {
    relay?.kill();
    dockerSucceeds(["rm", "--force", container]);
    if (sandbox) {
      dockerSucceeds(["rm", "--force", "--volumes", `sail-boat-${sandbox}`]);
      removeSite(`boat-${sandbox}-${WEB_PORT}`);
    }
    if (home) await NodeFSP.rm(home, { recursive: true, force: true });
  });

  it("installs the client into the named user's ~/.ascii/bin, with its relay beside it", async () => {
    const installed = await run("node", [
      RELAY,
      "install",
      "--container",
      container,
      "--relay",
      relayUrl,
      "--user",
      "node",
    ]);
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stdout.trim()).toBe(`boat-relay: installed ${BOAT}`);
    const dir = NodePath.posix.dirname(BOAT);
    const modes = await inside([
      "stat",
      "-c",
      "%n %U %a",
      BOAT,
      `${dir}/relay-client.ts`,
      `${dir}/relay.json`,
    ]);
    expect(modes.stdout.trim().split("\n")).toEqual([
      `${BOAT} node 755`,
      `${dir}/relay-client.ts node 644`,
      `${dir}/relay.json node 644`,
    ]);
    expect(JSON.parse((await inside(["cat", `${dir}/relay.json`])).stdout)).toEqual({
      relay: relayUrl,
      container,
    });
  });

  it("signs in with onboard and onboard --wait", async () => {
    const before = lastJson<{ account: { signedIn: boolean } }>((await ok(["status"])).stdout);
    expect(before.account.signedIn).toBe(false);
    const started = lastJson<{ url: string; userCode: string }>((await ok(["onboard"])).stdout);
    expect(started.url).toBe(`https://auth.localtest.me/boat/device?code=${started.userCode}`);
    await ok(["onboard", "--wait"]);
    const after = lastJson<{ account: { signedIn: boolean } }>((await ok(["status"])).stdout);
    expect(after.account.signedIn).toBe(true);
  });

  it("creates a sandbox, runs a command in it, and copies a file up and back", async () => {
    const created = await ok(["new", "--name", "relay test", "--type", "small", "--no-auto-stop"]);
    sandbox = lastJson<{ id: string }>(created.stdout).id;
    expect(sandbox).toMatch(SANDBOX_ID);
    expect((await exec("id -un")).stdout).toBe("user\n");

    const body = `relayed ${NodeCrypto.randomBytes(8).toString("hex")}\n`;
    await inside(["sh", "-c", "cat > /tmp/up.txt && chmod 640 /tmp/up.txt"], body);
    await ok(["scp", "/tmp/up.txt", `${sandbox}:/home/user/`]);
    expect((await exec("cat /home/user/up.txt; stat -c %a /home/user/up.txt")).stdout).toBe(
      `${body}640\n`,
    );
    await ok(["scp", `${sandbox}:/home/user/up.txt`, "/tmp/down.txt"]);
    expect((await inside(["cat", "/tmp/down.txt"])).stdout).toBe(body);

    const missing = await boat(["scp", "/tmp/nope.txt", `${sandbox}:/home/user/`]);
    expect(missing.status).toBe(1);
    expect(lastJson<{ code: string }>(missing.stderr).code).toBe("invalid_arguments");
  });

  it("hosts a sandbox port that the caller reaches by name over plain http", async () => {
    await exec(
      `systemd-run --user --unit fake-boat-relay-web node -e 'require("http").createServer((q, s) => s.end(${JSON.stringify(WEB_BODY)})).listen(${WEB_PORT}, "127.0.0.1")'`,
    );
    const hosted = await ok(["host", sandbox, String(WEB_PORT), "--public", "--localhost"], {
      FAKE_BOAT_HOST_SCHEME: "http",
    });
    const url = new URL(lastJson<{ url: string }>(hosted.stdout).url);
    hostname = url.hostname;
    expect(url.protocol, "FAKE_* from the caller reaches the fake").toBe("http:");
    expect(hostname).toBe(`${sandbox}-${WEB_PORT}.localtest.me`);
    expect((await relayedHosts()).filter((line) => line.includes(`\t${hostname} `))).toHaveLength(
      1,
    );
    await expect.poll(() => fetchInside(`http://${hostname}/`), POLL).toBe(WEB_BODY);

    const dockerLines = async () =>
      (await inside(["cat", "/etc/hosts"])).stdout
        .split("\n")
        .filter((line) => line !== "" && !line.endsWith(MARKER));
    const before = await dockerLines();
    await ok(["status"]);
    await ok(["status"]);
    expect(await dockerLines(), "Docker's own entries survive every rewrite").toEqual(before);
    expect(before.some((line) => line.includes("localhost"))).toBe(true);
    const relayed = await relayedHosts();
    expect(new Set(relayed).size, "no host is added twice").toBe(relayed.length);
    expect(relayed.filter((line) => line.includes(`\t${hostname} `))).toHaveLength(1);
  });

  it("refuses forward and says why", async () => {
    const forwarded = await boat(["forward", sandbox, "--remote", "1455", "--local", "1455"]);
    expect(forwarded.status).toBe(1);
    const said = lastJson<{ code: string; error: string }>(forwarded.stderr);
    expect(said.code).toBe("unsupported");
    expect(said.error).toContain("link and a code");
  });

  it("deletes the sandbox and drops its host on the next call", async () => {
    await ok(["delete", sandbox, "--yes"]);
    const listed = lastJson<{ sandboxes: ReadonlyArray<{ id: string }> }>(
      (await ok(["list", "--all"])).stdout,
    );
    expect(listed.sandboxes.map((entry) => entry.id)).not.toContain(sandbox);
    expect((await relayedHosts()).some((line) => line.includes(`\t${hostname} `))).toBe(false);
  });
});

// @effect-diagnostics nodeBuiltinImport:off - Exercises the stand-ins' on-disk state from several processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { caddyDir } from "./caddy.ts";
import {
  canonicalPath,
  fixturesRoot,
  homeId,
  isRunning,
  nameOwner,
  processRef,
  readJson,
  releaseName,
  reserveName,
  takeLock,
  thisProcess,
} from "./state.ts";

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fixture-state-test-"));
const lib = (file: string) => JSON.stringify(NodePath.join(import.meta.dirname, file));

const fixtures = NodePath.join(import.meta.dirname, "..");

const inChild = (script: string, env: NodeJS.ProcessEnv = process.env) =>
  NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
  });

const spawnScript = (script: string) =>
  NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A process that holds `lock` from the moment this resolves until it is killed. */
async function lockHolder(lock: string) {
  const child = spawnScript(
    `import { takeLock } from ${lib("state.ts")};
     if (!takeLock(${JSON.stringify(lock)}, 60_000)) process.exit(3);
     process.stdout.write("held\\n");
     setInterval(() => {}, 60_000);`,
  );
  const [line] = await Promise.race([
    NodeEvents.EventEmitter.once(child.stdout, "data"),
    NodeEvents.EventEmitter.once(child, "exit").then(([code]: Array<unknown>) => {
      throw new Error(`the holder exited ${code} before it held ${lock}`);
    }),
  ]);
  expect(String(line)).toBe("held\n");
  return {
    pid: child.pid ?? 0,
    kill: async (signal: NodeJS.Signals) => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill(signal);
      await exited;
    },
  };
}

describe("fixture state", () => {
  const namespace = `state-test-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const movedHome = NodePath.join(scratch, "moved-home");

  afterAll(() => {
    releaseName(namespace, "taken", movedHome);
    NodeFS.rmSync(NodePath.join(fixturesRoot(), "names", namespace), {
      recursive: true,
      force: true,
    });
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps Caddy and name reservations where HOME and XDG_STATE_HOME cannot move them", () => {
    const moved = { ...process.env, HOME: scratch, XDG_STATE_HOME: scratch };
    const child = inChild(
      `import { caddyDir } from ${lib("caddy.ts")};
       import { reserveName } from ${lib("state.ts")};
       reserveName(${JSON.stringify(namespace)}, "taken", ${JSON.stringify(movedHome)});
       process.stdout.write(caddyDir());`,
      moved,
    );
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe(caddyDir());
    expect(nameOwner(namespace, "taken")).toBe(canonicalPath(movedHome));
  });

  it("names one home whether or not its path ends in a slash", () => {
    const home = canonicalPath(NodePath.join(scratch, "slash-home"));
    const resolve = (given: string) =>
      inChild(
        `import { homeId, standInHome } from ${lib("state.ts")};
         const home = standInHome("fly", "FAKE_FLY_HOME");
         process.stdout.write(JSON.stringify([home, homeId(home)]));`,
        { ...process.env, FAKE_FLY_HOME: given },
      ).stdout;
    expect(resolve(`${home}/`)).toBe(JSON.stringify([home, homeId(home)]));
    expect(resolve(`${home}/`)).toBe(resolve(home));
  });

  it.each([
    ["fly", "FAKE_FLY_HOME", ["auth", "whoami"]],
    ["boat", "FAKE_BOAT_HOME", ["--json", "status"]],
  ])("treats an empty %s home as unset", (kind, envName, argv) => {
    const state = NodePath.join(scratch, `empty-${kind}`);
    const fake = NodePath.join(fixtures, `fake-${kind}`, `${kind}.ts`);
    const child = NodeChildProcess.spawnSync(process.execPath, [fake, ...argv], {
      encoding: "utf8",
      env: { ...process.env, [envName]: "", XDG_STATE_HOME: state, HOME: state },
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    const homes = NodeFS.readdirSync(NodePath.join(state, "sail-fixtures", kind));
    expect(homes).toHaveLength(1);
    const calls = NodePath.join(state, "sail-fixtures", kind, homes[0] ?? "", "calls.jsonl");
    expect(NodeFS.readFileSync(calls, "utf8")).toContain(JSON.stringify(argv));
  });

  it("never shows a reader a half-written exclusive file", () => {
    const file = NodePath.join(scratch, "exclusive.json");
    const writer = NodeChildProcess.spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import { createJsonExclusive } from ${lib("state.ts")};
       createJsonExclusive(${JSON.stringify(file)}, { filler: "x".repeat(64 * 1024 * 1024) });`,
    ]);
    let seen: { readonly filler: string } | undefined;
    for (let attempt = 0; seen === undefined && attempt < 10_000_000; attempt++)
      seen = readJson(file);
    writer.kill();
    expect(seen?.filler.length).toBe(64 * 1024 * 1024);
  });
});

describe("fixture locks", () => {
  const lockPath = (name: string) => NodePath.join(scratch, `${name}.lock`);

  it("keeps everyone else out until its holder ends, however it ends", async () => {
    const lock = lockPath("held");
    const holder = await lockHolder(lock);
    expect(takeLock(lock), "a live holder keeps it").toBeUndefined();
    await holder.kill("SIGKILL");
    const release = takeLock(lock);
    expect(release, "free the moment its holder is gone").toBeTypeOf("function");
    release?.();
  });

  it.each([
    ["an empty object", "{}"],
    ["a live pid that is not a holder", '{"pid":1}'],
    ["an unrelated node process", JSON.stringify({ pid: process.pid })],
    ["half a file", '{"pid":'],
  ])("is free when the file holds %s", (_, junk) => {
    const lock = lockPath(`junk-${NodeCrypto.randomBytes(3).toString("hex")}`);
    NodeFS.writeFileSync(lock, junk);
    const release = takeLock(lock);
    expect(release).toBeTypeOf("function");
    release?.();
    expect(takeLock(lock), "and it locks again").toBeTypeOf("function");
  });

  it("never lets two processes in at once, while holders die inside it", async () => {
    const lock = lockPath("contended");
    const marker = NodePath.join(scratch, "inside.json");
    const overlaps = NodePath.join(scratch, "overlaps.log");
    const worker = () =>
      spawnScript(
        `import * as NodeFS from "node:fs";
         import { isRunning, readJson, thisProcess, withLock } from ${lib("state.ts")};
         for (let round = 0; round < 40; round++) {
           withLock(${JSON.stringify(lock)}, () => {
             const inside = readJson(${JSON.stringify(marker)});
             if (isRunning(inside)) NodeFS.appendFileSync(${JSON.stringify(overlaps)}, JSON.stringify(inside) + "\\n");
             NodeFS.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(thisProcess()));
             Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
             if (Math.random() < 0.02) {
               NodeFS.rmSync(${JSON.stringify(marker)});
               process.kill(process.pid, "SIGKILL");
             }
             NodeFS.rmSync(${JSON.stringify(marker)});
           });
         }`,
      );
    const workers = Array.from({ length: 8 }, worker);
    const ended = await Promise.all(
      workers.map(
        async (child) => (await NodeEvents.EventEmitter.once(child, "exit"))[1] as string | null,
      ),
    );
    expect(NodeFS.existsSync(overlaps) ? NodeFS.readFileSync(overlaps, "utf8") : "").toBe("");
    expect(ended.filter((signal) => signal === null).length, "some ran to the end").toBeGreaterThan(
      0,
    );
  });
});

describe("process identity", () => {
  it("names a running process by its pid and start, and nothing else", async () => {
    expect(isRunning(thisProcess())).toBe(true);
    expect(isRunning({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970" })).toBe(false);
    expect(isRunning({ pid: process.pid })).toBe(false);
    expect(isRunning({})).toBe(false);
    expect(isRunning(undefined)).toBe(false);
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
    const ref = processRef(child.pid ?? 0);
    expect(isRunning(ref)).toBe(true);
    const exited = NodeEvents.EventEmitter.once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect(isRunning(ref)).toBe(false);
  });
});

describe("home paths", () => {
  it("names one home and one owner however a symlink in its path spells it", () => {
    const real = NodePath.join(scratch, "real");
    const link = NodePath.join(scratch, "link");
    NodeFS.mkdirSync(real);
    NodeFS.symlinkSync(real, link);
    const spelled = NodePath.join(link, "not-yet", "home");
    const resolved = NodePath.join(NodeFS.realpathSync(real), "not-yet", "home");
    expect(canonicalPath(spelled)).toBe(resolved);
    expect(homeId(spelled)).toBe(homeId(resolved));
    const resolve = (given: string) =>
      inChild(
        `import { standInHome } from ${lib("state.ts")};
         process.stdout.write(standInHome("fly", "FAKE_FLY_HOME"));`,
        { ...process.env, FAKE_FLY_HOME: given },
      ).stdout;
    expect(resolve(spelled)).toBe(resolved);

    const namespace = `state-test-${NodeCrypto.randomBytes(3).toString("hex")}`;
    try {
      expect(reserveName(namespace, "app", spelled)).toBe(true);
      expect(reserveName(namespace, "app", resolved), "the other spelling holds it too").toBe(true);
      releaseName(namespace, "app", resolved);
      expect(nameOwner(namespace, "app")).toBeUndefined();
    } finally {
      NodeFS.rmSync(NodePath.join(fixturesRoot(), "names", namespace), {
        recursive: true,
        force: true,
      });
    }
  });
});

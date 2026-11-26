// @effect-diagnostics nodeBuiltinImport:off - Exercises the stand-ins' on-disk state from several processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { caddyDir } from "./caddy.ts";
import { fixturesRoot, homeId, nameOwner, readJson, releaseName } from "./state.ts";

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fixture-state-test-"));
const lib = (file: string) => JSON.stringify(NodePath.join(import.meta.dirname, file));

const fixtures = NodePath.join(import.meta.dirname, "..");

const inChild = (script: string, env: NodeJS.ProcessEnv = process.env) =>
  NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
  });

describe("fixture state", () => {
  const namespace = `state-test-${NodeCrypto.randomBytes(3).toString("hex")}`;

  afterAll(() => {
    releaseName(namespace, "taken", "moved-env");
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
       reserveName(${JSON.stringify(namespace)}, "taken", "moved-env");
       process.stdout.write(caddyDir());`,
      moved,
    );
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe(caddyDir());
    expect(nameOwner(namespace, "taken")).toBe("moved-env");
  });

  it("names one home whether or not its path ends in a slash", () => {
    const home = NodePath.join(scratch, "slash-home");
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
      env: { ...process.env, [envName]: "", XDG_STATE_HOME: state },
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

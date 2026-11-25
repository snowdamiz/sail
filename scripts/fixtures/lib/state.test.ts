// @effect-diagnostics nodeBuiltinImport:off - Exercises the stand-ins' on-disk state from several processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { caddyDir } from "./caddy.ts";
import { fixturesRoot, logCall, nameOwner, readJson, releaseName } from "./state.ts";

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fixture-state-test-"));
const lib = (file: string) => JSON.stringify(NodePath.join(import.meta.dirname, file));

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

  it("masks a secret flag's value however it is written", () => {
    const home = NodePath.join(scratch, "calls");
    const argv = ["-tglued", "-t", "spaced", "-t=equals", "--access-token=long", "-a", "app"];
    logCall(home, { argv, mutating: false, exitCode: 0 }, ["-t", "--access-token"]);
    const logged = JSON.parse(NodeFS.readFileSync(NodePath.join(home, "calls.jsonl"), "utf8")) as {
      readonly argv: ReadonlyArray<string>;
    };
    expect(logged.argv).toEqual([
      "-t<redacted>",
      "-t",
      "<redacted>",
      "-t=<redacted>",
      "--access-token=<redacted>",
      "-a",
      "app",
    ]);
  });
});

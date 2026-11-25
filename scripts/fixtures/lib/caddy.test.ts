// @effect-diagnostics nodeBuiltinImport:off - Drives the shared fixture Caddy through the Docker CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { caddyDir, publishSite, removeSite, rootCertPath } from "./caddy.ts";
import { docker, FIXTURE_LABEL, hasDocker, NETWORK } from "./docker.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const run = NodeCrypto.randomBytes(3).toString("hex");
const upstream = `sail-caddy-test-${run}`;
const ids = Array.from({ length: 6 }, (_, index) => `caddy-test-${run}-${index}`);

const publishInChild = (id: string) =>
  execFile(process.execPath, [
    "--input-type=module",
    "-e",
    `import { publishSite } from ${JSON.stringify(NodePath.join(import.meta.dirname, "caddy.ts"))};
     publishSite({ id: ${JSON.stringify(id)}, host: ${JSON.stringify(`${id}.localtest.me`)}, upstream: ${JSON.stringify(`${upstream}:8080`)} });`,
  ]);

const status = async (url: string) =>
  (
    await execFile("curl", [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--cacert",
      rootCertPath(),
      url,
    ])
  ).stdout;

describe.skipIf(!hasDocker())("fixture Caddy", () => {
  beforeAll(() => {
    docker([
      "run",
      "--detach",
      "--name",
      upstream,
      "--label",
      `${FIXTURE_LABEL}=caddy-test`,
      "--network",
      NETWORK,
      "--memory",
      "64m",
      "caddy:2",
      "caddy",
      "respond",
      "--listen",
      ":8080",
      "--body",
      "ok",
    ]);
  });

  afterAll(() => {
    for (const id of [...ids, `caddy-test-${run}-bad`]) removeSite(id);
    docker(["rm", "--force", upstream]);
  });

  it("serves every site that processes publish at the same time", async () => {
    await Promise.all(ids.map(publishInChild));
    const answers = await Promise.all(ids.map((id) => status(`https://${id}.localtest.me/`)));
    expect(answers).toEqual(ids.map(() => "200"));
  });

  it("drops a site Caddy refuses, so later reloads keep working", async () => {
    const bad = `caddy-test-${run}-bad`;
    expect(() => publishSite({ id: bad, host: `${bad}.localtest.me`, upstream: "x {" })).toThrow();
    expect(NodeFS.existsSync(NodePath.join(caddyDir(), "sites", `${bad}.caddy`))).toBe(false);
    expect(await status(`https://${ids[0]}.localtest.me/`)).toBe("200");
  });

  it("refuses the hosts the fixtures reserve", () => {
    expect(() =>
      publishSite({ id: `caddy-test-${run}-auth`, host: "auth.localtest.me", upstream: "x:1" }),
    ).toThrow(/reserved/);
  });
});

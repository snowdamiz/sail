// @effect-diagnostics nodeBuiltinImport:off - Drives the shared fixture Caddy through the Docker CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  CADDY_CONTAINER,
  CADDYFILE,
  CADDYFILE_VERSION,
  caddyDir,
  ensureCaddy,
  isOlderCaddyfile,
  publishSite,
  removeSite,
  rootCertPath,
} from "./caddy.ts";
import { docker, FIXTURE_LABEL, hasDocker, NETWORK } from "./docker.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const run = NodeCrypto.randomBytes(3).toString("hex");
const upstream = `sail-caddy-test-${run}`;
const ids = Array.from({ length: 6 }, (_, index) => `caddy-test-${run}-${index}`);

const publishInChild = (id: string, to = `${upstream}:8080`) =>
  execFile(process.execPath, [
    "--input-type=module",
    "-e",
    `import { publishSite } from ${JSON.stringify(NodePath.join(import.meta.dirname, "caddy.ts"))};
     publishSite({ id: ${JSON.stringify(id)}, host: ${JSON.stringify(`${id}.localtest.me`)}, upstream: ${JSON.stringify(to)} });`,
  ]);

/**
 * Holds the reload lock until a second process waits on it, then lists `sites/` as any other
 * reload would see it. Bounded, so a publisher that never arrives cannot hold the lock for long.
 */
const LIST_SITES_WHEN_SOMEONE_WAITS = `echo held
i=0
until [ "$(ps -o args | grep -c '^flock /data/reload.lock')" -ge 2 ] || [ "$i" -ge 600 ]; do
  i=$((i + 1)); sleep 0.05
done
ls /etc/caddy/sites`;

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

describe("fixture Caddyfile version", () => {
  const stamped = (version: number) =>
    CADDYFILE.replace(
      /^# sail-fixtures Caddyfile v\d+\n/,
      `# sail-fixtures Caddyfile v${version}\n`,
    );

  it("never replaces a Caddyfile a newer checkout wrote", () => {
    expect(isOlderCaddyfile(stamped(CADDYFILE_VERSION + 1))).toBe(false);
    expect(isOlderCaddyfile(stamped(999_999))).toBe(false);
    expect(isOlderCaddyfile(CADDYFILE)).toBe(false);
    expect(isOlderCaddyfile(stamped(CADDYFILE_VERSION - 1))).toBe(true);
    expect(isOlderCaddyfile("{\n}\n")).toBe(true);
  });

  it("bumps the version with every change to the Caddyfile's text", () => {
    const sha256 = NodeCrypto.createHash("sha256").update(CADDYFILE).digest("hex");
    expect(
      { version: CADDYFILE_VERSION, sha256 },
      "changed the Caddyfile? bump CADDYFILE_VERSION, then pin the new hash here",
    ).toEqual({
      version: 1,
      sha256: "2c5ea0ff0916ab982970fe5a092e4bf1babdb1643db0f32160eff5c56b9fa247",
    });
  });
});

describe.skipIf(!hasDocker())("fixture Caddy", () => {
  beforeAll(() => {
    ensureCaddy();
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
    docker([
      "exec",
      upstream,
      "sh",
      "-c",
      "i=0; until wget -q -O /dev/null http://127.0.0.1:8080/; do [ $((i += 1)) -lt 100 ] || exit 1; sleep 0.1; done",
    ]);
  });

  afterAll(() => {
    for (const id of ids) removeSite(id);
    docker(["rm", "--force", upstream]);
  });

  it("serves every site that processes publish at the same time", async () => {
    await Promise.all(ids.map((id) => publishInChild(id)));
    const answers = await Promise.all(ids.map((id) => status(`https://${id}.localtest.me/`)));
    expect(answers).toEqual(ids.map(() => "200"));
  });

  it("never lets another reload see a site Caddy refuses", async () => {
    const bad = `caddy-test-${run}-bad`;
    const holder = NodeChildProcess.spawn("docker", [
      "exec",
      CADDY_CONTAINER,
      "flock",
      "/data/reload.lock",
      "sh",
      "-c",
      LIST_SITES_WHEN_SOMEONE_WAITS,
    ]);
    let listing = "";
    holder.stdout.setEncoding("utf8");
    const held = new Promise<void>((resolve) =>
      holder.stdout.on("data", (chunk: string) => {
        listing += chunk;
        if (listing.startsWith("held\n")) resolve();
      }),
    );
    const released = new Promise((resolve) => holder.once("exit", resolve));
    await held;
    const publishing = publishInChild(bad, "x {");
    await expect(released).resolves.toBe(0);
    await expect(publishing).rejects.toThrow();
    expect(listing.split("\n")).toContain(`${ids[0]}.caddy`);
    expect(listing.split("\n")).not.toContain(`${bad}.caddy`);
    expect(NodeFS.existsSync(NodePath.join(caddyDir(), "sites", `${bad}.caddy`))).toBe(false);
    expect(await status(`https://${ids[0]}.localtest.me/`)).toBe("200");
  });

  it("refuses the hosts the fixtures reserve", () => {
    expect(() =>
      publishSite({ id: `caddy-test-${run}-auth`, host: "auth.localtest.me", upstream: "x:1" }),
    ).toThrow(/reserved/);
  });
});

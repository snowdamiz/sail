// @effect-diagnostics nodeBuiltinImport:off - Drives the shared fixture Caddy through the Docker CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  CA_VERSION,
  CADDY_CONTAINER,
  caddyContainer,
  CADDYFILE,
  CADDYFILE_VERSION,
  caddyDir,
  ensureCaddy,
  ensureRootCa,
  ROOT_LABEL,
  rootFingerprint,
  isOlderCaddyfile,
  publicUrl,
  publishSite,
  removeSite,
  rootCertPath,
} from "./caddy.ts";
import { docker, FIXTURE_LABEL, hasDocker, NETWORK, DOCKER_TEST_TIMEOUT_MS } from "./docker.ts";
import { fixturesRoot, takeLock } from "./state.ts";

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Docker work on the VM every lane shares, not a hidden wait.
vi.setConfig({ testTimeout: DOCKER_TEST_TIMEOUT_MS, hookTimeout: DOCKER_TEST_TIMEOUT_MS });

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const run = NodeCrypto.randomBytes(3).toString("hex");
const upstream = `sail-caddy-test-${run}`;
const ids = Array.from({ length: 6 }, (_, index) => `caddy-test-${run}-${index}`);

const HOME = `caddy-test-${run}`;
const CADDY_TS = JSON.stringify(NodePath.join(import.meta.dirname, "caddy.ts"));

const inChild = (script: string, env: NodeJS.ProcessEnv = process.env) =>
  execFile(process.execPath, ["--input-type=module", "-e", script], { env });

const publishScript = (id: string, to: string, home: string) =>
  `import { publishSite } from ${CADDY_TS};
   publishSite({ id: ${JSON.stringify(id)}, home: ${JSON.stringify(home)}, host: ${JSON.stringify(`${id}.localtest.me`)}, upstream: ${JSON.stringify(to)} });`;

const publishInChild = (id: string, to = `${upstream}:8080`) =>
  inChild(publishScript(id, to, HOME));

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

/** Holds the reload lock until a second process waits on it, then until told to let go. */
const HOLD_UNTIL_TOLD = `echo held
i=0
until [ "$(ps -o args | grep -c '^flock /data/reload.lock')" -ge 2 ] || [ "$i" -ge 600 ]; do
  i=$((i + 1)); sleep 0.05
done
echo waiting
read -r go`;

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

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fixture-caddy-test-"));
afterAll(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));

const openssl = (args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync("openssl", args, { encoding: "utf8" });

/** A leaf for `san`, signed by the root in `ca`, as anything holding the root key could make. */
function issue(ca: string, san: string): { readonly key: string; readonly cert: string } {
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "leaf-"));
  const at = (name: string) => NodePath.join(dir, name);
  NodeFS.writeFileSync(at("ext.cnf"), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
  const steps = [
    ["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"].concat([
      "-keyout",
      at("leaf.key"),
      "-out",
      at("leaf.csr"),
      "-subj",
      "/CN=leaf",
    ]),
    ["x509", "-req", "-in", at("leaf.csr"), "-CA", NodePath.join(ca, "root.crt")]
      .concat(["-CAkey", NodePath.join(ca, "root.key"), "-set_serial", "1", "-days", "1"])
      .concat(["-extfile", at("ext.cnf"), "-out", at("leaf.crt")]),
  ];
  for (const step of steps) expect(openssl(step).status, step[0]).toBe(0);
  return { key: at("leaf.key"), cert: at("leaf.crt") };
}

const verifies = (ca: string, san: string) =>
  openssl(["verify", "-CAfile", NodePath.join(ca, "root.crt"), issue(ca, san).cert]).status === 0;

/** Node's own TLS client, which an app under test would use with `NODE_EXTRA_CA_CERTS`. */
async function nodeAccepts(ca: string, san: string, host: string): Promise<boolean> {
  const leaf = issue(ca, san);
  const server = NodeHttps.createServer(
    { key: NodeFS.readFileSync(leaf.key), cert: NodeFS.readFileSync(leaf.cert) },
    (_request, response) => response.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { readonly port: number };
  try {
    return await new Promise<boolean>((resolve) => {
      const request = NodeHttps.get(
        {
          host: "127.0.0.1",
          servername: host,
          port,
          ca: NodeFS.readFileSync(NodePath.join(ca, "root.crt")),
        },
        (response) => {
          response.resume();
          resolve(true);
        },
      );
      request.on("error", () => resolve(false));
    });
  } finally {
    server.close();
  }
}

const CURL = NodeFS.existsSync("/usr/bin/curl") ? "/usr/bin/curl" : "curl";

/** The system curl, on LibreSSL on macOS, which reads a name constraint differently from OpenSSL. */
async function curlAccepts(ca: string, san: string, host: string): Promise<boolean> {
  const leaf = issue(ca, san);
  const server = NodeHttps.createServer(
    { key: NodeFS.readFileSync(leaf.key), cert: NodeFS.readFileSync(leaf.cert) },
    (_request, response) => response.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { readonly port: number };
  try {
    const args = ["-s", "--cacert", NodePath.join(ca, "root.crt")].concat([
      "--resolve",
      `${host}:${port}:127.0.0.1`,
      `https://${host}:${port}/`,
    ]);
    return await execFile(CURL, args).then(
      ({ stdout }) => stdout === "ok",
      () => false,
    );
  } finally {
    server.close();
  }
}

const V1_CONSTRAINTS = "critical,permitted;DNS:localtest.me";
const V2_CONSTRAINTS = `${V1_CONSTRAINTS},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:::/::`;

/** A root an older revision made: version 1 had no version file and said nothing about IPs. */
function makeOldRoot(dir: string, version: 1 | 2): void {
  const ca = NodePath.join(dir, "ca");
  NodeFS.mkdirSync(ca, { recursive: true });
  const made = openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    NodePath.join(ca, "root.key"),
    "-out",
    NodePath.join(ca, "root.crt"),
    "-days",
    "30",
    "-subj",
    "/CN=Sail fixtures local CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-addext",
    `nameConstraints=${version === 1 ? V1_CONSTRAINTS : V2_CONSTRAINTS}`,
  ]);
  expect(made.status).toBe(0);
  if (version === 2) NodeFS.writeFileSync(NodePath.join(ca, "version"), "2\n");
}

describe("fixture root CA", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "home-"));
  const ca = NodePath.join(dir, "ca");
  beforeAll(() => {
    ensureRootCa(dir);
  });

  it("signs localtest.me names and nothing else, IP addresses included", () => {
    expect(verifies(ca, "DNS:demo.localtest.me")).toBe(true);
    expect(verifies(ca, "DNS:auth.localtest.me")).toBe(true);
    expect(verifies(ca, "DNS:evil.example.com")).toBe(false);
    expect(verifies(ca, "DNS:evil-localtest.me")).toBe(false);
    expect(verifies(ca, "IP:127.0.0.1")).toBe(false);
    expect(verifies(ca, "IP:1.1.1.1")).toBe(false);
    expect(verifies(ca, "IP:::1")).toBe(false);
  });

  it("is refused by Node's TLS client for an IP address or a name that only ends in localtest.me", async () => {
    expect(await nodeAccepts(ca, "DNS:demo.localtest.me", "demo.localtest.me")).toBe(true);
    expect(await nodeAccepts(ca, "IP:127.0.0.1", "")).toBe(false);
    expect(await nodeAccepts(ca, "DNS:evil-localtest.me", "evil-localtest.me")).toBe(false);
  });

  it("is refused by macOS curl for a name that only ends in localtest.me", async () => {
    expect(await curlAccepts(ca, "DNS:demo.localtest.me", "demo.localtest.me")).toBe(true);
    expect(await curlAccepts(ca, "DNS:evil-localtest.me", "evil-localtest.me")).toBe(false);
  });

  it("replaces a version 2 root, which LibreSSL lets vouch for evil-localtest.me", async () => {
    const old = NodeFS.mkdtempSync(NodePath.join(scratch, "v2-"));
    makeOldRoot(old, 2);
    const oldCa = NodePath.join(old, "ca");
    expect(verifies(oldCa, "DNS:evil-localtest.me"), "OpenSSL refused it already").toBe(false);
    if (
      /LibreSSL/.test(NodeChildProcess.spawnSync(CURL, ["--version"], { encoding: "utf8" }).stdout)
    )
      expect(await curlAccepts(oldCa, "DNS:evil-localtest.me", "evil-localtest.me")).toBe(true);
    const kept = NodePath.join(old, "kept-v2.crt");
    NodeFS.copyFileSync(NodePath.join(oldCa, "root.crt"), kept);
    expect(ensureRootCa(old)).toBe(true);
    expect(await curlAccepts(oldCa, "DNS:evil-localtest.me", "evil-localtest.me")).toBe(false);
    const signed = issue(oldCa, "DNS:demo.localtest.me");
    expect(
      openssl(["verify", "-CAfile", kept, signed.cert]).status,
      "a lane that kept the version 2 root still verifies what the new root signs",
    ).toBe(0);
  });

  it("makes a root when the version is there but the root or its key is not", () => {
    for (const missing of ["root.crt", "root.key"]) {
      const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "partial-"));
      expect(ensureRootCa(dir)).toBe(true);
      NodeFS.rmSync(NodePath.join(dir, "ca", missing));
      expect(ensureRootCa(dir), `without ${missing}`).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(dir, "ca", missing))).toBe(true);
      expect(rootFingerprint(dir)).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("keeps the old root when the new one cannot take its place", async () => {
    const old = NodeFS.mkdtempSync(NodePath.join(scratch, "promote-"));
    makeOldRoot(old, 2);
    const before = NodeFS.readFileSync(NodePath.join(old, "ca", "root.crt"), "utf8");
    const failed = await inChild(
      `import fs from "node:fs";
       import { syncBuiltinESMExports } from "node:module";
       const rename = fs.renameSync;
       fs.renameSync = (from, to) => {
         if (to.endsWith("/ca") && !from.endsWith("-retired")) throw Object.assign(new Error("promotion failed"), { code: "EIO" });
         return rename(from, to);
       };
       syncBuiltinESMExports();
       const { ensureRootCa } = await import(${CADDY_TS});
       ensureRootCa(${JSON.stringify(old)});`,
    ).then(
      () => "",
      (error: { readonly stderr: string }) => error.stderr,
    );
    expect(failed).toContain("promotion failed");
    expect(NodeFS.readFileSync(NodePath.join(old, "ca", "root.crt"), "utf8")).toBe(before);
    expect(NodeFS.readdirSync(old).toSorted()).toEqual(["ca", "caddy.lock"]);
  });

  it("replaces an older root once when several lanes upgrade it at the same moment", async () => {
    const old = NodeFS.mkdtempSync(NodePath.join(scratch, "race-"));
    makeOldRoot(old, 1);
    const go = NodePath.join(old, "go");
    const lanes = Array.from({ length: 4 }, () =>
      NodeChildProcess.spawn(process.execPath, [
        "--input-type=module",
        "-e",
        `import * as NodeFS from "node:fs";
         import { ensureRootCa } from ${JSON.stringify(NodePath.join(import.meta.dirname, "caddy.ts"))};
         process.stdout.write("ready\\n");
         while (!NodeFS.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
         process.stdout.write(String(ensureRootCa(${JSON.stringify(old)})));`,
      ]),
    );
    const outputs = lanes.map((lane) => {
      let output = "";
      lane.stdout.setEncoding("utf8");
      lane.stdout.on("data", (chunk: string) => (output += chunk));
      return new Promise<string>((resolve) => lane.once("close", () => resolve(output)));
    });
    await Promise.all(
      lanes.map(
        (lane) =>
          new Promise((resolve) =>
            NodeReadline.createInterface({ input: lane.stdout }).once("line", resolve),
          ),
      ),
    );
    NodeFS.writeFileSync(go, "");
    const answers = (await Promise.all(outputs)).map((output) => output.replace("ready\n", ""));
    expect(
      answers.filter((answer) => answer === "true"),
      answers.join(","),
    ).toHaveLength(1);
    const ca = NodePath.join(old, "ca");
    const publicKey = (args: ReadonlyArray<string>) => openssl(args).stdout;
    expect(publicKey(["x509", "-noout", "-pubkey", "-in", NodePath.join(ca, "root.crt")])).toBe(
      publicKey(["pkey", "-pubout", "-in", NodePath.join(ca, "root.key")]),
    );
    expect(verifies(ca, "IP:127.0.0.1")).toBe(false);
    expect(NodeFS.readdirSync(old).toSorted()).toEqual(["ca", "caddy.lock", "go"]);
  });

  it("replaces a root an older revision made, and keeps a current or newer one", () => {
    const old = NodeFS.mkdtempSync(NodePath.join(scratch, "old-"));
    makeOldRoot(old, 1);
    const before = NodeFS.readFileSync(NodePath.join(old, "ca", "root.crt"), "utf8");
    expect(verifies(NodePath.join(old, "ca"), "IP:127.0.0.1")).toBe(true);
    expect(ensureRootCa(old)).toBe(true);
    const after = NodeFS.readFileSync(NodePath.join(old, "ca", "root.crt"), "utf8");
    expect(after).not.toBe(before);
    expect(verifies(NodePath.join(old, "ca"), "IP:127.0.0.1")).toBe(false);
    expect(ensureRootCa(old)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(old, "ca", "root.crt"), "utf8")).toBe(after);
    NodeFS.writeFileSync(NodePath.join(old, "ca", "version"), `${CA_VERSION + 1}\n`);
    expect(ensureRootCa(old)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(old, "ca", "root.crt"), "utf8")).toBe(after);
  });
});

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
    ensureCaddy(HOME);
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
    const answers = await Promise.all(
      ids.map((id) => status(`${publicUrl(`${id}.localtest.me`)}/`)),
    );
    expect(answers).toEqual(ids.map(() => "200"));
  });

  it("never lets another reload see a site Caddy refuses", async () => {
    const bad = `caddy-test-${run}-bad`;
    const holder = NodeChildProcess.spawn("docker", [
      "exec",
      caddyContainer(),
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
    expect(await status(`${publicUrl(`${ids[0]}.localtest.me`)}/`)).toBe("200");
  });

  it("runs Caddy on the root on disk, with that root's own data volume", () => {
    const root = rootFingerprint();
    const state = JSON.parse(docker(["inspect", "--format", "{{json .}}", caddyContainer()])) as {
      readonly Config: { readonly Labels: Readonly<Record<string, string>> };
      readonly Mounts: ReadonlyArray<{ readonly Destination: string; readonly Name?: string }>;
    };
    expect(state.Config.Labels[ROOT_LABEL]).toBe(root);
    expect(state.Mounts.find((mount) => mount.Destination === "/data")?.Name).toBe(
      `${caddyContainer()}-data-${root}`,
    );
    const ca = JSON.parse(
      docker([
        "exec",
        caddyContainer(),
        "wget",
        "-q",
        "-O",
        "-",
        "http://127.0.0.1:2019/pki/ca/local",
      ]),
    ) as { readonly root_certificate: string };
    expect(ca.root_certificate.trim()).toBe(NodeFS.readFileSync(rootCertPath(), "utf8").trim());
  });

  it("serves with a shared root that cannot sign an IP address", () => {
    expect(verifies(NodePath.dirname(rootCertPath()), "IP:127.0.0.1")).toBe(false);
    expect(verifies(NodePath.dirname(rootCertPath()), "DNS:demo.localtest.me")).toBe(true);
  });

  it("refuses the hosts the fixtures reserve", () => {
    expect(() =>
      publishSite({
        id: `caddy-test-${run}-auth`,
        home: HOME,
        host: "auth.localtest.me",
        upstream: "x:1",
      }),
    ).toThrow(/reserved/);
  });
});

describe.skipIf(!hasDocker())("a Caddy that two homes share", () => {
  const instance = `test-${run}`;
  const env = { ...process.env, SAIL_FIXTURES_CADDY_INSTANCE: instance };
  const container = `${CADDY_CONTAINER}-${instance}`;
  const dir = NodePath.join(fixturesRoot(), `caddy-${instance}`);
  const backend = `sail-caddy-two-${run}`;
  const site = (home: string) => `two-${run}-${home}`;
  const inInstance = (script: string) => inChild(script, env);
  const ensureFor = (home: string) =>
    inInstance(`import { ensureCaddy } from ${CADDY_TS}; ensureCaddy(${JSON.stringify(home)});`);
  const publishFor = (home: string, to = `${backend}:8080`) =>
    inInstance(publishScript(site(home), to, home));
  const removeFor = (home: string) =>
    inInstance(
      `import { removeSite } from ${CADDY_TS}; removeSite(${JSON.stringify(site(home))});`,
    );
  const running = () =>
    JSON.parse(docker(["inspect", "--format", "{{json .}}", container])) as {
      readonly Id: string;
      readonly Config: { readonly Labels: Readonly<Record<string, string>> };
    };
  const fingerprint = () =>
    NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(NodePath.join(dir, "ca", "root.crt")))
      .digest("hex")
      .slice(0, 12);
  /** What a lane that read the root when it started sees, by the CA file it kept. */
  const statusWith = async (root: string, home: string) => {
    const port = docker(["port", container, "443/tcp"]).trim().split("\n")[0]?.split(":").pop();
    const host = `${site(home)}.localtest.me`;
    const args = ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", root];
    const target = [`${host}:${port}:127.0.0.1`, `https://${host}:${port}/`];
    return execFile("curl", [...args, "--resolve", ...target]).then(
      ({ stdout }) => stdout,
      () => "unreachable",
    );
  };
  /** Caddy issues a new site's certificate after the reload returns, slowly at load 90. */
  const servesWith = (root: string, home: string) =>
    expect.poll(() => statusWith(root, home), { timeout: 120_000, interval: 250 }).toBe("200");
  const keepRoot = (name: string) => {
    const kept = NodePath.join(scratch, `${name}.crt`);
    NodeFS.copyFileSync(NodePath.join(dir, "ca", "root.crt"), kept);
    return kept;
  };
  const putOldRoot = () => {
    NodeFS.rmSync(NodePath.join(dir, "ca"), { recursive: true, force: true });
    makeOldRoot(dir, 2);
  };

  beforeAll(() => {
    docker(
      ["run", "--detach", "--name", backend, "--label", `${FIXTURE_LABEL}=caddy-test`]
        .concat(["--network", NETWORK, "--memory", "64m", "caddy:2"])
        .concat(["caddy", "respond", "--listen", ":8080", "--body", "ok"]),
    );
    NodeFS.mkdirSync(dir, { recursive: true });
  });

  afterAll(() => {
    docker(["rm", "--force", backend, container]);
    const volumes = docker(["volume", "ls", "-q", "--filter", `name=^${container}-data-`]).trim();
    if (volumes) docker(["volume", "rm", "--force", ...volumes.split("\n")]);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the root other homes trust, and refuses to replace a Caddy they serve through", async () => {
    putOldRoot();
    NodeFS.mkdirSync(NodePath.join(dir, "sites"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(dir, "sites", `${site("z")}.caddy`),
      `${site("z")}.localtest.me {\n\ttls internal\n\treverse_proxy ${backend}:8080\n}\n`,
    );
    await publishFor("a");
    const first = running();
    const rootA = keepRoot("root-a");
    expect(first.Config.Labels[ROOT_LABEL], "the version 2 root, which home z trusts").toBe(
      fingerprint(),
    );
    expect(NodeFS.readFileSync(NodePath.join(dir, "ca", "version"), "utf8")).toBe("2\n");
    await servesWith(rootA, "a");

    await ensureFor("b");
    expect(running().Id, "home b waits for the newer root too").toBe(first.Id);

    const served = NodePath.join(scratch, `ca-${run}`);
    NodeFS.cpSync(NodePath.join(dir, "ca"), served, { recursive: true });
    putOldRoot();
    const refused = await ensureFor("b").then(
      () => "",
      (error: { readonly stderr: string }) => error.stderr,
    );
    expect(refused).toMatch(new RegExp(`other homes still serve .*${site("a")}`));
    expect(running().Id).toBe(first.Id);
    expect(await statusWith(rootA, "a"), "home a keeps working on the root it read").toBe("200");
    NodeFS.rmSync(NodePath.join(dir, "ca"), { recursive: true });
    NodeFS.cpSync(served, NodePath.join(dir, "ca"), { recursive: true });

    NodeFS.rmSync(NodePath.join(dir, "sites", `${site("z")}.caddy`));
    await removeFor("a");
    await ensureFor("b");
    const second = running();
    expect(second.Id, "nobody else serves through it now").not.toBe(first.Id);
    expect(second.Config.Labels[ROOT_LABEL]).toBe(fingerprint());
    expect(NodeFS.readFileSync(NodePath.join(dir, "ca", "version"), "utf8")).toBe(
      `${CA_VERSION}\n`,
    );
    await publishFor("b");
    await servesWith(keepRoot("root-b"), "b");
    expect(await statusWith(rootA, "b"), "a lane that read the version 2 root").toBe("200");
    await removeFor("b");
  });

  it("replaces the Caddy only once a reload in flight lets go of the host lock", async () => {
    await ensureFor("a");
    const before = running().Id;
    const holder = NodeChildProcess.spawn("docker", [
      "exec",
      "--interactive",
      container,
      "flock",
      "/data/reload.lock",
      "sh",
      "-c",
      HOLD_UNTIL_TOLD,
    ]);
    const lines = NodeReadline.createInterface({ input: holder.stdout })[Symbol.asyncIterator]();
    expect((await lines.next()).value).toBe("held");
    const reloading = publishFor("a", `sail-gone-${run}:8080`);
    expect((await lines.next()).value, "home a's reload waits inside the container").toBe(
      "waiting",
    );
    const probe = takeLock(NodePath.join(dir, "caddy.lock"));
    probe?.();
    expect(probe, "and holds the host lock while it waits").toBeUndefined();

    NodeFS.writeFileSync(NodePath.join(dir, "ca", "version"), "2\n");
    const replacing = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { ensureCaddy } from ${CADDY_TS};
         import { takeLock } from ${JSON.stringify(NodePath.join(import.meta.dirname, "state.ts"))};
         const free = takeLock(${JSON.stringify(NodePath.join(dir, "caddy.lock"))});
         free?.();
         process.stdout.write(free ? "free\\n" : "blocked\\n");
         ensureCaddy("b");`,
      ],
      { env, stdio: ["ignore", "pipe", "inherit"] },
    );
    const [seen] = await NodeEvents.EventEmitter.once(replacing.stdout, "data");
    expect(String(seen), "home b finds the reload holding the lock it must take").toBe("blocked\n");
    expect(running().Id).toBe(before);
    holder.stdin.end("go\n");
    await expect(reloading, "the reload was not cut off").resolves.toBeDefined();
    expect((await NodeEvents.EventEmitter.once(replacing, "exit"))[0]).toBe(0);
    expect(running().Id).not.toBe(before);
    await removeFor("a");
  });
});

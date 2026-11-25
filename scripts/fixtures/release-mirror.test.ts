// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Drives the real installer against the release mirror, on this computer and in Docker.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { docker, FIXTURE_LABEL, hasDocker } from "./lib/docker.ts";
import { startMirror, type Mirror } from "./release-mirror.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const VERSION = "1.2.3";

const dockerArch = () =>
  docker(["info", "--format", "{{.Architecture}}"]).trim() === "aarch64" ? "arm64" : "x64";

async function writeArchive(dir: string, platform: string, arch: string): Promise<string> {
  const stem = `t3-${VERSION}-${platform}-${arch}`;
  const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mirror-stage-"));
  await NodeFSP.mkdir(NodePath.join(staging, stem));
  await NodeFSP.writeFile(
    NodePath.join(staging, stem, "t3"),
    `#!/bin/sh\necho 't3 v${VERSION}'\n`,
    {
      mode: 0o755,
    },
  );
  const archivePath = NodePath.join(dir, `${stem}.tar.gz`);
  NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", staging, stem]);
  await NodeFSP.rm(staging, { recursive: true, force: true });
  return archivePath;
}

describe("release mirror", () => {
  let root: string;
  let archivePath: string;
  let mirror: Mirror;

  beforeAll(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mirror-"));
    await NodeFSP.mkdir(NodePath.join(root, "releases"));
    archivePath = await writeArchive(
      NodePath.join(root, "releases"),
      HostProcess.Platform.defaultValue(),
      HostProcess.Architecture.defaultValue(),
    );
    mirror = await startMirror({ dir: NodePath.join(root, "releases") });
  });

  afterAll(async () => {
    await mirror?.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("serves checksums, archives, and an installer pointed at itself", async () => {
    const archive = await NodeFSP.readFile(archivePath);
    const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
    const sums = await fetch(`${mirror.url}/v${VERSION}/SHA256SUMS`);
    expect(await sums.text()).toBe(`${digest}  ${NodePath.basename(archivePath)}\n`);

    const served = await fetch(`${mirror.url}/v${VERSION}/${NodePath.basename(archivePath)}`);
    expect(Buffer.from(await served.arrayBuffer()).equals(archive)).toBe(true);

    for (const path of ["/install.sh", `/v${VERSION}/install.sh`]) {
      const installer = await (await fetch(`${mirror.url}${path}`)).text();
      expect(installer).toContain(`base_url="\${T3CODE_RELEASE_BASE_URL:-${mirror.url}}"`);
    }

    for (const path of ["/nope", `/v9.9.9/SHA256SUMS`, `/v${VERSION}/t3-other.tar.gz`]) {
      expect((await fetch(`${mirror.url}${path}`)).status, path).toBe(404);
    }
  });

  it("installs t3 here through curl | sh", async () => {
    const home = NodePath.join(root, "home");
    await NodeFSP.mkdir(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      T3CODE_HOME: NodePath.join(home, ".t3"),
      T3CODE_VERSION: VERSION,
    };
    delete env.T3CODE_RELEASE_BASE_URL;
    delete env.T3CODE_INSTALL_BIN_DIR;
    const { stderr } = await execFile("sh", ["-c", `curl -fsSL "${mirror.url}/install.sh" | sh`], {
      env,
      cwd: home,
    });
    expect(stderr).toContain(`Installed T3 Code ${VERSION}`);
    const { stdout } = await execFile(NodePath.join(home, ".local/bin/t3"), ["--version"]);
    expect(stdout.trim()).toBe(`t3 v${VERSION}`);
  });
});

describe.skipIf(!hasDocker())("release mirror from a container", () => {
  let root: string;
  let mirror: Mirror;
  let containerId: string | undefined;

  beforeAll(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mirror-docker-"));
    await writeArchive(root, "linux", dockerArch());
    // Docker Desktop reaches loopback as host.docker.internal; Linux's host-gateway does not.
    mirror = await startMirror({
      dir: root,
      host: HostProcess.Platform.defaultValue() === "linux" ? "0.0.0.0" : "127.0.0.1",
    });
  });

  afterAll(async () => {
    if (containerId !== undefined) docker(["rm", "-f", "-v", containerId]);
    await mirror?.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("installs t3 in Linux through wget | sh", async () => {
    const port = new URL(mirror.url).port;
    containerId = docker([
      "run",
      "-d",
      "--memory",
      "256m",
      "--label",
      `${FIXTURE_LABEL}=release-mirror-test`,
      "--add-host=host.docker.internal:host-gateway",
      "--entrypoint",
      "sh",
      "caddy:2",
      "-c",
      `wget -qO- http://host.docker.internal:${port}/install.sh | T3CODE_VERSION=${VERSION} sh && "$HOME/.local/bin/t3" --version`,
    ]).trim();
    const { stdout: exitCode } = await execFile("docker", ["wait", containerId], {
      timeout: 60_000,
    });
    const logs = NodeChildProcess.spawnSync("docker", ["logs", containerId], { encoding: "utf8" });
    expect(exitCode.trim(), logs.stdout + logs.stderr).toBe("0");
    expect(logs.stderr).toContain(`Installed T3 Code ${VERSION}`);
    expect(logs.stdout.trim().split("\n").at(-1)).toBe(`t3 v${VERSION}`);
  });
});

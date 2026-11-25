// @effect-diagnostics nodeBuiltinImport:off - Executes generated installers against isolated local release fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { buildDesktopInstallers } from "./build-desktop-installers.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);

async function fixture(platform: "Darwin" | "Linux", corrupt = false) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sail-installer-"));
  const release = NodePath.join(root, "release");
  const bin = NodePath.join(root, "fixture-bin");
  const install = NodePath.join(root, "User's Applications $literal");
  const command = NodePath.join(root, "commands");
  await NodeFSP.mkdir(release);
  await NodeFSP.mkdir(bin);
  await buildDesktopInstallers({
    version: "0.1.3",
    repository: "snowdamiz/sail",
    outputDir: release,
  });
  const name = platform === "Darwin" ? "Sail-0.1.3-arm64.zip" : "Sail-arm64.AppImage";
  if (platform === "Darwin") {
    const bundle = NodePath.join(root, "Sail.app");
    await NodeFSP.mkdir(NodePath.join(bundle, "Contents", "MacOS"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(bundle, "Contents", "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Sail (Beta)</string></dict></plist>',
    );
    await NodeFSP.writeFile(NodePath.join(bundle, "Contents", "MacOS", "Sail"), "fixture");
    await execute("/usr/bin/ditto", [
      "-c",
      "-k",
      "--keepParent",
      bundle,
      NodePath.join(release, name),
    ]);
  } else {
    await NodeFSP.writeFile(NodePath.join(release, name), "fixture appimage");
  }
  const sha = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(NodePath.join(release, name)))
    .digest("hex");
  await NodeFSP.writeFile(
    NodePath.join(release, "SHA256SUMS"),
    `${corrupt ? "0".repeat(64) : sha}  ${name}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo "$FIXTURE_PLATFORM";; -m) echo arm64;; esac\n',
    { mode: 0o755 },
  );
  await NodeFSP.writeFile(NodePath.join(bin, "sysctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await NodeFSP.writeFile(
    NodePath.join(bin, "curl"),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) shift; output="$1";; https:*) url="$1";; esac; shift; done\ncp "$FIXTURE_RELEASE_DIR/${url##*/}" "$output"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: bin + NodePath.delimiter + process.env.PATH,
    FIXTURE_PLATFORM: platform,
    FIXTURE_RELEASE_DIR: release,
    SAIL_INSTALL_DIR: install,
    SAIL_INSTALL_BIN_DIR: command,
    XDG_DATA_HOME: NodePath.join(root, "share"),
  };
  return {
    root,
    release,
    install,
    command,
    run: () => execute("/bin/sh", [NodePath.join(release, "install-desktop.sh")], { env }),
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it.runIf(NodeOS.type() === "Darwin")(
  "installs an unsigned macOS archive and creates a launcher with correctly quoted paths",
  async () => {
    await using f = await fixture("Darwin");
    await f.run();
    expect(
      await NodeFSP.readFile(
        NodePath.join(f.install, "Sail.app", "Contents", "MacOS", "Sail"),
        "utf8",
      ),
    ).toBe("fixture");
    const launcher = await NodeFSP.readFile(NodePath.join(f.command, "sail"), "utf8");
    expect(launcher).toContain("User'\\''s Applications $literal");
    await execute("/bin/sh", ["-n", NodePath.join(f.command, "sail")]);
    await f.run();
    expect((await NodeFSP.readdir(f.install)).filter((name) => name.startsWith(".Sail"))).toEqual(
      [],
    );
  },
);

it("installs a Linux AppImage, launcher, and app menu entry without executing it", async () => {
  await using f = await fixture("Linux");
  await f.run();
  expect(await NodeFSP.readFile(NodePath.join(f.command, "sail"), "utf8")).toBe("fixture appimage");
  expect(
    await NodeFSP.readFile(NodePath.join(f.root, "share", "applications", "sail.desktop"), "utf8"),
  ).toContain("Sail.AppImage");
});

it("leaves an existing installation intact when the published checksum is wrong", async () => {
  await using f = await fixture("Linux", true);
  await NodeFSP.mkdir(f.install);
  await NodeFSP.writeFile(NodePath.join(f.install, "Sail.AppImage"), "original");
  await expect(f.run()).rejects.toThrow("Checksum verification failed");
  expect(await NodeFSP.readFile(NodePath.join(f.install, "Sail.AppImage"), "utf8")).toBe(
    "original",
  );
});

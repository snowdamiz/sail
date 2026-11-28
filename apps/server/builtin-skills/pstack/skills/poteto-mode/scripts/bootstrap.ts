import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const scriptsDirectory = import.meta.dir;
const nodeModulesDirectory = NodePath.join(scriptsDirectory, "node_modules");
const commanderPackagePath = NodePath.join(nodeModulesDirectory, "commander", "package.json");
const installKeyPath = NodePath.join(nodeModulesDirectory, ".poteto-mode-tools-install-key");

function currentInstallKey(): string {
  return NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(NodePath.join(scriptsDirectory, "package.json")))
    .update("\0")
    .update(NodeFS.readFileSync(NodePath.join(scriptsDirectory, "bun.lock")))
    .digest("hex");
}

export function ensureDependenciesInstalled(): void {
  const installKey = currentInstallKey();
  if (
    NodeFS.existsSync(commanderPackagePath) &&
    NodeFS.existsSync(installKeyPath) &&
    NodeFS.readFileSync(installKeyPath, "utf8").trim() === installKey
  ) {
    return;
  }

  const result = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], {
    cwd: scriptsDirectory,
  });
  if (result.exitCode !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`bun install --frozen-lockfile exited with status ${result.exitCode}`);
  }
  if (!NodeFS.existsSync(commanderPackagePath)) {
    throw new Error("bun install --frozen-lockfile completed without installing commander");
  }

  NodeFS.writeFileSync(installKeyPath, `${installKey}\n`);

  const restarted = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(restarted.exitCode ?? 1);
}

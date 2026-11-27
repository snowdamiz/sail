// @effect-diagnostics nodeBuiltinImport:off - Release tooling renders platform installer assets and SHA256SUMS.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import desktopPackage from "../apps/desktop/package.json" with { type: "json" };

const CHECKSUM_EXTENSIONS = [".zip", ".dmg", ".AppImage", ".deb", ".tar.gz"];

export async function buildDesktopInstallers(options: {
  readonly version: string;
  readonly repository: string;
  readonly outputDir: string;
  readonly releaseBaseUrl?: string;
  readonly writeChecksums?: boolean;
}) {
  if (
    !/^\d+\.\d+\.\d+(?:-(?:(?:nightly|preview)\.\d{8}\.\d+|pr\.\d+\.\d+|lane\.[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*))?$/.test(
      options.version,
    )
  )
    throw new Error("Invalid desktop installer version.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository))
    throw new Error("Invalid release repository.");
  const releaseBase =
    options.releaseBaseUrl ?? `https://github.com/${options.repository}/releases/download`;
  if (!/^https?:\/\/[\w.\-/:]+$/.test(releaseBase))
    throw new Error("Invalid release download URL.");
  await NodeFSP.mkdir(options.outputDir, { recursive: true });
  const name = "install-desktop.sh";
  const template = await NodeFSP.readFile(NodePath.join(import.meta.dirname, name), "utf8");
  await NodeFSP.writeFile(
    NodePath.join(options.outputDir, name),
    template
      .replaceAll("__SAIL_VERSION__", options.version)
      .replaceAll("__SAIL_REPOSITORY__", options.repository)
      .replaceAll("__SAIL_RELEASE_BASE__", releaseBase.replace(/\/$/, "")),
    { mode: 0o755 },
  );

  if (options.writeChecksums) {
    const entries = (await NodeFSP.readdir(options.outputDir))
      .filter(
        (entry) => entry === "install.sh" || CHECKSUM_EXTENSIONS.some((ext) => entry.endsWith(ext)),
      )
      .sort();
    const lines: string[] = [];
    for (const entry of entries) {
      const content = await NodeFSP.readFile(NodePath.join(options.outputDir, entry));
      const digest = NodeCrypto.createHash("sha256").update(content).digest("hex");
      lines.push(`${digest}  ${entry}`);
    }
    if (lines.length > 0) {
      await NodeFSP.writeFile(
        NodePath.join(options.outputDir, "SHA256SUMS"),
        `${lines.join("\n")}\n`,
        "utf8",
      );
    }
  }
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      version: { type: "string", default: desktopPackage.version },
      repository: {
        type: "string",
        default:
          process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY ||
          process.env.GITHUB_REPOSITORY ||
          CLI_RELEASE_REPOSITORY,
      },
      "output-dir": { type: "string", default: "release" },
      "release-base-url": { type: "string" },
      checksums: { type: "boolean", default: false },
    },
  });
  await buildDesktopInstallers({
    version: values.version,
    repository: values.repository,
    outputDir: values["output-dir"],
    ...(values["release-base-url"] ? { releaseBaseUrl: values["release-base-url"] } : {}),
    writeChecksums: values.checksums,
  });
}

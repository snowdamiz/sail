// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - The macOS archive adapter owns HTTP streams, private staging, and the detached install helper.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { compareSemverVersions } from "@t3tools/shared/semver";

const Manifest = Schema.Struct({
  version: Schema.String,
  files: Schema.Array(
    Schema.Struct({ url: Schema.String, sha512: Schema.String, size: Schema.Number }),
  ),
  releaseNotes: Schema.optional(Schema.String),
});
const decodeManifest = Schema.decodeUnknownSync(fromYaml(Manifest));
const decodeReleases = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      tag_name: Schema.String,
      draft: Schema.optional(Schema.Boolean),
      body: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);
const Feed = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("github"), owner: Schema.String, repo: Schema.String }),
  Schema.Struct({ provider: Schema.Literal("generic"), url: Schema.String }),
]);
const decodeFeed = Schema.decodeUnknownSync(Feed);
const InstallRecord = Schema.Struct({
  version: Schema.String,
  target: Schema.String,
  backup: Schema.String,
  staging: Schema.String,
});
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(InstallRecord));
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/;

interface Options {
  readonly version: () => string;
  readonly arch: () => string;
  readonly appBundle: () => string;
  readonly cacheDir: () => string;
  readonly resourcesDir: () => string;
  readonly runningPid: number;
  readonly quit: () => void;
  readonly onCleanupFailure?: (cause: unknown) => void;
  readonly fetch?: typeof fetch;
  readonly run?: (command: string, args: ReadonlyArray<string>) => Promise<string>;
  readonly launchInstaller?: (
    script: string,
    args: ReadonlyArray<string>,
    log: string,
  ) => Promise<void>;
}

function secureUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalLoopbackHost(url.hostname)))
    throw new Error("The update feed must use HTTPS.");
  return url;
}

export function selectMacArchive(manifest: typeof Manifest.Type, arch: string) {
  if (!RELEASE_VERSION.test(manifest.version)) throw new Error("Invalid desktop release version.");
  const name = "Sail-" + manifest.version + "-" + arch + ".zip";
  const versioned = "../../releases/v" + manifest.version + "/" + name;
  const file = manifest.files.find(
    (entry) =>
      decodeURIComponent(entry.url) === name || decodeURIComponent(entry.url) === versioned,
  );
  if (
    !file ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
  )
    throw new Error("The release has no valid macOS archive for " + arch + ".");
  return { ...file, url: file.url === versioned ? versioned : name };
}

/** Keeps the existing update UI while replacing Squirrel.Mac's certificate-dependent installer. */
export class MacArchiveUpdater extends NodeEvents.EventEmitter {
  channel: string | null = "latest";
  allowDowngrade = false;
  allowPrerelease = false;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  fullChangelog = false;
  disableDifferentialDownload = true;
  private feed: typeof Feed.Type | undefined;
  private available: { manifest: typeof Manifest.Type; baseUrl: string } | null = null;
  private downloaded: { replacement: string; staging: string; version: string } | null = null;
  private readonly run;
  private readonly fetch;
  private readonly options: Options;

  constructor(options: Options) {
    super();
    this.options = options;
    this.run =
      options.run ??
      (async (command: string, args: ReadonlyArray<string>) =>
        (await execute(command, [...args])).stdout.trim());
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  setFeedURL(options: unknown) {
    this.feed = decodeFeed(options);
    this.available = null;
  }

  private async response(url: string) {
    const response = await this.fetch(secureUrl(url), {
      signal: AbortSignal.timeout(120_000),
      headers: { "User-Agent": "Sail-Desktop-Updater" },
    });
    if (!response.ok) throw new Error("Update request failed (" + response.status + ").");
    return response;
  }

  /** Electron's fs treats app.asar as a directory, so its rm cannot delete an app bundle. */
  private removeBundle(path: string) {
    return this.run("/bin/rm", ["-rf", "--", path]);
  }

  private async cleanAppliedInstall() {
    const recordPath = NodePath.join(this.options.cacheDir(), "pending-install.json");
    const raw = await NodeFSP.readFile(recordPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (raw === null) return;
    const record = decodeRecord(raw);
    const target = this.options.appBundle();
    if (record.version !== this.options.version() || record.target !== target) return;
    if (
      !record.backup.startsWith(target + ".previous-") ||
      !record.staging.startsWith(NodePath.resolve(this.options.cacheDir()) + NodePath.sep)
    )
      throw new Error("Invalid previous desktop install record.");
    await this.removeBundle(record.backup);
    await this.removeBundle(record.staging);
    await NodeFSP.rm(recordPath);
  }

  async checkForUpdates() {
    this.emit("checking-for-update");
    this.available = null;
    // Leftovers from the last install. The next check retries, so they never cost this one.
    await this.cleanAppliedInstall().catch((cause) => this.options.onCleanupFailure?.(cause));
    const feed =
      this.feed ??
      decodeFeed(
        Schema.decodeSync(fromYaml(Feed))(
          await NodeFSP.readFile(
            NodePath.join(this.options.resourcesDir(), "app-update.yml"),
            "utf8",
          ),
        ),
      );
    let baseUrl: string;
    let releaseNotes: string | undefined;
    let expectedVersion: string | undefined;
    if (feed.provider === "github") {
      if (!/^[\w.-]+$/.test(feed.owner) || !/^[\w.-]+$/.test(feed.repo))
        throw new Error("Invalid GitHub update repository.");
      let release: ReturnType<typeof decodeReleases>[number] | undefined;
      for (let page = 1; release === undefined; page++) {
        const releases = decodeReleases(
          await (
            await this.response(
              "https://api.github.com/repos/" +
                feed.owner +
                "/" +
                feed.repo +
                "/releases?per_page=100&page=" +
                page,
            )
          ).json(),
        );
        release = releases
          .filter((candidate) => {
            const version = candidate.tag_name.replace(/^v/, "");
            return (
              !candidate.draft &&
              candidate.tag_name.startsWith("v") &&
              RELEASE_VERSION.test(version) &&
              (this.allowPrerelease || !version.includes("-"))
            );
          })
          .sort((a, b) => compareSemverVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
        if (releases.length < 100) break;
      }
      if (!release) throw new Error("No desktop release is available on this channel.");
      expectedVersion = release.tag_name.slice(1);
      releaseNotes = release.body ?? undefined;
      baseUrl =
        "https://github.com/" +
        feed.owner +
        "/" +
        feed.repo +
        "/releases/download/" +
        release.tag_name +
        "/";
    } else {
      baseUrl = secureUrl(feed.url.replace(/\/?$/, "/")).href;
    }
    const channel = (
      expectedVersion !== undefined
        ? expectedVersion.includes("-nightly.")
        : this.channel === "nightly"
    )
      ? "nightly"
      : "latest";
    const manifest = decodeManifest(
      await (await this.response(baseUrl + channel + "-mac.yml")).text(),
    );
    if (expectedVersion !== undefined && manifest.version !== expectedVersion)
      throw new Error("Update manifest version does not match its release.");
    selectMacArchive(manifest, this.options.arch());
    const compared = compareSemverVersions(manifest.version, this.options.version());
    if (compared === 0 || (compared < 0 && !this.allowDowngrade)) {
      this.emit("update-not-available", { version: manifest.version });
      return;
    }
    this.available = { manifest, baseUrl };
    this.emit("update-available", {
      ...manifest,
      releaseNotes: releaseNotes ?? manifest.releaseNotes,
    });
  }

  async downloadUpdate() {
    const available = this.available;
    if (!available) throw new Error("Check for updates before downloading.");
    const file = selectMacArchive(available.manifest, this.options.arch());
    if (this.downloaded) {
      await this.removeBundle(this.downloaded.replacement);
      await this.removeBundle(this.downloaded.staging);
      this.downloaded = null;
    }
    const target = this.options.appBundle();
    if (!target.endsWith(".app")) throw new Error("Sail must run from an installed app bundle.");
    const cache = this.options.cacheDir();
    await NodeFSP.mkdir(cache, { recursive: true, mode: 0o700 });
    const staging = await NodeFSP.mkdtemp(NodePath.join(cache, "update-"));
    const replacement = target + ".update-" + NodeCrypto.randomUUID();
    try {
      // Stage beside the installed bundle before quitting, so permission and copy failures keep it running.
      await NodeFSP.mkdir(replacement, { mode: 0o700 });
      const response = await this.response(new URL(file.url, available.baseUrl).href);
      if (!response.body) throw new Error("The update archive is empty.");
      const archive = NodePath.join(staging, "update.zip");
      const hash = NodeCrypto.createHash("sha512");
      let bytes = 0;
      let milestone = -1;
      const output = await NodeFSP.open(archive, "wx", 0o600);
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > file.size) throw new Error("Update archive exceeds its expected size.");
          hash.update(chunk);
          await output.writeFile(chunk);
          const percent = Math.floor((bytes / file.size) * 100);
          if (Math.floor(percent / 10) !== milestone) {
            milestone = Math.floor(percent / 10);
            this.emit("download-progress", { percent });
          }
        }
      } finally {
        await output.close();
      }
      if (bytes !== file.size || hash.digest("base64") !== file.sha512)
        throw new Error("The update archive failed checksum verification.");
      const extracted = NodePath.join(staging, "extracted");
      await this.run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
      const bundles = (await NodeFSP.readdir(extracted)).filter((name) => name.endsWith(".app"));
      if (bundles.length !== 1) throw new Error("The update must contain one Sail app bundle.");
      const bundle = NodePath.join(extracted, bundles[0]!);
      const info = NodePath.join(bundle, "Contents", "Info.plist");
      const read = (key: string, plist: string) =>
        this.run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]);
      const [id, currentId, version, executable] = await Promise.all([
        read("CFBundleIdentifier", info),
        read("CFBundleIdentifier", NodePath.join(target, "Contents", "Info.plist")),
        read("CFBundleShortVersionString", info),
        read("CFBundleExecutable", info),
      ]);
      if (
        id !== currentId ||
        version !== available.manifest.version ||
        NodePath.basename(executable) !== executable
      )
        throw new Error("The downloaded bundle does not match this Sail installation.");
      await NodeFSP.access(NodePath.join(bundle, "Contents", "MacOS", executable), 1);
      await this.run("/usr/bin/ditto", [bundle, replacement]);
      await this.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", replacement]);
      this.downloaded = { replacement, staging, version };
      this.emit("update-downloaded", { version });
    } catch (error) {
      await this.removeBundle(replacement);
      await this.removeBundle(staging);
      throw error;
    }
  }

  async quitAndInstall(_silent = true, relaunch = true) {
    const download = this.downloaded;
    if (!download) throw new Error("No verified desktop update is ready.");
    const target = this.options.appBundle();
    const backup = target + ".previous-" + NodeCrypto.randomUUID();
    const script = NodePath.join(download.staging, "install.sh");
    await NodeFSP.copyFile(NodePath.join(this.options.resourcesDir(), "update-macos.sh"), script);
    await NodeFSP.writeFile(
      NodePath.join(this.options.cacheDir(), "pending-install.json"),
      JSON.stringify({
        version: download.version,
        target,
        backup,
        staging: download.staging,
      }),
      { mode: 0o600 },
    );
    const args = [
      String(this.options.runningPid),
      target,
      download.replacement,
      backup,
      String(relaunch),
    ];
    const log = NodePath.join(this.options.cacheDir(), "install.log");
    if (this.options.launchInstaller) {
      await this.options.launchInstaller(script, args, log);
    } else {
      const output = await NodeFSP.open(log, "a", 0o600);
      try {
        const child = NodeChildProcess.spawn("/bin/sh", [script, ...args], {
          detached: true,
          stdio: ["ignore", output.fd, output.fd],
          cwd: "/",
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
      } finally {
        await output.close();
      }
    }
    this.options.quit();
  }
}

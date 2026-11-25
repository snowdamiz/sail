// @effect-diagnostics nodeBuiltinImport:off - Fixtures exercise private app bundles and the real detached install script.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it, vi } from "vite-plus/test";
import { MacArchiveUpdater, selectMacArchive } from "./MacArchiveUpdater.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const payload = Buffer.from("a fixture macOS release archive");
const digest = NodeCrypto.createHash("sha512").update(payload).digest("base64");
const manifest = (version = "0.1.3") => ({
  version,
  files: ["arm64", "x64"].map((arch) => ({
    url: "Sail-" + version + "-" + arch + ".zip",
    sha512: digest,
    size: payload.length,
  })),
});
const helper = NodePath.resolve(import.meta.dirname, "../../resources/update-macos.sh");

async function bundle(path: string, version: string, id = "com.sail.desktop") {
  await NodeFSP.mkdir(NodePath.join(path, "Contents", "MacOS"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(path, "Contents", "Info.plist"),
    JSON.stringify({
      CFBundleIdentifier: id,
      CFBundleShortVersionString: version,
      CFBundleExecutable: "Sail",
    }),
  );
  await NodeFSP.writeFile(NodePath.join(path, "Contents", "MacOS", "Sail"), version, {
    mode: 0o755,
  });
}

async function fixture(
  options: {
    corrupt?: boolean;
    wrongIdentity?: boolean;
    paged?: boolean;
    releases?: ReadonlyArray<{ tag_name: string; body?: string }>;
  } = {},
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sail-updater-"));
  const app = NodePath.join(root, "User's Apps", "Sail.app");
  const cache = NodePath.join(root, "cache");
  const resources = NodePath.join(root, "resources");
  await bundle(app, "0.1.2");
  await NodeFSP.mkdir(resources);
  await NodeFSP.copyFile(helper, NodePath.join(resources, "update-macos.sh"));
  await NodeFSP.writeFile(
    NodePath.join(resources, "app-update.yml"),
    "provider: github\nowner: snowdamiz\nrepo: sail\n",
  );
  const requests: string[] = [];
  const quit = vi.fn();
  const backupPaths: string[] = [];
  let current = "0.1.2";
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/api.github.com/") || url.includes("api.github.com/"))
      return Response.json(
        options.paged && (new URL(url).searchParams.get("page") ?? "1") === "1"
          ? Array.from({ length: 100 }, (_, index) => ({ tag_name: "runtime-v" + index + ".0.0" }))
          : (options.releases ?? [
              { tag_name: "runtime-v9.0.0" },
              { tag_name: "v0.1.3", body: "Fixes" },
            ]),
      );
    if (url.endsWith(".yml")) {
      const version =
        options.releases?.find((release) => /^v\d/.test(release.tag_name))?.tag_name.slice(1) ??
        "0.1.3";
      return new Response(JSON.stringify(manifest(version)));
    }
    return new Response(options.corrupt ? Buffer.from("wrong bytes") : payload);
  };
  const updaterOptions = {
    version: () => current,
    arch: () => "arm64",
    appBundle: () => app,
    cacheDir: () => cache,
    resourcesDir: () => resources,
    runningPid: 2147483647,
    quit,
    fetch,
    run: async (command: string, args: ReadonlyArray<string>) => {
      if (command.endsWith("/ditto")) {
        if (args[0] === "-x") {
          await bundle(
            NodePath.join(args[3]!, "Sail.app"),
            "0.1.3",
            options.wrongIdentity ? "some.other.app" : "com.sail.desktop",
          );
        } else {
          await NodeFSP.cp(args[0]!, args[1]!, { recursive: true, preserveTimestamps: true });
        }
      } else if (command === "/bin/rm") {
        await execute(command, [...args]);
      } else if (command.endsWith("/plutil")) {
        const info = JSON.parse(await NodeFSP.readFile(args.at(-1)!, "utf8")) as Record<
          string,
          string
        >;
        return info[args[1]!]!;
      }
      return "";
    },
    launchInstaller: async (script: string, args: ReadonlyArray<string>) => {
      expect(quit).not.toHaveBeenCalled();
      expect(await NodeFSP.readFile(NodePath.join(app, "Contents", "MacOS", "Sail"), "utf8")).toBe(
        "0.1.2",
      );
      backupPaths.push(args[3]!);
      await execute("/bin/sh", [script, ...args.slice(0, 4), "false"]);
    },
  };
  return {
    root,
    app,
    cache,
    requests,
    quit,
    backupPaths,
    updaterOptions,
    updater: new MacArchiveUpdater(updaterOptions),
    setCurrent: (value: string) => {
      current = value;
    },
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("verifies and installs an unsigned app, retaining the previous bundle until the new version runs", async () => {
  await using f = await fixture();
  const available = vi.fn();
  const downloaded = vi.fn();
  f.updater.on("update-available", available);
  f.updater.on("update-downloaded", downloaded);
  await f.updater.checkForUpdates();
  expect(available).toHaveBeenCalledWith(
    expect.objectContaining({ version: "0.1.3", releaseNotes: "Fixes" }),
  );
  await f.updater.downloadUpdate();
  expect(downloaded).toHaveBeenCalledWith({ version: "0.1.3" });
  expect(f.requests.at(-1)).toBe(
    "https://github.com/snowdamiz/sail/releases/download/v0.1.3/Sail-0.1.3-arm64.zip",
  );
  expect(f.quit).not.toHaveBeenCalled();
  await f.updater.quitAndInstall();
  expect(f.quit).toHaveBeenCalledOnce();
  const executable = (path: string) => NodePath.join(path, "Contents", "MacOS", "Sail");
  expect(await NodeFSP.readFile(executable(f.app), "utf8")).toBe("0.1.3");
  expect(await NodeFSP.readFile(executable(f.backupPaths[0]!), "utf8")).toBe("0.1.2");
  f.setCurrent("0.1.3");
  await new MacArchiveUpdater(f.updaterOptions).checkForUpdates();
  await expect(NodeFSP.stat(f.backupPaths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("checks for updates even when a finished install cannot be cleaned up", async () => {
  await using f = await fixture();
  await NodeFSP.mkdir(f.cache, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(f.cache, "pending-install.json"), "{ invalid");
  const available = vi.fn();
  const onCleanupFailure = vi.fn();
  const updater = new MacArchiveUpdater({ ...f.updaterOptions, onCleanupFailure });
  updater.on("update-available", available);
  await updater.checkForUpdates();
  expect(available).toHaveBeenCalledOnce();
  expect(onCleanupFailure).toHaveBeenCalledOnce();
});

it.each([{ corrupt: true }, { wrongIdentity: true }])(
  "leaves the current app intact after invalid update bytes or identity: %j",
  async (options) => {
    await using f = await fixture(options);
    const downloaded = vi.fn();
    f.updater.on("update-downloaded", downloaded);
    await f.updater.checkForUpdates();
    await expect(f.updater.downloadUpdate()).rejects.toThrow();
    expect(downloaded).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
    expect(await NodeFSP.readFile(NodePath.join(f.app, "Contents", "MacOS", "Sail"), "utf8")).toBe(
      "0.1.2",
    );
    expect(
      (await NodeFSP.readdir(NodePath.dirname(f.app))).filter((name) => name.includes(".update-")),
    ).toEqual([]);
  },
);

it("follows a stable release's stable manifest when it supersedes a nightly", async () => {
  await using f = await fixture({
    releases: [
      { tag_name: "v0.1.4" },
      { tag_name: "v0.1.3-nightly.20261027.2" },
      { tag_name: "v8.0.0-preview.20261027.3" },
    ],
  });
  f.updater.allowPrerelease = true;
  f.updater.channel = "nightly";
  await f.updater.checkForUpdates();
  expect(f.requests.at(-1)).toBe(
    "https://github.com/snowdamiz/sail/releases/download/v0.1.4/latest-mac.yml",
  );
});

it("selects only the current architecture's named archive", () => {
  expect(selectMacArchive(manifest(), "x64").url).toBe("Sail-0.1.3-x64.zip");
  expect(() =>
    selectMacArchive(
      {
        ...manifest(),
        files: [{ ...manifest().files[0]!, url: "../Sail-0.1.3-arm64.zip" }],
      },
      "arm64",
    ),
  ).toThrow("no valid macOS archive");
});

it("follows versioned public downloads while rejecting unrelated paths", () => {
  const value = manifest();
  const files = value.files.map((file) => ({ ...file, url: "../../releases/v0.1.3/" + file.url }));
  expect(selectMacArchive({ ...value, files }, "arm64")).toMatchObject({
    url: "../../releases/v0.1.3/Sail-0.1.3-arm64.zip",
  });
});

it("restores the installed app if the replacement rename fails", async () => {
  await using f = await fixture();
  const replacement = f.app + ".replacement";
  const backup = f.app + ".backup";
  await bundle(replacement, "0.1.3");
  const bin = NodePath.join(f.root, "bin");
  await NodeFSP.mkdir(bin);
  await NodeFSP.writeFile(
    NodePath.join(bin, "mv"),
    '#!/bin/sh\n[ "$1" != "$FAIL_FROM" ] || exit 1\nexec /bin/mv "$@"\n',
    { mode: 0o755 },
  );
  await expect(
    execute("/bin/sh", [helper, "2147483647", f.app, replacement, backup, "false"], {
      env: {
        ...process.env,
        PATH: bin + NodePath.delimiter + process.env.PATH,
        FAIL_FROM: replacement,
      },
    }),
  ).rejects.toThrow();
  expect(await NodeFSP.readFile(NodePath.join(f.app, "Contents", "MacOS", "Sail"), "utf8")).toBe(
    "0.1.2",
  );
  await expect(NodeFSP.stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
});

it("finds the desktop release beyond a full page of runtime artifacts", async () => {
  await using f = await fixture({ paged: true });
  const available = vi.fn();
  f.updater.on("update-available", available);
  await f.updater.checkForUpdates();
  expect(available).toHaveBeenCalledWith(expect.objectContaining({ version: "0.1.3" }));
  expect(f.requests.some((url) => url.includes("page=2"))).toBe(true);
});

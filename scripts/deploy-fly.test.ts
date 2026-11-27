// @effect-diagnostics nodeBuiltinImport:off - Runs the deployment script with stub executables in a temporary directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const deploy = NodeURL.fileURLToPath(new URL("../deploy/fly/deploy.sh", import.meta.url));
const origin = "https://example-sail.localtest.me:14443";
const machineId = "123abcd";
const volumeId = "vol_local1";

const fixture = `
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [tool, ...args] = process.argv.slice(2);
appendFileSync("calls", JSON.stringify([tool, ...args]) + "\\n");
const output = (value) => console.log(JSON.stringify(value));
const option = (name) => args[args.indexOf(name) + 1];
const environmentId = "sail-test-environment";
const readSecrets = () => (existsSync("secrets") ? JSON.parse(readFileSync("secrets", "utf8")) : {});

if (tool === "curl") {
  if (args.at(-1) === "https://api.github.com/repos/snowdamiz/sail/releases/latest") {
    output({ previous: { tag_name: "v0.0.1" }, tag_name: "v1.2.3" });
  } else if (args.at(-1) === "${origin}/.well-known/t3/environment") {
    output({
      nested: { environmentId },
      environmentId: process.env.TEST_ENVIRONMENT_ID ?? environmentId,
    });
  } else if (args.at(-1) === "${origin}/api/auth/session") {
    output({
      authenticated: false,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
        ownerPassword: process.env.TEST_OWNER_PASSWORD_STATE ?? "unset",
      },
    });
  } else {
    process.exitCode = 97;
  }
} else {
  switch (args.slice(0, 2).join(" ")) {
    case "auth whoami":
      process.exitCode = process.env.TEST_SIGNED_OUT === "yes" ? 1 : 0;
      break;
    case "apps list":
      if (existsSync("app")) console.log("example-sail");
      break;
    case "apps create":
      writeFileSync("app", "", { flag: "wx" });
      break;
    case "volumes list":
      output(existsSync("volume") ? [JSON.parse(readFileSync("volume", "utf8"))] : []);
      break;
    case "volumes create":
      writeFileSync("volume", JSON.stringify({
        id: "${volumeId}",
        name: args[2],
        state: "created",
        region: option("--region"),
      }), { flag: "wx" });
      break;
    case "volumes snapshots":
      console.log("Snapshot requested.");
      break;
    case "secrets list": {
      const secrets = readSecrets();
      const keyName = process.env.TEST_LEGACY_SECRET_KEYS === "yes" ? "Name" : "name";
      output(Object.keys(secrets).map((name) => ({ [keyName]: name, digest: "deadbeef" })));
      break;
    }
    case "secrets import": {
      const secrets = readSecrets();
      const input = readFileSync(0, "utf8");
      for (const rawLine of input.split(/\\r?\\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) {
          process.exitCode = 95;
          break;
        }
        secrets[line.slice(0, eq)] = line.slice(eq + 1);
      }
      writeFileSync("secrets", JSON.stringify(secrets));
      break;
    }
    case "status --app":
      output({ AppURL: "${origin}" });
      break;
    case "machine list":
      console.log("${machineId}");
      break;
    case "ssh console": {
      const command = option("-C");
      if (option("--machine") !== "${machineId}" || option("--user") !== "sail") {
        process.exitCode = 98;
      } else if (command === "cat /data/sail/userdata/environment-id") {
        console.log(environmentId);
      } else if (command.startsWith("t3 auth pairing create --json --require-running ")) {
        const token = process.env.TEST_REPEAT_TOKEN === "yes"
          ? "repeated_fixture_credential"
          : randomBytes(24).toString("base64url");
        output({
          pairUrl: "${origin}/pair#token=" + token,
          ...(command.endsWith(" --qr") ? { qr: " ▀█\\n ▄█" } : {}),
        });
      } else {
        process.exitCode = 99;
      }
      break;
    }
    default:
      if (args[0] !== "deploy") process.exitCode = 96;
  }
}
`;

let directory: string;
beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sail-deploy-fly-"));
  NodeFS.writeFileSync(NodePath.join(directory, "fixture.mjs"), fixture);
  for (const tool of ["flyctl", "curl"]) {
    const wrapper = NodePath.join(directory, tool);
    NodeFS.writeFileSync(wrapper, `#!/bin/sh\nexec "$SAIL_TEST_NODE" ./fixture.mjs ${tool} "$@"\n`);
    NodeFS.chmodSync(wrapper, 0o755);
  }
  NodeFS.writeFileSync(NodePath.join(directory, "calls"), "");
});
afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

const calls = (): string[][] =>
  NodeFS.readFileSync(NodePath.join(directory, "calls"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const readStoredSecrets = (): Record<string, string> => {
  const secretsPath = NodePath.join(directory, "secrets");
  return NodeFS.existsSync(secretsPath)
    ? (JSON.parse(NodeFS.readFileSync(secretsPath, "utf8")) as Record<string, string>)
    : {};
};

const run = (args: string[], overrides?: NodeJS.ProcessEnv) =>
  NodeChildProcess.spawnSync(deploy, ["--app", "example-sail", ...args], {
    cwd: directory,
    env: {
      PATH: [directory, "/usr/bin", "/bin"].join(NodePath.delimiter),
      SAIL_TEST_NODE: process.execPath,
      ...overrides,
    },
    encoding: "utf8",
  });

const mutations = () =>
  calls().filter(
    ([tool, action, subcommand]) =>
      tool === "flyctl" &&
      (action === "deploy" ||
        ((action === "apps" || action === "volumes") && subcommand === "create")),
  );
const secretImports = () =>
  calls().filter(
    ([tool, action, subcommand]) =>
      tool === "flyctl" && action === "secrets" && subcommand === "import",
  );
const mints = () => calls().filter((call) => call.at(-1)?.startsWith("t3 auth pairing create"));

function readTokens(output: string) {
  const url = output.match(/^Sail URL: (https:\/\/\S+)$/m)?.[1];
  expect(url).toBe(origin);
  const desktop = output.match(/^Desktop link: (sail:\/\/\S+)$/m)?.[1];
  const browser = output.match(/^Browser or phone link: (https:\/\/\S+)$/m)?.[1];
  const desktopUrl = desktop && new URL(desktop).searchParams.get("pairingUrl");
  const urls = [desktopUrl, browser];
  expect(urls.every((item) => item?.startsWith(`${origin}/pair#token=`))).toBe(true);
  expect(output.includes(" ▀█\n ▄█")).toBe(true);
  return urls.map((item) => item?.split("#token=")[1]);
}

describe("deploy/fly/deploy.sh", () => {
  it("creates the app and volume once, stages an initial password once, and mints fresh links on both runs", () => {
    const first = run(["--image", "sail-server:test", "--region", "ord"]);
    expect(first.status, first.stderr).toBe(0);
    const firstTokens = readTokens(first.stdout);
    const initialPassword = first.stdout.match(/^Initial password: (\S+)$/m)?.[1];
    expect(initialPassword).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(readStoredSecrets().SAIL_INITIAL_OWNER_PASSWORD).toBe(initialPassword);
    expect(secretImports()).toEqual([
      ["flyctl", "secrets", "import", "--app", "example-sail", "--stage"],
    ]);
    expect(mutations().map((call) => call.slice(1, 3))).toEqual([
      ["apps", "create"],
      ["volumes", "create"],
      ["deploy", expect.any(String)],
    ]);

    const second = run(["--image", "sail-server:test"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).not.toContain("Initial password:");
    expect(secretImports()).toHaveLength(1);
    const tokens = [...firstTokens, ...readTokens(second.stdout)];
    expect(tokens.every((token) => Boolean(token))).toBe(true);
    expect(new Set(tokens).size).toBe(4);
    expect(mutations().slice(3)).toEqual([
      expect.arrayContaining(["deploy", "--primary-region", "ord", "--ha=false", "--local-only"]),
    ]);
    expect(mints()).toHaveLength(4);
  });

  it("stages a custom password from --password-file without printing it", () => {
    const passwordFile = NodePath.join(directory, "owner-password.txt");
    const customPassword = "my-custom-sail-password-12345";
    NodeFS.writeFileSync(passwordFile, `${customPassword}\n`);

    const result = run(["--image", "sail-server:test", "--password-file", passwordFile]);
    expect(result.status, result.stderr).toBe(0);
    readTokens(result.stdout);
    expect(result.stdout).not.toContain("Initial password:");
    expect(result.stdout).not.toContain(customPassword);
    expect(result.stderr).not.toContain(customPassword);
    expect(readStoredSecrets().SAIL_INITIAL_OWNER_PASSWORD).toBe(customPassword);
    expect(secretImports()).toHaveLength(1);
  });

  it("rejects short or multi-line --password-file before contacting Fly", () => {
    const shortFile = NodePath.join(directory, "short.txt");
    NodeFS.writeFileSync(shortFile, "too-short\n");
    const shortResult = run(["--image", "sail-server:test", "--password-file", shortFile]);
    expect(shortResult.status).toBe(1);
    expect(shortResult.stderr).toContain("15-256 characters");
    expect(calls()).toEqual([]);

    const multiLineFile = NodePath.join(directory, "multi.txt");
    NodeFS.writeFileSync(multiLineFile, "first-valid-password-line\nsecond-line\n");
    const multiResult = run(["--image", "sail-server:test", "--password-file", multiLineFile]);
    expect(multiResult.status).toBe(1);
    expect(multiResult.stderr).toContain("single line");
    expect(calls()).toEqual([]);
  });

  it("skips generating a password when upgrading an existing server with a configured password or legacy secret key", () => {
    NodeFS.writeFileSync(NodePath.join(directory, "app"), "");
    NodeFS.writeFileSync(
      NodePath.join(directory, "volume"),
      JSON.stringify({ id: volumeId, name: "sail_data", state: "created", region: "iad" }),
    );

    const configuredUpgrade = run(["--image", "sail-server:test"], {
      TEST_OWNER_PASSWORD_STATE: "configured",
    });
    expect(configuredUpgrade.status, configuredUpgrade.stderr).toBe(0);
    expect(configuredUpgrade.stdout).not.toContain("Initial password:");
    expect(secretImports()).toHaveLength(0);

    const unsetUpgrade = run(["--image", "sail-server:test"], {
      TEST_OWNER_PASSWORD_STATE: "unset",
    });
    expect(unsetUpgrade.status, unsetUpgrade.stderr).toBe(0);
    expect(unsetUpgrade.stdout).toMatch(/^Initial password: \S+$/m);
    expect(secretImports()).toHaveLength(1);

    const legacyListUpgrade = run(["--image", "sail-server:test"], {
      TEST_LEGACY_SECRET_KEYS: "yes",
    });
    expect(legacyListUpgrade.status, legacyListUpgrade.stderr).toBe(0);
    expect(legacyListUpgrade.stdout).not.toContain("Initial password:");
    expect(secretImports()).toHaveLength(1);
  });

  it("keeps pairing and snapshots separate from deployment", () => {
    expect(run(["--image", "sail-server:test"]).status).toBe(0);
    const pair = run(["--pair"]);
    expect(pair.status, pair.stderr).toBe(0);
    expect(pair.stdout).not.toContain("Initial password:");
    expect(new Set(readTokens(pair.stdout)).size).toBe(2);

    const snapshot = run(["--snapshot"]);
    expect(snapshot.status, snapshot.stderr).toBe(0);
    expect(snapshot.stdout).toBe("Snapshot requested.\n");
    expect(calls()).toContainEqual([
      "flyctl",
      "volumes",
      "snapshots",
      "create",
      volumeId,
      "--app",
      "example-sail",
    ]);
    expect(mutations()).toHaveLength(3);
    expect(mints()).toHaveLength(4);
  });

  it.each([{ args: [] }, { args: ["--build"] }, { args: ["--pair"] }, { args: ["--snapshot"] }])(
    "makes no external calls for --dry-run $args",
    ({ args }) => {
      const result = run(["--dry-run", ...args]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^Would /);
      expect(calls()).toEqual([]);
    },
  );

  it("does not mint or print links if the public and Machine environment IDs differ", () => {
    const result = run(["--pair"], { TEST_ENVIRONMENT_ID: "another-environment" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Public environment ID differs");
    expect(result.stdout).toBe("");
    expect(mints()).toHaveLength(0);
    expect(mutations()).toHaveLength(0);
  });

  it("rejects duplicate tokens before printing either link", () => {
    const result = run(["--pair"], { TEST_REPEAT_TOKEN: "yes" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("same token twice");
    expect(result.stdout).toBe("");
    expect(result.stderr.includes("repeated_fixture_credential")).toBe(false);
  });

  it("requires the existing volume's region before redeploying", () => {
    expect(run(["--image", "sail-server:test", "--region", "ord"]).status).toBe(0);
    const result = run(["--image", "sail-server:test", "--region", "iad"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The existing volume is in ord");
    expect(mutations()).toHaveLength(3);
    expect(mints()).toHaveLength(2);
  });

  it("maps a published GitHub release to the corresponding GHCR image tag", () => {
    const result = run([]);
    expect(result.status, result.stderr).toBe(0);
    expect(mutations().at(-1)).toEqual(
      expect.arrayContaining(["--image", "ghcr.io/snowdamiz/sail-server:1.2.3"]),
    );
  });

  it("uses Fly's remote builder for --build", () => {
    const result = run(["--build"]);
    expect(result.status, result.stderr).toBe(0);
    const deploy = mutations().at(-1);
    expect(deploy).toEqual(expect.arrayContaining(["--remote-only", "--dockerfile"]));
    expect(deploy).not.toContain("--image");
  });

  it("stops for Fly login before any mutation", () => {
    const result = run([], { TEST_SIGNED_OUT: "yes" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run fly auth login");
    expect(calls()).toEqual([["flyctl", "auth", "whoami"]]);
  });
});

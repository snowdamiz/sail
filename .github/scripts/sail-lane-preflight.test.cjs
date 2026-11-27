const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const workflow = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
const step = workflow.split("      - &require-private-lane-package\n")[1].split(/^      - /m)[0];
const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "");
const metadata = {
  name: "sail-server-lane",
  package_type: "container",
  owner: { login: "Snowdamiz" },
  visibility: "private",
};

test("the shared lane-only gate runs before both build and index publication", () => {
  assert.match(step, /if: needs\.prepare\.outputs\.lane == 'true'/);
  assert.match(step, /GH_TOKEN: \$\{\{ secrets\.SAIL_LANE_PACKAGE_READ_TOKEN \}\}/);
  assert.match(
    workflow,
    /      - \*require-private-lane-package\n      - uses: actions\/download-artifact/,
  );
  assert.ok(
    workflow.indexOf("&require-private-lane-package") <
      workflow.indexOf("name: Build and push by digest"),
  );
});

function run(
  payload,
  { ownerType = "User", expected = "user", token = "mock-read-token", fail = false } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "sail-lane-test-"));
  try {
    writeFileSync(
      join(directory, "gh"),
      `#!/bin/bash
set -eu
[[ "$#" == 2 && "$1" == api && "$2" == "$EXPECTED/packages/container/sail-server-lane" ]]
[[ "$GH_TOKEN" == mock-read-token ]]
printf '%s' "$MOCK_METADATA"
[[ "$MOCK_FAIL" == false ]]
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: directory + ":" + process.env.PATH,
        GH_TOKEN: token,
        GITHUB_REPOSITORY_OWNER: "Snowdamiz",
        OWNER_TYPE: ownerType,
        IMAGE: "ghcr.io/snowdamiz/sail-server-lane",
        EXPECTED: expected,
        MOCK_METADATA: typeof payload === "string" ? payload : JSON.stringify(payload),
        MOCK_FAIL: String(fail),
      },
    });
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, /mock-read-token/);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts authoritative private metadata from the exact user endpoint", () => {
  assert.equal(run(metadata).status, 0);
});
test("accepts authoritative private metadata from the exact organization endpoint", () => {
  assert.equal(run(metadata, { ownerType: "Organization", expected: "orgs/snowdamiz" }).status, 0);
});
for (const [name, payload, options] of [
  ["public", { ...metadata, visibility: "public" }],
  ["internal", { ...metadata, visibility: "internal" }],
  ["wrong owner", { ...metadata, owner: { login: "another-owner" } }],
  ["wrong type", { ...metadata, package_type: "npm" }],
  ["wrong name", { ...metadata, name: "sail-server" }],
  ["missing visibility", { ...metadata, visibility: undefined }],
  ["missing owner", { ...metadata, owner: undefined }],
  ["empty object", {}],
  ["array", [metadata]],
  ["malformed JSON", "not JSON"],
  ["empty response", ""],
  ["multiple JSON documents", JSON.stringify(metadata) + "\n" + JSON.stringify(metadata)],
  ["failed request despite valid output", metadata, { fail: true }],
  ["missing secret", metadata, { token: "" }],
  ["unknown owner type", metadata, { ownerType: "Bot" }],
]) {
  test("rejects " + name, () => {
    const result = run(payload, options);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::/);
  });
}

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const workflow = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
const resolveStep = workflow
  .split("      - name: Resolve release version\n")[1]
  .split(/^      - /m)[0];
const resolveScript = resolveStep.split("        run: |\n")[1].replace(/^ {10}/gm, "");

function resolve(version, { draft = "false", refType = "", refName = "" } = {}) {
  const result = spawnSync(
    "bash",
    ["-c", `git() { return 1; }\ngh() { return 0; }\n${resolveScript}`],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        REQUESTED_VERSION: version,
        REQUESTED_DRAFT: draft,
        GITHUB_REF_TYPE: refType,
        GITHUB_REF_NAME: refName,
        GITHUB_REPOSITORY_OWNER: "Snowdamiz",
        GITHUB_REPOSITORY: "Snowdamiz/sail",
        GITHUB_OUTPUT: "/dev/stdout",
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

test("stable tag releases use the regular server package", () => {
  assert.deepEqual(resolve("", { refType: "tag", refName: "v1.2.3" }), {
    version: "1.2.3",
    tag: "v1.2.3",
    lane: "false",
    draft: "false",
    prerelease: "false",
    image: "ghcr.io/snowdamiz/sail-server",
  });
});

test("regular prereleases still use the regular server package", () => {
  assert.deepEqual(resolve("v1.2.3-preview.20261127.1", { draft: "true" }), {
    version: "1.2.3-preview.20261127.1",
    tag: "v1.2.3-preview.20261127.1",
    lane: "false",
    draft: "true",
    prerelease: "true",
    image: "ghcr.io/snowdamiz/sail-server",
  });
});

test("lane releases use the disposable package and remain draft prereleases", () => {
  assert.deepEqual(resolve("v1.2.3-lane.w6.1"), {
    version: "1.2.3-lane.w6.1",
    tag: "v1.2.3-lane.w6.1",
    lane: "true",
    draft: "true",
    prerelease: "true",
    image: "ghcr.io/snowdamiz/sail-server-lane-v2",
  });
});

test("both image jobs publish the resolved package with the workflow token", () => {
  const build = workflow.split(/^  server-image-build:\n/m)[1].split(/^  server-image:\n/m)[0];
  const index = workflow.split(/^  server-image:\n/m)[1].split(/^  publish:\n/m)[0];
  for (const job of [build, index]) {
    assert.match(job, /packages: write/);
    assert.match(job, /password: \$\{\{ github\.token \}\}/);
  }
  assert.match(build, /outputs: type=image,name=\$\{\{ needs\.prepare\.outputs\.image \}\}/);
  assert.match(index, /IMAGE: \$\{\{ needs\.prepare\.outputs\.image \}\}/);
  assert.match(index, /--tag "\$IMAGE:\$VERSION" --tag "\$IMAGE:\$GITHUB_SHA"/);
  assert.match(
    index,
    /name: Verify anonymous pulls for regular releases\n\s+if: needs\.prepare\.outputs\.lane == 'false'/,
  );
});

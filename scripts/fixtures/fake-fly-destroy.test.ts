// @effect-diagnostics nodeBuiltinImport:off - Exercises the stand-in CLI with synthetic local state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const app = "synthetic-app";
const id = "synthetic-machine";

function withRecordedMachine(
  run: (fixture: {
    readonly record: string;
    readonly marker: string;
    readonly dockerCalls: string;
    readonly destroy: (force: boolean) => NodeChildProcess.SpawnSyncReturns<string>;
  }) => void,
): void {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-fly-destroy-"));
  try {
    const record = NodePath.join(root, "machines", `${id}.json`);
    const marker = NodePath.join(root, "apps", `${app}.json.route-repair`);
    const dockerCalls = NodePath.join(root, "docker-calls");
    NodeFS.mkdirSync(NodePath.dirname(record));
    NodeFS.mkdirSync(NodePath.dirname(marker));
    NodeFS.writeFileSync(record, JSON.stringify({ app, id }));
    NodeFS.writeFileSync(
      NodePath.join(root, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_FLY_HOME/docker-calls"\nprintf "No such container\\n" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    run({
      record,
      marker,
      dockerCalls,
      destroy: (force) =>
        NodeChildProcess.spawnSync(
          process.execPath,
          [
            NodePath.join(import.meta.dirname, "fake-fly", "fly.ts"),
            "machine",
            "destroy",
            id,
            ...(force ? ["--force"] : []),
          ],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              FAKE_FLY_HOME: root,
              FLY_APP: "",
              FLY_ACCESS_TOKEN: "",
              FLY_API_TOKEN: "",
              PATH: `${root}${NodePath.delimiter}${process.env.PATH ?? ""}`,
            },
          },
        ),
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

it.each([false, true])(
  "refuses machine destruction while route repair is pending (force=%s)",
  (force) => {
    withRecordedMachine(({ record, marker, dockerCalls, destroy }) => {
      const before = NodeFS.readFileSync(record, "utf8");
      NodeFS.writeFileSync(marker, "");
      expect(destroy(force)).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("unresolved route repair; refusing to destroy machine"),
      });
      expect(NodeFS.readFileSync(record, "utf8")).toBe(before);
      expect(NodeFS.existsSync(marker)).toBe(true);
      expect(NodeFS.existsSync(dockerCalls)).toBe(false);
    });
  },
);

it("removes a stopped machine record when no recovery is pending", () => {
  withRecordedMachine(({ record, marker, destroy }) => {
    expect(destroy(false)).toMatchObject({
      status: 0,
      stdout: expect.stringContaining(`${id} has been destroyed`),
    });
    expect(NodeFS.existsSync(record)).toBe(false);
    expect(NodeFS.existsSync(marker)).toBe(false);
  });
});

import * as SecureRandom from "effect/crypto/SecureRandom";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  docker,
  dockerSucceeds,
  DOCKER_TEST_TIMEOUT_MS,
  FIXTURE_LABEL,
  hasDocker,
  stopDockerContainer,
} from "./docker.ts";

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Docker work on the VM every lane shares.
vi.setConfig({ testTimeout: DOCKER_TEST_TIMEOUT_MS });

async function withSlowContainer(delay: number, run: (id: string) => void): Promise<void> {
  const name = `sail-stop-test-${SecureRandom.uuidV4Unsafe()}`;
  let id: string | undefined;
  try {
    id = docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `${FIXTURE_LABEL}=docker-test`,
      "--memory",
      "64m",
      "caddy:2",
      "sh",
      "-c",
      `trap "sleep ${delay}; exit 0" TERM; touch /tmp/ready; while :; do sleep 1; done`,
    ]).trim();
    const started = id;
    await expect
      .poll(() => dockerSucceeds(["exec", started, "test", "-f", "/tmp/ready"]), {
        timeout: 120_000,
      })
      .toBe(true);
    run(started);
  } finally {
    const owned =
      id ??
      (dockerSucceeds(["container", "inspect", name])
        ? docker(["container", "inspect", "--format", "{{.Id}}", name]).trim()
        : undefined);
    if (owned) docker(["rm", "--force", "--volumes", owned]);
  }
}

describe.skipIf(!hasDocker())("stopping a fixture container", () => {
  it("waits for a slow stop after the Docker CLI times out", () =>
    withSlowContainer(10, (id) => {
      stopDockerContainer(id, ["--time", "20"], 5_000);
      expect(docker(["inspect", "--format", "{{.State.Status}}", id]).trim()).toBe("exited");
    }));

  it("reports a timed-out stop if the container is still running after the wait", () =>
    withSlowContainer(60, (id) => {
      expect(() => stopDockerContainer(id, ["--time", "90"], 5_000, 1_000)).toThrow(/ETIMEDOUT/);
      expect(docker(["inspect", "--format", "{{.State.Running}}", id]).trim()).toBe("true");
    }));

  it("propagates an actual Docker failure", () => {
    expect(() =>
      stopDockerContainer("sail-no-such-test-container", ["--time", "1"], 30_000),
    ).toThrow(/No such container/i);
  });
});

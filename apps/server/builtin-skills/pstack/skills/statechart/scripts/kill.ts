import * as NodeChildProcess from "node:child_process";

export const killGroup = (pid: number) =>
  new Promise<void>((resolve) => {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone vendored CLI script
    if (process.platform === "win32") {
      NodeChildProcess.spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" })
        .on("error", () => resolve())
        .on("exit", () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    resolve();
  });

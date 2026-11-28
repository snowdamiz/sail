import * as NodeFS from "node:fs";
import * as NodeStreamPromises from "node:stream/promises";
import { killGroup } from "./kill.ts";

const [pid, ...dirs] = process.argv.slice(2);

let input = "";
process.stdin.setEncoding("utf8").on("data", (chunk: string) => (input += chunk));
await NodeStreamPromises.finished(process.stdin).catch(() => {});
const running = !input.includes("exited");
// oxlint-disable-next-line t3code/no-global-process-runtime -- standalone vendored CLI script
const groupOutlivesWorker = process.platform !== "win32";
if (running || groupOutlivesWorker) await killGroup(Number(pid));
for (const dir of dirs) NodeFS.rmSync(dir, { recursive: true, force: true });

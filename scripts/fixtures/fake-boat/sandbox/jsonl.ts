// @effect-diagnostics nodeBuiltinImport:off - Newline-delimited JSON over stdio for the plain Node fake CLIs.
import * as NodeReadline from "node:readline";

export type JsonObject = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function serveJsonLines(
  answer: (message: JsonObject) => ReadonlyArray<JsonObject>,
): Promise<void> {
  const lines = NodeReadline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const message: unknown = JSON.parse(line);
    if (!isObject(message)) throw new Error(`expected a JSON object, got ${line}`);
    for (const reply of answer(message)) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
}

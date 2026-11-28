import * as NodeBuffer from "node:buffer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { checkView } from "./frontends/view.ts";
import { compile } from "./pipeline.ts";
import { check, messageOf } from "./run.ts";

const [stage, specFile, configFile, viewFile] = process.argv.slice(2);

try {
  const view = checkView(
    viewFile ? await import(NodeURL.pathToFileURL(NodePath.resolve(viewFile)).href) : {},
    NodeUtil.inspect,
  );
  const { files, exit } = compile(await check(specFile, configFile), view);
  const draft = NodePath.join(stage, "draft");
  NodeFS.mkdirSync(draft);
  for (const [name, parts] of files) {
    const fd = NodeFS.openSync(NodePath.join(draft, name), "wx");
    try {
      for (const part of parts)
        NodeFS.writeSync(fd, typeof part === "string" ? NodeBuffer.Buffer.from(part) : part);
      NodeFS.writeSync(fd, "\n");
    } finally {
      NodeFS.closeSync(fd);
    }
  }
  NodeFS.renameSync(draft, NodePath.join(stage, "done"));
  process.exit(exit);
} catch (error) {
  console.error(messageOf(error));
  process.exit(2);
}

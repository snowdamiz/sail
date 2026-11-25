// @effect-diagnostics extendsNativeError:off - The command table shared by the plain Node fake CLIs, in the sandbox and on this computer.

export type FlagKind = "boolean" | "string";

/** One row of a fake CLI's command table. Path words match literally, so `--version` can be one. */
export interface CommandSpec {
  readonly path: ReadonlyArray<string>;
  readonly args?: ReadonlyArray<string>;
  readonly flags?: Readonly<Record<string, FlagKind>>;
  /** Takes the argv after `--`. */
  readonly rest?: boolean;
}

export interface Invocation<C extends CommandSpec> {
  readonly command: C;
  readonly args: Readonly<Record<string, string>>;
  readonly flags: ReadonlyMap<string, string | true>;
  readonly rest: ReadonlyArray<string>;
  readonly global: ReadonlySet<string>;
}

export type UsageCode = "unknown_command" | "unknown_flag" | "invalid_arguments";

export class UsageError extends Error {
  readonly code: UsageCode;
  constructor(code: UsageCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Global flags may sit anywhere before `--`; everything after `--` belongs to the command. The
 * longest matching path wins, so `snapshot rm <name>` is not read as `snapshot <id> <name>`.
 */
export function parse<C extends CommandSpec>(
  table: ReadonlyArray<C>,
  argv: ReadonlyArray<string>,
  globalFlags: ReadonlyArray<string> = [],
): Invocation<C> {
  const dash = argv.indexOf("--");
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const rest = dash === -1 ? [] : argv.slice(dash + 1);
  const global = new Set(head.filter((token) => globalFlags.includes(token)));
  const tokens = head.filter((token) => !globalFlags.includes(token));
  const command = table
    .filter((entry) => entry.path.every((word, index) => tokens[index] === word))
    .toSorted((a, b) => b.path.length - a.path.length)[0];
  if (!command) {
    throw new UsageError("unknown_command", `unknown command: ${tokens.join(" ") || "(none)"}`);
  }
  const name = command.path.join(" ");
  const positionals: Array<string> = [];
  const flags = new Map<string, string | true>();
  for (let index = command.path.length; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const flag = token.slice(2);
    const kind = command.flags?.[flag];
    if (kind === undefined)
      throw new UsageError("unknown_flag", `unknown flag ${token} for ${name}`);
    if (kind === "boolean") {
      flags.set(flag, true);
      continue;
    }
    const value = tokens[++index];
    if (value === undefined) throw new UsageError("invalid_arguments", `${token} needs a value`);
    flags.set(flag, value);
  }
  const names = command.args ?? [];
  if (positionals.length !== names.length) {
    const usage = [name, ...names.map((arg) => `<${arg}>`)].join(" ");
    throw new UsageError("invalid_arguments", `usage: ${usage}`);
  }
  if (dash !== -1 && !command.rest) {
    throw new UsageError("invalid_arguments", `${name} takes no arguments after --`);
  }
  const args = Object.fromEntries(names.map((arg, index) => [arg, positionals[index] ?? ""]));
  return { command, args, flags, rest, global };
}

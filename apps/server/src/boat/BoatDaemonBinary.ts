import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class BoatDaemonBinaryNotFound extends Schema.TaggedError<BoatDaemonBinaryNotFound>()(
  "BoatDaemonBinaryNotFound",
  { candidates: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return "sail-boatd was not found. Build it with `cargo build --release --manifest-path native/sail-boat/Cargo.toml`, or set SAIL_BOATD_PATH.";
  }
}

export class BoatDaemonBinaryNotExecutable extends Schema.TaggedError<BoatDaemonBinaryNotExecutable>()(
  "BoatDaemonBinaryNotExecutable",
  { path: Schema.String, mode: Schema.Number },
) {
  override get message(): string {
    return `sail-boatd at '${this.path}' is not executable.`;
  }
}

export type BoatDaemonBinaryError = BoatDaemonBinaryNotFound | BoatDaemonBinaryNotExecutable;

export class BoatDaemonBinary extends Context.Service<
  BoatDaemonBinary,
  { readonly resolve: Effect.Effect<string, BoatDaemonBinaryError> }
>()("t3/boat/BoatDaemonBinary") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const executableName = platform === "win32" ? "sail-boatd.exe" : "sail-boatd";
  const override = environment.SAIL_BOATD_PATH?.trim();
  // A repo checkout runs the server from src/boat or from dist, two and three levels below the repo.
  const repoCandidates = [
    path.resolve(import.meta.dirname, "../../../../native/sail-boat"),
    path.resolve(import.meta.dirname, "../../../native/sail-boat"),
  ].flatMap((crate) =>
    ["release", "debug"].map((profile) => path.join(crate, "target", profile, executableName)),
  );
  const candidates = override ? [override, ...repoCandidates] : repoCandidates;

  const resolve: BoatDaemonBinary["Service"]["resolve"] = Effect.gen(function* () {
    for (const candidate of candidates) {
      const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
      if (Option.isNone(stat)) continue;
      // Windows has no exec bit, so a directory would otherwise pass until spawn.
      if (
        stat.value.type === "Directory" ||
        (platform !== "win32" && (stat.value.mode & 0o111) === 0)
      ) {
        return yield* new BoatDaemonBinaryNotExecutable({
          path: candidate,
          mode: stat.value.mode,
        });
      }
      return candidate;
    }
    return yield* new BoatDaemonBinaryNotFound({ candidates });
  });

  return BoatDaemonBinary.of({ resolve });
});

export const layer = Layer.effect(BoatDaemonBinary, make);

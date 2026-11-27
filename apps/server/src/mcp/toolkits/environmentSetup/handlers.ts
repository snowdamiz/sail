import {
  EnvironmentSetupBundle,
  OrchestratorMcpFailure,
  type EnvironmentSetupError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EnvironmentSetupTransfer from "../../../environmentSetup/EnvironmentSetupTransfer.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { EnvironmentSetupToolkit } from "./tools.ts";

const copyFailure = (error: EnvironmentSetupError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const decodeBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(EnvironmentSetupBundle));
const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const layer = McpToolAccess.toLayer(EnvironmentSetupToolkit, {
  t3_environment_setup_export: McpToolAccess.writesEnvironment((_input, check) =>
    Effect.gen(function* () {
      const transfer = yield* EnvironmentSetupTransfer.EnvironmentSetupTransfer;
      return yield* transfer
        .export(check)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "EnvironmentSetupError" ? copyFailure(error) : error,
          ),
        );
    }),
  ),
  t3_environment_setup_import: McpToolAccess.writesEnvironment(
    ({ action, bundleJson, revision }, check) =>
      Effect.gen(function* () {
        const transfer = yield* EnvironmentSetupTransfer.EnvironmentSetupTransfer;
        if (action === "apply" && revision === undefined) {
          return yield* invalidRequest("Give the preview revision to apply the copy.");
        }
        const bundle = yield* decodeBundle(bundleJson).pipe(
          Effect.mapError(() => invalidRequest("Give the exported setup bundle as JSON text.")),
        );
        const input =
          action === "apply" && revision !== undefined
            ? { action, bundle, revision }
            : { action: "preview" as const, bundle };
        return yield* transfer
          .import(input, check)
          .pipe(
            Effect.mapError((error) =>
              error._tag === "EnvironmentSetupError" ? copyFailure(error) : error,
            ),
          );
      }),
  ),
});

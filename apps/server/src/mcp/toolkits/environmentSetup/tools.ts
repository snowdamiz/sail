import {
  EnvironmentSetupBundle,
  MAX_ENVIRONMENT_SETUP_BYTES,
  EnvironmentSetupPreview,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as EnvironmentSetupTransfer from "../../../environmentSetup/EnvironmentSetupTransfer.ts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    EnvironmentSetupTransfer.EnvironmentSetupTransfer,
  ],
};

const ExportTool = Tool.make("t3_environment_setup_export", {
  ...shared,
  description:
    "Export this environment's portable setup when the user asks to copy it. The bundle includes provider definitions, shortcuts, themes, and user skill files. Local credentials and machine-specific configuration are excluded. Requires full access.",
  success: EnvironmentSetupBundle,
}).annotate(Tool.Readonly, true);

const ImportTool = Tool.make("t3_environment_setup_import", {
  ...shared,
  description:
    "Preview a setup bundle here. Give the export bundle as JSON text. Apply only after the user confirms the target and preview, using the same bundle and preview revision. Requires full access.",
  parameters: Schema.Struct({
    action: Schema.Literals(["preview", "apply"]),
    bundleJson: Schema.String.check(Schema.isMaxLength(MAX_ENVIRONMENT_SETUP_BYTES)),
    revision: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  }),
  success: EnvironmentSetupPreview,
}).annotate(Tool.Destructive, true);

export const EnvironmentSetupToolkit = Toolkit.make(ExportTool, ImportTool);

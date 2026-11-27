import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import { withAdmission } from "../serverAdmission.ts";

export function admitCommand(command: OrchestrationV2ServerCommand) {
  // Only commands that settle a named owner can enter independently during drain.
  switch (command.type) {
    case "runtime-request.respond":
    case "runtime-request.delivery.fail":
    case "thread.user-input.dismiss":
    case "run.interrupt":
    case "thread.interrupt.unresponsive":
    case "thread.stop":
    case "subagent.stop":
    case "queued-run.cancel":
    case "run.output.submit":
    case "checkpoint.rollback.fail":
    case "thread.background-work.settle":
    case "delegated_task.remote.complete":
    case "delegated_task.remote.stop":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
      return withAdmission("continuation");
    default:
      return withAdmission("root");
  }
}

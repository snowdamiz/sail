import { AuthOrchestrationReadScope } from "@t3tools/contracts";

import { boatsEnvironment } from "~/state/boats";
import { useLocalEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";

/** Toasts this server's Boat notices on every page; `boatsEnvironment` raises each toast. */
export function BoatNoticeToasts() {
  const environmentId = useLocalEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  useEnvironmentQuery(
    environmentId !== null && canRead
      ? boatsEnvironment.notices({ environmentId, input: {} })
      : null,
  );
  return null;
}

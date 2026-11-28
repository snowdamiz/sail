import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  SessionTransferThreadDestination,
  SessionTransferThreadOrigin,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg, T, Var } from "gt-react";
import { ArrowRightLeftIcon, ExternalLinkIcon } from "lucide-react";

import { m } from "../i18n/messages";
import { useEnvironment } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { useOpenTransferredThread } from "./SessionTransferToasts";
import { Button } from "./ui/button";

export function SessionTransferBanner(props: {
  readonly transferredTo: SessionTransferThreadDestination | null;
  readonly transferOrigin: SessionTransferThreadOrigin | null;
}) {
  const { transferredTo, transferOrigin } = props;
  const router = useRouter();
  const openTransferredThread = useOpenTransferredThread();
  const targetEnvironment = useEnvironment(transferredTo?.environmentId ?? null);
  const originEnvironment = useEnvironment(transferOrigin?.environmentId ?? null);

  if (transferredTo !== null) {
    const targetLabel =
      transferredTo.environmentName ??
      targetEnvironment?.label ??
      transferredTo.machineId ??
      m(msg("Local"));

    return (
      <div
        role="status"
        data-testid="session-transfer-banner-destination"
        className="flex items-center justify-between gap-3 border-b border-border/70 bg-muted/45 px-4 py-2 text-xs text-foreground"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ArrowRightLeftIcon aria-hidden className="size-3.5 shrink-0 text-info-foreground" />
          <span className="truncate font-medium">
            <T>
              Moved to <Var>{targetLabel}</Var>
            </T>
          </span>
        </div>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void openTransferredThread({
              environmentId: transferredTo.environmentId,
              threadId: transferredTo.threadId,
              machineId: transferredTo.machineId,
            });
          }}
        >
          <ExternalLinkIcon aria-hidden className="size-3" />
          <T>Open session</T>
        </Button>
      </div>
    );
  }

  if (transferOrigin !== null) {
    const sourceLabel =
      transferOrigin.environmentName ??
      originEnvironment?.label ??
      transferOrigin.machineId ??
      m(msg("Local"));

    return (
      <div
        role="status"
        data-testid="session-transfer-banner-origin"
        className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ArrowRightLeftIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            <T>
              Moved from <Var>{sourceLabel}</Var>
            </T>
          </span>
        </div>
        {originEnvironment !== null ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              void router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(transferOrigin.environmentId, transferOrigin.threadId),
                ),
              });
            }}
          >
            <T>View original</T>
          </Button>
        ) : null}
      </div>
    );
  }

  return null;
}

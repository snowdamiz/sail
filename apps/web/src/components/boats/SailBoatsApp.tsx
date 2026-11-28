import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { environmentSupportsLocalSessions, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { AlertTriangleIcon, ServerIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import {
  boatCommandsAllowedAtom,
  boatServerChoicesAtom,
  boatServerIdAtom,
  boatServerSelectionAtom,
} from "~/state/boats";
import { clientHostEnvironmentAtom } from "~/state/clientHostEnvironment";
import { serverEnvironment } from "~/state/server";
import { SettingsGroup } from "../settings/SettingsGroup";
import { ITEM_ROW_CLASSNAME } from "../settings/itemRows";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { BoatAccessContext, type BoatAccess } from "./access";
import { useBoatsPage, useFollowBoatLink } from "./api";
import {
  BoatsFrame,
  type Notice,
  type Notify,
  type ServerSelection,
} from "./components/BoatsFrame";
import { ReadyBoatsView } from "./components/ReadyBoatsView";
import { SetupBody } from "./components/SetupView";
import { useIsMountedRef } from "./components/common";
import { errorText } from "./reply";

function StartingSkeleton() {
  const gt = useGT();
  return (
    <section className="space-y-2.5">
      <div className="px-3 sm:px-4" aria-hidden="true">
        <Skeleton className="h-5 w-24" />
      </div>
      <SettingsGroup divided={false}>
        <div
          role="status"
          aria-label={gt("Starting Sail Boats")}
          className="divide-y divide-border/50"
        >
          {["first", "second"].map((slot) => (
            <div
              key={slot}
              className={`${ITEM_ROW_CLASSNAME} flex items-center justify-between gap-4`}
              aria-hidden="true"
            >
              <div className="flex items-center gap-3">
                <Skeleton shape="pill" className="size-2.5" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-44" />
                </div>
              </div>
              <Skeleton shape="card" className="h-6 w-20" />
            </div>
          ))}
        </div>
      </SettingsGroup>
    </section>
  );
}

export function SailBoatsApp() {
  const environmentId = useAtomValue(boatServerIdAtom);
  return <BoatsForServer key={environmentId ?? "none"} environmentId={environmentId} />;
}

function BoatsForServer({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const gt = useGT();
  const { page, retry } = useBoatsPage(environmentId);
  const allowed = useAtomValue(boatCommandsAllowedAtom(environmentId));
  const onHost = useAtomValue(clientHostEnvironmentAtom(environmentId));
  const { entries } = useAtomValue(environmentCatalog.catalogValueAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supportsLocalProjects = environmentSupportsLocalSessions(serverConfig);
  const selectServer = useAtomSet(boatServerSelectionAtom);
  const servers = useAtomValue(boatServerChoicesAtom);

  const access: BoatAccess = {
    environmentId,
    can: (command) => allowed.has(command),
    isPaired: (id) => {
      const entry = id === null ? undefined : entries.get(id);
      return entry?.enabled === true && entry.unsupportedReason === undefined;
    },
    onHost,
  };

  const follow = useFollowBoatLink(onHost);
  const [notice, setNotice] = useState<Notice | null>(null);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useIsMountedRef();

  const notify: Notify = (text, tone = "error") => {
    if (!mountedRef.current) return;
    setNotice({ text, tone });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setNotice(null), 5000);
  };

  const dismissNotice = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setNotice(null);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the notice auto-dismiss timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const server: ServerSelection = {
    selected: environmentId,
    choices: servers.map(({ target }) => ({
      value: target.environmentId,
      label: target.label,
    })),
    select: selectServer,
  };

  return (
    <BoatAccessContext value={access}>
      {page.kind === "ready" ? (
        <ReadyBoatsView
          state={page.state}
          supportsLocalProjects={supportsLocalProjects}
          follow={follow}
          notify={notify}
          server={server}
          notice={notice}
          dismissNotice={dismissNotice}
        />
      ) : page.kind === "setup" ? (
        <SetupBody
          state={page.state}
          follow={follow}
          notify={notify}
          server={server}
          notice={notice}
          dismissNotice={dismissNotice}
        />
      ) : page.kind === "noServer" ? (
        <BoatsFrame back={null} server={server} notice={notice} dismissNotice={dismissNotice}>
          <SettingsGroup divided={false}>
            <Empty size="compact">
              <EmptyMedia variant="icon">
                <ServerIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>
                  <h1>{gt("Boats isn't available here")}</h1>
                </EmptyTitle>
                <EmptyDescription>
                  {gt(
                    "Connect to the server that manages your Boat machines, then choose it here.",
                  )}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </SettingsGroup>
        </BoatsFrame>
      ) : page.kind === "offline" ? (
        <BoatsFrame back={null} server={server} notice={notice} dismissNotice={dismissNotice}>
          <div className="mx-auto w-full max-w-xl space-y-4 pt-4 sm:pt-8">
            <div className="space-y-1 px-1">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                {gt("Boat daemon offline")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {gt("Sail could not reach the Boat daemon on this server.")}
              </p>
            </div>
            <SettingsGroup divided={false}>
              <div className="space-y-4 p-4 sm:p-5">
                <Alert variant="error">
                  <AlertTriangleIcon aria-hidden="true" />
                  <AlertDescription>{page.message}</AlertDescription>
                </Alert>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void retry().catch((error) => {
                        if (mountedRef.current) notify(errorText(error));
                      })
                    }
                  >
                    {gt("Retry")}
                  </Button>
                </div>
              </div>
            </SettingsGroup>
          </div>
        </BoatsFrame>
      ) : (
        <BoatsFrame
          breadcrumbHeading
          back={null}
          server={server}
          notice={notice}
          dismissNotice={dismissNotice}
        >
          <StartingSkeleton />
        </BoatsFrame>
      )}
    </BoatAccessContext>
  );
}

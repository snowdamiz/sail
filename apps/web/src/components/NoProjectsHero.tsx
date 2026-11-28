import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { environmentSupportsLocalSessions } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { SailBrandMark } from "./SailBrandMark";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const gt = useGT();
  const contentArea = workspaceAreaProps("home", 1, gt("Home"));
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);
  const hasSessionHost = environments.some((environment) =>
    canCreateProjectInEnvironment(environment.connection.phase, environment.serverConfig),
  );
  const hasControlPlane = environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      !environmentSupportsLocalSessions(environment.serverConfig),
  );
  const needsBoat = !hasSessionHost && hasControlPlane;

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>
                {needsBoat ? <T>Connect a Boat to start</T> : <T>What should we work on?</T>}
              </EmptyTitle>
              <EmptyDescription>
                {needsBoat
                  ? gt(
                      "This server manages Boats and synced settings. Launch or connect a Boat machine to run sessions.",
                    )
                  : scratchTargetEnvironmentId === null
                    ? gt("Add a project to start your first thread.")
                    : gt("Add a project, or start without one.")}
              </EmptyDescription>
              <div className="mt-6 flex justify-center gap-2">
                {needsBoat ? (
                  <>
                    <Button size="sm" render={<Link to="/boats" />}>
                      <SailBrandMark className="size-4" aria-hidden="true" />
                      <T>Open Boats</T>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      render={<Link to="/settings/connections" />}
                    >
                      <T>Connect a computer</T>
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
                      <PlusIcon className="size-4" />
                      <T>Add project</T>
                    </Button>
                    {scratchTargetEnvironmentId === null ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
                      >
                        <MessageSquareDashedIcon className="size-4" />
                        <T>Start without a project</T>
                      </Button>
                    )}
                  </>
                )}
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

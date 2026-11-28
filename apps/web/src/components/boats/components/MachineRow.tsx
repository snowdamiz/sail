import { T, Var, useGT, useMessages } from "gt-react";
import { FolderPlusIcon, ServerIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ConnectionStatusDot } from "../../ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME } from "../../settings/itemRows";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { MACHINE_STATUS, hourly, machineKey } from "../machine";
import type { MachineView, Size } from "../types";
import { AgentName, AgentNames } from "./AgentLogos";
import {
  DeleteErrorAlert,
  MachineActionButton,
  MachineMenu,
  type MachineControls,
} from "./MachineActions";
import { useDetail } from "./common";

export function MachineRow({
  machine,
  size,
  controls,
  onOpen,
  onPickProject,
}: {
  readonly machine: MachineView;
  readonly size: Size | undefined;
  readonly controls: MachineControls;
  readonly onOpen: () => void;
  readonly onPickProject: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const key = machineKey(machine);
  const status = MACHINE_STATUS[machine.state];
  const detail = useDetail(machine);
  const cloning = machine.projects.filter((project) => project.status);
  const showSignedOut = Boolean(machine.id && machine.signedOut.length > 0);
  const showNeedsProject = !showSignedOut && controls.needsProject;
  const hasSubRows =
    controls.deleteRefusal !== null || showSignedOut || showNeedsProject || cloning.length > 0;

  return (
    <li className={cn(ITEM_ROW_CLASSNAME, "space-y-2.5")}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 sm:flex-nowrap">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
            <ServerIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            <span className="absolute -right-1 -bottom-1 rounded-full bg-card p-0.5">
              <ConnectionStatusDot dotClassName={status.dotClassName} />
            </span>
          </div>

          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {controls.canOpen ? (
                <button
                  type="button"
                  aria-label={gt("Details for {name}", { name: machine.name })}
                  onClick={onOpen}
                  className="max-w-full cursor-pointer truncate rounded-xs text-left text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {machine.name}
                </button>
              ) : (
                <span className="max-w-full truncate text-sm font-medium text-foreground">
                  {machine.name}
                </span>
              )}
              <Badge size="sm" variant={status.badgeVariant}>
                {messages(status.label)}
              </Badge>
              <Badge size="sm" variant="secondary">
                <span className="font-mono">{machine.size}</span>
              </Badge>
              {size ? (
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {hourly(size.hourly)}
                </span>
              ) : null}
            </div>
            {detail ? (
              <Tooltip>
                <TooltipTrigger render={<p className="truncate text-xs text-muted-foreground" />}>
                  {detail}
                </TooltipTrigger>
                <TooltipPopup>{detail}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <MachineActionButton
            targetKey={key}
            control={controls.rowPrimary}
            onRequest={controls.request}
            pendingLabel={controls.pending?.label ?? null}
            size="xs"
          />
          {machine.id &&
          !controls.busy &&
          (controls.menuItems.length > 0 || controls.rowPrimary?.kind !== "armDelete") ? (
            <MachineMenu
              targetKey={key}
              machineName={machine.name}
              controls={controls}
              onPickProject={onPickProject}
            />
          ) : null}
        </div>
      </div>

      {hasSubRows ? (
        <div className="space-y-2 sm:pl-12">
          <DeleteErrorAlert controls={controls} />

          {showSignedOut ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
              <span className="text-warning-foreground">
                {machine.signedOut.length === 1 ? (
                  <T>
                    <Var>
                      <AgentNames names={machine.signedOut} />
                    </Var>{" "}
                    needs a sign-in
                  </T>
                ) : (
                  <T>
                    <Var>
                      <AgentNames names={machine.signedOut} />
                    </Var>{" "}
                    need a sign-in
                  </T>
                )}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {machine.signedOut.map((agent) => {
                  const signInControl = controls.signInAgentControl(agent);
                  return (
                    <Button
                      key={agent}
                      size="xs"
                      variant="outline"
                      disabled={signInControl.disabled}
                      onClick={() =>
                        controls.request({ kind: "run", action: signInControl.action })
                      }
                    >
                      {machine.signedOut.length > 1 ? <AgentName name={agent} /> : gt("Sign in")}
                    </Button>
                  );
                })}
              </div>
            </div>
          ) : showNeedsProject ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <FolderPlusIcon aria-hidden="true" className="size-3.5" />
                {gt("No projects yet")}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={!controls.canAddProject}
                onClick={onPickProject}
              >
                {gt("Add one")}
              </Button>
            </div>
          ) : null}

          {cloning.map((project) => (
            <Tooltip key={project.id}>
              <TooltipTrigger
                render={<div className="flex items-center gap-2 text-xs text-muted-foreground" />}
              >
                <Spinner aria-hidden="true" size="xs" tone="muted" />
                <span className="truncate">
                  {project.title} · {project.status}
                </span>
              </TooltipTrigger>
              <TooltipPopup>
                {project.title} · {project.status}
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
      ) : null}
    </li>
  );
}

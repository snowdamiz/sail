import { T, Var, useGT, useMessages } from "gt-react";
import { ChevronRightIcon, FolderPlusIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ConnectionStatusDot } from "../../ConnectionStatusDot";
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
  const detail = useDetail(machine) || messages(status.label);
  const cloning = machine.projects.filter((project) => project.status);
  const showSignedOut = Boolean(machine.id && machine.signedOut.length > 0);
  const showNeedsProject = !showSignedOut && controls.needsProject;
  const hasSubRows =
    controls.deleteRefusal !== null || showSignedOut || showNeedsProject || cloning.length > 0;
  const isError = machine.state === "error" || machine.state === "missing";
  const isWorking = machine.state === "working";
  const isDimmed = machine.state === "asleep" || machine.state === "missing";
  const projectCount = machine.projects.length;

  const identity = (
    <>
      <ConnectionStatusDot
        dotClassName={status.dotClassName}
        pingClassName={status.pingClassName}
      />

      <div className="min-w-0 flex-1 space-y-0.5">
        <div
          className={cn(
            "truncate text-sm font-medium",
            isDimmed ? "text-foreground/80" : "text-foreground",
          )}
        >
          {machine.name}
        </div>

        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "min-w-0 truncate",
                    isError && "text-destructive-foreground",
                    isWorking && "text-success-foreground",
                  )}
                />
              }
            >
              {detail}
            </TooltipTrigger>
            <TooltipPopup side="top">{detail}</TooltipPopup>
          </Tooltip>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
            ·
          </span>
          <span className="shrink-0 font-mono">{machine.size}</span>
          {size ? (
            <>
              <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
                ·
              </span>
              <span className="shrink-0 font-mono tabular-nums">{hourly(size.hourly)}</span>
            </>
          ) : null}
          {projectCount > 0 ? (
            <>
              <span
                aria-hidden="true"
                className="hidden shrink-0 text-muted-foreground/50 sm:inline"
              >
                ·
              </span>
              <span className="hidden shrink-0 tabular-nums sm:inline">
                {gt("{count, plural, one {# project} other {# projects}}", {
                  count: projectCount,
                })}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </>
  );

  return (
    <li className="overflow-hidden first:rounded-t-xl last:rounded-b-xl">
      <div
        className={cn(
          "group/machine-row flex items-center gap-3 px-3 py-3 sm:px-4",
          controls.canOpen && "transition-colors hover:bg-accent/35",
        )}
      >
        {controls.canOpen ? (
          <button
            type="button"
            aria-label={gt("Details for {name}", { name: machine.name })}
            onClick={onOpen}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {identity}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{identity}</div>
        )}

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
          {controls.canOpen ? (
            <ChevronRightIcon
              aria-hidden="true"
              className="pointer-events-none size-4 text-muted-foreground/45 transition-all duration-150 group-hover/machine-row:translate-x-0.5 group-hover/machine-row:text-muted-foreground"
            />
          ) : null}
        </div>
      </div>

      {hasSubRows ? (
        <div className="space-y-2 px-3 pb-3 pl-9 sm:px-4 sm:pl-10">
          <DeleteErrorAlert controls={controls} />

          {showSignedOut ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/25 bg-warning-surface/75 px-3 py-1.5 text-xs">
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
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <FolderPlusIcon aria-hidden="true" className="size-3.5 text-muted-foreground/70" />
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

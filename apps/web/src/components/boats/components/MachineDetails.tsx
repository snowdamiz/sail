import { useGT, useMessages } from "gt-react";
import { CheckIcon, ChevronDownIcon, ClockIcon, ServerIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ConnectionStatusDot } from "../../ConnectionStatusDot";
import { SettingsGroup } from "../../settings/SettingsGroup";
import { ITEM_ROW_CLASSNAME } from "../../settings/itemRows";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Skeleton } from "../../ui/skeleton";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useMachineDetails } from "../api";
import {
  ACTIONS,
  MACHINE_STATUS,
  duration,
  hourly,
  machineKey,
  money,
  resizeHint,
  shortDate,
  sizeOf,
  timeLeft,
  useMachineActionLabel,
} from "../machine";
import type { MachineDetails as Details, MachineView, Size } from "../types";
import { AgentName } from "./AgentLogos";
import {
  DeleteErrorAlert,
  MachineActionButton,
  type MachineControls,
  type PowerControls,
} from "./MachineActions";
import { MachineSizePicker } from "./MachineSizePicker";
import { ProjectPicker } from "./ProjectPicker";
import { useDetail, useSecsLeft } from "./common";

export function MachineDetails({
  machine,
  sizes,
  version,
  controls,
  supportsLocalProjects,
  openProjectPicker,
  signIn,
  onError,
}: {
  readonly machine: MachineView;
  readonly sizes: readonly Size[];
  readonly version: unknown;
  readonly controls: MachineControls;
  readonly supportsLocalProjects: boolean;
  readonly openProjectPicker: boolean;
  readonly signIn: ReactNode;
  readonly onError: (text: string) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const details = useMachineDetails(machine.id, version, onError);
  const status = MACHINE_STATUS[machine.state];
  const size = sizeOf(sizes, machine.size);
  const detail = useDetail(machine);
  const key = machineKey(machine);
  const gone = machine.state === "missing";

  return (
    <div className="space-y-6">
      <SettingsGroup className="bg-card">
        <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-4 sm:px-5">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="relative mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
              <ServerIcon aria-hidden="true" className="size-4.5 text-muted-foreground" />
              <span className="absolute -right-1 -bottom-1 rounded-full bg-card p-0.5">
                <ConnectionStatusDot dotClassName={status.dotClassName} />
              </span>
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold text-foreground">{machine.name}</h1>
                <Badge size="sm" variant={status.badgeVariant}>
                  {messages(status.label)}
                </Badge>
                <Badge size="sm" variant="secondary">
                  <span className="font-mono">{machine.size}</span>
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{detail}</p>
              {size ? (
                <p className="font-mono text-xs text-muted-foreground tabular-nums">
                  {size.spec} · {hourly(size.hourly)}
                </p>
              ) : null}
            </div>
          </div>

          <div className="shrink-0">
            <MachineActionButton
              targetKey={key}
              control={controls.detailsPrimary}
              onRequest={controls.request}
              size="sm"
              pendingLabel={controls.pending?.label ?? null}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <StatCell label={gt("Today")} value={details ? money(details.costToday) : null} />
          <StatCell label={gt("This month")} value={details ? money(details.costMonth) : null} />
          <StatCell
            label={gt("Awake today")}
            value={details ? duration(details.awakeSecsToday) : null}
          />
        </div>
      </SettingsGroup>

      {controls.power !== null ? (
        <PowerSection machine={machine} power={controls.power} controls={controls} />
      ) : null}

      <AgentsSection machine={machine} details={details} controls={controls} signIn={signIn} />

      <ConnectSection details={details} controls={controls} />

      {gone && !machine.projects.length ? null : (
        <ProjectsSection
          machine={machine}
          controls={controls}
          supportsLocalProjects={supportsLocalProjects}
          openProjectPicker={openProjectPicker}
        />
      )}

      <MachineDangerSection machine={machine} size={size} controls={controls} />

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 font-mono text-xs text-muted-foreground">
        {details ? (
          <>
            <span>{gt("Sail {version}", { version: details.t3Version })}</span>
            <span aria-hidden="true">·</span>
            <span>{gt("created {date}", { date: shortDate(details.createdAt) })}</span>
            <span aria-hidden="true">·</span>
            <span className="select-all">{machine.id}</span>
          </>
        ) : (
          <Skeleton className="h-4 w-56" />
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {count !== undefined && count > 0 ? (
          <Badge size="sm" variant="secondary">
            <span className="font-mono tabular-nums">{count}</span>
          </Badge>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatCell({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 sm:px-5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {value !== null ? (
        <span className="font-mono text-sm font-medium text-foreground tabular-nums">{value}</span>
      ) : (
        <Skeleton className="mt-0.5 h-4 w-16" />
      )}
    </div>
  );
}

function PowerSection({
  machine,
  power,
  controls,
}: {
  readonly machine: MachineView;
  readonly power: PowerControls;
  readonly controls: MachineControls;
}) {
  const gt = useGT();
  const actionLabel = useMachineActionLabel();
  const pendingAction = controls.pending?.action;
  const autoSleepOn =
    pendingAction?.cmd === "keep_awake" &&
    (pendingAction.minutes === null || pendingAction.minutes === 0)
      ? pendingAction.minutes === 0
      : power.autoSleep.checked;

  const powerControl = power.power;

  return (
    <Section title={gt("Power")}>
      <SettingsGroup className="bg-card">
        <div className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-4")}>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium text-foreground">{gt("Auto sleep")}</div>
            <p className="text-xs text-muted-foreground">
              {autoSleepOn
                ? gt("Sleeps 3 min after agents finish; asleep is free")
                : gt("Stays up and bills until you turn this back on")}
            </p>
          </div>
          <Switch
            aria-label={gt("Auto sleep")}
            checked={autoSleepOn}
            disabled={power.autoSleep.disabled}
            onCheckedChange={(checked) =>
              controls.request({ kind: "run", action: power.autoSleep.actionFor(checked) })
            }
          />
        </div>

        <div className={cn(ITEM_ROW_CLASSNAME, "flex flex-wrap items-center gap-2")}>
          <Button
            size="xs"
            variant="outline"
            disabled={powerControl === null || powerControl.disabled}
            onClick={() => {
              if (powerControl !== null) {
                controls.request({ kind: "run", action: powerControl.action });
              }
            }}
          >
            {actionLabel(powerControl !== null ? powerControl.action : ACTIONS.sleep)}
          </Button>
          {autoSleepOn ? (
            <StayAwakeControl machine={machine} power={power} controls={controls} />
          ) : null}
        </div>
      </SettingsGroup>
    </Section>
  );
}

function StayAwakeControl({
  machine,
  power,
  controls,
}: {
  readonly machine: MachineView;
  readonly power: PowerControls;
  readonly controls: MachineControls;
}) {
  const gt = useGT();
  const left = useSecsLeft(machine.keepAwakeUntil);

  if (machine.keepAwakeUntil !== null) {
    return (
      <div className="flex items-center gap-1.5" role="status">
        <Badge variant="warning" size="control">
          <ClockIcon aria-hidden="true" className="size-3" />
          <span className="font-mono tabular-nums">
            {gt("Awake · {left} left", { left: timeLeft(left) })}
          </span>
        </Badge>
        <Button
          size="xs"
          variant="ghost"
          disabled={power.stopStayingAwake.disabled}
          onClick={() => controls.request({ kind: "run", action: power.stopStayingAwake.action })}
        >
          {gt("Stop")}
        </Button>
      </div>
    );
  }

  const allDisabled = power.temporaryAwake.every((item) => item.disabled);

  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" disabled={allDisabled} />}>
        {gt("Stay awake for…")}
        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start" width="content">
        {power.temporaryAwake.map((item) => {
          const minutes = item.action.minutes ?? 0;
          return (
            <MenuItem
              key={minutes}
              disabled={item.disabled}
              onClick={() => controls.request({ kind: "run", action: item.action })}
            >
              {duration(minutes * 60)}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

function AgentsSection({
  machine,
  details,
  controls,
  signIn,
}: {
  readonly machine: MachineView;
  readonly details: Details | null;
  readonly controls: MachineControls;
  readonly signIn: ReactNode;
}) {
  const gt = useGT();

  return (
    <Section title={gt("Agents")}>
      <SettingsGroup className="bg-card">
        {details ? (
          details.agents.length > 0 ? (
            details.agents.map((agent) => {
              const control = controls.signInAgentControl(agent.name);
              const running =
                controls.pending?.action.cmd === "sign_in_agent" &&
                controls.pending.action.agent === agent.name;
              return (
                <div
                  key={agent.name}
                  className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-3")}
                >
                  <AgentName name={agent.name} />
                  {agent.signedIn ? (
                    <Badge size="sm" variant="success">
                      <CheckIcon aria-hidden="true" className="size-3" />
                      {gt("Signed in")}
                    </Badge>
                  ) : machine.signedOut.includes(agent.name) ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={control.disabled}
                      aria-busy={running}
                      onClick={() => controls.request({ kind: "run", action: control.action })}
                    >
                      {running ? (
                        <>
                          <Spinner aria-hidden="true" />
                          {gt("Signing in…")}
                        </>
                      ) : (
                        gt("Sign in")
                      )}
                    </Button>
                  ) : (
                    <Badge size="sm" variant="secondary">
                      {gt("Signed out")}
                    </Badge>
                  )}
                </div>
              );
            })
          ) : (
            <div className={cn(ITEM_ROW_CLASSNAME, "text-xs text-muted-foreground")}>
              {gt("No agents reported on this machine.")}
            </div>
          )
        ) : (
          <RowsSkeleton count={2} />
        )}
      </SettingsGroup>
      {signIn ? <div className="pt-1">{signIn}</div> : null}
    </Section>
  );
}

function ConnectSection({
  details,
  controls,
}: {
  readonly details: Details | null;
  readonly controls: MachineControls;
}) {
  const gt = useGT();
  const running = controls.pending?.action.cmd === "turn_on_connect";

  return (
    <Section title={gt("Other devices")}>
      <SettingsGroup className="bg-card">
        {details ? (
          <div className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-4")}>
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium text-foreground">T3 Connect</div>
              {details.connect ? null : (
                <p className="text-xs text-muted-foreground">
                  {gt("Sail on your phone or in a browser, with your Sail account")}
                </p>
              )}
            </div>
            {details.connect ? (
              <Badge size="sm" variant="success">
                <CheckIcon aria-hidden="true" className="size-3" />
                {gt("On")}
              </Badge>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={controls.connectControl.disabled}
                aria-busy={running}
                onClick={() =>
                  controls.request({ kind: "run", action: controls.connectControl.action })
                }
              >
                {running ? (
                  <>
                    <Spinner aria-hidden="true" />
                    {gt("Approve in browser…")}
                  </>
                ) : (
                  gt("Turn on")
                )}
              </Button>
            )}
          </div>
        ) : (
          <RowsSkeleton count={1} />
        )}
      </SettingsGroup>
    </Section>
  );
}

function ProjectsSection({
  machine,
  controls,
  supportsLocalProjects,
  openProjectPicker,
}: {
  readonly machine: MachineView;
  readonly controls: MachineControls;
  readonly supportsLocalProjects: boolean;
  readonly openProjectPicker: boolean;
}) {
  const gt = useGT();
  const gone = machine.state === "missing";

  return (
    <Section title={gt("Projects")} count={machine.projects.length}>
      <SettingsGroup className="bg-card">
        {machine.projects.map((project) => (
          <div
            key={project.id}
            className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-3")}
          >
            <Tooltip>
              <TooltipTrigger
                render={<span className="truncate text-sm font-medium text-foreground" />}
              >
                {project.title}
              </TooltipTrigger>
              <TooltipPopup>{project.title}</TooltipPopup>
            </Tooltip>
            {project.status ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" />
                  }
                >
                  <Spinner aria-hidden="true" size="xs" tone="muted" />
                  <span className="max-w-48 truncate">{project.status}</span>
                </TooltipTrigger>
                <TooltipPopup>{project.status}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ))}

        {!machine.projects.length && !gone ? (
          <div className={cn(ITEM_ROW_CLASSNAME, "text-xs text-muted-foreground")}>
            {supportsLocalProjects
              ? gt("Cloned from its git remote, .env files included")
              : gt("Add projects after connecting to this Boat")}
          </div>
        ) : null}

        {supportsLocalProjects && !gone ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <ProjectPicker
              m={machine}
              initialOpen={openProjectPicker}
              disabled={!controls.canAddProject}
              onAdd={controls.onAddProject}
            />
          </div>
        ) : null}
      </SettingsGroup>
    </Section>
  );
}

function MachineDangerSection({
  machine,
  size,
  controls,
}: {
  readonly machine: MachineView;
  readonly size: Size | undefined;
  readonly controls: MachineControls;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [expanded, setExpanded] = useState(false);
  const open = expanded || controls.deleteRefusal !== null;
  const gone = machine.state === "missing";
  const key = machineKey(machine);

  return (
    <SettingsGroup divided={false} className="bg-card">
      <Collapsible open={open} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          className={cn(
            "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5",
            open ? "rounded-t-xl" : "rounded-xl",
          )}
        >
          <span className="text-sm font-medium text-foreground">{gt("Machine")}</span>
          <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground tabular-nums">
            <span>
              {gone ? gt("gone") : size ? `${machine.size} · ${hourly(size.hourly)}` : machine.size}
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-4 transition-transform duration-150", open && "rotate-180")}
            />
          </span>
        </CollapsibleTrigger>

        <CollapsiblePanel>
          <div className="space-y-4 border-t border-border/50 px-4 py-4 sm:px-5">
            {gone ? null : (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">{gt("Size")}</div>
                <MachineSizePicker
                  sizes={controls.resizeChoices.map((choice) => choice.size)}
                  value={machine.size}
                  ariaLabel={gt("Size")}
                  isOptionDisabled={(choice) => {
                    const match = controls.resizeChoices.find(
                      (candidate) => candidate.size.id === choice.id,
                    );
                    return match ? !match.current && match.control.disabled : true;
                  }}
                  onChange={(sizeId) => {
                    const match = controls.resizeChoices.find(
                      (candidate) => candidate.size.id === sizeId,
                    );
                    if (match && !match.current && !match.control.disabled) {
                      controls.request({ kind: "run", action: match.control.action });
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">{messages(resizeHint(machine))}</p>
              </div>
            )}

            <div className={cn("space-y-3", !gone && "border-t border-border/50 pt-4")}>
              <MachineActionButton
                targetKey={key}
                control={controls.deleteControl}
                onRequest={controls.request}
                size="sm"
                surface="danger"
              />
              <DeleteErrorAlert controls={controls} />
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </SettingsGroup>
  );
}

function RowsSkeleton({ count }: { readonly count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={ITEM_ROW_CLASSNAME} aria-hidden="true">
          <Skeleton className="h-4 w-32" />
        </div>
      ))}
    </>
  );
}

import { useGT, useLocale, useMessages } from "gt-react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  FolderGit2Icon,
} from "lucide-react";
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
  const locale = useLocale();
  const messages = useMessages();
  const details = useMachineDetails(machine.id, version, onError);
  const status = MACHINE_STATUS[machine.state];
  const statusLabel = messages(status.label);
  const size = sizeOf(sizes, machine.size);
  const detail = useDetail(machine);
  const showDetail = detail.trim().toLowerCase() !== statusLabel.trim().toLowerCase() && detail;
  const key = machineKey(machine);
  const gone = machine.state === "missing";

  return (
    <div className="space-y-8">
      <header className="space-y-5 px-3 sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <ConnectionStatusDot
                dotClassName={status.dotClassName}
                pingClassName={status.pingClassName}
              />
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                {machine.name}
              </h1>
              <Badge size="sm" variant={status.badgeVariant}>
                {statusLabel}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {showDetail ? (
                <>
                  <span>{detail}</span>
                  <span aria-hidden="true" className="text-muted-foreground/50">
                    ·
                  </span>
                </>
              ) : null}
              <span className="font-mono">{machine.size}</span>
              {size ? (
                <>
                  <span aria-hidden="true" className="text-muted-foreground/50">
                    ·
                  </span>
                  <span>{size.spec}</span>
                  <span aria-hidden="true" className="text-muted-foreground/50">
                    ·
                  </span>
                  <span className="font-mono tabular-nums">{hourly(size.hourly)}</span>
                </>
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

        <div className="grid grid-cols-3 gap-6 border-t border-border/50 pt-4">
          <StatCell label={gt("Today")} value={details ? money(details.costToday) : null} />
          <StatCell label={gt("This month")} value={details ? money(details.costMonth) : null} />
          <StatCell
            label={gt("Awake today")}
            value={details ? duration(details.awakeSecsToday) : null}
          />
        </div>
      </header>

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

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 font-mono text-2xs text-muted-foreground/80 sm:px-4">
        {details ? (
          <>
            <span>{gt("Sail {version}", { version: details.t3Version })}</span>
            <span aria-hidden="true">·</span>
            <span>{gt("created {date}", { date: shortDate(details.createdAt, locale) })}</span>
            <span aria-hidden="true">·</span>
            <span className="select-all">{machine.id}</span>
          </>
        ) : (
          <Skeleton className="h-3.5 w-56" />
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  headerAction,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly headerAction?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 sm:px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {count !== undefined && count > 0 ? (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{count}</span>
          ) : null}
        </div>
        {headerAction ? (
          <div className="flex min-h-7 items-center justify-end">{headerAction}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatCell({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {value !== null ? (
        <div className="text-lg font-semibold tracking-tight text-foreground tabular-nums">
          {value}
        </div>
      ) : (
        <Skeleton className="mt-1 h-6 w-16" />
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
      <SettingsGroup>
        <div className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-6")}>
          <div className="min-w-0 space-y-0.5">
            <h3 className="text-sm font-medium text-foreground">{gt("Auto sleep")}</h3>
            <p className="text-xs leading-normal text-muted-foreground">
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

        <div
          className={cn(
            ITEM_ROW_CLASSNAME,
            "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
          )}
        >
          <div className="min-w-0 space-y-0.5">
            <h3 className="text-sm font-medium text-foreground">{gt("Power state")}</h3>
            <p className="text-xs leading-normal text-muted-foreground">
              {autoSleepOn
                ? gt("Sleep immediately or hold this machine awake for a set window.")
                : gt("Put this machine to sleep immediately when you're done.")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
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
      <MenuPopup align="end" width="content">
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
      <SettingsGroup>
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
                  <AgentName name={agent.name} className="text-sm" />
                  {agent.signedIn ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                      <CheckIcon aria-hidden="true" className="size-3.5" />
                      {gt("Signed in")}
                    </span>
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
                    <span className="text-xs text-muted-foreground">{gt("Signed out")}</span>
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
      <SettingsGroup>
        {details ? (
          <div className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-6")}>
            <div className="min-w-0 space-y-0.5">
              <h3 className="text-sm font-medium text-foreground">T3 Connect</h3>
              <p className="text-xs leading-normal text-muted-foreground">
                {details.connect
                  ? gt("Reachable from Sail on your phone or in a browser.")
                  : gt("Sail on your phone or in a browser, with your Sail account")}
              </p>
            </div>
            {details.connect ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-success-foreground">
                <CheckIcon aria-hidden="true" className="size-3.5" />
                {gt("On")}
              </span>
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
    <Section
      title={gt("Projects")}
      count={machine.projects.length}
      headerAction={
        supportsLocalProjects && !gone ? (
          <ProjectPicker
            m={machine}
            initialOpen={openProjectPicker}
            disabled={!controls.canAddProject}
            onAdd={controls.onAddProject}
          />
        ) : null
      }
    >
      <SettingsGroup>
        {machine.projects.map((project) => (
          <div
            key={project.id}
            className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-3")}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <FolderGit2Icon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <Tooltip>
                <TooltipTrigger
                  render={<span className="truncate text-sm font-medium text-foreground" />}
                >
                  {project.title}
                </TooltipTrigger>
                <TooltipPopup>{project.title}</TooltipPopup>
              </Tooltip>
            </div>
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
  const [selectedSize, setSelectedSize] = useState(machine.size);
  const [syncedMachineSize, setSyncedMachineSize] = useState(machine.size);

  if (syncedMachineSize !== machine.size) {
    setSyncedMachineSize(machine.size);
    setSelectedSize(machine.size);
  }

  const open = expanded || controls.deleteRefusal !== null;
  const gone = machine.state === "missing";
  const key = machineKey(machine);
  const pendingResize = controls.pending?.action.cmd === "resize_machine" ? controls.pending : null;
  const selectedChoice =
    controls.resizeChoices.find((choice) => choice.size.id === selectedSize) ?? null;
  const hasPendingSizeChange = selectedSize !== machine.size;
  const summary = gone
    ? gt("gone")
    : size
      ? `${machine.size} · ${hourly(size.hourly)}`
      : machine.size;

  return (
    <section>
      <Collapsible
        open={open}
        onOpenChange={setExpanded}
        render={<SettingsGroup divided={false} />}
      >
        <div className="flex items-center px-3 sm:px-4">
          <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium text-foreground">{gt("Machine")}</span>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground tabular-nums">
              {summary}
            </span>
          </CollapsibleTrigger>
        </div>

        <CollapsiblePanel>
          <div className="divide-y divide-border/50 border-t border-border/50">
            {gone ? null : (
              <div className="space-y-3 px-3 py-4 sm:px-4">
                <div className="space-y-0.5">
                  <h3 className="text-sm font-medium text-foreground">{gt("Size")}</h3>
                  <p className="text-xs text-muted-foreground">{messages(resizeHint(machine))}</p>
                </div>
                <MachineSizePicker
                  sizes={controls.resizeChoices.map((choice) => choice.size)}
                  value={selectedSize}
                  ariaLabel={gt("Size")}
                  isOptionDisabled={() => !controls.canResize}
                  onChange={setSelectedSize}
                />
                {hasPendingSizeChange || pendingResize !== null ? (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <Button
                      size="xs"
                      variant="default"
                      disabled={
                        pendingResize !== null ||
                        !controls.canResize ||
                        selectedChoice === null ||
                        selectedChoice.control.disabled
                      }
                      aria-busy={pendingResize !== null}
                      onClick={() => {
                        if (selectedChoice && !selectedChoice.control.disabled) {
                          controls.request({ kind: "run", action: selectedChoice.control.action });
                        }
                      }}
                    >
                      {pendingResize !== null ? (
                        <>
                          <Spinner aria-hidden="true" />
                          {pendingResize.label}
                        </>
                      ) : (
                        gt("Resize to {size}", { size: selectedSize })
                      )}
                    </Button>
                    {hasPendingSizeChange ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={pendingResize !== null}
                        onClick={() => setSelectedSize(machine.size)}
                      >
                        {gt("Cancel")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}

            <div className="space-y-3 px-3 py-3.5 sm:px-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <div className="min-w-0 space-y-0.5">
                  <h3 className="text-sm font-medium text-foreground">
                    {gone ? gt("Remove machine") : gt("Delete machine")}
                  </h3>
                  <p className="text-xs leading-normal text-muted-foreground">
                    {gone
                      ? gt("Remove this missing machine from your Boat list.")
                      : gt("Permanently destroy this machine and its local disk.")}
                  </p>
                </div>
                <MachineActionButton
                  targetKey={key}
                  control={controls.deleteControl}
                  onRequest={controls.request}
                  size="sm"
                  surface="danger"
                  className="shrink-0"
                />
              </div>
              <DeleteErrorAlert controls={controls} />
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
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

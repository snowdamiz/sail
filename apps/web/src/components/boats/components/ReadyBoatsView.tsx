import { useGT } from "gt-react";
import { PlusIcon, ServerIcon, Settings2Icon } from "lucide-react";

import { SettingsGroup } from "../../settings/SettingsGroup";
import { Button } from "../../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../ui/empty";
import type { useFollowBoatLink } from "../api";
import { machineKey, sizeOf } from "../machine";
import type { UiState } from "../types";
import { useReadyBoatsSession } from "../useReadyBoatsSession";
import { BoatsFrame, type Notice, type Notify, type ServerSelection } from "./BoatsFrame";
import { Costs } from "./Costs";
import { MachineDetails } from "./MachineDetails";
import { MachineRow } from "./MachineRow";
import { NewMachine } from "./NewMachine";
import { SettingsView } from "./SettingsView";
import { SignInPanel } from "./SignInPanel";

type FollowLink = ReturnType<typeof useFollowBoatLink>;

export function ReadyBoatsView({
  state,
  supportsLocalProjects,
  follow,
  notify,
  server,
  notice,
  dismissNotice,
}: {
  readonly state: UiState;
  readonly supportsLocalProjects: boolean;
  readonly follow: FollowLink;
  readonly notify: Notify;
  readonly server: ServerSelection;
  readonly notice: Notice | null;
  readonly dismissNotice: () => void;
}) {
  const gt = useGT();
  const session = useReadyBoatsSession({ state, supportsLocalProjects, follow, notify });
  const { view } = session;

  const detailsError = (text: string) =>
    notify(gt("Couldn't load details: {error}", { error: text }));

  const signInPanel =
    session.signIn === null ? null : (
      <SignInPanel
        key={session.signIn.attempt.attemptId}
        attempt={session.signIn.attempt}
        command="manage_agent_sign_in"
        onFinish={session.finishSignIn}
      />
    );

  const breadcrumbTitle =
    view.kind === "details"
      ? view.machine.name
      : view.kind === "new"
        ? gt("New machine")
        : view.kind === "settings"
          ? gt("Boat settings")
          : undefined;

  const awakeCount = state.machines.filter(
    (machine) => machine.state === "working" || machine.state === "idle",
  ).length;

  const headerActions = (
    <>
      {view.kind !== "settings" ? (
        <Button size="sm" variant="outline" onClick={() => session.navigate({ kind: "settings" })}>
          <Settings2Icon aria-hidden="true" className="size-3.5" />
          {gt("Boat settings")}
        </Button>
      ) : null}
      {view.kind === "list" && state.machines.length > 0 ? (
        <Button
          size="sm"
          variant="default"
          disabled={!session.canCreate}
          onClick={() => session.navigate({ kind: "new" })}
        >
          <PlusIcon aria-hidden="true" className="size-3.5" />
          {gt("New machine")}
        </Button>
      ) : null}
    </>
  );

  return (
    <BoatsFrame
      breadcrumbTitle={breadcrumbTitle}
      breadcrumbHeading={view.kind !== "details"}
      back={view.kind === "list" ? null : session.back}
      server={server}
      headerActions={headerActions}
      notice={notice}
      dismissNotice={dismissNotice}
    >
      {view.kind === "details" ? (
        <MachineDetails
          key={view.machine.id}
          machine={view.machine}
          sizes={state.sizes}
          version={state}
          controls={session.controlsFor(view.machine)}
          supportsLocalProjects={supportsLocalProjects}
          openProjectPicker={view.entry === "projectPicker"}
          signIn={session.signIn?.machineId === view.machine.id ? signInPanel : null}
          onError={detailsError}
        />
      ) : view.kind === "new" ? (
        <NewMachine
          state={state}
          supportsLocalProjects={supportsLocalProjects}
          canCreate={session.canCreate}
          onCreate={session.create}
          onCancel={session.back}
        />
      ) : view.kind === "settings" ? (
        <SettingsView
          state={state}
          onSave={session.saveSettings}
          onAddMcp={session.addMcp}
          onSignOut={session.signOut}
        />
      ) : state.machines.length === 0 ? (
        <SettingsGroup divided={false}>
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <ServerIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>
                <h2>{gt("No machines yet")}</h2>
              </EmptyTitle>
              <EmptyDescription>
                {gt(
                  "A machine is a cloud computer your Sail agents work on. It sleeps when nobody's working, and sleeping is free.",
                )}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                size="sm"
                variant="default"
                disabled={!session.canCreate}
                onClick={() => session.navigate({ kind: "new" })}
              >
                <PlusIcon aria-hidden="true" className="size-3.5" />
                {gt("New machine")}
              </Button>
            </EmptyContent>
          </Empty>
        </SettingsGroup>
      ) : (
        <section className="space-y-2.5">
          <div className="flex min-h-7 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 sm:px-4">
            <div className="space-y-0.5">
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-semibold text-foreground">{gt("Machines")}</h2>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {state.machines.length}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {gt("Cloud machines that sleep for free when no agent is working.")}
              </p>
            </div>
            {awakeCount > 0 ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {gt("{count} awake", { count: awakeCount })}
              </span>
            ) : null}
          </div>
          <SettingsGroup divided={false}>
            <ul className="divide-y divide-border/50">
              {state.machines.map((machine) => (
                <MachineRow
                  key={machineKey(machine)}
                  machine={machine}
                  size={sizeOf(state.sizes, machine.size)}
                  controls={session.controlsFor(machine)}
                  onOpen={() => session.navigateToMachine(machine, "overview")}
                  onPickProject={() => session.navigateToMachine(machine, "projectPicker")}
                />
              ))}
            </ul>
          </SettingsGroup>
        </section>
      )}

      {signInPanel !== null &&
      (view.kind !== "details" || view.machine.id !== session.signIn?.machineId)
        ? signInPanel
        : null}

      {view.kind === "list" ? <Costs costs={state.costs} /> : null}
    </BoatsFrame>
  );
}

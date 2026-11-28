import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  environmentSupportsLocalSessions,
  type BoatSignIn,
  type BoatSignInPhase,
  type EnvironmentId,
} from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  InfoIcon,
  PlusIcon,
  ServerIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { m as message } from "~/i18n/messages";
import {
  boatCommandsAllowedAtom,
  boatServerChoicesAtom,
  boatServerIdAtom,
  boatServerSelectionAtom,
} from "~/state/boats";
import { clientHostEnvironmentAtom } from "~/state/clientHostEnvironment";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { SailBrandMark } from "../SailBrandMark";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SettingsGroup } from "../settings/SettingsGroup";
import { ITEM_ROW_CLASSNAME } from "../settings/itemRows";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { type BoatAccess, BoatAccessContext, useBoatAccess } from "./access";
import { useBoatCall, useBoatsPage, useFollowBoatLink } from "./api";
import { Costs } from "./components/Costs";
import {
  deriveMachineControls,
  type ActionRequest,
  type DeleteRefusal,
  type MachineControls,
} from "./components/MachineActions";
import { MachineDetails } from "./components/MachineDetails";
import { MachineRow } from "./components/MachineRow";
import { NewMachine, type CreateMachineInput } from "./components/NewMachine";
import { SettingsView } from "./components/SettingsView";
import { SetupView } from "./components/SetupView";
import { SignInPanel } from "./components/SignInPanel";
import { isMachineOpenable, machineKey, sizeOf, type Action } from "./machine";
import { errorText, type BoatLink } from "./reply";
import type { LocalProject, MachineView, McpClient, Settings, SetupAction, UiState } from "./types";

type EntryIntent = "overview" | "projectPicker";

type ReadyLocation =
  | { readonly kind: "list" }
  | { readonly kind: "new" }
  | { readonly kind: "settings" }
  | {
      readonly kind: "details";
      readonly machineId: MachineView["id"];
      readonly entry: EntryIntent;
    };

type ResolvedReadyView =
  | Exclude<ReadyLocation, { kind: "details" }>
  | { readonly kind: "details"; readonly machine: MachineView; readonly entry: EntryIntent };

type FollowLink = (openUrl: string | undefined, expectedEnvironmentId?: EnvironmentId) => BoatLink;

interface Notice {
  readonly tone: "error" | "info";
  readonly text: string;
}

type Notify = (text: string, tone?: Notice["tone"]) => void;

interface PendingOperation {
  readonly requestId: symbol;
  readonly label: string;
}

interface ServerSelection {
  readonly selected: EnvironmentId | null;
  readonly choices: ReadonlyArray<{ readonly value: EnvironmentId; readonly label: string }>;
  readonly select: (id: EnvironmentId | null) => void;
}

const OPEN_OVERLAY_SELECTOR =
  '[data-slot="menu-popup"][data-open], [data-slot="popover-popup"][data-open], [data-slot="select-popup"][data-open], [role="dialog"]';

function resolveReadyView(location: ReadyLocation, state: UiState): ResolvedReadyView {
  if (location.kind !== "details") return location;
  const machine = state.machines.find(
    (candidate) => candidate.id === location.machineId && isMachineOpenable(candidate),
  );
  if (!machine) return { kind: "list" };
  return { kind: "details", machine, entry: location.entry };
}

function BoatsFrame({
  breadcrumbTitle,
  pageTitle,
  pageSubtitle,
  back,
  server,
  toolbar,
  notice,
  dismissNotice,
  children,
}: {
  readonly breadcrumbTitle?: string | undefined;
  readonly pageTitle?: string | undefined;
  readonly pageSubtitle?: string | undefined;
  readonly back: (() => void) | null;
  readonly server: ServerSelection;
  readonly toolbar?: ReactNode;
  readonly notice: Notice | null;
  readonly dismissNotice: () => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const showServerSelect =
    server.choices.length > 1 || (server.selected === null && server.choices.length > 0);
  const showToolbarRow = Boolean(pageTitle || showServerSelect || toolbar);

  useEffect(() => {
    if (back === null) return;
    let overlayOwnedEvent: KeyboardEvent | null = null;
    const onCapture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) {
        overlayOwnedEvent = event;
      }
    };
    const onBubble = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const owned = event === overlayOwnedEvent;
      overlayOwnedEvent = null;
      if (owned || event.defaultPrevented || event.repeat || event.isComposing) return;
      back();
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble, false);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble, false);
    };
  }, [back]);

  return (
    <SidebarInset data-testid="sail-boats-workspace" className="min-h-0 flex-1 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
        {back !== null ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Back")}
            onClick={back}
            className="[-webkit-app-region:no-drag]"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        <WorkspaceBreadcrumb ariaLabel={gt("Boats breadcrumb")} className="flex-1">
          <WorkspaceBreadcrumbItem current={back === null}>
            {back !== null ? (
              <button
                type="button"
                onClick={back}
                className="[-webkit-app-region:no-drag] inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <SailBrandMark aria-hidden="true" className="size-3.5 shrink-0" />
                <WorkspaceBreadcrumbText>{gt("Boats")}</WorkspaceBreadcrumbText>
              </button>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-2">
                <SailBrandMark aria-hidden="true" className="size-4 shrink-0" />
                <WorkspaceBreadcrumbText>{gt("Boats")}</WorkspaceBreadcrumbText>
              </span>
            )}
          </WorkspaceBreadcrumbItem>
          {back !== null && breadcrumbTitle ? (
            <>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <WorkspaceBreadcrumbText>{breadcrumbTitle}</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
            </>
          ) : null}
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>

      <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="readable" className="gap-6">
          {showToolbarRow ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              {pageTitle ? (
                <div className="min-w-0 space-y-0.5">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                    {pageTitle}
                  </h1>
                  {pageSubtitle ? (
                    <p className="text-xs text-muted-foreground">{pageSubtitle}</p>
                  ) : null}
                </div>
              ) : (
                <div />
              )}
              <div className="flex flex-wrap items-center gap-2">
                {showServerSelect ? (
                  <Select<EnvironmentId>
                    value={server.selected}
                    onValueChange={server.select}
                    items={server.choices}
                  >
                    <SelectTrigger size="sm" aria-label={gt("Boats server")}>
                      <SelectValue placeholder={gt("Select a server")} />
                    </SelectTrigger>
                    <SelectPopup>
                      {server.choices.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                {toolbar}
              </div>
            </div>
          ) : null}

          {notice !== null ? (
            <Alert variant={notice.tone === "error" ? "error" : "info"}>
              {notice.tone === "error" ? (
                <AlertTriangleIcon aria-hidden="true" />
              ) : (
                <InfoIcon aria-hidden="true" />
              )}
              <AlertDescription>{notice.text}</AlertDescription>
              <AlertAction>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={gt("Dismiss notice")}
                  onClick={dismissNotice}
                >
                  <XIcon aria-hidden="true" className="size-3.5" />
                </Button>
              </AlertAction>
            </Alert>
          ) : null}

          {children}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function SetupBody({
  state,
  follow,
  notify,
  server,
  notice,
  dismissNotice,
}: {
  readonly state: UiState;
  readonly follow: FollowLink;
  readonly notify: Notify;
  readonly server: ServerSelection;
  readonly notice: Notice | null;
  readonly dismissNotice: () => void;
}) {
  const gt = useGT();
  const call = useBoatCall();
  const [signIn, setSignIn] = useState<BoatSignIn | null>(null);
  const [requesting, setRequesting] = useState(false);

  const finish = useCallback(
    (phase: BoatSignInPhase) => {
      setSignIn(null);
      if (phase === "expired") notify(gt("The sign-in expired. Start again to get a new code."));
      if (phase === "failed") notify(gt("Sign-in could not finish. Try again."));
    },
    [gt, notify],
  );

  const act = (action: SetupAction) => {
    setRequesting(true);
    void call("setup_action", { action })
      .then(
        (reply) => {
          if (reply.signIn !== undefined) {
            setSignIn(reply.signIn);
            if (reply.signIn.onHost) follow(reply.signIn.prompt?.url);
          } else {
            follow(reply.openUrl);
          }
        },
        (error) => notify(errorText(error)),
      )
      .finally(() => setRequesting(false));
  };

  return (
    <BoatsFrame back={null} server={server} notice={notice} dismissNotice={dismissNotice}>
      <SetupView
        setup={state.setup}
        busy={state.setupBusy}
        signIn={
          signIn === null ? null : (
            <SignInPanel
              key={signIn.attemptId}
              attempt={signIn}
              command="manage_boat_sign_in"
              onFinish={finish}
            />
          )
        }
        requesting={requesting}
        onAction={act}
      />
    </BoatsFrame>
  );
}

function useReadyBoatsSession({
  state,
  supportsLocalProjects,
  follow,
  notify,
}: {
  readonly state: UiState;
  readonly supportsLocalProjects: boolean;
  readonly follow: FollowLink;
  readonly notify: Notify;
}) {
  const access = useBoatAccess();
  const call = useBoatCall();
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  const [location, setLocation] = useState<ReadyLocation>({ kind: "list" });
  const [pending, setPending] = useState<ReadonlyMap<string, PendingOperation>>(() => new Map());
  const [refused, setRefused] = useState<ReadonlyMap<string, DeleteRefusal>>(() => new Map());
  const [signIn, setSignIn] = useState<{
    readonly machineId: string;
    readonly attempt: BoatSignIn;
  } | null>(null);

  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const startingSignInRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const view = resolveReadyView(location, state);
  if (location.kind === "details" && view.kind === "list") {
    setLocation({ kind: "list" });
  }

  const back = useCallback(() => setLocation({ kind: "list" }), []);

  const navigate = useCallback((next: Exclude<ReadyLocation, { kind: "details" }>) => {
    setLocation(next);
  }, []);

  const navigateToMachine = useCallback((machine: MachineView, entry: EntryIntent) => {
    if (!isMachineOpenable(machine)) return;
    setLocation({ kind: "details", machineId: machine.id, entry });
  }, []);

  const finishSignIn = useCallback(
    (phase: BoatSignInPhase) => {
      setSignIn(null);
      if (phase === "expired") notify(gt("The sign-in expired. Start again to get a new code."));
      if (phase === "failed") notify(gt("Sign-in could not finish. Try again."));
    },
    [gt, notify],
  );

  const clearRefusal = useCallback((key: string) => {
    setRefused((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  const busyLabelFor = useCallback(
    (action: Action): string => {
      switch (action.cmd) {
        case "wake_machine":
          return gt("Waking…");
        case "pair_machine":
          return gt("Sending…");
        case "open_machine":
          return gt("Opening…");
        default:
          return action.busy;
      }
    },
    [gt],
  );

  const dispatchAction = useCallback(
    (target: MachineView, request: ActionRequest) => {
      const latest =
        (target.id ? state.machines.find((candidate) => candidate.id === target.id) : undefined) ??
        target;
      const key = machineKey(latest);
      if (inFlightKeysRef.current.has(key)) return;

      let action: Action;
      if (request.kind === "run") {
        action = request.action;
      } else if (request.kind === "confirmed") {
        action = request.deletion.action;
      } else {
        if (!refused.has(key)) return;
        action = {
          cmd: "delete_machine",
          label: "Delete anyway",
          busy: "Deleting…",
          discard: true,
        };
      }

      if (!access.can(action.cmd)) return;

      const isSignIn = action.cmd === "sign_in_agent" || action.cmd === "turn_on_connect";
      if (isSignIn && (signIn !== null || startingSignInRef.current)) return;
      if (isSignIn) startingSignInRef.current = true;

      inFlightKeysRef.current.add(key);
      const requestId = Symbol(action.cmd);
      const label = busyLabelFor(action);
      setPending((current) => {
        const next = new Map(current);
        next.set(key, { requestId, label });
        return next;
      });

      const pairIfAsked = (openUrl: string | undefined) => {
        if (follow(openUrl, latest.environmentId ?? undefined).kind === "pairing") {
          notify(gt('Accept "{name}" to pair it with Sail', { name: latest.name }), "info");
        }
      };

      const run = async () => {
        switch (action.cmd) {
          case "delete_machine":
            clearRefusal(key);
            try {
              await call("delete_machine", { id: latest.id, discard: action.discard });
            } catch (error) {
              if (action.discard) throw error;
              if (mountedRef.current) {
                setRefused((current) => {
                  const next = new Map(current);
                  next.set(key, { message: errorText(error) });
                  return next;
                });
              }
            }
            return;
          case "sign_in_agent":
          case "turn_on_connect": {
            setLocation({ kind: "details", machineId: latest.id, entry: "overview" });
            const reply = await (
              action.cmd === "sign_in_agent"
                ? call(action.cmd, { id: latest.id, agent: action.agent })
                : call(action.cmd, { id: latest.id })
            ).finally(() => {
              startingSignInRef.current = false;
            });
            if (reply.signIn === undefined) throw new Error(gt("Sign-in could not start."));
            if (!mountedRef.current) return;
            setSignIn({ machineId: latest.id, attempt: reply.signIn });
            if (reply.signIn.onHost) follow(reply.signIn.prompt?.url);
            return;
          }
          case "keep_awake":
            await call("keep_awake", { id: latest.id, minutes: action.minutes });
            return;
          case "resize_machine":
            await call("resize_machine", { id: latest.id, size: action.size });
            return;
          case "wake_machine":
            await call("wake_machine", { id: latest.id });
            if (
              !access.onHost &&
              latest.environmentId !== null &&
              access.isPaired(latest.environmentId)
            ) {
              void retryNow(latest.environmentId);
            }
            return;
          case "open_machine": {
            if (!access.onHost && latest.state === "asleep") {
              await call("wake_machine", { id: latest.id });
            }
            const { data: thread } = await call("latest_thread", { id: latest.id });
            if (thread === null) {
              if (mountedRef.current) {
                notify(message(msg("No thread available to open.")), "info");
              }
              return;
            }
            const reply = await call("open_machine", { id: latest.id, thread });
            pairIfAsked(reply.openUrl);
            return;
          }
          case "pair_machine": {
            const id = latest.environmentId;
            if (access.onHost && id !== null) {
              const entry = registry.get(environmentCatalog.catalogValueAtom).entries.get(id);
              if (entry?.enabled === false && entry.unsupportedReason === undefined) {
                const result = await setEnabled({ environmentId: id, enabled: true });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                return;
              }
            }
            pairIfAsked((await call("pair_machine", { id: latest.id })).openUrl);
            return;
          }
          default:
            pairIfAsked((await call(action.cmd, { id: latest.id })).openUrl);
        }
      };

      void run()
        .catch((error) => {
          if (mountedRef.current) notify(`${latest.name}: ${errorText(error)}`);
        })
        .finally(() => {
          inFlightKeysRef.current.delete(key);
          if (!mountedRef.current) return;
          setPending((current) => {
            if (current.get(key)?.requestId !== requestId) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
        });
    },
    [
      access,
      busyLabelFor,
      call,
      clearRefusal,
      follow,
      gt,
      notify,
      refused,
      registry,
      retryNow,
      setEnabled,
      signIn,
      state.machines,
    ],
  );

  const addProject = useCallback(
    (machine: MachineView, project: LocalProject) => {
      void call("add_project", { id: machine.id, projectId: project.id }).then(
        () => {
          if (mountedRef.current) {
            notify(
              gt("{project} is on {machine}", { project: project.title, machine: machine.name }),
              "info",
            );
          }
        },
        (error) => {
          if (mountedRef.current) {
            notify(
              gt("Couldn't add {project} to {machine}: {error}", {
                project: project.title,
                machine: machine.name,
                error: errorText(error),
              }),
            );
          }
        },
      );
    },
    [call, gt, notify],
  );

  const controlsFor = useCallback(
    (machine: MachineView): MachineControls => {
      const key = machineKey(machine);
      const presentation = deriveMachineControls({
        machine,
        sizes: state.sizes,
        access,
        supportsLocalProjects,
        pendingLabel: pending.get(key)?.label ?? null,
        deleteRefusal: refused.get(key) ?? null,
        signingIn: signIn !== null,
      });
      return {
        ...presentation,
        request: (request) => dispatchAction(machine, request),
        onDismissDeleteError: () => clearRefusal(key),
        onAddProject: (project) => addProject(machine, project),
      };
    },
    [
      access,
      addProject,
      clearRefusal,
      dispatchAction,
      pending,
      refused,
      signIn,
      state.sizes,
      supportsLocalProjects,
    ],
  );

  const canCreate = access.can("create_machine");

  const create = useCallback(
    (input: CreateMachineInput) => {
      if (!canCreate) return;
      setLocation({ kind: "list" });
      void call("create_machine", {
        name: input.name,
        size: input.size,
        projects: input.projects,
      }).then(
        (reply) => {
          follow(reply.openUrl);
        },
        (error) => {
          if (mountedRef.current) notify(errorText(error));
        },
      );
    },
    [call, canCreate, follow, notify],
  );

  const saveSettings = useCallback(
    (settings: Settings) =>
      call("update_settings", { settings }).then(
        () => undefined,
        (error) => {
          if (mountedRef.current) notify(errorText(error));
        },
      ),
    [call, notify],
  );

  const addMcp = useCallback(
    (client: McpClient) =>
      call("add_mcp", { client }).then(
        () => undefined,
        (error) => {
          if (mountedRef.current) notify(errorText(error));
        },
      ),
    [call, notify],
  );

  const signOut = useCallback(
    () =>
      call("sign_out_boat", undefined).then(
        () => undefined,
        (error) => {
          if (mountedRef.current) notify(errorText(error));
        },
      ),
    [call, notify],
  );

  return {
    view,
    back,
    navigate,
    navigateToMachine,
    controlsFor,
    signIn,
    finishSignIn,
    canCreate,
    create,
    saveSettings,
    addMcp,
    signOut,
  };
}

function ReadyBody({
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

  const detailsError = useCallback(
    (text: string) => notify(gt("Couldn't load details: {error}", { error: text })),
    [gt, notify],
  );

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

  const pageTitle =
    view.kind === "list"
      ? gt("Boats")
      : view.kind === "new"
        ? gt("New machine")
        : view.kind === "settings"
          ? gt("Boat settings")
          : undefined;

  const pageSubtitle =
    view.kind === "list"
      ? gt("Cloud machines that sleep for free when no agent is working.")
      : undefined;

  const toolbar = (
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
      pageTitle={pageTitle}
      pageSubtitle={pageSubtitle}
      back={view.kind === "list" ? null : session.back}
      server={server}
      toolbar={toolbar}
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
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-sm font-semibold text-foreground">{gt("Machines")}</h2>
            <Badge size="sm" variant="secondary">
              <span className="font-mono tabular-nums">{state.machines.length}</span>
            </Badge>
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

function StartingSkeleton() {
  const gt = useGT();
  return (
    <SettingsGroup divided={false}>
      <div
        role="status"
        aria-label={gt("Starting Sail Boats")}
        className="divide-y divide-border/50"
      >
        {[0, 1].map((index) => (
          <div
            key={index}
            className={`${ITEM_ROW_CLASSNAME} flex items-center justify-between gap-4`}
            aria-hidden="true"
          >
            <div className="flex items-center gap-3">
              <Skeleton shape="card" className="size-9" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
            <Skeleton shape="card" className="h-6 w-20" />
          </div>
        ))}
      </div>
    </SettingsGroup>
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

  const access: BoatAccess = useMemo(
    () => ({
      environmentId,
      can: (command) => allowed.has(command),
      isPaired: (id) => {
        const entry = id === null ? undefined : entries.get(id);
        return entry?.enabled === true && entry.unsupportedReason === undefined;
      },
      onHost,
    }),
    [allowed, entries, environmentId, onHost],
  );

  const follow = useFollowBoatLink(onHost);
  const [notice, setNotice] = useState<Notice | null>(null);
  const timerRef = useRef<number | null>(null);

  const notify: Notify = useCallback((text, tone = "error") => {
    setNotice({ text, tone });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const dismissNotice = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setNotice(null);
  }, []);

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
        <ReadyBody
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
                  <h2>{gt("Boats isn't available here")}</h2>
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
          <SettingsGroup divided={false}>
            <div className="space-y-4 p-4 sm:p-5">
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-foreground">
                  {gt("Boat daemon offline")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {gt("Sail could not reach the Boat daemon on this server.")}
                </p>
              </div>
              <Alert variant="error">
                <AlertTriangleIcon aria-hidden="true" />
                <AlertDescription>{page.message}</AlertDescription>
              </Alert>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void retry().catch((error) => notify(errorText(error)))}
                >
                  {gt("Retry")}
                </Button>
              </div>
            </div>
          </SettingsGroup>
        </BoatsFrame>
      ) : (
        <BoatsFrame back={null} server={server} notice={notice} dismissNotice={dismissNotice}>
          <StartingSkeleton />
        </BoatsFrame>
      )}
    </BoatAccessContext>
  );
}

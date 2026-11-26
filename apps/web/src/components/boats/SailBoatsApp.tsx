import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { boatCommandsAllowedAtom } from "~/state/boats";
import { clientHostEnvironmentAtom } from "~/state/clientHostEnvironment";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { SailBrandMark } from "../SailBrandMark";
import { type BoatAccess, BoatAccessContext, useBoatAccess } from "./access";
import { call, useBoatsPage, useFollowBoatLink } from "./api";
import "./boats.css";
import { Costs } from "./components/Costs";
import { Icon } from "./components/Icons";
import { MachineDetails } from "./components/MachineDetails";
import { MachineRow } from "./components/MachineRow";
import { NewMachine } from "./components/NewMachine";
import { Ocean, type OceanBoat } from "./components/Ocean";
import { SettingsView } from "./components/SettingsView";
import { type SignInPrompt, SetupView } from "./components/SetupView";
import { Dots } from "./components/common";
import { machineKey, type Action } from "./machine";
import { errorText, type BoatLink } from "./reply";
import type { LocalProject, MachineView, McpClient, SetupAction, UiState } from "./types";

type View = "list" | "new" | "settings" | `machine:${string}`;

type FollowLink = (openUrl: string | undefined) => BoatLink;

const canOpen = (m: MachineView) => !!m.id && m.state !== "creating";

function without<V>(record: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _, ...rest } = record;
  return rest;
}

function Brand() {
  return (
    <div className="brand">
      <SailBrandMark className="size-4 shrink-0" aria-hidden="true" />
      <span className="brand-name">Sail Boats</span>
    </div>
  );
}

function Setup({
  state,
  follow,
  onError,
}: {
  state: UiState;
  follow: FollowLink;
  onError: (t: string) => void;
}) {
  // Only the tab that started the sign-in holds its page and code; other tabs see it busy.
  const [signIn, setSignIn] = useState<SignInPrompt | null>(null);
  if (signIn !== null && state.setup !== "signInBoat") setSignIn(null);

  const act = (action: SetupAction) =>
    void call("setup_action", { action }).then(
      (reply) => {
        const link = follow(reply.openUrl);
        if (action === "signInBoat" && link.kind === "browser")
          setSignIn({ url: link.url, userCode: reply.userCode ?? null });
      },
      (e) => onError(errorText(e)),
    );
  return (
    <>
      <Ocean boats={[{ key: "setup", name: "Sail", state: "creating" }]}>
        <Brand />
      </Ocean>
      <SetupView
        setup={state.setup}
        busy={state.setupBusy}
        signIn={state.setup === "signInBoat" && state.setupBusy ? signIn : null}
        onAction={act}
      />
    </>
  );
}

function Ready({
  state,
  follow,
  toast,
}: {
  state: UiState;
  follow: FollowLink;
  toast: (t: string, tone?: "error" | "info") => void;
}) {
  const access = useBoatAccess();
  const [view, setView] = useState<View>("list");
  const [pickProject, setPickProject] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [pending, setPending] = useState<Record<string, string>>({});
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const back = useCallback(() => setView("list"), []);
  const detailsError = useCallback(
    (text: string) => toast(`Couldn't load details: ${text}`),
    [toast],
  );

  const detailsId = view.startsWith("machine:") ? view.slice("machine:".length) : null;
  const selected = detailsId ? state.machines.find((m) => m.id === detailsId) : undefined;

  useEffect(() => {
    if (detailsId && !selected) setView("list");
  }, [detailsId, selected]);

  const boats: OceanBoat[] = useMemo(() => {
    const list: OceanBoat[] = state.machines.map((m) => ({
      key: machineKey(m),
      name: m.name,
      state: m.state,
      pickable: canOpen(m),
    }));
    if (view === "new")
      list.push({ key: "__draft", name: draftName, state: "creating", label: draftName || "new" });
    return list;
  }, [state.machines, view, draftName]);

  const openDetails = (m: MachineView, pick = false) => {
    setPickProject(pick);
    setView(`machine:${m.id}`);
  };

  const addProject = (m: MachineView, p: LocalProject) =>
    void call("add_project", { id: m.id, projectId: p.id }).then(
      () => toast(`${p.title} is on ${m.name}`, "info"),
      (e) => toast(`Couldn't add ${p.title} to ${m.name}: ${errorText(e)}`),
    );

  const pick = (key: string) => {
    const m = state.machines.find((x) => machineKey(x) === key);
    if (m && canOpen(m)) openDetails(m);
  };

  const track = (m: MachineView, busy: string, job: () => Promise<void>) => {
    const key = machineKey(m);
    setPending((p) => ({ ...p, [key]: busy }));
    void job()
      .catch((e) => toast(`${m.name}: ${errorText(e)}`))
      .finally(() => setPending((p) => without(p, key)));
  };

  const act = (m: MachineView, a: Action) =>
    track(m, a.busy, async () => {
      const key = machineKey(m);
      const pairIfAsked = (openUrl: string | undefined) => {
        if (follow(openUrl).kind === "pairing")
          toast(`Accept "${m.name}" to pair it with Sail`, "info");
      };
      switch (a.cmd) {
        case "delete_machine":
          setDeleteErrors((d) => without(d, key));
          try {
            await call("delete_machine", { id: m.id, discard: a.discard });
          } catch (e) {
            if (a.discard) throw e;
            setDeleteErrors((d) => ({ ...d, [key]: errorText(e) }));
          }
          return;
        case "sign_in_agent":
          await call("sign_in_agent", { id: m.id, agent: a.agent });
          toast(`${a.agent} is signed in on ${m.name}`, "info");
          return;
        case "turn_on_connect":
          await call("turn_on_connect", { id: m.id });
          toast(`${m.name} is reachable from your other devices`, "info");
          return;
        case "keep_awake":
          await call("keep_awake", { id: m.id, minutes: a.minutes });
          return;
        case "resize_machine":
          await call("resize_machine", { id: m.id, size: a.size });
          return;
        case "open_machine": {
          const reply = await call(
            "open_machine",
            a.thread !== undefined ? { id: m.id, thread: a.thread } : { id: m.id },
          );
          pairIfAsked(reply.openUrl);
          return;
        }
        default:
          pairIfAsked((await call(a.cmd, { id: m.id })).openUrl);
      }
    });

  const addMcp = (client: McpClient) =>
    call("add_mcp", { client }).then(
      () => undefined,
      (e) => toast(errorText(e)),
    );

  const create = (name: string, size: string, projects: string[]) => {
    setView("list");
    void call("create_machine", { name, size, projects }).then(
      (reply) => void follow(reply.openUrl),
      (e) => toast(errorText(e)),
    );
  };
  const canCreate = access.can("create_machine");

  return (
    <>
      <Ocean
        boats={boats}
        active={view === "new" ? "__draft" : selected ? machineKey(selected) : hover}
        compact={view !== "list"}
        {...(view === "new" ? {} : { onPick: pick })}
      >
        <Brand />
        <button
          type="button"
          className="btn btn-icon btn-on-sea"
          onClick={() => setView("settings")}
          aria-label="Boat settings"
        >
          <Icon name="sliders" />
        </button>
      </Ocean>

      {selected ? (
        <MachineDetails
          key={selected.id}
          machine={selected}
          sizes={state.sizes}
          version={state}
          pending={pending[machineKey(selected)] ?? null}
          deleteError={deleteErrors[machineKey(selected)] ?? null}
          pickProject={pickProject}
          onAction={(a) => act(selected, a)}
          onAddProject={(p) => addProject(selected, p)}
          onDismissDeleteError={() => setDeleteErrors((d) => without(d, machineKey(selected)))}
          onError={detailsError}
          onBack={back}
        />
      ) : view === "new" ? (
        <NewMachine state={state} onNameChange={setDraftName} onCreate={create} onBack={back} />
      ) : view === "settings" ? (
        <SettingsView
          state={state}
          onSave={(settings) =>
            void call("update_settings", { settings }).catch((e) => toast(errorText(e)))
          }
          onAddMcp={addMcp}
          onBack={back}
        />
      ) : (
        <div className="view">
          {state.machines.length === 0 ? (
            <div className="empty">
              <h1 className="display">No machines yet</h1>
              <p className="lede">
                A machine is a cloud computer your Sail agents work on. It sleeps when nobody's
                working, and sleeping is free.
              </p>
              <button
                type="button"
                className="btn btn-solid btn-lg"
                disabled={!canCreate}
                onClick={() => setView("new")}
              >
                <Icon name="plus" /> New machine
              </button>
            </div>
          ) : (
            <>
              <div className="list-head">
                <span className="caption">
                  machines <span className="count">{state.machines.length}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-solid"
                  disabled={!canCreate}
                  onClick={() => setView("new")}
                >
                  <Icon name="plus" size={12} /> New machine
                </button>
              </div>
              <ul className="list">
                {state.machines.map((m) => (
                  <MachineRow
                    key={machineKey(m)}
                    machine={m}
                    sizes={state.sizes}
                    pending={pending[machineKey(m)] ?? null}
                    deleteError={deleteErrors[machineKey(m)] ?? null}
                    onAction={(a) => act(m, a)}
                    onDismissDeleteError={() => setDeleteErrors((d) => without(d, machineKey(m)))}
                    onHover={setHover}
                    {...(canOpen(m)
                      ? { onOpen: (pick: boolean | undefined) => openDetails(m, pick) }
                      : {})}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {selected ? null : <Costs costs={state.costs} />}
    </>
  );
}

export function SailBoatsApp() {
  const environmentId = usePrimaryEnvironmentId();
  const { page, retry } = useBoatsPage(environmentId);
  const allowed = useAtomValue(boatCommandsAllowedAtom(environmentId));
  const onHost = useAtomValue(clientHostEnvironmentAtom(environmentId));
  const access: BoatAccess = { can: (command) => allowed.has(command), onHost };
  const follow = useFollowBoatLink(onHost);
  const [notice, setNotice] = useState<{ text: string; tone: "error" | "info" } | null>(null);
  const timer = useRef<number | null>(null);

  const toast = useCallback((text: string, tone: "error" | "info" = "error") => {
    setNotice({ text, tone });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <BoatAccessContext value={access}>
      <div className="sail-boats-scope" data-testid="sail-boats-workspace">
        <div className="app">
          {page.kind === "ready" ? (
            <Ready state={page.state} follow={follow} toast={toast} />
          ) : page.kind === "setup" ? (
            <Setup state={page.state} follow={follow} onError={toast} />
          ) : page.kind === "offline" ? (
            <>
              <Ocean boats={[{ key: "err", name: "Sail", state: "error" }]}>
                <Brand />
              </Ocean>
              <div className="view center">
                <div className="empty">
                  <h1 className="display">Boat daemon offline</h1>
                  <p className="lede">{page.message}</p>
                  <button
                    type="button"
                    className="btn btn-solid"
                    onClick={() => void retry().catch((e) => toast(errorText(e)))}
                  >
                    Retry
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <Ocean boats={[{ key: "boot", name: "Sail", state: "creating" }]}>
                <Brand />
              </Ocean>
              <div className="view center">
                <p className="caption">
                  <Dots /> starting Sail Boats
                </p>
              </div>
            </>
          )}

          {notice ? (
            <div className="toast" role="alert" onClick={() => setNotice(null)}>
              <Icon name={notice.tone === "error" ? "alert" : "check"} size={14} />
              <span>{notice.text}</span>
            </div>
          ) : null}
        </div>
      </div>
    </BoatAccessContext>
  );
}

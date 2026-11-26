import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { offered, useBoatAccess } from "../access";
import type { MachineView, Size } from "../types";
import {
  ACTIONS,
  machineKey,
  menuActions,
  needsProject,
  primaryAction,
  seedOf,
  signInTo,
  type Action,
  type MenuItem,
} from "../machine";
import { AgentName, AgentNames } from "./AgentLogos";
import { BoatIcon } from "./BoatIcon";
import { DeleteErrorNote, Dots, useArmed, useDetail } from "./common";
import { Icon } from "./Icons";

interface Props {
  machine: MachineView;
  sizes: Size[];
  /** label of the command currently running for this machine */
  pending: string | null;
  /** why the last delete was refused (work still running) */
  deleteError: string | null;
  onAction: (a: Action) => void;
  onDismissDeleteError: () => void;
  onHover: (key: string | null) => void;
  /** open this machine's details (`pickProject`: with the project picker open); omitted while it can't have any */
  onOpen?: (pickProject?: boolean) => void;
}

export function MachineRow({
  machine: m,
  sizes,
  pending,
  deleteError,
  onAction,
  onDismissDeleteError,
  onHover,
  onOpen,
}: Props) {
  const key = machineKey(m);
  const access = useBoatAccess();
  const paired = access.isPaired(m.environmentId);
  const primary = offered(access, primaryAction(m, paired));
  const detail = useDetail(m);
  const extra = menuActions(m, sizes, paired).filter((a) => "kind" in a || offered(access, a));
  const [armed, arm] = useArmed(); // two-step confirm for the primary "Remove"
  // "Add a project…" picks from Sail's projects in the details view
  const menuAction = (a: MenuItem) => ("kind" in a ? onOpen?.(true) : onAction(a));

  const runPrimary = () => {
    if (!primary) return;
    if (primary.cmd === "delete_machine") arm(() => onAction(primary));
    else onAction(primary);
  };

  return (
    <li
      className={`row state-${m.state}${onOpen ? " is-openable" : ""}`}
      onClick={(e) => {
        // anywhere on the row except its own controls (buttons, menu)
        if (onOpen && !(e.target as Element).closest("button:not(.row-name), [role=menu]"))
          onOpen();
      }}
      onMouseEnter={() => onHover(key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(key)}
      onBlur={() => onHover(null)}
    >
      <BoatIcon state={m.state} seed={seedOf(key)} />
      <div className="row-text">
        <div className="row-title">
          {onOpen ? (
            <button className="row-name" aria-label={`Details for ${m.name}`}>
              {m.name}
            </button>
          ) : (
            <span className="row-name">{m.name}</span>
          )}
          <span className="chip">{m.size}</span>
        </div>
        <div className="row-detail" title={detail}>
          {detail}
        </div>
      </div>
      <div className="row-actions">
        {pending ? (
          <span className="row-busy">
            <Dots /> {pending}
          </span>
        ) : primary ? (
          <button
            className={`btn btn-sm ${armed ? "btn-danger" : primary.solid ? "btn-solid" : "btn-outline"}`}
            disabled={!access.can(primary.cmd)}
            onClick={runPrimary}
          >
            {armed ? "Confirm" : primary.label}
          </button>
        ) : null}
        {m.id && !pending ? <RowMenu machine={m} actions={extra} onAction={menuAction} /> : null}
      </div>
      {deleteError ? (
        <DeleteErrorNote
          error={deleteError}
          busy={!!pending}
          onDeleteAnyway={() => onAction(ACTIONS.deleteAnyway)}
          onKeep={onDismissDeleteError}
        />
      ) : null}
      {m.id && m.signedOut.length ? (
        <div className="row-note">
          <span className="row-note-text">
            <AgentNames names={m.signedOut} /> {m.signedOut.length === 1 ? "needs" : "need"} a
            sign-in
          </span>
          {m.signedOut.map((agent) => (
            <button
              key={agent}
              className="btn btn-link"
              disabled={!!pending || !access.can("sign_in_agent")}
              onClick={() => onAction(signInTo(agent))}
            >
              {m.signedOut.length > 1 ? <AgentName name={agent} /> : "Sign in"}
            </button>
          ))}
        </div>
      ) : needsProject(m, paired) && onOpen ? (
        <div className="row-note">
          <span className="row-note-text">No projects yet</span>
          <button
            className="btn btn-link"
            disabled={!access.can("add_project")}
            onClick={() => onOpen(true)}
          >
            Add one
          </button>
        </div>
      ) : null}
      {m.projects
        .filter((p) => p.status)
        .map((p) => (
          <div key={p.id} className="row-note">
            <Dots />
            <span className="row-note-text" title={`${p.title} · ${p.status}`}>
              {p.title} · {p.status}
            </span>
          </div>
        ))}
    </li>
  );
}

const MENU_GAP = 4; // between button and menu
const MENU_MARGIN = 8; // menu ↔ window edge

function RowMenu({
  machine,
  actions,
  onAction,
}: {
  machine: MachineView;
  actions: MenuItem[];
  onAction: (a: MenuItem) => void;
}) {
  const access = useBoatAccess();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // anchored to the button's edge, opening toward the side with more room; scrolls if neither fits
  const [pos, setPos] = useState<{
    up: boolean;
    edge: number;
    right: number;
    maxHeight: number;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - MENU_GAP - MENU_MARGIN;
    const above = r.top - MENU_GAP - MENU_MARGIN;
    const up = menu.current.offsetHeight > below && above > below;
    setPos({
      up,
      edge: up ? window.innerHeight - r.top + MENU_GAP : r.bottom + MENU_GAP,
      right: window.innerWidth - r.right,
      maxHeight: up ? above : below,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (
        e.type !== "resize" &&
        e.type !== "keydown" &&
        (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))
      )
        return;
      setOpen(false);
      setConfirm(false);
      if (e instanceof KeyboardEvent) button.current?.focus();
    };
    // the menu is fixed-position: scrolling the list or resizing would leave it detached
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open && pos) menu.current?.querySelector("button")?.focus();
  }, [open, pos]);

  const choose = (a: MenuItem) => {
    setOpen(false);
    setConfirm(false);
    onAction(a);
  };

  return (
    <>
      <button
        ref={button}
        className={`btn btn-icon${open ? " is-open" : ""}`}
        aria-label={`More for ${machine.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          className={`menu${pos?.up ? " is-up" : ""}`}
          style={
            pos
              ? {
                  [pos.up ? "bottom" : "top"]: pos.edge,
                  right: pos.right,
                  maxHeight: pos.maxHeight,
                }
              : { visibility: "hidden" }
          }
        >
          <div className="menu-label">{machine.name}</div>
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              className="menu-item"
              disabled={!access.can("kind" in a ? "add_project" : a.cmd)}
              onClick={() => choose(a)}
            >
              {a.label}
            </button>
          ))}
          <div className="menu-sep" />
          <button
            role="menuitem"
            className={`menu-item danger${confirm ? " is-armed" : ""}`}
            disabled={!access.can("delete_machine")}
            onClick={() => (confirm ? choose(ACTIONS.del) : setConfirm(true))}
          >
            {confirm ? "Click again to delete forever" : "Delete machine…"}
          </button>
        </div>
      ) : null}
    </>
  );
}

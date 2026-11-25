import { useEffect, useReducer, useState } from "react";
import { timeLeft } from "../machine";
import type { MachineView } from "../types";

export function Dots() {
  return (
    <span className="dots" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * Whole seconds left until `endsAt` (unix ms). Re-renders only when `timeLeft` would change:
 * every second in the last minute, otherwise on the minute.
 */
export function useSecsLeft(endsAt: number | null): number {
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const ms = endsAt === null ? 0 : endsAt - Date.now();
  useEffect(() => {
    if (ms <= 0) return;
    const unit = ms <= 60_000 ? 1000 : 60_000;
    const t = setTimeout(bump, ms % unit || unit);
    return () => clearTimeout(t);
  }, [endsAt, tick]); // `ms` is read fresh each render
  return Math.max(0, Math.ceil(ms / 1000));
}

/** The machine's detail line, ticking while it counts down. */
export function useDetail(m: MachineView): string {
  const secs = useSecsLeft(m.countdown?.endsAt ?? null);
  return m.countdown ? m.countdown.template.replace("{left}", timeLeft(secs)) : m.detail;
}

/** Escape closes an open disclosure first: capture phase, so the view's own Escape ("back") sees it handled. */
export function useEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onEscape]);
}

/** Two-step confirm: first click arms for 3s, second click runs. */
export function useArmed(): [boolean, (run: () => void) => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return [
    armed,
    (run) => {
      if (!armed) return setArmed(true);
      setArmed(false);
      run();
    },
  ];
}

/** Why the last delete was refused, with "Delete anyway" / "Keep". */
export function DeleteErrorNote({
  error,
  busy,
  onDeleteAnyway,
  onKeep,
}: {
  error: string;
  busy: boolean;
  onDeleteAnyway: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="row-note is-danger" role="alert">
      <span className="row-note-text">{error}</span>
      <button className="btn btn-sm btn-danger" disabled={busy} onClick={onDeleteAnyway}>
        Delete anyway
      </button>
      <button className="btn btn-sm btn-quiet" onClick={onKeep}>
        Keep
      </button>
    </div>
  );
}

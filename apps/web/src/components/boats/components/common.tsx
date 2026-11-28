import { useEffect, useReducer } from "react";
import { timeLeft } from "../machine";
import type { MachineView } from "../types";

export function useSecsLeft(endsAt: number | null): number {
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const ms = endsAt === null ? 0 : endsAt - Date.now();
  useEffect(() => {
    if (ms <= 0) return;
    const unit = ms <= 60_000 ? 1000 : 60_000;
    const timer = window.setTimeout(bump, ms % unit || unit);
    return () => window.clearTimeout(timer);
  }, [endsAt, tick, ms]);
  return Math.max(0, Math.ceil(ms / 1000));
}

export function useDetail(m: MachineView): string {
  const secs = useSecsLeft(m.countdown?.endsAt ?? null);
  return m.countdown ? m.countdown.template.replace("{left}", timeLeft(secs)) : m.detail;
}

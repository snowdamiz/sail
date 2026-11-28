import { secondTick } from "@t3tools/client-runtime/clock";
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { timeLeft } from "../machine";
import type { MachineView } from "../types";

const NOOP_SUBSCRIBE = () => () => {};
const ZERO_SNAPSHOT = () => 0;

export function useIsMountedRef(): RefObject<boolean> {
  const mountedRef = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks component mount lifetime for in-flight async RPC guards
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

export function useSecsLeft(endsAt: number | null): number {
  const now = useSyncExternalStore(
    endsAt === null ? NOOP_SUBSCRIBE : secondTick.subscribe,
    endsAt === null ? ZERO_SNAPSHOT : secondTick.getSnapshot,
    endsAt === null ? ZERO_SNAPSHOT : secondTick.getSnapshot,
  );
  if (endsAt === null) return 0;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export function useDetail(m: MachineView): string {
  const secs = useSecsLeft(m.countdown?.endsAt ?? null);
  return m.countdown ? m.countdown.template.replace("{left}", timeLeft(secs)) : m.detail;
}

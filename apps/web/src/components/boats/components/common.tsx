import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { timeLeft } from "../machine";
import type { MachineView } from "../types";

const MAX_TIMEOUT_MS = 2_147_483_647;
const NOOP_SUBSCRIBE = () => () => {};
const ZERO_SNAPSHOT = () => 0;

interface CountdownStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

interface CountdownEntry {
  readonly store: CountdownStore;
  readonly listeners: Set<() => void>;
  value: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const ZERO_COUNTDOWN_STORE: CountdownStore = {
  subscribe: NOOP_SUBSCRIBE,
  getSnapshot: ZERO_SNAPSHOT,
};

const countdowns = new Map<number, CountdownEntry>();

export function sampleCountdown(
  endsAt: number,
  now = Date.now(),
): { readonly value: number; readonly nextDelayMs: number | null } {
  if (!Number.isFinite(endsAt) || !Number.isFinite(now)) {
    return { value: 0, nextDelayMs: null };
  }
  const remainingMs = endsAt - now;
  if (remainingMs <= 0) return { value: 0, nextDelayMs: null };
  if (remainingMs <= 60_000) {
    const secs = Math.ceil(remainingMs / 1000);
    return {
      value: secs,
      nextDelayMs: Math.min(Math.max(1, remainingMs - (secs - 1) * 1000), MAX_TIMEOUT_MS),
    };
  }
  const mins = Math.ceil(remainingMs / 60_000);
  return {
    value: mins * 60,
    nextDelayMs: Math.min(Math.max(1, remainingMs - (mins - 1) * 60_000), MAX_TIMEOUT_MS),
  };
}

function scheduleCountdown(entry: CountdownEntry, endsAt: number, delayMs: number | null) {
  if (delayMs === null) {
    entry.timer = undefined;
    if (entry.value !== 0) {
      entry.value = 0;
      for (const listener of entry.listeners) listener();
    }
    return;
  }
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (entry.listeners.size === 0) return;
    const sample = sampleCountdown(endsAt);
    const changed = sample.value !== entry.value;
    entry.value = sample.value;
    if (changed) {
      for (const listener of entry.listeners) listener();
    }
    if (entry.listeners.size > 0 && entry.timer === undefined) {
      scheduleCountdown(entry, endsAt, sample.nextDelayMs);
    }
  }, delayMs);
}

function countdownStore(endsAt: number | null): CountdownStore {
  if (endsAt === null || !Number.isFinite(endsAt)) return ZERO_COUNTDOWN_STORE;
  const existing = countdowns.get(endsAt);
  if (existing !== undefined) return existing.store;

  const store: CountdownStore = {
    subscribe: (listener) => {
      let entry = countdowns.get(endsAt);
      if (entry === undefined) {
        const sample = sampleCountdown(endsAt);
        entry = {
          store,
          listeners: new Set([listener]),
          value: sample.value,
          timer: undefined,
        };
        countdowns.set(endsAt, entry);
        scheduleCountdown(entry, endsAt, sample.nextDelayMs);
      } else {
        entry.listeners.add(listener);
      }
      const joined = entry;
      return () => {
        joined.listeners.delete(listener);
        if (joined.listeners.size > 0) return;
        clearTimeout(joined.timer);
        joined.timer = undefined;
        if (countdowns.get(endsAt) === joined) countdowns.delete(endsAt);
      };
    },
    getSnapshot: () => countdowns.get(endsAt)?.value ?? sampleCountdown(endsAt).value,
  };
  return store;
}

export function useIsMountedRef(): RefObject<boolean> {
  const mountedRef = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks commit-time component mount lifetime for in-flight async RPC guards
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

export function useSecsLeft(endsAt: number | null): number {
  const store = countdownStore(endsAt);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, ZERO_SNAPSHOT);
}

export function useDetail(m: MachineView): string {
  const secs = useSecsLeft(m.countdown?.endsAt ?? null);
  return m.countdown ? m.countdown.template.replace("{left}", timeLeft(secs)) : m.detail;
}

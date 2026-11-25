// One shared, throttled animation clock for every pixel canvas. Pixel art looks
// best stepped, so we tick at 12 fps. Reduced motion: no clock at all.
import { useEffect, useSyncExternalStore } from "react";
import type { Theme } from "./palette";

const FPS = 12;
const subs = new Set<(t: number) => void>();
let raf = 0;
let last = 0;
const clock = () => performance.now() / 1000;

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  if (document.hidden || now - last < 1000 / FPS) return;
  last = now;
  const t = clock();
  subs.forEach((f) => f(t));
}

function subscribe(f: (t: number) => void) {
  subs.add(f);
  if (subs.size === 1) raf = requestAnimationFrame(frame);
  return () => {
    subs.delete(f);
    if (subs.size === 0) cancelAnimationFrame(raf);
  };
}

// Stores read the window only when used, so the site can render these components ahead of time.
const off = () => false;

function mediaStore(query: string) {
  return {
    subscribe: (cb: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    get: () => window.matchMedia(query).matches,
  };
}

const motionStore = mediaStore("(prefers-reduced-motion: reduce)");
const darkStore = mediaStore("(prefers-color-scheme: dark)");

export function useReducedMotion(): boolean {
  return useSyncExternalStore(motionStore.subscribe, motionStore.get, off);
}

// re-armed on every change: a resolution query only matches the ratio it was made for
const dprStore = {
  subscribe: (cb: () => void) => {
    let mq: MediaQueryList;
    const watch = () => {
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener("change", changed);
    };
    const changed = () => {
      mq.removeEventListener("change", changed);
      watch();
      cb();
    };
    watch();
    return () => mq.removeEventListener("change", changed);
  },
  get: () => window.devicePixelRatio,
};

/** Device px per CSS px; follows the window between screens. */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(dprStore.subscribe, dprStore.get, () => 1);
}

export function useTheme(): Theme {
  return useSyncExternalStore(darkStore.subscribe, darkStore.get, off) ? "dark" : "light";
}

/**
 * Calls `draw(t)` on every tick, or once with `null` under reduced motion.
 * Redraws whenever `deps` change.
 */
export function useAnimation(draw: (t: number | null) => void, deps: unknown[]) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) {
      draw(null);
      return;
    }
    draw(clock());
    return subscribe(draw);
  }, [reduced, ...deps]);
}

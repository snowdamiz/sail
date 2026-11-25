// Whole pictures from the pixel parts: the sea strip and a row's boat icon. Pure
// drawing on a `t` clock, apart from the components that animate them.
import type { MachineState } from "../types";
import { seedOf } from "../machine";
import { drawBoat, poseFor, type Anchor } from "./boat";
import { palettes, type Theme } from "./palette";
import { CLEAR, hash, ramp, type Px } from "./px";
import { drawScene } from "./scene";

/** The sea strip's size in CSS px. */
const STRIP_W = 380;
const STRIP_H = 148;
const MARGIN = 18; // scene px kept free of boats at either end
const SLOT = 19; // scene px a boat needs; fewer and the sea zooms out, then scrolls
const SCROLL_SLOT = 24; // a scrolling sea spreads boats out: a clearly wider sea, room to sail

export interface Sea {
  /** CSS px per scene px: 2 close up … 1 zoomed out */
  scale: number;
  /** scene size in px */
  w: number;
  h: number;
  /** wider than the strip: it scrolls */
  scrolls: boolean;
  boats: { cx: number; wy: number; room: number }[];
}

/**
 * Zoom and room for `n` boats on a `dpr` screen: as close up as they fit, zooming out
 * only in steps that keep pixels crisp, then a sea wider than the strip.
 */
export function seaFor(n: number, dpr: number): Sea {
  const scales = Number.isInteger(1.5 * dpr) ? [2, 1.5, 1] : [2, 1];
  const need = 2 * MARGIN + n * SLOT;
  const scale = scales.find((s) => need <= Math.floor(STRIP_W / s)) ?? 1;
  const k = 2 / scale;
  const fit = Math.ceil(STRIP_W / scale);
  const scrolls = need > fit;
  const w = scrolls ? 2 * MARGIN + n * SCROLL_SLOT : fit;
  const slot = (w - 2 * MARGIN) / n;
  return {
    scale,
    w,
    h: Math.ceil(STRIP_H / scale),
    scrolls,
    boats: Array.from({ length: n }, (_, i) => ({
      cx: Math.round(MARGIN + slot * (i + 0.5)),
      wy: Math.round(k * (n === 1 ? 54 : 52 + (i % 2) * 4)),
      room: Math.max(0, Math.min(7, Math.floor((slot - 18) / 2))),
    })),
  };
}

/**
 * Draws `sea` with `boats` at `t` seconds (`null`: reduced motion's still frame) into a
 * `sea.w`×`sea.h` buffer. Returns where each boat's mast top sits, in scene pixels, for its tag.
 */
export function paintSea(
  px: Px,
  sea: Sea,
  theme: Theme,
  boats: { key: string; state: MachineState }[],
  t: number | null,
) {
  const pal = palettes[theme];
  const time = t ?? 0;
  drawScene(px, 2 / sea.scale, pal, theme, time);
  const anchors = new Map<string, Anchor>();
  // back row first so nearer boats overlap farther ones
  const order = boats
    .flatMap((b, i) => {
      const s = sea.boats[i];
      return s ? [{ b, s }] : [];
    })
    .sort((a, z) => a.s.wy - z.s.wy);
  for (const { b, s } of order) {
    anchors.set(
      b.key,
      drawBoat(px, s.cx, s.wy, pal, poseFor(b.state, t, seedOf(b.key), s.room), time),
    );
  }
  return anchors;
}

export const ICON_W = 24;
export const ICON_H = 21;
const WATERLINE = 17;

/** Draws an `ICON_W`×`ICON_H` boat on its own patch of water at `t` seconds (`null`: still frame). */
export function paintBoatIcon(
  px: Px,
  theme: Theme,
  state: MachineState,
  seed: number,
  t: number | null,
) {
  const pal = palettes[theme];
  const time = t ?? 0;
  px.fill(CLEAR);
  const frame = Math.floor(time * 2 + seed * 10);
  for (let y = WATERLINE + 1; y < ICON_H; y++) {
    for (let x = 0; x < ICON_W; x++) {
      const edge = Math.min(x, ICON_W - 1 - x) / 5 - (y - WATERLINE - 1) * 0.22;
      if (edge < hash(x, y, 1) * 0.6) continue;
      const streak = hash((x + frame) >> 2, y, 5) > 0.7 ? -1.2 : 0;
      const idx = pal.waterTo - 1.6 + (y - WATERLINE) * 0.4 + streak;
      px.set(x, y, ramp(pal.water, idx / (pal.water.length - 1), x, y));
    }
  }
  drawBoat(px, ICON_W / 2, WATERLINE, pal, poseFor(state, t, seed, 0), time);
}

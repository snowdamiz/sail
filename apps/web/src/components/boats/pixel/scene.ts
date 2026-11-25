// The ocean strip: dithered sky, a lighthouse, streaky water fading into the page.
import type { Palette, Theme } from "./palette";
import { bayer, hash, ramp, type Px } from "./px";

/**
 * Zoom-out of a scene: 1 = the close-up strip, 2 = twice as much sea in the same space.
 * Distances grow with it, things keep their pixel size. One number zooms everything;
 * or sideways, the sky above the horizon and the sea below it each get their own, with
 * `top` rows of plain sky above the scene.
 */
export type Zoom = number | { x: number; sky: number; sea: number; top?: number };

/** In the close-up strip: the horizon's row, and the rows of sea below it. */
const HORIZON = 32;

/** Where things sit in a `w`-wide scene at `zoom`. */
function geometry(w: number, zoom: Zoom) {
  const k = typeof zoom === "number" ? { x: zoom, sky: zoom, sea: zoom } : zoom;
  const top = k.top ?? 0;
  const atX = (v: number) => Math.round(v * k.x);
  const inSky = (v: number) => top + Math.round(v * k.sky);
  const horizon = inSky(HORIZON);
  return {
    top, // the sky's gradient starts here
    horizon,
    deep: horizon + Math.round(22 * k.sea), // deepest water row; below it the sea lightens into the page
    dissolve: Math.round(7 * k.sea), // bottom rows that dither away into the page background
    haze: inSky(21), // haze bands drift below this row
    sun: { x: atX(112), y: horizon - 3 },
    moon: { x: atX(116), y: inSky(10) },
    lighthouse: w - atX(32),
  };
}
type Geometry = ReturnType<typeof geometry>;

/** A block of scene px, ends exclusive. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Scene px around a calm rect kept clear of sky detail. */
const PAD = 3;
/** Scene px beyond that over which stars thin in; clouds, solid things, fade in over less. */
const STAR_FEATHER = 8;
const CLOUD_FEATHER = 3;

/** How clear of `calm` a box (ends exclusive) stands: 0 within PAD of it, 1 from `feather` beyond that. */
function clearance(
  calm: Rect[],
  feather: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let c = 1;
  for (const r of calm) {
    const gap = Math.max(r.x0 - x1, x0 - r.x1, r.y0 - y1, y0 - r.y1, 0);
    c = Math.min(c, (gap - PAD) / feather);
  }
  return c;
}

/** Sky px per cloud. */
const CLOUD_AREA = 4500;

/** Flat-bottomed puffs drifting right, spread down the sky, smaller and slower towards the horizon. */
function drawClouds(px: Px, g: Geometry, pal: Palette, time: number, calm: Rect[]) {
  const { w } = px;
  const rows = g.horizon - 14;
  if (rows <= 0) return;
  const count = Math.max(1, Math.round((w * rows) / CLOUD_AREA));
  for (let i = 0; i < count; i++) {
    // one per band of rows, so they don't bunch up
    const base = 8 + Math.round(((i + hash(i, 41)) / count) * rows);
    const near = 1 - (0.5 * base) / g.horizon;
    const width = Math.round((20 + hash(i, 42) * 22) * near);
    const speed = (0.5 + hash(i, 43) * 0.6) * near;
    const period = w + 2 * width;
    const cx = ((hash(i, 44) * period + time * speed) % period) - width;
    // the middle puffs tower over the ends
    const puffs = [0, 1, 2, 3].map((k) => ({
      x: cx + ((k + 0.5) / 4 - 0.5) * width * 0.75,
      r: width * (0.13 + hash(i, k, 45) * 0.1 + (k === 1 || k === 2 ? 0.07 : 0)),
    }));
    const tall = Math.max(...puffs.map((p) => p.r));
    const [x0, x1, y0] = [
      Math.floor(cx - width / 2),
      Math.ceil(cx + width / 2),
      Math.floor(base - tall),
    ];
    // near text the whole cloud thins out, so none is left half eaten
    const fade = clearance(calm, CLOUD_FEATHER, x0, y0, x1 + 1, base + 1);
    if (fade <= 0) continue;
    for (let y = y0; y <= base; y++) {
      const v = base - y;
      for (let x = x0; x <= x1; x++) {
        if (bayer(x, y) >= fade || !puffs.some((p) => (x - p.x) ** 2 + v ** 2 <= p.r ** 2))
          continue;
        px.set(x, y, ramp(pal.cloud, 1 - v / (tall * 0.7), x, y));
      }
    }
  }
}

function skyT(
  g: Geometry,
  x: number,
  y: number,
  time: number,
  theme: Theme,
  lampOn: boolean,
): number {
  let t = Math.pow(Math.max(0, y - g.top) / (g.horizon - g.top), theme === "light" ? 2.6 : 1.3);

  // drifting haze bands, like long exposure clouds
  if (y > g.haze) {
    const len = 12 + hash(y, 1) * 22;
    const seg = Math.floor((x + time * (0.6 + hash(y, 2)) + hash(y, 3) * 400) / len);
    if (y % 3 !== 0 && hash(seg, y, 7) > 0.78) t += theme === "light" ? 0.22 : 0.12;
  }

  if (theme === "light") {
    const d = Math.hypot((x - g.sun.x) / 1.8, y - g.sun.y);
    if (d < 16) t = Math.max(t, 1.05 - d / 22);
  } else {
    const d = Math.hypot(x - g.moon.x, y - g.moon.y);
    if (d < 11) t += (1 - d / 11) * 0.35;
    if (lampOn) {
      // beam sweeping left from the lamp
      const dx = g.lighthouse - x;
      const dy = y - (g.horizon - 16);
      if (dx > 2 && dx < 70 && Math.abs(dy) < 1 + dx * 0.09) t += 0.45 * (1 - dx / 70);
    }
  }
  return t;
}

/** Fills `px` with the scene at `zoom`; `calm` blocks (text on the sky) stay clear of stars and clouds. */
export function drawScene(
  px: Px,
  zoom: Zoom,
  pal: Palette,
  theme: Theme,
  time: number,
  calm: Rect[] = [],
) {
  const { w, h } = px;
  const g = geometry(w, zoom);
  const { horizon, sun, moon } = g;
  const lampOn = time % 3 < 1.6;

  for (let y = 0; y < horizon; y++) {
    for (let x = 0; x < w; x++) {
      px.set(x, y, ramp(pal.sky, skyT(g, x, y, time, theme, lampOn), x, y));
    }
  }

  if (pal.cloud.length) drawClouds(px, g, pal, time, calm);

  if (theme === "light") {
    for (let y = sun.y - 3; y <= sun.y + 3; y++)
      for (let x = sun.x - 3; x <= sun.x + 3; x++)
        if (Math.hypot(x - sun.x, y - sun.y) <= 2.6) px.set(x, y, pal.glow[0]!);
  } else {
    for (let y = 0; y < horizon - 6; y++)
      for (let x = 0; x < w; x++) {
        const s = hash(x, y, 3);
        if (s > 0.984 && hash(x, y, 17) < clearance(calm, STAR_FEATHER, x, y, x + 1, y + 1)) {
          const twinkle = hash(x, y, Math.floor(time * 1.5 + s * 40)) > 0.8;
          px.set(x, y, pal.star[twinkle ? 2 : s > 0.995 ? 0 : 1]!);
        }
      }
    for (let y = moon.y - 5; y <= moon.y + 5; y++)
      for (let x = moon.x - 5; x <= moon.x + 5; x++) {
        const d = Math.hypot(x - moon.x, y - moon.y);
        if (d <= 4.2)
          px.set(
            x,
            y,
            Math.hypot(x - moon.x - 1.6, y - moon.y + 1) < 2 && d > 1 ? pal.glow[1]! : pal.glow[0]!,
          );
      }
  }

  // far island on the left
  for (let x = 0; x < 46; x++) {
    const height = Math.floor(Math.sin((x / 46) * Math.PI) * 4 + hash(x >> 2, 9) * 1.6);
    for (let i = 1; i <= height; i++) px.set(x, horizon - i, pal.shore);
  }

  // lighthouse on a rock
  const L = g.lighthouse;
  for (let x = L - 9; x <= L + 9; x++) px.set(x, horizon, pal.tower);
  for (let x = L - 7; x <= L + 7; x++) px.set(x, horizon - 1, pal.tower);
  for (let x = L - 4; x <= L + 5; x++) px.set(x, horizon - 2, pal.tower);
  for (let i = 3; i <= 13; i++) {
    const half = i <= 8 ? 2 : 1;
    const stripe = (i - 3) % 4 >= 2;
    for (let x = L - half; x <= L + half; x++)
      px.set(x, horizon - i, stripe ? pal.towerStripe : pal.tower);
  }
  for (let x = L - 2; x <= L + 2; x++) px.set(x, horizon - 14, pal.tower);
  for (let x = L - 1; x <= L + 1; x++) {
    px.set(x, horizon - 15, lampOn ? pal.lamp : pal.tower);
    px.set(x, horizon - 16, lampOn ? pal.lamp : pal.towerStripe);
  }
  px.set(L, horizon - 17, pal.tower);

  // water
  const span = pal.waterTo - pal.waterFrom;
  const last = pal.water.length - 1;
  const glint = theme === "light" ? sun.x : moon.x;
  for (let y = horizon + 1; y < h; y++) {
    const d = Math.min((y - horizon) / (g.deep - horizon), 1);
    const len = 3 + d * 12 + hash(y, 4) * 5;
    const speed = 0.8 + d * 3.5 + hash(y, 5);
    const off = hash(y, 6) * 500;
    const shallow = y > g.deep ? (y - g.deep) / (h - 1 - g.deep) : 0;
    const base =
      pal.waterFrom +
      span * Math.pow(d, 0.8) +
      (pal.waterFade - pal.waterTo) * Math.pow(shallow, 1.4);
    const fade = (y - (h - 1 - g.dissolve)) / g.dissolve;
    for (let x = 0; x < w; x++) {
      if (y === h - 1) {
        px.set(x, y, pal.bg);
        continue;
      }
      if (fade > 0) {
        const jag = (hash(x >> 2, 4) - 0.5) * 0.5 + (hash(x, y, 4) - 0.5) * 0.25;
        if (fade + jag > bayer(x, y)) {
          px.set(x, y, pal.bg);
          continue;
        }
      }
      let idx = base;
      const seg = Math.floor((x + time * speed + off) / len);
      const r = hash(seg, y, 11);
      if (r > 0.94) idx -= 2.5;
      else if (r > 0.76) idx -= 1.3;
      else if (r < 0.1) idx += 0.8;
      const reach = 3 + d * 12;
      if (Math.abs(x - glint) < reach && hash(seg, y, Math.floor(time * 3)) > 0.55)
        idx -= 1.6 * (1 - d * 0.6);
      px.set(x, y, ramp(pal.water, idx / last, x, y));
    }
  }
}

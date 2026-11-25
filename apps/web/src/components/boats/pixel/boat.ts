// Procedural pixel sailboat. Local sprite space: 16px hull, bow to the right,
// ly = 0 is the waterline, negative ly goes up the mast.
import type { MachineState } from "../types";
import type { Palette } from "./palette";
import { hash, Px, type Color } from "./px";

export interface Pose {
  sail: number; // 0 lowered … 1 fully up
  build: number; // 0 nothing … 1 finished hull + mast + sails
  tilt: number; // listing (radians-ish)
  flag: boolean;
  dim: boolean;
  ghost: boolean;
  wake: boolean;
  zzz: number[]; // rise 0…1 of each z drifting off a sleeping boat
  dx: number;
  dy: number;
  flip: boolean;
}

const BASE: Pose = {
  sail: 1,
  build: 1,
  tilt: 0,
  flag: false,
  dim: false,
  ghost: false,
  wake: false,
  zzz: [],
  dx: 0,
  dy: 0,
  flip: false,
};

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const ease = (v: number) => 1 - (1 - v) * (1 - v);
/** 0→1 over `rise` seconds, then hold until `period` and repeat. */
const loop = (t: number, rise: number, period: number) => ease(clamp01((t % period) / rise));

/**
 * @param t seconds; `null` = reduced motion (a single telling still frame)
 * @param seed per-boat phase offset
 * @param room horizontal px the boat may drift either way while sailing
 */
export function poseFor(state: MachineState, t: number | null, seed: number, room: number): Pose {
  const still = t === null;
  const time = (t ?? 0) + seed * 7.3;
  switch (state) {
    case "working": {
      if (still) return { ...BASE, wake: true };
      const phase = (time * 2 * Math.PI) / 18;
      return {
        ...BASE,
        wake: true,
        dx: Math.round(Math.sin(phase) * room),
        flip: Math.cos(phase) < 0,
        dy: Math.round(Math.sin(time * Math.PI) * 0.8),
      };
    }
    case "idle":
      return BASE;
    case "sleeping":
      return { ...BASE, sail: still ? 0.4 : 1 - loop(time, 1.8, 2.6) };
    case "asleep":
      return {
        ...BASE,
        sail: 0,
        dim: true,
        zzz: still ? [0.3, 0.7] : [0, 0.5].map((k) => (time / 3.6 + k) % 1),
      };
    case "waking":
      return { ...BASE, sail: still ? 0.6 : loop(time, 1.6, 2.4) };
    case "creating":
      return { ...BASE, build: still ? 0.55 : clamp01((time % 4.2) / 3.4) };
    case "error":
      return { ...BASE, tilt: 0.17, flag: true, sail: 0.75 };
    case "missing":
      return { ...BASE, ghost: true, dim: true };
    case "unknown":
      return { ...BASE, sail: 0.5, dim: true };
  }
}

const MAST_TOP = -16;
const Z_SMALL = ["###", ".#.", "#..", "###"];
const Z_BIG = ["####", "..#.", ".#..", "#...", "####"];
const MAIN_ROWS = 12; // ly -15 … -4
const JIB_ROWS = 10; // ly -13 … -4

export interface Anchor {
  x: number; // mast x in buffer px
  y: number; // top of mast in buffer px
}

/** Draw a boat whose hull centre is at buffer x `cx`, waterline at buffer y `wy`. */
export function drawBoat(
  px: Px,
  cx: number,
  wy: number,
  pal: Palette,
  pose: Pose,
  t: number,
): Anchor {
  const c = pose.dim ? pal.boatAsleep : pal.boat;
  const ox = cx - 8 + pose.dx;
  const oy = wy + pose.dy;
  const lean = pose.tilt;

  const put = (lx: number, ly: number, col: Color) => {
    if (pose.flip) lx = 15 - lx;
    // two per-row / per-column shears: hole-free fake rotation
    const sx = lx + Math.round(-(ly + 2) * lean * 0.6);
    const sy = ly + Math.round((sx - 8) * lean);
    const X = ox + sx;
    const Y = oy + sy;
    if (pose.ghost && (X + Y) & 1) return;
    px.set(X, Y, col);
  };

  const hullCols = Math.ceil(16 * clamp01(pose.build / 0.45));
  const mastLen = Math.round(14 * clamp01((pose.build - 0.45) / 0.2));
  const sail = Math.min(pose.sail, clamp01((pose.build - 0.65) / 0.3));
  const built = pose.build >= 1;

  // reflection, broken up by the water
  if (built && !pose.ghost) {
    const frame = Math.floor(t * 3);
    for (let lx = 2; lx <= 13; lx++) {
      if (hash(lx, 1, frame) > 0.45) put(lx, 1, pal.reflection);
      if (lx > 2 && lx < 13 && hash(lx, 2, frame) > 0.6) put(lx, 2, pal.reflection);
      if (sail > 0.5 && lx > 3 && lx < 13 && hash(lx, 4, frame) > 0.75)
        put(lx, 3 + (lx & 1), pal.sailReflection);
    }
  }

  // scaffold while under construction
  if (pose.build < 0.7) {
    for (let ly = -1; ly >= -8; ly--) {
      if (ly & 1) continue;
      put(-2, ly, c.mast);
      put(17, ly, c.mast);
    }
    for (let lx = -2; lx <= 17; lx += 2) put(lx, -9, c.mast);
  }

  // hull
  for (let lx = 0; lx < hullCols; lx++) {
    put(lx, -2, c.deck);
    if (lx >= 1 && lx <= 14) put(lx, -1, c.hull);
    if (lx >= 3 && lx <= 13) put(lx, 0, c.keel);
  }
  if (!built && hullCols < 16 && hash(hullCols, Math.floor(t * 8)) > 0.3)
    put(hullCols, -2, pal.foam);

  // mast + boom
  for (let i = 0; i < mastLen; i++) put(8, -3 - i, c.mast);
  if (mastLen > 0) for (let lx = 2; lx < 8; lx++) put(lx, -3, c.mast);

  // sails
  const mainH = Math.round(MAIN_ROWS * sail);
  const jibH = Math.round(JIB_ROWS * sail);
  if (mastLen === 14 && mainH === 0) {
    for (let lx = 3; lx <= 7; lx++) put(lx, -4, c.sailShade);
    for (let lx = 5; lx <= 7; lx++) put(lx, -5, c.sailShade);
  }
  for (let r = 0; r < mainH; r++) {
    const src = mainH === 1 ? MAIN_ROWS - 1 : Math.round((r * (MAIN_ROWS - 1)) / (mainH - 1));
    const w = 1 + Math.floor((src * 6) / 11);
    const ly = -4 - (mainH - 1) + r;
    for (let k = 0; k < w; k++) put(7 - k, ly, k === w - 1 && w > 2 ? c.sailShade : c.sail);
  }
  for (let r = 0; r < jibH; r++) {
    const src = jibH === 1 ? JIB_ROWS - 1 : Math.round((r * (JIB_ROWS - 1)) / (jibH - 1));
    const w = 1 + Math.floor((src * 5) / 9);
    const ly = -4 - (jibH - 1) + r;
    for (let k = 0; k < w; k++) put(9 + k, ly, c.sailShade);
  }

  if (pose.flag && mastLen === 14) {
    put(9, MAST_TOP, pal.flag);
    put(10, MAST_TOP, pal.flag);
    put(11, MAST_TOP, pal.flag);
    put(9, MAST_TOP + 1, pal.flag);
    put(10, MAST_TOP + 1, pal.flag);
    put(8, MAST_TOP, c.mast);
  }

  // z's drifting up through the empty jib space
  for (const p of pose.zzz) {
    if (p > 0.9) continue;
    const glyph = p < 0.45 ? Z_SMALL : Z_BIG;
    const gx = 10 + Math.round(p * 3);
    const gy = -5 - Math.round(p * 6) - glyph.length; // tops out at the masthead
    glyph.forEach((row, r) =>
      [...row].forEach((ch, col) => ch === "#" && put(gx + col, gy + r, c.mast)),
    );
  }

  // wake: foam trailing the stern, a splash at the bow
  if (pose.wake) {
    const f = Math.floor(t * 6);
    const trail = [-1, -2, -4, -5, -7, -10];
    trail.forEach((lx, i) => {
      if (hash(i, f, 3) > 0.3 + i * 0.08) put(lx, 0, pal.foam);
    });
    if (hash(f, 9) > 0.5) put(-1, -1, pal.foam);
    if (hash(f, 13) > 0.4) put(15, 0, pal.foam);
  }

  const topY = oy + MAST_TOP;
  return { x: ox + (pose.flip ? 7 : 8), y: topY };
}

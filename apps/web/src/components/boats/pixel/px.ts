// Tiny pixel buffer: draw into a Uint32Array, blit with putImageData, let CSS
// upscale with `image-rendering: pixelated` at an integer factor.

export type Color = number; // packed little-endian ABGR, as ImageData wants

export function rgb(hex: string): Color {
  const n = parseInt(hex.slice(1), 16);
  return (0xff << 24) | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff);
}

export const CLEAR: Color = 0;

export class Px {
  readonly img: ImageData;
  readonly data: Uint32Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.img = new ImageData(w, h);
    this.data = new Uint32Array(this.img.data.buffer);
  }

  set(x: number, y: number, c: Color) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data[y * this.w + x] = c;
  }

  fill(c: Color) {
    this.data.fill(c);
  }

  copyFrom(other: Px) {
    this.data.set(other.data);
  }

  blit(ctx: CanvasRenderingContext2D) {
    ctx.putImageData(this.img, 0, 0);
  }
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Ordered-dither threshold in [0,1) for pixel (x, y). */
export function bayer(x: number, y: number): number {
  return ((BAYER[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
}

/** Pick a colour from a ramp at position t∈[0,1], ordered-dithered between steps. */
export function ramp(colors: Color[], t: number, x: number, y: number): Color {
  const pos = Math.min(Math.max(t, 0), 1) * (colors.length - 1);
  const i = Math.floor(pos);
  if (i >= colors.length - 1) return colors[colors.length - 1]!;
  return pos - i > bayer(x, y) ? colors[i + 1]! : colors[i]!;
}

/** Deterministic hash → [0,1). */
export function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

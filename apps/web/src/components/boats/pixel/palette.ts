import { rgb, type Color } from "./px";

export type Theme = "light" | "dark";

export interface BoatColors {
  sail: Color;
  sailShade: Color;
  deck: Color;
  hull: Color;
  keel: Color;
  mast: Color;
}

export interface Palette {
  bg: Color;
  sky: Color[]; // top → horizon
  water: Color[]; // lightest → darkest
  waterFrom: number; // ramp index at the horizon
  waterTo: number; // ramp index in the deepest row
  waterFade: number; // ramp index the shallows fade toward (≈ page background)
  shore: Color;
  tower: Color;
  towerStripe: Color;
  lamp: Color;
  glow: Color[]; // sun / moon halo, inner → outer
  star: Color[];
  cloud: Color[]; // lit top → shaded underside
  foam: Color;
  flag: Color;
  reflection: Color;
  sailReflection: Color;
  boat: BoatColors;
  boatAsleep: BoatColors;
}

const light: Palette = {
  bg: rgb("#fefefe"),
  sky: ["#263fa9", "#263fa9", "#495eb7", "#6b7cc4", "#929fd3", "#c2c9e6", "#e0e3f2", "#f1f3f9"].map(
    rgb,
  ),
  water: ["#fefefe", "#e0e3f2", "#c2c9e6", "#929fd3", "#6b7cc4", "#495eb7", "#263fa9"].map(rgb),
  waterFrom: 2,
  waterTo: 6,
  waterFade: 0.6,
  shore: rgb("#6b7cc4"),
  tower: rgb("#1d2a6b"),
  towerStripe: rgb("#fefefe"),
  lamp: rgb("#fefefe"),
  glow: ["#fefefe", "#f1f3f9", "#e0e3f2"].map(rgb),
  star: [],
  cloud: ["#fefefe", "#f1f3f9", "#e0e3f2", "#c2c9e6"].map(rgb),
  foam: rgb("#fefefe"),
  flag: rgb("#e0452f"),
  reflection: rgb("#1d2a6b"),
  sailReflection: rgb("#c2c9e6"),
  boat: {
    sail: rgb("#fefefe"),
    sailShade: rgb("#c2c9e6"),
    deck: rgb("#495eb7"),
    hull: rgb("#1d2a6b"),
    keel: rgb("#131c45"),
    mast: rgb("#131c45"),
  },
  boatAsleep: {
    sail: rgb("#e0e3f2"),
    sailShade: rgb("#c2c9e6"),
    deck: rgb("#6b7cc4"),
    hull: rgb("#1d2a6b"),
    keel: rgb("#131c45"),
    mast: rgb("#1d2a6b"),
  },
};

const dark: Palette = {
  bg: rgb("#0f1634"),
  sky: ["#0b1029", "#0f1634", "#0f1634", "#131c45", "#182358", "#1d2a6b", "#263fa9"].map(rgb),
  water: [
    "#c2c9e6",
    "#929fd3",
    "#6b7cc4",
    "#495eb7",
    "#263fa9",
    "#1d2a6b",
    "#182358",
    "#131c45",
  ].map(rgb),
  waterFrom: 4,
  waterTo: 7,
  waterFade: 7,
  shore: rgb("#0b1029"),
  tower: rgb("#0b1029"),
  towerStripe: rgb("#495eb7"),
  lamp: rgb("#fefefe"),
  glow: ["#e0e3f2", "#c2c9e6", "#495eb7"].map(rgb),
  star: ["#e0e3f2", "#929fd3", "#495eb7"].map(rgb),
  cloud: [],
  foam: rgb("#c2c9e6"),
  flag: rgb("#ff6a4d"),
  reflection: rgb("#0b1029"),
  sailReflection: rgb("#495eb7"),
  boat: {
    sail: rgb("#e0e3f2"),
    sailShade: rgb("#929fd3"),
    deck: rgb("#6b7cc4"),
    hull: rgb("#263fa9"),
    keel: rgb("#1d2a6b"),
    mast: rgb("#c2c9e6"),
  },
  boatAsleep: {
    sail: rgb("#c2c9e6"),
    sailShade: rgb("#929fd3"),
    deck: rgb("#6b7cc4"),
    hull: rgb("#263fa9"),
    keel: rgb("#1d2a6b"),
    mast: rgb("#929fd3"),
  },
};

export const palettes: Record<Theme, Palette> = { light, dark };

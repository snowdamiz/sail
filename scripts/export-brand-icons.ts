#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Deterministic build-time SVG rasterization.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";
import {
  SAIL_BACKGROUND,
  SAIL_DEV_LOGO_CONTENT,
  SAIL_DEV_LOGO_SVG,
  SAIL_HULL_PATH,
  SAIL_JIB_PATH,
  SAIL_LOGO_CONTENT,
  SAIL_LOGO_SVG,
  SAIL_MAIN_PATH,
  SAIL_NIGHTLY_LOGO_CONTENT,
  SAIL_NIGHTLY_LOGO_SVG,
  SAIL_PRIMARY,
  SAIL_SECONDARY,
  SAIL_WAKE,
} from "@t3tools/shared/sailBrand";
import { BRAND_ASSET_PATHS, resolveWebIconOverrides } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const outputs = new Map<string, string | Buffer>();

const png = (svg: string, size: number) =>
  sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();

const makeMacSvg = (content: string) =>
  `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dy="1.5" stdDeviation="2" flood-opacity=".35"/></filter></defs><g transform="translate(100 100) scale(6.4375)" filter="url(#shadow)">${content}</g></svg>`;

const makeVariantAssets = async (svg: string, content: string) => {
  const [universal, mac, icon512, icon192, touch, favicon32, favicon16, ico] = await Promise.all([
    png(svg, 1024),
    png(makeMacSvg(content), 1024),
    png(svg, 512),
    png(svg, 192),
    png(svg, 180),
    png(svg, 32),
    png(svg, 16),
    Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await png(svg, size) })),
    ).then(encodePngIco),
  ]);
  return { universal, mac, icon512, icon192, touch, favicon32, favicon16, ico };
};

const [prodAssets, nightlyAssets, devAssets] = await Promise.all([
  makeVariantAssets(SAIL_LOGO_SVG, SAIL_LOGO_CONTENT),
  makeVariantAssets(SAIL_NIGHTLY_LOGO_SVG, SAIL_NIGHTLY_LOGO_CONTENT),
  makeVariantAssets(SAIL_DEV_LOGO_SVG, SAIL_DEV_LOGO_CONTENT),
]);

const variants = [
  {
    brand: "development",
    directory: "dev",
    ios: BRAND_ASSET_PATHS.developmentIosIconPng,
    mac: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    windows: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    assets: devAssets,
    bgHex: "#082032",
    mainColor: "#2DD4BF",
    jibColor: "#CCFBF1",
    hullColor: "#38BDF8",
  },
  {
    brand: "nightly",
    directory: "nightly",
    ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
    mac: BRAND_ASSET_PATHS.nightlyMacIconPng,
    universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    windows: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    assets: nightlyAssets,
    bgHex: "#0B1120",
    mainColor: "#818CF8",
    jibColor: "#E0E7FF",
    hullColor: "#38BDF8",
  },
  {
    brand: "production",
    directory: "prod",
    ios: BRAND_ASSET_PATHS.productionIosIconPng,
    mac: BRAND_ASSET_PATHS.productionMacIconPng,
    universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windows: BRAND_ASSET_PATHS.productionWindowsIconIco,
    assets: prodAssets,
    bgHex: SAIL_BACKGROUND,
    mainColor: SAIL_PRIMARY,
    jibColor: SAIL_SECONDARY,
    hullColor: SAIL_WAKE,
  },
] as const;

for (const variant of variants) {
  outputs.set(variant.ios, variant.assets.universal);
  outputs.set(variant.mac, variant.assets.mac);
  outputs.set(variant.universal, variant.assets.universal);
  outputs.set(variant.windows, variant.assets.ico);
  for (const mapping of resolveWebIconOverrides(variant.brand, "apps/web/public")) {
    const value = mapping.targetRelativePath.endsWith(".ico")
      ? variant.assets.ico
      : mapping.targetRelativePath.endsWith("16x16.png")
        ? variant.assets.favicon16
        : mapping.targetRelativePath.endsWith("32x32.png")
          ? variant.assets.favicon32
          : mapping.targetRelativePath.endsWith("192x192.png")
            ? variant.assets.icon192
            : mapping.targetRelativePath.endsWith("512x512.png")
              ? variant.assets.icon512
              : variant.assets.touch;
    outputs.set(mapping.sourceRelativePath, value);
    if (variant.brand === "production") outputs.set(mapping.targetRelativePath, value);
  }
  outputs.set(
    `assets/${variant.directory}/app-icon.icon/Assets/text.svg`,
    `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><path d="${SAIL_MAIN_PATH}" fill="${variant.mainColor}"/><path d="${SAIL_JIB_PATH}" fill="${variant.jibColor}"/><path d="${SAIL_HULL_PATH}" fill="${variant.hullColor}"/></svg>\n`,
  );
  const color = variant.bgHex
    .slice(1)
    .match(/../g)!
    .map((part) => (parseInt(part, 16) / 255).toFixed(5));
  outputs.set(
    `assets/${variant.directory}/app-icon.icon/icon.json`,
    JSON.stringify(
      {
        fill: { solid: `srgb:${color.join(",")},1.00000` },
        groups: [
          {
            layers: [
              {
                "image-name": "text.svg",
                name: "Sail",
                glass: false,
                position: { scale: 8, "translation-in-points": [0, 0] },
              },
            ],
            shadow: { kind: "neutral", opacity: 0 },
            translucency: { enabled: false, value: 0 },
          },
        ],
        "supported-platforms": { circles: ["watchOS"], squares: "shared" },
      },
      null,
      2,
    ) + "\n",
  );
}

outputs.set("assets/prod/logo.svg", SAIL_LOGO_SVG + "\n");

const makeDmgSvg = (label: string, content: string, accent: string, bg: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="864" viewBox="0 0 640 432"><rect width="640" height="432" fill="${bg}"/><g transform="translate(296 24) scale(.375)">${content}</g><text x="320" y="104" fill="#FFFFFF" font-family="Helvetica" font-size="23" font-weight="700" text-anchor="middle">Drag ${label} into Applications.</text><path d="M285 214h70m-12-12 12 12-12 12" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><text x="320" y="367" fill="#94A3B8" font-family="Helvetica" font-size="12" text-anchor="middle">Once copied, open it from Applications.</text></svg>\n`;

outputs.set(
  "apps/desktop/resources/dmg/dmg-background-latest.svg",
  makeDmgSvg("Sail", SAIL_LOGO_CONTENT, SAIL_PRIMARY, SAIL_BACKGROUND),
);
outputs.set(
  "apps/desktop/resources/dmg/dmg-background-nightly.svg",
  makeDmgSvg("Sail (Nightly)", SAIL_NIGHTLY_LOGO_CONTENT, "#818CF8", "#0B1120"),
);

const stale: string[] = [];
for (const [file, contents] of outputs) {
  const target = NodePath.join(root, file);
  const data = Buffer.from(contents);
  if (check) {
    const existing = await NodeFSP.readFile(target).catch(() => null);
    const matches =
      file.endsWith(".json") && existing
        ? JSON.stringify(JSON.parse(existing.toString())) ===
          JSON.stringify(JSON.parse(data.toString()))
        : existing?.equals(data);
    if (!matches) stale.push(file);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, data);
  }
}
if (stale.length) throw new Error("Generated Sail icons are stale: " + stale.join(", "));
console.log(`${check ? "Verified" : "Generated"} ${outputs.size} matching Sail brand assets.`);

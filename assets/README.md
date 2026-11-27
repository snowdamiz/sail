# Update the Sail logo

Edit the shared artwork in [sailBrand.ts](../packages/shared/src/sailBrand.ts). The web and desktop interfaces use the same artwork as the exported icons across release channels.

Run `vp run icons:export` from the repository root. It regenerates the README logo, desktop and browser icons, macOS installer backgrounds, and Icon Composer projects. The macOS app icon has an 824 × 824 body centered on a 1024 × 1024 canvas.

Run `vp run icons:check` to verify that the tracked exports match the shared artwork.

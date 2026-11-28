import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const { menu, nativeImages } = vi.hoisted(() => ({
  menu: {
    template: [] as Electron.MenuItemConstructorOptions[],
    onPopup: null as ((template: Electron.MenuItemConstructorOptions[]) => void) | null,
  },
  nativeImages: [] as Array<{ dataURL: string; scaleFactor: number }>,
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      menu.template = template;
      return {
        popup: (options: Electron.PopupOptions) => {
          menu.onPopup?.(template);
          options.callback?.();
        },
      };
    },
  },
  nativeImage: {
    createEmpty: () => {
      let empty = true;
      const image = {
        addRepresentation: (rep: { dataURL: string; scaleFactor: number }) => {
          nativeImages.push(rep);
          empty = false;
        },
        isEmpty: () => empty,
      };
      return image;
    },
  },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

describe("ElectronMenu", () => {
  it.effect("shows ampersands in labels instead of reading them as mnemonics", () =>
    Effect.gen(function* () {
      menu.onPopup = null;
      const electronMenu = yield* ElectronMenu.make;
      yield* electronMenu.showContextMenu({
        window: { webContents: { getZoomFactor: () => 1 } } as Electron.BrowserWindow,
        items: [
          { id: "filter", label: "Filter by R&D" },
          { id: "more", label: "A&B", children: [{ id: "child", label: "C && D" }] },
        ],
        position: Option.none(),
        source: Option.none(),
      });

      assert.deepEqual(
        menu.template.map((item) => item.label),
        ["Filter by R&&D", "A&&B"],
      );
      const submenu = menu.template[1]!.submenu as Electron.MenuItemConstructorOptions[];
      assert.equal(submenu[0]!.label, "C &&&& D");
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.effect(
    "formats nested Move to Boat submenus with sublabels, icons, and disabled targets on macOS",
    () =>
      Effect.gen(function* () {
        nativeImages.length = 0;
        menu.onPopup = (template) => {
          const moveSubmenu = template[0]!.submenu as Electron.MenuItemConstructorOptions[];
          moveSubmenu[0]!.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
        };
        const electronMenu = yield* ElectronMenu.make;
        const selected = yield* electronMenu.showContextMenu({
          window: { webContents: { getZoomFactor: () => 1 } } as Electron.BrowserWindow,
          items: [
            {
              id: "move-session",
              label: "Move to Boat",
              detail: "Pauses and resumes",
              iconImage: "data:image/png;base64,SHIP",
              children: [
                {
                  id: "move-to-boat:skiff",
                  label: "skiff",
                  detail: "Idle",
                  iconImage: "data:image/png;base64,BOAT1",
                },
                {
                  id: "move-to-boat:dinghy",
                  label: "dinghy",
                  detail: "Creating",
                  disabled: true,
                },
              ],
            },
          ],
          position: Option.none(),
          source: Option.none(),
        });

        assert.deepEqual(selected, Option.some("move-to-boat:skiff"));
        assert.equal(menu.template[0]!.label, "Move to Boat");
        assert.equal(menu.template[0]!.sublabel, "Pauses and resumes");
        assert.isDefined(menu.template[0]!.icon);

        const submenu = menu.template[0]!.submenu as Electron.MenuItemConstructorOptions[];
        assert.equal(submenu.length, 2);
        assert.equal(submenu[0]!.label, "skiff");
        assert.equal(submenu[0]!.sublabel, "Idle");
        assert.equal(submenu[0]!.enabled, true);
        assert.isDefined(submenu[0]!.icon);
        assert.equal(submenu[1]!.label, "dinghy");
        assert.equal(submenu[1]!.sublabel, "Creating");
        assert.equal(submenu[1]!.enabled, false);
        assert.deepEqual(nativeImages, [
          { scaleFactor: 2, dataURL: "data:image/png;base64,BOAT1" },
          { scaleFactor: 2, dataURL: "data:image/png;base64,SHIP" },
        ]);
      }).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
  );

  it.effect("appends detail to labels for nested submenus on non-macOS platforms", () =>
    Effect.gen(function* () {
      menu.onPopup = null;
      const electronMenu = yield* ElectronMenu.make;
      yield* electronMenu.showContextMenu({
        window: { webContents: { getZoomFactor: () => 1 } } as Electron.BrowserWindow,
        items: [
          {
            id: "move-session",
            label: "Move to Boat",
            detail: "Pauses & resumes",
            children: [
              { id: "move-to-boat:skiff", label: "skiff", detail: "Working" },
              { id: "move-to-boat:broken", label: "broken", detail: "Error", disabled: true },
            ],
          },
        ],
        position: Option.none(),
        source: Option.none(),
      });

      assert.equal(menu.template[0]!.label, "Move to Boat (Pauses && resumes)");
      assert.isUndefined(menu.template[0]!.sublabel);
      const submenu = menu.template[0]!.submenu as Electron.MenuItemConstructorOptions[];
      assert.equal(submenu[0]!.label, "skiff (Working)");
      assert.equal(submenu[0]!.enabled, true);
      assert.equal(submenu[1]!.label, "broken (Error)");
      assert.equal(submenu[1]!.enabled, false);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});

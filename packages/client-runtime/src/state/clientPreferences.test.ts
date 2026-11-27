import { EnvironmentId } from "@t3tools/contracts";
import {
  clientSettingsForStorage,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientPreferencesSnapshot,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  acknowledgeClientPreferences,
  editClientPreferences,
  prepareClientPreferencesWrite,
  reconcileClientPreferences,
  restoreClientPreferences,
  selectClientPreferencesServer,
} from "./clientPreferences.ts";

const encodeSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeSettings = Schema.decodeSync(ClientSettingsSchema);

const main = EnvironmentId.make("main");
const other = EnvironmentId.make("other");
const firstId = "427f1564-18fb-4e1c-a15b-5a34e24b8d04";
const secondId = "a5d664eb-3d68-476e-8fc7-451b21752f0e";
const firstWrite = { writerId: firstId, sequence: 1 };
const initial = { revision: 1, values: { fontSizeCode: 16, diffLayout: "split" } } as const;
const source = (snapshot: ClientPreferencesSnapshot | undefined = initial) => ({
  environmentId: main,
  snapshot,
  access: "writable" as const,
});

describe("main server client preferences", () => {
  it("loads the existing shared record and retains device fields in storage", () => {
    const local = {
      ...DEFAULT_CLIENT_SETTINGS,
      fontSizeCode: 17,
      confirmQuit: "double-click",
    } as const;
    const synced = reconcileClientPreferences(local, source());
    expect(synced).toMatchObject({
      fontSizeCode: 16,
      diffLayout: "split",
      confirmQuit: "double-click",
    });
    expect(prepareClientPreferencesWrite(synced, () => firstId)).toBe(synced);
    const stored = clientSettingsForStorage(encodeSettings(synced));
    expect(stored).not.toHaveProperty("fontSizeCode");
    expect(stored).not.toHaveProperty("diffLayout");
    expect(stored.confirmQuit).toBe("double-click");
    expect(restoreClientPreferences(decodeSettings(stored))).toEqual(synced);
  });

  it("overlays offline edits, sends only changed shared fields, and converges in commit order", () => {
    const synced = reconcileClientPreferences(DEFAULT_CLIENT_SETTINGS, source());
    const edited = editClientPreferences(
      synced,
      { ...synced, fontSizeCode: 18, confirmQuit: "double-click" },
      source(),
    );
    const sending = prepareClientPreferencesWrite(edited, () => firstId);
    const restored = restoreClientPreferences(
      decodeSettings(clientSettingsForStorage(encodeSettings(sending))),
    );
    expect(restored.clientPreferencesCache?.sending).toEqual({
      ...firstWrite,
      changes: { fontSizeCode: 18 },
    });
    expect(prepareClientPreferencesWrite(restored, () => secondId)).toBe(restored);
    const newest = { revision: 5, values: { fontSizeCode: 14, diffLayout: "stacked" } } as const;
    const live = reconcileClientPreferences(restored, source(newest));
    expect(live).toMatchObject({
      fontSizeCode: 18,
      diffLayout: "stacked",
      confirmQuit: "double-click",
    });
    const acknowledged = acknowledgeClientPreferences(live, main, firstWrite, {
      revision: 4,
      values: { fontSizeCode: 18, diffLayout: "stacked" },
    });
    expect(acknowledged).toMatchObject({
      fontSizeCode: 14,
      diffLayout: "stacked",
      confirmQuit: "double-click",
    });
    expect(acknowledged.clientPreferencesCache?.sending).toBeUndefined();
  });

  it("keeps edits made after a batch starts for the next write", () => {
    const synced = reconcileClientPreferences(DEFAULT_CLIENT_SETTINGS, source());
    const first = editClientPreferences(synced, { ...synced, fontSizeCode: 18 }, source());
    const sending = prepareClientPreferencesWrite(first, () => firstId);
    const second = editClientPreferences(sending, { ...sending, fontSizeCode: 17 }, source());
    const acknowledged = acknowledgeClientPreferences(second, main, firstWrite, {
      revision: 2,
      values: { ...initial.values, fontSizeCode: 18 },
    });
    expect(acknowledged.fontSizeCode).toBe(17);
    expect(
      prepareClientPreferencesWrite(acknowledged, () => secondId).clientPreferencesCache?.sending,
    ).toEqual({ writerId: firstId, sequence: 2, changes: { fontSizeCode: 17 } });
  });

  it("preserves edits made before the initial shared snapshot", () => {
    const awaiting = { ...source(), snapshot: undefined };
    const edited = editClientPreferences(
      DEFAULT_CLIENT_SETTINGS,
      { ...DEFAULT_CLIENT_SETTINGS, fontSizeCode: 18 },
      awaiting,
    );
    const synced = reconcileClientPreferences(edited, source());
    expect(synced).toMatchObject({ fontSizeCode: 18, diffLayout: "split" });
    expect(
      prepareClientPreferencesWrite(synced, () => firstId).clientPreferencesCache?.sending,
    ).toEqual({ ...firstWrite, changes: { fontSizeCode: 18 } });
    const readOnly = reconcileClientPreferences(edited, { ...source(), access: "read-only" });
    expect(readOnly.fontSizeCode).toBe(18);
    expect(prepareClientPreferencesWrite(readOnly, () => firstId)).toBe(readOnly);
  });

  it("stages edits against the restored binding before the catalog resolves", () => {
    const synced = reconcileClientPreferences(DEFAULT_CLIENT_SETTINGS, source());
    const edited = editClientPreferences(synced, { ...synced, fontSizeCode: 18 }, undefined);
    const stored = clientSettingsForStorage(encodeSettings(edited));
    expect(restoreClientPreferences(decodeSettings(stored)).fontSizeCode).toBe(18);
    expect(edited.clientPreferencesCache?.pending).toEqual({ fontSizeCode: 18 });
  });

  it("leaves a pin unresolved in a tab that has never seen its registration", () => {
    expect(
      selectClientPreferencesServer({
        ready: true,
        pinWasRegistered: false,
        inferSingle: true,
        candidates: [other],
        pinned: main,
        primary: null,
      }),
    ).toBeUndefined();
  });

  it("keeps a removed binding detached even when another tab still lists the server", () => {
    expect(
      selectClientPreferencesServer({
        ready: true,
        pinWasRegistered: false,
        inferSingle: true,
        candidates: [main],
        pinned: null,
        primary: null,
      }),
    ).toBeNull();
  });

  it("keeps read-only edits local while applying other live fields", () => {
    const readOnly = { ...source(), access: "read-only" } as const;
    const synced = reconcileClientPreferences(DEFAULT_CLIENT_SETTINGS, readOnly);
    const edited = editClientPreferences(synced, { ...synced, fontSizeCode: 17 }, readOnly);
    const latest = reconcileClientPreferences(edited, {
      ...readOnly,
      snapshot: { revision: 2, values: { fontSizeCode: 15, diffLayout: "stacked" } },
    });
    expect(latest).toMatchObject({ fontSizeCode: 17, diffLayout: "stacked" });
    expect(prepareClientPreferencesWrite(latest, () => firstId)).toBe(latest);
  });

  it("keeps current values on removal or opt-out and discards the old write binding", () => {
    const synced = reconcileClientPreferences(DEFAULT_CLIENT_SETTINGS, source());
    const edited = editClientPreferences(synced, { ...synced, fontSizeCode: 18 }, source());
    const sending = prepareClientPreferencesWrite(edited, () => firstId);
    const detached = reconcileClientPreferences(sending, { ...source(), environmentId: null });
    const optedOut = editClientPreferences(
      sending,
      { ...sending, syncClientPreferences: false },
      source(),
    );
    for (const settings of [detached, optedOut]) {
      expect(settings.fontSizeCode).toBe(18);
      expect(settings.clientPreferencesCache).toBeUndefined();
      expect(acknowledgeClientPreferences(settings, main, firstWrite, initial)).toBe(settings);
    }
    expect(reconcileClientPreferences(optedOut, source())).toBe(optedOut);
    const switched = reconcileClientPreferences(detached, { ...source(), environmentId: other });
    expect(switched.fontSizeCode).toBe(16);
    expect(switched.clientPreferencesCache?.pending).toEqual({});
  });

  it("retains a pinned server across reload and refuses to route its edits to another server", () => {
    expect(
      selectClientPreferencesServer({
        ready: true,
        pinWasRegistered: true,
        inferSingle: false,
        candidates: [other],
        pinned: undefined,
        primary: null,
      }),
    ).toBeNull();
    expect(
      selectClientPreferencesServer({
        ready: false,
        pinWasRegistered: false,
        inferSingle: false,
        candidates: [],
        pinned: main,
        primary: null,
      }),
    ).toBeUndefined();
    expect(
      selectClientPreferencesServer({
        ready: true,
        pinWasRegistered: true,
        inferSingle: false,
        candidates: [other, main],
        pinned: main,
        primary: null,
      }),
    ).toBe(main);
    expect(
      selectClientPreferencesServer({
        ready: true,
        pinWasRegistered: true,
        inferSingle: false,
        candidates: [other],
        pinned: main,
        primary: other,
      }),
    ).toBeNull();
  });
});

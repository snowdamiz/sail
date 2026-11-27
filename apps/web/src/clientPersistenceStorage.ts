import {
  clientSettingsForStorage,
  ClientSettingsSchema,
  type ClientSettings,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const StoredClientSettings = Schema.toEncoded(ClientSettingsSchema);

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    clientSettingsForStorage(encodeClientSettings(settings)),
    StoredClientSettings,
  );
}

/** Storage events fire only for other tabs' writes; a null key means storage was cleared. */
export function subscribeBrowserClientSettingsWrites(onChange: () => void): () => void {
  if (!hasWindow()) {
    return () => undefined;
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CLIENT_SETTINGS_STORAGE_KEY || event.key === null) {
      onChange();
    }
  };
  const target = window;
  target.addEventListener("storage", handleStorage);
  return () => target.removeEventListener("storage", handleStorage);
}

export async function withBrowserClientSettingsLock<A>(
  work: (readLatest: boolean) => Promise<A>,
): Promise<A> {
  const browser = hasWindow() && window.desktopBridge === undefined;
  const locks = browser ? window.navigator?.locks : undefined;
  return locks === undefined
    ? work(browser)
    : locks.request(CLIENT_SETTINGS_STORAGE_KEY, () => work(true));
}

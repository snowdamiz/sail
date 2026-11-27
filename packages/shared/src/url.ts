// `URL.parse` and `URL.canParse` are missing before Safari 17/18, and client code ships unpolyfilled.
export function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** The origin of an http(s) URL, else undefined: an app scheme's origin is the string "null". */
export function webOrigin(value: string | undefined): string | undefined {
  const url = value ? parseUrl(value) : null;
  return url?.protocol === "http:" || url?.protocol === "https:" ? url.origin : undefined;
}

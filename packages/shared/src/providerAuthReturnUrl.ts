import { parseUrl } from "./url.ts";

const THIS_COMPUTER = new Set(["localhost", "127.0.0.1", "[::1]"]);

// A delivery carries the one-time OAuth code in the URL fragment, so plain HTTP never qualifies.
const isTrustedHttpsOrigin = (origin: string, trustedOrigins: ReadonlyArray<string | undefined>) =>
  trustedOrigins.some((trusted) => {
    const url = trusted ? parseUrl(trusted) : null;
    return url?.protocol === "https:" && url.origin === origin;
  });

export function providerAuthReturnUrl(
  value: string | undefined,
  trustedOrigins: ReadonlyArray<string | undefined> = [],
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop =
      ["sail:", "sail-dev:", "t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (THIS_COMPUTER.has(url.hostname) || isTrustedHttpsOrigin(url.origin, trustedOrigins));
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

import { isLoopbackHost } from "./preview.ts";

/** A sign-in returns to the desktop app, a loopback page, or a page at the caller's `trustedOrigin`. */
export function providerAuthReturnUrl(
  value: string | undefined,
  trustedOrigin?: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop =
      ["sail:", "sail-dev:", "t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) ||
        (!!trustedOrigin && url.origin === new URL(trustedOrigin).origin));
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

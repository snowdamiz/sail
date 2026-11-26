import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import { readPairingAppLink } from "@t3tools/shared/remote";

import { m } from "~/i18n/messages";
import type { CommandName, CommandResult } from "./types";

/** A command's answer. `openUrl` and `userCode` reach only the tab that sent the command. */
export interface BoatReply<C extends CommandName> {
  readonly data: CommandResult<C>;
  readonly openUrl?: string;
  readonly userCode?: string;
}

/** Where a reply's `openUrl` goes in the tab that asked. */
export type BoatLink =
  | { readonly kind: "pairing"; readonly pairingUrl: string }
  | { readonly kind: "app"; readonly href: string }
  | { readonly kind: "browser"; readonly url: string }
  | { readonly kind: "ignored" };

const IGNORED: BoatLink = { kind: "ignored" };

/** `onHost`: a pairing link points at this server's localhost, so only its host can pair (until W12). */
export function classifyBoatLink(openUrl: string | undefined, onHost: boolean): BoatLink {
  if (openUrl === undefined) return IGNORED;
  const pairingUrl = readPairingAppLink(openUrl);
  if (pairingUrl !== null) return onHost ? { kind: "pairing", pairingUrl } : IGNORED;
  const href = promptLinkAppPath(openUrl);
  if (href !== null) return { kind: "app", href };
  return URL.parse(openUrl)?.protocol === "https:" ? { kind: "browser", url: openUrl } : IGNORED;
}

/** A failed command's text: the daemon's or the connection's own message. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return thrownErrorMessage(e, m) || "Something went wrong";
  return "Something went wrong";
}

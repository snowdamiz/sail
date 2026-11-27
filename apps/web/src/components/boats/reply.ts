import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import { readPairingAppLink } from "@t3tools/shared/remote";

import { m } from "~/i18n/messages";
import type { CommandName, CommandResult } from "./types";

export interface BoatReply<C extends CommandName> {
  readonly data: CommandResult<C>;
  readonly openUrl?: string;
  readonly userCode?: string;
}

export type BoatLink =
  | { readonly kind: "pairing"; readonly pairingUrl: string }
  | { readonly kind: "app"; readonly href: string }
  | { readonly kind: "browser"; readonly url: string }
  | { readonly kind: "ignored" };

const IGNORED: BoatLink = { kind: "ignored" };

export function classifyBoatLink(openUrl: string | undefined, onHost: boolean): BoatLink {
  if (openUrl === undefined) return IGNORED;
  const pairingUrl = readPairingAppLink(openUrl);
  if (pairingUrl !== null) return onHost ? { kind: "pairing", pairingUrl } : IGNORED;
  const href = promptLinkAppPath(openUrl);
  if (href !== null) return { kind: "app", href };
  return URL.parse(openUrl)?.protocol === "https:" ? { kind: "browser", url: openUrl } : IGNORED;
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return thrownErrorMessage(e, m) || "Something went wrong";
  return "Something went wrong";
}

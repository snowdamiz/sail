import type { BoatSignIn } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import { readPairingAppLink } from "@t3tools/shared/remote";

import { m } from "~/i18n/messages";
import type { CommandName, CommandResult } from "./types";

export interface BoatReply<C extends CommandName> {
  readonly data: CommandResult<C>;
  readonly openUrl?: string;
  readonly signIn?: BoatSignIn;
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
  const url = URL.parse(openUrl);
  if (url?.protocol !== "https:") return IGNORED;
  if (
    url.pathname === "/pair" &&
    url.search === "" &&
    url.username === "" &&
    url.password === "" &&
    new URLSearchParams(url.hash.slice(1)).get("token")
  ) {
    return { kind: "pairing", pairingUrl: openUrl };
  }
  return { kind: "browser", url: openUrl };
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return thrownErrorMessage(e, m) || "Something went wrong";
  return "Something went wrong";
}

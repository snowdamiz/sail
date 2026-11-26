import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { toastManager } from "./components/ui/toast";
import { readLocalStorageValue, writeLocalStorageValue } from "./hooks/useLocalStorage";
import { m } from "./i18n/messages";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentPresentations } from "./state/presentation";
import { serverEnvironment } from "./state/server";

type ProviderAuthDelivery = NonNullable<ReturnType<typeof readCodexAuthDelivery>>;

// Origin-scoped, so every tab of this browser at this address shares it, and no other site can
// write it. A server that asks for a code without the user starting a sign-in here finds nothing.
const SIGN_INS_KEY = "t3code:codex-sign-ins:v1";
const SIGN_IN_LIFETIME_MS = 10 * 60_000;
const CodexSignIn = Schema.Struct({
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  flowId: Schema.String,
  expiresAt: Schema.Number,
});
type CodexSignIn = typeof CodexSignIn.Type;
const CodexSignIns = Schema.Array(CodexSignIn);

const sameFlow = (a: Omit<CodexSignIn, "expiresAt">, b: Omit<CodexSignIn, "expiresAt">) =>
  a.environmentId === b.environmentId && a.instanceId === b.instanceId && a.flowId === b.flowId;

/** Lets this browser's tabs at this address accept the code for a sign-in it started. */
export function rememberProviderAuthSignIn(signIn: Omit<CodexSignIn, "expiresAt">): void {
  const now = Date.now();
  writeLocalStorageValue(
    SIGN_INS_KEY,
    (signIns) => [
      ...signIns.filter((other) => other.expiresAt > now && !sameFlow(other, signIn)),
      { ...signIn, expiresAt: now + SIGN_IN_LIFETIME_MS },
    ],
    [],
    CodexSignIns,
  );
}

function takeSignIn(delivery: ProviderAuthDelivery): CodexSignIn | undefined {
  const now = Date.now();
  const live = readLocalStorageValue(SIGN_INS_KEY, [], CodexSignIns).filter(
    (signIn) => signIn.expiresAt > now,
  );
  const signIn = live.find((candidate) => sameFlow(candidate, delivery));
  writeLocalStorageValue(
    SIGN_INS_KEY,
    live.filter((other) => other !== signIn),
    [],
    CodexSignIns,
  );
  return signIn;
}

/**
 * Remove the code before the router, tracing, or welcome screen sees the incoming address, then
 * hand it to its environment once that environment connects, if this browser started that sign-in
 * and it has not expired. Hosted web receives only the one-time code; the environment verifies and
 * stores tokens.
 */
export function startProviderAuthDelivery(): void {
  if (!window.location.hash.startsWith("#codex-auth=")) return;
  const delivery = readCodexAuthDelivery(window.location.href, [window.location.origin]);
  window.history.replaceState(
    window.history.state,
    "",
    delivery?.returnUrl ?? `${window.location.pathname}${window.location.search}`,
  );
  if (!delivery) return;
  const signIn = takeSignIn(delivery);
  if (!signIn) {
    toastManager.add({
      type: "error",
      title: m(msg("ChatGPT sign-in couldn't finish")),
      description: m(
        msg(
          "This browser didn't start that sign-in. Sign in again in the browser that did, and paste the URL from the final localhost page.",
        ),
      ),
    });
    return;
  }

  const presentationAtom = environmentPresentations.presentationAtom(delivery.environmentId);
  if (appAtomRegistry.get(presentationAtom)?.connection.phase === "connected") {
    void completeProviderAuth(delivery);
    return;
  }
  const expiry = setTimeout(() => {
    unsubscribe();
    toastManager.add({
      type: "error",
      title: m(msg("ChatGPT sign-in couldn't finish")),
      description: m(msg("Reconnect to the environment and try again.")),
    });
  }, signIn.expiresAt - Date.now());
  const unsubscribe = appAtomRegistry.subscribe(presentationAtom, (presentation) => {
    if (presentation?.connection.phase !== "connected") return;
    clearTimeout(expiry);
    unsubscribe();
    void completeProviderAuth(delivery);
  });
}

async function completeProviderAuth(delivery: ProviderAuthDelivery): Promise<void> {
  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.completeProviderAuth,
      {
        environmentId: delivery.environmentId,
        input: {
          instanceId: delivery.instanceId,
          flowId: delivery.flowId,
          callbackUrl: delivery.callbackUrl,
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("ChatGPT sign-in couldn't finish")),
        description: m(msg("Return to the provider and try again.")),
      });
    }
  } catch {
    toastManager.add({
      type: "error",
      title: m(msg("ChatGPT sign-in couldn't finish")),
      description: m(msg("Reconnect to the environment and try again.")),
    });
  }
}

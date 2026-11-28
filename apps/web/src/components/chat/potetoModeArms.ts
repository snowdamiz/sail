import type { OrchestrationV2Run } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

export type ComposerPotetoModeState = "off" | "armed" | "active";

/** Threads whose next message triggers built-in pstack poteto-mode for the session. */
const potetoModeArmsAtom = Atom.make<Readonly<Record<string, number>>>({}).pipe(Atom.keepAlive);

export function armPotetoMode(threadKey: string): void {
  appAtomRegistry.set(potetoModeArmsAtom, {
    ...appAtomRegistry.get(potetoModeArmsAtom),
    [threadKey]: Date.now(),
  });
}

/** With `arm`, clears only that arm so a completed send never cancels a newer toggle. */
export function disarmPotetoMode(threadKey: string, arm?: number): void {
  const current = appAtomRegistry.get(potetoModeArmsAtom);
  if (current[threadKey] === undefined || (arm !== undefined && current[threadKey] !== arm)) return;
  const { [threadKey]: _removed, ...rest } = current;
  appAtomRegistry.set(potetoModeArmsAtom, rest);
}

export function togglePotetoModeArm(threadKey: string): boolean {
  if (readPotetoModeArm(threadKey) !== undefined) {
    disarmPotetoMode(threadKey);
    return false;
  }
  armPotetoMode(threadKey);
  return true;
}

export function readPotetoModeArm(threadKey: string): number | undefined {
  return appAtomRegistry.get(potetoModeArmsAtom)[threadKey];
}

export function usePotetoModeArmed(threadKey: string): boolean {
  return useAtomValue(potetoModeArmsAtom)[threadKey] !== undefined;
}

type PotetoSessionRun = Pick<
  OrchestrationV2Run,
  "ordinal" | "freshContext" | "potetoMode" | "status" | "startedAt"
>;

function runNeverStarted(run: Pick<PotetoSessionRun, "status" | "startedAt">): boolean {
  return (run.status === "cancelled" || run.status === "failed") && run.startedAt === null;
}

/**
 * Whether built-in pstack poteto-mode has already been triggered (or queued to trigger) in the
 * current provider session. A pending `/clear` (`freshSessionArmed`) opens a new session, so the
 * upcoming session does not inherit the previous one.
 */
export function isPotetoModeActiveInSession(
  runs: ReadonlyArray<PotetoSessionRun>,
  freshSessionArmed = false,
): boolean {
  if (freshSessionArmed) return false;
  let boundary = 0;
  for (const run of runs) {
    if (
      run.freshContext === true &&
      run.status !== "queued" &&
      !runNeverStarted(run) &&
      run.ordinal > boundary
    ) {
      boundary = run.ordinal;
    }
  }
  return runs.some(
    (run) => run.ordinal >= boundary && run.potetoMode === true && !runNeverStarted(run),
  );
}

export function resolveComposerPotetoModeState(input: {
  readonly activeInSession: boolean;
  readonly armed: boolean;
}): ComposerPotetoModeState {
  if (input.activeInSession) return "active";
  if (input.armed) return "armed";
  return "off";
}

import type { DesktopBoatStatus } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandArgs, CommandName, CommandResult, MachineDetails, UiState } from "./types";

function getBoatBridge() {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.boat ?? null;
}

export function hasDesktopBoatBridge(): boolean {
  return getBoatBridge() !== null;
}

export async function call<C extends CommandName>(
  cmd: C,
  args: CommandArgs<C>,
): Promise<CommandResult<C>> {
  const bridge = getBoatBridge();
  if (!bridge) {
    throw new Error("Sail Boats requires the Sail desktop app.");
  }
  return (await bridge.invoke(cmd, args)) as CommandResult<C>;
}

/** Rejections are strings per contract; normalise anything else. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

export function useBoatDaemonStatus(): DesktopBoatStatus | null {
  const [status, setStatus] = useState<DesktopBoatStatus | null>(null);

  useEffect(() => {
    const bridge = getBoatBridge();
    if (!bridge) return;
    let alive = true;
    const unsubscribe = bridge.onStatus((next) => {
      if (alive) setStatus(next);
    });
    void bridge.getStatus().then(
      (next) => {
        if (alive) setStatus(next);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return status;
}

export function useUiState(): {
  state: UiState | null;
  loadError: string | null;
  retry: () => void;
} {
  const [state, setState] = useState<UiState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const bridge = getBoatBridge();
    if (!bridge) {
      setLoadError("Sail Boats requires the Sail desktop app.");
      return;
    }

    let alive = true;
    const unsubscribe = bridge.onState((next) => {
      if (!alive || !next || typeof next !== "object") return;
      setLoadError(null);
      setState(next as UiState);
    });

    void bridge.invoke("get_state", undefined).then(
      (s) => {
        if (!alive) return;
        setLoadError(null);
        setState(s as UiState);
      },
      (e) => {
        if (!alive) return;
        setLoadError(errorText(e));
      },
    );

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setLoadError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { state, loadError, retry };
}

/**
 * Fetches a machine's details whenever `version` changes (pass the latest UiState).
 * A failed refetch keeps the last data; `onError` fires once per run of failures.
 */
export function useMachineDetails(
  id: string,
  version: unknown,
  onError: (text: string) => void,
): MachineDetails | null {
  const [details, setDetails] = useState<MachineDetails | null>(null);
  const failing = useRef(false);
  const latest = useRef(0);

  useEffect(() => {
    const req = ++latest.current;
    void call("get_machine_details", { id }).then(
      (d) => {
        if (req !== latest.current) return;
        failing.current = false;
        setDetails(d);
      },
      (e) => {
        if (req !== latest.current || failing.current) return;
        failing.current = true;
        onError(errorText(e));
      },
    );
  }, [id, version, onError]);

  return details?.id === id ? details : null;
}

/** The machine's latest thread id, looked up once per machine; null when it has none. */
export function useLatestThread(id: string): string | null {
  const [latest, setLatest] = useState<{ id: string; thread: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void call("latest_thread", { id }).then(
      (thread) => live && setLatest({ id, thread }),
      () => live && setLatest({ id, thread: null }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  return latest?.id === id ? latest.thread : null;
}

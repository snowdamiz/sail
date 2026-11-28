import type { BoatSignIn, BoatSignInAction, BoatSignInPhase } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { AlertTriangleIcon, CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Spinner } from "../../ui/spinner";
import { useBoatAccess } from "../access";
import { useBoatCall } from "../api";

type SignInCommand = "manage_agent_sign_in" | "manage_boat_sign_in";

export function SignInPanel({
  attempt,
  command,
  onFinish,
}: {
  readonly attempt: BoatSignIn;
  readonly command: SignInCommand;
  readonly onFinish: (attemptId: string, phase: BoatSignInPhase) => void;
}) {
  const gt = useGT();
  const call = useBoatCall();
  const access = useBoatAccess();
  const canManage = access.can(command);
  const codeId = useId();
  const [code, setCode] = useState("");
  const [action, setAction] = useState<"submit" | "cancel" | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);
  const mountedRef = useRef(true);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: {
      target: "sign-in code",
      unavailableMessage: msg("Clipboard API is unavailable while copying sign-in code."),
      failureMessage: msg("Failed to copy sign-in code to the clipboard."),
    },
  });
  const { attemptId, prompt } = attempt;
  const pollStatus = useEffectEvent(() => call(command, { action: "status", attemptId }));
  const reportFinish = useEffectEvent((phase: BoatSignInPhase) => onFinish(attemptId, phase));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!canManage) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const { data: phase } = await pollStatus();
        if (stopped) return;
        if (phase !== "pending") {
          reportFinish(phase);
          return;
        }
      } catch {
        if (stopped) return;
      }
      timer = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [access.environmentId, attemptId, canManage, command]);

  const act = (input: BoatSignInAction) => {
    setAction(input.action === "submit" ? "submit" : "cancel");
    setCode("");
    setFailed(false);
    void call(command, input).then(
      ({ data: phase }) => {
        if (!mountedRef.current) return;
        if (phase !== "pending") onFinish(attemptId, phase);
        else if (input.action === "submit") {
          setSubmitted(true);
          setAction(null);
        }
      },
      () => {
        if (!mountedRef.current) return;
        setAction(null);
        setFailed(true);
      },
    );
  };

  if (!canManage) return null;

  const url = prompt === null ? null : URL.parse(prompt.url);
  const link = url?.protocol === "https:" ? url.href : null;
  const showDevice = prompt?.kind === "device" && action !== "cancel";
  const showPaste = prompt?.kind === "paste" && action === null;

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs/5">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div
          role="status"
          className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
        >
          <Spinner aria-hidden="true" size="xs" tone="muted" />
          <span>
            {action === "cancel" ? gt("Cancelling sign-in…") : gt("Waiting for sign-in…")}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {link && action !== "cancel" ? (
            <Button
              size="xs"
              variant="default"
              render={<a href={link} target="_blank" rel="noopener noreferrer" />}
            >
              {gt("Open sign-in page")}
              <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
          {action !== "cancel" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={action === "submit"}
              onClick={() => act({ action: "cancel", attemptId })}
            >
              {gt("Cancel sign-in")}
            </Button>
          ) : null}
        </div>
      </div>

      {showDevice ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 bg-muted/40 px-4 py-3.5">
          <span className="text-xs text-muted-foreground">
            {gt("Enter this code on the sign-in page")}
          </span>
          <div className="flex items-center gap-1.5">
            <code className="rounded-md border border-border bg-background px-2.5 py-1 font-mono text-sm font-semibold tracking-wider text-foreground select-all">
              {prompt.code}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Copy code")}
              onClick={() => copyToClipboard(prompt.code, undefined)}
            >
              {isCopied ? (
                <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
              ) : (
                <CopyIcon aria-hidden="true" className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {showPaste ? (
        <form
          className="flex flex-col gap-2.5 border-t border-border/50 bg-muted/40 px-4 py-3.5 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) act({ action: "submit", attemptId, code });
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={codeId}>{gt("Paste the sign-in code")}</Label>
            <Input
              id={codeId}
              type="password"
              font="mono"
              size="sm"
              autoComplete="off"
              maxLength={2048}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <Button size="sm" variant="default" type="submit" disabled={!code.trim()}>
            {gt("Submit code")}
          </Button>
        </form>
      ) : null}

      {failed ? (
        <div className="border-t border-border/50 px-4 py-3">
          <Alert variant="error">
            <AlertTriangleIcon aria-hidden="true" />
            <AlertDescription>{gt("The sign-in request failed. Try again.")}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {submitted && !failed && action !== "cancel" ? (
        <p
          role="status"
          className="border-t border-border/50 bg-muted/20 px-4 py-2 text-xs text-muted-foreground"
        >
          {gt("Code sent. If sign-in stalls, try another code.")}
        </p>
      ) : null}
    </div>
  );
}

import type { BoatSignIn, BoatSignInAction, BoatSignInPhase } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";

import { useBoatAccess } from "../access";
import { call } from "../api";
import { Dots } from "./common";

type SignInCommand = "manage_agent_sign_in" | "manage_boat_sign_in";

export function SignInPanel({
  attempt,
  command,
  onFinish,
}: {
  attempt: BoatSignIn;
  command: SignInCommand;
  onFinish: (phase: BoatSignInPhase) => void;
}) {
  const gt = useGT();
  const canManage = useBoatAccess().can(command);
  const [code, setCode] = useState("");
  const [action, setAction] = useState<"submit" | "cancel" | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);
  const { attemptId, prompt } = attempt;

  // Poll the caller's private attempt while the vendor CLI is waiting for the browser.
  useEffect(() => {
    if (!canManage) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const { data: phase } = await call(command, { action: "status", attemptId });
        if (stopped) return;
        if (phase !== "pending") {
          onFinish(phase);
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
  }, [attemptId, canManage, command, onFinish]);

  const act = (input: BoatSignInAction) => {
    setAction(input.action === "submit" ? "submit" : "cancel");
    setCode("");
    setFailed(false);
    void call(command, input).then(
      ({ data: phase }) => {
        if (phase !== "pending") onFinish(phase);
        else if (input.action === "submit") {
          setSubmitted(true);
          setAction(null);
        }
      },
      () => {
        setAction(null);
        setFailed(true);
      },
    );
  };
  if (!canManage) return null;

  const url = prompt === null ? null : URL.parse(prompt.url);
  const link = url?.protocol === "https:" ? url.href : null;
  return (
    <div className="boat-sign-in">
      {link && action !== "cancel" ? (
        <a className="btn btn-link" href={link} target="_blank" rel="noopener noreferrer">
          {gt("Open sign-in page")}
        </a>
      ) : null}
      {prompt?.kind === "device" && action !== "cancel" ? (
        <span className="step-body">
          {gt("Enter this code on the sign-in page")}{" "}
          <code className="step-code">{prompt.code}</code>
        </span>
      ) : null}
      {prompt?.kind === "paste" && action === null ? (
        <form
          className="boat-sign-in"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) act({ action: "submit", attemptId, code });
          }}
        >
          <label className="boat-sign-in">
            {gt("Paste the sign-in code")}
            <input
              type="password"
              className="input"
              autoComplete="off"
              maxLength={2048}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button className="btn btn-sm btn-solid" type="submit" disabled={!code.trim()}>
            {gt("Submit code")}
          </button>
        </form>
      ) : null}
      {failed ? <span role="alert">{gt("The sign-in request failed. Try again.")}</span> : null}
      {submitted && !failed && action !== "cancel" ? (
        <span role="status">{gt("Code sent. If sign-in stalls, try another code.")}</span>
      ) : null}
      <div role="status" className="step-body">
        <Dots /> {action === "cancel" ? gt("Cancelling sign-in…") : gt("Waiting for sign-in…")}
      </div>
      {action !== "cancel" ? (
        <button
          className="btn btn-sm btn-outline"
          type="button"
          disabled={action === "submit"}
          onClick={() => act({ action: "cancel", attemptId })}
        >
          {gt("Cancel sign-in")}
        </button>
      ) : null}
    </div>
  );
}

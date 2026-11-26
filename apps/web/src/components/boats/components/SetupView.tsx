import { useBoatAccess } from "../access";
import type { Setup, SetupAction } from "../types";
import { Icon } from "./Icons";
import { Dots } from "./common";

export interface SignInPrompt {
  url: string;
  userCode: string | null;
}

const STEPS: {
  id: Exclude<Setup, "starting" | "ready">;
  title: string;
  body: string;
  button: string;
  busy: string;
}[] = [
  {
    id: "installBoat",
    title: "Install the Boat CLI",
    body: "Sail uses the Boat CLI on this server to run cloud machines on your Boat account.",
    button: "Install Boat CLI",
    busy: "Installing",
  },
  {
    id: "signInBoat",
    title: "Sign in to Boat",
    body: "Opens your browser. Machines bill to your own Boat plan.",
    button: "Sign in to Boat",
    busy: "Waiting for sign-in",
  },
];

export function SetupView({
  setup,
  busy,
  signIn,
  onAction,
}: {
  setup: Setup;
  busy: boolean;
  signIn: SignInPrompt | null;
  onAction: (a: SetupAction) => void;
}) {
  const canAct = useBoatAccess().can("setup_action");
  const locked = busy || !canAct;
  const canShowPendingSignIn = setup === "signInBoat" && busy && signIn === null && canAct;
  if (setup === "starting" || setup === "ready") {
    return (
      <div className="view center">
        <p className="caption">
          <Dots /> checking your setup
        </p>
      </div>
    );
  }
  const current = setup === "installT3" ? STEPS.length : STEPS.findIndex((s) => s.id === setup);

  return (
    <div className="view">
      <div className="view-body">
        <h1 className="display">Set sail in two steps</h1>
        <p className="lede">
          Launch cloud machines inside Sail that sleep for free when no agent is working.
        </p>
        <ol className="steps">
          {STEPS.map((s, i) => {
            const status = i < current ? "done" : i === current ? "current" : "todo";
            return (
              <li
                key={s.id}
                className={`step is-${status}`}
                aria-current={status === "current" ? "step" : undefined}
              >
                <span className="step-num">
                  {status === "done" ? <Icon name="check" size={12} /> : `0${i + 1}`}
                </span>
                <div className="step-text">
                  <span className="step-title">{s.title}</span>
                  {status === "current" ? <span className="step-body">{s.body}</span> : null}
                  {status === "current" ? (
                    <button
                      type="button"
                      className="btn btn-solid btn-lg"
                      disabled={locked && !canShowPendingSignIn}
                      aria-busy={busy}
                      onClick={() => onAction(s.id)}
                    >
                      {canShowPendingSignIn ? (
                        "Show sign-in page"
                      ) : busy ? (
                        <>
                          <Dots /> {s.busy}
                        </>
                      ) : (
                        s.button
                      )}
                    </button>
                  ) : null}
                  {status === "current" && signIn ? (
                    <span className="step-body">
                      Finish on{" "}
                      <a
                        className="btn btn-link"
                        href={signIn.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Boat's sign-in page
                      </a>
                      {signIn.userCode ? (
                        <>
                          . If it asks for a code, enter{" "}
                          <code className="step-code">{signIn.userCode}</code>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {setup === "installT3" ? (
          <p className="lede" style={{ marginTop: 12 }}>
            This server could not run its own <code>t3</code> command. Restart the server, then
            check again.
          </p>
        ) : null}
      </div>
      <div className="view-foot">
        <button
          type="button"
          className="btn btn-link"
          disabled={locked}
          onClick={() => onAction("recheck")}
        >
          Done it already? Check again
        </button>
      </div>
    </div>
  );
}

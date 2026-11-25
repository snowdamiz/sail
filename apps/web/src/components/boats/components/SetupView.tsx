import type { Setup, SetupAction } from "../types";
import { Icon } from "./Icons";
import { Dots } from "./common";

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
    body: "Sail uses the Boat CLI to run cloud machines on your Boat account.",
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
  signInCode,
  onAction,
}: {
  setup: Setup;
  busy: boolean;
  signInCode: string | null;
  onAction: (a: SetupAction) => void;
}) {
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
                      disabled={busy}
                      aria-busy={busy}
                      onClick={() => onAction(s.id)}
                    >
                      {busy ? (
                        <>
                          <Dots /> {s.busy}
                        </>
                      ) : (
                        s.button
                      )}
                    </button>
                  ) : null}
                  {status === "current" && busy && signInCode ? (
                    <span className="step-body">
                      If Boat asks for a code, enter <code className="step-code">{signInCode}</code>
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {setup === "installT3" ? (
          <p className="lede" style={{ marginTop: 12 }}>
            Sail's bundled CLI launcher was not found (for example in unpackaged dev mode). Launch
            the packaged Sail desktop app or set <code>SAIL_DESKTOP_CLI</code>, then click Recheck.
          </p>
        ) : null}
      </div>
      <div className="view-foot">
        <button
          type="button"
          className="btn btn-link"
          disabled={busy}
          onClick={() => onAction("recheck")}
        >
          Done it already? Check again
        </button>
      </div>
    </div>
  );
}

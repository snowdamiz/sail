import type { BoatSignIn, BoatSignInPhase } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { SailBrandMark } from "../../SailBrandMark";
import { SettingsGroup } from "../../settings/SettingsGroup";
import { Alert, AlertDescription } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { useBoatAccess } from "../access";
import { useBoatCall, type useFollowBoatLink } from "../api";
import { errorText } from "../reply";
import type { Setup, SetupAction, UiState } from "../types";
import { BoatsFrame, type Notice, type Notify, type ServerSelection } from "./BoatsFrame";
import { SignInPanel } from "./SignInPanel";
import { useIsMountedRef } from "./common";

type FollowLink = ReturnType<typeof useFollowBoatLink>;

export function SetupBody({
  state,
  follow,
  notify,
  server,
  notice,
  dismissNotice,
}: {
  readonly state: UiState;
  readonly follow: FollowLink;
  readonly notify: Notify;
  readonly server: ServerSelection;
  readonly notice: Notice | null;
  readonly dismissNotice: () => void;
}) {
  const gt = useGT();
  const call = useBoatCall();
  const [signIn, setSignIn] = useState<BoatSignIn | null>(null);
  const [requesting, setRequesting] = useState(false);
  const activeAttemptIdRef = useRef<string | null>(null);
  const mountedRef = useIsMountedRef();

  const finish = (attemptId: string, phase: BoatSignInPhase) => {
    if (!mountedRef.current || activeAttemptIdRef.current !== attemptId) return;
    activeAttemptIdRef.current = null;
    setSignIn((current) => (current?.attemptId === attemptId ? null : current));
    if (phase === "expired") notify(gt("The sign-in expired. Start again to get a new code."));
    if (phase === "failed") notify(gt("Sign-in could not finish. Try again."));
  };

  const act = (action: SetupAction) => {
    setRequesting(true);
    void call("setup_action", { action })
      .then(
        (reply) => {
          if (!mountedRef.current) return;
          if (reply.signIn !== undefined) {
            activeAttemptIdRef.current = reply.signIn.attemptId;
            setSignIn(reply.signIn);
            if (reply.signIn.onHost) follow(reply.signIn.prompt?.url);
          } else {
            follow(reply.openUrl);
          }
        },
        (error) => {
          if (mountedRef.current) notify(errorText(error));
        },
      )
      .finally(() => {
        if (mountedRef.current) setRequesting(false);
      });
  };

  const isChecking = state.setup === "starting" || state.setup === "ready";

  return (
    <BoatsFrame
      breadcrumbHeading={isChecking}
      back={null}
      server={server}
      notice={notice}
      dismissNotice={dismissNotice}
    >
      <SetupView
        setup={state.setup}
        busy={state.setupBusy}
        signIn={
          signIn === null ? null : (
            <SignInPanel
              key={signIn.attemptId}
              attempt={signIn}
              command="manage_boat_sign_in"
              onFinish={finish}
            />
          )
        }
        requesting={requesting}
        onAction={act}
      />
    </BoatsFrame>
  );
}

function SetupView({
  setup,
  busy,
  signIn,
  requesting,
  onAction,
}: {
  readonly setup: Setup;
  readonly busy: boolean;
  readonly signIn: ReactNode;
  readonly requesting: boolean;
  readonly onAction: (action: SetupAction) => void;
}) {
  const gt = useGT();
  const canAct = useBoatAccess().can("setup_action");
  const locked = busy || requesting || !canAct || signIn !== null;

  if (setup === "starting" || setup === "ready") {
    return (
      <div
        role="status"
        className="flex items-center justify-center gap-2.5 py-20 text-sm text-muted-foreground"
      >
        <Spinner aria-hidden="true" size="sm" tone="muted" />
        <span>{gt("Checking your setup…")}</span>
      </div>
    );
  }

  const primaryAction: SetupAction = setup === "installBoat" ? "installBoat" : "signInBoat";

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 pt-4 sm:pt-8">
      <div className="space-y-2 px-1">
        <SailBrandMark aria-hidden="true" className="size-6 text-foreground" />
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {gt("Set sail with Boat")}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {gt("Launch cloud machines inside Sail that sleep for free when no agent is working.")}
        </p>
      </div>

      <SettingsGroup divided={false}>
        {setup === "installT3" ? (
          <div className="px-4 py-4 sm:px-5">
            <Alert variant="warning">
              <AlertTriangleIcon aria-hidden="true" />
              <AlertDescription>
                {gt(
                  "This server could not run its own t3 command. Restart the server, then check again.",
                )}
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="space-y-4 px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div className="min-w-0 space-y-0.5">
                <h2 className="text-sm font-medium text-foreground">{gt("Sign in to Boat")}</h2>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {gt("Machines bill to your Boat plan. Sail handles setup automatically.")}
                </p>
              </div>
              {signIn === null ? (
                <Button
                  size="sm"
                  variant="default"
                  className="shrink-0"
                  disabled={locked}
                  aria-busy={busy || requesting}
                  onClick={() => onAction(primaryAction)}
                >
                  {busy || requesting ? (
                    <>
                      <Spinner aria-hidden="true" />
                      {gt("Setting up Boat…")}
                    </>
                  ) : (
                    gt("Sign in to Boat")
                  )}
                </Button>
              ) : null}
            </div>
            {signIn}
          </div>
        )}
      </SettingsGroup>

      <div className="flex justify-end px-1">
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={locked}
          onClick={() => onAction("recheck")}
        >
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          {gt("Done it already? Check again")}
        </Button>
      </div>
    </div>
  );
}

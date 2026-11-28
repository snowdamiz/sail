import { useGT } from "gt-react";
import { AlertTriangleIcon, CheckIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SettingsGroup } from "../../settings/SettingsGroup";
import { Alert, AlertDescription } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { useBoatAccess } from "../access";
import type { Setup, SetupAction } from "../types";

export function SetupView({
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
      <SettingsGroup divided={false}>
        <div
          role="status"
          className="flex items-center justify-center gap-2.5 px-4 py-12 text-sm text-muted-foreground"
        >
          <Spinner aria-hidden="true" size="sm" tone="muted" />
          <span>{gt("Checking your setup…")}</span>
        </div>
      </SettingsGroup>
    );
  }

  const steps: ReadonlyArray<{
    readonly id: "installBoat" | "signInBoat";
    readonly title: string;
    readonly body: string;
    readonly button: string;
    readonly busyLabel: string;
  }> = [
    {
      id: "installBoat",
      title: gt("Install the Boat CLI"),
      body: gt("Sail uses the Boat CLI on this server to run cloud machines on your Boat account."),
      button: gt("Install Boat CLI"),
      busyLabel: gt("Installing…"),
    },
    {
      id: "signInBoat",
      title: gt("Sign in to Boat"),
      body: gt("Machines bill to your Boat plan."),
      button: gt("Sign in to Boat"),
      busyLabel: gt("Waiting for sign-in…"),
    },
  ];

  const current = setup === "installT3" ? steps.length : steps.findIndex((s) => s.id === setup);

  return (
    <SettingsGroup>
      <div className="px-4 py-4 sm:px-5 sm:py-5">
        <h2 className="text-base font-semibold text-foreground">{gt("Set sail in two steps")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {gt("Launch cloud machines inside Sail that sleep for free when no agent is working.")}
        </p>
      </div>

      <ol className="divide-y divide-border/50">
        {steps.map((step, index) => {
          const status = index < current ? "done" : index === current ? "current" : "todo";
          return (
            <li
              key={step.id}
              aria-current={status === "current" ? "step" : undefined}
              className={cn(
                "flex items-start gap-3.5 px-4 py-4 sm:px-5",
                status === "todo" && "opacity-60",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-medium",
                  status === "done"
                    ? "bg-success/15 text-success-foreground"
                    : status === "current"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-muted/50 text-muted-foreground",
                )}
              >
                {status === "done" ? <CheckIcon className="size-3.5" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{step.title}</span>
                  {status === "done" ? (
                    <Badge variant="success" size="sm">
                      {gt("Done")}
                    </Badge>
                  ) : null}
                </div>
                {status === "current" ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
                ) : null}
                {status === "current" && signIn === null ? (
                  <div>
                    <Button
                      size="sm"
                      variant="default"
                      disabled={locked}
                      aria-busy={busy}
                      onClick={() => onAction(step.id)}
                    >
                      {busy ? (
                        <>
                          <Spinner aria-hidden="true" />
                          {step.busyLabel}
                        </>
                      ) : (
                        step.button
                      )}
                    </Button>
                  </div>
                ) : null}
                {status === "current" ? signIn : null}
              </div>
            </li>
          );
        })}
      </ol>

      {setup === "installT3" ? (
        <div className="px-4 py-3.5 sm:px-5">
          <Alert variant="warning">
            <AlertTriangleIcon aria-hidden="true" />
            <AlertDescription>
              {gt(
                "This server could not run its own t3 command. Restart the server, then check again.",
              )}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="flex items-center justify-end bg-muted/20 px-4 py-2.5 sm:px-5">
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
    </SettingsGroup>
  );
}

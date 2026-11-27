import {
  AuthOwnerPasswordMinLength,
  AuthOwnerPasswordMaxLength,
  isValidOwnerPassword,
  type EnvironmentId,
} from "@t3tools/contracts";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";
import { useState } from "react";
import { T, useGT } from "gt-react";
import { updateOwnerPassword } from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

export function OwnerPasswordSettings({
  configured,
  environmentId,
}: {
  configured: boolean;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  const matches = password === confirmation && isValidOwnerPassword(password);

  return (
    <SettingsRow
      title={gt("Browser sign-in password")}
      description={gt(
        "Sign in from future browsers without a pairing link. Use a password of 15–256 characters. Changing it signs out password-based sessions, but not paired devices. Pairing links still work for recovery.",
      )}
      control={
        <form
          className="flex w-64 max-w-full flex-col gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!matches || saving) return;
            setSaving(true);
            setError(false);
            setSaved(false);
            const result = await updateOwnerPassword(password).then(
              (authenticated) => ({ kind: "success" as const, authenticated }),
              () => ({ kind: "error" as const }),
            );
            setSaving(false);
            setError(result.kind === "error");
            if (result.kind === "success") {
              if (!result.authenticated) {
                window.location.reload();
                return;
              }
              setSaved(true);
              appAtomRegistry.refresh(environmentSession.sessionStateAtom(environmentId));
              setPassword("");
              setConfirmation("");
            }
          }}
        >
          <Input
            nativeInput
            type="password"
            autoComplete="new-password"
            aria-label={gt("New password")}
            placeholder={gt("New password")}
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            disabled={saving}
            required
            minLength={AuthOwnerPasswordMinLength}
            maxLength={AuthOwnerPasswordMaxLength * 2}
          />
          <Input
            nativeInput
            type="password"
            autoComplete="new-password"
            aria-label={gt("Confirm password")}
            placeholder={gt("Confirm password")}
            maxLength={AuthOwnerPasswordMaxLength * 2}
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            disabled={saving}
            required
          />
          {confirmation.length > 0 && confirmation !== password ? (
            <p role="status" className="text-xs text-destructive">
              <T>Passwords do not match.</T>
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={!matches || saving}>
            {configured || saved ? gt("Change password") : gt("Set password")}
          </Button>
          {saved ? (
            <p role="status" className="text-xs text-muted-foreground">
              <T>
                Password saved. Password-based sessions have been signed out. Paired devices remain
                signed in.
              </T>
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              <T>Could not save password. Try again.</T>
            </p>
          ) : null}
        </form>
      }
    />
  );
}

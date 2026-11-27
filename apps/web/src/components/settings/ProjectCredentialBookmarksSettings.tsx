import { useAtomValue } from "@effect/atom-react";
import {
  configuredSecretSources,
  parseCredentialEnvVar,
  secretRequestFailureMessage,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProjectCredentialSummary,
  type ProjectId,
  type SecretProviderId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useEffect, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ProjectCredentialBookmarksSettings({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.secretProviders);
  const bookmarks = useEnvironmentSettings(
    environmentId,
    (settings) => settings.projectCredentialBookmarks[projectId] ?? {},
  );
  const update = useUpdateEnvironmentSettings(environmentId);
  const listCredentials = useAtomCommand(serverEnvironment.listProjectCredentials, {
    label: "list project credentials",
    reportFailure: false,
    reportDefect: false,
  });
  const saveCredential = useAtomCommand(serverEnvironment.saveProjectCredential, {
    label: "save project credential",
    reportFailure: false,
    reportDefect: false,
  });
  const sources = configuredSecretSources(providers, messages);
  const [mode, setMode] = useState<"link" | "create">("link");
  const [label, setLabel] = useState("");
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const [reference, setReference] = useState("");
  const [vault, setVault] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [envVar, setEnvVar] = useState("");
  const [autoGrant, setAutoGrant] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedCredentials, setSyncedCredentials] = useState<
    ReadonlyArray<ProjectCredentialSummary>
  >([]);

  const syncSupported = config?.projectCredentialsSync === true;

  const refreshSynced = () => {
    if (!syncSupported) return;
    void listCredentials({ environmentId, input: { projectId } }).then((result) => {
      if (result._tag === "Success") {
        setSyncedCredentials(result.value.credentials.filter((entry) => entry.source === "synced"));
      }
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads host-synced Boat credentials from the server RPC when the viewed project or sync capability changes
  useEffect(() => {
    if (!syncSupported) return;
    let cancelled = false;
    void listCredentials({ environmentId, input: { projectId } }).then((result) => {
      if (!cancelled && result._tag === "Success") {
        setSyncedCredentials(result.value.credentials.filter((entry) => entry.source === "synced"));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, listCredentials, projectId, syncSupported]);

  const effectiveSourceId = sourceId ?? (sources.length === 1 ? (sources[0]?.id ?? null) : null);
  const source = sources.find((entry) => entry.id === effectiveSourceId);
  const parsedReference = source ? secretRequestReference(source, reference) : undefined;
  const trimmedEnvVar = envVar.trim();
  const parsedEnvVar = trimmedEnvVar.length > 0 ? parseCredentialEnvVar(trimmedEnvVar) : undefined;
  const envVarValid = trimmedEnvVar.length === 0 || parsedEnvVar !== undefined;

  if (config?.projectCredentialBookmarks !== true) return null;
  if (!canManage && syncedCredentials.length === 0) return null;

  const canSubmitLink =
    !saving && Boolean(label.trim()) && parsedReference !== undefined && envVarValid;
  const canSubmitCreate =
    !saving &&
    Boolean(label.trim()) &&
    source !== undefined &&
    Boolean(vault.trim()) &&
    vault.trim().length <= 120 &&
    !/[\r\n]/.test(vault) &&
    Boolean(secretValue.trim()) &&
    envVarValid;

  const handleLinkSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!parsedReference || !label.trim() || !envVarValid || saving) return;
    setSaving(true);
    setError(null);
    update(
      {
        projectCredentialBookmarks: {
          [projectId]: {
            [randomUUID()]: {
              label: label.trim(),
              reference: parsedReference,
              ...(parsedEnvVar !== undefined ? { envVar: parsedEnvVar } : {}),
              autoGrant,
            },
          },
        },
      },
      {
        onSaved: () => {
          setLabel("");
          setReference("");
          setEnvVar("");
          setAutoGrant(true);
          setSaving(false);
        },
        onFailed: () => setSaving(false),
      },
    );
  };

  const handleCreateSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitCreate || source === undefined) return;
    const trimmedSecret = secretValue.trim();
    setSaving(true);
    setError(null);
    setSecretValue("");
    const result = await saveCredential({
      environmentId,
      input: {
        projectId,
        provider: source.id,
        vault: vault.trim(),
        label: label.trim(),
        fields: [
          {
            name: parsedEnvVar ?? label.trim(),
            label: label.trim(),
            value: trimmedSecret,
            ...(parsedEnvVar !== undefined ? { envVar: parsedEnvVar } : {}),
          },
        ],
        autoGrant,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setLabel("");
      setEnvVar("");
      setAutoGrant(true);
      refreshSynced();
      return;
    }
    setSecretValue(trimmedSecret);
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result), messages));
    }
  };

  return (
    <SettingsSection title={gt("Project credentials")}>
      <p className="px-4 py-3 text-xs text-muted-foreground">
        <T>
          Authorize 1Password credentials for this project. Auto-use credentials are provided to
          agents, terminals, and new Boats created for this project without signing in to 1Password
          again.
        </T>
      </p>
      {Object.entries(bookmarks).map(([id, bookmark]) => {
        const isAutoGrant = bookmark.autoGrant !== false;
        return (
          <SettingsRow
            key={id}
            title={
              <span className="flex flex-wrap items-center gap-1.5">
                <span>{bookmark.label}</span>
                {bookmark.envVar !== undefined ? (
                  <Badge variant="outline">
                    <code>{bookmark.envVar}</code>
                  </Badge>
                ) : null}
              </span>
            }
            description={bookmark.reference.reference}
            control={
              canManage ? (
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>
                      <T>Auto-use</T>
                    </span>
                    <Switch
                      checked={isAutoGrant}
                      disabled={saving}
                      aria-label={gt("Auto-use credential")}
                      onCheckedChange={(checked) =>
                        update({
                          projectCredentialBookmarks: {
                            [projectId]: {
                              [id]: {
                                ...bookmark,
                                autoGrant: checked,
                              },
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={saving}
                    onClick={() =>
                      update({ projectCredentialBookmarks: { [projectId]: { [id]: null } } })
                    }
                  >
                    <T>Remove</T>
                  </Button>
                </div>
              ) : null
            }
          />
        );
      })}
      {syncedCredentials.map((credential) => (
        <SettingsRow
          key={`synced:${credential.id}`}
          title={
            <span className="flex flex-wrap items-center gap-1.5">
              <span>{credential.label}</span>
              {credential.envVar !== undefined ? (
                <Badge variant="outline">
                  <code>{credential.envVar}</code>
                </Badge>
              ) : null}
              <Badge variant="secondary">
                <T>Synced from managing host</T>
              </Badge>
            </span>
          }
          description={
            credential.autoGrant
              ? gt("Authorized for automatic use on this Boat")
              : gt("Synced from managing host")
          }
          control={null}
        />
      ))}
      {canManage && sources.length > 0 ? (
        <div className="flex flex-col gap-2 px-4 py-3">
          {syncSupported ? (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant={mode === "link" ? "secondary" : "ghost"}
                disabled={saving}
                onClick={() => {
                  setMode("link");
                  setError(null);
                }}
              >
                <T>Link existing reference</T>
              </Button>
              <Button
                type="button"
                size="xs"
                variant={mode === "create" ? "secondary" : "ghost"}
                disabled={saving}
                onClick={() => {
                  setMode("create");
                  setError(null);
                }}
              >
                <T>Save new to 1Password</T>
              </Button>
            </div>
          ) : null}
          <form
            className="flex flex-col gap-2"
            autoComplete="off"
            onSubmit={mode === "create" ? (e) => void handleCreateSubmit(e) : handleLinkSubmit}
          >
            <Input
              aria-label={gt("Credential name")}
              placeholder={gt("Credential name")}
              value={label}
              maxLength={100}
              disabled={saving}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
            <Select
              value={effectiveSourceId}
              onValueChange={(id) =>
                setSourceId(sources.find((entry) => entry.id === id)?.id ?? null)
              }
            >
              <SelectTrigger size="sm" aria-label={gt("Secret provider")} disabled={saving}>
                <SelectValue>{source?.label ?? gt("Select a secret provider")}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {sources.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {mode === "link" ? (
              <Input
                aria-label={gt("Secret reference")}
                placeholder={source?.referencePlaceholder ?? "op://vault/item/field"}
                value={reference}
                maxLength={1024}
                disabled={saving}
                onChange={(event) => setReference(event.currentTarget.value)}
              />
            ) : (
              <>
                <Input
                  aria-label={gt("Vault name or ID")}
                  placeholder={gt("Vault name or ID")}
                  value={vault}
                  maxLength={120}
                  disabled={saving}
                  onChange={(event) => setVault(event.currentTarget.value)}
                />
                <Input
                  type="password"
                  aria-label={gt("Secret value")}
                  placeholder={gt("Paste the secret")}
                  value={secretValue}
                  disabled={saving}
                  onChange={(event) => setSecretValue(event.currentTarget.value)}
                />
              </>
            )}
            <Input
              font="mono"
              aria-label={gt("Environment variable (optional)")}
              placeholder={gt("Environment variable (optional, e.g. AWS_ACCESS_KEY_ID)")}
              value={envVar}
              maxLength={128}
              disabled={saving}
              aria-invalid={!envVarValid || undefined}
              onChange={(event) => setEnvVar(event.currentTarget.value)}
            />
            <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                <T>Automatically provide to agents, terminals, and Boats for this project</T>
              </span>
              <Switch
                checked={autoGrant}
                disabled={saving}
                aria-label={gt("Auto-use credential")}
                onCheckedChange={setAutoGrant}
              />
            </label>
            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              size="sm"
              disabled={mode === "create" ? !canSubmitCreate : !canSubmitLink}
            >
              {mode === "create" ? <T>Save to 1Password</T> : <T>Save credential</T>}
            </Button>
          </form>
        </div>
      ) : syncedCredentials.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          <T>Add a secret provider on this environment first.</T>
        </p>
      ) : null}
    </SettingsSection>
  );
}

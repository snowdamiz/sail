import { useAtomValue } from "@effect/atom-react";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProjectId,
  type SecretProviderId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
  const sources = configuredSecretSources(providers, messages);
  const [label, setLabel] = useState("");
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const source = sources.find((entry) => entry.id === sourceId);
  const parsed = source ? secretRequestReference(source, reference) : undefined;
  if (config?.projectCredentialBookmarks !== true || !canManage) return null;
  return (
    <SettingsSection title={gt("Project credential references")}>
      <p className="px-4 py-3 text-xs text-muted-foreground">
        <T>
          Save links to existing vault items for this project. The values stay in your password
          manager. You choose whether to use a saved reference when answering a private credential
          request.
        </T>
      </p>
      {Object.entries(bookmarks).map(([id, bookmark]) => (
        <SettingsRow
          key={id}
          title={bookmark.label}
          description={bookmark.reference.reference}
          control={
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
          }
        />
      ))}
      {sources.length > 0 ? (
        <form
          className="flex flex-col gap-2 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!parsed || !label.trim() || saving) return;
            setSaving(true);
            update(
              {
                projectCredentialBookmarks: {
                  [projectId]: {
                    [randomUUID()]: { label: label.trim(), reference: parsed },
                  },
                },
              },
              {
                onSaved: () => {
                  setLabel("");
                  setReference("");
                  setSaving(false);
                },
                onFailed: () => setSaving(false),
              },
            );
          }}
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
            value={sourceId}
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
          <Input
            aria-label={gt("Secret reference")}
            placeholder={source?.referencePlaceholder ?? "op://vault/item/field"}
            value={reference}
            maxLength={1024}
            disabled={saving}
            onChange={(event) => setReference(event.currentTarget.value)}
          />
          <Button type="submit" size="sm" disabled={!parsed || !label.trim() || saving}>
            <T>Save reference</T>
          </Button>
        </form>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          <T>Add a secret provider on this environment first.</T>
        </p>
      )}
    </SettingsSection>
  );
}

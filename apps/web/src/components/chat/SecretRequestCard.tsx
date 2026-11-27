import { pipe } from "effect/Function";
import {
  configuredSecretSources,
  parseCredentialEnvVar,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  secretRequestLink,
  secretRequestPrivacyNote,
  secretRequestReference,
  secretRequestSources,
  secretRequestValue,
  suggestedCredentialEnvVar,
  type SecretRequestInput,
  type SecretRequestItem,
  type SecretRequestReply,
  type SecretRequestSource,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type ProjectCredentialSaveField,
  type ProjectId,
  type SecretProviderId,
  type ServerConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { hasFeatureFlag } from "@t3tools/client-runtime/state/server";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  CheckIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  MinusIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";

import { serverEnvironment } from "../../state/server";
import { localEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentThread } from "../../state/threads";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { useBoatsPage } from "../boats/api";
import { managedBoatOriginProject } from "../boats/machine";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SecretSourceSelect } from "../settings/SecretSourceInput";
import { WorkLogRow } from "./WorkLog";

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const messages = useMessages();
  const display = secretRequestDisplay(item, props.visibility, messages);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "saved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.label} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingSecretRequestForm environmentId={props.environmentId} item={item} />;
}

const NO_SOURCES: ReadonlyArray<SecretRequestSource> = [];
const NULL_CONFIG_ATOM = Atom.make<ServerConfig | null>(null);

function useSecretRequestSources(environmentId: EnvironmentId) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const messages = useMessages();
  // The server accepts a reference answer only with this scope; without it the card is typed.
  const canUseReferences = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  return canUseReferences && hasFeatureFlag(config, "secretProviders")
    ? secretRequestSources(config, config?.settings.secretProviders ?? {}, messages)
    : NO_SOURCES;
}

function useManagedBoatVaultTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | undefined;
  readonly enabled: boolean;
}) {
  const messages = useMessages();
  const managerId = useAtomValue(localEnvironmentIdAtom);
  const candidateManagerId =
    input.enabled &&
    input.projectId !== undefined &&
    managerId !== null &&
    managerId !== input.environmentId
      ? managerId
      : null;
  const canReadBoats = useEnvironmentScope(candidateManagerId, AuthOrchestrationReadScope);
  const canManageProviders = useEnvironmentScope(candidateManagerId, AuthProvidersManageScope);
  const managerConfig = useAtomValue(
    candidateManagerId !== null
      ? serverEnvironment.configValueAtom(candidateManagerId)
      : NULL_CONFIG_ATOM,
  );
  const managerSources =
    candidateManagerId !== null &&
    canManageProviders &&
    managerConfig?.projectCredentialsSync === true &&
    hasFeatureFlag(managerConfig, "secretProviders")
      ? configuredSecretSources(managerConfig.settings.secretProviders, messages)
      : NO_SOURCES;
  const shouldReadBoats = candidateManagerId !== null && canReadBoats && managerSources.length > 0;
  const { page: boats } = useBoatsPage(shouldReadBoats ? candidateManagerId : null);
  if (
    !shouldReadBoats ||
    candidateManagerId === null ||
    input.projectId === undefined ||
    (boats.kind !== "ready" && boats.kind !== "setup")
  ) {
    return null;
  }
  const originProjectId = managedBoatOriginProject(
    boats.state.machines,
    input.environmentId,
    input.projectId,
  );
  if (originProjectId === undefined) return null;
  return {
    managerId: candidateManagerId,
    originProjectId,
    sources: managerSources,
  };
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const messages = useMessages();
  const gt = useGT();
  const formId = useId();
  const errorId = useId();
  const privacyId = useId();
  const vaultCheckLabelId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const saveProjectCredential = useAtomCommand(serverEnvironment.saveProjectCredential, {
    label: "save project credential",
    reportFailure: false,
    reportDefect: false,
  });
  const multiple = item.fields !== undefined;
  const inputs = secretRequestInputs(item, messages);
  // A reference answers one value, so a card with fields is always typed.
  const configuredSources = useSecretRequestSources(props.environmentId);
  const sources = multiple ? NO_SOURCES : configuredSources;
  const projectId = Option.getOrUndefined(
    useEnvironmentThread(props.environmentId, item.threadId).data,
  )?.thread.projectId;
  const bookmarks = useEnvironmentSettings(props.environmentId, (settings) =>
    projectId === undefined ? {} : (settings.projectCredentialBookmarks[projectId] ?? {}),
  );
  const availableBookmarks = Object.entries(bookmarks).filter(([, bookmark]) =>
    sources.some(
      (entry) =>
        entry.id === bookmark.reference.provider && entry.isReference(bookmark.reference.reference),
    ),
  );
  const vaultSaveSupported = useAtomValue(
    serverEnvironment.configValueAtom(props.environmentId),
    (config) => config?.projectCredentialBookmarks === true,
  );
  const localVaultAvailable = vaultSaveSupported && configuredSources.length > 0;
  const managedBoatVault = useManagedBoatVaultTarget({
    environmentId: props.environmentId,
    projectId,
    enabled: !localVaultAvailable,
  });
  const vaultSources = localVaultAvailable
    ? configuredSources
    : (managedBoatVault?.sources ?? NO_SOURCES);

  const [saveToVault, setSaveToVault] = useState(false);
  const [vaultProvider, setVaultProvider] = useState<SecretProviderId | null>(null);
  const [vault, setVault] = useState("");
  const [vaultLabel, setVaultLabel] = useState(item.label.slice(0, 100));
  const [vaultEnvVar, setVaultEnvVar] = useState(() =>
    multiple ? "" : suggestedCredentialEnvVar(item.label),
  );
  const [vaultEnvVars, setVaultEnvVars] = useState<Readonly<Record<string, string>>>(() =>
    multiple
      ? Object.fromEntries(inputs.map((input) => [input.key, suggestedCredentialEnvVar(input.key)]))
      : {},
  );
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const source = sources.find((candidate) => candidate.id === sourceId) ?? null;
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and click can both submit before a render.
  const inFlight = useRef(false);
  const inputId = (index: number) => `${formId}-${index}`;
  const describedBy = error !== null ? `${privacyId} ${errorId}` : privacyId;
  const effectiveVaultProvider =
    vaultProvider !== null && vaultSources.some((entry) => entry.id === vaultProvider)
      ? vaultProvider
      : vaultSources.length === 1
        ? (vaultSources[0]?.id ?? null)
        : null;
  const vaultModeAvailable = vaultSources.length > 0 && source === null;
  const vaultMode = vaultModeAvailable && saveToVault;
  const usingManagedBoatVault = vaultMode && !localVaultAvailable && managedBoatVault !== null;

  const typedReply: SecretRequestReply | null = vaultMode
    ? effectiveVaultProvider === null
      ? null
      : {
          type: "save-to-vault",
          values,
          provider: effectiveVaultProvider,
          vault,
          label: vaultLabel,
          ...(multiple
            ? { envVars: vaultEnvVars }
            : vaultEnvVar.trim().length > 0
              ? { envVar: vaultEnvVar }
              : {}),
        }
    : { type: "save", values };
  const canSave =
    source === null
      ? typedReply !== null && secretRequestAnswerInput(item, typedReply) !== null
      : reference.trim().length > 0;

  const send = async (reply: SecretRequestReply) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    // A password field that leaves the page with text in it can prompt to save a login,
    // so the card is emptied before it closes; a failed answer puts the values back.
    const typed = values;
    setValues({});

    if (reply.type === "save-to-vault" && usingManagedBoatVault && managedBoatVault !== null) {
      const fields: Array<ProjectCredentialSaveField> = multiple
        ? inputs.map((fieldInput) => {
            const rawEnv = secretRequestValue(reply.envVars ?? {}, fieldInput.key).trim();
            const parsedEnv = rawEnv ? parseCredentialEnvVar(rawEnv) : undefined;
            return {
              name: fieldInput.key,
              label: fieldInput.label,
              value: secretRequestValue(typed, fieldInput.key).trim(),
              ...(parsedEnv !== undefined ? { envVar: parsedEnv } : {}),
            };
          })
        : [
            (() => {
              const rawEnv = reply.envVar?.trim() ?? "";
              const parsedEnv = rawEnv ? parseCredentialEnvVar(rawEnv) : undefined;
              return {
                name: parsedEnv ?? reply.label.trim(),
                label: reply.label.trim(),
                value: secretRequestValue(typed, "").trim(),
                ...(parsedEnv !== undefined ? { envVar: parsedEnv } : {}),
              };
            })(),
          ];
      const saveResult = await saveProjectCredential({
        environmentId: managedBoatVault.managerId,
        input: {
          projectId: managedBoatVault.originProjectId,
          provider: reply.provider,
          vault: reply.vault.trim(),
          label: reply.label.trim(),
          fields,
          autoGrant: true,
        },
      });
      if (saveResult._tag === "Failure") {
        inFlight.current = false;
        setSubmitting(false);
        setValues(typed);
        setSaveToVault(false);
        if (!isAtomCommandInterrupted(saveResult)) {
          pipe(
            squashAtomCommandFailure(saveResult),
            (failure) => secretRequestFailureMessage(failure, messages),
            setError,
          );
        }
        return;
      }
      const directInput = secretRequestAnswerInput(item, { type: "save", values: typed });
      if (directInput === null) {
        inFlight.current = false;
        setSubmitting(false);
        setValues(typed);
        return;
      }
      const boatAnswer = await answer({
        environmentId: props.environmentId,
        input: directInput,
      }).finally(() => {
        inFlight.current = false;
        setSubmitting(false);
      });
      if (boatAnswer._tag === "Success") {
        setReference("");
        return;
      }
      setValues(typed);
      if (!isAtomCommandInterrupted(boatAnswer)) {
        pipe(
          squashAtomCommandFailure(boatAnswer),
          (failure) => secretRequestFailureMessage(failure, messages),
          setError,
        );
      }
      return;
    }

    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setReference("");
      return;
    }
    setValues(typed);
    if (reply.type === "save-to-vault") setSaveToVault(false);
    if (!isAtomCommandInterrupted(result)) {
      pipe(
        squashAtomCommandFailure(result),
        (failure) => secretRequestFailureMessage(failure, messages),
        setError,
      );
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (source === null) {
      if (typedReply !== null) void send(typedReply);
    } else if (secretRequestReference(source, reference) === undefined) {
      setError(source.invalidReferenceMessage);
    } else {
      void send({ type: "reference", source, reference });
    }
  };

  const link = secretRequestLink(item);
  const field = (input: SecretRequestInput, index: number) => (
    <SecretRequestField
      key={input.key}
      id={inputId(index)}
      input={input}
      // A single input is labelled by the card title.
      label={multiple ? input.label : undefined}
      value={secretRequestValue(values, input.key)}
      disabled={submitting}
      invalid={error !== null}
      describedBy={describedBy}
      onChange={(value) => setValues((current) => ({ ...current, [input.key]: value }))}
    />
  );
  const saveButton = (
    <Button type="submit" disabled={submitting || !canSave}>
      {vaultMode ? gt("Save to vault and use") : <T>Save securely</T>}
    </Button>
  );

  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      autoComplete="off"
      // On click, not pointerdown: the mousedown that follows a pointerdown
      // moves focus back off the input. A click that ends a text selection
      // leaves it alone so the reason can still be copied.
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest("input, button, a")) return;
        if (window.getSelection()?.isCollapsed === false) return;
        const empty = inputs.findIndex((input) => !secretRequestValue(values, input.key).trim());
        document.getElementById(inputId(Math.max(empty, 0)))?.focus();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {multiple ? (
          <p className="text-sm font-medium text-foreground">{item.label}</p>
        ) : (
          <label htmlFor={inputId(0)} className="text-sm font-medium text-foreground">
            {item.label}
          </label>
        )}
        {item.reason.trim() ? (
          <p className="text-sm wrap-anywhere text-muted-foreground">{item.reason}</p>
        ) : null}
      </div>
      {link !== null ? (
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <Button
            variant="outline"
            size="sm"
            render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}
          >
            <T>
              Open <Var>{link.host}</Var>
            </T>
            <ExternalLinkIcon aria-hidden />
          </Button>
          {/* A link found in the reason is already shown there. */}
          {item.url !== undefined ? (
            <p className="font-mono text-xs wrap-anywhere text-muted-foreground">{item.url}</p>
          ) : null}
        </div>
      ) : null}
      {availableBookmarks.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            <T>Saved project references</T>
          </span>
          {availableBookmarks.map(([id, bookmark]) => (
            <Button
              key={id}
              type="button"
              size="xs"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setSourceId(bookmark.reference.provider);
                setReference(bookmark.reference.reference);
                setError(null);
              }}
            >
              {bookmark.label}
            </Button>
          ))}
        </div>
      ) : null}
      {multiple ? (
        <div className="flex min-w-0 flex-col gap-2.5">{inputs.map(field)}</div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          {sources.length > 0 ? (
            <SecretSourceSelect
              value={source?.id ?? null}
              sources={sources}
              label={item.label}
              disabled={submitting}
              onValueChange={(next) => {
                setSourceId(next);
                setError(null);
              }}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            {source === null ? (
              inputs.map(field)
            ) : (
              <Input
                id={inputId(0)}
                font="mono"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={source.referencePlaceholder}
                value={reference}
                disabled={submitting}
                aria-invalid={error !== null || undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setReference(event.currentTarget.value);
                  setError(null);
                }}
              />
            )}
          </div>
          {saveButton}
        </div>
      )}
      {vaultModeAvailable ? (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={saveToVault}
              aria-labelledby={vaultCheckLabelId}
              disabled={submitting}
              onCheckedChange={(checked) => setSaveToVault(checked === true)}
            />
            <span id={vaultCheckLabelId}>
              <T>Also save in 1Password for this project</T>
            </span>
          </label>
          {vaultMode ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <Select
                value={effectiveVaultProvider}
                onValueChange={(id) =>
                  setVaultProvider(vaultSources.find((entry) => entry.id === id)?.id ?? null)
                }
              >
                <SelectTrigger size="sm" aria-label={gt("Secret provider")} disabled={submitting}>
                  <SelectValue>
                    {vaultSources.find((entry) => entry.id === effectiveVaultProvider)?.label ??
                      gt("Select a secret provider")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {vaultSources.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Input
                aria-label={gt("Vault name or ID")}
                placeholder={gt("Vault name or ID")}
                value={vault}
                disabled={submitting}
                maxLength={120}
                onChange={(event) => setVault(event.currentTarget.value)}
              />
              <Input
                aria-label={gt("Credential name")}
                placeholder={gt("Credential name")}
                value={vaultLabel}
                disabled={submitting}
                maxLength={100}
                onChange={(event) => setVaultLabel(event.currentTarget.value)}
              />
              {multiple ? (
                <div className="flex flex-col gap-1.5">
                  {inputs.map((fieldInput) => (
                    <Input
                      key={`env:${fieldInput.key}`}
                      font="mono"
                      aria-label={gt("Environment variable for {field} (optional)", {
                        field: fieldInput.label,
                      })}
                      placeholder={gt("Env var for {field} (optional)", {
                        field: fieldInput.label,
                      })}
                      value={secretRequestValue(vaultEnvVars, fieldInput.key)}
                      disabled={submitting}
                      maxLength={128}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setVaultEnvVars((current) => ({ ...current, [fieldInput.key]: next }));
                      }}
                    />
                  ))}
                </div>
              ) : (
                <Input
                  font="mono"
                  aria-label={gt("Environment variable (optional)")}
                  placeholder={gt("Environment variable (optional, e.g. AWS_ACCESS_KEY_ID)")}
                  value={vaultEnvVar}
                  disabled={submitting}
                  maxLength={128}
                  onChange={(event) => setVaultEnvVar(event.currentTarget.value)}
                />
              )}
              <p className="text-xs text-muted-foreground">
                <T>
                  Saves to 1Password and authorizes this project so future sessions and Boats can
                  use it automatically.
                </T>
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 grow basis-52 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {secretRequestPrivacyNote(item, messages)}
        </p>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={submitting}
            onClick={() => void send({ type: "decline" })}
          >
            <T>Decline</T>
          </Button>
          {multiple ? saveButton : null}
        </div>
      </div>
    </form>
  );
}

function SecretRequestField(props: {
  readonly id: string;
  readonly input: SecretRequestInput;
  readonly label: string | undefined;
  readonly value: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy: string;
  readonly onChange: (value: string) => void;
}) {
  const gt = useGT();
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggleReveal = () => {
    const input = inputRef.current;
    const selectionStart = input?.selectionStart ?? null;
    const selectionEnd = input?.selectionEnd ?? null;
    const selectionDirection = input?.selectionDirection ?? undefined;
    flushSync(() => setRevealed((current) => !current));
    if (input !== null && selectionStart !== null && selectionEnd !== null) {
      input.focus();
      input.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    }
  };

  const control = props.input.secret ? (
    <InputGroup>
      <InputGroupInput
        ref={inputRef}
        id={props.id}
        type={revealed ? "text" : "password"}
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={props.input.placeholder}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      <InputGroupAddon align="inline-end">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={props.disabled}
          aria-label={revealed ? gt("Hide secret") : gt("Show secret")}
          aria-pressed={revealed}
          onClick={toggleReveal}
        >
          {revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  ) : (
    <Input
      id={props.id}
      type="text"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      placeholder={props.input.placeholder}
      value={props.value}
      disabled={props.disabled}
      aria-invalid={props.invalid || undefined}
      aria-describedby={props.describedBy}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    />
  );

  if (props.label === undefined) return control;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={props.id} className="text-xs font-medium text-foreground">
        {props.label}
      </label>
      {control}
    </div>
  );
}

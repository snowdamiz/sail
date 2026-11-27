import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  type EnvironmentId,
  type EnvironmentSetupBundle,
  type EnvironmentSetupPreview,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const exportSetup = createEnvironmentRpcCommand(connectionAtomRuntime, {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Console diagnostic label.
  label: "export environment setup",
  tag: WS_METHODS.environmentSetupExport,
});
const importSetup = createEnvironmentRpcCommand(connectionAtomRuntime, {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Console diagnostic label.
  label: "import environment setup",
  tag: WS_METHODS.environmentSetupImport,
});

export function CopySetupDialog() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const fileReaders = useEnvironmentsWithScope(environments, AuthFilesystemReadScope);
  const providerManagers = useEnvironmentsWithScope(environments, AuthProvidersManageScope);
  const settingsWriters = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const terminalOperators = useEnvironmentsWithScope(environments, AuthTerminalOperateScope);
  const sources = environments.filter(
    ({ environmentId }) => fileReaders.has(environmentId) && providerManagers.has(environmentId),
  );
  const targets = environments.filter(
    ({ environmentId }) =>
      settingsWriters.has(environmentId) &&
      providerManagers.has(environmentId) &&
      terminalOperators.has(environmentId),
  );
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const eligible = sources.some(({ environmentId }) =>
    targets.some((target) => environmentId !== target.environmentId),
  );
  if (!eligible && !open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!applying) setOpen(next);
      }}
    >
      <DialogTrigger render={<Button variant="ghost-muted" size="sm" />}>
        {gt("Copy setup")}
      </DialogTrigger>
      <DialogPopup>
        {open && (
          <CopySetupForm
            sources={sources}
            targets={targets}
            onApplying={setApplying}
            onDone={() => setOpen(false)}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function CopySetupForm({
  sources,
  targets,
  onApplying,
  onDone,
}: {
  readonly sources: readonly EnvironmentPresentation[];
  readonly targets: readonly EnvironmentPresentation[];
  readonly onApplying: (applying: boolean) => void;
  readonly onDone: () => void;
}) {
  const gt = useGT();
  const [sourceId, setSource] = useState<EnvironmentId | null>(null);
  const [targetId, setTarget] = useState<EnvironmentId | null>(null);
  const [pending, setPending] = useState<"preview" | "apply" | null>(null);
  const [problem, setProblem] = useState<"export" | "preview" | "apply" | null>(null);
  const [review, setReview] = useState<{
    readonly bundle: EnvironmentSetupBundle;
    readonly preview: EnvironmentSetupPreview;
  } | null>(null);
  const read = useAtomCommand(exportSetup, { reportFailure: false });
  const write = useAtomCommand(importSetup, { reportFailure: false });
  const canRead = useAtomValue(exportSetup.permissionAtom(sourceId));
  const canWrite = useAtomValue(importSetup.permissionAtom(targetId));
  const canPreview =
    canRead &&
    canWrite &&
    sourceId !== null &&
    targetId !== null &&
    sourceId !== targetId &&
    sources.some(({ environmentId }) => environmentId === sourceId) &&
    targets.some(({ environmentId }) => environmentId === targetId);
  const canApply =
    review !== null &&
    (review.preview.settings ||
      review.preview.keybindings ||
      review.preview.themes.length > 0 ||
      review.preview.skills.length > 0 ||
      review.preview.providers.some(({ changed }) => changed));

  async function previewCopy() {
    if (!canPreview || pending !== null) return;
    setReview(null);
    setProblem(null);
    setPending("preview");
    const exported = await read({ environmentId: sourceId, input: {} });
    if (exported._tag === "Failure") {
      setPending(null);
      setProblem("export");
      return;
    }
    const bundle = exported.value;
    const planned = await write({ environmentId: targetId, input: { action: "preview", bundle } });
    setPending(null);
    if (planned._tag === "Failure") {
      setProblem("preview");
      return;
    }
    setReview({ bundle, preview: planned.value });
  }

  async function applyCopy() {
    if (!canPreview || !canApply || pending !== null) return;
    setProblem(null);
    setPending("apply");
    onApplying(true);
    const applied = await write({
      environmentId: targetId,
      input: { action: "apply", bundle: review.bundle, revision: review.preview.revision },
    });
    onApplying(false);
    setPending(null);
    if (applied._tag === "Failure") {
      setReview(null);
      setProblem("apply");
      return;
    }
    onDone();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Copy setup</T>
        </DialogTitle>
        <DialogDescription>
          <T>
            Copy providers, settings, shortcuts, themes, and user skills between two environments.
            Credentials and machine paths stay on their own machines.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-4 sm:grid-cols-2">
          <EnvironmentPicker
            label={gt("Source environment")}
            value={sourceId}
            environments={sources.filter(({ environmentId }) => environmentId !== targetId)}
            disabled={pending !== null}
            onChange={(id) => {
              setSource(id);
              setReview(null);
              setProblem(null);
            }}
          />
          <EnvironmentPicker
            label={gt("Target environment")}
            value={targetId}
            environments={targets.filter(({ environmentId }) => environmentId !== sourceId)}
            disabled={pending !== null}
            onChange={(id) => {
              setTarget(id);
              setReview(null);
              setProblem(null);
            }}
          />
        </div>
        {review !== null && (
          <div className="mt-4 space-y-2 text-sm" aria-live="polite">
            <h3 className="font-medium">
              <T>Changes on the target</T>
            </h3>
            <ul className="list-disc space-y-1 ps-5">
              {review.preview.settings && (
                <li>
                  <T>Server settings</T>
                </li>
              )}
              {review.preview.keybindings && (
                <li>
                  <T>Keyboard shortcuts</T>
                </li>
              )}
              {review.preview.themes.map((theme) => (
                <li key={theme}>{gt("Theme: {name}", { name: theme })}</li>
              ))}
              {review.preview.skills.map(({ root, folder }) => (
                <li key={`${root}/${folder}`}>
                  {gt("Skill: {name}", { name: `${root}/${folder}` })}
                </li>
              ))}
              {review.preview.providers
                .filter(({ changed }) => changed)
                .map(({ id, name }) => (
                  <li key={id}>{gt("Provider: {name}", { name })}</li>
                ))}
            </ul>
            {!canApply && (
              <p>
                <T>No changes to copy.</T>
              </p>
            )}
            {review.preview.providers
              .filter(
                ({ missingEnvironment, missingCredential, needsLocalSetup }) =>
                  missingEnvironment.length > 0 ||
                  missingCredential !== undefined ||
                  needsLocalSetup,
              )
              .map(({ id, name, missingEnvironment, missingCredential, needsLocalSetup }) => (
                <p key={id}>
                  {gt("{name} needs these values on the target: {variables}", {
                    name,
                    variables: [
                      ...missingEnvironment,
                      ...(needsLocalSetup ? [gt("Local executable")] : []),
                      ...(missingCredential === undefined ? [] : [missingCredential]),
                    ].join(", "),
                  })}
                </p>
              ))}
          </div>
        )}
        {problem !== null && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {problem === "export"
              ? gt("Could not export setup from the source environment.")
              : problem === "preview"
                ? gt("Could not preview setup on the target environment.")
                : gt("Could not finish copying setup. Preview again to see what remains.")}
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={pending === "apply"} />}>
          <T>Cancel</T>
        </DialogClose>
        {review === null ? (
          <Button disabled={!canPreview || pending !== null} onClick={() => void previewCopy()}>
            {pending === "preview" ? gt("Preparing preview…") : gt("Preview copy")}
          </Button>
        ) : (
          <Button
            disabled={!canPreview || !canApply || pending !== null}
            onClick={() => void applyCopy()}
          >
            {pending === "apply" ? gt("Copying setup…") : gt("Apply copy")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function EnvironmentPicker({
  label,
  value,
  environments,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: EnvironmentId | null;
  readonly environments: readonly EnvironmentPresentation[];
  readonly disabled: boolean;
  readonly onChange: (id: EnvironmentId | null) => void;
}) {
  const gt = useGT();
  const items = environments.map(({ environmentId, label, displayUrl }) => ({
    value: environmentId,
    label: displayUrl ? `${label} · ${displayUrl}` : label,
  }));
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      <Select items={items} value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder={gt("Select an environment")} />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  TrimmedNonEmptyString,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedThreadRef,
  type SessionTransferAvailableModel,
  type SessionTransferDirection,
  type SessionTransferPreflightResult,
  type SessionTransferTarget,
} from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { AlertTriangleIcon, CircleAlertIcon, InfoIcon, LaptopIcon, ShipIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { sessionTransferEnvironment } from "../state/sessionTransfers";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export interface SessionTransferDialogRequest {
  readonly coordinatorId: EnvironmentId;
  readonly direction: SessionTransferDirection;
  readonly sourceThreadRef: ScopedThreadRef;
  readonly sourceThreadTitle: string;
  readonly target: SessionTransferTarget;
  readonly targetLabel: string;
  readonly preflight: SessionTransferPreflightResult;
}

const useSessionTransferDialogStore = create<{
  request: SessionTransferDialogRequest | null;
  session: number;
}>(() => ({
  request: null,
  session: 0,
}));

export function openSessionTransferDialog(request: SessionTransferDialogRequest) {
  useSessionTransferDialogStore.setState((state) => ({
    request,
    session: state.session + 1,
  }));
}

function closeSessionTransferDialog() {
  useSessionTransferDialogStore.setState({ request: null });
}

function modelOptionKey(
  model: Pick<SessionTransferAvailableModel, "instanceId" | "model">,
): string {
  return `${model.instanceId}\u0000${model.model}`;
}

function formatAvailableModelLabel(model: SessionTransferAvailableModel): string {
  const providerLabel = model.displayName ?? model.driverKind;
  const modelLabel = model.modelName ?? model.model;
  return `${providerLabel} \u00b7 ${modelLabel}`;
}

function toModelSelection(model: SessionTransferAvailableModel): ModelSelection {
  return {
    provider: model.driverKind,
    instanceId: model.instanceId,
    model: model.model,
  } as ModelSelection;
}

export function SessionTransferDialogHost() {
  const request = useSessionTransferDialogStore((state) => state.request);
  const session = useSessionTransferDialogStore((state) => state.session);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears any open transfer dialog request when the host unmounts
  useEffect(() => () => closeSessionTransferDialog(), []);
  return request ? <SessionTransferDialog key={session} request={request} /> : null;
}

function SessionTransferDialog({ request }: { request: SessionTransferDialogRequest }) {
  const gt = useGT();
  const baseId = useId();
  const { preflight } = request;
  const sourceState = preflight.sourceState;

  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    () => preflight.resolvedTargetProjectId ?? preflight.candidateProjects[0]?.projectId ?? "",
  );
  const [cloneDestinationPath, setCloneDestinationPath] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState<string>(() => {
    if (preflight.resolvedModelSelection) {
      const matched = preflight.availableModels.find(
        (candidate) =>
          candidate.instanceId === preflight.resolvedModelSelection?.instanceId &&
          candidate.model === preflight.resolvedModelSelection?.model,
      );
      if (matched) return modelOptionKey(matched);
    }
    const first = preflight.availableModels[0];
    return first ? modelOptionKey(first) : "";
  });

  const hasPausedBlockers =
    sourceState?.hadPendingRuntimeRequest === true || (sourceState?.activeSubagentCount ?? 0) > 0;
  const [autoResume, setAutoResume] = useState(
    () => sourceState?.wasRunning === true && !hasPausedBlockers,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectedModel =
    preflight.availableModels.find((candidate) => modelOptionKey(candidate) === selectedModelKey) ??
    null;
  const selectedProject =
    preflight.candidateProjects.find((candidate) => candidate.projectId === selectedProjectId) ??
    null;

  const trimmedClonePath = cloneDestinationPath.trim();
  const isUnsupported = preflight.unsupportedReason !== null;
  const missingProject = preflight.needsProjectSelection && selectedProject === null;
  const missingClonePath = preflight.needsCloneDestination && trimmedClonePath.length === 0;
  const missingModel = preflight.needsModelSelection && selectedModel === null;
  const canSubmit =
    !isUnsupported && !submitting && !missingProject && !missingClonePath && !missingModel;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    const targetProjectId: ProjectId | undefined = preflight.needsProjectSelection
      ? selectedProject?.projectId
      : (preflight.resolvedTargetProjectId ?? undefined);
    const modelSelectionOverride: ModelSelection | undefined = preflight.needsModelSelection
      ? selectedModel
        ? toModelSelection(selectedModel)
        : undefined
      : (preflight.resolvedModelSelection ?? undefined);

    const result = await runAtomCommand(
      appAtomRegistry,
      sessionTransferEnvironment.start,
      {
        environmentId: request.coordinatorId,
        input: {
          direction: request.direction,
          sourceEnvironmentId: request.sourceThreadRef.environmentId,
          sourceThreadId: request.sourceThreadRef.threadId,
          target: request.target,
          ...(targetProjectId !== undefined ? { targetProjectId } : {}),
          ...(preflight.needsCloneDestination && trimmedClonePath.length > 0
            ? { cloneDestinationPath: TrimmedNonEmptyString.make(trimmedClonePath) }
            : {}),
          ...(modelSelectionOverride !== undefined ? { modelSelectionOverride } : {}),
          autoResume,
          ...(preflight.needsRunningConfirmation ? { confirmedRunningPause: true } : {}),
        },
      },
      { reportFailure: false },
    );

    if (result._tag === "Success") {
      closeSessionTransferDialog();
      return;
    }

    setSubmitting(false);
    if (!isAtomCommandInterrupted(result)) {
      setSubmitError(
        thrownErrorMessage(squashAtomCommandFailure(result), m) ??
          m(msg("Failed to start session transfer.")),
      );
    }
  };

  const DirectionIcon = request.direction === "boat_to_local" ? LaptopIcon : ShipIcon;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) closeSessionTransferDialog();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <DirectionIcon aria-hidden className="size-4 text-muted-foreground" />
              {request.direction === "boat_to_local" ? (
                <T>Move session to Local</T>
              ) : (
                <T>
                  Move session to <Var>{request.targetLabel}</Var>
                </T>
              )}
            </span>
          </DialogTitle>
          <DialogDescription>
            <span className="block truncate">{request.sourceThreadTitle}</span>
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-4">
            {isUnsupported ? (
              <Alert variant="error">
                <CircleAlertIcon />
                <AlertTitle>
                  <T>Session transfer unavailable</T>
                </AlertTitle>
                <AlertDescription>{preflight.unsupportedReason}</AlertDescription>
              </Alert>
            ) : null}

            {!isUnsupported && preflight.needsProjectSelection ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${baseId}-project`}>
                  <T>Destination project</T>
                </Label>
                <p className="text-xs text-muted-foreground">
                  <T>
                    Multiple matching checkouts were found on the destination. Choose where to
                    import this session.
                  </T>
                </p>
                <Select
                  value={selectedProjectId}
                  onValueChange={(value) => {
                    if (typeof value === "string") setSelectedProjectId(value);
                  }}
                >
                  <SelectTrigger id={`${baseId}-project`} aria-label={gt("Destination project")}>
                    <SelectValue>
                      {selectedProject
                        ? `${selectedProject.name} (${selectedProject.workspaceRoot})`
                        : gt("Select a project")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {preflight.candidateProjects.map((project) => (
                      <SelectItem key={project.projectId} value={project.projectId}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{project.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {project.workspaceRoot}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}

            {!isUnsupported && preflight.needsCloneDestination ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${baseId}-clone-path`}>
                  <T>Local clone directory</T>
                </Label>
                <p className="text-xs text-muted-foreground">
                  <T>
                    No local checkout was found for this repository. Enter a directory where Sail
                    should clone it.
                  </T>
                </p>
                <Input
                  id={`${baseId}-clone-path`}
                  value={cloneDestinationPath}
                  onChange={(event) => setCloneDestinationPath(event.target.value)}
                  placeholder={gt("/path/to/local/checkout")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : null}

            {!isUnsupported && preflight.needsModelSelection ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${baseId}-model`}>
                  <T>Destination model</T>
                </Label>
                <p className="text-xs text-muted-foreground">
                  <T>
                    This session's provider or model is not available on the destination. Choose a
                    model to continue with.
                  </T>
                </p>
                {preflight.availableModels.length > 0 ? (
                  <Select
                    value={selectedModelKey}
                    onValueChange={(value) => {
                      if (typeof value === "string") setSelectedModelKey(value);
                    }}
                  >
                    <SelectTrigger id={`${baseId}-model`} aria-label={gt("Destination model")}>
                      <SelectValue>
                        {selectedModel
                          ? formatAvailableModelLabel(selectedModel)
                          : gt("Select a model")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {preflight.availableModels.map((model) => {
                        const key = modelOptionKey(model);
                        return (
                          <SelectItem key={key} value={key}>
                            {formatAvailableModelLabel(model)}
                          </SelectItem>
                        );
                      })}
                    </SelectPopup>
                  </Select>
                ) : (
                  <Alert variant="error">
                    <CircleAlertIcon />
                    <AlertDescription>
                      <T>No compatible models are configured on the destination.</T>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            ) : null}

            {!isUnsupported && preflight.needsRunningConfirmation ? (
              <div className="space-y-3">
                <Alert variant="warning">
                  <AlertTriangleIcon />
                  <AlertTitle>
                    <T>Active work will be paused</T>
                  </AlertTitle>
                  <AlertDescription>
                    <div className="space-y-1">
                      {sourceState?.wasRunning ? (
                        <p>
                          <T>
                            The in-flight turn on the source will be paused cleanly before exporting
                            this session.
                          </T>
                        </p>
                      ) : null}
                      {(sourceState?.activeSubagentCount ?? 0) > 0 ? (
                        <p>
                          {gt(
                            "{count, plural, one {{count} active subagent will be paused without auto-executing on the destination.} other {{count} active subagents will be paused without auto-executing on the destination.}}",
                            { count: sourceState?.activeSubagentCount ?? 0 },
                          )}
                        </p>
                      ) : null}
                      {sourceState?.hadPendingRuntimeRequest ? (
                        <p>
                          <T>
                            Pending approval or secret requests will be paused without
                            auto-executing so you can review them after the move.
                          </T>
                        </p>
                      ) : null}
                    </div>
                  </AlertDescription>
                </Alert>

                {sourceState?.wasRunning ? (
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={autoResume}
                      onCheckedChange={(checked) => setAutoResume(checked === true)}
                    />
                    <span>
                      <T>Resume automatically on destination after move</T>
                    </span>
                  </label>
                ) : null}
              </div>
            ) : null}

            {!isUnsupported && preflight.warnings.length > 0 ? (
              <Alert variant="info">
                <InfoIcon />
                <AlertDescription>
                  <ul className="list-disc space-y-1 ps-4">
                    {preflight.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {submitError !== null ? (
              <Alert variant="error">
                <CircleAlertIcon />
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => closeSessionTransferDialog()}
          >
            {isUnsupported ? <T>Close</T> : <T>Cancel</T>}
          </Button>
          {!isUnsupported ? (
            <Button
              data-slot="dialog-action"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {submitting ? (
                <T>Starting move…</T>
              ) : request.direction === "boat_to_local" ? (
                <T>Move to Local</T>
              ) : (
                <T>Move to Boat</T>
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

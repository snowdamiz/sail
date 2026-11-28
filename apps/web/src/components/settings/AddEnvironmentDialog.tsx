import { errorDisplayMessage, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { pipe } from "effect/Function";
import { ChevronsLeftRightEllipsisIcon, KeyRoundIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  ConnectionOnboarding,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { cn } from "../../lib/utils";
import { formatDesktopSshTarget } from "./EnvironmentRow";
import { Input } from "../ui/input";
import { CommandShortcut } from "../ui/command";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { AnimatedHeight } from "../AnimatedHeight";
import { useOfferMainServer } from "../desktop/MainServerDialog";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectOwnerPassword as connectOwnerPasswordAtom,
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
  probeOwnerPassword as probeOwnerPasswordAtom,
} from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import { desktopSshHostsStateAtom, filterDiscoveredSshHosts } from "~/state/desktopSshHosts";
import { type EnvironmentPresentation, useRelayEnvironmentDiscovery } from "~/state/environments";
import type { AddEnvironmentPrefill } from "~/state/linkedThreadView";
import { useAtomCommand } from "../../state/use-atom-command";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../../keybindings";
import {
  parseManualDesktopSshTarget,
  parsePairingUrlFields,
  parseRemotePairingFields,
  formatDesktopSshConnectionError,
} from "./ConnectionsSettings.logic";

const SSH_PROTOCOL_NAME = "SSH";
const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];
const EMPTY_SAVED_ENVIRONMENTS: ReadonlyArray<EnvironmentPresentation> = [];

// known_hosts can list one host on several ports. Its own bracketed form keeps an IPv6
// host's port separate from the address; no portless known_hosts entry has that form.
const sshHostSuggestionValue = (target: DesktopDiscoveredSshHost) =>
  target.port === null ? target.alias : `[${target.alias}]:${target.port}`;

export interface ReauthenticateRouteTarget {
  readonly environment: EnvironmentPresentation;
  readonly connectionId: string;
  readonly httpBaseUrl: string;
}

type ConnectionMode = "password" | "remote" | "ssh";

type ReadyOwnerPasswordHost = Extract<
  ConnectionOnboarding.OwnerPasswordHost,
  { readonly kind: "ready" }
>;
type UnavailableOwnerPasswordHost = Extract<
  ConnectionOnboarding.OwnerPasswordHost,
  { readonly kind: "unavailable" }
>;

type PasswordStep =
  | { readonly kind: "host" }
  | { readonly kind: "checking"; readonly host: string }
  | {
      readonly kind: "unavailable";
      readonly host: string;
      readonly result: UnavailableOwnerPasswordHost;
    }
  | {
      readonly kind: "ready";
      readonly host: string;
      readonly server: ReadyOwnerPasswordHost;
    }
  | {
      readonly kind: "activation-failed";
      readonly host: string;
      readonly environmentId: EnvironmentId;
      readonly origin: string;
      readonly message: string;
    };

const isSavedConnectionActivationErrorSchema = Schema.is(
  ConnectionOnboarding.SavedConnectionActivationError,
);

function isSavedConnectionActivationError(
  error: unknown,
): error is ConnectionOnboarding.SavedConnectionActivationError {
  return (
    isSavedConnectionActivationErrorSchema(error) ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "SavedConnectionActivationError" &&
      "environmentId" in error &&
      typeof error.environmentId === "string")
  );
}

function isHttpsUrl(value: string): boolean {
  return URL.parse(value)?.protocol === "https:";
}

function resolveDefaultMode(input: {
  readonly isDesktop: boolean;
  readonly prefill: AddEnvironmentPrefill | null;
  readonly reauthTarget: ReauthenticateRouteTarget | null;
}): ConnectionMode {
  if (!input.isDesktop) return "remote";
  if (input.reauthTarget !== null) {
    return isHttpsUrl(input.reauthTarget.httpBaseUrl) ? "password" : "remote";
  }
  if (input.prefill !== null) return "remote";
  return "password";
}

function hostFromUrlOrRaw(value: string): string {
  return URL.parse(value)?.host ?? value;
}

export function AddEnvironmentDialog({
  open,
  prefill = null,
  routeTarget = null,
  reauthTarget = null,
  error: controlledError,
  savedEnvironments = EMPTY_SAVED_ENVIRONMENTS,
  initialHost = "",
  showTrigger = true,
  openedFrom = "settings",
  onConnected,
  onOpenChange,
  onErrorChange,
}: {
  readonly open: boolean;
  /** A machine the user chose elsewhere to pair with; they supply only the pairing code. */
  readonly prefill?: AddEnvironmentPrefill | null;
  readonly routeTarget?: EnvironmentPresentation | null;
  /** An existing refused direct route being re-authenticated in place. */
  readonly reauthTarget?: ReauthenticateRouteTarget | null;
  /** An address already known for the machine being added, such as one a link uses. */
  readonly initialHost?: string;
  readonly error?: string | null;
  readonly savedEnvironments?: ReadonlyArray<EnvironmentPresentation>;
  readonly showTrigger?: boolean;
  readonly openedFrom?: "welcome" | "empty-state" | "settings";
  readonly onConnected?: (environmentId: EnvironmentId) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onErrorChange?: (error: string | null) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const desktopBridge = window.desktopBridge;
  const isDesktop = desktopBridge !== undefined;
  const isHttpsReauth = reauthTarget !== null && isHttpsUrl(reauthTarget.httpBaseUrl);
  const canUsePasswordMode = isDesktop && (reauthTarget === null || isHttpsReauth);
  const canUseSshMode = isDesktop && reauthTarget === null;
  const defaultMode = resolveDefaultMode({ isDesktop, prefill, reauthTarget });
  const resolvedInitialHost = reauthTarget?.httpBaseUrl ?? prefill?.host ?? initialHost;
  const isNewDirectAdd = routeTarget === null && reauthTarget === null && prefill === null;

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const probeOwnerPassword = useAtomCommand(probeOwnerPasswordAtom, { reportFailure: false });
  const connectOwnerPassword = useAtomCommand(connectOwnerPasswordAtom, { reportFailure: false });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const offerMainServer = useOfferMainServer();
  const relayDiscoveryState = useRelayEnvironmentDiscovery();

  const [uncontrolledError, setUncontrolledError] = useState<string | null>(null);
  const error = controlledError !== undefined ? controlledError : uncontrolledError;
  const setError = (next: string | null) => {
    if (onErrorChange) onErrorChange(next);
    else setUncontrolledError(next);
  };

  const savedDesktopSshEnvironmentKeys = (() => {
    const keys = new Set<string>();
    for (const environment of savedEnvironments) {
      if (!environment.entry) continue;
      const profile = environment.entry.profile;
      if (
        environment.entry.target._tag !== "SshConnectionTarget" ||
        Option.isNone(profile) ||
        profile.value._tag !== "SshConnectionProfile"
      ) {
        continue;
      }
      const target = profile.value.target;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  })();

  const initialPasswordStep: PasswordStep =
    reauthTarget !== null && isHttpsReauth && defaultMode === "password"
      ? { kind: "checking", host: reauthTarget.httpBaseUrl }
      : { kind: "host" };
  const [savedBackendMode, setSavedBackendMode] = useState<ConnectionMode>(defaultMode);
  const [savedBackendHost, setSavedBackendHost] = useState(resolvedInitialHost);
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [passwordStep, setPasswordStep] = useState<PasswordStep>(initialPasswordStep);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [isCommittingPassword, setIsCommittingPassword] = useState(false);
  const passwordSubmittingRef = useRef(false);
  const probeGenerationRef = useRef(0);
  const probeAbortControllerRef = useRef<AbortController | null>(null);

  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");
  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");
  const [sshHostSuggestionsOpen, setSshHostSuggestionsOpen] = useState(false);
  const highlightedSshHostRef = useRef<DesktopDiscoveredSshHost | undefined>(undefined);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const savedBackendSessionRef = useRef(0);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSavedBackendMode(defaultMode);
      setPasswordStep(initialPasswordStep);
      setOwnerPassword("");
      setSavedBackendHost(resolvedInitialHost);
      setSavedBackendPairingCode("");
      setSavedBackendSshHost("");
      setSavedBackendSshUsername("");
      setSavedBackendSshPort("");
      if (controlledError === undefined) setUncontrolledError(null);
    }
  }

  const isBusy = isAddingSavedBackend || isCommittingPassword;
  const isSshDiscoveryActive = canUseSshMode && open && savedBackendMode === "ssh";
  const desktopSshHosts = useEnvironmentQuery(
    isSshDiscoveryActive ? desktopSshHostsStateAtom : null,
    messages,
  );
  // The discovery atom is kept alive across dialog opens, so re-read SSH config
  // each time the SSH tab is shown; stale hosts stay visible while it refreshes.
  const refreshDesktopSshHosts = desktopSshHosts.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rereads desktop SSH config through the bridge each time the SSH tab is shown
  useEffect(() => {
    if (isSshDiscoveryActive) refreshDesktopSshHosts();
  }, [isSshDiscoveryActive, refreshDesktopSshHosts]);

  const abortProbe = () => {
    probeGenerationRef.current += 1;
    probeAbortControllerRef.current?.abort();
    probeAbortControllerRef.current = null;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts any in-flight host probe when the dialog closes or unmounts
  useEffect(() => {
    if (!open) {
      probeGenerationRef.current += 1;
      probeAbortControllerRef.current?.abort();
      probeAbortControllerRef.current = null;
    }
    return () => {
      probeGenerationRef.current += 1;
      probeAbortControllerRef.current?.abort();
      probeAbortControllerRef.current = null;
    };
  }, [open]);

  const applyOwnerPasswordProbeResult = (input: {
    readonly host: string;
    readonly generation: number;
    readonly controller: AbortController;
    readonly result: Awaited<ReturnType<typeof probeOwnerPassword>>;
  }) => {
    if (input.generation !== probeGenerationRef.current || input.controller.signal.aborted) {
      return;
    }
    if (probeAbortControllerRef.current === input.controller) {
      probeAbortControllerRef.current = null;
    }

    if (input.result._tag === "Failure") {
      if (!isAtomCommandInterrupted(input.result)) {
        const cause = squashAtomCommandFailure(input.result);
        setError(
          errorDisplayMessage(cause, m) ??
            thrownErrorMessage(cause, m) ??
            gt("Could not reach this server."),
        );
      }
      setPasswordStep({ kind: "host" });
      return;
    }

    if (input.result.value.kind === "unavailable") {
      setPasswordStep({ kind: "unavailable", host: input.host, result: input.result.value });
      return;
    }

    setPasswordStep({ kind: "ready", host: input.host, server: input.result.value });
  };

  const runOwnerPasswordProbe = async (hostInput: string) => {
    const trimmed = hostInput.trim();
    if (reauthTarget === null) {
      if (!trimmed) {
        setError(gt("Enter a server address."));
        return;
      }
      const parsedPairingUrl = parsePairingUrlFields(trimmed);
      if (parsedPairingUrl) {
        abortProbe();
        setError(null);
        setOwnerPassword("");
        setPasswordStep({ kind: "host" });
        setSavedBackendHost(parsedPairingUrl.host);
        setSavedBackendPairingCode(parsedPairingUrl.pairingCode);
        setSavedBackendMode("remote");
        return;
      }
    }

    abortProbe();
    const generation = probeGenerationRef.current;
    const controller = new AbortController();
    probeAbortControllerRef.current = controller;
    setError(null);
    setOwnerPassword("");
    setPasswordStep({ kind: "checking", host: trimmed });

    const destination: ConnectionOnboarding.OwnerPasswordDestination =
      reauthTarget !== null
        ? {
            kind: "reauthenticate",
            environmentId: reauthTarget.environment.environmentId,
            connectionId: reauthTarget.connectionId,
          }
        : routeTarget !== null
          ? {
              kind: "add-route",
              host: trimmed,
              environmentId: routeTarget.environmentId,
            }
          : {
              kind: "add",
              host: trimmed,
              ...(prefill?.environmentId !== undefined
                ? { expectedEnvironmentId: prefill.environmentId }
                : {}),
            };

    const result = await probeOwnerPassword(destination, { signal: controller.signal });
    applyOwnerPasswordProbeResult({ host: trimmed, generation, controller, result });
  };

  const runReauthOwnerPasswordProbe = useEffectEvent(
    async (generation: number, controller: AbortController) => {
      if (reauthTarget === null) return;
      const host = reauthTarget.httpBaseUrl.trim();
      const result = await probeOwnerPassword(
        {
          kind: "reauthenticate",
          environmentId: reauthTarget.environment.environmentId,
          connectionId: reauthTarget.connectionId,
        },
        { signal: controller.signal },
      );
      applyOwnerPasswordProbeResult({ host, generation, controller, result });
    },
  );

  const reauthConnectionId = reauthTarget?.connectionId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes the saved HTTPS route automatically when opening re-authentication in password mode
  useEffect(() => {
    if (!open || reauthConnectionId === null || !isHttpsReauth || savedBackendMode !== "password") {
      return;
    }
    probeAbortControllerRef.current?.abort();
    const controller = new AbortController();
    probeAbortControllerRef.current = controller;
    const generation = probeGenerationRef.current + 1;
    probeGenerationRef.current = generation;
    void runReauthOwnerPasswordProbe(generation, controller);
    return () => {
      probeGenerationRef.current += 1;
      controller.abort();
      if (probeAbortControllerRef.current === controller) {
        probeAbortControllerRef.current = null;
      }
    };
  }, [open, reauthConnectionId, isHttpsReauth, savedBackendMode]);

  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  const unsavedDiscoveredSshHosts = discoveredSshHosts.filter((target) => {
    const address = formatDesktopSshTarget(target);
    return (
      !savedDesktopSshEnvironmentKeys.has(target.alias) &&
      (target.source === "ssh-config" || !savedDesktopSshEnvironmentKeys.has(address))
    );
  });
  const filteredDiscoveredSshHosts = filterDiscoveredSshHosts(
    unsavedDiscoveredSshHosts,
    savedBackendSshHost,
  );
  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending && desktopSshHosts.data === null;
  const discoveredSshHostsError = desktopSshHosts.error;
  const hasSshHostSuggestionContent =
    canUseSshMode && (isLoadingDiscoveredSshHosts || unsavedDiscoveredSshHosts.length > 0);

  const resetDialogState = () => {
    abortProbe();
    savedBackendSessionRef.current += 1;
    setSavedBackendMode(defaultMode);
    setPasswordStep({ kind: "host" });
    setOwnerPassword("");
    setSavedBackendHost(resolvedInitialHost);
    setSavedBackendPairingCode("");
    setSavedBackendSshHost("");
    setSavedBackendSshUsername("");
    setSavedBackendSshPort("");
    setError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (isCommittingPassword || passwordSubmittingRef.current)) return;
    if (!nextOpen) {
      resetDialogState();
    }
    onOpenChange(nextOpen);
  };

  const switchMode = (nextMode: ConnectionMode) => {
    if (isBusy || savedBackendMode === nextMode) return;
    abortProbe();
    setError(null);
    setOwnerPassword("");
    setPasswordStep(
      nextMode === "password" && reauthTarget !== null && isHttpsReauth
        ? { kind: "checking", host: reauthTarget.httpBaseUrl }
        : { kind: "host" },
    );
    setSavedBackendMode(nextMode);
  };

  const switchToPairingWithHost = (hostValue: string) => {
    if (isBusy) return;
    abortProbe();
    setError(null);
    setOwnerPassword("");
    setPasswordStep({ kind: "host" });
    if (hostValue.trim().length > 0) {
      setSavedBackendHost(hostValue.trim());
    }
    setSavedBackendMode("remote");
  };

  const finishDirectConnection = (environmentId: EnvironmentId, hostForOffer: string) => {
    resetDialogState();
    onOpenChange(false);
    onConnected?.(environmentId);

    if (isNewDirectAdd) {
      if (offerMainServer({ environmentId, host: hostForOffer })) return;
      toastManager.add({
        type: "success",
        title: gt("Backend added"),
        description: gt("The environment is saved and will reconnect on app startup."),
      });
      return;
    }

    if (reauthTarget !== null) {
      toastManager.add({
        type: "success",
        title: gt("Signed in again"),
        description: gt("{environment} is signed in and reconnecting.", {
          environment: reauthTarget.environment.label,
        }),
      });
      return;
    }

    if (routeTarget !== null) {
      toastManager.add({
        type: "success",
        title: gt("Route added"),
        description: gt("{environment} now has another way to connect.", {
          environment: routeTarget.label,
        }),
      });
      return;
    }

    toastManager.add({
      type: "success",
      title: gt("Backend added"),
      description: gt("The environment is saved and will reconnect on app startup."),
    });
  };

  const handleSignInWithPassword = async () => {
    if (passwordSubmittingRef.current || passwordStep.kind !== "ready") return;
    if (ownerPassword.length === 0) {
      setError(gt("Enter the owner password."));
      return;
    }

    const redactedPassword = Redacted.make(ownerPassword);
    // Clear the input synchronously before awaiting so credentials do not linger in React state.
    setOwnerPassword("");
    passwordSubmittingRef.current = true;
    setIsCommittingPassword(true);
    setError(null);

    const server = passwordStep.server;
    const host = passwordStep.host;
    const result = await connectOwnerPassword({ server, password: redactedPassword });
    passwordSubmittingRef.current = false;
    setIsCommittingPassword(false);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        const message =
          errorDisplayMessage(cause, m) ?? thrownErrorMessage(cause, m) ?? gt("Could not sign in.");
        if (isSavedConnectionActivationError(cause)) {
          setPasswordStep({
            kind: "activation-failed",
            host,
            environmentId: cause.environmentId,
            origin: server.origin,
            message,
          });
          return;
        }
        setError(message);
      }
      return;
    }

    finishDirectConnection(result.value, hostFromUrlOrRaw(server.origin));
  };

  const handleRetryEnableEnvironment = async () => {
    if (passwordSubmittingRef.current || passwordStep.kind !== "activation-failed") return;
    passwordSubmittingRef.current = true;
    setIsCommittingPassword(true);
    setError(null);

    const { environmentId, origin, host } = passwordStep;
    const result = await setEnvironmentEnabled({ environmentId, enabled: true });
    passwordSubmittingRef.current = false;
    setIsCommittingPassword(false);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        const message =
          errorDisplayMessage(cause, m) ??
          thrownErrorMessage(cause, m) ??
          gt("Failed to switch the backend on.");
        setPasswordStep({
          kind: "activation-failed",
          host,
          environmentId,
          origin,
          message,
        });
      }
      return;
    }

    finishDirectConnection(environmentId, hostFromUrlOrRaw(origin));
  };

  const connectSavedBackendSshTarget = async (target: DesktopSshEnvironmentTarget) => {
    const session = savedBackendSessionRef.current;
    setIsAddingSavedBackend(true);
    setError(null);
    const result = await connectSshEnvironment({
      target,
      label: "",
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
    });
    if (result._tag === "Failure") {
      if (session === savedBackendSessionRef.current && !isAtomCommandInterrupted(result)) {
        pipe(squashAtomCommandFailure(result), formatDesktopSshConnectionError, setError);
      }
      setIsAddingSavedBackend(false);
      return;
    }

    resetDialogState();
    onOpenChange(false);
    onConnected?.(result.value);
    toastManager.add({
      type: "success",
      title: routeTarget ? gt("Route added") : gt("Environment connected"),
      description: routeTarget
        ? gt("{environment} can now be reached over SSH {host}.", {
            environment: routeTarget.label,
            host: target.alias,
          })
        : gt("{host} is ready over an SSH-managed tunnel.", { host: target.alias }),
    });
    setIsAddingSavedBackend(false);
  };

  const handleAddSavedBackend = async () => {
    if (savedBackendMode === "ssh") {
      let target: DesktopSshEnvironmentTarget;
      try {
        target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
      } catch (cause) {
        setError(formatDesktopSshConnectionError(cause));
        return;
      }

      await connectSavedBackendSshTarget(target);
      return;
    }

    setIsAddingSavedBackend(true);
    setError(null);
    let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;
    try {
      remotePairingInput = parseRemotePairingFields({
        host: savedBackendHost,
        pairingCode: savedBackendPairingCode,
      });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? (thrownErrorMessage(cause, m) ?? cause.message)
          : gt("Failed to add backend.");
      setError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not add backend"),
          description: message,
        }),
      );
      setIsAddingSavedBackend(false);
      return;
    }

    const expected = reauthTarget?.environment ?? routeTarget ?? prefill;
    const result = await connectPairing(
      reauthTarget !== null
        ? {
            ...remotePairingInput,
            expectedEnvironmentId: reauthTarget.environment.environmentId,
            replaceConnectionId: reauthTarget.connectionId,
          }
        : {
            ...remotePairingInput,
            ...(expected ? { expectedEnvironmentId: expected.environmentId } : {}),
          },
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        const message =
          cause instanceof Error
            ? (thrownErrorMessage(cause, m) ?? cause.message)
            : gt("Failed to add backend.");
        setError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not add backend"),
            description: message,
          }),
        );
      }
      setIsAddingSavedBackend(false);
      return;
    }

    let resolvedHost = hostFromUrlOrRaw(remotePairingInput.host);
    try {
      resolvedHost = new URL(resolveRemotePairingTarget(remotePairingInput).httpBaseUrl).host;
    } catch {
      // Keep parsed host fallback when pairing input resolves without a full URL.
    }

    setIsAddingSavedBackend(false);
    finishDirectConnection(result.value, resolvedHost);
  };

  const handleSavedBackendSshFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && savedBackendSshHost.trim().length > 0) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSelectSshHostSuggestion = async (target: DesktopDiscoveredSshHost) => {
    if (isBusy || !desktopBridge) return;

    const session = savedBackendSessionRef.current;
    setIsAddingSavedBackend(true);
    setError(null);
    setSavedBackendSshHost(target.alias);
    let resolved: DesktopSshEnvironmentTarget;
    try {
      resolved = await desktopBridge.resolveSshHost(target.alias);
    } catch (cause) {
      if (session === savedBackendSessionRef.current) {
        setError(formatDesktopSshConnectionError(cause));
      }
      setIsAddingSavedBackend(false);
      return;
    }
    if (session !== savedBackendSessionRef.current) {
      setIsAddingSavedBackend(false);
      return;
    }
    if (target.port !== null) resolved = { ...resolved, port: target.port };
    setSavedBackendSshUsername(resolved.username ?? "");
    setSavedBackendSshPort(resolved.port === null ? "" : String(resolved.port));
    await connectSavedBackendSshTarget(resolved);
  };

  const handleSavedBackendSshHostKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    const isSshHostPopupVisible = sshHostSuggestionsOpen && hasSshHostSuggestionContent;
    if (isSshHostPopupVisible) {
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { modelPickerOpen: false },
      });
      const index = threadJumpIndexFromCommand(command ?? "");
      const target = index === null ? undefined : filteredDiscoveredSshHosts[index];
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        setSshHostSuggestionsOpen(false);
        void handleSelectSshHostSuggestion(target);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    const hasHighlightedSshHost =
      isSshHostPopupVisible && highlightedSshHostRef.current !== undefined;
    if (
      !event.defaultPrevented &&
      !hasHighlightedSshHost &&
      event.key === "Enter" &&
      savedBackendSshHost.trim().length > 0
    ) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSavedBackendHostChange = (value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (parsedPairingUrl) {
      abortProbe();
      setError(null);
      setOwnerPassword("");
      setPasswordStep({ kind: "host" });
      setSavedBackendHost(parsedPairingUrl.host);
      setSavedBackendPairingCode(parsedPairingUrl.pairingCode);
      setSavedBackendMode("remote");
      return;
    }
    setSavedBackendHost(value);
    if (savedBackendMode === "password") {
      abortProbe();
      setError(null);
      setOwnerPassword("");
      if (passwordStep.kind !== "host") {
        setPasswordStep({ kind: "host" });
      }
    }
  };

  const renderConnectionModeCard = (input: {
    readonly mode: ConnectionMode;
    readonly title: string;
    readonly description: string;
    readonly icon?: ReactNode;
  }) => {
    const selected = savedBackendMode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        disabled={isBusy}
        onClick={() => switchMode(input.mode)}
      >
        {input.icon ? (
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
              selected
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
            )}
          >
            {input.icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };

  const unavailableReasonMessage = (reason: UnavailableOwnerPasswordHost["reason"]): string => {
    switch (reason) {
      case "unset":
        return gt(
          "This server does not have an owner password set yet. Open it in a browser and set one under Settings \u2192 Sharing & access, or connect with a pairing code.",
        );
      case "disabled":
        return gt(
          "Owner password sign-in is disabled on this server. Connect with a pairing code instead.",
        );
      case "older-server":
        return gt(
          "This server does not support owner password sign-in yet. Update it or connect with a pairing code instead.",
        );
    }
  };

  const renderPasswordModeBody = () => {
    if (passwordStep.kind === "activation-failed") {
      return (
        <div className="space-y-4">
          <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
            <p className="text-2xs font-medium text-muted-foreground">
              <T>Server</T>
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-foreground">
              {passwordStep.origin}
            </p>
          </div>
          <Alert variant="error">
            <AlertDescription>{passwordStep.message}</AlertDescription>
          </Alert>
          <Button
            type="button"
            className="w-full"
            disabled={isCommittingPassword}
            onClick={() => void handleRetryEnableEnvironment()}
          >
            {isCommittingPassword ? gt("Enabling\u2026") : gt("Enable environment")}
          </Button>
        </div>
      );
    }

    if (passwordStep.kind === "ready") {
      return (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSignInWithPassword();
          }}
        >
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {passwordStep.server.label}
              </p>
              <p className="truncate font-mono text-2xs text-muted-foreground">
                {passwordStep.server.origin}
              </p>
            </div>
            {reauthTarget === null ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                disabled={isCommittingPassword}
                onClick={() => {
                  setError(null);
                  setOwnerPassword("");
                  setPasswordStep({ kind: "host" });
                }}
              >
                <T>Change</T>
              </Button>
            ) : null}
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Owner password</T>
            </span>
            <Input
              nativeInput
              type="password"
              autoComplete="current-password"
              autoFocus
              value={ownerPassword}
              onChange={(event) => setOwnerPassword(event.currentTarget.value)}
              placeholder={gt("Enter owner password")}
              disabled={isCommittingPassword}
            />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            className="w-full"
            disabled={isCommittingPassword || ownerPassword.length === 0}
          >
            {isCommittingPassword ? gt("Signing in\u2026") : gt("Sign in")}
          </Button>
        </form>
      );
    }

    if (passwordStep.kind === "unavailable") {
      return (
        <div className="space-y-4">
          {reauthTarget !== null ? (
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <p className="text-2xs font-medium text-muted-foreground">
                <T>Server</T>
              </p>
              <p className="mt-0.5 truncate font-mono text-xs text-foreground">
                {reauthTarget.httpBaseUrl}
              </p>
            </div>
          ) : (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                <T>Server URL</T>
              </span>
              <Input
                value={savedBackendHost}
                onChange={(event) => handleSavedBackendHostChange(event.target.value)}
                placeholder="https://sail.example.com"
                disabled={isBusy}
                spellCheck={false}
              />
            </label>
          )}
          <Alert>
            <AlertDescription>
              {unavailableReasonMessage(passwordStep.result.reason)}
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              disabled={isBusy}
              onClick={() =>
                switchToPairingWithHost(
                  reauthTarget?.httpBaseUrl ?? (passwordStep.result.origin || savedBackendHost),
                )
              }
            >
              <T>Use a pairing code</T>
            </Button>
            {reauthTarget === null ? (
              <Button
                type="button"
                variant="ghost-muted"
                disabled={isBusy}
                onClick={() => void runOwnerPasswordProbe(savedBackendHost)}
              >
                <T>Check again</T>
              </Button>
            ) : null}
          </div>
        </div>
      );
    }

    if (reauthTarget !== null) {
      return (
        <div className="space-y-4">
          <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
            <p className="text-2xs font-medium text-muted-foreground">
              <T>Server</T>
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-foreground">
              {reauthTarget.httpBaseUrl}
            </p>
          </div>
          {passwordStep.kind === "checking" ? (
            <p role="status" className="text-xs text-muted-foreground">
              <T>Checking server…</T>
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {passwordStep.kind !== "checking" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={isBusy}
                onClick={() => void runOwnerPasswordProbe(reauthTarget.httpBaseUrl)}
              >
                <T>Check again</T>
              </Button>
              <Button
                type="button"
                variant="ghost-muted"
                disabled={isBusy}
                onClick={() => switchToPairingWithHost(reauthTarget.httpBaseUrl)}
              >
                <T>Use a pairing code</T>
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    const isChecking = passwordStep.kind === "checking";
    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void runOwnerPasswordProbe(savedBackendHost);
        }}
      >
        <div className="space-y-1.5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Server URL</T>
            </span>
            <Input
              value={savedBackendHost}
              onChange={(event) => handleSavedBackendHostChange(event.target.value)}
              placeholder="https://sail.example.com"
              disabled={isBusy}
              spellCheck={false}
              autoFocus
            />
          </label>
          <span className="block text-2xs text-muted-foreground">
            <T>
              Enter your server&apos;s HTTPS address, or paste a pairing link to switch to pairing
              code.
            </T>
          </span>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          className="w-full"
          disabled={isBusy || isChecking || savedBackendHost.trim().length === 0}
        >
          {isChecking ? gt("Checking\u2026") : gt("Continue")}
        </Button>
      </form>
    );
  };

  const renderRemoteFields = () => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            <T>Host</T>
          </span>
          <Input
            value={savedBackendHost}
            onChange={(event) => handleSavedBackendHostChange(event.target.value)}
            placeholder="backend.example.com"
            disabled={isBusy || reauthTarget !== null}
            readOnly={reauthTarget !== null}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            <T>Pairing code</T>
          </span>
          <Input
            value={savedBackendPairingCode}
            onChange={(event) => setSavedBackendPairingCode(event.target.value)}
            placeholder={gt("PAIRCODE")}
            disabled={isBusy}
            spellCheck={false}
          />
        </label>
      </div>
      {reauthTarget === null ? (
        <div>
          <span className="mt-1 block text-2xs text-muted-foreground">
            <T>Paste a full pairing URL here to fill both fields automatically.</T>
          </span>
        </div>
      ) : null}
    </div>
  );

  const relayRouteOffer =
    routeTarget !== null &&
    !routeTarget.relayManaged &&
    relayDiscoveryState.environments.has(routeTarget.environmentId)
      ? relayDiscoveryState.environments.get(routeTarget.environmentId)!.environment
      : null;

  const addRelayRoute = async () => {
    if (relayRouteOffer === null || routeTarget === null) return;
    setIsAddingSavedBackend(true);
    const result = await registerEnvironment(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: relayRouteOffer.environmentId,
          label: routeTarget.label,
        }),
      }),
    );
    setIsAddingSavedBackend(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error
            ? (thrownErrorMessage(cause, m) ?? cause.message)
            : gt("Could not add the route."),
        );
      }
      return;
    }
    resetDialogState();
    onOpenChange(false);
    onConnected?.(relayRouteOffer.environmentId);
    toastManager.add({
      type: "success",
      title: gt("Route added"),
      description: gt(
        "{environment} falls back to T3 Connect when its other routes are unreachable.",
        { environment: routeTarget.label },
      ),
    });
  };

  const renderRemoteModeBody = () => (
    <div className="space-y-4">
      {relayRouteOffer !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            <T>This machine is on your T3 Connect account. Use it as a fallback route.</T>
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={isBusy}
            onClick={() => void addRelayRoute()}
          >
            <T>Add T3 Connect</T>
          </Button>
        </div>
      ) : null}
      {renderRemoteFields()}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={isBusy}
        onClick={() => void handleAddSavedBackend()}
      >
        <PlusIcon className="size-3.5" />
        {isAddingSavedBackend
          ? reauthTarget !== null
            ? gt("Signing in\u2026")
            : gt("Adding\u2026")
          : reauthTarget !== null
            ? gt("Sign in again")
            : routeTarget
              ? gt("Add route")
              : gt("Add environment")}
      </Button>
    </div>
  );

  const renderSshFields = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="block">
          <label
            htmlFor="saved-backend-ssh-host"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            <T>SSH host or alias</T>
          </label>
          <Autocomplete
            items={filteredDiscoveredSshHosts}
            itemToStringValue={sshHostSuggestionValue}
            mode="none"
            openOnInputClick
            open={sshHostSuggestionsOpen}
            onOpenChange={setSshHostSuggestionsOpen}
            onItemHighlighted={(target) => {
              highlightedSshHostRef.current = target;
            }}
            value={savedBackendSshHost}
            onValueChange={(value, eventDetails) => {
              setSavedBackendSshHost(value);
              if (eventDetails.reason !== "item-press") return;

              const target = filteredDiscoveredSshHosts.find(
                (host) => sshHostSuggestionValue(host) === value,
              );
              if (target) void handleSelectSshHostSuggestion(target);
            }}
          >
            <AutocompleteInput
              id="saved-backend-ssh-host"
              onKeyDown={handleSavedBackendSshHostKeyDown}
              placeholder={gt("Search hosts or type devbox")}
              disabled={isBusy}
              spellCheck={false}
            />
            {hasSshHostSuggestionContent ? (
              <AutocompletePopup>
                {isLoadingDiscoveredSshHosts ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    <T>Loading hosts…</T>
                  </div>
                ) : filteredDiscoveredSshHosts.length > 0 ? (
                  <AutocompleteList className="max-h-72">
                    {filteredDiscoveredSshHosts.map((target, index) => {
                      const address = formatDesktopSshTarget(target);
                      const shortcutCommand = index < 9 ? threadJumpCommandForIndex(index) : null;
                      const shortcutLabel = shortcutCommand
                        ? shortcutLabelForCommand(keybindings, shortcutCommand, navigator.platform)
                        : null;
                      return (
                        <AutocompleteItem
                          key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                          value={target}
                          className="h-8 min-h-8 whitespace-nowrap"
                        >
                          <span className="min-w-0 truncate text-sm font-medium">
                            {target.alias}
                          </span>
                          {address !== target.alias ? (
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {address}
                            </span>
                          ) : (
                            <span className="flex-1" />
                          )}
                          {shortcutLabel ? (
                            <CommandShortcut className="shrink-0">{shortcutLabel}</CommandShortcut>
                          ) : null}
                        </AutocompleteItem>
                      );
                    })}
                  </AutocompleteList>
                ) : (
                  <AutocompleteEmpty className="break-all">
                    <T>
                      No hosts match "<Var>{savedBackendSshHost.trim()}</Var>".
                    </T>
                  </AutocompleteEmpty>
                )}
              </AutocompletePopup>
            ) : null}
          </Autocomplete>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Username</T>
            </span>
            <Input
              value={savedBackendSshUsername}
              onChange={(event) => setSavedBackendSshUsername(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="root"
              disabled={isBusy}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Port</T>
            </span>
            <Input
              value={savedBackendSshPort}
              onChange={(event) => setSavedBackendSshPort(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="22"
              inputMode="numeric"
              disabled={isBusy}
              spellCheck={false}
            />
          </label>
        </div>
        {error || discoveredSshHostsError ? (
          <Alert variant="error">
            <AlertDescription>{error ?? discoveredSshHostsError}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          variant="outline"
          className="w-full"
          disabled={isBusy}
          onClick={() => void handleAddSavedBackend()}
        >
          <PlusIcon className="size-3.5" />
          {isAddingSavedBackend
            ? gt("Adding…")
            : routeTarget
              ? gt("Add route")
              : gt("Add environment")}
        </Button>
      </div>
    </div>
  );

  const modeCount = (canUsePasswordMode ? 1 : 0) + 1 + (canUseSshMode ? 1 : 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {showTrigger ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button size="xs" variant="ghost-muted" aria-label={gt("Add environment")}>
                    <PlusIcon className="size-3" />
                    <span>
                      <T>Add environment</T>
                    </span>
                  </Button>
                }
              />
            }
          />
          <TooltipPopup side="top">
            <T>Add environment</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {reauthTarget !== null
              ? gt("Sign in again to {environment}", {
                  environment: reauthTarget.environment.label,
                })
              : routeTarget
                ? gt("Add a route to {environment}", { environment: routeTarget.label })
                : prefill
                  ? gt("Connect to {environment}", { environment: prefill.label })
                  : openedFrom === "welcome" || openedFrom === "empty-state"
                    ? gt("Sign in to a Sail server")
                    : gt("Add Environment")}
          </DialogTitle>
          <DialogDescription>
            {reauthTarget !== null
              ? canUsePasswordMode
                ? gt(
                    "Enter this server's owner password or a fresh pairing code to reconnect this route.",
                  )
                : gt("Enter a fresh pairing code to reconnect this route.")
              : routeTarget
                ? isDesktop
                  ? gt(
                      "Connect to this machine over another address, such as its Tailscale name. It joins the existing routes instead of adding a second machine.",
                    )
                  : gt(
                      "Pair this machine again over another address, such as its Tailscale name. It joins the existing routes instead of adding a second machine.",
                    )
                : prefill
                  ? gt(
                      "Create a pairing code on {environment}, in its Settings → Sharing & access or with `t3 auth pairing create`, and enter it here.",
                      { environment: prefill.label },
                    )
                  : isDesktop
                    ? gt("Sign in with an owner password, a pairing code, or SSH.")
                    : gt("Pair another environment to this client.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {modeCount > 1 ? (
              <div
                className={cn("grid gap-3", modeCount === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}
              >
                {canUsePasswordMode
                  ? renderConnectionModeCard({
                      mode: "password",
                      title: gt("Password"),
                      description: gt("Sign in with a server's HTTPS URL and owner password."),
                      icon: <KeyRoundIcon aria-hidden className="size-4" />,
                    })
                  : null}
                {renderConnectionModeCard({
                  mode: "remote",
                  title: gt("Pairing code"),
                  description: gt("Enter a backend host and pairing code."),
                  icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
                })}
                {canUseSshMode
                  ? renderConnectionModeCard({
                      mode: "ssh",
                      title: SSH_PROTOCOL_NAME,
                      description: gt("Use local SSH config, agent, and tunnels for the backend."),
                      icon: <TerminalIcon aria-hidden className="size-4" />,
                    })
                  : null}
              </div>
            ) : null}
            <AnimatedHeight>
              {savedBackendMode === "password" && canUsePasswordMode
                ? renderPasswordModeBody()
                : savedBackendMode === "ssh" && canUseSshMode
                  ? renderSshFields()
                  : renderRemoteModeBody()}
            </AnimatedHeight>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

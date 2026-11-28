// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off -- Multi-server integration suite runs real loopback HTTP/WS servers, git repositories, raw fetch proxy checks, and disk assertions.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WebSocket as NodeWebSocket, WebSocketServer } from "@effect/platform-node/NodeWS";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  ChatAttachmentId,
  EnvironmentId,
  EventId,
  GitRefName,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  type RepositoryIdentity,
  RunId,
  RuntimeRequestId,
  type ServerProvider,
  SessionTransferId,
  type SessionTransferProgressEvent,
  type SessionTransferRecord,
  SourceControlProviderKind,
  ThreadId,
  TrimmedNonEmptyString,
  isTerminalSessionTransferPhase,
} from "@t3tools/contracts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as AcpRegistrySessions from "../provider/AcpRegistrySessions.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import { resolveTransferStagingDir } from "../assets/SessionTransferToken.ts";
import * as WorkspacePreviewRevisions from "../assets/WorkspacePreviewRevisions.ts";
import { createAttachmentId, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentSetupTransfer from "../environmentSetup/EnvironmentSetupTransfer.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GuestShareService from "../guest/GuestShareService.ts";
import * as ServerHttp from "../http.ts";
import * as IssueService from "../issue/IssueService.ts";
import * as IssueTrackerConnections from "../issue/IssueTrackerConnections.ts";
import * as Keybindings from "../keybindings.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as McpSignIn from "../mcpApps/McpSignIn.ts";
import * as EventLoopMonitor from "../observability/EventLoopMonitor.ts";
import * as OtlpEndpointCheck from "../observability/OtlpEndpointCheck.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as NativeChildWorkQuery from "../orchestration-v2/NativeChildWorkQuery.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as SessionTransferEndpointService from "../orchestration-v2/SessionTransferEndpointService.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ThreadViewers from "../orchestration-v2/ThreadViewers.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as PeerClientPairing from "../peer/PeerClientPairing.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerThreadRelay from "../peer/PeerThreadRelay.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SessionTransferRepository from "../persistence/SessionTransferRepository.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstallation from "../provider/providerInstallation.ts";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretCheck from "../secrets/SecretCheck.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlBuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "../sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as TriageService from "../triage/TriageService.ts";
import * as NpmRelease from "../cloud/npmRelease.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkflowRuntime from "../workflows/WorkflowRuntime.ts";
import * as Workflows from "../workflows/Workflows.ts";
// oxlint-disable-next-line t3code/no-layout-command-approval-writes -- Multi-server integration harness mocks unused Ws.layer dependency.
import * as LayoutCommandApprovalWrites from "../workspace/LayoutCommandApprovalWrites.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WorkspaceBundle from "../vcs/WorkspaceBundle.ts";
import * as Ws from "../ws.ts";
import * as BoatSupervisor from "./BoatSupervisor.ts";
import * as SessionTransferCoordinator from "./SessionTransferCoordinator.ts";

const NOW_ISO = IsoDateTime.make("2026-11-28T05:00:00.000Z");
const CLAUDE_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: TrimmedNonEmptyString.make("claude-sonnet-4-6"),
};
const CODEX_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: TrimmedNonEmptyString.make("gpt-5.4"),
};
const SHARED_REPO_IDENTITY: RepositoryIdentity = {
  canonicalKey: "github.com/acme/sail-e2e",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/sail-e2e.git",
  },
  owner: "acme",
  name: "sail-e2e",
  displayName: "acme/sail-e2e",
  provider: SourceControlProviderKind.make("github"),
};

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function initGitRepo(
  dir: string,
  options?: { readonly bare?: boolean; readonly branch?: string },
): void {
  NodeFS.mkdirSync(dir, { recursive: true });
  if (options?.bare) {
    git(dir, ["init", "--bare", "-b", options.branch ?? "main"]);
    return;
  }
  git(dir, ["init", "-b", options?.branch ?? "main"]);
  git(dir, ["config", "user.name", "Session Transfer E2E"]);
  git(dir, ["config", "user.email", "transfer-e2e@example.com"]);
  NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "# Sail E2E\n");
  NodeFS.writeFileSync(NodePath.join(dir, "app.ts"), "export const version = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial commit"]);
}

function cloneGitRepo(bareDir: string, targetDir: string): void {
  NodeFS.mkdirSync(NodePath.dirname(targetDir), { recursive: true });
  git(NodePath.dirname(targetDir), ["clone", bareDir, targetDir]);
  git(targetDir, ["config", "user.name", "Session Transfer E2E"]);
  git(targetDir, ["config", "user.email", "transfer-e2e@example.com"]);
}

function listGitWorktreePaths(repoDir: string): ReadonlyArray<string> {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => NodeFS.realpathSync(line.slice("worktree ".length).trim()));
}

function makeServerProvider(
  instanceId: string,
  driver: "claudeAgent" | "codex",
  modelSlugs: ReadonlyArray<string>,
): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(instanceId),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW_ISO,
    slashCommands: [],
    skills: [],
    models: modelSlugs.map((slug) => ({
      slug: TrimmedNonEmptyString.make(slug),
      name: TrimmedNonEmptyString.make(slug),
      isCustom: false,
      capabilities: null,
    })),
  };
}

function makeUnusedWsServicesLayer() {
  return Layer.mergeAll(
    Layer.mock(SecretCheck.SecretCheck)({}),
    Layer.mock(WorkspacePaths.WorkspacePaths)({}),
    Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
    Layer.mock(TriageService.TriageService)({}),
    Layer.mock(TextGenerators.TextGenerators)({}),
    Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
    Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
    Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
    Layer.mock(AcpRegistrySessions.AcpRegistrySessions)({}),
    Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
    Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
    Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
    Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
    Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
    Layer.mock(CommandOutputHub.CommandOutputHub)({}),
    ThreadViewers.layer,
    Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
    Layer.mock(DeviceService.DeviceService)({}),
    Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
    Layer.mock(EnvironmentSetupTransfer.EnvironmentSetupTransfer)({}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.mock(HostResources.HostResources)({}),
    Layer.mock(McpAppRequests.McpAppRequests)({}),
    Layer.mock(McpSignIn.McpSignIn)({}),
    Layer.mock(ModelManifest.ModelManifest)({}),
    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
    Layer.mock(Orchestrator.OrchestratorV2)({}),
    Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
    Layer.mock(PairingGrantStore.PairingGrantStore)({}),
    Layer.mock(PeerLinks.PeerLinks)({}),
    Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
    Layer.mock(PeerThreadRelay.PeerThreadRelay)({}),
    Layer.mock(PeerClientPairing.PeerClientPairing)({}),
    Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
    Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
    Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({}),
    Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
    Layer.mock(PreviewManager.PreviewManager)({}),
    Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
    Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(ProviderAuthService.ProviderAuthService)({}),
    Layer.mock(ProviderInstallation.ProviderInstallation)({}),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
    Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
    Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
    Layer.mock(PullRequestService.PullRequestService)({}),
    Layer.mock(IssueService.IssueService)({}),
    Layer.mock(ThreadIssueService.ThreadIssueService)({}),
    Layer.mock(IssueTrackerConnections.IssueTrackerConnections)({}),
    Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
    Layer.mock(RelayClient.RelayClient)({}),
    Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
    Layer.mock(ReviewService.ReviewService)({}),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
    Workflows.layerDisabled,
    Layer.mock(WorkflowRuntime.WorkflowDefinitions)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(SecretResolver.SecretResolver)({}),
    Layer.mock(GuestShareService.GuestShareService)({}),
    Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
    Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
    Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
    Layer.mock(NpmRelease.NpmRelease)({}),
    Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
    Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
    Layer.mock(StorageCleanup.StorageCleanup)({}),
    Layer.mock(DatabaseStorage.DatabaseStorage)({}),
    Layer.mock(TerminalManager.TerminalManager)({}),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    Layer.mock(UsageService.UsageService)({}),
    Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
    Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
    Layer.mock(WorkspaceFolders.WorkspaceFolders)({}),
    Layer.mock(TaskFolders.TaskFolders)({}),
    Layer.mock(LayoutCommandApprovalWrites.LayoutCommandApprovalWrites)({}),
    Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
    Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
    Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
    Layer.mock(ServerBrowser.ServerBrowser)({
      profileReporter: Effect.succeed(() => Effect.void),
    }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Effect.succeed([]),
    }),
    Layer.mock(ExternalLauncher.ExternalLauncher)({
      resolveAvailableEditors: () => Effect.succeed([]),
      resolveFileManagerRevealKind: () => Effect.succeed("finder"),
    }),
    Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
      resolveTargets: () => Effect.succeed([]),
    }),
    Layer.mock(DirectEndpoints.DirectEndpoints)({
      resolve: () => Effect.succeed([]),
      resolveAvailable: () => Effect.succeed([]),
    }),
    Layer.mock(EventLoopMonitor.EventLoopMonitor)({
      latestNoticeableStall: Effect.undefined,
    }),
    ProviderInstallationGate.layer,
    FeatureFlags.layerTest(),
  );
}

interface NodeRecorder {
  readonly dispatches: Array<Record<string, unknown>>;
  readonly detachedSessions: Array<ProviderSessionId>;
  readonly sentMessages: Array<{
    readonly threadId: ThreadId;
    readonly text: string;
    readonly mode: string | undefined;
    readonly createdBy: string | undefined;
    readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
  }>;
}

interface ManagedProjectEntry {
  readonly project: Project;
  readonly repositoryIdentity: RepositoryIdentity | null;
}

interface SailServerNode {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly stateDir: string;
  readonly path: Path.Path;
  readonly attachmentsDir: string;
  readonly newProjectsRoot: string;
  readonly baseUrl: string;
  readonly projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
  readonly eventSink: EventSink.EventSinkV2["Service"];
  readonly endpoints: SessionTransferEndpointService.SessionTransferEndpointService["Service"];
  readonly repository: SessionTransferRepository.SessionTransferRepository["Service"];
  readonly coordinator?: SessionTransferCoordinator.SessionTransferCoordinator["Service"];
  readonly recorder: NodeRecorder;
  readonly projects: Map<ProjectId, ManagedProjectEntry>;
  readonly registerProject: (input: {
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly repositoryIdentity?: RepositoryIdentity | null;
  }) => void;
  readonly writeAttachmentFile: (
    threadId: ThreadId,
    fileName: string,
    bytes: Uint8Array,
  ) => ChatAttachmentId;
  readonly listThreadIds: () => Effect.Effect<ReadonlyArray<ThreadId>>;
  readonly close: () => Effect.Effect<void>;
}

interface BoatProxyFaults {
  pauseNextBundleUpload?: {
    readonly onArrived: () => void;
    readonly waitRelease: Promise<void>;
  } | null;
  dropNextBundleUpload?: boolean;
}

interface BoatDaemonProxyHandle {
  readonly localUrl: string;
  readonly proxyBearerToken: string;
  readonly upstreamBearerToken: string;
  readonly stats: {
    authSwaps: number;
    unauthorizedRejections: number;
    streamedTransferUploads: Array<{ readonly path: string; readonly bytes: number }>;
    streamedTransferDownloads: Array<{ readonly path: string; readonly bytes: number }>;
    wsUpgrades: number;
    wakeCalls: number;
    rejectedWhileSleeping: number;
  };
  readonly faults: BoatProxyFaults;
  getState: () => string;
  setState: (nextState: string) => void;
  captureCachedMetadata: () => Promise<void>;
  wake: () => void;
  close: () => Promise<void>;
  readonly isListening: () => boolean;
}

async function startBoatDaemonProxy(options: {
  readonly upstreamBaseUrl: string;
  readonly upstreamBearerToken: string;
  readonly proxyBearerToken: string;
  readonly initialState?: string;
}): Promise<BoatDaemonProxyHandle> {
  let machineState = options.initialState ?? "idle";
  let cachedServerConfig: unknown = null;
  let cachedShellSnapshot: unknown = null;
  const activeProxyTickets = new Set<string>();
  const activeWsClients = new Set<NodeWebSocket>();
  const stats = {
    authSwaps: 0,
    unauthorizedRejections: 0,
    streamedTransferUploads: [] as Array<{ readonly path: string; readonly bytes: number }>,
    streamedTransferDownloads: [] as Array<{ readonly path: string; readonly bytes: number }>,
    wsUpgrades: 0,
    wakeCalls: 0,
    rejectedWhileSleeping: 0,
  };
  const faults: BoatProxyFaults = {
    pauseNextBundleUpload: null,
    dropNextBundleUpload: false,
  };

  const upstreamUrl = new URL(options.upstreamBaseUrl);

  const fetchUpstreamWsTicket = async (): Promise<string> => {
    const res = await fetch(`${options.upstreamBaseUrl}/api/auth/websocket-ticket/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.upstreamBearerToken}` },
    });
    if (!res.ok) {
      throw new Error(`Upstream Boat WS ticket failed (${res.status})`);
    }
    const body = (await res.json()) as { readonly ticket: string };
    return body.ticket;
  };

  const callUpstreamUnaryRpc = async (method: string, payload: unknown): Promise<unknown> => {
    const ticket = await fetchUpstreamWsTicket();
    const wsUrl = `${options.upstreamBaseUrl.replace(/^http:/, "ws:")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`;
    return await new Promise<unknown>((resolve, reject) => {
      const ws = new NodeWebSocket(wsUrl);
      ws.once("open", () => {
        ws.send(
          JSON.stringify({ _tag: "Request", id: "cache-1", tag: method, payload, headers: [] }),
        );
      });
      ws.on("message", (raw) => {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        const parsed = JSON.parse(text) as unknown;
        const frames = Array.isArray(parsed) ? parsed : [parsed];
        for (const frame of frames) {
          if (
            typeof frame === "object" &&
            frame !== null &&
            "_tag" in frame &&
            frame._tag === "Exit" &&
            "requestId" in frame &&
            String(frame.requestId) === "cache-1" &&
            "exit" in frame
          ) {
            ws.close();
            resolve((frame as { readonly exit: unknown }).exit);
            return;
          }
        }
      });
      ws.once("error", reject);
    });
  };

  const captureCachedMetadata = async () => {
    cachedServerConfig = await callUpstreamUnaryRpc("server.getConfig", {});
    const shellRes = await fetch(`${options.upstreamBaseUrl}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${options.upstreamBearerToken}` },
    });
    if (shellRes.ok) {
      cachedShellSnapshot = await shellRes.json();
    }
  };

  const server = NodeHttp.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${options.proxyBearerToken}`) {
      stats.unauthorizedRejections += 1;
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
    stats.authSwaps += 1;

    // Mint a proxy-scoped WS ticket (just like sail-boatd Auth::issue_ticket).
    if (req.method === "POST" && reqUrl.pathname === "/api/auth/websocket-ticket/rpc") {
      const ticket = `proxy-ticket-${NodeCrypto.randomBytes(12).toString("hex")}`;
      activeProxyTickets.add(ticket);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ticket }));
      return;
    }

    // Serve cached shell snapshot while Boat is sleeping (matching sail-boatd capture semantics).
    if (machineState === "sleeping") {
      if (
        req.method === "GET" &&
        reqUrl.pathname === "/api/orchestration/shell" &&
        cachedShellSnapshot !== null
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(cachedShellSnapshot));
        return;
      }
      stats.rejectedWhileSleeping += 1;
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("Boat machine is sleeping");
      return;
    }

    const isSessionTransferRoute = reqUrl.pathname.startsWith("/api/session-transfers/");
    const forwardedHeaders: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: upstreamUrl.host,
      authorization: `Bearer ${options.upstreamBearerToken}`,
    };
    delete forwardedHeaders.connection;

    const upstreamReq = NodeHttp.request(
      {
        hostname: upstreamUrl.hostname,
        port: Number(upstreamUrl.port),
        method: req.method,
        path: `${reqUrl.pathname}${reqUrl.search}`,
        headers: forwardedHeaders,
      },
      (upstreamRes) => {
        let downBytes = 0;
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.on("data", (chunk: Buffer) => {
          downBytes += chunk.byteLength;
        });
        upstreamRes.on("end", () => {
          if (isSessionTransferRoute && req.method === "GET") {
            stats.streamedTransferDownloads.push({ path: reqUrl.pathname, bytes: downBytes });
          }
        });
        // Unbuffered direct stream forwarding.
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end();
    });

    if (isSessionTransferRoute && req.method === "POST") {
      let upBytes = 0;
      let faultHandled = false;
      const shouldDrop = faults.dropNextBundleUpload === true;
      if (shouldDrop) {
        faults.dropNextBundleUpload = false;
      }
      const pauseHook = faults.pauseNextBundleUpload ?? null;
      if (pauseHook !== null) {
        faults.pauseNextBundleUpload = null;
      }

      req.on("data", (chunk: Buffer) => {
        upBytes += chunk.byteLength;
        if (shouldDrop && !faultHandled) {
          faultHandled = true;
          // Write a partial chunk then violently drop both sockets to simulate mid-upload proxy cut.
          upstreamReq.write(chunk.subarray(0, Math.max(1, Math.min(32, chunk.byteLength))));
          upstreamReq.destroy(new Error("Injected proxy drop mid-upload"));
          req.destroy();
          res.destroy();
          return;
        }
        if (pauseHook !== null && !faultHandled) {
          faultHandled = true;
          req.pause();
          upstreamReq.write(chunk);
          pauseHook.onArrived();
          void pauseHook.waitRelease.then(() => {
            if (!req.destroyed && !upstreamReq.destroyed) {
              req.resume();
            }
          });
          return;
        }
        if (!upstreamReq.destroyed) {
          const ok = upstreamReq.write(chunk);
          if (!ok) {
            req.pause();
            upstreamReq.once("drain", () => {
              if (!req.destroyed) req.resume();
            });
          }
        }
      });

      req.on("end", () => {
        if (!upstreamReq.destroyed) {
          stats.streamedTransferUploads.push({ path: reqUrl.pathname, bytes: upBytes });
          upstreamReq.end();
        }
      });
      req.on("aborted", () => {
        upstreamReq.destroy();
      });
      return;
    }

    // Standard unbuffered streaming for attachments & other HTTP calls.
    req.pipe(upstreamReq);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const ticket = reqUrl.searchParams.get("wsTicket");
    if (!ticket || !activeProxyTickets.delete(ticket)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    stats.wsUpgrades += 1;
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      activeWsClients.add(clientWs);
      clientWs.once("close", () => {
        activeWsClients.delete(clientWs);
      });

      if (machineState === "sleeping") {
        // While Boat sleeps, answer cached server.getConfig and reject live transfer RPCs.
        clientWs.on("message", (raw) => {
          const text = typeof raw === "string" ? raw : raw.toString("utf8");
          const frame = JSON.parse(text) as {
            readonly _tag?: string;
            readonly id?: string;
            readonly tag?: string;
          };
          if (frame.tag === "server.getConfig" && cachedServerConfig !== null) {
            clientWs.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: frame.id,
                exit: cachedServerConfig,
              }),
            );
            return;
          }
          stats.rejectedWhileSleeping += 1;
          clientWs.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: {
                _tag: "Failure",
                cause: [
                  {
                    _tag: "Fail",
                    error: {
                      _tag: "SessionTransferError",
                      code: "target_unavailable",
                      message: "Boat machine is sleeping and must be woken first.",
                    },
                  },
                ],
              },
            }),
          );
        });
        return;
      }

      // Live pass-through WebSocket bridge with upstream Boat bearer token -> upstream ticket.
      const pendingFromClient: Array<string | Buffer> = [];
      let upstreamWs: NodeWebSocket | null = null;
      let upstreamOpen = false;

      clientWs.on("message", (data, isBinary) => {
        const payload = isBinary ? (data as Buffer) : data.toString("utf8");
        if (upstreamWs !== null && upstreamOpen) {
          upstreamWs.send(payload);
        } else {
          pendingFromClient.push(payload);
        }
      });

      void fetchUpstreamWsTicket()
        .then((upstreamTicket) => {
          if (clientWs.readyState !== NodeWebSocket.OPEN) return;
          const upstreamWsUrl = `${options.upstreamBaseUrl.replace(/^http:/, "ws:")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(upstreamTicket)}`;
          upstreamWs = new NodeWebSocket(upstreamWsUrl);
          activeWsClients.add(upstreamWs);
          upstreamWs.once("open", () => {
            upstreamOpen = true;
            for (const msg of pendingFromClient) {
              upstreamWs?.send(msg);
            }
            pendingFromClient.length = 0;
          });
          upstreamWs.on("message", (data, isBinary) => {
            if (clientWs.readyState === NodeWebSocket.OPEN) {
              clientWs.send(isBinary ? data : data.toString("utf8"));
            }
          });
          upstreamWs.once("close", () => {
            activeWsClients.delete(upstreamWs!);
            if (clientWs.readyState === NodeWebSocket.OPEN) {
              clientWs.close();
            }
          });
          upstreamWs.once("error", () => {
            if (clientWs.readyState === NodeWebSocket.OPEN) {
              clientWs.close();
            }
          });
          clientWs.once("close", () => {
            if (upstreamWs && upstreamWs.readyState === NodeWebSocket.OPEN) {
              upstreamWs.close();
            }
          });
        })
        .catch(() => {
          clientWs.close();
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Proxy failed to bind TCP port");
  }
  const localUrl = `http://127.0.0.1:${address.port}`;

  return {
    localUrl,
    proxyBearerToken: options.proxyBearerToken,
    upstreamBearerToken: options.upstreamBearerToken,
    stats,
    faults,
    getState: () => machineState,
    setState: (nextState: string) => {
      machineState = nextState;
    },
    captureCachedMetadata,
    wake: () => {
      stats.wakeCalls += 1;
      machineState = "idle";
    },
    isListening: () => server.listening,
    close: async () => {
      for (const ws of activeWsClients) {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
      activeWsClients.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
        });
      });
    },
  };
}

function startSailServerNode(options: {
  readonly role: "local" | "boat";
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly stateDir: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly upstreamBearerToken?: string;
  readonly boatProxy?: BoatDaemonProxyHandle;
  readonly boatMachineId?: string;
  readonly boatMachineName?: string;
  readonly boatEnvironmentId?: EnvironmentId;
  readonly daemonProjects?: () => ReadonlyArray<{
    readonly id: string;
    readonly originProjectId?: string | null;
    readonly title?: string;
    readonly repoKey?: string | null;
  }>;
}): Effect.Effect<SailServerNode> {
  return Effect.gen(function* () {
    const nodeScope = yield* Scope.make();
    const newProjectsRoot = NodePath.join(options.stateDir, "managed-projects");
    NodeFS.mkdirSync(newProjectsRoot, { recursive: true });

    const recorder: NodeRecorder = {
      dispatches: [],
      detachedSessions: [],
      sentMessages: [],
    };
    const projects = new Map<ProjectId, ManagedProjectEntry>();
    const validWsTickets = new Set<string>();
    const threadIds = new Set<ThreadId>();

    const registerProject = (input: {
      readonly id: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
      readonly repositoryIdentity?: RepositoryIdentity | null;
    }) => {
      const now = NOW_ISO;
      projects.set(input.id, {
        project: {
          id: input.id,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
        repositoryIdentity: input.repositoryIdentity ?? null,
      });
    };

    const configLayer = ServerConfig.layerTest(options.stateDir, options.stateDir).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
    );

    const sqliteLayer = Layer.fresh(SqlitePersistence.layerConfig).pipe(
      Layer.provideMerge(configLayer),
    );
    const eventStoreLayer = EventStore.layer.pipe(Layer.provideMerge(sqliteLayer));
    const projectionStoreLayer = ProjectionStore.layer.pipe(Layer.provideMerge(eventStoreLayer));
    const eventSinkLayer = EventSink.layer.pipe(Layer.provideMerge(projectionStoreLayer));
    const baseDataLayer = eventSinkLayer;

    const sessionTransferRepoLayer = SessionTransferRepository.layer;
    const secretLayer = ServerSecretStore.layer;
    const signerLayer = AssetSigner.layer.pipe(Layer.provideMerge(secretLayer));
    const settingsLayer = ServerSettings.layer.pipe(
      Layer.provide(Layer.merge(secretLayer, ManagedPolicy.layerTest())),
    );
    const keybindingsLayer = Keybindings.layer;
    const documentTextLayer = DocumentText.layer;
    const vcsProcessLayer = VcsProcess.layer;
    const workspaceBundleLayer = WorkspaceBundle.layer.pipe(Layer.provideMerge(vcsProcessLayer));
    const workspacePreviewRevisionsLayer = WorkspacePreviewRevisions.layer;

    const envIdentityLayer = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(options.environmentId),
    });
    const envLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId: options.environmentId,
        label: TrimmedNonEmptyString.make(options.label),
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: TrimmedNonEmptyString.make("0.0.0-e2e"),
        capabilities: { localSessions: true },
      } as never),
    });

    const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(Option.fromNullishOr(projects.get(id)?.project)),
      getByWorkspaceRoot: (workspaceRoot) => {
        const match = [...projects.values()].find(
          (entry) => entry.project.workspaceRoot === workspaceRoot,
        );
        return Effect.succeed(Option.fromNullishOr(match?.project));
      },
      listPage: (input) => {
        const all = [...projects.values()].map((entry) => ({
          ...entry.project,
          repositoryIdentity: entry.repositoryIdentity,
        }));
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? 200;
        const slice = all.slice(cursor, cursor + limit);
        return Effect.succeed({
          projects: slice,
          nextCursor: cursor + slice.length < all.length ? cursor + slice.length : null,
        } as never);
      },
      create: (input) =>
        Effect.sync(() => {
          const project: Project = {
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          };
          projects.set(project.id, { project, repositoryIdentity: null });
          return project;
        }),
    });

    const managedFoldersLayer = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: newProjectsRoot,
      scratchRoot: Effect.succeedNone,
      createNamedProject: (input) =>
        Effect.sync(() => {
          const slug = input.name.replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
          const workspaceRoot = NodePath.join(
            newProjectsRoot,
            `${slug}-${NodeCrypto.randomBytes(4).toString("hex")}`,
          );
          NodeFS.mkdirSync(workspaceRoot, { recursive: true });
          git(workspaceRoot, ["init", "-b", "main"]);
          git(workspaceRoot, ["config", "user.name", "Boat E2E"]);
          git(workspaceRoot, ["config", "user.email", "boat-e2e@example.com"]);
          const projectId = ProjectId.make(
            `boat-proj-${NodeCrypto.randomBytes(4).toString("hex")}`,
          );
          const project: Project = {
            id: projectId,
            title: input.name,
            workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          };
          projects.set(projectId, { project, repositoryIdentity: null });
          return { projectId, workspaceRoot };
        }),
    });

    const repoIdentityResolverLayer = Layer.mock(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
    )({
      resolve: (cwd) =>
        Effect.sync(() => {
          for (const entry of projects.values()) {
            if (
              cwd === entry.project.workspaceRoot ||
              cwd.startsWith(`${entry.project.workspaceRoot}${NodePath.sep}`)
            ) {
              return entry.repositoryIdentity;
            }
          }
          return null;
        }),
    });

    const providerRegistryLayer = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(options.providers),
    });

    const providerMetaMap = new Map(
      options.providers.map((p) => [
        p.instanceId,
        {
          driver: p.driver,
          continuationKey: String(p.instanceId),
          enabled: p.enabled,
          capabilities: CodexProviderCapabilitiesV2,
        },
      ]),
    );
    const providerAdapterRegistryLayer = Layer.mock(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    )({
      list: () => Effect.succeed(options.providers.map((p) => p.instanceId)),
      getMetadata: (id) => {
        const meta = providerMetaMap.get(id);
        return meta
          ? Effect.succeed(meta)
          : Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId: id }),
            );
      },
    });

    const providerSessionManagerLayer = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)(
      {
        detach: (input) =>
          Effect.sync(() => {
            recorder.detachedSessions.push(input.providerSessionId);
          }),
      },
    );

    const threadManagementLayer = Layer.effect(
      ThreadManagementService.ThreadManagementService,
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        return {
          dispatch: (command: Record<string, unknown>) =>
            Effect.gen(function* () {
              recorder.dispatches.push(command);
              const now = yield* DateTime.now;
              if (command.type === "thread.stop") {
                const threadId = command.threadId as ThreadId;
                const records = yield* store.getThreadRecords(threadId, ["runs"]);
                const events: OrchestrationV2DomainEvent[] = [];
                for (const run of records.runs) {
                  if (
                    run.status === "running" ||
                    run.status === "starting" ||
                    run.status === "preparing" ||
                    run.status === "waiting"
                  ) {
                    events.push({
                      id: EventId.make(`stop:${run.id}:${DateTime.toEpochMillis(now)}`),
                      type: "run.updated",
                      threadId,
                      runId: run.id,
                      occurredAt: now,
                      payload: {
                        ...run,
                        status: "interrupted",
                        completedAt: now,
                      },
                    });
                  }
                }
                if (events.length > 0) {
                  yield* sink.write({ events });
                }
              } else if (command.type === "thread.archive") {
                const threadId = command.threadId as ThreadId;
                const records = yield* store.getThreadRecords(threadId, []);
                yield* sink.write({
                  events: [
                    {
                      id: EventId.make(`archive:${threadId}:${DateTime.toEpochMillis(now)}`),
                      type: "thread.archived",
                      threadId,
                      occurredAt: now,
                      payload: {
                        ...records.thread,
                        archivedAt: now,
                        updatedAt: now,
                      },
                    },
                  ],
                });
              }
              return { sequence: 1, events: [] };
            }),
          forceStopThread: (threadId: ThreadId) =>
            Effect.sync(() => {
              recorder.dispatches.push({ type: "forceStopThread", threadId });
            }),
          sendToThread: (input: {
            readonly threadId: ThreadId;
            readonly messageId: MessageId;
            readonly text: string;
            readonly mode?: string;
            readonly createdBy?: "user" | "system";
            readonly attachments?: ReadonlyArray<{ readonly id: ChatAttachmentId }>;
            readonly modelSelection: ModelSelection;
          }) =>
            Effect.gen(function* () {
              recorder.sentMessages.push({
                threadId: input.threadId,
                text: input.text,
                mode: input.mode,
                createdBy: input.createdBy,
                attachmentIds: (input.attachments ?? []).map((att) => att.id),
              });
              const now = yield* DateTime.now;
              const runId = RunId.make(`send-run:${NodeCrypto.randomBytes(4).toString("hex")}`);
              const existing = yield* store.getThreadRecords(input.threadId, ["runs"]);
              const nextOrdinal = existing.runs.length + 1;
              yield* sink.write({
                events: [
                  {
                    id: EventId.make(`send-msg:${input.messageId}`),
                    type: "message.updated",
                    threadId: input.threadId,
                    runId,
                    occurredAt: now,
                    payload: {
                      createdBy: input.createdBy ?? "user",
                      creationSource: "server",
                      id: input.messageId,
                      threadId: input.threadId,
                      runId,
                      nodeId: null,
                      role: "user",
                      text: input.text,
                      attachments: [],
                      streaming: false,
                      createdAt: now,
                      updatedAt: now,
                    },
                  },
                  {
                    id: EventId.make(`send-run:${runId}`),
                    type: "run.created",
                    threadId: input.threadId,
                    runId,
                    providerInstanceId: input.modelSelection.instanceId,
                    occurredAt: now,
                    payload: {
                      id: runId,
                      threadId: input.threadId,
                      ordinal: nextOrdinal,
                      providerInstanceId: input.modelSelection.instanceId,
                      modelSelection: input.modelSelection,
                      providerThreadId: null,
                      userMessageId: input.messageId,
                      rootNodeId: null,
                      activeAttemptId: null,
                      status: input.mode === "queue" ? "queued" : "running",
                      queuePosition: input.mode === "queue" ? nextOrdinal : null,
                      queueHeld: false,
                      requestedAt: now,
                      startedAt: input.mode === "queue" ? null : now,
                      completedAt: null,
                      checkpointId: null,
                      contextHandoffId: null,
                    },
                  },
                ],
              });
              return { sequence: 1, events: [] };
            }),
        } as never;
      }),
    );

    const boatSupervisorLayer =
      options.role === "local" && options.boatProxy !== undefined
        ? Layer.mock(BoatSupervisor.BoatSupervisor)({
            hasConfiguredBoats: Effect.succeed(true),
            currentState: Effect.sync(() =>
              Option.some({
                machines: [
                  {
                    id: options.boatMachineId ?? "machine-1",
                    environmentId: options.boatEnvironmentId,
                    name: options.boatMachineName ?? "dev-boat",
                    state: options.boatProxy!.getState(),
                    projects: options.daemonProjects?.() ?? [],
                  },
                ],
              }),
            ),
            getMachineProxyAccess: () =>
              Effect.sync(() => ({
                machineId: options.boatMachineId ?? "machine-1",
                environmentId: options.boatEnvironmentId!,
                machineName: options.boatMachineName ?? "dev-boat",
                state: options.boatProxy!.getState(),
                localUrl: options.boatProxy!.localUrl,
                bearerToken: options.boatProxy!.proxyBearerToken,
              })),
            invoke: (command) =>
              Effect.sync(() => {
                if (command.command === "wake_machine") {
                  options.boatProxy!.wake();
                  return { data: { ok: true } };
                }
                if (command.command === "keep_awake") {
                  return { data: { ok: true } };
                }
                return {
                  data: {
                    machines: [
                      {
                        id: options.boatMachineId ?? "machine-1",
                        environmentId: options.boatEnvironmentId,
                        name: options.boatMachineName ?? "dev-boat",
                        state: options.boatProxy!.getState(),
                        projects: options.daemonProjects?.() ?? [],
                      },
                    ],
                  },
                };
              }),
          })
        : Layer.mock(BoatSupervisor.BoatSupervisor)({
            hasConfiguredBoats: Effect.succeed(false),
          });

    const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      getDescriptor: () =>
        Effect.succeed({
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["bearer-access-token"],
          sessionCookieName: TrimmedNonEmptyString.make("t3-e2e"),
        } as never),
      authenticateWebSocketUpgrade: (input) => {
        const reqUrl = new URL(input.url, "http://127.0.0.1");
        const ticket = reqUrl.searchParams.get("wsTicket");
        if (options.upstreamBearerToken !== undefined) {
          if (!ticket || !validWsTickets.delete(ticket)) {
            return Effect.fail(new Error("Invalid or missing Boat WS ticket") as never);
          }
        }
        return Effect.succeed({
          sessionId: AuthSessionId.make(`${options.role}-ws-session`),
          subject: "one-time-token",
          method: "bearer-access-token",
          scopes: [
            AuthAccessReadScope,
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
            AuthSourceControlWriteScope,
          ],
        });
      },
    });

    const sessionStoreLayer = Layer.mock(SessionStore.SessionStore)({
      cookieName: `t3-${options.role}`,
      legacyCookieName: undefined,
      markConnected: () => Effect.void,
      markDisconnected: () => Effect.void,
      awaitInvalidation: () => Effect.never,
    });

    const endpointServiceLayer = SessionTransferEndpointService.layer.pipe(
      Layer.provideMerge(workspaceBundleLayer),
      Layer.provideMerge(providerAdapterRegistryLayer),
      Layer.provideMerge(providerSessionManagerLayer),
      Layer.provideMerge(threadManagementLayer),
      Layer.provideMerge(projectServiceLayer),
      Layer.provideMerge(repoIdentityResolverLayer),
      Layer.provideMerge(documentTextLayer),
      Layer.provideMerge(signerLayer),
      Layer.provideMerge(envIdentityLayer),
      Layer.provideMerge(envLayer),
    );

    const httpServerLayer = NodeHttpServer.layer(NodeHttp.createServer, {
      host: "127.0.0.1",
      port: 0,
    });

    const coreServicesLayer = Layer.mergeAll(
      makeUnusedWsServicesLayer(),
      endpointServiceLayer,
      sessionTransferRepoLayer,
      settingsLayer,
      keybindingsLayer,
      workspacePreviewRevisionsLayer,
      managedFoldersLayer,
      providerRegistryLayer,
      boatSupervisorLayer,
      authLayer,
      sessionStoreLayer,
      Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
      Layer.succeed(SourceControlBuiltInDrivers.SourceControlDrivers, []),
      FetchHttpClient.layer,
    ).pipe(Layer.provideMerge(baseDataLayer));

    const coordinatorLayer =
      options.role === "local"
        ? SessionTransferCoordinator.layer.pipe(
            Layer.provideMerge(httpServerLayer),
            Layer.provideMerge(coreServicesLayer),
          )
        : Layer.empty.pipe(
            Layer.provideMerge(httpServerLayer),
            Layer.provideMerge(coreServicesLayer),
          );

    // Extra Boat HTTP routes matching real Sail server routes used by BoatRemoteClient.
    const checkBoatBearer = (
      request: HttpServerRequest.HttpServerRequest,
    ): HttpServerResponse.HttpServerResponse | null => {
      if (options.upstreamBearerToken === undefined) return null;
      if (request.headers.authorization !== `Bearer ${options.upstreamBearerToken}`) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      return null;
    };

    const layerBoatTicketRoute = HttpRouter.add(
      "POST",
      "/api/auth/websocket-ticket/rpc",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const unauthorized = checkBoatBearer(request);
        if (unauthorized !== null) return unauthorized;
        const ticket = `boat-ticket-${NodeCrypto.randomBytes(12).toString("hex")}`;
        validWsTickets.add(ticket);
        return HttpServerResponse.jsonUnsafe({ ticket }, { status: 200 });
      }),
    );

    const layerBoatShellRoute = HttpRouter.add(
      "GET",
      "/api/orchestration/shell",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const unauthorized = checkBoatBearer(request);
        if (unauthorized !== null) return unauthorized;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly id: string;
        }>`SELECT thread_id AS id FROM orchestration_v2_projection_threads`;
        const threads: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          const rec = yield* store.getThread(ThreadId.make(row.id)).pipe(Effect.option);
          if (Option.isSome(rec) && rec.value.deletedAt === null) {
            threads.push({
              id: rec.value.id,
              projectId: rec.value.projectId,
              title: rec.value.title,
              branch: rec.value.branch,
              worktreePath: rec.value.worktreePath,
            });
          }
        }
        return HttpServerResponse.jsonUnsafe(
          {
            projects: [...projects.values()].map((entry) => ({
              id: entry.project.id,
              title: entry.project.title,
              workspaceRoot: entry.project.workspaceRoot,
              repositoryIdentity: entry.repositoryIdentity,
            })),
            threads,
          },
          { status: 200 },
        );
      }),
    );

    const layerBoatBoundedThreadRoute = HttpRouter.add(
      "GET",
      "/api/orchestration/threads/:threadId/bounded",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const unauthorized = checkBoatBearer(request);
        if (unauthorized !== null) return unauthorized;
        const url = new URL(request.url, "http://127.0.0.1");
        const match = /^\/api\/orchestration\/threads\/([^/]+)\/bounded$/.exec(url.pathname);
        if (!match?.[1]) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const threadId = ThreadId.make(decodeURIComponent(match[1]));
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const records = yield* store
          .getThreadRecords(threadId, ["runs", "runtimeRequests", "subagents"])
          .pipe(Effect.option);
        if (Option.isNone(records)) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        return HttpServerResponse.jsonUnsafe(
          {
            thread: {
              id: records.value.thread.id,
              projectId: records.value.thread.projectId,
              title: records.value.thread.title,
              modelSelection: records.value.thread.modelSelection,
              providerInstanceId: records.value.thread.providerInstanceId,
              branch: records.value.thread.branch,
              worktreePath: records.value.thread.worktreePath,
            },
            runs: records.value.runs.map((run) => ({ status: run.status })),
            runtimeRequests: records.value.runtimeRequests.map((req) => ({
              id: req.id,
              kind: req.kind,
              status: req.status,
              createdAt: DateTime.formatIso(req.createdAt),
            })),
            subagents: records.value.subagents.map((sub) => ({ status: sub.status })),
          },
          { status: 200 },
        );
      }),
    );

    const routesLayer = Layer.mergeAll(
      ServerHttp.layerAssetRoute,
      ServerHttp.layerAttachmentUploadRoute,
      ServerHttp.layerSessionTransferBundleDownloadRoute,
      ServerHttp.layerSessionTransferBundleUploadRoute,
      Ws.layer,
      layerBoatTicketRoute,
      layerBoatShellRoute,
      layerBoatBoundedThreadRoute,
    );

    const fullLayer = HttpRouter.serve(routesLayer, { disableListenLog: true }).pipe(
      Layer.provideMerge(coordinatorLayer),
    );

    const ctx = yield* Layer.buildWithScope(fullLayer, nodeScope).pipe(Effect.orDie);
    const httpServer = Context.get(ctx, HttpServer.HttpServer);
    const serverConfig = Context.get(ctx, ServerConfig.ServerConfig);
    const effectPath = Context.get(ctx, Path.Path);
    const projectionStore = Context.get(ctx, ProjectionStore.ProjectionStoreV2);
    const eventSink = Context.get(ctx, EventSink.EventSinkV2);
    const endpoints = Context.get(
      ctx,
      SessionTransferEndpointService.SessionTransferEndpointService,
    );
    const repository = Context.get(ctx, SessionTransferRepository.SessionTransferRepository);
    const sql = Context.get(ctx, SqlClient.SqlClient);
    const coordinator = Option.getOrUndefined(
      Context.getOption(ctx, SessionTransferCoordinator.SessionTransferCoordinator),
    );

    const baseUrl = HttpServer.formatAddress(httpServer.address);

    const writeAttachmentFile = (
      threadId: ThreadId,
      fileName: string,
      bytes: Uint8Array,
    ): ChatAttachmentId => {
      const id = createAttachmentId(threadId);
      if (id === null) {
        throw new Error(`Failed to create attachment id for ${threadId}`);
      }
      const ext = NodePath.extname(fileName) || ".bin";
      const target = NodePath.join(serverConfig.attachmentsDir, `${id}${ext}`);
      NodeFS.mkdirSync(serverConfig.attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(target, bytes);
      return id;
    };

    const listThreadIds = (): Effect.Effect<ReadonlyArray<ThreadId>> =>
      sql<{
        readonly id: string;
      }>`SELECT thread_id AS id FROM orchestration_v2_projection_threads ORDER BY created_at ASC`.pipe(
        Effect.map((rows) => rows.map((row) => ThreadId.make(row.id))),
        Effect.orDie,
      );

    void threadIds;

    return {
      environmentId: options.environmentId,
      label: options.label,
      stateDir: serverConfig.stateDir,
      path: effectPath,
      attachmentsDir: serverConfig.attachmentsDir,
      newProjectsRoot,
      baseUrl,
      projectionStore,
      eventSink,
      endpoints,
      repository,
      ...(coordinator !== undefined ? { coordinator } : {}),
      recorder,
      projects,
      registerProject,
      writeAttachmentFile,
      listThreadIds,
      close: () => Scope.close(nodeScope, Exit.void),
    };
  });
}

function seedThread(
  node: SailServerNode,
  input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messages?: ReadonlyArray<{
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly attachments?: ReadonlyArray<{
        readonly id: ChatAttachmentId;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
      }>;
    }>;
    readonly activeRun?: boolean;
    readonly queuedPrompts?: ReadonlyArray<string>;
    readonly pendingRuntimeRequests?: ReadonlyArray<{
      readonly id: string;
      readonly kind: "command" | "file-read" | "file-change" | "user_input";
    }>;
  },
) {
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    const thread: OrchestrationV2AppThread = {
      id: input.threadId,
      projectId: input.projectId,
      title: input.title,
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: input.branch !== null ? GitRefName.make(input.branch) : null,
      worktreePath: input.worktreePath,
      createdBy: "user",
      creationSource: "web",
      activeProviderThreadId: ProviderThreadId.make(`pt-${input.threadId}`),
      lineage: {
        rootThreadId: input.threadId,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    const events: OrchestrationV2DomainEvent[] = [
      {
        id: EventId.make(`seed:thread:${input.threadId}`),
        type: "thread.created",
        threadId: input.threadId,
        occurredAt: now,
        payload: thread,
      },
    ];

    for (let i = 0; i < (input.messages ?? []).length; i += 1) {
      const m = input.messages![i]!;
      const msg: OrchestrationV2ConversationMessage = {
        createdBy: m.role === "user" ? "user" : "system",
        creationSource: m.role === "user" ? "web" : "server",
        id: MessageId.make(m.id),
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        role: m.role,
        text: m.text,
        attachments: (m.attachments ?? []).map((att) => ({
          type: "image" as const,
          id: att.id,
          name: att.name,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
        })),
        streaming: false,
        createdAt: now,
        updatedAt: now,
      };
      events.push({
        id: EventId.make(`seed:msg:${input.threadId}:${i}`),
        type: "message.updated",
        threadId: input.threadId,
        occurredAt: now,
        payload: msg,
      });
    }

    let nextOrdinal = 1;
    if (input.activeRun) {
      const runId = RunId.make(`run-active-${input.threadId}`);
      const sessionId = ProviderSessionId.make(`ps-${input.threadId}`);
      const session: OrchestrationV2ProviderSession = {
        id: sessionId,
        driver: ProviderDriverKind.make(
          input.modelSelection.instanceId === "codex" ? "codex" : "claudeAgent",
        ),
        providerInstanceId: input.modelSelection.instanceId,
        status: "running",
        cwd: TrimmedNonEmptyString.make(input.worktreePath ?? "/tmp"),
        model: input.modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const run: OrchestrationV2Run = {
        id: runId,
        threadId: input.threadId,
        ordinal: nextOrdinal,
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        providerThreadId: ProviderThreadId.make(`pt-${input.threadId}`),
        userMessageId: MessageId.make(input.messages?.[0]?.id ?? `msg-${input.threadId}`),
        rootNodeId: NodeId.make(`node-${input.threadId}`),
        activeAttemptId: null,
        status: "running",
        queuePosition: null,
        queueHeld: false,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      nextOrdinal += 1;
      events.push(
        {
          id: EventId.make(`seed:session:${input.threadId}`),
          type: "provider-session.updated",
          threadId: input.threadId,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: session,
        },
        {
          id: EventId.make(`seed:pthread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: ProviderThreadId.make(`pt-${input.threadId}`),
            driver: session.driver,
            providerInstanceId: input.modelSelection.instanceId,
            providerSessionId: sessionId,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`seed:run:${runId}`),
          type: "run.created",
          threadId: input.threadId,
          runId,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: run,
        },
      );

      for (let i = 0; i < (input.pendingRuntimeRequests ?? []).length; i += 1) {
        const req = input.pendingRuntimeRequests![i]!;
        const runtimeReq: OrchestrationV2RuntimeRequest = {
          id: RuntimeRequestId.make(req.id),
          nodeId: NodeId.make(`node-${input.threadId}`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: req.kind,
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        };
        events.push({
          id: EventId.make(`seed:req:${req.id}`),
          type: "runtime-request.updated",
          threadId: input.threadId,
          runId,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: runtimeReq,
        });
      }
    }

    for (let i = 0; i < (input.queuedPrompts ?? []).length; i += 1) {
      const promptText = input.queuedPrompts![i]!;
      const qMsgId = MessageId.make(`qmsg-${input.threadId}-${i}`);
      const qRunId = RunId.make(`qrun-${input.threadId}-${i}`);
      events.push(
        {
          id: EventId.make(`seed:qmsg:${qMsgId}`),
          type: "message.updated",
          threadId: input.threadId,
          runId: qRunId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: qMsgId,
            threadId: input.threadId,
            runId: qRunId,
            nodeId: null,
            role: "user",
            text: promptText,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`seed:qrun:${qRunId}`),
          type: "run.created",
          threadId: input.threadId,
          runId: qRunId,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: qRunId,
            threadId: input.threadId,
            ordinal: nextOrdinal,
            providerInstanceId: input.modelSelection.instanceId,
            modelSelection: input.modelSelection,
            providerThreadId: null,
            userMessageId: qMsgId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "queued",
            queuePosition: i + 1,
            queueHeld: false,
            requestedAt: now,
            startedAt: null,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      );
      nextOrdinal += 1;
    }

    yield* node.eventSink.write({ events });
  });
}

function waitForTerminalTransfer(
  coordinator: SessionTransferCoordinator.SessionTransferCoordinator["Service"],
  transferId: SessionTransferId,
): Effect.Effect<{
  readonly finalRecord: SessionTransferRecord;
  readonly phases: ReadonlyArray<SessionTransferRecord["phase"]>;
}> {
  return Effect.gen(function* () {
    const phases: Array<SessionTransferRecord["phase"]> = [];
    const done = yield* Deferred.make<SessionTransferRecord>();

    const subFiber = yield* coordinator.subscribe.pipe(
      Stream.runForEach((event: SessionTransferProgressEvent) =>
        Effect.gen(function* () {
          const candidates = event._tag === "snapshot" ? event.transfers : [event.transfer];
          for (const rec of candidates) {
            if (rec.transferId !== transferId) continue;
            if (phases[phases.length - 1] !== rec.phase) {
              phases.push(rec.phase);
            }
            if (isTerminalSessionTransferPhase(rec.phase)) {
              yield* Deferred.succeed(done, rec);
            }
          }
        }),
      ),
      Effect.forkChild,
    );

    const finalRecord = yield* Deferred.await(done).pipe(
      Effect.ensuring(Fiber.interrupt(subFiber)),
    );
    return { finalRecord, phases };
  });
}

function assertNoLeakedStaging(stateDir: string): void {
  const stagingRoot = NodePath.join(stateDir, "session-transfers");
  if (!NodeFS.existsSync(stagingRoot)) return;
  const entries = NodeFS.readdirSync(stagingRoot);
  expect(entries).toEqual([]);
}

interface TwoServerEnvironment {
  readonly rootDir: string;
  readonly localNode: SailServerNode;
  readonly boatNode: SailServerNode;
  readonly proxy: BoatDaemonProxyHandle;
  readonly localEnvId: EnvironmentId;
  readonly boatEnvId: EnvironmentId;
  readonly boatMachineId: string;
  readonly teardown: () => Effect.Effect<void>;
}

function setupTwoServerEnvironment(options?: {
  readonly localProviders?: ReadonlyArray<ServerProvider>;
  readonly boatProviders?: ReadonlyArray<ServerProvider>;
  readonly initialBoatState?: string;
  readonly daemonProjects?: () => ReadonlyArray<{
    readonly id: string;
    readonly originProjectId?: string | null;
    readonly title?: string;
    readonly repoKey?: string | null;
  }>;
}): Effect.Effect<TwoServerEnvironment> {
  return Effect.gen(function* () {
    const rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xfer-e2e-"));
    const localStateDir = NodePath.join(rootDir, "local-state");
    const boatStateDir = NodePath.join(rootDir, "boat-state");
    NodeFS.mkdirSync(localStateDir, { recursive: true });
    NodeFS.mkdirSync(boatStateDir, { recursive: true });

    const localEnvId = EnvironmentId.make("env-local-e2e");
    const boatEnvId = EnvironmentId.make("env-boat-e2e");
    const boatMachineId = "boat-machine-e2e";
    const upstreamBearerToken = `boat-upstream-${NodeCrypto.randomBytes(8).toString("hex")}`;
    const proxyBearerToken = `boat-proxy-${NodeCrypto.randomBytes(8).toString("hex")}`;

    const defaultProviders = [
      makeServerProvider("claudeAgent", "claudeAgent", ["claude-sonnet-4-6"]),
      makeServerProvider("codex", "codex", ["gpt-5.4"]),
    ];

    const boatNode = yield* startSailServerNode({
      role: "boat",
      environmentId: boatEnvId,
      label: "dev-boat",
      stateDir: boatStateDir,
      providers: options?.boatProviders ?? defaultProviders,
      upstreamBearerToken,
    });

    const proxy = yield* Effect.promise(() =>
      startBoatDaemonProxy({
        upstreamBaseUrl: boatNode.baseUrl,
        upstreamBearerToken,
        proxyBearerToken,
        initialState: options?.initialBoatState ?? "idle",
      }),
    );

    const localNode = yield* startSailServerNode({
      role: "local",
      environmentId: localEnvId,
      label: "Local MacBook",
      stateDir: localStateDir,
      providers: options?.localProviders ?? defaultProviders,
      boatProxy: proxy,
      boatMachineId,
      boatMachineName: "dev-boat",
      boatEnvironmentId: boatEnvId,
      ...(options?.daemonProjects !== undefined ? { daemonProjects: options.daemonProjects } : {}),
    });

    return {
      rootDir,
      localNode,
      boatNode,
      proxy,
      localEnvId,
      boatEnvId,
      boatMachineId,
      teardown: () =>
        Effect.gen(function* () {
          yield* localNode.close();
          yield* Effect.promise(() => proxy.close());
          yield* boatNode.close();
          expect(proxy.isListening()).toBe(false);
          NodeFS.rmSync(rootDir, { recursive: true, force: true });
        }),
    };
  });
}

describe("SessionTransfer multi-server end-to-end integration", () => {
  it.live(
    "Scenario 1: Idle Local -> Boat preserves unpushed commits, staged/unstaged/untracked state, binary attachments, and provenance",
    () =>
      Effect.gen(function* () {
        const env = yield* setupTwoServerEnvironment();
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const bareRepo = NodePath.join(env.rootDir, "origin.git");
            const localRepo = NodePath.join(env.rootDir, "local-repo");
            const boatRepo = NodePath.join(env.rootDir, "boat-repo");
            initGitRepo(bareRepo, { bare: true });
            initGitRepo(localRepo);
            git(localRepo, ["remote", "add", "origin", bareRepo]);
            git(localRepo, ["push", "-u", "origin", "main"]);
            cloneGitRepo(bareRepo, boatRepo);

            // Create feature branch with 2 unpushed commits + staged + unstaged + untracked binary file.
            git(localRepo, ["checkout", "-b", "feat/idle-transfer"]);
            NodeFS.writeFileSync(NodePath.join(localRepo, "feature.ts"), "export const a = 1;\n");
            git(localRepo, ["add", "feature.ts"]);
            git(localRepo, ["commit", "-m", "unpushed commit 1"]);

            NodeFS.writeFileSync(NodePath.join(localRepo, "feature.ts"), "export const a = 2;\n");
            git(localRepo, ["add", "feature.ts"]);
            git(localRepo, ["commit", "-m", "unpushed commit 2"]);

            // Staged edit + newly staged file.
            NodeFS.writeFileSync(NodePath.join(localRepo, "staged.txt"), "staged payload\n");
            NodeFS.writeFileSync(NodePath.join(localRepo, "app.ts"), "export const version = 2;\n");
            git(localRepo, ["add", "staged.txt", "app.ts"]);

            // Unstaged edit on top of staged file + another unstaged file.
            NodeFS.writeFileSync(
              NodePath.join(localRepo, "app.ts"),
              "export const version = 2;\nexport const dirty = true;\n",
            );
            NodeFS.writeFileSync(NodePath.join(localRepo, "README.md"), "# Sail E2E Modified\n");

            // Untracked binary file in nested directory.
            const untrackedBytes = Uint8Array.from([
              0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xfe, 0xff,
            ]);
            NodeFS.mkdirSync(NodePath.join(localRepo, "notes"), { recursive: true });
            NodeFS.writeFileSync(
              NodePath.join(localRepo, "notes", "untracked.bin"),
              untrackedBytes,
            );

            const expectedHead = git(localRepo, ["rev-parse", "HEAD"]);
            const expectedStatus = git(localRepo, ["status", "--porcelain"]);
            const expectedStagedDiff = git(localRepo, ["diff", "--cached"]);
            const expectedUnstagedDiff = git(localRepo, ["diff"]);

            const localProjectId = ProjectId.make("proj-local-1");
            const boatProjectId = ProjectId.make("proj-boat-1");
            env.localNode.registerProject({
              id: localProjectId,
              title: "Sail E2E",
              workspaceRoot: localRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });
            env.boatNode.registerProject({
              id: boatProjectId,
              title: "Sail E2E",
              workspaceRoot: boatRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });

            // Real binary PNG attachment on Local.
            const sourceThreadId = ThreadId.make("thread-idle-local");
            const pngBytes = Uint8Array.from([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef, 0x42, 0x99,
            ]);
            const sourceAttachmentId = env.localNode.writeAttachmentFile(
              sourceThreadId,
              "screenshot.png",
              pngBytes,
            );

            yield* seedThread(env.localNode, {
              threadId: sourceThreadId,
              projectId: localProjectId,
              title: "Idle Feature Work",
              modelSelection: CLAUDE_MODEL,
              branch: "feat/idle-transfer",
              worktreePath: localRepo,
              messages: [
                {
                  id: "msg-u1",
                  role: "user",
                  text: "Inspect this screenshot and ship the feature.",
                  attachments: [
                    {
                      id: sourceAttachmentId,
                      name: "screenshot.png",
                      mimeType: "image/png",
                      sizeBytes: pngBytes.byteLength,
                    },
                  ],
                },
                {
                  id: "msg-a1",
                  role: "assistant",
                  text: "I updated feature.ts and staged the initial draft.",
                },
              ],
            });

            const coordinator = env.localNode.coordinator!;
            const preflight = yield* coordinator.preflight({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
            });
            expect(preflight.ready).toBe(true);
            expect(preflight.resolvedTargetProjectId).toBe(boatProjectId);

            const started = yield* coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
              targetProjectId: boatProjectId,
            });

            const { finalRecord } = yield* waitForTerminalTransfer(coordinator, started.transferId);
            expect(finalRecord.phase).toBe("completed");
            expect(finalRecord.destinationProjectId).toBe(boatProjectId);
            expect(finalRecord.destinationThreadId).not.toBeNull();
            expect(finalRecord.destinationWorktreePath).not.toBeNull();

            // Verify Boat git state matches Local byte-for-byte.
            const destWorktree = finalRecord.destinationWorktreePath!;
            expect(git(destWorktree, ["rev-parse", "HEAD"])).toBe(expectedHead);
            expect(git(destWorktree, ["status", "--porcelain"])).toBe(expectedStatus);
            expect(git(destWorktree, ["diff", "--cached"])).toBe(expectedStagedDiff);
            expect(git(destWorktree, ["diff"])).toBe(expectedUnstagedDiff);
            const restoredUntracked = new Uint8Array(
              NodeFS.readFileSync(NodePath.join(destWorktree, "notes", "untracked.bin")),
            );
            expect(restoredUntracked).toEqual(untrackedBytes);

            // Verify Boat destination thread provenance + binary attachment bytes.
            const destRecords = yield* env.boatNode.projectionStore.getThreadRecords(
              finalRecord.destinationThreadId!,
              ["messages"],
            );
            expect(destRecords.thread.transferOrigin).toMatchObject({
              transferId: started.transferId,
              environmentId: env.localEnvId,
              projectId: localProjectId,
              threadId: sourceThreadId,
            });
            const destUserMsg = destRecords.messages.find((m) => m.role === "user");
            expect(destUserMsg?.attachments).toHaveLength(1);
            const destAttId = destUserMsg!.attachments[0]!.id;
            expect(destAttId).not.toBe(sourceAttachmentId);
            const destAttPath = resolveAttachmentPathById({
              attachmentsDir: env.boatNode.attachmentsDir,
              attachmentId: destAttId,
            });
            expect(destAttPath).not.toBeNull();
            expect(new Uint8Array(NodeFS.readFileSync(destAttPath!))).toEqual(pngBytes);

            // Verify archived source provenance on Local.
            const sourceAfter = yield* env.localNode.projectionStore.getThread(sourceThreadId);
            expect(sourceAfter.archivedAt).not.toBeNull();
            expect(sourceAfter.transferredTo).toMatchObject({
              transferId: started.transferId,
              environmentId: env.boatEnvId,
              machineId: env.boatMachineId,
              projectId: boatProjectId,
              threadId: finalRecord.destinationThreadId,
            });

            // Verify real loopback proxy semantics (auth swap + unbuffered bundle streaming + WS upgrade).
            expect(env.proxy.stats.authSwaps).toBeGreaterThan(0);
            expect(env.proxy.stats.streamedTransferUploads).toHaveLength(1);
            expect(env.proxy.stats.streamedTransferUploads[0]!.bytes).toBeGreaterThan(0);
            expect(env.proxy.stats.wsUpgrades).toBeGreaterThan(0);

            // Verify zero leftover staging directories on both servers.
            assertNoLeakedStaging(env.localNode.stateDir);
            assertNoLeakedStaging(env.boatNode.stateDir);
          }),
          env.teardown(),
        );
      }),
  );

  it.live(
    "Scenario 2: Running turn mid-stream pauses cleanly on source and auto-continues with queued follow-up prompts on Boat",
    () =>
      Effect.gen(function* () {
        const env = yield* setupTwoServerEnvironment();
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const bareRepo = NodePath.join(env.rootDir, "origin.git");
            const localRepo = NodePath.join(env.rootDir, "local-repo");
            const boatRepo = NodePath.join(env.rootDir, "boat-repo");
            initGitRepo(bareRepo, { bare: true });
            initGitRepo(localRepo);
            git(localRepo, ["remote", "add", "origin", bareRepo]);
            git(localRepo, ["push", "-u", "origin", "main"]);
            cloneGitRepo(bareRepo, boatRepo);

            const localProjectId = ProjectId.make("proj-local-2");
            const boatProjectId = ProjectId.make("proj-boat-2");
            env.localNode.registerProject({
              id: localProjectId,
              title: "Running Repo",
              workspaceRoot: localRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });
            env.boatNode.registerProject({
              id: boatProjectId,
              title: "Running Repo",
              workspaceRoot: boatRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });

            const sourceThreadId = ThreadId.make("thread-running-local");
            yield* seedThread(env.localNode, {
              threadId: sourceThreadId,
              projectId: localProjectId,
              title: "Active Refactor",
              modelSelection: CLAUDE_MODEL,
              branch: "main",
              worktreePath: localRepo,
              messages: [
                { id: "msg-r1", role: "user", text: "Refactor the parser module." },
                { id: "msg-r2", role: "assistant", text: "Refactoring parser now..." },
              ],
              activeRun: true,
              queuedPrompts: ["Then add unit tests for edge cases.", "Finally update the README."],
            });

            const coordinator = env.localNode.coordinator!;
            const preflight = yield* coordinator.preflight({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
            });
            expect(preflight.needsRunningConfirmation).toBe(true);
            expect(preflight.sourceState?.wasRunning).toBe(true);
            expect(preflight.sourceState?.heldQueuedRunCount).toBe(2);

            const started = yield* coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
              targetProjectId: boatProjectId,
              autoResume: true,
              confirmedRunningPause: true,
            });

            const { finalRecord } = yield* waitForTerminalTransfer(coordinator, started.transferId);
            expect(finalRecord.phase).toBe("completed");
            expect(finalRecord.sourceWasRunning).toBe(true);
            expect(finalRecord.autoResume).toBe(true);
            expect(finalRecord.hadPendingRuntimeRequest).toBe(false);

            // Source stopped, detached provider session, and archived cleanly.
            expect(env.localNode.recorder.dispatches.some((d) => d.type === "thread.stop")).toBe(
              true,
            );
            expect(env.localNode.recorder.detachedSessions.length).toBeGreaterThanOrEqual(1);
            const sourceRecords = yield* env.localNode.projectionStore.getThreadRecords(
              sourceThreadId,
              ["runs"],
            );
            expect(sourceRecords.thread.archivedAt).not.toBeNull();
            expect(sourceRecords.runs.some((r) => r.status === "interrupted")).toBe(true);

            // Destination received history + automatic continuation turn + 2 queued follow-ups in order.
            const destThreadId = finalRecord.destinationThreadId!;
            const destRecords = yield* env.boatNode.projectionStore.getThreadRecords(destThreadId, [
              "messages",
              "contextHandoffs",
            ]);
            expect(destRecords.contextHandoffs.length).toBeGreaterThanOrEqual(1);
            expect(destRecords.messages.some((m) => m.text === "Refactor the parser module.")).toBe(
              true,
            );

            const boatSends = env.boatNode.recorder.sentMessages.filter(
              (m) => m.threadId === destThreadId,
            );
            expect(boatSends).toHaveLength(3);
            expect(boatSends[0]?.mode).toBe("auto");
            expect(boatSends[0]?.createdBy).toBe("system");
            expect(boatSends[1]?.mode).toBe("queue");
            expect(boatSends[1]?.text).toBe("Then add unit tests for edge cases.");
            expect(boatSends[2]?.mode).toBe("queue");
            expect(boatSends[2]?.text).toBe("Finally update the README.");

            assertNoLeakedStaging(env.localNode.stateDir);
            assertNoLeakedStaging(env.boatNode.stateDir);
          }),
          env.teardown(),
        );
      }),
  );

  it.live(
    "Scenario 3: Running turn with pending approval/secret request lands PAUSED on Boat without auto-executing or auto-approving",
    () =>
      Effect.gen(function* () {
        const env = yield* setupTwoServerEnvironment();
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const bareRepo = NodePath.join(env.rootDir, "origin.git");
            const localRepo = NodePath.join(env.rootDir, "local-repo");
            const boatRepo = NodePath.join(env.rootDir, "boat-repo");
            initGitRepo(bareRepo, { bare: true });
            initGitRepo(localRepo);
            git(localRepo, ["remote", "add", "origin", bareRepo]);
            git(localRepo, ["push", "-u", "origin", "main"]);
            cloneGitRepo(bareRepo, boatRepo);

            const localProjectId = ProjectId.make("proj-local-3");
            const boatProjectId = ProjectId.make("proj-boat-3");
            env.localNode.registerProject({
              id: localProjectId,
              title: "Approval Repo",
              workspaceRoot: localRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });
            env.boatNode.registerProject({
              id: boatProjectId,
              title: "Approval Repo",
              workspaceRoot: boatRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });

            const sourceThreadId = ThreadId.make("thread-approval-local");
            yield* seedThread(env.localNode, {
              threadId: sourceThreadId,
              projectId: localProjectId,
              title: "Needs Approval",
              modelSelection: CLAUDE_MODEL,
              branch: "main",
              worktreePath: localRepo,
              messages: [{ id: "msg-p1", role: "user", text: "Deploy using secret API token." }],
              activeRun: true,
              pendingRuntimeRequests: [
                {
                  id: "req-approval-1",
                  kind: "command",
                },
                {
                  id: "req-secret-1",
                  kind: "user_input",
                },
              ],
              queuedPrompts: ["Verify deployment health after deploy."],
            });

            const coordinator = env.localNode.coordinator!;
            const started = yield* coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
              targetProjectId: boatProjectId,
              autoResume: true,
              confirmedRunningPause: true,
            });

            const { finalRecord } = yield* waitForTerminalTransfer(coordinator, started.transferId);
            expect(finalRecord.phase).toBe("completed");
            expect(finalRecord.sourceWasRunning).toBe(true);
            expect(finalRecord.hadPendingRuntimeRequest).toBe(true);

            // CRITICAL INVARIANT: Boat must NOT auto-execute or auto-approve!
            const destThreadId = finalRecord.destinationThreadId!;
            expect(env.boatNode.recorder.sentMessages).toHaveLength(0);

            const destRecords = yield* env.boatNode.projectionStore.getThreadRecords(destThreadId, [
              "runs",
              "messages",
              "contextHandoffs",
            ]);
            expect(destRecords.runs).toHaveLength(1);
            expect(destRecords.runs[0]?.status).toBe("queued");
            expect(destRecords.runs[0]?.queueHeld).toBe(true);
            expect(
              destRecords.messages.some((m) => m.text === "Verify deployment health after deploy."),
            ).toBe(true);

            const sourceAfter = yield* env.localNode.projectionStore.getThread(sourceThreadId);
            expect(sourceAfter.archivedAt).not.toBeNull();

            assertNoLeakedStaging(env.localNode.stateDir);
            assertNoLeakedStaging(env.boatNode.stateDir);
          }),
          env.teardown(),
        );
      }),
  );

  it.live(
    "Scenario 4: Round-trip Local -> Boat -> Local avoids branch conflict, preserves archived original history, and restores Boat edits",
    () =>
      Effect.gen(function* () {
        const env = yield* setupTwoServerEnvironment();
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const bareRepo = NodePath.join(env.rootDir, "origin.git");
            const localRepo = NodePath.join(env.rootDir, "local-repo");
            const boatRepo = NodePath.join(env.rootDir, "boat-repo");
            initGitRepo(bareRepo, { bare: true });
            initGitRepo(localRepo);
            git(localRepo, ["remote", "add", "origin", bareRepo]);
            git(localRepo, ["push", "-u", "origin", "main"]);
            cloneGitRepo(bareRepo, boatRepo);

            git(localRepo, ["checkout", "-b", "feat/roundtrip"]);
            NodeFS.writeFileSync(NodePath.join(localRepo, "step1.txt"), "from local\n");
            git(localRepo, ["add", "step1.txt"]);
            git(localRepo, ["commit", "-m", "local step 1"]);

            const localProjectId = ProjectId.make("proj-local-4");
            const boatProjectId = ProjectId.make("proj-boat-4");
            env.localNode.registerProject({
              id: localProjectId,
              title: "Roundtrip Repo",
              workspaceRoot: localRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });
            env.boatNode.registerProject({
              id: boatProjectId,
              title: "Roundtrip Repo",
              workspaceRoot: boatRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });

            const originalThreadId = ThreadId.make("thread-roundtrip-origin");
            yield* seedThread(env.localNode, {
              threadId: originalThreadId,
              projectId: localProjectId,
              title: "Roundtrip Work",
              modelSelection: CLAUDE_MODEL,
              branch: "feat/roundtrip",
              worktreePath: localRepo,
              messages: [{ id: "msg-rt1", role: "user", text: "Start work locally." }],
            });

            const coordinator = env.localNode.coordinator!;

            // Leg 1: Local -> Boat
            const leg1Start = yield* coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId: originalThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
              targetProjectId: boatProjectId,
            });
            const leg1 = yield* waitForTerminalTransfer(coordinator, leg1Start.transferId);
            expect(leg1.finalRecord.phase).toBe("completed");
            const boatThreadId = leg1.finalRecord.destinationThreadId!;
            const boatWorktree = leg1.finalRecord.destinationWorktreePath!;

            // Make additional commits + staged + unstaged + untracked edits on Boat!
            NodeFS.writeFileSync(
              NodePath.join(boatWorktree, "step2-boat.txt"),
              "committed on boat\n",
            );
            git(boatWorktree, ["add", "step2-boat.txt"]);
            git(boatWorktree, ["commit", "-m", "boat commit 2"]);

            NodeFS.writeFileSync(
              NodePath.join(boatWorktree, "boat-staged.txt"),
              "staged on boat\n",
            );
            git(boatWorktree, ["add", "boat-staged.txt"]);
            NodeFS.writeFileSync(
              NodePath.join(boatWorktree, "step1.txt"),
              "from local + boat edit\n",
            );
            const boatUntrackedBytes = Uint8Array.from([0x10, 0x20, 0x30, 0x40, 0x50]);
            NodeFS.writeFileSync(NodePath.join(boatWorktree, "boat-notes.bin"), boatUntrackedBytes);

            const expectedBoatHead = git(boatWorktree, ["rev-parse", "HEAD"]);
            const expectedBoatStatus = git(boatWorktree, ["status", "--porcelain"]);
            const expectedBoatStagedDiff = git(boatWorktree, ["diff", "--cached"]);
            const expectedBoatUnstagedDiff = git(boatWorktree, ["diff"]);

            // Append an assistant message on Boat thread before moving back.
            const now = yield* DateTime.now;
            yield* env.boatNode.eventSink.write({
              events: [
                {
                  id: EventId.make("boat-msg-rt2"),
                  type: "message.updated",
                  threadId: boatThreadId,
                  occurredAt: now,
                  payload: {
                    createdBy: "system",
                    creationSource: "server",
                    id: MessageId.make("msg-rt2-boat"),
                    threadId: boatThreadId,
                    runId: null,
                    nodeId: null,
                    role: "assistant",
                    text: "Completed heavy build and edits on Boat.",
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
              ],
            });

            // Leg 2: Boat -> Local
            const leg2Preflight = yield* coordinator.preflight({
              direction: "boat_to_local",
              sourceEnvironmentId: env.boatEnvId,
              sourceThreadId: boatThreadId,
              target: { kind: "local" },
            });
            expect(leg2Preflight.ready).toBe(true);
            expect(leg2Preflight.resolvedTargetProjectId).toBe(localProjectId);

            const leg2Start = yield* coordinator.start({
              direction: "boat_to_local",
              sourceEnvironmentId: env.boatEnvId,
              sourceThreadId: boatThreadId,
              target: { kind: "local" },
              targetProjectId: localProjectId,
            });
            const leg2 = yield* waitForTerminalTransfer(coordinator, leg2Start.transferId);
            expect(leg2.finalRecord.errorMessage).toBeNull();
            expect(leg2.finalRecord.phase).toBe("completed");
            const returnedThreadId = leg2.finalRecord.destinationThreadId!;
            const returnedWorktree = leg2.finalRecord.destinationWorktreePath!;

            // Verify no row theft: original Local thread is distinct, archived, and untouched.
            expect(returnedThreadId).not.toBe(originalThreadId);
            const origLocalRecords = yield* env.localNode.projectionStore.getThreadRecords(
              originalThreadId,
              ["messages"],
            );
            expect(origLocalRecords.thread.archivedAt).not.toBeNull();
            expect(origLocalRecords.thread.transferredTo?.threadId).toBe(boatThreadId);
            expect(origLocalRecords.messages.map((m) => m.text)).toEqual(["Start work locally."]);

            // Verify branch conflict avoidance (feat/roundtrip already checked out on localRepo).
            expect(leg2.finalRecord.destinationBranch).not.toBeNull();
            expect(leg2.finalRecord.destinationBranch).not.toBe("feat/roundtrip");
            expect(leg2.finalRecord.destinationBranch).toContain("feat/roundtrip");

            // Verify Boat edits restored exactly in returned Local worktree.
            expect(git(returnedWorktree, ["rev-parse", "HEAD"])).toBe(expectedBoatHead);
            expect(git(returnedWorktree, ["status", "--porcelain"])).toBe(expectedBoatStatus);
            expect(git(returnedWorktree, ["diff", "--cached"])).toBe(expectedBoatStagedDiff);
            expect(git(returnedWorktree, ["diff"])).toBe(expectedBoatUnstagedDiff);
            expect(
              new Uint8Array(
                NodeFS.readFileSync(NodePath.join(returnedWorktree, "boat-notes.bin")),
              ),
            ).toEqual(boatUntrackedBytes);

            // Verify returned Local thread has full history including Boat's message + transferOrigin.
            const returnedRecords = yield* env.localNode.projectionStore.getThreadRecords(
              returnedThreadId,
              ["messages"],
            );
            expect(returnedRecords.thread.archivedAt).toBeNull();
            expect(returnedRecords.thread.transferOrigin?.threadId).toBe(boatThreadId);
            expect(
              returnedRecords.messages.some(
                (m) => m.text === "Completed heavy build and edits on Boat.",
              ),
            ).toBe(true);

            // Verify Boat thread was archived pointing back to the returned Local thread.
            const boatAfter = yield* env.boatNode.projectionStore.getThread(boatThreadId);
            expect(boatAfter.archivedAt).not.toBeNull();
            expect(boatAfter.transferredTo?.threadId).toBe(returnedThreadId);

            // Verify proxy streamed download during Boat -> Local as well!
            expect(env.proxy.stats.streamedTransferDownloads).toHaveLength(1);
            expect(env.proxy.stats.streamedTransferDownloads[0]!.bytes).toBeGreaterThan(0);

            assertNoLeakedStaging(env.localNode.stateDir);
            assertNoLeakedStaging(env.boatNode.stateDir);
          }),
          env.teardown(),
        );
      }),
  );

  it.live(
    "Scenario 5: Mid-transfer cancel, mid-upload proxy drop + retry, and post-commit crash reconcileOnStartup are clean and idempotent",
    () =>
      Effect.gen(function* () {
        const env = yield* setupTwoServerEnvironment();
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const bareRepo = NodePath.join(env.rootDir, "origin.git");
            const localRepo = NodePath.join(env.rootDir, "local-repo");
            const boatRepo = NodePath.join(env.rootDir, "boat-repo");
            initGitRepo(bareRepo, { bare: true });
            initGitRepo(localRepo);
            git(localRepo, ["remote", "add", "origin", bareRepo]);
            git(localRepo, ["push", "-u", "origin", "main"]);
            cloneGitRepo(bareRepo, boatRepo);

            NodeFS.writeFileSync(NodePath.join(localRepo, "resilience.txt"), "payload-v1\n");
            git(localRepo, ["add", "resilience.txt"]);
            git(localRepo, ["commit", "-m", "resilience commit"]);
            const expectedHead = git(localRepo, ["rev-parse", "HEAD"]);

            const localProjectId = ProjectId.make("proj-local-5");
            const boatProjectId = ProjectId.make("proj-boat-5");
            env.localNode.registerProject({
              id: localProjectId,
              title: "Resilience Repo",
              workspaceRoot: localRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });
            env.boatNode.registerProject({
              id: boatProjectId,
              title: "Resilience Repo",
              workspaceRoot: boatRepo,
              repositoryIdentity: SHARED_REPO_IDENTITY,
            });

            const coordinator = env.localNode.coordinator!;

            // 5a. Cancel mid-transfer
            const cancelThreadId = ThreadId.make("thread-cancel-local");
            yield* seedThread(env.localNode, {
              threadId: cancelThreadId,
              projectId: localProjectId,
              title: "Cancel Mid Upload",
              modelSelection: CLAUDE_MODEL,
              branch: "main",
              worktreePath: localRepo,
              messages: [{ id: "msg-c1", role: "user", text: "Cancel me mid upload." }],
            });

            let markArrived!: () => void;
            const uploadArrived = new Promise<void>((resolve) => {
              markArrived = resolve;
            });
            let releaseUpload!: () => void;
            const waitRelease = new Promise<void>((resolve) => {
              releaseUpload = resolve;
            });
            env.proxy.faults.pauseNextBundleUpload = {
              onArrived: markArrived,
              waitRelease,
            };

            const cancelStart = yield* coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId: cancelThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
              targetProjectId: boatProjectId,
            });

            yield* Effect.promise(() => uploadArrived);
            yield* coordinator.cancel({ transferId: cancelStart.transferId });
            releaseUpload();

            const cancelledRes = yield* waitForTerminalTransfer(
              coordinator,
              cancelStart.transferId,
            );
            expect(cancelledRes.finalRecord.phase).toBe("cancelled");

            // Source stays unarchived & active; Boat has zero destination threads and zero leaked worktrees/staging.
            const cancelSourceAfter =
              yield* env.localNode.projectionStore.getThread(cancelThreadId);
            expect(cancelSourceAfter.archivedAt).toBeNull();
            expect(cancelSourceAfter.transferredTo).toBeNull();
            expect(yield* env.boatNode.listThreadIds()).toHaveLength(0);
            expect(listGitWorktreePaths(boatRepo)).toEqual([NodeFS.realpathSync(boatRepo)]);
            assertNoLeakedStaging(env.localNode.stateDir);
            assertNoLeakedStaging(env.boatNode.stateDir);

            // 5b. Drop proxy connection mid-upload, then retry cleanly
            env.proxy.faults.dropNextBundleUpload = true;
            const dropStart = yield* coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId: cancelThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
              targetProjectId: boatProjectId,
            });
            const droppedRes = yield* waitForTerminalTransfer(coordinator, dropStart.transferId);
            expect(droppedRes.finalRecord.phase).toBe("failed");
            expect(droppedRes.finalRecord.errorMessage).not.toBeNull();
            expect(yield* env.boatNode.listThreadIds()).toHaveLength(0);
            expect(listGitWorktreePaths(boatRepo)).toEqual([NodeFS.realpathSync(boatRepo)]);

            const retried = yield* coordinator.retry({ transferId: dropStart.transferId });
            expect(retried.phase).toBe("queued");
            const retryDone = yield* waitForTerminalTransfer(coordinator, dropStart.transferId);
            expect(retryDone.finalRecord.phase).toBe("completed");
            expect(git(retryDone.finalRecord.destinationWorktreePath!, ["rev-parse", "HEAD"])).toBe(
              expectedHead,
            );
            expect(yield* env.boatNode.listThreadIds()).toHaveLength(1);
            expect(listGitWorktreePaths(boatRepo)).toHaveLength(2); // main repo + 1 destination worktree

            // 5c. Post-commit crash reconciliation (`reconcileOnStartup`)
            const crashThreadId = ThreadId.make("thread-post-commit-crash");
            yield* seedThread(env.localNode, {
              threadId: crashThreadId,
              projectId: localProjectId,
              title: "Post-Commit Crash",
              modelSelection: CLAUDE_MODEL,
              branch: "main",
              worktreePath: localRepo,
              messages: [{ id: "msg-crash-1", role: "user", text: "Simulate crash after commit." }],
            });

            // Execute real prepare -> stage -> HTTP bundle transfer -> commit on Boat,
            // then persist Local SQLite transfer row at "finalizing_source" as if Local crashed right before finalizeSource!
            const crashTransferId = SessionTransferId.make("tx-crash-reconcile");
            const prepared = yield* env.localNode.endpoints.prepareSource({
              transferId: crashTransferId,
              direction: "local_to_boat",
              threadId: crashThreadId,
              targetEnvironmentId: env.boatEnvId,
              targetMachineId: TrimmedNonEmptyString.make(env.boatMachineId),
              targetMachineName: TrimmedNonEmptyString.make("dev-boat"),
            });
            const staged = yield* env.boatNode.endpoints.stageImport({
              transferId: crashTransferId,
              manifest: prepared.manifest,
              targetProjectId: boatProjectId,
            });
            // Stream the real bundle over HTTP from Local to Boat through the real proxy!
            const bundleRes = yield* Effect.promise(() =>
              fetch(`${env.localNode.baseUrl}${prepared.bundleDownloadRelativeUrl!}`),
            );
            expect(bundleRes.ok).toBe(true);
            const bundleBytes = new Uint8Array(
              yield* Effect.promise(() => bundleRes.arrayBuffer()),
            );
            const uploadRes = yield* Effect.promise(() =>
              fetch(`${env.proxy.localUrl}${staged.bundleUploadRelativeUrl!}`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${env.proxy.proxyBearerToken}`,
                  "content-type": "application/octet-stream",
                  "content-length": String(bundleBytes.byteLength),
                },
                body: bundleBytes,
              }),
            );
            expect(uploadRes.status).toBe(204);

            const committed = yield* env.boatNode.endpoints.commitImport({
              transferId: crashTransferId,
              manifest: prepared.manifest,
              destinationProjectId: boatProjectId,
              destinationThreadId: staged.destinationThreadId,
              autoResume: false,
            });

            // Persist durable SQLite row stuck in "finalizing_source" (post-commit crash state).
            const crashRecord: SessionTransferRecord = {
              transferId: crashTransferId,
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceEnvironmentName: TrimmedNonEmptyString.make("Local MacBook"),
              sourceMachineId: null,
              sourceProjectId: localProjectId,
              sourceThreadId: crashThreadId,
              destinationEnvironmentId: env.boatEnvId,
              destinationEnvironmentName: TrimmedNonEmptyString.make("dev-boat"),
              destinationMachineId: TrimmedNonEmptyString.make(env.boatMachineId),
              destinationProjectId: committed.destinationProjectId,
              destinationThreadId: committed.destinationThreadId,
              phase: "finalizing_source",
              phaseDetail: "Archiving source thread...",
              sourceWasRunning: false,
              autoResume: false,
              hadPendingRuntimeRequest: false,
              destinationBranch: committed.destinationBranch,
              destinationWorktreePath: committed.destinationWorktreePath,
              modelSelectionOverride: null,
              cloneDestinationPath: null,
              warnings: [],
              errorMessage: null,
              createdAt: NOW_ISO,
              updatedAt: NOW_ISO,
              completedAt: null,
            };
            yield* env.localNode.repository.upsert(crashRecord);

            // Reconcile on startup twice to verify completion + idempotency.
            yield* coordinator.reconcileOnStartup;
            yield* coordinator.reconcileOnStartup;

            const reconciled = yield* env.localNode.repository.getById(crashTransferId);
            expect(Option.isSome(reconciled)).toBe(true);
            expect(Option.getOrThrow(reconciled).phase).toBe("completed");

            const crashSourceAfter = yield* env.localNode.projectionStore.getThread(crashThreadId);
            expect(crashSourceAfter.archivedAt).not.toBeNull();
            expect(crashSourceAfter.transferredTo?.threadId).toBe(committed.destinationThreadId);

            // Boat still has exactly 2 destination threads (5b + 5c) and 3 worktrees (main + 5b + 5c): ZERO duplicates!
            expect(yield* env.boatNode.listThreadIds()).toHaveLength(2);
            expect(listGitWorktreePaths(boatRepo)).toHaveLength(3);
            expect(
              NodeFS.existsSync(
                resolveTransferStagingDir(
                  env.boatNode.stateDir,
                  crashTransferId,
                  env.boatNode.path,
                )!,
              ),
            ).toBe(false);
            assertNoLeakedStaging(env.localNode.stateDir);
            assertNoLeakedStaging(env.boatNode.stateDir);
          }),
          env.teardown(),
        );
      }),
  );

  it.live(
    "Scenario 6: Sleeping Boat wakes cleanly, requires modelSelectionOverride on provider mismatch, and transfers remote-less local git repo via full bundle",
    () =>
      Effect.gen(function* () {
        const env = yield* setupTwoServerEnvironment({
          localProviders: [makeServerProvider("claudeAgent", "claudeAgent", ["claude-sonnet-4-6"])],
          boatProviders: [makeServerProvider("codex", "codex", ["gpt-5.4"])],
          initialBoatState: "idle",
        });
        yield* Effect.ensuring(
          Effect.gen(function* () {
            // Capture proxy's sleeping-mode cache (just like sail-boatd does before sleep), then put Boat to sleep!
            yield* Effect.promise(() => env.proxy.captureCachedMetadata());
            env.proxy.setState("sleeping");

            // Remote-less local git repo (ZERO git remotes, zero pre-existing project on Boat!).
            const remoteLessRepo = NodePath.join(env.rootDir, "remoteless-local-repo");
            initGitRepo(remoteLessRepo);
            expect(git(remoteLessRepo, ["remote"])).toBe("");

            git(remoteLessRepo, ["checkout", "-b", "feat/local-only"]);
            NodeFS.writeFileSync(
              NodePath.join(remoteLessRepo, "solo.ts"),
              "export const remoteLess = true;\n",
            );
            git(remoteLessRepo, ["add", "solo.ts"]);
            git(remoteLessRepo, ["commit", "-m", "remote-less commit"]);

            NodeFS.writeFileSync(NodePath.join(remoteLessRepo, "staged-local.txt"), "staged\n");
            git(remoteLessRepo, ["add", "staged-local.txt"]);
            NodeFS.writeFileSync(
              NodePath.join(remoteLessRepo, "solo.ts"),
              "export const remoteLess = true;\nexport const edited = 1;\n",
            );
            NodeFS.writeFileSync(
              NodePath.join(remoteLessRepo, "untracked-local.txt"),
              "untracked-body\n",
            );

            const expectedHead = git(remoteLessRepo, ["rev-parse", "HEAD"]);
            const expectedStatus = git(remoteLessRepo, ["status", "--porcelain"]);
            const expectedStagedDiff = git(remoteLessRepo, ["diff", "--cached"]);
            const expectedUnstagedDiff = git(remoteLessRepo, ["diff"]);

            const localProjectId = ProjectId.make("proj-remoteless");
            env.localNode.registerProject({
              id: localProjectId,
              title: "RemoteLess Repo",
              workspaceRoot: remoteLessRepo,
              repositoryIdentity: null,
            });

            const sourceThreadId = ThreadId.make("thread-remoteless-local");
            yield* seedThread(env.localNode, {
              threadId: sourceThreadId,
              projectId: localProjectId,
              title: "Solo Repo Session",
              modelSelection: CLAUDE_MODEL,
              branch: "feat/local-only",
              worktreePath: remoteLessRepo,
              messages: [{ id: "msg-s6", role: "user", text: "Continue work on Boat." }],
            });

            const coordinator = env.localNode.coordinator!;

            // Preflight without override detects unavailable provider/model on Boat!
            const preflightMissingOverride = yield* coordinator.preflight({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
            });
            expect(preflightMissingOverride.ready).toBe(false);
            expect(preflightMissingOverride.needsModelSelection).toBe(true);
            expect(preflightMissingOverride.willAutoCloneProject).toBe(true);
            expect(
              preflightMissingOverride.availableModels.some(
                (m) => m.instanceId === CODEX_MODEL.instanceId && m.model === CODEX_MODEL.model,
              ),
            ).toBe(true);

            // Preflight WITH modelSelectionOverride becomes ready!
            const preflightWithOverride = yield* coordinator.preflight({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
              modelSelectionOverride: CODEX_MODEL,
            });
            expect(preflightWithOverride.ready).toBe(true);
            expect(preflightWithOverride.needsModelSelection).toBe(false);
            expect(preflightWithOverride.resolvedModelSelection).toEqual(CODEX_MODEL);

            // Boat is still sleeping right before start!
            expect(env.proxy.getState()).toBe("sleeping");
            expect(env.proxy.stats.wakeCalls).toBe(0);

            const started = yield* coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: env.localEnvId,
              sourceThreadId,
              target: {
                kind: "boat",
                machineId: env.boatMachineId,
                environmentId: env.boatEnvId,
              },
              modelSelectionOverride: CODEX_MODEL,
            });

            const { finalRecord, phases } = yield* waitForTerminalTransfer(
              coordinator,
              started.transferId,
            );
            expect(finalRecord.errorMessage).toBeNull();
            expect(finalRecord.phase).toBe("completed");
            expect(phases).toContain("waking_target");

            // Boat woke cleanly via wake_machine before transferring!
            expect(env.proxy.stats.wakeCalls).toBe(1);
            expect(env.proxy.getState()).toBe("idle");
            expect(env.proxy.stats.rejectedWhileSleeping).toBe(0);

            // Boat auto-created a project for the remote-less repo and restored full git state!
            expect(finalRecord.destinationProjectId).not.toBeNull();
            expect(env.boatNode.projects.has(finalRecord.destinationProjectId!)).toBe(true);
            const destWorktree = finalRecord.destinationWorktreePath!;
            expect(git(destWorktree, ["rev-parse", "HEAD"])).toBe(expectedHead);
            expect(git(destWorktree, ["status", "--porcelain"])).toBe(expectedStatus);
            expect(git(destWorktree, ["diff", "--cached"])).toBe(expectedStagedDiff);
            expect(git(destWorktree, ["diff"])).toBe(expectedUnstagedDiff);
            expect(
              NodeFS.readFileSync(NodePath.join(destWorktree, "untracked-local.txt"), "utf8"),
            ).toBe("untracked-body\n");

            // Destination thread adopted the overridden Codex provider/model!
            const destThread = yield* env.boatNode.projectionStore.getThread(
              finalRecord.destinationThreadId!,
            );
            expect(destThread.modelSelection).toEqual(CODEX_MODEL);
            expect(destThread.providerInstanceId).toBe(CODEX_MODEL.instanceId);

            assertNoLeakedStaging(env.localNode.stateDir);
            assertNoLeakedStaging(env.boatNode.stateDir);
          }),
          env.teardown(),
        );
      }),
  );
});

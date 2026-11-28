import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EnvironmentId,
  GitRefName,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SourceControlProviderKind,
  type RepositoryIdentity,
  RuntimeRequestId,
  type ServerProvider,
  type SessionTransferAbortInput,
  type SessionTransferCommitImportInput,
  SessionTransferError,
  type SessionTransferFinalizeSourceInput,
  SessionTransferId,
  type SessionTransferManifest,
  type SessionTransferPrepareSourceInput,
  type SessionTransferPrepareSourceResult,
  type SessionTransferProgressEvent,
  type SessionTransferRecord,
  type SessionTransferStageImportInput,
  type SessionTransferStageImportResult,
  ThreadId,
  TrimmedNonEmptyString,
  WS_METHODS,
  isTerminalSessionTransferPhase,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Stream from "effect/Stream";
import * as NodeWS from "@effect/platform-node/NodeWS";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as SessionTransferEndpointService from "../orchestration-v2/SessionTransferEndpointService.ts";
import * as SessionTransferRepository from "../persistence/SessionTransferRepository.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as BoatCredentialSync from "./BoatCredentialSync.ts";
import * as BoatProviderSync from "./BoatProviderSync.ts";
import * as BoatSupervisor from "./BoatSupervisor.ts";
import * as SessionTransferCoordinator from "./SessionTransferCoordinator.ts";

const LOCAL_ENV_ID = EnvironmentId.make("env-local");
const BOAT_ENV_ID = EnvironmentId.make("env-boat");
const LOCAL_PROJECT_ID = ProjectId.make("proj-local");
const BOAT_PROJECT_ID = ProjectId.make("proj-boat");
const LOCAL_THREAD_ID = ThreadId.make("thread-local");
const BOAT_THREAD_ID = ThreadId.make("thread-boat");
const DEST_THREAD_ID = ThreadId.make("thread-dest");
const NOW_ISO = IsoDateTime.make("2026-11-28T05:00:00.000Z");

const SAMPLE_REPO_IDENTITY: RepositoryIdentity = {
  canonicalKey: "github.com/acme/sail",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/sail.git",
  },
  owner: "acme",
  name: "sail",
  displayName: "acme/sail",
  provider: SourceControlProviderKind.make("github"),
};

const CLAUDE_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: TrimmedNonEmptyString.make("claude-sonnet-4-6"),
};

function makeServerProvider(
  instanceId: string,
  driver: string,
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

function makeManifest(input: {
  readonly transferId: SessionTransferId;
  readonly direction: "local_to_boat" | "boat_to_local";
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId;
  readonly sourceThreadId: ThreadId;
  readonly repositoryIdentity?: RepositoryIdentity | null;
  readonly attachments?: SessionTransferManifest["attachments"];
  readonly wasRunning?: boolean;
}): SessionTransferManifest {
  return {
    schemaVersion: 1,
    transferId: input.transferId,
    direction: input.direction,
    exportedAt: NOW_ISO,
    sourceEnvironmentId: input.sourceEnvironmentId,
    sourceEnvironmentName: TrimmedNonEmptyString.make(
      input.direction === "local_to_boat" ? "MacBook Pro" : "dev-boat",
    ),
    sourceMachineId:
      input.direction === "boat_to_local" ? TrimmedNonEmptyString.make("machine-1") : null,
    sourceProjectId: input.sourceProjectId,
    sourceProjectName: TrimmedNonEmptyString.make("sail"),
    sourceWorkspaceRoot: TrimmedNonEmptyString.make("/workspace/sail"),
    sourceThreadId: input.sourceThreadId,
    title: TrimmedNonEmptyString.make("Transfer me"),
    providerInstanceId: CLAUDE_MODEL.instanceId,
    providerDriverKind: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    sourceState: {
      wasRunning: input.wasRunning ?? false,
      hadPendingRuntimeRequest: false,
      pendingRuntimeRequests: [],
      heldQueuedRunCount: 0,
      activeSubagentCount: 0,
      branch: GitRefName.make("feat/transfer"),
      headSha: TrimmedNonEmptyString.make("deadbeef"),
      isDirty: true,
      isGitRepo: true,
    },
    workspace: {
      mode: "git_bundle",
      isGitRepo: true,
      branch: GitRefName.make("feat/transfer"),
      headSha: TrimmedNonEmptyString.make("deadbeef"),
      baseRef: TrimmedNonEmptyString.make("main"),
      isDetachedHead: false,
      hasStagedChanges: false,
      hasUnstagedChanges: true,
      hasUntrackedFiles: false,
      bundleSizeBytes: NonNegativeInt.make(4096),
      bundleSha256: TrimmedNonEmptyString.make("abc123"),
      ...(input.repositoryIdentity !== undefined
        ? { repositoryIdentity: input.repositoryIdentity }
        : { repositoryIdentity: SAMPLE_REPO_IDENTITY }),
      warnings: [],
    },
    attachments: input.attachments ?? [],
    messages: [],
    turnItems: [],
    plans: [],
    heldQueuedRuns: [],
    handoffSummary: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

interface HarnessOptions {
  readonly boatState?: string;
  readonly boatSessionTransferSupported?: boolean;
  readonly boatProviders?: ReadonlyArray<ServerProvider>;
  readonly localProviders?: ReadonlyArray<ServerProvider>;
  readonly boatShellProjects?: ReadonlyArray<SessionTransferCoordinator.RemoteShellProject>;
  readonly boatDaemonProjects?: ReadonlyArray<{
    readonly id: string;
    readonly originProjectId?: string | null;
    readonly title?: string;
    readonly repoKey?: string | null;
  }>;
  readonly localProjects?: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly repositoryIdentity?: RepositoryIdentity | null;
  }>;
  readonly localThreadModelSelection?: ModelSelection;
  readonly localThreadRuns?: ReadonlyArray<{ readonly status: string }>;
  readonly localThreadRuntimeRequests?: ReadonlyArray<{
    readonly id: RuntimeRequestId;
    readonly kind: "command" | "permission" | "user_input";
    readonly status: "pending" | "resolved";
  }>;
  readonly localThreadSubagents?: ReadonlyArray<{ readonly status: string }>;
  readonly localIsGitRepo?: boolean;
  readonly remoteThreadSummary?: Partial<SessionTransferCoordinator.RemoteThreadSummary>;
  readonly manifestAttachments?: SessionTransferManifest["attachments"];
  readonly manifestRepoIdentity?: RepositoryIdentity | null;
  readonly onStreamHttpTransfer?: SessionTransferCoordinator.BoatRemoteClientShape["streamHttpTransfer"];
  readonly onBoatCommitImport?: SessionTransferCoordinator.BoatRemoteClientShape["commitImport"];
  readonly onLocalStageImport?: (
    input: SessionTransferStageImportInput,
  ) => Effect.Effect<SessionTransferStageImportResult, SessionTransferError>;
  readonly onBoatAddProject?: () => void;
  readonly onWakeMachine?: () => void;
  readonly onCreateRemoteProject?: () => {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  };
}

function makeHarness(options: HarnessOptions = {}) {
  const calls = {
    boatInvoke: [] as Array<{ readonly command: string; readonly args?: unknown }>,
    providerSyncCount: 0,
    credentialSyncedProjects: [] as ProjectId[],
    localPrepareSource: [] as SessionTransferPrepareSourceInput[],
    localStageImport: [] as SessionTransferStageImportInput[],
    localCommitImport: [] as SessionTransferCommitImportInput[],
    localFinalizeSource: [] as SessionTransferFinalizeSourceInput[],
    localAbort: [] as SessionTransferAbortInput[],
    remotePrepareSource: [] as SessionTransferPrepareSourceInput[],
    remoteStageImport: [] as SessionTransferStageImportInput[],
    remoteCommitImport: [] as SessionTransferCommitImportInput[],
    remoteFinalizeSource: [] as SessionTransferFinalizeSourceInput[],
    remoteAbort: [] as SessionTransferAbortInput[],
    remoteCreateProject: [] as Array<{ readonly name: string; readonly initGit?: boolean }>,
    streamTransfers: [] as Array<{
      readonly sourceUrl: string;
      readonly targetUrl: string;
      readonly sourceBearerToken?: string;
      readonly targetBearerToken?: string;
    }>,
    createdLocalProjects: [] as Array<{
      readonly projectId: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
    }>,
    gitCommands: [] as Array<{ readonly cwd: string; readonly args: ReadonlyArray<string> }>,
  };

  let currentBoatState = options.boatState ?? "idle";
  const boatProjects = [
    ...(options.boatShellProjects ?? [
      {
        id: BOAT_PROJECT_ID,
        title: "sail",
        workspaceRoot: "/home/sail/sail",
        repositoryIdentity: SAMPLE_REPO_IDENTITY,
      },
    ]),
  ];
  const daemonProjects = [
    ...(options.boatDaemonProjects ?? [
      {
        id: BOAT_PROJECT_ID,
        originProjectId: LOCAL_PROJECT_ID,
        title: "sail",
        repoKey: SAMPLE_REPO_IDENTITY.canonicalKey,
      },
    ]),
  ];
  const localProjects = [
    ...(options.localProjects ?? [
      {
        id: LOCAL_PROJECT_ID,
        title: "sail",
        workspaceRoot: "/Users/dev/sail",
        repositoryIdentity: SAMPLE_REPO_IDENTITY,
      },
    ]),
  ];

  const defaultProviders = [
    makeServerProvider("claudeAgent", "claudeAgent", ["claude-sonnet-4-6"]),
  ];
  const boatProviders = options.boatProviders ?? defaultProviders;
  const localProviders = options.localProviders ?? defaultProviders;

  const boatSupervisorLayer = Layer.succeed(
    BoatSupervisor.BoatSupervisor,
    BoatSupervisor.BoatSupervisor.of({
      invoke: (input) =>
        Effect.sync(() => {
          calls.boatInvoke.push({
            command: input.command,
            ...(input.args !== undefined ? { args: input.args } : {}),
          });
          if (input.command === "wake_machine") {
            currentBoatState = "idle";
            options.onWakeMachine?.();
            return { data: { ok: true } };
          }
          if (input.command === "add_project") {
            options.onBoatAddProject?.();
            boatProjects.push({
              id: BOAT_PROJECT_ID,
              title: "sail",
              workspaceRoot: "/home/sail/sail",
              repositoryIdentity: SAMPLE_REPO_IDENTITY,
            });
            daemonProjects.push({
              id: BOAT_PROJECT_ID,
              originProjectId: LOCAL_PROJECT_ID,
              title: "sail",
              repoKey: SAMPLE_REPO_IDENTITY.canonicalKey,
            });
            return { data: { ok: true } };
          }
          if (input.command === "get_state") {
            return {
              data: {
                machines: [
                  {
                    id: "machine-1",
                    environmentId: BOAT_ENV_ID,
                    name: "dev-boat",
                    state: currentBoatState,
                    projects: daemonProjects,
                  },
                ],
              },
            };
          }
          return { data: { ok: true } };
        }),
      getMachineProxyAccess: () =>
        Effect.succeed({
          machineId: "machine-1",
          machineName: "dev-boat",
          environmentId: BOAT_ENV_ID,
          state: currentBoatState,
          localUrl: "http://127.0.0.1:41999",
          bearerToken: "internal-boat-token",
        }),
      hasConfiguredBoats: Effect.succeed(true),
      currentState: Effect.sync(() =>
        Option.some({
          machines: [
            {
              id: "machine-1",
              environmentId: BOAT_ENV_ID,
              name: "dev-boat",
              state: currentBoatState,
              projects: daemonProjects,
            },
          ],
        }),
      ),
      passiveEvents: Stream.empty,
      events: Stream.empty,
      notices: Stream.empty,
    }),
  );

  const localEndpointsLayer = Layer.succeed(
    SessionTransferEndpointService.SessionTransferEndpointService,
    SessionTransferEndpointService.SessionTransferEndpointService.of({
      prepareSource: (input) =>
        Effect.sync(() => {
          calls.localPrepareSource.push(input);
          const manifest = makeManifest({
            transferId: input.transferId,
            direction: input.direction,
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceProjectId: LOCAL_PROJECT_ID,
            sourceThreadId: input.threadId,
            ...(options.manifestRepoIdentity !== undefined
              ? { repositoryIdentity: options.manifestRepoIdentity }
              : {}),
            ...(options.manifestAttachments !== undefined
              ? { attachments: options.manifestAttachments }
              : {}),
          });
          return {
            manifest,
            bundleDownloadRelativeUrl: TrimmedNonEmptyString.make(
              `/api/session-transfers/${input.transferId}/bundle?token=src-bundle`,
            ),
            bundleExpiresAt: NOW_ISO,
          } satisfies SessionTransferPrepareSourceResult;
        }),
      stageImport: (input) => {
        calls.localStageImport.push(input);
        if (options.onLocalStageImport) {
          return options.onLocalStageImport(input);
        }
        return Effect.succeed({
          destinationProjectId: input.targetProjectId ?? LOCAL_PROJECT_ID,
          destinationThreadId: DEST_THREAD_ID,
          destinationBranch: GitRefName.make("feat/transfer"),
          destinationWorktreePath: TrimmedNonEmptyString.make("/Users/dev/sail/.worktrees/wt-1"),
          resolvedModelSelection: input.modelSelectionOverride ?? CLAUDE_MODEL,
          bundleUploadRelativeUrl: TrimmedNonEmptyString.make(
            `/api/session-transfers/${input.transferId}/bundle?token=dst-bundle`,
          ),
          bundleUploadExpiresAt: NOW_ISO,
          attachmentUploads: input.manifest.attachments.map((att, idx) => ({
            sourceAttachmentId: att.attachmentId,
            destinationAttachmentId: ChatAttachmentId.make(`dest-att-${idx + 1}`),
            uploadRelativeUrl: TrimmedNonEmptyString.make(
              `/api/session-transfers/${input.transferId}/attachments/${att.attachmentId}?token=dst-att`,
            ),
            expiresAt: NOW_ISO,
          })),
          warnings: [],
        } satisfies SessionTransferStageImportResult);
      },
      commitImport: (input) =>
        Effect.sync(() => {
          calls.localCommitImport.push(input);
          return {
            destinationProjectId: input.destinationProjectId,
            destinationThreadId: input.destinationThreadId,
            destinationBranch: GitRefName.make("feat/transfer"),
            destinationWorktreePath: TrimmedNonEmptyString.make("/Users/dev/sail/.worktrees/wt-1"),
            resumed: false,
            warnings: [],
          };
        }),
      finalizeSource: (input) =>
        Effect.sync(() => {
          calls.localFinalizeSource.push(input);
          return { archived: true };
        }),
      abort: (input) =>
        Effect.sync(() => {
          calls.localAbort.push(input);
          return { cleanedUp: true };
        }),
    }),
  );

  const remoteClientLayer = Layer.succeed(
    SessionTransferCoordinator.BoatRemoteClient,
    SessionTransferCoordinator.BoatRemoteClient.of({
      getServerConfig: () =>
        Effect.succeed({
          environmentId: BOAT_ENV_ID,
          environmentLabel: "dev-boat",
          sessionTransferSupported: options.boatSessionTransferSupported ?? true,
          providers: boatProviders,
        }),
      getShellSnapshot: () =>
        Effect.succeed({
          projects: [...boatProjects],
          threads: [
            {
              id: BOAT_THREAD_ID,
              projectId: BOAT_PROJECT_ID,
              title: "Boat thread",
              branch: GitRefName.make("feat/transfer"),
              worktreePath: "/home/sail/sail/.worktrees/wt-boat",
            },
          ],
        }),
      getThreadSummary: (_endpoint, threadId) =>
        Effect.succeed({
          id: threadId,
          projectId: BOAT_PROJECT_ID,
          title: "Boat thread",
          modelSelection: CLAUDE_MODEL,
          providerInstanceId: CLAUDE_MODEL.instanceId,
          providerDriverKind: ProviderDriverKind.make("claudeAgent"),
          branch: GitRefName.make("feat/transfer"),
          worktreePath: "/home/sail/sail/.worktrees/wt-boat",
          wasRunning: false,
          pendingRuntimeRequests: [],
          activeSubagentCount: 0,
          heldQueuedRunCount: 0,
          isGitRepo: true,
          isDirty: false,
          headSha: "deadbeef",
          ...options.remoteThreadSummary,
        }),
      createRemoteProject: (_endpoint, input) =>
        Effect.sync(() => {
          calls.remoteCreateProject.push(input);
          if (options.onCreateRemoteProject) {
            return options.onCreateRemoteProject();
          }
          const createdId = ProjectId.make("proj-boat-created");
          boatProjects.push({
            id: createdId,
            title: input.name,
            workspaceRoot: `/home/sail/${input.name}`,
          });
          return { projectId: createdId, workspaceRoot: `/home/sail/${input.name}` };
        }),
      prepareSource: (_endpoint, input) =>
        Effect.sync(() => {
          calls.remotePrepareSource.push(input);
          const manifest = makeManifest({
            transferId: input.transferId,
            direction: input.direction,
            sourceEnvironmentId: BOAT_ENV_ID,
            sourceProjectId: BOAT_PROJECT_ID,
            sourceThreadId: input.threadId,
            ...(options.manifestRepoIdentity !== undefined
              ? { repositoryIdentity: options.manifestRepoIdentity }
              : {}),
            ...(options.manifestAttachments !== undefined
              ? { attachments: options.manifestAttachments }
              : {}),
          });
          return {
            manifest,
            bundleDownloadRelativeUrl: TrimmedNonEmptyString.make(
              `/api/session-transfers/${input.transferId}/bundle?token=boat-bundle`,
            ),
            bundleExpiresAt: NOW_ISO,
          };
        }),
      stageImport: (_endpoint, input) =>
        Effect.sync(() => {
          calls.remoteStageImport.push(input);
          return {
            destinationProjectId: input.targetProjectId ?? BOAT_PROJECT_ID,
            destinationThreadId: DEST_THREAD_ID,
            destinationBranch: GitRefName.make("feat/transfer"),
            destinationWorktreePath: TrimmedNonEmptyString.make("/home/sail/sail/.worktrees/wt-1"),
            resolvedModelSelection: input.modelSelectionOverride ?? CLAUDE_MODEL,
            bundleUploadRelativeUrl: TrimmedNonEmptyString.make(
              `/api/session-transfers/${input.transferId}/bundle?token=boat-upload`,
            ),
            bundleUploadExpiresAt: NOW_ISO,
            attachmentUploads: input.manifest.attachments.map((att, idx) => ({
              sourceAttachmentId: att.attachmentId,
              destinationAttachmentId: ChatAttachmentId.make(`boat-att-${idx + 1}`),
              uploadRelativeUrl: TrimmedNonEmptyString.make(
                `/api/session-transfers/${input.transferId}/attachments/${att.attachmentId}?token=boat-att`,
              ),
              expiresAt: NOW_ISO,
            })),
            warnings: [],
          };
        }),
      commitImport: (endpoint, input) => {
        calls.remoteCommitImport.push(input);
        if (options.onBoatCommitImport) {
          return options.onBoatCommitImport(endpoint, input);
        }
        return Effect.succeed({
          destinationProjectId: input.destinationProjectId,
          destinationThreadId: input.destinationThreadId,
          destinationBranch: GitRefName.make("feat/transfer"),
          destinationWorktreePath: TrimmedNonEmptyString.make("/home/sail/sail/.worktrees/wt-1"),
          resumed: false,
          warnings: [],
        });
      },
      finalizeSource: (_endpoint, input) =>
        Effect.sync(() => {
          calls.remoteFinalizeSource.push(input);
          return { archived: true };
        }),
      abort: (_endpoint, input) =>
        Effect.sync(() => {
          calls.remoteAbort.push(input);
          return { cleanedUp: true };
        }),
      streamHttpTransfer: (input) => {
        calls.streamTransfers.push({
          sourceUrl: input.sourceUrl,
          targetUrl: input.targetUrl,
          ...(input.sourceBearerToken !== undefined
            ? { sourceBearerToken: input.sourceBearerToken }
            : {}),
          ...(input.targetBearerToken !== undefined
            ? { targetBearerToken: input.targetBearerToken }
            : {}),
        });
        if (options.onStreamHttpTransfer) {
          return options.onStreamHttpTransfer(input);
        }
        return Effect.succeed({
          bytesTransferred: input.expectedSizeBytes ?? 128,
          status: 200,
        });
      },
    }),
  );

  const projectServiceLayer = Layer.succeed(ProjectService.ProjectService, {
    getById: (id: ProjectId) =>
      Effect.sync(() => {
        const found = localProjects.find((p) => p.id === id);
        if (!found) return Option.none();
        return Option.some({
          id: found.id,
          title: TrimmedNonEmptyString.make(found.title),
          workspaceRoot: TrimmedNonEmptyString.make(found.workspaceRoot),
          ...(found.repositoryIdentity !== undefined
            ? { repositoryIdentity: found.repositoryIdentity }
            : {}),
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        });
      }),
    getByWorkspaceRoot: (workspaceRoot: string) =>
      Effect.sync(() => {
        const found = localProjects.find((p) => p.workspaceRoot === workspaceRoot);
        if (!found) return Option.none();
        return Option.some({
          id: found.id,
          title: TrimmedNonEmptyString.make(found.title),
          workspaceRoot: TrimmedNonEmptyString.make(found.workspaceRoot),
          ...(found.repositoryIdentity !== undefined
            ? { repositoryIdentity: found.repositoryIdentity }
            : {}),
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        });
      }),
    listPage: () =>
      Effect.sync(() => ({
        projects: localProjects.map((found) => ({
          id: found.id,
          title: TrimmedNonEmptyString.make(found.title),
          workspaceRoot: TrimmedNonEmptyString.make(found.workspaceRoot),
          ...(found.repositoryIdentity !== undefined
            ? { repositoryIdentity: found.repositoryIdentity }
            : {}),
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        })),
        nextCursor: null,
      })),
    create: (input: {
      readonly projectId: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
    }) =>
      Effect.sync(() => {
        calls.createdLocalProjects.push({
          projectId: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
        });
        localProjects.push({
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
        });
        return {
          id: input.projectId,
          title: TrimmedNonEmptyString.make(input.title),
          workspaceRoot: TrimmedNonEmptyString.make(input.workspaceRoot),
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        };
      }),
  } as unknown as ProjectService.ProjectService["Service"]);

  const projectionStoreLayer = Layer.succeed(ProjectionStoreV2.ProjectionStoreV2, {
    getThread: (threadId: ThreadId) =>
      Effect.succeed({
        id: threadId,
        projectId: LOCAL_PROJECT_ID,
        title: "Local thread",
        modelSelection: options.localThreadModelSelection ?? CLAUDE_MODEL,
        branch: GitRefName.make("feat/transfer"),
        worktreePath: "/Users/dev/sail",
      }),
    getThreadProjection: (threadId: ThreadId) =>
      Effect.succeed({
        thread: {
          id: threadId,
          projectId: LOCAL_PROJECT_ID,
          title: "Local thread",
          modelSelection: options.localThreadModelSelection ?? CLAUDE_MODEL,
          branch: GitRefName.make("feat/transfer"),
          worktreePath: "/Users/dev/sail",
        },
        runs: options.localThreadRuns ?? [],
        runtimeRequests: (options.localThreadRuntimeRequests ?? []).map((req) => ({
          id: req.id,
          kind: req.kind,
          status: req.status,
          createdAt: DateTime.makeUnsafe("2026-11-28T05:00:00.000Z"),
        })),
        subagents: options.localThreadSubagents ?? [],
      }),
  } as unknown as ProjectionStoreV2.ProjectionStoreV2["Service"]);

  const providerRegistryLayer = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.succeed(localProviders),
  } as unknown as ProviderRegistry.ProviderRegistry["Service"]);

  const serverEnvironmentLayer = Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(LOCAL_ENV_ID),
      getDescriptor: Effect.succeed({
        environmentId: LOCAL_ENV_ID,
        label: "MacBook Pro",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "1.0.0",
        capabilities: { repositoryIdentity: true },
      }),
    }),
  );

  const repoIdentityLayer = Layer.succeed(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.RepositoryIdentityResolver.of({
      resolve: () =>
        Effect.succeed(
          options.manifestRepoIdentity !== undefined
            ? options.manifestRepoIdentity
            : SAMPLE_REPO_IDENTITY,
        ),
    }),
  );

  const vcsLayer = Layer.succeed(
    VcsProcess.VcsProcess,
    VcsProcess.VcsProcess.of({
      run: (input) =>
        Effect.sync(() => {
          calls.gitCommands.push({ cwd: input.cwd, args: input.args });
          const isGit = options.localIsGitRepo ?? true;
          if (input.args[0] === "rev-parse" && input.args[1] === "--is-inside-work-tree") {
            return {
              exitCode: (isGit ? 0 : 128) as VcsProcess.VcsProcessOutput["exitCode"],
              stdout: isGit ? "true\n" : "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }
          if (input.args[0] === "rev-parse" && input.args[1] === "HEAD") {
            return {
              exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
              stdout: "deadbeef\n",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }
          return {
            exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    }),
  );

  const providerSyncLayer = Layer.succeed(
    BoatProviderSync.BoatProviderSync,
    BoatProviderSync.BoatProviderSync.of({
      syncAllRunning: Effect.sync(() => {
        calls.providerSyncCount += 1;
      }),
    }),
  );

  const credentialSyncLayer = Layer.succeed(
    BoatCredentialSync.BoatCredentialSync,
    BoatCredentialSync.BoatCredentialSync.of({
      syncProject: (projectId) =>
        Effect.sync(() => {
          calls.credentialSyncedProjects.push(projectId);
        }),
      syncAllRunning: Effect.void,
    }),
  );

  const repoLayer = SessionTransferRepository.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  const depsLayer = Layer.mergeAll(
    repoLayer,
    boatSupervisorLayer,
    localEndpointsLayer,
    remoteClientLayer,
    projectServiceLayer,
    projectionStoreLayer,
    providerRegistryLayer,
    serverEnvironmentLayer,
    repoIdentityLayer,
    vcsLayer,
    providerSyncLayer,
    credentialSyncLayer,
    NodeServices.layer,
  );

  const coordinatorLayer = SessionTransferCoordinator.layer.pipe(Layer.provideMerge(depsLayer));

  return { calls, layer: coordinatorLayer };
}

const collectTransferEventsUntilTerminal = Effect.fn("collectTransferEventsUntilTerminal")(
  function* (
    coordinator: SessionTransferCoordinator.SessionTransferCoordinatorShape,
    trigger: Effect.Effect<SessionTransferRecord, SessionTransferError>,
  ) {
    const subscribed = yield* Deferred.make<void>();
    const collected: SessionTransferRecord[] = [];
    const targetTransferIdDeferred = yield* Deferred.make<SessionTransferId>();

    const fiber = yield* Effect.forkScoped(
      coordinator.subscribe.pipe(
        Stream.tap((event) =>
          event._tag === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.filter(
          (event): event is Extract<SessionTransferProgressEvent, { readonly _tag: "updated" }> =>
            event._tag === "updated",
        ),
        Stream.mapEffect((event) =>
          Effect.gen(function* () {
            const targetId = yield* Deferred.await(targetTransferIdDeferred);
            if (event.transfer.transferId === targetId) {
              collected.push(event.transfer);
            }
            return event.transfer;
          }),
        ),
        Stream.takeUntil((record) => isTerminalSessionTransferPhase(record.phase)),
        Stream.runDrain,
      ),
    );

    yield* Deferred.await(subscribed);
    const initial = yield* trigger;
    yield* Deferred.succeed(targetTransferIdDeferred, initial.transferId);
    yield* Fiber.join(fiber);

    return {
      initial,
      events: collected,
      final: collected[collected.length - 1]!,
    };
  },
);

describe("SessionTransferCoordinator", () => {
  it.effect(
    "completes a full local_to_boat lifecycle with provider sync, bundle/attachment streaming, commit, and source archival",
    () => {
      const attId = ChatAttachmentId.make("att-1");
      const harness = makeHarness({
        manifestAttachments: [
          {
            attachmentId: attId,
            type: "image",
            name: TrimmedNonEmptyString.make("shot.png"),
            mimeType: TrimmedNonEmptyString.make("image/png"),
            sizeBytes: NonNegativeInt.make(512),
            downloadRelativeUrl: TrimmedNonEmptyString.make(
              `/api/session-transfers/tx-1/attachments/${attId}?token=att-dl`,
            ),
          },
        ],
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const result = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.start({
            transferId: SessionTransferId.make("tx-1"),
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: {
              kind: "boat",
              machineId: TrimmedNonEmptyString.make("machine-1"),
              environmentId: BOAT_ENV_ID,
            },
            autoResume: true,
          }),
        );

        expect(result.initial.phase).toBe("queued");
        expect(result.final.phase).toBe("completed");
        expect(result.final.destinationThreadId).toBe(DEST_THREAD_ID);
        expect(result.final.destinationProjectId).toBe(BOAT_PROJECT_ID);
        expect(result.final.destinationWorktreePath).toBe("/home/sail/sail/.worktrees/wt-1");
        expect(result.final.destinationBranch).toBe("feat/transfer");

        const phases = result.events.map((e) => e.phase);
        expect(phases).toContain("pausing_source");
        expect(phases).toContain("exporting_source");
        expect(phases).toContain("preparing_target_project");
        expect(phases).toContain("transferring_workspace");
        expect(phases).toContain("transferring_attachments");
        expect(phases).toContain("committing_target");
        expect(phases).toContain("finalizing_source");
        expect(phases).toContain("completed");

        expect(harness.calls.providerSyncCount).toBe(1);
        expect(harness.calls.localPrepareSource).toHaveLength(1);
        expect(harness.calls.remoteStageImport).toHaveLength(1);
        expect(harness.calls.streamTransfers).toHaveLength(2);
        expect(harness.calls.streamTransfers[0]?.targetBearerToken).toBe("internal-boat-token");
        expect(harness.calls.streamTransfers[0]?.sourceBearerToken).toBeUndefined();
        expect(harness.calls.remoteCommitImport).toHaveLength(1);
        expect(harness.calls.remoteCommitImport[0]?.attachmentIdMap).toEqual({
          [attId]: ChatAttachmentId.make("boat-att-1"),
        });
        expect(harness.calls.localFinalizeSource).toHaveLength(1);
        expect(harness.calls.localFinalizeSource[0]?.destination.threadId).toBe(DEST_THREAD_ID);

        const listed = yield* coordinator.list({});
        expect(listed.transfers).toHaveLength(1);
        expect(listed.transfers[0]?.phase).toBe("completed");
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "completes a boat_to_local transfer matching the local project by originProjectId and repository identity",
    () => {
      const harness = makeHarness({
        boatDaemonProjects: [
          {
            id: BOAT_PROJECT_ID,
            originProjectId: null,
            title: "sail",
            repoKey: SAMPLE_REPO_IDENTITY.canonicalKey,
          },
        ],
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const result = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.start({
            transferId: SessionTransferId.make("tx-b2l"),
            direction: "boat_to_local",
            sourceEnvironmentId: BOAT_ENV_ID,
            sourceThreadId: BOAT_THREAD_ID,
            target: { kind: "local" },
          }),
        );

        expect(result.final.phase).toBe("completed");
        expect(result.final.destinationProjectId).toBe(LOCAL_PROJECT_ID);
        expect(result.final.destinationThreadId).toBe(DEST_THREAD_ID);
        expect(harness.calls.remotePrepareSource).toHaveLength(1);
        expect(harness.calls.localStageImport).toHaveLength(1);
        expect(harness.calls.streamTransfers).toHaveLength(1);
        expect(harness.calls.streamTransfers[0]?.sourceBearerToken).toBe("internal-boat-token");
        expect(harness.calls.streamTransfers[0]?.targetBearerToken).toBeUndefined();
        expect(harness.calls.localCommitImport).toHaveLength(1);
        expect(harness.calls.remoteFinalizeSource).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("wakes a sleeping Boat machine before preparing and transferring", () => {
    const harness = makeHarness({ boatState: "asleep" });

    return Effect.gen(function* () {
      const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
      const result = yield* collectTransferEventsUntilTerminal(
        coordinator,
        coordinator.start({
          transferId: SessionTransferId.make("tx-wake"),
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: {
            kind: "boat",
            machineId: TrimmedNonEmptyString.make("machine-1"),
          },
        }),
      );

      expect(result.final.phase).toBe("completed");
      expect(result.events.map((e) => e.phase)).toContain("waking_target");
      expect(harness.calls.boatInvoke.some((c) => c.command === "wake_machine")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "auto-clones missing Boat project via add_project + credential sync for repos with remotes",
    () => {
      const harness = makeHarness({
        boatShellProjects: [],
        boatDaemonProjects: [],
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const preflight = yield* coordinator.preflight({
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: {
            kind: "boat",
            machineId: TrimmedNonEmptyString.make("machine-1"),
          },
        });
        expect(preflight.ready).toBe(true);
        expect(preflight.willAutoCloneProject).toBe(true);

        const result = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.start({
            transferId: SessionTransferId.make("tx-autoclone"),
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: {
              kind: "boat",
              machineId: TrimmedNonEmptyString.make("machine-1"),
            },
          }),
        );

        expect(result.final.phase).toBe("completed");
        expect(harness.calls.boatInvoke.some((c) => c.command === "add_project")).toBe(true);
        expect(harness.calls.credentialSyncedProjects).toEqual([LOCAL_PROJECT_ID]);
        expect(result.final.destinationProjectId).toBe(BOAT_PROJECT_ID);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "creates a fresh Boat project via createRemoteProject for remote-less local git repos",
    () => {
      const harness = makeHarness({
        boatShellProjects: [],
        boatDaemonProjects: [],
        localProjects: [
          {
            id: LOCAL_PROJECT_ID,
            title: "scratch-repo",
            workspaceRoot: "/Users/dev/scratch-repo",
            repositoryIdentity: null,
          },
        ],
        manifestRepoIdentity: null,
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const result = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.start({
            transferId: SessionTransferId.make("tx-remoteless"),
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: {
              kind: "boat",
              machineId: TrimmedNonEmptyString.make("machine-1"),
            },
          }),
        );

        expect(result.final.phase).toBe("completed");
        expect(harness.calls.boatInvoke.some((c) => c.command === "add_project")).toBe(false);
        expect(harness.calls.remoteCreateProject).toHaveLength(1);
        expect(result.final.destinationProjectId).toBe(ProjectId.make("proj-boat-created"));
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "creates a local project at cloneDestinationPath when boat_to_local has no local match",
    () => {
      const harness = makeHarness({
        localProjects: [],
        boatDaemonProjects: [],
        manifestRepoIdentity: null,
      });

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "session-transfer-clone-" });
        const destPath = `${tmpDir}/cloned-repo`;

        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const result = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.start({
            transferId: SessionTransferId.make("tx-clone-dest"),
            direction: "boat_to_local",
            sourceEnvironmentId: BOAT_ENV_ID,
            sourceThreadId: BOAT_THREAD_ID,
            target: { kind: "local" },
            cloneDestinationPath: TrimmedNonEmptyString.make(destPath),
          }),
        );

        expect(result.final.phase).toBe("completed");
        expect(harness.calls.createdLocalProjects).toHaveLength(1);
        expect(harness.calls.createdLocalProjects[0]?.workspaceRoot).toBe(destPath);
        expect(
          harness.calls.gitCommands.some((c) => c.cwd === destPath && c.args[0] === "init"),
        ).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("preflight flags older Boat servers lacking sessionTransfer support", () => {
    const harness = makeHarness({ boatSessionTransferSupported: false });
    return Effect.gen(function* () {
      const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
      const res = yield* coordinator.preflight({
        direction: "local_to_boat",
        sourceEnvironmentId: LOCAL_ENV_ID,
        sourceThreadId: LOCAL_THREAD_ID,
        target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
      });
      expect(res.ready).toBe(false);
      expect(res.unsupportedReason).toContain("older Sail server");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("preflight rejects non-git repositories", () => {
    const harness = makeHarness({ localIsGitRepo: false });
    return Effect.gen(function* () {
      const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
      const res = yield* coordinator.preflight({
        direction: "local_to_boat",
        sourceEnvironmentId: LOCAL_ENV_ID,
        sourceThreadId: LOCAL_THREAD_ID,
        target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
      });
      expect(res.ready).toBe(false);
      expect(res.unsupportedReason).toContain("git repositories");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "preflight handles boat_to_local project disambiguation, missing local clone, model fallback, and running/request/subagent warnings",
    () => {
      const ambiguousHarness = makeHarness({
        boatDaemonProjects: [],
        localProjects: [
          {
            id: ProjectId.make("local-1"),
            title: "sail-a",
            workspaceRoot: "/Users/dev/sail-a",
            repositoryIdentity: SAMPLE_REPO_IDENTITY,
          },
          {
            id: ProjectId.make("local-2"),
            title: "sail-b",
            workspaceRoot: "/Users/dev/sail-b",
            repositoryIdentity: SAMPLE_REPO_IDENTITY,
          },
        ],
        localProviders: [makeServerProvider("codex", "codex", ["gpt-5.4"])],
        remoteThreadSummary: {
          wasRunning: true,
          activeSubagentCount: 2,
          pendingRuntimeRequests: [
            {
              id: RuntimeRequestId.make("req-1"),
              kind: "command",
              createdAt: NOW_ISO,
            },
          ],
        },
      });

      const missingLocalHarness = makeHarness({
        boatDaemonProjects: [],
        localProjects: [],
        localProviders: [makeServerProvider("claude-custom", "claudeAgent", ["claude-sonnet-4-6"])],
      });

      return Effect.gen(function* () {
        const res1 = yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          return yield* coordinator.preflight({
            direction: "boat_to_local",
            sourceEnvironmentId: BOAT_ENV_ID,
            sourceThreadId: BOAT_THREAD_ID,
            target: { kind: "local" },
          });
        }).pipe(Effect.scoped, Effect.provide(ambiguousHarness.layer));

        expect(res1.ready).toBe(false);
        expect(res1.needsProjectSelection).toBe(true);
        expect(res1.candidateProjects).toHaveLength(2);
        expect(res1.needsModelSelection).toBe(true);
        expect(res1.availableModels).toHaveLength(1);
        expect(res1.needsRunningConfirmation).toBe(true);
        expect(res1.warnings.length).toBeGreaterThanOrEqual(4);

        const res2 = yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          return yield* coordinator.preflight({
            direction: "boat_to_local",
            sourceEnvironmentId: BOAT_ENV_ID,
            sourceThreadId: BOAT_THREAD_ID,
            target: { kind: "local" },
          });
        }).pipe(Effect.scoped, Effect.provide(missingLocalHarness.layer));

        expect(res2.ready).toBe(false);
        expect(res2.needsCloneDestination).toBe(true);
        // Same-driver matching maps claudeAgent -> claude-custom automatically.
        expect(res2.needsModelSelection).toBe(false);
        expect(res2.resolvedModelSelection?.instanceId).toBe(
          ProviderInstanceId.make("claude-custom"),
        );
      });
    },
  );

  it.effect("warns and continues with stub when a source attachment is missing (not_found)", () => {
    const missingAtt = ChatAttachmentId.make("att-missing");
    const presentAtt = ChatAttachmentId.make("att-present");
    const harness = makeHarness({
      manifestAttachments: [
        {
          attachmentId: missingAtt,
          type: "file",
          name: TrimmedNonEmptyString.make("gone.txt"),
          mimeType: TrimmedNonEmptyString.make("text/plain"),
          sizeBytes: NonNegativeInt.make(42),
          downloadRelativeUrl: TrimmedNonEmptyString.make(
            `/api/session-transfers/tx-miss/attachments/${missingAtt}?token=a`,
          ),
        },
        {
          attachmentId: presentAtt,
          type: "file",
          name: TrimmedNonEmptyString.make("ok.txt"),
          mimeType: TrimmedNonEmptyString.make("text/plain"),
          sizeBytes: NonNegativeInt.make(64),
          downloadRelativeUrl: TrimmedNonEmptyString.make(
            `/api/session-transfers/tx-miss/attachments/${presentAtt}?token=b`,
          ),
        },
      ],
      onStreamHttpTransfer: (input) =>
        input.sourceUrl.includes(missingAtt)
          ? Effect.fail(new SessionTransferError({ code: "not_found", message: "missing" }))
          : Effect.succeed({ bytesTransferred: 64, status: 200 }),
    });

    return Effect.gen(function* () {
      const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
      const result = yield* collectTransferEventsUntilTerminal(
        coordinator,
        coordinator.start({
          transferId: SessionTransferId.make("tx-miss"),
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
        }),
      );

      expect(result.final.phase).toBe("completed");
      expect(result.final.warnings.some((w) => w.includes("gone.txt"))).toBe(true);
      expect(harness.calls.remoteCommitImport[0]?.attachmentIdMap).toEqual({
        [presentAtt]: ChatAttachmentId.make("boat-att-2"),
      });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("cancel aborts an in-flight transfer before commit and cleans up both sides", () => {
    const streamStarted = Deferred.makeUnsafe<void>();
    const streamHold = Deferred.makeUnsafe<void>();

    const harness = makeHarness({
      onStreamHttpTransfer: () =>
        Deferred.succeed(streamStarted, undefined).pipe(
          Effect.andThen(Deferred.await(streamHold)),
          Effect.as({ bytesTransferred: 0, status: 200 }),
        ),
    });

    return Effect.gen(function* () {
      const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
      const started = yield* coordinator.start({
        transferId: SessionTransferId.make("tx-cancel"),
        direction: "local_to_boat",
        sourceEnvironmentId: LOCAL_ENV_ID,
        sourceThreadId: LOCAL_THREAD_ID,
        target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
      });

      yield* Deferred.await(streamStarted);
      const cancelled = yield* coordinator.cancel({ transferId: started.transferId });

      expect(cancelled.phase).toBe("cancelled");
      expect(harness.calls.remoteCommitImport).toHaveLength(0);
      expect(harness.calls.remoteAbort).toHaveLength(1);
      expect(harness.calls.localAbort).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "enforces transferId idempotency, rejects duplicate active transfers, and retries preserving saved overrides",
    () => {
      let streamAttempt = 0;
      const overrideModel: ModelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: TrimmedNonEmptyString.make("gpt-5.4"),
      };
      const harness = makeHarness({
        onStreamHttpTransfer: () => {
          streamAttempt += 1;
          if (streamAttempt === 1) {
            return Effect.fail(
              new SessionTransferError({
                code: "workspace_error",
                message: "transient network error",
              }),
            );
          }
          return Effect.succeed({ bytesTransferred: 4096, status: 200 });
        },
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const firstRun = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.start({
            transferId: SessionTransferId.make("tx-retry"),
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            modelSelectionOverride: overrideModel,
          }),
        );

        expect(firstRun.final.phase).toBe("failed");
        expect(firstRun.final.errorMessage).toContain("transient network error");
        expect(harness.calls.remoteAbort).toHaveLength(1);
        expect(harness.calls.localAbort).toHaveLength(1);

        // Idempotent start by transferId returns existing record.
        const idempotent = yield* coordinator.start({
          transferId: SessionTransferId.make("tx-retry"),
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
        });
        expect(idempotent.transferId).toBe(SessionTransferId.make("tx-retry"));

        // Retry succeeds and preserves modelSelectionOverride.
        const secondRun = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.retry({ transferId: SessionTransferId.make("tx-retry") }),
        );
        expect(secondRun.final.phase).toBe("completed");
        expect(harness.calls.remoteCommitImport[0]?.modelSelectionOverride).toEqual(overrideModel);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("rejects a second concurrent transfer for the same source thread", () => {
    const streamStarted = Deferred.makeUnsafe<void>();
    const streamHold = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      onStreamHttpTransfer: () =>
        Deferred.succeed(streamStarted, undefined).pipe(
          Effect.andThen(Deferred.await(streamHold)),
          Effect.as({ bytesTransferred: 0, status: 200 }),
        ),
    });

    return Effect.gen(function* () {
      const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
      const first = yield* coordinator.start({
        transferId: SessionTransferId.make("tx-first"),
        direction: "local_to_boat",
        sourceEnvironmentId: LOCAL_ENV_ID,
        sourceThreadId: LOCAL_THREAD_ID,
        target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
      });
      yield* Deferred.await(streamStarted);

      const secondError = yield* Effect.flip(
        coordinator.start({
          transferId: SessionTransferId.make("tx-second"),
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
        }),
      );
      expect(secondError.code).toBe("already_in_flight");

      yield* coordinator.cancel({ transferId: first.transferId });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "reconcileOnStartup completes transfers stuck in finalizing_source and fails pre-commit active transfers",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const repo = yield* SessionTransferRepository.SessionTransferRepository;
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;

        yield* repo.upsert({
          transferId: SessionTransferId.make("tx-finalizing"),
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceEnvironmentName: TrimmedNonEmptyString.make("MacBook Pro"),
          sourceMachineId: null,
          sourceProjectId: LOCAL_PROJECT_ID,
          sourceThreadId: ThreadId.make("thread-a"),
          destinationEnvironmentId: BOAT_ENV_ID,
          destinationEnvironmentName: TrimmedNonEmptyString.make("dev-boat"),
          destinationMachineId: TrimmedNonEmptyString.make("machine-1"),
          destinationProjectId: BOAT_PROJECT_ID,
          destinationThreadId: DEST_THREAD_ID,
          phase: "finalizing_source",
          phaseDetail: "Archiving source thread...",
          sourceWasRunning: false,
          autoResume: false,
          hadPendingRuntimeRequest: false,
          destinationBranch: GitRefName.make("feat/transfer"),
          destinationWorktreePath: TrimmedNonEmptyString.make("/home/sail/sail/.worktrees/wt-1"),
          modelSelectionOverride: null,
          cloneDestinationPath: null,
          warnings: [],
          errorMessage: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          completedAt: null,
        });

        yield* repo.upsert({
          transferId: SessionTransferId.make("tx-midflight"),
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceEnvironmentName: TrimmedNonEmptyString.make("MacBook Pro"),
          sourceMachineId: null,
          sourceProjectId: LOCAL_PROJECT_ID,
          sourceThreadId: ThreadId.make("thread-b"),
          destinationEnvironmentId: BOAT_ENV_ID,
          destinationEnvironmentName: TrimmedNonEmptyString.make("dev-boat"),
          destinationMachineId: TrimmedNonEmptyString.make("machine-1"),
          destinationProjectId: BOAT_PROJECT_ID,
          destinationThreadId: null,
          phase: "transferring_workspace",
          phaseDetail: "Streaming workspace bundle...",
          sourceWasRunning: false,
          autoResume: false,
          hadPendingRuntimeRequest: false,
          destinationBranch: null,
          destinationWorktreePath: null,
          modelSelectionOverride: null,
          cloneDestinationPath: null,
          warnings: [],
          errorMessage: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          completedAt: null,
        });

        yield* coordinator.reconcileOnStartup;

        const finalized = yield* repo.getById(SessionTransferId.make("tx-finalizing"));
        const interrupted = yield* repo.getById(SessionTransferId.make("tx-midflight"));

        expect(Option.isSome(finalized) && finalized.value.phase).toBe("completed");
        expect(harness.calls.localFinalizeSource).toHaveLength(1);

        expect(Option.isSome(interrupted) && interrupted.value.phase).toBe("failed");
        expect(Option.isSome(interrupted) && interrupted.value.errorMessage).toBe(
          "Interrupted by server restart",
        );
        expect(harness.calls.localAbort).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );
});

describe("makeLiveBoatRemoteClient", () => {
  const mockTicketFetch: typeof fetch = async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/auth/websocket-ticket/rpc")) {
      return new Response(JSON.stringify({ ticket: "test-ticket" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  const mockHttpLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, mockTicketFetch)),
  );

  const acquireMockBoatRpcServer = (handler: (tag: string, payload: unknown) => unknown) =>
    Effect.acquireRelease(
      Effect.promise(async () => {
        const received: Array<{ readonly tag: string; readonly payload: unknown }> = [];
        const wss = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
        wss.on("connection", (ws) => {
          ws.on("message", (raw) => {
            const parsed = JSON.parse(String(raw)) as {
              readonly id: string;
              readonly tag: string;
              readonly payload: unknown;
            };
            received.push({ tag: parsed.tag, payload: parsed.payload });
            const value = handler(parsed.tag, parsed.payload);
            ws.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: parsed.id,
                exit: { _tag: "Success", value },
              }),
            );
          });
        });

        await new Promise<void>((resolve) => {
          wss.once("listening", () => resolve());
        });
        const address = wss.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected numeric listen address");
        }
        return {
          wss,
          received,
          endpoint: {
            localUrl: `http://127.0.0.1:${address.port}`,
            bearerToken: "test-bearer-token",
          } satisfies SessionTransferCoordinator.BoatRemoteEndpoint,
        };
      }),
      ({ wss }) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const client of wss.clients) {
                client.terminate();
              }
              wss.close(() => resolve());
            }),
        ),
    );

  it.effect(
    "createRemoteProject parses direct { projectId, workspaceRoot } without sending initGit and supports legacy { project }",
    () =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.some(httpClient));
        let callIndex = 0;
        const mock = yield* acquireMockBoatRpcServer((tag) => {
          if (tag !== WS_METHODS.projectsCreateNew) {
            throw new Error(`Unexpected RPC tag: ${tag}`);
          }
          callIndex += 1;
          if (callIndex === 1) {
            return {
              projectId: "proj-direct",
              workspaceRoot: "/home/sail/projects/new-app",
            };
          }
          if (callIndex === 2) {
            return {
              project: {
                id: "proj-legacy",
                workspaceRoot: "/home/sail/projects/legacy-app",
              },
            };
          }
          return {};
        });

        const direct = yield* client.createRemoteProject!(mock.endpoint, {
          name: "new-app",
          initGit: true,
        });
        expect(direct).toEqual({
          projectId: ProjectId.make("proj-direct"),
          workspaceRoot: "/home/sail/projects/new-app",
        });
        expect(mock.received[0]).toEqual({
          tag: WS_METHODS.projectsCreateNew,
          payload: { name: "new-app" },
        });
        expect(Object.hasOwn(mock.received[0]!.payload as Record<string, unknown>, "initGit")).toBe(
          false,
        );

        const legacy = yield* client.createRemoteProject!(mock.endpoint, {
          name: "legacy-app",
        });
        expect(legacy).toEqual({
          projectId: ProjectId.make("proj-legacy"),
          workspaceRoot: "/home/sail/projects/legacy-app",
        });

        const missingError = yield* Effect.flip(
          client.createRemoteProject!(mock.endpoint, { name: "broken-app" }),
        );
        expect(missingError).toBeInstanceOf(SessionTransferError);
        expect(missingError.code).toBe("internal");
      }).pipe(Effect.scoped, Effect.provide(mockHttpLayer)),
  );

  it.effect(
    "prepareSource decodes DateTime.Utc fields from wire JSON and rejects malformed responses with internal error",
    () =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.some(httpClient));
        const txId = SessionTransferId.make("tx-decode-prepare");
        const baseManifest = makeManifest({
          transferId: txId,
          direction: "boat_to_local",
          sourceEnvironmentId: BOAT_ENV_ID,
          sourceProjectId: BOAT_PROJECT_ID,
          sourceThreadId: BOAT_THREAD_ID,
        });
        let malformed = false;
        const mock = yield* acquireMockBoatRpcServer((tag) => {
          if (tag !== WS_METHODS.sessionTransferPrepareSource) {
            throw new Error(`Unexpected RPC tag: ${tag}`);
          }
          if (malformed) {
            return { manifest: { invalid: true } };
          }
          return {
            manifest: {
              ...baseManifest,
              messages: [
                {
                  id: MessageId.make("msg-1"),
                  threadId: BOAT_THREAD_ID,
                  runId: null,
                  nodeId: null,
                  createdBy: "user",
                  creationSource: "web",
                  role: "user",
                  text: "hello from boat",
                  attachments: [],
                  streaming: false,
                  createdAt: "2026-11-28T05:00:00.000Z",
                  updatedAt: "2026-11-28T05:00:01.000Z",
                },
              ],
            },
            bundleDownloadRelativeUrl: "/api/session-transfer/tx-decode-prepare/bundle",
            bundleExpiresAt: NOW_ISO,
          };
        });

        const decoded = yield* client.prepareSource(mock.endpoint, {
          transferId: txId,
          direction: "boat_to_local",
          threadId: BOAT_THREAD_ID,
        });
        expect(decoded.manifest.messages).toHaveLength(1);
        const msg = decoded.manifest.messages[0]!;
        expect(DateTime.isDateTime(msg.createdAt)).toBe(true);
        expect(DateTime.isDateTime(msg.updatedAt)).toBe(true);
        expect(DateTime.formatIso(msg.createdAt)).toBe("2026-11-28T05:00:00.000Z");
        expect(DateTime.formatIso(msg.updatedAt)).toBe("2026-11-28T05:00:01.000Z");

        malformed = true;
        const decodeErr = yield* Effect.flip(
          client.prepareSource(mock.endpoint, {
            transferId: txId,
            direction: "boat_to_local",
            threadId: BOAT_THREAD_ID,
          }),
        );
        expect(decodeErr).toBeInstanceOf(SessionTransferError);
        expect(decodeErr.code).toBe("internal");
        expect(decodeErr.transferId).toBe(txId);
      }).pipe(Effect.scoped, Effect.provide(mockHttpLayer)),
  );

  it.effect(
    "stageImport, commitImport, finalizeSource, and abort decode valid responses and fail with internal on malformed responses",
    () =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.some(httpClient));
        const txId = SessionTransferId.make("tx-decode-rpcs");
        const manifest = makeManifest({
          transferId: txId,
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceProjectId: LOCAL_PROJECT_ID,
          sourceThreadId: LOCAL_THREAD_ID,
        });
        let malformed = false;
        const mock = yield* acquireMockBoatRpcServer((tag) => {
          if (malformed) {
            return { unexpected: true };
          }
          switch (tag) {
            case WS_METHODS.sessionTransferStageImport:
              return {
                destinationProjectId: BOAT_PROJECT_ID,
                destinationThreadId: DEST_THREAD_ID,
                destinationBranch: "feat/transfer",
                destinationWorktreePath: "/home/sail/sail/.worktrees/wt-1",
                resolvedModelSelection: CLAUDE_MODEL,
                bundleUploadRelativeUrl: "/api/session-transfer/tx-decode-rpcs/bundle",
                bundleUploadExpiresAt: NOW_ISO,
                attachmentUploads: [],
                warnings: [],
              };
            case WS_METHODS.sessionTransferCommitImport:
              return {
                destinationProjectId: BOAT_PROJECT_ID,
                destinationThreadId: DEST_THREAD_ID,
                destinationBranch: "feat/transfer",
                destinationWorktreePath: "/home/sail/sail/.worktrees/wt-1",
                resumed: false,
                warnings: [],
              };
            case WS_METHODS.sessionTransferFinalizeSource:
              return { archived: true };
            case WS_METHODS.sessionTransferAbort:
              return { cleanedUp: true };
            default:
              throw new Error(`Unexpected RPC tag: ${tag}`);
          }
        });

        const staged = yield* client.stageImport(mock.endpoint, {
          transferId: txId,
          manifest,
          targetProjectId: BOAT_PROJECT_ID,
        });
        expect(staged.destinationThreadId).toBe(DEST_THREAD_ID);

        const committed = yield* client.commitImport(mock.endpoint, {
          transferId: txId,
          manifest,
          destinationProjectId: BOAT_PROJECT_ID,
          destinationThreadId: DEST_THREAD_ID,
          autoResume: false,
        });
        expect(committed.destinationThreadId).toBe(DEST_THREAD_ID);
        expect(committed.resumed).toBe(false);

        const finalized = yield* client.finalizeSource(mock.endpoint, {
          transferId: txId,
          threadId: BOAT_THREAD_ID,
          destination: {
            transferId: txId,
            environmentId: LOCAL_ENV_ID,
            environmentName: TrimmedNonEmptyString.make("MacBook Pro"),
            machineId: null,
            projectId: LOCAL_PROJECT_ID,
            threadId: DEST_THREAD_ID,
            transferredAt: NOW_ISO,
          },
        });
        expect(finalized.archived).toBe(true);

        const aborted = yield* client.abort(mock.endpoint, {
          transferId: txId,
          role: "destination",
          reason: "test",
        });
        expect(aborted.cleanedUp).toBe(true);

        malformed = true;
        const stageErr = yield* Effect.flip(
          client.stageImport(mock.endpoint, {
            transferId: txId,
            manifest,
            targetProjectId: BOAT_PROJECT_ID,
          }),
        );
        expect(stageErr.code).toBe("internal");
        expect(stageErr.transferId).toBe(txId);

        const commitErr = yield* Effect.flip(
          client.commitImport(mock.endpoint, {
            transferId: txId,
            manifest,
            destinationProjectId: BOAT_PROJECT_ID,
            destinationThreadId: DEST_THREAD_ID,
            autoResume: false,
          }),
        );
        expect(commitErr.code).toBe("internal");
        expect(commitErr.transferId).toBe(txId);

        const finalizeErr = yield* Effect.flip(
          client.finalizeSource(mock.endpoint, {
            transferId: txId,
            threadId: BOAT_THREAD_ID,
            destination: {
              transferId: txId,
              environmentId: LOCAL_ENV_ID,
              environmentName: TrimmedNonEmptyString.make("MacBook Pro"),
              machineId: null,
              projectId: LOCAL_PROJECT_ID,
              threadId: DEST_THREAD_ID,
              transferredAt: NOW_ISO,
            },
          }),
        );
        expect(finalizeErr.code).toBe("internal");
        expect(finalizeErr.transferId).toBe(txId);

        const abortErr = yield* Effect.flip(
          client.abort(mock.endpoint, {
            transferId: txId,
            role: "destination",
            reason: "test",
          }),
        );
        expect(abortErr.code).toBe("internal");
        expect(abortErr.transferId).toBe(txId);
      }).pipe(Effect.scoped, Effect.provide(mockHttpLayer)),
  );
});

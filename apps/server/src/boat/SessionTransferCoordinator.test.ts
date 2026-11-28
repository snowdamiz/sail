// @effect-diagnostics nodeBuiltinImport:off -- Loopback HTTP/TCP fixture servers for live BoatRemoteClient tests.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
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
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
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
  type SessionTransferThreadOrigin,
  ThreadId,
  TrimmedNonEmptyString,
  WS_METHODS,
  isTerminalSessionTransferPhase,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { PersistenceSqlError } from "../persistence/Errors.ts";
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
  }> | null;
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
  readonly onLocalPrepareSource?: (
    input: SessionTransferPrepareSourceInput,
  ) => Effect.Effect<SessionTransferPrepareSourceResult, SessionTransferError>;
  readonly onRemoteStageImport?: (
    input: SessionTransferStageImportInput,
  ) => Effect.Effect<SessionTransferStageImportResult, SessionTransferError>;
  readonly onLocalFinalizeSource?: (
    input: SessionTransferFinalizeSourceInput,
  ) => Effect.Effect<{ readonly archived: boolean }, SessionTransferError>;
  readonly onRemoteFinalizeSource?: (
    input: SessionTransferFinalizeSourceInput,
  ) => Effect.Effect<{ readonly archived: boolean }, SessionTransferError>;
  readonly onRemoteAbort?: (
    input: SessionTransferAbortInput,
  ) => Effect.Effect<{ readonly cleanedUp: boolean }, SessionTransferError>;
  readonly onRemoteGetServerConfig?: () => ReturnType<
    SessionTransferCoordinator.BoatRemoteClientShape["getServerConfig"]
  >;
  readonly onRemoteGetThreadSummary?: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionTransferCoordinator.RemoteThreadSummary, SessionTransferError>;
  readonly onBoatAddProjectReturn?: (
    boatProjects: Array<SessionTransferCoordinator.RemoteShellProject>,
    daemonProjects: Array<{
      readonly id: string;
      readonly originProjectId?: string | null;
      readonly title?: string;
      readonly repoKey?: string | null;
    }>,
  ) => Record<string, unknown>;
  readonly failTransitionPhase?: SessionTransferCoordinator.SessionTransferCoordinatorShape extends never
    ? never
    : string;
  readonly localThreadTransferOrigin?: SessionTransferThreadOrigin | null;
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
    remoteGetServerConfigCount: 0,
    remoteGetShellSnapshotCount: 0,
    remoteGetThreadSummaryCount: 0,
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
  const omitDaemonProjects = options.boatDaemonProjects === null;
  const daemonProjects = [
    ...(options.boatDaemonProjects === null
      ? []
      : (options.boatDaemonProjects ?? [
          {
            id: BOAT_PROJECT_ID,
            originProjectId: LOCAL_PROJECT_ID,
            title: "sail",
            repoKey: SAMPLE_REPO_IDENTITY.canonicalKey,
          },
        ])),
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
            if (options.onBoatAddProjectReturn) {
              return { data: options.onBoatAddProjectReturn(boatProjects, daemonProjects) };
            }
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
                    ...(omitDaemonProjects ? {} : { projects: daemonProjects }),
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
              ...(omitDaemonProjects ? {} : { projects: daemonProjects }),
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
      prepareSource: (input) => {
        calls.localPrepareSource.push(input);
        if (options.onLocalPrepareSource) {
          return options.onLocalPrepareSource(input);
        }
        return Effect.sync(() => {
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
        });
      },
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
      finalizeSource: (input) => {
        calls.localFinalizeSource.push(input);
        if (options.onLocalFinalizeSource) {
          return options.onLocalFinalizeSource(input);
        }
        return Effect.succeed({ archived: true });
      },
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
      getServerConfig: () => {
        calls.remoteGetServerConfigCount += 1;
        if (options.onRemoteGetServerConfig) {
          return options.onRemoteGetServerConfig();
        }
        return Effect.succeed({
          environmentId: BOAT_ENV_ID,
          environmentLabel: "dev-boat",
          sessionTransferSupported: options.boatSessionTransferSupported ?? true,
          providers: boatProviders,
        });
      },
      getShellSnapshot: () =>
        Effect.sync(() => {
          calls.remoteGetShellSnapshotCount += 1;
          return {
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
          };
        }),
      getThreadSummary: (_endpoint, threadId) => {
        calls.remoteGetThreadSummaryCount += 1;
        if (options.onRemoteGetThreadSummary) {
          return options.onRemoteGetThreadSummary(threadId);
        }
        return Effect.succeed({
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
        });
      },
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
      stageImport: (_endpoint, input) => {
        calls.remoteStageImport.push(input);
        if (options.onRemoteStageImport) {
          return options.onRemoteStageImport(input);
        }
        return Effect.sync(() => {
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
        });
      },
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
      finalizeSource: (_endpoint, input) => {
        calls.remoteFinalizeSource.push(input);
        if (options.onRemoteFinalizeSource) {
          return options.onRemoteFinalizeSource(input);
        }
        return Effect.succeed({ archived: true });
      },
      abort: (_endpoint, input) => {
        calls.remoteAbort.push(input);
        if (options.onRemoteAbort) {
          return options.onRemoteAbort(input);
        }
        return Effect.succeed({ cleanedUp: true });
      },
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
        ...(options.localThreadTransferOrigin !== undefined
          ? { transferOrigin: options.localThreadTransferOrigin }
          : {}),
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

  const baseRepoLayer = SessionTransferRepository.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const repoLayer =
    options.failTransitionPhase === undefined
      ? baseRepoLayer
      : Layer.effect(
          SessionTransferRepository.SessionTransferRepository,
          Effect.gen(function* () {
            const inner = yield* SessionTransferRepository.SessionTransferRepository;
            return {
              ...inner,
              transitionPhase: (input) =>
                input.phase === options.failTransitionPhase
                  ? Effect.fail(
                      new PersistenceSqlError({
                        operation: "transitionPhase",
                        detail: `Simulated DB failure persisting phase ${input.phase}`,
                      }),
                    )
                  : inner.transitionPhase(input),
            };
          }),
        ).pipe(Layer.provide(baseRepoLayer));

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
        boatProviders: [
          makeServerProvider("claudeAgent", "claudeAgent", ["claude-sonnet-4-6"]),
          makeServerProvider("codex", "codex", ["gpt-5.4"]),
        ],
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
      const harness = makeHarness({
        remoteThreadSummary: {
          transferOrigin: {
            transferId: SessionTransferId.make("tx-finalizing"),
            environmentId: LOCAL_ENV_ID,
            environmentName: TrimmedNonEmptyString.make("MacBook Pro"),
            machineId: null,
            projectId: LOCAL_PROJECT_ID,
            threadId: ThreadId.make("thread-a"),
            transferredAt: NOW_ISO,
          },
        },
      });

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
        expect(harness.calls.remoteAbort).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "reconcileOnStartup finishes finalizing_source when committing_target already committed on destination, and preserves finalizing_source on transient Boat error",
    () => {
      const committedTxId = SessionTransferId.make("tx-commit-crash");
      const transientTxId = SessionTransferId.make("tx-finalize-transient");
      const harness = makeHarness({
        onRemoteGetThreadSummary: (threadId) =>
          Effect.succeed({
            id: threadId,
            projectId: BOAT_PROJECT_ID,
            title: "Committed thread",
            modelSelection: CLAUDE_MODEL,
            branch: GitRefName.make("feat/transfer"),
            worktreePath: "/home/sail/sail/.worktrees/wt-1",
            transferOrigin: {
              transferId: committedTxId,
              environmentId: LOCAL_ENV_ID,
              environmentName: TrimmedNonEmptyString.make("MacBook Pro"),
              machineId: null,
              projectId: LOCAL_PROJECT_ID,
              threadId: ThreadId.make("thread-commit-src"),
              transferredAt: NOW_ISO,
            },
            wasRunning: false,
            pendingRuntimeRequests: [],
            activeSubagentCount: 0,
            heldQueuedRunCount: 0,
            isGitRepo: true,
          }),
        localThreadTransferOrigin: {
          transferId: transientTxId,
          environmentId: BOAT_ENV_ID,
          environmentName: TrimmedNonEmptyString.make("dev-boat"),
          machineId: TrimmedNonEmptyString.make("machine-1"),
          projectId: BOAT_PROJECT_ID,
          threadId: BOAT_THREAD_ID,
          transferredAt: NOW_ISO,
        },
        onRemoteFinalizeSource: () =>
          Effect.fail(
            new SessionTransferError({
              code: "target_unavailable",
              message: "Boat temporarily unreachable",
            }),
          ),
      });

      return Effect.gen(function* () {
        const repo = yield* SessionTransferRepository.SessionTransferRepository;
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;

        yield* repo.upsert({
          transferId: committedTxId,
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceEnvironmentName: TrimmedNonEmptyString.make("MacBook Pro"),
          sourceMachineId: null,
          sourceProjectId: LOCAL_PROJECT_ID,
          sourceThreadId: ThreadId.make("thread-commit-src"),
          destinationEnvironmentId: BOAT_ENV_ID,
          destinationEnvironmentName: TrimmedNonEmptyString.make("dev-boat"),
          destinationMachineId: TrimmedNonEmptyString.make("machine-1"),
          destinationProjectId: BOAT_PROJECT_ID,
          destinationThreadId: DEST_THREAD_ID,
          phase: "committing_target",
          phaseDetail: "Importing workspace and history on destination...",
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
          transferId: transientTxId,
          direction: "boat_to_local",
          sourceEnvironmentId: BOAT_ENV_ID,
          sourceEnvironmentName: TrimmedNonEmptyString.make("dev-boat"),
          sourceMachineId: TrimmedNonEmptyString.make("machine-1"),
          sourceProjectId: BOAT_PROJECT_ID,
          sourceThreadId: BOAT_THREAD_ID,
          destinationEnvironmentId: LOCAL_ENV_ID,
          destinationEnvironmentName: TrimmedNonEmptyString.make("MacBook Pro"),
          destinationMachineId: null,
          destinationProjectId: LOCAL_PROJECT_ID,
          destinationThreadId: DEST_THREAD_ID,
          phase: "finalizing_source",
          phaseDetail: "Archiving source thread...",
          sourceWasRunning: false,
          autoResume: false,
          hadPendingRuntimeRequest: false,
          destinationBranch: GitRefName.make("feat/transfer"),
          destinationWorktreePath: TrimmedNonEmptyString.make("/Users/dev/sail/.worktrees/wt-1"),
          modelSelectionOverride: null,
          cloneDestinationPath: null,
          warnings: [],
          errorMessage: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          completedAt: null,
        });

        yield* coordinator.reconcileOnStartup;

        const recovered = yield* repo.getById(committedTxId);
        expect(Option.isSome(recovered) && recovered.value.phase).toBe("completed");
        expect(harness.calls.localFinalizeSource).toHaveLength(1);
        expect(harness.calls.remoteAbort).toHaveLength(0);

        const stillFinalizing = yield* repo.getById(transientTxId);
        expect(Option.isSome(stillFinalizing) && stillFinalizing.value.phase).toBe(
          "finalizing_source",
        );
        expect(harness.calls.remoteFinalizeSource).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "interruption mid-prepareSource and mid-stageImport and failure writing committing_target phase all abort attempted endpoints cleanly",
    () =>
      Effect.gen(function* () {
        // (a) Mid-prepareSource cancel still calls localAbort
        const prepStarted = Deferred.makeUnsafe<void>();
        const prepHold = Deferred.makeUnsafe<void>();
        const prepHarness = makeHarness({
          onLocalPrepareSource: () =>
            Deferred.succeed(prepStarted, undefined).pipe(
              Effect.andThen(Deferred.await(prepHold)),
              Effect.andThen(
                Effect.fail(new SessionTransferError({ code: "cancelled", message: "held" })),
              ),
            ),
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const started = yield* coordinator.start({
            transferId: SessionTransferId.make("tx-mid-prep"),
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
          });
          yield* Deferred.await(prepStarted);
          const cancelled = yield* coordinator.cancel({ transferId: started.transferId });
          expect(cancelled.phase).toBe("cancelled");
          expect(prepHarness.calls.localAbort).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(prepHarness.layer));

        // (b) Mid-stageImport cancel still calls BOTH localAbort and remoteAbort
        const stageStarted = Deferred.makeUnsafe<void>();
        const stageHold = Deferred.makeUnsafe<void>();
        const stageHarness = makeHarness({
          onRemoteStageImport: () =>
            Deferred.succeed(stageStarted, undefined).pipe(
              Effect.andThen(Deferred.await(stageHold)),
              Effect.andThen(
                Effect.fail(new SessionTransferError({ code: "cancelled", message: "held" })),
              ),
            ),
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const started = yield* coordinator.start({
            transferId: SessionTransferId.make("tx-mid-stage"),
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
          });
          yield* Deferred.await(stageStarted);
          const cancelled = yield* coordinator.cancel({ transferId: started.transferId });
          expect(cancelled.phase).toBe("cancelled");
          expect(stageHarness.calls.localAbort).toHaveLength(1);
          expect(stageHarness.calls.remoteAbort).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(stageHarness.layer));

        // (c) Failure writing committing_target phase does NOT mark committed and aborts both endpoints
        const commitWriteHarness = makeHarness({
          failTransitionPhase: "committing_target",
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const result = yield* collectTransferEventsUntilTerminal(
            coordinator,
            coordinator.start({
              transferId: SessionTransferId.make("tx-fail-commit-phase"),
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            }),
          );
          expect(result.final.phase).toBe("failed");
          expect(commitWriteHarness.calls.remoteCommitImport).toHaveLength(0);
          expect(commitWriteHarness.calls.localAbort).toHaveLength(1);
          expect(commitWriteHarness.calls.remoteAbort).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(commitWriteHarness.layer));
      }),
  );

  it.effect(
    "concurrent start calls with the same transferId launch exactly one worker and cancel cleanly interrupts it",
    () => {
      const prepStarted = Deferred.makeUnsafe<void>();
      const prepHold = Deferred.makeUnsafe<void>();
      const harness = makeHarness({
        onLocalPrepareSource: () =>
          Deferred.succeed(prepStarted, undefined).pipe(
            Effect.andThen(Deferred.await(prepHold)),
            Effect.andThen(
              Effect.fail(new SessionTransferError({ code: "cancelled", message: "held" })),
            ),
          ),
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const txId = SessionTransferId.make("tx-concurrent-same-id");
        const startInput = {
          transferId: txId,
          direction: "local_to_boat" as const,
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: { kind: "boat" as const, machineId: TrimmedNonEmptyString.make("machine-1") },
        };

        const [first, second] = yield* Effect.all(
          [coordinator.start(startInput), coordinator.start(startInput)],
          { concurrency: "unbounded" },
        );

        expect(first.transferId).toBe(txId);
        expect(second.transferId).toBe(txId);

        yield* Deferred.await(prepStarted);
        expect(harness.calls.localPrepareSource).toHaveLength(1);

        const cancelled = yield* coordinator.cancel({ transferId: txId });
        expect(cancelled.phase).toBe("cancelled");
        expect(harness.calls.localPrepareSource).toHaveLength(1);
        expect(harness.calls.localAbort).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "start rejects running thread without confirmedRunningPause and rejects unavailable modelSelectionOverride before prepareSource",
    () =>
      Effect.gen(function* () {
        const runningHarness = makeHarness({
          localThreadRuns: [{ status: "running" }],
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const err = yield* Effect.flip(
            coordinator.start({
              transferId: SessionTransferId.make("tx-unconfirmed-run"),
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            }),
          );
          expect(err.code).toBe("preflight_required");
          expect(runningHarness.calls.localPrepareSource).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(runningHarness.layer));

        const badModelHarness = makeHarness();
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const err = yield* Effect.flip(
            coordinator.start({
              transferId: SessionTransferId.make("tx-bad-model"),
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
              modelSelectionOverride: {
                instanceId: ProviderInstanceId.make("nonexistent"),
                model: TrimmedNonEmptyString.make("ghost-model"),
              },
            }),
          );
          expect(err.code).toBe("preflight_required");
          expect(err.message).toContain("ghost-model");
          expect(badModelHarness.calls.localPrepareSource).toHaveLength(0);
          expect(badModelHarness.calls.remoteStageImport).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(badModelHarness.layer));
      }),
  );

  it.effect(
    "strict destination project selection: fails missing explicit targetProjectId, fails ambiguous repo matches, and resolves post-clone strictly by projectId or canonical workspaceRoot (never by title)",
    () =>
      Effect.gen(function* () {
        // 1. Missing explicit targetProjectId fails with no fallback
        const missingExplicitHarness = makeHarness();
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const preflightErr = yield* Effect.flip(
            coordinator.preflight({
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
              targetProjectId: ProjectId.make("proj-missing"),
            }),
          );
          expect(preflightErr.code).toBe("not_found");

          const startRes = yield* collectTransferEventsUntilTerminal(
            coordinator,
            coordinator.start({
              transferId: SessionTransferId.make("tx-missing-explicit"),
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
              targetProjectId: ProjectId.make("proj-missing"),
            }),
          );
          expect(startRes.final.phase).toBe("failed");
          expect(startRes.final.errorMessage).toContain("proj-missing");
          expect(
            missingExplicitHarness.calls.boatInvoke.some((c) => c.command === "add_project"),
          ).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(missingExplicitHarness.layer));

        // 2. Multiple matching repos fail instead of falling through to add_project
        const ambiguousHarness = makeHarness({
          boatDaemonProjects: [],
          boatShellProjects: [
            {
              id: ProjectId.make("boat-dup-1"),
              title: "sail-1",
              workspaceRoot: "/home/sail/sail-1",
              repositoryIdentity: SAMPLE_REPO_IDENTITY,
            },
            {
              id: ProjectId.make("boat-dup-2"),
              title: "sail-2",
              workspaceRoot: "/home/sail/sail-2",
              repositoryIdentity: SAMPLE_REPO_IDENTITY,
            },
          ],
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const startRes = yield* collectTransferEventsUntilTerminal(
            coordinator,
            coordinator.start({
              transferId: SessionTransferId.make("tx-ambiguous-boat"),
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            }),
          );
          expect(startRes.final.phase).toBe("failed");
          expect(startRes.final.errorMessage).toContain("Multiple projects");
          expect(ambiguousHarness.calls.boatInvoke.some((c) => c.command === "add_project")).toBe(
            false,
          );
        }).pipe(Effect.scoped, Effect.provide(ambiguousHarness.layer));

        // 3. Post-clone resolution resolves by canonical workspaceRoot and NEVER picks unrelated title-only project
        const titleCollisionHarness = makeHarness({
          boatDaemonProjects: [],
          boatShellProjects: [
            {
              id: ProjectId.make("boat-unrelated-same-title"),
              title: "sail",
              workspaceRoot: "/home/sail/unrelated-sail",
              repositoryIdentity: null,
            },
          ],
          onBoatAddProjectReturn: () => {
            // Simulate add_project returning without adding any matching project/root:
            // must NOT pick boat-unrelated-same-title!
            return { ok: true };
          },
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const startRes = yield* collectTransferEventsUntilTerminal(
            coordinator,
            coordinator.start({
              transferId: SessionTransferId.make("tx-no-title-fallback"),
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            }),
          );
          expect(startRes.final.phase).toBe("failed");
          expect(titleCollisionHarness.calls.remoteStageImport).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(titleCollisionHarness.layer));

        const canonicalRootHarness = makeHarness({
          boatDaemonProjects: [],
          boatShellProjects: [
            {
              id: ProjectId.make("boat-unrelated-same-title"),
              title: "sail",
              workspaceRoot: "/home/sail/unrelated-sail",
              repositoryIdentity: null,
            },
          ],
          onBoatAddProjectReturn: (boatProjects) => {
            boatProjects.push({
              id: ProjectId.make("boat-cloned-exact"),
              title: "sail",
              workspaceRoot: "/home/sail/repos/sail",
              repositoryIdentity: null,
            });
            return { workspaceRoot: "/home/sail/repos/./sail/" };
          },
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const startRes = yield* collectTransferEventsUntilTerminal(
            coordinator,
            coordinator.start({
              transferId: SessionTransferId.make("tx-canonical-root"),
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            }),
          );
          expect(startRes.final.phase).toBe("completed");
          expect(startRes.final.destinationProjectId).toBe(ProjectId.make("boat-cloned-exact"));
        }).pipe(Effect.scoped, Effect.provide(canonicalRootHarness.layer));
      }),
  );

  it.effect(
    "read-scoped preflight on a sleeping Boat issues zero Boat HTTP/WS snapshot calls and does not wake the Boat",
    () => {
      const harness = makeHarness({ boatState: "asleep" });
      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const preflight = yield* coordinator.preflight({
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
        });

        expect(preflight.ready).toBe(true);
        expect(preflight.warnings.some((w) => w.includes("asleep"))).toBe(true);
        expect(harness.calls.remoteGetServerConfigCount).toBe(0);
        expect(harness.calls.remoteGetShellSnapshotCount).toBe(0);
        expect(harness.calls.remoteGetThreadSummaryCount).toBe(0);
        expect(harness.calls.boatInvoke.some((c) => c.command === "wake_machine")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("redacts signed transfer query tokens from persisted transfer errorMessage", () => {
    const harness = makeHarness({
      onStreamHttpTransfer: (input) =>
        Effect.fail(
          new SessionTransferError({
            code: "workspace_error",
            message: `Upload failed for ${input.sourceUrl} -> ${input.targetUrl}`,
          }),
        ),
    });
    return Effect.gen(function* () {
      const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
      const res = yield* collectTransferEventsUntilTerminal(
        coordinator,
        coordinator.start({
          transferId: SessionTransferId.make("tx-redact-err"),
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
        }),
      );
      expect(res.final.phase).toBe("failed");
      expect(res.final.errorMessage).toBeTruthy();
      expect(res.final.errorMessage).not.toContain("token=");
      expect(res.final.errorMessage).not.toContain("src-bundle");
      expect(res.final.errorMessage).not.toContain("boat-upload");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "redacts signed token path segments in persisted transfer errorMessage on 404 and 500 download failures",
    () =>
      Effect.gen(function* () {
        const bundleToken404 = "eyJ0eXBlIjoiYnVuZGxlLTQwNCJ9.superSecretPathSig404";
        const bundleToken500 = "eyJ0eXBlIjoiYnVuZGxlLTUwMCJ9.superSecretPathSig500";
        const attachToken500 = "eyJ0eXBlIjoiYXR0YWNobWVudCJ9.superSecretAttSig500";
        const assetToken500 = "eyJ0eXBlIjoiYXNzZXQifQ.superSecretAssetSig500";

        // 1. 404 with path-token URL
        const harness404 = makeHarness({
          onStreamHttpTransfer: () =>
            Effect.fail(
              new SessionTransferError({
                code: "not_found",
                message: `Transfer payload not found at source (http://127.0.0.1:41999/api/session-transfers/${bundleToken404}/bundle).`,
              }),
            ),
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const repo = yield* SessionTransferRepository.SessionTransferRepository;
          const result = yield* collectTransferEventsUntilTerminal(
            coordinator,
            coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            }),
          );
          expect(result.final.phase).toBe("failed");
          const persisted = yield* repo.getById(result.final.transferId);
          expect(Option.isSome(persisted)).toBe(true);
          if (!Option.isSome(persisted)) return;
          expect(persisted.value.errorMessage).toContain("/api/session-transfers/[REDACTED]");
          expect(persisted.value.errorMessage).not.toContain(bundleToken404);
          expect(persisted.value.errorMessage).not.toContain("superSecretPathSig404");
        }).pipe(Effect.scoped, Effect.provide(harness404.layer));

        // 2. 500 with path-token URLs across session-transfers, attachments, and assets
        const harness500 = makeHarness({
          onStreamHttpTransfer: () =>
            Effect.fail(
              new SessionTransferError({
                code: "workspace_error",
                message: `Failed to download transfer payload (HTTP 500): refs http://127.0.0.1:41999/api/session-transfers/${bundleToken500}/bundle http://127.0.0.1:41999/api/attachments/upload/${attachToken500} http://127.0.0.1:41999/api/assets/${assetToken500}/shot.png`,
              }),
            ),
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const repo = yield* SessionTransferRepository.SessionTransferRepository;
          const result = yield* collectTransferEventsUntilTerminal(
            coordinator,
            coordinator.start({
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            }),
          );
          expect(result.final.phase).toBe("failed");
          const persisted = yield* repo.getById(result.final.transferId);
          expect(Option.isSome(persisted)).toBe(true);
          if (!Option.isSome(persisted)) return;
          expect(persisted.value.errorMessage).toContain("/api/session-transfers/[REDACTED]");
          expect(persisted.value.errorMessage).toContain("/api/attachments/[REDACTED]");
          expect(persisted.value.errorMessage).toContain("/api/assets/[REDACTED]");
          expect(persisted.value.errorMessage).not.toContain(bundleToken500);
          expect(persisted.value.errorMessage).not.toContain(attachToken500);
          expect(persisted.value.errorMessage).not.toContain(assetToken500);
        }).pipe(Effect.scoped, Effect.provide(harness500.layer));
      }),
  );

  it.effect(
    "reconcileOnStartup aborts finalizing_source when destination thread does not exist instead of archiving source",
    () => {
      const txId = SessionTransferId.make("tx-finalizing-uncommitted");
      const harness = makeHarness({
        onRemoteGetThreadSummary: () =>
          Effect.fail(
            new SessionTransferError({
              code: "not_found",
              message: "Destination thread does not exist",
            }),
          ),
      });

      return Effect.gen(function* () {
        const repo = yield* SessionTransferRepository.SessionTransferRepository;
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;

        yield* repo.upsert({
          transferId: txId,
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceEnvironmentName: TrimmedNonEmptyString.make("MacBook Pro"),
          sourceMachineId: null,
          sourceProjectId: LOCAL_PROJECT_ID,
          sourceThreadId: LOCAL_THREAD_ID,
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

        yield* coordinator.reconcileOnStartup;

        const record = yield* repo.getById(txId);
        expect(Option.isSome(record) && record.value.phase).toBe("failed");
        expect(harness.calls.localFinalizeSource).toHaveLength(0);
        expect(harness.calls.localAbort).toHaveLength(1);
        expect(harness.calls.remoteAbort).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "live worker keeps transfer in finalizing_source on post-commit internal finalizeSource error and reconcileOnStartup completes it",
    () => {
      const txId = SessionTransferId.make("tx-post-commit-internal-err");
      let failFinalize = true;
      const finalizeFailedSignal = Deferred.makeUnsafe<void>();

      const harness = makeHarness({
        remoteThreadSummary: {
          transferOrigin: {
            transferId: txId,
            environmentId: LOCAL_ENV_ID,
            environmentName: TrimmedNonEmptyString.make("MacBook Pro"),
            machineId: null,
            projectId: LOCAL_PROJECT_ID,
            threadId: LOCAL_THREAD_ID,
            transferredAt: NOW_ISO,
          },
        },
        onLocalFinalizeSource: () => {
          if (failFinalize) {
            return Effect.fail(
              new SessionTransferError({
                code: "internal",
                message: "SQLITE_BUSY while archiving source thread",
              }),
            ).pipe(
              Effect.tapError(() =>
                Deferred.succeed(finalizeFailedSignal, undefined).pipe(Effect.ignore),
              ),
            );
          }
          return Effect.succeed({ archived: true });
        },
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const repo = yield* SessionTransferRepository.SessionTransferRepository;
        const subscribed = yield* Deferred.make<void>();

        const awaitRetryPhase = yield* Effect.forkScoped(
          coordinator.subscribe.pipe(
            Stream.tap((event) =>
              event._tag === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
            ),
            Stream.filter(
              (
                event,
              ): event is Extract<SessionTransferProgressEvent, { readonly _tag: "updated" }> =>
                event._tag === "updated" && event.transfer.transferId === txId,
            ),
            Stream.takeUntil(
              (event) =>
                event.transfer.phase === "finalizing_source" &&
                (event.transfer.phaseDetail?.includes("awaiting source archival retry") ?? false),
            ),
            Stream.runDrain,
          ),
        );

        yield* Deferred.await(subscribed);
        yield* coordinator.start({
          transferId: txId,
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
          autoResume: false,
        });

        yield* Deferred.await(finalizeFailedSignal);
        yield* Fiber.join(awaitRetryPhase);

        const afterError = yield* repo.getById(txId);
        expect(Option.isSome(afterError)).toBe(true);
        if (!Option.isSome(afterError)) return;
        expect(afterError.value.phase).toBe("finalizing_source");
        expect(afterError.value.completedAt).toBeNull();
        expect(afterError.value.errorMessage).toContain("SQLITE_BUSY");
        expect(harness.calls.localAbort).toHaveLength(0);
        expect(harness.calls.remoteAbort).toHaveLength(0);

        failFinalize = false;
        yield* coordinator.reconcileOnStartup;

        const completed = yield* repo.getById(txId);
        expect(Option.isSome(completed) && completed.value.phase).toBe("completed");
        expect(Option.isSome(completed) && completed.value.errorMessage).toBeNull();
        expect(harness.calls.localFinalizeSource).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "reconcileOnStartup keeps pre-commit transfer non-terminal when remote abort fails and retries cleanly next pass",
    () => {
      const txId = SessionTransferId.make("tx-remote-abort-retry");
      let remoteAbortShouldFail = true;
      const harness = makeHarness({
        onRemoteAbort: () => {
          if (remoteAbortShouldFail) {
            return Effect.fail(
              new SessionTransferError({
                code: "target_unavailable",
                message: "Boat temporarily unreachable during abort",
              }),
            );
          }
          return Effect.succeed({ cleanedUp: true });
        },
      });

      return Effect.gen(function* () {
        const repo = yield* SessionTransferRepository.SessionTransferRepository;
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;

        yield* repo.upsert({
          transferId: txId,
          direction: "local_to_boat",
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceEnvironmentName: TrimmedNonEmptyString.make("MacBook Pro"),
          sourceMachineId: null,
          sourceProjectId: LOCAL_PROJECT_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          destinationEnvironmentId: BOAT_ENV_ID,
          destinationEnvironmentName: TrimmedNonEmptyString.make("dev-boat"),
          destinationMachineId: TrimmedNonEmptyString.make("machine-1"),
          destinationProjectId: BOAT_PROJECT_ID,
          destinationThreadId: DEST_THREAD_ID,
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

        // First reconciliation: remote abort fails -> record MUST stay non-terminal.
        yield* coordinator.reconcileOnStartup;
        const afterFirst = yield* repo.getById(txId);
        expect(Option.isSome(afterFirst) && afterFirst.value.phase).toBe("transferring_workspace");
        expect(harness.calls.remoteAbort).toHaveLength(1);

        // Second reconciliation: remote abort succeeds -> transitions to failed.
        remoteAbortShouldFail = false;
        yield* coordinator.reconcileOnStartup;
        const afterSecond = yield* repo.getById(txId);
        expect(Option.isSome(afterSecond) && afterSecond.value.phase).toBe("failed");
        expect(harness.calls.remoteAbort).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "cancel honors completed, finalizing_source, and committed committing_target without aborting destination",
    () =>
      Effect.gen(function* () {
        // Case 1: Worker finishes uninterruptible commit and advances to completed while cancel interrupts it.
        const txId1 = SessionTransferId.make("tx-cancel-race-committed");
        const enteredCommit = Deferred.makeUnsafe<void>();
        const releaseCommit = Deferred.makeUnsafe<void>();
        let destinationCommitted = false;

        const harness1 = makeHarness({
          onBoatCommitImport: (_endpoint, input) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Deferred.succeed(enteredCommit, undefined).pipe(Effect.ignore);
                yield* Deferred.await(releaseCommit);
                destinationCommitted = true;
                return {
                  destinationProjectId: input.destinationProjectId,
                  destinationThreadId: input.destinationThreadId,
                  destinationBranch: GitRefName.make("feat/transfer"),
                  destinationWorktreePath: TrimmedNonEmptyString.make(
                    "/home/sail/sail/.worktrees/wt-1",
                  ),
                  resumed: false,
                  warnings: [],
                };
              }),
            ),
          onRemoteGetThreadSummary: (threadId) =>
            destinationCommitted
              ? Effect.succeed({
                  id: threadId,
                  projectId: BOAT_PROJECT_ID,
                  title: "Committed thread",
                  modelSelection: CLAUDE_MODEL,
                  branch: GitRefName.make("feat/transfer"),
                  worktreePath: "/home/sail/sail/.worktrees/wt-1",
                  transferOrigin: {
                    transferId: txId1,
                    environmentId: LOCAL_ENV_ID,
                    environmentName: TrimmedNonEmptyString.make("MacBook Pro"),
                    machineId: null,
                    projectId: LOCAL_PROJECT_ID,
                    threadId: LOCAL_THREAD_ID,
                    transferredAt: NOW_ISO,
                  },
                  wasRunning: false,
                  pendingRuntimeRequests: [],
                  activeSubagentCount: 0,
                  heldQueuedRunCount: 0,
                  isGitRepo: true,
                })
              : Effect.fail(new SessionTransferError({ code: "not_found", message: "missing" })),
        });

        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const repo = yield* SessionTransferRepository.SessionTransferRepository;

          yield* coordinator.start({
            transferId: txId1,
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            autoResume: false,
          });
          yield* Deferred.await(enteredCommit);

          // Simulate a race where cancel passed its initial phase check right before
          // committing_target was observed, then interrupts the worker as it completes commit.
          const current = yield* repo.getById(txId1);
          expect(Option.isSome(current) && current.value.phase).toBe("committing_target");
          if (Option.isSome(current)) {
            yield* repo.transitionPhase({
              transferId: txId1,
              phase: "transferring_workspace",
              updatedAt: NOW_ISO,
            });
          }

          const cancelFiber = yield* Effect.forkChild(
            Effect.flip(coordinator.cancel({ transferId: txId1 })),
          );
          for (let tick = 0; tick < 20; tick += 1) {
            yield* Effect.yieldNow;
          }
          yield* Deferred.succeed(releaseCommit, undefined).pipe(Effect.ignore);

          const cancelErr = yield* Fiber.join(cancelFiber);
          expect(cancelErr.code).toBe("invalid_phase");

          const finalRecord = yield* repo.getById(txId1);
          expect(Option.isSome(finalRecord)).toBe(true);
          if (Option.isSome(finalRecord)) {
            expect(["completed", "finalizing_source"]).toContain(finalRecord.value.phase);
          }
          expect(harness1.calls.localFinalizeSource).toHaveLength(1);
          expect(harness1.calls.remoteAbort).toHaveLength(0);
          expect(harness1.calls.localAbort).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(harness1.layer));

        // Case 2: Worker is interrupted inside committing_target after destination already committed
        // durably, and finalizeSource fails -> stays finalizing_source, cancel must NOT abort destination.
        const txId2 = SessionTransferId.make("tx-cancel-race-finalizing");
        const commitStarted2 = Deferred.makeUnsafe<void>();

        const harness2 = makeHarness({
          onBoatCommitImport: () =>
            Deferred.succeed(commitStarted2, undefined).pipe(Effect.andThen(Effect.never)),
          onLocalFinalizeSource: () =>
            Effect.fail(
              new SessionTransferError({
                code: "internal",
                message: "Transient archive lock",
              }),
            ),
          onRemoteGetThreadSummary: (threadId) =>
            Effect.succeed({
              id: threadId,
              projectId: BOAT_PROJECT_ID,
              title: "Committed thread",
              modelSelection: CLAUDE_MODEL,
              branch: GitRefName.make("feat/transfer"),
              worktreePath: "/home/sail/sail/.worktrees/wt-1",
              transferOrigin: {
                transferId: txId2,
                environmentId: LOCAL_ENV_ID,
                environmentName: TrimmedNonEmptyString.make("MacBook Pro"),
                machineId: null,
                projectId: LOCAL_PROJECT_ID,
                threadId: LOCAL_THREAD_ID,
                transferredAt: NOW_ISO,
              },
              wasRunning: false,
              pendingRuntimeRequests: [],
              activeSubagentCount: 0,
              heldQueuedRunCount: 0,
              isGitRepo: true,
            }),
        });

        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const repo = yield* SessionTransferRepository.SessionTransferRepository;

          yield* coordinator.start({
            transferId: txId2,
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            autoResume: false,
          });
          yield* Deferred.await(commitStarted2);

          const current = yield* repo.getById(txId2);
          expect(Option.isSome(current) && current.value.phase).toBe("committing_target");
          if (Option.isSome(current)) {
            yield* repo.transitionPhase({
              transferId: txId2,
              phase: "transferring_workspace",
              updatedAt: NOW_ISO,
            });
          }

          const cancelErr = yield* Effect.flip(coordinator.cancel({ transferId: txId2 }));
          expect(cancelErr.code).toBe("invalid_phase");

          const finalRecord = yield* repo.getById(txId2);
          expect(Option.isSome(finalRecord) && finalRecord.value.phase).toBe("finalizing_source");
          expect(harness2.calls.localFinalizeSource).toHaveLength(1);
          expect(harness2.calls.remoteAbort).toHaveLength(0);
          expect(harness2.calls.localAbort).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(harness2.layer));
      }),
  );

  it.live(
    "interrupting winning start fiber settles startingTransfers Deferred so duplicate waiter never hangs",
    () => {
      const txId = SessionTransferId.make("tx-start-interrupt-race");
      const enteredStart = Deferred.makeUnsafe<void>();
      let blockFirstCall = true;

      const harness = makeHarness({
        onRemoteGetServerConfig: () => {
          if (blockFirstCall) {
            blockFirstCall = false;
            return Deferred.succeed(enteredStart, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.succeed({
            environmentId: BOAT_ENV_ID,
            environmentLabel: "dev-boat",
            sessionTransferSupported: true,
            providers: [makeServerProvider("claudeAgent", "claudeAgent", ["claude-sonnet-4-6"])],
          });
        },
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const startInput = {
          transferId: txId,
          direction: "local_to_boat" as const,
          sourceEnvironmentId: LOCAL_ENV_ID,
          sourceThreadId: LOCAL_THREAD_ID,
          target: { kind: "boat" as const, machineId: TrimmedNonEmptyString.make("machine-1") },
          autoResume: false,
        };

        const winner = yield* Effect.forkChild(coordinator.start(startInput));
        yield* Deferred.await(enteredStart);

        const waiter = yield* Effect.forkChild(coordinator.start(startInput));
        for (let tick = 0; tick < 20; tick += 1) {
          yield* Effect.yieldNow;
        }

        yield* Fiber.interrupt(winner);

        const waiterExit = yield* Fiber.await(waiter).pipe(
          Effect.timeoutOption(Duration.seconds(2)),
        );
        expect(Option.isSome(waiterExit)).toBe(true);
        if (Option.isSome(waiterExit)) {
          expect(Exit.isFailure(waiterExit.value)).toBe(true);
        }

        const retryResult = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.start(startInput),
        );
        expect(retryResult.final.phase).toBe("completed");
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "passes resolved destination modelSelectionOverride (provider instance + canonical slug) to stageImport and commitImport",
    () => {
      const destinationProvider: ServerProvider = {
        ...makeServerProvider("claude-boat-custom", "claudeAgent", ["claude-sonnet-4-6"]),
        models: [
          {
            slug: TrimmedNonEmptyString.make("claude-sonnet-4-6"),
            name: TrimmedNonEmptyString.make("Claude Sonnet 4.6"),
            aliases: [TrimmedNonEmptyString.make("sonnet-latest")],
            isCustom: false,
            capabilities: null,
          },
        ],
      };

      const harness = makeHarness({
        boatProviders: [destinationProvider],
      });

      return Effect.gen(function* () {
        const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
        const result = yield* collectTransferEventsUntilTerminal(
          coordinator,
          coordinator.start({
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            modelSelectionOverride: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: TrimmedNonEmptyString.make("sonnet-latest"),
            },
            autoResume: false,
          }),
        );

        expect(result.final.phase).toBe("completed");
        const expectedResolved: ModelSelection = {
          instanceId: ProviderInstanceId.make("claude-boat-custom"),
          model: TrimmedNonEmptyString.make("claude-sonnet-4-6"),
        };
        expect(harness.calls.remoteStageImport).toHaveLength(1);
        expect(harness.calls.remoteStageImport[0]?.modelSelectionOverride).toEqual(
          expectedResolved,
        );
        expect(harness.calls.remoteCommitImport).toHaveLength(1);
        expect(harness.calls.remoteCommitImport[0]?.modelSelectionOverride).toEqual(
          expectedResolved,
        );
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "sleeping local-to-Boat preflight enforces project resolution parity for invalid/unverified targetProjectId and multiple origin matches",
    () =>
      Effect.gen(function* () {
        // 1. Sleeping Boat with cached projects: bogus explicit targetProjectId fails with not_found.
        const cachedHarness = makeHarness({ boatState: "asleep" });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const err = yield* Effect.flip(
            coordinator.preflight({
              direction: "local_to_boat",
              sourceEnvironmentId: LOCAL_ENV_ID,
              sourceThreadId: LOCAL_THREAD_ID,
              target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
              targetProjectId: ProjectId.make("proj-does-not-exist"),
            }),
          );
          expect(err.code).toBe("not_found");
          expect(cachedHarness.calls.remoteGetShellSnapshotCount).toBe(0);
        }).pipe(Effect.scoped, Effect.provide(cachedHarness.layer));

        // 2. Sleeping Boat without cached project list: explicit targetProjectId cannot be verified -> ready=false.
        const uncachedHarness = makeHarness({
          boatState: "asleep",
          boatDaemonProjects: null,
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const preflight = yield* coordinator.preflight({
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
            targetProjectId: ProjectId.make("proj-unverified"),
          });
          expect(preflight.ready).toBe(false);
          expect(preflight.needsProjectSelection).toBe(true);
          expect(preflight.resolvedTargetProjectId).toBeNull();
          expect(preflight.warnings.some((w) => w.includes("project list is unavailable"))).toBe(
            true,
          );
          expect(uncachedHarness.calls.remoteGetShellSnapshotCount).toBe(0);
        }).pipe(Effect.scoped, Effect.provide(uncachedHarness.layer));

        // 3. Sleeping Boat with multiple originProjectId matches: MUST report ambiguity
        //    even if only one of them matches repoKey (never fall through to repo matching).
        const ambiguousOriginHarness = makeHarness({
          boatState: "asleep",
          boatDaemonProjects: [
            {
              id: "proj-boat-origin-1",
              originProjectId: LOCAL_PROJECT_ID,
              title: "sail-1",
              repoKey: SAMPLE_REPO_IDENTITY.canonicalKey,
            },
            {
              id: "proj-boat-origin-2",
              originProjectId: LOCAL_PROJECT_ID,
              title: "sail-2",
              repoKey: "github.com/other/repo",
            },
          ],
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* SessionTransferCoordinator.SessionTransferCoordinator;
          const preflight = yield* coordinator.preflight({
            direction: "local_to_boat",
            sourceEnvironmentId: LOCAL_ENV_ID,
            sourceThreadId: LOCAL_THREAD_ID,
            target: { kind: "boat", machineId: TrimmedNonEmptyString.make("machine-1") },
          });
          expect(preflight.ready).toBe(false);
          expect(preflight.needsProjectSelection).toBe(true);
          expect(preflight.resolvedTargetProjectId).toBeNull();
          expect(preflight.willAutoCloneProject).toBe(false);
          expect(ambiguousOriginHarness.calls.remoteGetShellSnapshotCount).toBe(0);
        }).pipe(Effect.scoped, Effect.provide(ambiguousOriginHarness.layer));
      }),
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

  it.effect(
    "getShellSnapshot and getThreadSummary send x-t3-orchestration-protocol header and read snapshot.projection.thread",
    () =>
      Effect.gen(function* () {
        const seenHeaders: Array<{
          readonly url: string;
          readonly protocol: string | undefined;
          readonly auth: string | undefined;
        }> = [];

        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const srv = NodeHttp.createServer((req, res) => {
              const protoHeader = req.headers[ORCHESTRATION_PROTOCOL_HEADER];
              const authHeader = req.headers.authorization;
              seenHeaders.push({
                url: req.url ?? "",
                protocol: typeof protoHeader === "string" ? protoHeader : undefined,
                auth: typeof authHeader === "string" ? authHeader : undefined,
              });
              if (req.url === "/api/orchestration/shell") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    snapshotSequence: 5,
                    projects: [
                      {
                        id: BOAT_PROJECT_ID,
                        title: "sail",
                        workspaceRoot: "/home/sail/sail",
                      },
                    ],
                    threads: [
                      {
                        id: BOAT_THREAD_ID,
                        projectId: BOAT_PROJECT_ID,
                        title: "Boat thread",
                        branch: "feat/transfer",
                        worktreePath: "/home/sail/sail/.worktrees/wt-boat",
                      },
                    ],
                  }),
                );
                return;
              }
              if (req.url?.startsWith(`/api/orchestration/threads/${BOAT_THREAD_ID}/bounded`)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    snapshotSequence: 9,
                    projection: {
                      thread: {
                        id: BOAT_THREAD_ID,
                        projectId: BOAT_PROJECT_ID,
                        title: "Projected Boat Thread",
                        modelSelection: CLAUDE_MODEL,
                        providerInstanceId: CLAUDE_MODEL.instanceId,
                        branch: "feat/transfer",
                        worktreePath: "/home/sail/sail/.worktrees/wt-boat",
                        transferOrigin: {
                          transferId: "tx-origin-1",
                          environmentId: LOCAL_ENV_ID,
                          environmentName: "MacBook Pro",
                          machineId: null,
                          projectId: LOCAL_PROJECT_ID,
                          threadId: LOCAL_THREAD_ID,
                          transferredAt: NOW_ISO,
                        },
                      },
                      runs: [{ status: "running" }, { status: "queued" }],
                      runtimeRequests: [
                        {
                          id: "req-live-1",
                          kind: "command",
                          status: "pending",
                          createdAt: NOW_ISO,
                        },
                      ],
                      subagents: [{ status: "running" }],
                    },
                  }),
                );
                return;
              }
              res.writeHead(404);
              res.end("not found");
            });
            await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
            const addr = srv.address();
            if (!addr || typeof addr === "string") throw new Error("Expected numeric port");
            return { srv, port: addr.port };
          }),
          ({ srv }) =>
            Effect.promise(() => new Promise<void>((resolve) => srv.close(() => resolve()))),
        );

        const httpClient = yield* HttpClient.HttpClient;
        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.some(httpClient));
        const endpoint: SessionTransferCoordinator.BoatRemoteEndpoint = {
          localUrl: `http://127.0.0.1:${server.port}`,
          bearerToken: "boat-secret-bearer",
        };

        const shell = yield* client.getShellSnapshot(endpoint);
        expect(shell.projects).toHaveLength(1);
        expect(shell.projects[0]?.id).toBe(BOAT_PROJECT_ID);

        const summary = yield* client.getThreadSummary(endpoint, BOAT_THREAD_ID);
        expect(summary.title).toBe("Projected Boat Thread");
        expect(summary.wasRunning).toBe(true);
        expect(summary.heldQueuedRunCount).toBe(1);
        expect(summary.pendingRuntimeRequests).toHaveLength(1);
        expect(summary.activeSubagentCount).toBe(1);
        expect(summary.transferOrigin?.transferId).toBe(SessionTransferId.make("tx-origin-1"));

        expect(seenHeaders).toHaveLength(2);
        for (const h of seenHeaders) {
          expect(h.protocol).toBe(ORCHESTRATION_PROTOCOL_VERSION_TEXT);
          expect(h.auth).toBe("Bearer boat-secret-bearer");
        }
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.effect(
    "streamHttpTransfer streams Content-Length and chunked payloads, redacts signed URLs on 404, and caps 500 error body reads at 1024 bytes",
    () =>
      Effect.gen(function* () {
        const payload = Buffer.alloc(192 * 1024, 0xab);
        let receivedChunks: Buffer[] = [];
        let hugeBodyBytesWritten = 0;

        const servers = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const srcSrv = NodeHttp.createServer((req, res) => {
              if (req.url?.startsWith("/cl")) {
                res.writeHead(200, {
                  "content-type": "application/octet-stream",
                  "content-length": String(payload.byteLength),
                });
                res.end(payload);
                return;
              }
              if (req.url?.startsWith("/chunked")) {
                res.writeHead(200, { "content-type": "application/octet-stream" });
                for (let off = 0; off < payload.byteLength; off += 16 * 1024) {
                  res.write(payload.subarray(off, Math.min(payload.byteLength, off + 16 * 1024)));
                }
                res.end();
                return;
              }
              if (req.url?.startsWith("/missing")) {
                res.writeHead(404);
                res.end("not found");
                return;
              }
              if (req.url?.startsWith("/huge-error")) {
                res.writeHead(500, { "content-type": "text/plain" });
                const prefix =
                  "Failed at http://127.0.0.1/api/session-transfers/tx/bundle?token=super-secret-token ";
                const huge = prefix + "E".repeat(128 * 1024);
                hugeBodyBytesWritten = Buffer.byteLength(huge);
                res.end(huge);
                return;
              }
              res.writeHead(404);
              res.end();
            });

            const dstSrv = NodeHttp.createServer((req, res) => {
              receivedChunks = [];
              req.on("data", (chunk: Buffer) => receivedChunks.push(chunk));
              req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
              });
            });

            await new Promise<void>((resolve) => srcSrv.listen(0, "127.0.0.1", () => resolve()));
            await new Promise<void>((resolve) => dstSrv.listen(0, "127.0.0.1", () => resolve()));
            const srcAddr = srcSrv.address();
            const dstAddr = dstSrv.address();
            if (
              !srcAddr ||
              typeof srcAddr === "string" ||
              !dstAddr ||
              typeof dstAddr === "string"
            ) {
              throw new Error("Expected numeric ports");
            }
            return { srcSrv, dstSrv, srcPort: srcAddr.port, dstPort: dstAddr.port };
          }),
          ({ srcSrv, dstSrv }) =>
            Effect.promise(async () => {
              await new Promise<void>((resolve) => srcSrv.close(() => resolve()));
              await new Promise<void>((resolve) => dstSrv.close(() => resolve()));
            }),
        );

        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.none());

        // 1. Content-Length transfer
        const clRes = yield* client.streamHttpTransfer({
          sourceUrl: `http://127.0.0.1:${servers.srcPort}/cl?token=signed-src`,
          targetUrl: `http://127.0.0.1:${servers.dstPort}/upload?token=signed-dst`,
          contentType: "application/octet-stream",
        });
        expect(clRes.bytesTransferred).toBe(payload.byteLength);
        expect(Buffer.concat(receivedChunks).equals(payload)).toBe(true);

        // 2. Chunked transfer
        const chunkedRes = yield* client.streamHttpTransfer({
          sourceUrl: `http://127.0.0.1:${servers.srcPort}/chunked?token=signed-src`,
          targetUrl: `http://127.0.0.1:${servers.dstPort}/upload?token=signed-dst`,
          contentType: "application/octet-stream",
        });
        expect(chunkedRes.bytesTransferred).toBe(payload.byteLength);
        expect(Buffer.concat(receivedChunks).equals(payload)).toBe(true);

        // 3. 404 redacts signed query string
        const notFoundErr = yield* Effect.flip(
          client.streamHttpTransfer({
            sourceUrl: `http://127.0.0.1:${servers.srcPort}/missing?token=top-secret-404`,
            targetUrl: `http://127.0.0.1:${servers.dstPort}/upload`,
          }),
        );
        expect(notFoundErr.code).toBe("not_found");
        expect(notFoundErr.message).toContain("/missing");
        expect(notFoundErr.message).not.toContain("top-secret-404");
        expect(notFoundErr.message).not.toContain("token=");

        // 4. 500 caps error body read & redacts signed URLs inside body
        const serverErr = yield* Effect.flip(
          client.streamHttpTransfer({
            sourceUrl: `http://127.0.0.1:${servers.srcPort}/huge-error?token=top-secret-500`,
            targetUrl: `http://127.0.0.1:${servers.dstPort}/upload`,
          }),
        );
        expect(serverErr.code).toBe("workspace_error");
        expect(hugeBodyBytesWritten).toBeGreaterThan(100_000);
        expect(serverErr.message.length).toBeLessThan(350);
        expect(serverErr.message).not.toContain("top-secret-500");
        expect(serverErr.message).not.toContain("super-secret-token");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "streamHttpTransfer redacts signed path-segment credentials on 404 and 500 responses",
    () =>
      Effect.gen(function* () {
        const pathToken404 = "eyJvcCI6ImRvd25sb2FkIn0.pathSecretSig404";
        const pathToken500 = "eyJvcCI6ImRvd25sb2FkIn0.pathSecretSig500";
        const attPathToken = "eyJvcCI6InVwbG9hZCJ9.attSecretSig500";

        const servers = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const srcSrv = NodeHttp.createServer((req, res) => {
              if (req.url?.includes(pathToken404)) {
                res.writeHead(404);
                res.end("not found");
                return;
              }
              res.writeHead(500, { "content-type": "text/plain" });
              res.end(
                `Upstream failed for /api/session-transfers/${pathToken500}/bundle and http://127.0.0.1/api/attachments/upload/${attPathToken}`,
              );
            });
            const dstSrv = NodeHttp.createServer((_req, res) => {
              res.writeHead(200);
              res.end("ok");
            });
            await new Promise<void>((resolve) => srcSrv.listen(0, "127.0.0.1", () => resolve()));
            await new Promise<void>((resolve) => dstSrv.listen(0, "127.0.0.1", () => resolve()));
            const srcAddr = srcSrv.address();
            const dstAddr = dstSrv.address();
            if (
              !srcAddr ||
              typeof srcAddr === "string" ||
              !dstAddr ||
              typeof dstAddr === "string"
            ) {
              throw new Error("Expected numeric ports");
            }
            return { srcSrv, dstSrv, srcPort: srcAddr.port, dstPort: dstAddr.port };
          }),
          ({ srcSrv, dstSrv }) =>
            Effect.promise(async () => {
              await new Promise<void>((resolve) => srcSrv.close(() => resolve()));
              await new Promise<void>((resolve) => dstSrv.close(() => resolve()));
            }),
        );

        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.none());

        const err404 = yield* Effect.flip(
          client.streamHttpTransfer({
            sourceUrl: `http://127.0.0.1:${servers.srcPort}/api/session-transfers/${pathToken404}/bundle`,
            targetUrl: `http://127.0.0.1:${servers.dstPort}/api/session-transfers/dst-tok/bundle`,
          }),
        );
        expect(err404.code).toBe("not_found");
        expect(err404.message).toContain("/api/session-transfers/[REDACTED]");
        expect(err404.message).not.toContain(pathToken404);
        expect(err404.message).not.toContain("pathSecretSig404");

        const err500 = yield* Effect.flip(
          client.streamHttpTransfer({
            sourceUrl: `http://127.0.0.1:${servers.srcPort}/api/session-transfers/${pathToken500}/bundle`,
            targetUrl: `http://127.0.0.1:${servers.dstPort}/api/session-transfers/dst-tok/bundle`,
          }),
        );
        expect(err500.code).toBe("workspace_error");
        expect(err500.message).toContain("/api/session-transfers/[REDACTED]");
        expect(err500.message).toContain("/api/attachments/[REDACTED]");
        expect(err500.message).not.toContain(pathToken500);
        expect(err500.message).not.toContain(attPathToken);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "streamHttpTransfer preserves early target 413/503 status and delayed error body across Content-Length and chunked sources",
    () =>
      Effect.gen(function* () {
        const chunk64k = Buffer.alloc(64 * 1024, 0x55);
        const totalSize = chunk64k.byteLength * 4;

        const servers = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const srcSrv = NodeHttp.createServer((req, res) => {
              const isChunked = req.url?.startsWith("/paced-chunked");
              if (isChunked) {
                res.writeHead(200, { "content-type": "application/octet-stream" });
              } else {
                res.writeHead(200, {
                  "content-type": "application/octet-stream",
                  "content-length": String(totalSize),
                });
              }
              res.write(chunk64k);
              // @effect-diagnostics-next-line globalTimers:off -- Raw Node HTTP mock server paces chunks outside an Effect fiber.
              const timer = setTimeout(() => {
                if (!res.destroyed && !res.writableEnded) {
                  res.write(chunk64k);
                  res.write(chunk64k);
                  res.end(chunk64k);
                }
              }, 300);
              res.on("close", () => clearTimeout(timer));
            });

            const dstSrv = NodeHttp.createServer((req, res) => {
              const status = req.url?.includes("413") ? 413 : 503;
              const detail =
                status === 413 ? "bundle exceeds 100 MiB limit" : "boat staging disk busy";
              res.writeHead(status, { "content-type": "text/plain" });
              res.flushHeaders();
              // @effect-diagnostics-next-line globalTimers:off -- Raw Node HTTP mock server delays error body outside an Effect fiber.
              setTimeout(() => {
                if (!res.destroyed && !res.writableEnded) {
                  res.end(detail);
                }
              }, 100);
              req.resume();
            });

            await new Promise<void>((resolve) => srcSrv.listen(0, "127.0.0.1", () => resolve()));
            await new Promise<void>((resolve) => dstSrv.listen(0, "127.0.0.1", () => resolve()));
            const srcAddr = srcSrv.address();
            const dstAddr = dstSrv.address();
            if (
              !srcAddr ||
              typeof srcAddr === "string" ||
              !dstAddr ||
              typeof dstAddr === "string"
            ) {
              throw new Error("Expected numeric ports");
            }
            return { srcSrv, dstSrv, srcPort: srcAddr.port, dstPort: dstAddr.port };
          }),
          ({ srcSrv, dstSrv }) =>
            Effect.promise(async () => {
              srcSrv.closeAllConnections();
              dstSrv.closeAllConnections();
              await new Promise<void>((resolve) => srcSrv.close(() => resolve()));
              await new Promise<void>((resolve) => dstSrv.close(() => resolve()));
            }),
        );

        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.none());

        for (const sourcePath of ["/paced-cl", "/paced-chunked"]) {
          const err413 = yield* Effect.flip(
            client.streamHttpTransfer({
              sourceUrl: `http://127.0.0.1:${servers.srcPort}${sourcePath}`,
              targetUrl: `http://127.0.0.1:${servers.dstPort}/reject-413`,
            }),
          );
          expect(err413.code).toBe("bundle_too_large");
          expect(err413.message).toContain("HTTP 413");
          expect(err413.message).toContain("bundle exceeds 100 MiB limit");

          const err503 = yield* Effect.flip(
            client.streamHttpTransfer({
              sourceUrl: `http://127.0.0.1:${servers.srcPort}${sourcePath}`,
              targetUrl: `http://127.0.0.1:${servers.dstPort}/reject-503`,
            }),
          );
          expect(err503.code).toBe("workspace_error");
          expect(err503.message).toContain("HTTP 503");
          expect(err503.message).toContain("boat staging disk busy");
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "streamHttpTransfer fails when target returns early 2xx while source truncates before Content-Length",
    () =>
      Effect.gen(function* () {
        const servers = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const srcSrv = NodeNet.createServer((socket) => {
              socket.once("data", () => {
                socket.write(
                  "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n",
                );
                socket.write(Buffer.alloc(8192, 0x41));
                // @effect-diagnostics-next-line globalTimers:off -- Raw Node TCP mock server truncates socket outside an Effect fiber.
                setTimeout(() => {
                  socket.end();
                }, 60);
              });
            });

            const dstSrv = NodeHttp.createServer((req, res) => {
              const status = req.url?.includes("201") ? 201 : 200;
              res.writeHead(status, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
              req.resume();
            });

            await new Promise<void>((resolve) => srcSrv.listen(0, "127.0.0.1", () => resolve()));
            await new Promise<void>((resolve) => dstSrv.listen(0, "127.0.0.1", () => resolve()));
            const srcAddr = srcSrv.address();
            const dstAddr = dstSrv.address();
            if (
              !srcAddr ||
              typeof srcAddr === "string" ||
              !dstAddr ||
              typeof dstAddr === "string"
            ) {
              throw new Error("Expected numeric ports");
            }
            return { srcSrv, dstSrv, srcPort: srcAddr.port, dstPort: dstAddr.port };
          }),
          ({ srcSrv, dstSrv }) =>
            Effect.promise(async () => {
              dstSrv.closeAllConnections();
              await new Promise<void>((resolve) => srcSrv.close(() => resolve()));
              await new Promise<void>((resolve) => dstSrv.close(() => resolve()));
            }),
        );

        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.none());

        for (const dstPath of ["/early-200", "/early-201"]) {
          const err = yield* Effect.flip(
            client.streamHttpTransfer({
              sourceUrl: `http://127.0.0.1:${servers.srcPort}/truncated`,
              targetUrl: `http://127.0.0.1:${servers.dstPort}${dstPath}`,
            }),
          );
          expect(err.code).toBe("workspace_error");
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "streamHttpTransfer strictly rejects invalid or conflicting Content-Length and malformed or truncated chunked framing",
    () =>
      Effect.gen(function* () {
        let receivedTargetBytes = Buffer.alloc(0);

        const servers = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const srcSrv = NodeNet.createServer((socket) => {
              socket.once("data", (buf) => {
                const reqLine = buf.toString("latin1").split("\r\n")[0] ?? "";
                if (reqLine.includes("/bad-cl-alpha")) {
                  socket.end(
                    "HTTP/1.1 200 OK\r\nContent-Length: abc\r\nConnection: close\r\n\r\nhello",
                  );
                  return;
                }
                if (reqLine.includes("/bad-cl-conflict")) {
                  socket.end(
                    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 10\r\nConnection: close\r\n\r\nhello",
                  );
                  return;
                }
                if (reqLine.includes("/bad-chunk-delim")) {
                  socket.end(
                    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhelloXX0\r\n\r\n",
                  );
                  return;
                }
                if (reqLine.includes("/truncated-chunk-trailer")) {
                  socket.end(
                    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n",
                  );
                  return;
                }
                if (reqLine.includes("/valid-chunk-with-trailer")) {
                  socket.end(
                    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\nX-Checksum: deadbeef\r\n\r\n",
                  );
                  return;
                }
                socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
              });
            });

            const dstSrv = NodeHttp.createServer((req, res) => {
              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => {
                receivedTargetBytes = Buffer.concat(chunks);
                res.writeHead(200);
                res.end("ok");
              });
            });

            await new Promise<void>((resolve) => srcSrv.listen(0, "127.0.0.1", () => resolve()));
            await new Promise<void>((resolve) => dstSrv.listen(0, "127.0.0.1", () => resolve()));
            const srcAddr = srcSrv.address();
            const dstAddr = dstSrv.address();
            if (
              !srcAddr ||
              typeof srcAddr === "string" ||
              !dstAddr ||
              typeof dstAddr === "string"
            ) {
              throw new Error("Expected numeric ports");
            }
            return { srcSrv, dstSrv, srcPort: srcAddr.port, dstPort: dstAddr.port };
          }),
          ({ srcSrv, dstSrv }) =>
            Effect.promise(async () => {
              dstSrv.closeAllConnections();
              await new Promise<void>((resolve) => srcSrv.close(() => resolve()));
              await new Promise<void>((resolve) => dstSrv.close(() => resolve()));
            }),
        );

        const client = SessionTransferCoordinator.makeLiveBoatRemoteClient(Option.none());

        const badAlpha = yield* Effect.flip(
          client.streamHttpTransfer({
            sourceUrl: `http://127.0.0.1:${servers.srcPort}/bad-cl-alpha`,
            targetUrl: `http://127.0.0.1:${servers.dstPort}/upload`,
          }),
        );
        expect(badAlpha.code).toBe("workspace_error");
        expect(badAlpha.message).toContain("Content-Length");

        const badConflict = yield* Effect.flip(
          client.streamHttpTransfer({
            sourceUrl: `http://127.0.0.1:${servers.srcPort}/bad-cl-conflict`,
            targetUrl: `http://127.0.0.1:${servers.dstPort}/upload`,
          }),
        );
        expect(badConflict.code).toBe("workspace_error");
        expect(badConflict.message).toContain("Conflicting Content-Length");

        const badChunkDelim = yield* Effect.flip(
          client.streamHttpTransfer({
            sourceUrl: `http://127.0.0.1:${servers.srcPort}/bad-chunk-delim`,
            targetUrl: `http://127.0.0.1:${servers.dstPort}/upload`,
          }),
        );
        expect(badChunkDelim.code).toBe("workspace_error");
        expect(badChunkDelim.message).toContain("Malformed chunked");

        const truncatedTrailer = yield* Effect.flip(
          client.streamHttpTransfer({
            sourceUrl: `http://127.0.0.1:${servers.srcPort}/truncated-chunk-trailer`,
            targetUrl: `http://127.0.0.1:${servers.dstPort}/upload`,
          }),
        );
        expect(truncatedTrailer.code).toBe("workspace_error");
        expect(truncatedTrailer.message).toContain("prematurely");

        const validWithTrailer = yield* client.streamHttpTransfer({
          sourceUrl: `http://127.0.0.1:${servers.srcPort}/valid-chunk-with-trailer`,
          targetUrl: `http://127.0.0.1:${servers.dstPort}/upload`,
        });
        expect(validWithTrailer.bytesTransferred).toBe(5);
        expect(receivedTargetBytes.toString("utf8")).toBe("hello");
      }).pipe(Effect.scoped),
  );
});

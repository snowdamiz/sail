import {
  ChatAttachmentId,
  CommandId,
  EnvironmentId,
  type GitRefName as GitRefNameSchema,
  IsoDateTime,
  type ModelSelection,
  type OrchestrationV2Run,
  ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RepositoryIdentity,
  type RuntimeRequestId,
  type ServerProvider,
  type SessionTransferAbortInput,
  SessionTransferAbortResult,
  type SessionTransferAvailableModel,
  type SessionTransferCancelInput,
  type SessionTransferCandidateProject,
  type SessionTransferCommitImportInput,
  SessionTransferCommitImportResult,
  type SessionTransferDirection,
  SessionTransferError,
  type SessionTransferFinalizeSourceInput,
  SessionTransferFinalizeSourceResult,
  SessionTransferId,
  type SessionTransferListInput,
  type SessionTransferListResult,
  type SessionTransferPendingRuntimeRequest,
  type SessionTransferPhase,
  type SessionTransferPreflightInput,
  type SessionTransferPreflightResult,
  type SessionTransferPrepareSourceInput,
  SessionTransferPrepareSourceResult,
  type SessionTransferProgressEvent,
  type SessionTransferRecord,
  type SessionTransferRetryInput,
  type SessionTransferSourceState,
  type SessionTransferStageImportInput,
  SessionTransferStageImportResult,
  type SessionTransferStartInput,
  ThreadId,
  TrimmedNonEmptyString,
  WS_METHODS,
  isProviderAvailable,
  isTerminalSessionTransferPhase,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as SessionTransferEndpointService from "../orchestration-v2/SessionTransferEndpointService.ts";
import * as SessionTransferRepository from "../persistence/SessionTransferRepository.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as BoatCredentialSync from "./BoatCredentialSync.ts";
import * as BoatProviderSync from "./BoatProviderSync.ts";
import * as BoatSupervisor from "./BoatSupervisor.ts";

type GitRefName = typeof GitRefNameSchema.Type;

const WORKING_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const ACTIVE_SUBAGENT_STATUSES = new Set(["pending", "running", "waiting"]);
const RUNNING_BOAT_STATES = new Set(["working", "idle"]);
const KEEP_AWAKE_PING_INTERVAL = Duration.seconds(30);
const KEEP_AWAKE_WINDOW_MINUTES = 10;
const RPC_TIMEOUT_MS = 120_000;
const CLONE_POLL_INTERVAL = Duration.millis(500);
const CLONE_WAIT_TIMEOUT_MS = 15 * 60_000;

const isSessionTransferError = Schema.is(SessionTransferError);

export interface BoatRemoteEndpoint {
  readonly localUrl: string;
  readonly bearerToken: string;
}

export interface RemoteShellProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null;
}

export interface RemoteThreadSummary {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerDriverKind?: ProviderDriverKind;
  readonly branch: GitRefName | null;
  readonly worktreePath: string | null;
  readonly wasRunning: boolean;
  readonly pendingRuntimeRequests: ReadonlyArray<SessionTransferPendingRuntimeRequest>;
  readonly activeSubagentCount: number;
  readonly heldQueuedRunCount: number;
  readonly isGitRepo?: boolean;
  readonly isDirty?: boolean;
  readonly headSha?: string | null;
}

export interface RemoteServerConfigSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string;
  readonly sessionTransferSupported: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface BoatRemoteClientShape {
  readonly getServerConfig: (
    endpoint: BoatRemoteEndpoint,
  ) => Effect.Effect<RemoteServerConfigSummary, SessionTransferError>;
  readonly getShellSnapshot: (endpoint: BoatRemoteEndpoint) => Effect.Effect<
    {
      readonly projects: ReadonlyArray<RemoteShellProject>;
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly projectId: ProjectId;
        readonly title: string;
        readonly branch: GitRefName | null;
        readonly worktreePath: string | null;
      }>;
    },
    SessionTransferError
  >;
  readonly getThreadSummary: (
    endpoint: BoatRemoteEndpoint,
    threadId: ThreadId,
  ) => Effect.Effect<RemoteThreadSummary, SessionTransferError>;
  readonly createRemoteProject?: (
    endpoint: BoatRemoteEndpoint,
    input: { readonly name: string; readonly initGit?: boolean },
  ) => Effect.Effect<
    { readonly projectId: ProjectId; readonly workspaceRoot: string },
    SessionTransferError
  >;
  readonly prepareSource: (
    endpoint: BoatRemoteEndpoint,
    input: SessionTransferPrepareSourceInput,
  ) => Effect.Effect<SessionTransferPrepareSourceResult, SessionTransferError>;
  readonly stageImport: (
    endpoint: BoatRemoteEndpoint,
    input: SessionTransferStageImportInput,
  ) => Effect.Effect<SessionTransferStageImportResult, SessionTransferError>;
  readonly commitImport: (
    endpoint: BoatRemoteEndpoint,
    input: SessionTransferCommitImportInput,
  ) => Effect.Effect<SessionTransferCommitImportResult, SessionTransferError>;
  readonly finalizeSource: (
    endpoint: BoatRemoteEndpoint,
    input: SessionTransferFinalizeSourceInput,
  ) => Effect.Effect<SessionTransferFinalizeSourceResult, SessionTransferError>;
  readonly abort: (
    endpoint: BoatRemoteEndpoint,
    input: SessionTransferAbortInput,
  ) => Effect.Effect<SessionTransferAbortResult, SessionTransferError>;
  readonly streamHttpTransfer: (input: {
    readonly sourceUrl: string;
    readonly sourceBearerToken?: string;
    readonly targetUrl: string;
    readonly targetBearerToken?: string;
    readonly contentType?: string;
    readonly expectedSizeBytes?: number | null;
    readonly onProgress?: (bytesTransferred: number) => void;
  }) => Effect.Effect<
    { readonly bytesTransferred: number; readonly status: number },
    SessionTransferError
  >;
}

export class BoatRemoteClient extends Context.Service<BoatRemoteClient, BoatRemoteClientShape>()(
  "t3/boat/SessionTransferCoordinator/BoatRemoteClient",
) {}

const BoatDaemonProjectView = Schema.Struct({
  id: Schema.String,
  originProjectId: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.String),
  repoKey: Schema.optional(Schema.NullOr(Schema.String)),
});

const BoatDaemonMachineView = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  projects: Schema.optional(Schema.Array(BoatDaemonProjectView)),
});

const BoatDaemonStateView = Schema.Struct({
  machines: Schema.optional(Schema.Array(BoatDaemonMachineView)),
});
const decodeBoatDaemonStateView = Schema.decodeUnknownOption(BoatDaemonStateView);

function toNonEmptyTrimmed(
  value: string | null | undefined,
): typeof TrimmedNonEmptyString.Type | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? TrimmedNonEmptyString.make(trimmed) : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function nowIso(): Effect.Effect<IsoDateTime> {
  return Effect.map(DateTime.now, (now) => IsoDateTime.make(DateTime.formatIso(now)));
}

const decodePrepareSourceResult = Schema.decodeUnknownEffect(SessionTransferPrepareSourceResult);
const decodeStageImportResult = Schema.decodeUnknownEffect(SessionTransferStageImportResult);
const decodeCommitImportResult = Schema.decodeUnknownEffect(SessionTransferCommitImportResult);
const decodeFinalizeSourceResult = Schema.decodeUnknownEffect(SessionTransferFinalizeSourceResult);
const decodeAbortResult = Schema.decodeUnknownEffect(SessionTransferAbortResult);

function toSessionTransferError(
  code: SessionTransferError["code"],
  message: string,
  transferId?: SessionTransferId,
  cause?: unknown,
): SessionTransferError {
  return new SessionTransferError({
    code,
    message,
    ...(transferId !== undefined ? { transferId } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}

function extractRpcFailure(exit: unknown): {
  readonly code: SessionTransferError["code"];
  readonly message: string;
} {
  if (typeof exit === "object" && exit !== null && "cause" in exit) {
    const causes = Array.isArray(exit.cause) ? exit.cause : [exit.cause];
    for (const item of causes) {
      if (typeof item !== "object" || item === null) continue;
      const errObj =
        "error" in item && typeof item.error === "object" && item.error !== null
          ? item.error
          : "defect" in item && typeof item.defect === "object" && item.defect !== null
            ? item.defect
            : item;
      const tag = "_tag" in errObj && typeof errObj._tag === "string" ? errObj._tag : "";
      const message =
        "message" in errObj && typeof errObj.message === "string" ? errObj.message : "";
      if (tag === "SessionTransferError" && "code" in errObj && typeof errObj.code === "string") {
        return {
          code: errObj.code as SessionTransferError["code"],
          message: message || "Remote session transfer RPC failed.",
        };
      }
      if (
        tag === "RpcNotFound" ||
        message.includes("Unknown RPC") ||
        message.includes("not found") ||
        message.includes("Handler not found")
      ) {
        return {
          code: "unsupported",
          message:
            message ||
            "Remote Boat server does not support session transfer RPCs. Update the Boat machine and retry.",
        };
      }
      if (message.length > 0) {
        return { code: "internal", message };
      }
    }
  }
  return { code: "internal", message: "Remote Boat RPC failed." };
}

function makeLiveBoatRemoteClient(
  httpClientOption: Option.Option<HttpClient.HttpClient>,
): BoatRemoteClientShape {
  const requireHttpClient = (): Effect.Effect<HttpClient.HttpClient, SessionTransferError> =>
    Effect.fromOption(httpClientOption).pipe(
      Effect.mapError(() =>
        toSessionTransferError(
          "internal",
          "HttpClient service is not available for Boat communication.",
        ),
      ),
    );

  const callWsRpc = Effect.fn("BoatRemoteClient.callWsRpc")(function* <A>(
    endpoint: BoatRemoteEndpoint,
    method: string,
    payload: unknown,
  ) {
    const httpClient = yield* requireHttpClient();
    const ticketRes = yield* httpClient
      .execute(
        HttpClientRequest.post(`${endpoint.localUrl}/api/auth/websocket-ticket/rpc`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${endpoint.bearerToken}`),
        ),
      )
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError(
            "target_unavailable",
            `Boat proxy refused WebSocket ticket request: ${error.message}`,
            undefined,
            error,
          ),
        ),
      );
    if (ticketRes.status < 200 || ticketRes.status >= 300) {
      return yield* toSessionTransferError(
        "target_unavailable",
        `Boat proxy refused WebSocket ticket request (HTTP ${ticketRes.status}).`,
      );
    }
    const ticketPayload = (yield* ticketRes.json.pipe(
      Effect.mapError((error) =>
        toSessionTransferError(
          "target_unavailable",
          "Boat proxy returned an invalid WebSocket ticket response.",
          undefined,
          error,
        ),
      ),
    )) as { readonly ticket?: unknown };
    if (typeof ticketPayload.ticket !== "string" || ticketPayload.ticket.length === 0) {
      return yield* toSessionTransferError(
        "target_unavailable",
        "Boat proxy returned an invalid WebSocket ticket.",
      );
    }

    const wsBase = endpoint.localUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");
    const wsUrl = `${wsBase}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticketPayload.ticket)}`;

    return yield* Effect.callback<A, SessionTransferError>((resume) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const finish = (effect: Effect.Effect<A, SessionTransferError>) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
        resume(effect);
      };

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: method,
            payload,
            headers: [],
          }),
        );
      });

      ws.addEventListener("message", (event) => {
        try {
          const text = typeof event.data === "string" ? event.data : String(event.data);
          const parsed: unknown = JSON.parse(text);
          const frames = Array.isArray(parsed) ? parsed : [parsed];
          for (const frame of frames) {
            if (
              typeof frame === "object" &&
              frame !== null &&
              "_tag" in frame &&
              frame._tag === "Exit" &&
              "requestId" in frame &&
              String(frame.requestId) === "1" &&
              "exit" in frame &&
              typeof frame.exit === "object" &&
              frame.exit !== null
            ) {
              const exit = frame.exit as { readonly _tag?: string; readonly value?: A };
              if (exit._tag === "Success") {
                finish(Effect.succeed(exit.value as A));
                return;
              }
              const failure = extractRpcFailure(exit);
              finish(Effect.fail(toSessionTransferError(failure.code, failure.message)));
              return;
            }
          }
        } catch (error) {
          finish(
            Effect.fail(
              toSessionTransferError(
                "internal",
                `Failed to decode Boat RPC response for ${method}.`,
                undefined,
                error,
              ),
            ),
          );
        }
      });

      ws.addEventListener("error", () => {
        finish(
          Effect.fail(
            toSessionTransferError(
              "target_unavailable",
              `WebSocket error calling Boat RPC ${method}.`,
            ),
          ),
        );
      });

      ws.addEventListener("close", () => {
        finish(
          Effect.fail(
            toSessionTransferError(
              "target_unavailable",
              `Boat WebSocket closed before ${method} completed.`,
            ),
          ),
        );
      });

      return Effect.sync(() => {
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(RPC_TIMEOUT_MS),
        orElse: () =>
          Effect.fail(
            toSessionTransferError(
              "target_unavailable",
              `Timed out waiting for Boat RPC ${method}.`,
            ),
          ),
      }),
    );
  });

  const fetchJson = Effect.fn("BoatRemoteClient.fetchJson")(function* <A>(
    endpoint: BoatRemoteEndpoint,
    relativePath: string,
  ) {
    const httpClient = yield* requireHttpClient();
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(`${endpoint.localUrl}${relativePath}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${endpoint.bearerToken}`),
        ),
      )
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError(
            "target_unavailable",
            `Boat HTTP request ${relativePath} failed: ${error.message}`,
            undefined,
            error,
          ),
        ),
      );
    if (response.status === 404) {
      return yield* toSessionTransferError(
        "not_found",
        `Remote resource not found: ${relativePath}`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* toSessionTransferError(
        "target_unavailable",
        `Boat HTTP request ${relativePath} failed with HTTP ${response.status}.`,
      );
    }
    return (yield* response.json.pipe(
      Effect.mapError((error) =>
        toSessionTransferError(
          "internal",
          `Boat HTTP response ${relativePath} could not be decoded as JSON.`,
          undefined,
          error,
        ),
      ),
    )) as A;
  });

  return {
    getServerConfig: (endpoint) =>
      callWsRpc<{
        readonly environment?: { readonly environmentId?: string; readonly label?: string };
        readonly sessionTransfer?: boolean;
        readonly providers?: ReadonlyArray<ServerProvider>;
      }>(endpoint, WS_METHODS.serverGetConfig, {}).pipe(
        Effect.map((config) => ({
          environmentId: EnvironmentId.make(config.environment?.environmentId ?? "unknown"),
          ...(config.environment?.label ? { environmentLabel: config.environment.label } : {}),
          sessionTransferSupported: config.sessionTransfer === true,
          providers: config.providers ?? [],
        })),
      ),

    getShellSnapshot: (endpoint) =>
      fetchJson<{
        readonly projects?: ReadonlyArray<{
          readonly id: ProjectId;
          readonly title: string;
          readonly workspaceRoot: string;
          readonly repositoryIdentity?: RepositoryIdentity | null;
        }>;
        readonly threads?: ReadonlyArray<{
          readonly id: ThreadId;
          readonly projectId: ProjectId;
          readonly title: string;
          readonly branch?: GitRefName | null;
          readonly worktreePath?: string | null;
        }>;
      }>(endpoint, "/api/orchestration/shell").pipe(
        Effect.map((snapshot) => ({
          projects: (snapshot.projects ?? []).map((p) => ({
            id: p.id,
            title: p.title,
            workspaceRoot: p.workspaceRoot,
            ...(p.repositoryIdentity !== undefined
              ? { repositoryIdentity: p.repositoryIdentity }
              : {}),
          })),
          threads: (snapshot.threads ?? []).map((t) => ({
            id: t.id,
            projectId: t.projectId,
            title: t.title,
            branch: t.branch ?? null,
            worktreePath: t.worktreePath ?? null,
          })),
        })),
      ),

    getThreadSummary: (endpoint, threadId) =>
      fetchJson<{
        readonly thread?: {
          readonly id: ThreadId;
          readonly projectId: ProjectId;
          readonly title: string;
          readonly modelSelection: ModelSelection;
          readonly providerInstanceId?: ProviderInstanceId;
          readonly branch?: GitRefName | null;
          readonly worktreePath?: string | null;
        };
        readonly runs?: ReadonlyArray<{ readonly status?: string }>;
        readonly runtimeRequests?: ReadonlyArray<{
          readonly id: RuntimeRequestId;
          readonly kind: SessionTransferPendingRuntimeRequest["kind"];
          readonly status?: string;
          readonly createdAt: IsoDateTime;
          readonly summary?: string | null;
          readonly blocking?: boolean;
          readonly userOnly?: boolean;
        }>;
        readonly subagents?: ReadonlyArray<{ readonly status?: string }>;
      }>(endpoint, `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`).pipe(
        Effect.flatMap((snapshot) => {
          const thread = snapshot.thread;
          if (!thread) {
            return Effect.fail(
              toSessionTransferError("not_found", `Thread ${threadId} was not found on Boat.`),
            );
          }
          const runs = snapshot.runs ?? [];
          const wasRunning = runs.some(
            (run) =>
              run.status !== undefined &&
              WORKING_RUN_STATUSES.has(run.status as OrchestrationV2Run["status"]),
          );
          const heldQueuedRunCount = runs.filter((run) => run.status === "queued").length;
          const pendingRuntimeRequests: SessionTransferPendingRuntimeRequest[] = (
            snapshot.runtimeRequests ?? []
          )
            .filter((req) => req.status === "pending")
            .map((req) => ({
              id: req.id,
              kind: req.kind,
              createdAt: req.createdAt,
              ...(req.summary !== undefined ? { summary: req.summary } : {}),
              ...(req.blocking !== undefined ? { blocking: req.blocking } : {}),
              ...(req.userOnly !== undefined ? { userOnly: req.userOnly } : {}),
            }));
          const activeSubagentCount = (snapshot.subagents ?? []).filter(
            (sub) => sub.status !== undefined && ACTIVE_SUBAGENT_STATUSES.has(sub.status),
          ).length;

          return Effect.succeed<RemoteThreadSummary>({
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            modelSelection: thread.modelSelection,
            ...(thread.providerInstanceId !== undefined
              ? { providerInstanceId: thread.providerInstanceId }
              : {}),
            branch: thread.branch ?? null,
            worktreePath: thread.worktreePath ?? null,
            wasRunning,
            pendingRuntimeRequests,
            activeSubagentCount,
            heldQueuedRunCount,
            isGitRepo: true,
          });
        }),
      ),

    createRemoteProject: (endpoint, input) =>
      callWsRpc<{
        readonly projectId?: ProjectId;
        readonly workspaceRoot?: string;
        readonly project?: { readonly id: ProjectId; readonly workspaceRoot: string };
      }>(endpoint, WS_METHODS.projectsCreateNew, {
        name: input.name,
      }).pipe(
        Effect.flatMap((result) => {
          const projectId = result.projectId ?? result.project?.id;
          const workspaceRoot = result.workspaceRoot ?? result.project?.workspaceRoot;
          return projectId && workspaceRoot
            ? Effect.succeed({ projectId, workspaceRoot })
            : Effect.fail(
                toSessionTransferError("internal", "Boat did not return a created project."),
              );
        }),
      ),

    prepareSource: (endpoint, input) =>
      callWsRpc<unknown>(endpoint, WS_METHODS.sessionTransferPrepareSource, input).pipe(
        Effect.flatMap((raw) =>
          decodePrepareSourceResult(raw).pipe(
            Effect.mapError((cause) =>
              toSessionTransferError(
                "internal",
                "Failed to decode prepareSource response from Boat.",
                input.transferId,
                cause,
              ),
            ),
          ),
        ),
      ),

    stageImport: (endpoint, input) =>
      callWsRpc<unknown>(endpoint, WS_METHODS.sessionTransferStageImport, input).pipe(
        Effect.flatMap((raw) =>
          decodeStageImportResult(raw).pipe(
            Effect.mapError((cause) =>
              toSessionTransferError(
                "internal",
                "Failed to decode stageImport response from Boat.",
                input.transferId,
                cause,
              ),
            ),
          ),
        ),
      ),

    commitImport: (endpoint, input) =>
      callWsRpc<unknown>(endpoint, WS_METHODS.sessionTransferCommitImport, input).pipe(
        Effect.flatMap((raw) =>
          decodeCommitImportResult(raw).pipe(
            Effect.mapError((cause) =>
              toSessionTransferError(
                "internal",
                "Failed to decode commitImport response from Boat.",
                input.transferId,
                cause,
              ),
            ),
          ),
        ),
      ),

    finalizeSource: (endpoint, input) =>
      callWsRpc<unknown>(endpoint, WS_METHODS.sessionTransferFinalizeSource, input).pipe(
        Effect.flatMap((raw) =>
          decodeFinalizeSourceResult(raw).pipe(
            Effect.mapError((cause) =>
              toSessionTransferError(
                "internal",
                "Failed to decode finalizeSource response from Boat.",
                input.transferId,
                cause,
              ),
            ),
          ),
        ),
      ),

    abort: (endpoint, input) =>
      callWsRpc<unknown>(endpoint, WS_METHODS.sessionTransferAbort, input).pipe(
        Effect.flatMap((raw) =>
          decodeAbortResult(raw).pipe(
            Effect.mapError((cause) =>
              toSessionTransferError(
                "internal",
                "Failed to decode abort response from Boat.",
                input.transferId,
                cause,
              ),
            ),
          ),
        ),
      ),

    streamHttpTransfer: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const httpClient = yield* requireHttpClient();
          const scopedClient = HttpClient.withScope(httpClient);
          const sourceReq = HttpClientRequest.get(input.sourceUrl).pipe(
            input.sourceBearerToken !== undefined
              ? HttpClientRequest.setHeader("authorization", `Bearer ${input.sourceBearerToken}`)
              : (req) => req,
          );
          const sourceResponse = yield* scopedClient
            .execute(sourceReq)
            .pipe(
              Effect.mapError((error) =>
                toSessionTransferError(
                  "workspace_error",
                  `Failed to download transfer payload: ${error.message}`,
                  undefined,
                  error,
                ),
              ),
            );

          if (sourceResponse.status === 404) {
            return yield* toSessionTransferError(
              "not_found",
              `Transfer payload not found at source (${input.sourceUrl}).`,
            );
          }
          if (sourceResponse.status < 200 || sourceResponse.status >= 300) {
            return yield* toSessionTransferError(
              "workspace_error",
              `Failed to download transfer payload (HTTP ${sourceResponse.status}).`,
            );
          }

          let bytesTransferred = 0;
          const countedStream = sourceResponse.stream.pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => {
                bytesTransferred += chunk.byteLength;
                input.onProgress?.(bytesTransferred);
              }),
            ),
          );

          const contentType =
            input.contentType ??
            sourceResponse.headers["content-type"] ??
            "application/octet-stream";
          const headerContentLength = sourceResponse.headers["content-length"];
          const parsedHeaderLength =
            headerContentLength !== undefined && /^\d+$/.test(headerContentLength)
              ? Number(headerContentLength)
              : undefined;
          const contentLength =
            input.expectedSizeBytes !== undefined && input.expectedSizeBytes !== null
              ? input.expectedSizeBytes
              : parsedHeaderLength;

          const targetReq = HttpClientRequest.post(input.targetUrl).pipe(
            input.targetBearerToken !== undefined
              ? HttpClientRequest.setHeader("authorization", `Bearer ${input.targetBearerToken}`)
              : (req) => req,
            HttpClientRequest.bodyStream(countedStream, {
              contentType,
              ...(contentLength !== undefined ? { contentLength } : {}),
            }),
          );

          const targetResponse = yield* scopedClient
            .execute(targetReq)
            .pipe(
              Effect.mapError((error) =>
                isSessionTransferError(error)
                  ? error
                  : toSessionTransferError(
                      "workspace_error",
                      `Failed to upload transfer payload: ${error.message}`,
                      undefined,
                      error,
                    ),
              ),
            );

          if (targetResponse.status < 200 || targetResponse.status >= 300) {
            const detail = yield* targetResponse.text.pipe(Effect.orElseSucceed(() => ""));
            return yield* toSessionTransferError(
              targetResponse.status === 413 ? "bundle_too_large" : "workspace_error",
              `Failed to upload transfer payload (HTTP ${targetResponse.status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
            );
          }

          return { bytesTransferred, status: targetResponse.status };
        }),
      ),
  };
}

export interface SessionTransferCoordinatorShape {
  readonly preflight: (
    input: SessionTransferPreflightInput,
  ) => Effect.Effect<SessionTransferPreflightResult, SessionTransferError>;
  readonly start: (
    input: SessionTransferStartInput,
  ) => Effect.Effect<SessionTransferRecord, SessionTransferError>;
  readonly cancel: (
    input: SessionTransferCancelInput,
  ) => Effect.Effect<SessionTransferRecord, SessionTransferError>;
  readonly retry: (
    input: SessionTransferRetryInput,
  ) => Effect.Effect<SessionTransferRecord, SessionTransferError>;
  readonly list: (
    input: SessionTransferListInput,
  ) => Effect.Effect<SessionTransferListResult, SessionTransferError>;
  readonly subscribe: Stream.Stream<SessionTransferProgressEvent>;
  readonly reconcileOnStartup: Effect.Effect<void>;
}

export class SessionTransferCoordinator extends Context.Service<
  SessionTransferCoordinator,
  SessionTransferCoordinatorShape
>()("t3/boat/SessionTransferCoordinator") {}

interface ActiveTransferEntry {
  cancelled: boolean;
  committed: boolean;
  fiber: Fiber.Fiber<void, never> | null;
}

function collectAvailableModels(
  providers: ReadonlyArray<ServerProvider>,
): SessionTransferAvailableModel[] {
  const models: SessionTransferAvailableModel[] = [];
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) {
      continue;
    }
    for (const model of provider.models) {
      models.push({
        instanceId: provider.instanceId,
        driverKind: provider.driver,
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        model: model.slug,
        modelName: model.name,
      });
    }
  }
  return models;
}

function resolveModelSelectionOnDestination(
  desired: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  preferredDriverKind?: ProviderDriverKind,
): {
  readonly resolved: ModelSelection | null;
  readonly availableModels: ReadonlyArray<SessionTransferAvailableModel>;
  readonly needsModelSelection: boolean;
} {
  const availableModels = collectAvailableModels(providers);
  const usableProviders = providers.filter(
    (p) => p.enabled && p.installed && isProviderAvailable(p),
  );

  const modelMatches = (provider: ServerProvider, modelSlug: string): string | null => {
    const exact = provider.models.find((m) => m.slug === modelSlug);
    if (exact) return exact.slug;
    const aliased = provider.models.find((m) => m.aliases?.includes(modelSlug));
    if (aliased) return aliased.slug;
    return null;
  };

  // 1. Exact provider instance match.
  const exactProvider = usableProviders.find((p) => p.instanceId === desired.instanceId);
  if (exactProvider) {
    const matchedSlug = modelMatches(exactProvider, desired.model);
    if (matchedSlug !== null) {
      return {
        resolved: {
          ...desired,
          instanceId: exactProvider.instanceId,
          model: TrimmedNonEmptyString.make(matchedSlug),
        },
        availableModels,
        needsModelSelection: false,
      };
    }
  }

  // 2. Same driver match (e.g. different custom instance id or built-in driver).
  const targetDriver = preferredDriverKind ?? exactProvider?.driver ?? desired.instanceId;
  for (const provider of usableProviders) {
    if (provider.driver !== targetDriver) continue;
    const matchedSlug = modelMatches(provider, desired.model);
    if (matchedSlug !== null) {
      return {
        resolved: {
          ...desired,
          instanceId: provider.instanceId,
          model: TrimmedNonEmptyString.make(matchedSlug),
        },
        availableModels,
        needsModelSelection: false,
      };
    }
  }

  return {
    resolved: null,
    availableModels,
    needsModelSelection: true,
  };
}

function normalizeRepoKey(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) return null;
  return repositoryGroupingKeyOf(identity).trim().toLowerCase();
}

function repoKeysMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

const make = Effect.gen(function* () {
  const repository = yield* SessionTransferRepository.SessionTransferRepository;
  const localEndpoints = yield* SessionTransferEndpointService.SessionTransferEndpointService;
  const boatSupervisor = yield* BoatSupervisor.BoatSupervisor;
  const projectService = yield* ProjectService.ProjectService;
  const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serviceScope = yield* Effect.scope;

  const projectCloneTrackerOption = yield* Effect.serviceOption(
    ProjectCloneTracker.ProjectCloneTracker,
  );
  const boatProviderSyncOption = yield* Effect.serviceOption(BoatProviderSync.BoatProviderSync);
  const boatCredentialSyncOption = yield* Effect.serviceOption(
    BoatCredentialSync.BoatCredentialSync,
  );
  const httpServerOption = yield* Effect.serviceOption(HttpServer.HttpServer);
  const httpClientOption = yield* Effect.serviceOption(HttpClient.HttpClient);
  const vcsProcessOption = yield* Effect.serviceOption(VcsProcess.VcsProcess);
  const secureRandomOption = yield* Effect.serviceOption(SecureRandom.SecureRandom);
  const injectedRemoteClient = yield* Effect.serviceOption(BoatRemoteClient);

  const remoteClient: BoatRemoteClientShape = Option.getOrElse(injectedRemoteClient, () =>
    makeLiveBoatRemoteClient(httpClientOption),
  );

  const progressPubSub = yield* PubSub.unbounded<SessionTransferProgressEvent>();
  const activeTransfers = new Map<SessionTransferId, ActiveTransferEntry>();

  const randomHex = (byteLength: number): Effect.Effect<string> =>
    Option.match(secureRandomOption, {
      onNone: () => Effect.sync(() => bytesToHex(SecureRandom.randomBytesUnsafe(byteLength))),
      onSome: (random) => Effect.map(random.randomBytes(byteLength), bytesToHex),
    });

  const generateTransferId = (): Effect.Effect<SessionTransferId> =>
    randomHex(8).pipe(Effect.map((hex) => SessionTransferId.make(`tx-${hex}`)));

  const getLocalHttpBaseUrl = (): string => {
    if (Option.isNone(httpServerOption)) {
      return "http://127.0.0.1:0";
    }
    const address = httpServerOption.value.address;
    if (typeof address === "string" || !("port" in address)) {
      return "http://127.0.0.1:0";
    }
    return `http://${loopbackUrlHostForAddress(address)}:${address.port}`;
  };

  const publishRecord = (record: SessionTransferRecord): Effect.Effect<void> =>
    PubSub.publish(progressPubSub, { _tag: "updated", transfer: record }).pipe(Effect.asVoid);

  const getMachineProxyAccess = (input: {
    readonly machineId?: string;
    readonly environmentId?: EnvironmentId;
  }): Effect.Effect<BoatSupervisor.BoatMachineProxyAccess, SessionTransferError> => {
    const fn = boatSupervisor.getMachineProxyAccess;
    if (fn === undefined) {
      return Effect.fail(
        toSessionTransferError(
          "target_unavailable",
          "Boat supervisor does not expose machine proxy access.",
        ),
      );
    }
    return fn(input).pipe(
      Effect.mapError((error) =>
        toSessionTransferError(
          "target_unavailable",
          `Could not reach Boat machine: ${error.message}`,
          undefined,
          error,
        ),
      ),
    );
  };

  const getBoatDaemonMachineMeta = Effect.fn("SessionTransferCoordinator.getBoatDaemonMachineMeta")(
    function* (input: { readonly machineId?: string; readonly environmentId?: EnvironmentId }) {
      let rawState: unknown = undefined;
      if (boatSupervisor.currentState !== undefined) {
        const cached = yield* boatSupervisor.currentState;
        if (Option.isSome(cached)) {
          rawState = cached.value;
        }
      }
      if (rawState === undefined) {
        const fetched = yield* boatSupervisor.invoke({ command: "get_state" }).pipe(Effect.option);
        if (Option.isSome(fetched)) {
          rawState = fetched.value.data;
        }
      }
      const parsed = decodeBoatDaemonStateView(rawState);
      if (Option.isNone(parsed)) return null;
      const machines = parsed.value.machines ?? [];
      return (
        machines.find(
          (m) =>
            (input.machineId !== undefined && m.id === input.machineId) ||
            (input.environmentId !== undefined && m.environmentId === input.environmentId),
        ) ?? null
      );
    },
  );

  const listAllLocalProjects = Effect.fn("SessionTransferCoordinator.listAllLocalProjects")(
    function* () {
      const all = [];
      let cursor = 0;
      for (;;) {
        const page = yield* projectService
          .listPage({ cursor, limit: 200 })
          .pipe(
            Effect.mapError((error) =>
              toSessionTransferError("internal", error.message, undefined, error),
            ),
          );
        all.push(...page.projects);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return all;
    },
  );

  const probeLocalGitState = Effect.fn("SessionTransferCoordinator.probeLocalGitState")(function* (
    cwd: string,
  ) {
    if (Option.isSome(vcsProcessOption)) {
      const vcs = vcsProcessOption.value;
      const topLevel = yield* vcs
        .run({
          operation: "session-transfer.git-check",
          command: "git",
          cwd,
          args: ["rev-parse", "--is-inside-work-tree"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(Effect.option);
      if (Option.isNone(topLevel) || topLevel.value.exitCode !== 0) {
        return { isGitRepo: false, headSha: null, isDirty: false };
      }
      const headRes = yield* vcs
        .run({
          operation: "session-transfer.git-head",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(Effect.option);
      const statusRes = yield* vcs
        .run({
          operation: "session-transfer.git-status",
          command: "git",
          cwd,
          args: ["status", "--porcelain"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(Effect.option);
      return {
        isGitRepo: true,
        headSha:
          Option.isSome(headRes) && headRes.value.exitCode === 0
            ? toNonEmptyTrimmed(headRes.value.stdout)
            : null,
        isDirty:
          Option.isSome(statusRes) &&
          statusRes.value.exitCode === 0 &&
          statusRes.value.stdout.trim().length > 0,
      };
    }
    // Fallback when VcsProcess is not provided (e.g. unit tests): check .git presence.
    const hasGit = yield* fileSystem
      .exists(path.join(cwd, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    return { isGitRepo: hasGit, headSha: null, isDirty: false };
  });

  const transition = Effect.fn("SessionTransferCoordinator.transition")(function* (
    transferId: SessionTransferId,
    phase: SessionTransferPhase,
    fields: Omit<
      SessionTransferRepository.SessionTransferTransitionPhaseInput,
      "transferId" | "phase" | "updatedAt"
    > = {},
  ) {
    const updatedAt = yield* nowIso();
    const updated = yield* repository
      .transitionPhase({
        ...fields,
        transferId,
        phase,
        updatedAt,
      })
      .pipe(
        Effect.mapError((error) => {
          if (error._tag === "SessionTransferNotFoundError") {
            return toSessionTransferError("not_found", error.message, transferId, error);
          }
          if (error._tag === "SessionTransferInvalidPhaseError") {
            return toSessionTransferError("invalid_phase", error.message, transferId, error);
          }
          return toSessionTransferError("internal", error.message, transferId, error);
        }),
      );
    yield* publishRecord(updated);
    return updated;
  });

  const preflight: SessionTransferCoordinatorShape["preflight"] = Effect.fn(
    "SessionTransferCoordinator.preflight",
  )(function* (input) {
    const warnings: string[] = [];

    if (input.direction === "local_to_boat" && input.target.kind !== "boat") {
      return yield* toSessionTransferError(
        "unsupported",
        "local_to_boat transfer requires a Boat target.",
      );
    }
    if (input.direction === "boat_to_local" && input.target.kind !== "local") {
      return yield* toSessionTransferError(
        "unsupported",
        "boat_to_local transfer requires a local target.",
      );
    }

    const boatAccess = yield* input.target.kind === "boat"
      ? getMachineProxyAccess({
          machineId: input.target.machineId,
          ...(input.target.environmentId !== undefined
            ? { environmentId: input.target.environmentId }
            : {}),
        })
      : getMachineProxyAccess({
          environmentId: input.sourceEnvironmentId,
        });
    const boatEndpoint: BoatRemoteEndpoint = {
      localUrl: boatAccess.localUrl,
      bearerToken: boatAccess.bearerToken,
    };

    const remoteConfig = yield* remoteClient.getServerConfig(boatEndpoint);
    if (!remoteConfig.sessionTransferSupported) {
      return {
        ready: false,
        warnings: [],
        needsProjectSelection: false,
        candidateProjects: [],
        needsCloneDestination: false,
        needsModelSelection: false,
        availableModels: [],
        needsRunningConfirmation: false,
        unsupportedReason:
          "This Boat machine runs an older Sail server that does not support session transfer yet. Update the Boat machine and try again.",
      } satisfies SessionTransferPreflightResult;
    }

    const boatMachineMeta = yield* getBoatDaemonMachineMeta({
      machineId: boatAccess.machineId,
      environmentId: boatAccess.environmentId,
    });

    let sourceState: SessionTransferSourceState;
    let sourceModelSelection: ModelSelection;
    let sourceDriverKind: ProviderDriverKind | undefined;
    let unsupportedReason: string | null = null;
    let needsProjectSelection = false;
    let candidateProjects: SessionTransferCandidateProject[] = [];
    let needsCloneDestination = false;
    let resolvedTargetProjectId: ProjectId | null = null;
    let willAutoCloneProject = false;
    let destinationProviders: ReadonlyArray<ServerProvider>;

    if (input.direction === "local_to_boat") {
      const projection = yield* projectionStore
        .getThreadProjection(input.sourceThreadId)
        .pipe(
          Effect.mapError((error) =>
            toSessionTransferError(
              error._tag === "ProjectionStoreThreadNotFoundError" ? "not_found" : "internal",
              error.message,
              undefined,
              error,
            ),
          ),
        );
      const localProjectOption = yield* projectService
        .getById(projection.thread.projectId)
        .pipe(
          Effect.mapError((error) =>
            toSessionTransferError("internal", error.message, undefined, error),
          ),
        );
      if (Option.isNone(localProjectOption)) {
        return yield* toSessionTransferError(
          "not_found",
          `Source project ${projection.thread.projectId} was not found.`,
        );
      }
      const localProject = localProjectOption.value;
      const sourceCwd = projection.thread.worktreePath ?? localProject.workspaceRoot;
      const gitProbe = yield* probeLocalGitState(sourceCwd);
      const localRepoIdentity =
        localProject.repositoryIdentity ??
        (yield* repositoryIdentityResolver.resolve(localProject.workspaceRoot));

      const wasRunning = projection.runs.some((run) => WORKING_RUN_STATUSES.has(run.status));
      const heldQueuedRunCount = projection.runs.filter((run) => run.status === "queued").length;
      const pendingRuntimeRequests: SessionTransferPendingRuntimeRequest[] =
        projection.runtimeRequests
          .filter((req) => req.status === "pending")
          .map((req) => ({
            id: req.id,
            kind: req.kind,
            createdAt: IsoDateTime.make(DateTime.formatIso(req.createdAt)),
          }));
      const activeSubagentCount = projection.subagents.filter((sub) =>
        ACTIVE_SUBAGENT_STATUSES.has(sub.status),
      ).length;

      sourceState = {
        wasRunning,
        hadPendingRuntimeRequest: pendingRuntimeRequests.length > 0,
        pendingRuntimeRequests,
        heldQueuedRunCount,
        activeSubagentCount,
        branch: projection.thread.branch,
        headSha: gitProbe.headSha,
        isDirty: gitProbe.isDirty,
        isGitRepo: gitProbe.isGitRepo,
      };
      sourceModelSelection = projection.thread.modelSelection;
      const localProviders = yield* providerRegistry.getProviders;
      sourceDriverKind = localProviders.find(
        (p) => p.instanceId === sourceModelSelection.instanceId,
      )?.driver;
      destinationProviders = remoteConfig.providers;

      if (!gitProbe.isGitRepo) {
        unsupportedReason = "Only git repositories can be transferred between Local and Boat.";
      } else {
        const boatShell = yield* remoteClient.getShellSnapshot(boatEndpoint);
        const daemonProjects = boatMachineMeta?.projects ?? [];

        if (input.targetProjectId !== undefined) {
          const explicit = boatShell.projects.find((p) => p.id === input.targetProjectId);
          if (explicit) {
            resolvedTargetProjectId = explicit.id;
            candidateProjects = [
              {
                projectId: explicit.id,
                name: TrimmedNonEmptyString.make(explicit.title),
                workspaceRoot: TrimmedNonEmptyString.make(explicit.workspaceRoot),
                ...(explicit.repositoryIdentity !== undefined
                  ? { repositoryIdentity: explicit.repositoryIdentity }
                  : {}),
                matchReason: "manual",
              },
            ];
          }
        }

        if (resolvedTargetProjectId === null) {
          // 1. Match by originProjectId recorded in sail-boatd.
          const originMatches = daemonProjects
            .filter((dp) => dp.originProjectId === localProject.id)
            .map((dp) => boatShell.projects.find((bp) => bp.id === dp.id))
            .filter((bp): bp is RemoteShellProject => bp !== undefined);

          if (originMatches.length === 1 && originMatches[0]) {
            const match = originMatches[0];
            resolvedTargetProjectId = match.id;
            candidateProjects = [
              {
                projectId: match.id,
                name: TrimmedNonEmptyString.make(match.title),
                workspaceRoot: TrimmedNonEmptyString.make(match.workspaceRoot),
                ...(match.repositoryIdentity !== undefined
                  ? { repositoryIdentity: match.repositoryIdentity }
                  : {}),
                matchReason: "origin_project_id",
              },
            ];
          } else {
            // 2. Match by repositoryGroupingKeyOf.
            const localKey = normalizeRepoKey(localRepoIdentity);
            const repoMatches =
              localKey === null
                ? []
                : boatShell.projects.filter((bp) => {
                    const bpKey =
                      normalizeRepoKey(bp.repositoryIdentity) ??
                      daemonProjects.find((dp) => dp.id === bp.id)?.repoKey ??
                      null;
                    return repoKeysMatch(localKey, bpKey);
                  });

            if (repoMatches.length === 1 && repoMatches[0]) {
              const match = repoMatches[0];
              resolvedTargetProjectId = match.id;
              candidateProjects = [
                {
                  projectId: match.id,
                  name: TrimmedNonEmptyString.make(match.title),
                  workspaceRoot: TrimmedNonEmptyString.make(match.workspaceRoot),
                  ...(match.repositoryIdentity !== undefined
                    ? { repositoryIdentity: match.repositoryIdentity }
                    : {}),
                  matchReason: "repository_identity",
                },
              ];
            } else if (repoMatches.length > 1) {
              needsProjectSelection = true;
              candidateProjects = repoMatches.map((match) => ({
                projectId: match.id,
                name: TrimmedNonEmptyString.make(match.title),
                workspaceRoot: TrimmedNonEmptyString.make(match.workspaceRoot),
                ...(match.repositoryIdentity !== undefined
                  ? { repositoryIdentity: match.repositoryIdentity }
                  : {}),
                matchReason: "repository_identity",
              }));
            } else {
              // Not on Boat yet: auto-clone (if remote) or initialize fresh repo on Boat.
              willAutoCloneProject = true;
              if (localRepoIdentity) {
                warnings.push(
                  `Project "${localProject.title}" will be cloned onto ${boatAccess.machineName} automatically.`,
                );
              } else {
                warnings.push(
                  `Project "${localProject.title}" has no git remote; a fresh repository will be initialized on ${boatAccess.machineName} from the transferred workspace.`,
                );
              }
            }
          }
        }
      }
    } else {
      // boat_to_local
      const [remoteThread, boatShell, localProjects, localProviders] = yield* Effect.all([
        remoteClient.getThreadSummary(boatEndpoint, input.sourceThreadId),
        remoteClient.getShellSnapshot(boatEndpoint),
        listAllLocalProjects(),
        providerRegistry.getProviders,
      ]);
      const sourceBoatProject = boatShell.projects.find((p) => p.id === remoteThread.projectId);
      if (!sourceBoatProject) {
        return yield* toSessionTransferError(
          "not_found",
          `Source project ${remoteThread.projectId} was not found on Boat.`,
        );
      }

      sourceState = {
        wasRunning: remoteThread.wasRunning,
        hadPendingRuntimeRequest: remoteThread.pendingRuntimeRequests.length > 0,
        pendingRuntimeRequests: remoteThread.pendingRuntimeRequests,
        heldQueuedRunCount: remoteThread.heldQueuedRunCount,
        activeSubagentCount: remoteThread.activeSubagentCount,
        branch: remoteThread.branch,
        headSha: remoteThread.headSha ? toNonEmptyTrimmed(remoteThread.headSha) : null,
        isDirty: remoteThread.isDirty ?? false,
        isGitRepo: remoteThread.isGitRepo ?? true,
      };
      sourceModelSelection = remoteThread.modelSelection;
      sourceDriverKind =
        remoteThread.providerDriverKind ??
        remoteConfig.providers.find((p) => p.instanceId === sourceModelSelection.instanceId)
          ?.driver;
      destinationProviders = localProviders;

      if (!sourceState.isGitRepo) {
        unsupportedReason = "Only git repositories can be transferred between Local and Boat.";
      } else if (input.targetProjectId !== undefined) {
        const explicit = localProjects.find((p) => p.id === input.targetProjectId);
        if (explicit) {
          resolvedTargetProjectId = explicit.id;
          candidateProjects = [
            {
              projectId: explicit.id,
              name: explicit.title,
              workspaceRoot: explicit.workspaceRoot,
              ...(explicit.repositoryIdentity !== undefined
                ? { repositoryIdentity: explicit.repositoryIdentity }
                : {}),
              matchReason: "manual",
            },
          ];
        }
      }

      if (unsupportedReason === null && resolvedTargetProjectId === null) {
        const daemonProject = boatMachineMeta?.projects?.find(
          (dp) => dp.id === sourceBoatProject.id,
        );
        const originLocalProject =
          daemonProject?.originProjectId !== undefined && daemonProject.originProjectId !== null
            ? localProjects.find((lp) => lp.id === daemonProject.originProjectId)
            : undefined;

        if (originLocalProject) {
          resolvedTargetProjectId = originLocalProject.id;
          candidateProjects = [
            {
              projectId: originLocalProject.id,
              name: originLocalProject.title,
              workspaceRoot: originLocalProject.workspaceRoot,
              ...(originLocalProject.repositoryIdentity !== undefined
                ? { repositoryIdentity: originLocalProject.repositoryIdentity }
                : {}),
              matchReason: "origin_project_id",
            },
          ];
        } else {
          const remoteRepoKey =
            normalizeRepoKey(sourceBoatProject.repositoryIdentity) ??
            daemonProject?.repoKey ??
            null;
          const matchingLocal =
            remoteRepoKey === null
              ? []
              : localProjects.filter((lp) =>
                  repoKeysMatch(normalizeRepoKey(lp.repositoryIdentity), remoteRepoKey),
                );

          if (matchingLocal.length === 1 && matchingLocal[0]) {
            const match = matchingLocal[0];
            resolvedTargetProjectId = match.id;
            candidateProjects = [
              {
                projectId: match.id,
                name: match.title,
                workspaceRoot: match.workspaceRoot,
                ...(match.repositoryIdentity !== undefined
                  ? { repositoryIdentity: match.repositoryIdentity }
                  : {}),
                matchReason: "repository_identity",
              },
            ];
          } else if (matchingLocal.length > 1) {
            needsProjectSelection = true;
            candidateProjects = matchingLocal.map((match) => ({
              projectId: match.id,
              name: match.title,
              workspaceRoot: match.workspaceRoot,
              ...(match.repositoryIdentity !== undefined
                ? { repositoryIdentity: match.repositoryIdentity }
                : {}),
              matchReason: "repository_identity",
            }));
          } else {
            needsCloneDestination = true;
          }
        }
      }
    }

    let needsRunningConfirmation = false;
    if (sourceState.wasRunning) {
      needsRunningConfirmation = true;
      warnings.push("The active agent turn will be paused before transferring.");
    }
    if (sourceState.hadPendingRuntimeRequest) {
      needsRunningConfirmation = true;
      warnings.push(
        "This thread has pending approval or input requests that will not carry over automatically.",
      );
    }
    if (sourceState.activeSubagentCount > 0) {
      needsRunningConfirmation = true;
      warnings.push("This thread has active subagents; only the parent session will transfer.");
    }

    const desiredModel = input.modelSelectionOverride ?? sourceModelSelection;
    const modelResolution = resolveModelSelectionOnDestination(
      desiredModel,
      destinationProviders,
      sourceDriverKind,
    );
    if (modelResolution.needsModelSelection) {
      warnings.push(
        `Model "${desiredModel.model}" on provider "${desiredModel.instanceId}" is not available on the destination; select a replacement model.`,
      );
    }

    const ready =
      unsupportedReason === null &&
      !needsProjectSelection &&
      !needsCloneDestination &&
      !modelResolution.needsModelSelection &&
      !needsRunningConfirmation;

    return {
      ready,
      warnings,
      needsProjectSelection,
      candidateProjects,
      needsCloneDestination,
      needsModelSelection: modelResolution.needsModelSelection,
      availableModels: [...modelResolution.availableModels],
      needsRunningConfirmation,
      unsupportedReason,
      sourceState,
      resolvedTargetProjectId,
      resolvedModelSelection: modelResolution.resolved,
      willAutoCloneProject,
    } satisfies SessionTransferPreflightResult;
  });

  const ensureLocalProjectForBoatToLocal = Effect.fn(
    "SessionTransferCoordinator.ensureLocalProjectForBoatToLocal",
  )(function* (input: {
    readonly transferId: SessionTransferId;
    readonly manifest: SessionTransferPrepareSourceResult["manifest"];
    readonly explicitTargetProjectId?: ProjectId | null | undefined;
    readonly cloneDestinationPath?: string | null | undefined;
    readonly boatMachineId: string;
    readonly boatEnvironmentId: EnvironmentId;
  }) {
    if (input.explicitTargetProjectId) {
      const existing = yield* projectService
        .getById(input.explicitTargetProjectId)
        .pipe(
          Effect.mapError((error) =>
            toSessionTransferError("internal", error.message, input.transferId, error),
          ),
        );
      if (Option.isSome(existing)) {
        return existing.value.id;
      }
    }

    const localProjects = yield* listAllLocalProjects();
    const machineMeta = yield* getBoatDaemonMachineMeta({
      machineId: input.boatMachineId,
      environmentId: input.boatEnvironmentId,
    });
    const daemonProject = machineMeta?.projects?.find(
      (dp) => dp.id === input.manifest.sourceProjectId,
    );
    if (daemonProject?.originProjectId) {
      const originMatch = localProjects.find((p) => p.id === daemonProject.originProjectId);
      if (originMatch) return originMatch.id;
    }

    const remoteRepoKey =
      normalizeRepoKey(input.manifest.workspace.repositoryIdentity) ??
      daemonProject?.repoKey ??
      null;
    if (remoteRepoKey !== null) {
      const matches = localProjects.filter((lp) =>
        repoKeysMatch(normalizeRepoKey(lp.repositoryIdentity), remoteRepoKey),
      );
      if (matches.length === 1 && matches[0]) {
        return matches[0].id;
      }
      if (matches.length > 1) {
        return yield* toSessionTransferError(
          "preflight_required",
          "Multiple local checkouts match this repository; specify targetProjectId.",
          input.transferId,
        );
      }
    }

    const cloneDest = input.cloneDestinationPath?.trim();
    if (!cloneDest) {
      return yield* toSessionTransferError(
        "preflight_required",
        "No matching local project found; specify targetProjectId or cloneDestinationPath.",
        input.transferId,
      );
    }

    const existingByRoot = yield* projectService
      .getByWorkspaceRoot(cloneDest)
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError("internal", error.message, input.transferId, error),
        ),
      );
    if (Option.isSome(existingByRoot)) {
      return existingByRoot.value.id;
    }

    const projectTitle =
      input.manifest.sourceProjectName ??
      toNonEmptyTrimmed(path.basename(cloneDest)) ??
      TrimmedNonEmptyString.make("Transferred Project");
    const newProjectId = ProjectId.make(`proj-${yield* randomHex(6)}`);
    const createdAt = yield* nowIso();

    const repoIdentity = input.manifest.workspace.repositoryIdentity;
    const remoteUrl = repoIdentity?.locator.remoteUrl ?? null;

    if (remoteUrl !== null && Option.isSome(projectCloneTrackerOption)) {
      const tracker = projectCloneTrackerOption.value;
      yield* tracker
        .start(
          {
            projectId: newProjectId,
            title: projectTitle,
            createdAt,
            destinationPath: TrimmedNonEmptyString.make(cloneDest),
            remoteUrl: TrimmedNonEmptyString.make(remoteUrl),
            protocol: "https",
          },
          {
            createProject: (project) =>
              projectService
                .create({
                  commandId: CommandId.make(`session-transfer-clone:${project.projectId}`),
                  projectId: project.projectId,
                  title: project.title,
                  workspaceRoot: project.workspaceRoot,
                  createWorkspaceRootIfMissing: true,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError((cause) =>
                    cause._tag === "ProjectConflictError"
                      ? cause
                      : toSessionTransferError(
                          "workspace_error",
                          cause.message,
                          input.transferId,
                          cause,
                        ),
                  ),
                ) as never,
            onCloned: () => Effect.void,
          },
        )
        .pipe(
          Effect.mapError((error) =>
            toSessionTransferError(
              "workspace_error",
              `Failed to clone repository to ${cloneDest}: ${error.message}`,
              input.transferId,
              error,
            ),
          ),
        );

      const startedAtMs = yield* Clock.currentTimeMillis;
      const deadlineMs = startedAtMs + CLONE_WAIT_TIMEOUT_MS;
      for (;;) {
        const snapshot = yield* tracker.get(newProjectId);
        if (!snapshot || snapshot.phase === "done") {
          return newProjectId;
        }
        if (snapshot.phase === "failed" || snapshot.phase === "cancelled") {
          return yield* toSessionTransferError(
            "workspace_error",
            snapshot.error ?? `Clone to ${cloneDest} ${snapshot.phase}.`,
            input.transferId,
          );
        }
        const nowMs = yield* Clock.currentTimeMillis;
        if (nowMs >= deadlineMs) {
          return yield* toSessionTransferError(
            "workspace_error",
            `Timed out waiting for clone into ${cloneDest}.`,
            input.transferId,
          );
        }
        yield* Effect.sleep(CLONE_POLL_INTERVAL);
      }
    }

    // Remote-less repository or no clone tracker: create directory, git init, and register local project.
    yield* fileSystem
      .makeDirectory(cloneDest, { recursive: true })
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError(
            "workspace_error",
            `Failed to create local directory ${cloneDest}: ${error.message}`,
            input.transferId,
            error,
          ),
        ),
      );
    if (Option.isSome(vcsProcessOption)) {
      yield* vcsProcessOption.value
        .run({
          operation: "session-transfer.git-init",
          command: "git",
          cwd: cloneDest,
          args: ["init"],
          allowNonZeroExit: true,
          timeoutMs: 15_000,
        })
        .pipe(Effect.ignore);
    }
    const created = yield* projectService
      .create({
        commandId: CommandId.make(`session-transfer-create:${newProjectId}`),
        projectId: newProjectId,
        title: projectTitle,
        workspaceRoot: cloneDest,
        createWorkspaceRootIfMissing: true,
      })
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError("workspace_error", error.message, input.transferId, error),
        ),
      );
    return created.id;
  });

  const ensureBoatProjectForLocalToBoat = Effect.fn(
    "SessionTransferCoordinator.ensureBoatProjectForLocalToBoat",
  )(function* (input: {
    readonly transferId: SessionTransferId;
    readonly manifest: SessionTransferPrepareSourceResult["manifest"];
    readonly explicitTargetProjectId?: ProjectId | null | undefined;
    readonly boatAccess: BoatSupervisor.BoatMachineProxyAccess;
    readonly boatEndpoint: BoatRemoteEndpoint;
  }) {
    const boatShell = yield* remoteClient.getShellSnapshot(input.boatEndpoint);
    if (input.explicitTargetProjectId) {
      const match = boatShell.projects.find((p) => p.id === input.explicitTargetProjectId);
      if (match) return match.id;
    }

    const machineMeta = yield* getBoatDaemonMachineMeta({
      machineId: input.boatAccess.machineId,
      environmentId: input.boatAccess.environmentId,
    });
    const daemonProjects = machineMeta?.projects ?? [];

    const byOrigin = daemonProjects.find(
      (dp) => dp.originProjectId === input.manifest.sourceProjectId,
    );
    if (byOrigin) {
      const match = boatShell.projects.find((p) => p.id === byOrigin.id);
      if (match) return match.id;
    }

    const localKey = normalizeRepoKey(input.manifest.workspace.repositoryIdentity);
    if (localKey !== null) {
      const matches = boatShell.projects.filter((bp) => {
        const bpKey =
          normalizeRepoKey(bp.repositoryIdentity) ??
          daemonProjects.find((dp) => dp.id === bp.id)?.repoKey ??
          null;
        return repoKeysMatch(localKey, bpKey);
      });
      if (matches.length === 1 && matches[0]) {
        return matches[0].id;
      }
    }

    // Project is missing on Boat: clone via sail-boatd `add_project` if remote exists, else init fresh project.
    if (localKey !== null) {
      yield* boatSupervisor
        .invoke({
          command: "add_project",
          args: {
            id: input.boatAccess.machineId,
            projectId: input.manifest.sourceProjectId,
          },
        })
        .pipe(
          Effect.mapError((error) =>
            toSessionTransferError(
              "workspace_error",
              `Failed to clone project onto Boat: ${error.message}`,
              input.transferId,
              error,
            ),
          ),
        );

      if (Option.isSome(boatCredentialSyncOption)) {
        yield* boatCredentialSyncOption.value
          .syncProject(input.manifest.sourceProjectId)
          .pipe(Effect.ignore);
      }

      const refreshedShell = yield* remoteClient.getShellSnapshot(input.boatEndpoint);
      const refreshedMeta = yield* getBoatDaemonMachineMeta({
        machineId: input.boatAccess.machineId,
        environmentId: input.boatAccess.environmentId,
      });
      const refreshedOrigin = refreshedMeta?.projects?.find(
        (dp) => dp.originProjectId === input.manifest.sourceProjectId,
      );
      if (refreshedOrigin) {
        const found = refreshedShell.projects.find((p) => p.id === refreshedOrigin.id);
        if (found) return found.id;
      }
      const foundByRepo = refreshedShell.projects.find((bp) =>
        repoKeysMatch(normalizeRepoKey(bp.repositoryIdentity), localKey),
      );
      if (foundByRepo) return foundByRepo.id;
      const foundByTitle = refreshedShell.projects.find(
        (bp) => bp.title === input.manifest.sourceProjectName,
      );
      if (foundByTitle) return foundByTitle.id;
    }

    if (remoteClient.createRemoteProject !== undefined) {
      const created = yield* remoteClient.createRemoteProject(input.boatEndpoint, {
        name: input.manifest.sourceProjectName ?? "transferred-project",
        initGit: true,
      });
      return created.projectId;
    }

    return yield* toSessionTransferError(
      "workspace_error",
      `Could not locate or create target project on Boat machine ${input.boatAccess.machineName}.`,
      input.transferId,
    );
  });

  const executeTransfer = Effect.fn("SessionTransferCoordinator.executeTransfer")(
    function* (params: {
      readonly transferId: SessionTransferId;
      readonly direction: SessionTransferDirection;
      readonly sourceEnvironmentId: EnvironmentId;
      readonly sourceThreadId: ThreadId;
      readonly targetMachineId?: string | undefined;
      readonly targetEnvironmentId?: EnvironmentId | undefined;
      readonly targetProjectId?: ProjectId | null | undefined;
      readonly cloneDestinationPath?: string | null | undefined;
      readonly modelSelectionOverride?: ModelSelection | null | undefined;
      readonly autoResume: boolean;
      readonly entry: ActiveTransferEntry;
    }) {
      const { transferId, direction, entry } = params;
      const warnings: string[] = [];

      let boatAccess: BoatSupervisor.BoatMachineProxyAccess | null = null;
      let boatEndpoint: BoatRemoteEndpoint | null = null;
      let sourcePrepared = false;
      let destinationStaged = false;

      const checkCancelled = (): Effect.Effect<void, SessionTransferError> =>
        entry.cancelled
          ? Effect.fail(toSessionTransferError("cancelled", "Transfer cancelled.", transferId))
          : Effect.void;

      const cleanupBeforeCommit = Effect.fn("SessionTransferCoordinator.cleanupBeforeCommit")(
        function* (reason: string) {
          if (entry.committed) return;
          if (destinationStaged) {
            const abortInput: SessionTransferAbortInput = {
              transferId,
              role: "destination",
              reason,
            };
            yield* (
              direction === "local_to_boat" && boatEndpoint !== null
                ? remoteClient.abort(boatEndpoint, abortInput)
                : localEndpoints.abort(abortInput)
            ).pipe(Effect.ignore);
          }
          if (sourcePrepared) {
            const abortInput: SessionTransferAbortInput = {
              transferId,
              role: "source",
              threadId: params.sourceThreadId,
              reason,
            };
            yield* (
              direction === "local_to_boat"
                ? localEndpoints.abort(abortInput)
                : boatEndpoint !== null
                  ? remoteClient.abort(boatEndpoint, abortInput)
                  : Effect.void
            ).pipe(Effect.ignore);
          }
        },
      );

      const run = Effect.gen(function* () {
        yield* checkCancelled();
        const localEnv = yield* serverEnvironment.getDescriptor;

        // Step 1: Resolve Boat access & wake machine if sleeping.
        boatAccess = yield* direction === "local_to_boat"
          ? getMachineProxyAccess({
              ...(params.targetMachineId !== undefined
                ? { machineId: params.targetMachineId }
                : {}),
              ...(params.targetEnvironmentId !== undefined
                ? { environmentId: params.targetEnvironmentId }
                : {}),
            })
          : getMachineProxyAccess({
              environmentId: params.sourceEnvironmentId,
            });
        boatEndpoint = {
          localUrl: boatAccess.localUrl,
          bearerToken: boatAccess.bearerToken,
        };

        if (!RUNNING_BOAT_STATES.has(boatAccess.state)) {
          yield* transition(transferId, "waking_target", {
            phaseDetail: `Waking ${boatAccess.machineName}...`,
            ...(direction === "local_to_boat"
              ? {
                  destinationEnvironmentId: boatAccess.environmentId,
                  destinationEnvironmentName: toNonEmptyTrimmed(boatAccess.machineName),
                  destinationMachineId: toNonEmptyTrimmed(boatAccess.machineId),
                }
              : {}),
          });
          yield* boatSupervisor
            .invoke({
              command: "wake_machine",
              args: { id: boatAccess.machineId },
            })
            .pipe(
              Effect.mapError((error) =>
                toSessionTransferError(
                  "target_unavailable",
                  `Failed to wake Boat machine ${boatAccess?.machineName ?? ""}: ${error.message}`,
                  transferId,
                  error,
                ),
              ),
            );
          boatAccess = yield* getMachineProxyAccess({ machineId: boatAccess.machineId });
          boatEndpoint = {
            localUrl: boatAccess.localUrl,
            bearerToken: boatAccess.bearerToken,
          };
        }

        if (direction === "local_to_boat" && Option.isSome(boatProviderSyncOption)) {
          yield* boatProviderSyncOption.value.syncAllRunning.pipe(Effect.ignore);
        }

        yield* checkCancelled();

        // Step 2: Pause & export source thread.
        yield* transition(transferId, "pausing_source", {
          phaseDetail: "Pausing active work on source thread...",
        });
        yield* transition(transferId, "exporting_source", {
          phaseDetail: "Exporting thread history and workspace bundle...",
        });

        const prepareInput: SessionTransferPrepareSourceInput = {
          transferId,
          direction,
          threadId: params.sourceThreadId,
          targetEnvironmentId:
            direction === "local_to_boat" ? boatAccess.environmentId : localEnv.environmentId,
          targetMachineId:
            direction === "local_to_boat" ? toNonEmptyTrimmed(boatAccess.machineId) : null,
          targetMachineName:
            direction === "local_to_boat" ? toNonEmptyTrimmed(boatAccess.machineName) : null,
        };

        const prepared = yield* direction === "local_to_boat"
          ? localEndpoints.prepareSource(prepareInput)
          : remoteClient.prepareSource(boatEndpoint, prepareInput);
        sourcePrepared = true;
        warnings.push(...prepared.manifest.workspace.warnings);

        yield* checkCancelled();

        // Step 3: Prepare destination project (auto-clone on Boat or clone/resolve locally).
        yield* transition(transferId, "preparing_target_project", {
          phaseDetail: "Preparing target project...",
          sourceWasRunning: prepared.manifest.sourceState.wasRunning,
          hadPendingRuntimeRequest: prepared.manifest.sourceState.hadPendingRuntimeRequest,
          destinationEnvironmentId:
            direction === "local_to_boat" ? boatAccess.environmentId : localEnv.environmentId,
          destinationEnvironmentName:
            direction === "local_to_boat"
              ? toNonEmptyTrimmed(boatAccess.machineName)
              : toNonEmptyTrimmed(localEnv.label),
          destinationMachineId:
            direction === "local_to_boat" ? toNonEmptyTrimmed(boatAccess.machineId) : null,
          warnings: [...warnings],
        });

        const destinationProjectId = yield* direction === "local_to_boat"
          ? ensureBoatProjectForLocalToBoat({
              transferId,
              manifest: prepared.manifest,
              explicitTargetProjectId: params.targetProjectId,
              boatAccess,
              boatEndpoint,
            })
          : ensureLocalProjectForBoatToLocal({
              transferId,
              manifest: prepared.manifest,
              explicitTargetProjectId: params.targetProjectId,
              cloneDestinationPath: params.cloneDestinationPath,
              boatMachineId: boatAccess.machineId,
              boatEnvironmentId: boatAccess.environmentId,
            });

        yield* checkCancelled();

        // Step 4: Stage import & stream workspace bundle.
        yield* transition(transferId, "transferring_workspace", {
          phaseDetail: "Staging workspace import...",
          destinationProjectId,
        });

        const stageInput: SessionTransferStageImportInput = {
          transferId,
          manifest: prepared.manifest,
          targetProjectId: destinationProjectId,
          ...(params.modelSelectionOverride != null
            ? { modelSelectionOverride: params.modelSelectionOverride }
            : {}),
        };

        const staged = yield* direction === "local_to_boat"
          ? remoteClient.stageImport(boatEndpoint, stageInput)
          : localEndpoints.stageImport(stageInput);
        destinationStaged = true;
        warnings.push(...staged.warnings);

        const localBaseUrl = getLocalHttpBaseUrl();
        const sourceBaseUrl = direction === "local_to_boat" ? localBaseUrl : boatAccess.localUrl;
        const targetBaseUrl = direction === "local_to_boat" ? boatAccess.localUrl : localBaseUrl;
        const sourceBearer = direction === "boat_to_local" ? boatAccess.bearerToken : undefined;
        const targetBearer = direction === "local_to_boat" ? boatAccess.bearerToken : undefined;

        const keepAwakeFiber = yield* Effect.forkIn(
          Effect.gen(function* () {
            for (;;) {
              yield* Effect.sleep(KEEP_AWAKE_PING_INTERVAL);
              if (entry.cancelled || boatAccess === null) return;
              yield* boatSupervisor
                .invoke({
                  command: "keep_awake",
                  args: { id: boatAccess.machineId, minutes: KEEP_AWAKE_WINDOW_MINUTES },
                })
                .pipe(Effect.ignore);
            }
          }),
          serviceScope,
        );

        yield* Effect.ensuring(
          Effect.gen(function* () {
            if (
              prepared.bundleDownloadRelativeUrl !== null &&
              staged.bundleUploadRelativeUrl !== null
            ) {
              yield* transition(transferId, "transferring_workspace", {
                phaseDetail: "Streaming workspace bundle...",
                destinationThreadId: staged.destinationThreadId,
                destinationBranch: staged.destinationBranch,
                destinationWorktreePath: staged.destinationWorktreePath,
              });
              yield* remoteClient.streamHttpTransfer({
                sourceUrl: `${sourceBaseUrl}${prepared.bundleDownloadRelativeUrl}`,
                ...(sourceBearer !== undefined ? { sourceBearerToken: sourceBearer } : {}),
                targetUrl: `${targetBaseUrl}${staged.bundleUploadRelativeUrl}`,
                ...(targetBearer !== undefined ? { targetBearerToken: targetBearer } : {}),
                contentType: "application/octet-stream",
                expectedSizeBytes: prepared.manifest.workspace.bundleSizeBytes,
              });
            }

            yield* checkCancelled();

            // Step 5: Stream attachments (missing source attachment -> warn & skip stub).
            const attachmentIdMap: Record<ChatAttachmentId, ChatAttachmentId> = {};
            if (staged.attachmentUploads.length > 0) {
              yield* transition(transferId, "transferring_attachments", {
                phaseDetail: `Transferring ${staged.attachmentUploads.length} attachment(s)...`,
              });
              for (const uploadTarget of staged.attachmentUploads) {
                yield* checkCancelled();
                const sourceRef = prepared.manifest.attachments.find(
                  (att) => att.attachmentId === uploadTarget.sourceAttachmentId,
                );
                if (!sourceRef?.downloadRelativeUrl) {
                  const warn = `Attachment "${sourceRef?.name ?? uploadTarget.sourceAttachmentId}" is missing a source download URL and was replaced with a stub.`;
                  warnings.push(warn);
                  yield* Effect.logWarning(warn, { transferId });
                  continue;
                }
                const transferResult = yield* remoteClient
                  .streamHttpTransfer({
                    sourceUrl: `${sourceBaseUrl}${sourceRef.downloadRelativeUrl}`,
                    ...(sourceBearer !== undefined ? { sourceBearerToken: sourceBearer } : {}),
                    targetUrl: `${targetBaseUrl}${uploadTarget.uploadRelativeUrl}`,
                    ...(targetBearer !== undefined ? { targetBearerToken: targetBearer } : {}),
                    contentType: sourceRef.mimeType,
                    expectedSizeBytes: sourceRef.sizeBytes,
                  })
                  .pipe(
                    Effect.map(() => ({ transferred: true as const })),
                    Effect.catch((error) => {
                      if (error.code === "not_found") {
                        const warn = `Attachment "${sourceRef.name}" was missing on source and replaced with a stub.`;
                        warnings.push(warn);
                        return Effect.logWarning(warn, {
                          transferId,
                          attachmentId: sourceRef.attachmentId,
                        }).pipe(Effect.as({ transferred: false as const }));
                      }
                      return Effect.fail(error);
                    }),
                  );
                if (transferResult.transferred) {
                  attachmentIdMap[uploadTarget.sourceAttachmentId] =
                    uploadTarget.destinationAttachmentId;
                }
              }
            }

            yield* checkCancelled();

            // Step 6: Commit & optionally resume on destination.
            entry.committed = true;
            yield* transition(transferId, "committing_target", {
              phaseDetail: "Importing workspace and history on destination...",
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              destinationBranch: staged.destinationBranch,
              destinationWorktreePath: staged.destinationWorktreePath,
              warnings: [...warnings],
            });

            const commitInput: SessionTransferCommitImportInput = {
              transferId,
              manifest: prepared.manifest,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              ...(params.modelSelectionOverride != null
                ? { modelSelectionOverride: params.modelSelectionOverride }
                : {}),
              autoResume: params.autoResume,
              attachmentIdMap,
            };
            const committed = yield* direction === "local_to_boat"
              ? remoteClient.commitImport(boatEndpoint!, commitInput)
              : localEndpoints.commitImport(commitInput);
            warnings.push(...committed.warnings);

            if (committed.resumed) {
              yield* transition(transferId, "resuming_target", {
                phaseDetail: "Resuming session on destination...",
                destinationProjectId: committed.destinationProjectId,
                destinationThreadId: committed.destinationThreadId,
                destinationBranch: committed.destinationBranch,
                destinationWorktreePath: committed.destinationWorktreePath,
                warnings: [...warnings],
              });
            }

            // Step 7: Finalize source (archive with transfer destination pointer) & complete.
            const destinationEnvId =
              direction === "local_to_boat" ? boatAccess!.environmentId : localEnv.environmentId;
            const destinationEnvName =
              direction === "local_to_boat"
                ? toNonEmptyTrimmed(boatAccess!.machineName)
                : toNonEmptyTrimmed(localEnv.label);
            const destinationMachId =
              direction === "local_to_boat" ? toNonEmptyTrimmed(boatAccess!.machineId) : null;

            yield* transition(transferId, "finalizing_source", {
              phaseDetail: "Archiving source thread...",
              destinationEnvironmentId: destinationEnvId,
              destinationEnvironmentName: destinationEnvName,
              destinationMachineId: destinationMachId,
              destinationProjectId: committed.destinationProjectId,
              destinationThreadId: committed.destinationThreadId,
              destinationBranch: committed.destinationBranch,
              destinationWorktreePath: committed.destinationWorktreePath,
              warnings: [...warnings],
            });

            const finalizedAt = yield* nowIso();
            const finalizeInput: SessionTransferFinalizeSourceInput = {
              transferId,
              threadId: params.sourceThreadId,
              destination: {
                transferId,
                environmentId: destinationEnvId,
                environmentName: destinationEnvName,
                machineId: destinationMachId,
                projectId: committed.destinationProjectId,
                threadId: committed.destinationThreadId,
                transferredAt: finalizedAt,
              },
            };
            yield* direction === "local_to_boat"
              ? localEndpoints.finalizeSource(finalizeInput)
              : remoteClient.finalizeSource(boatEndpoint!, finalizeInput);

            const completedAt = yield* nowIso();
            yield* transition(transferId, "completed", {
              phaseDetail: null,
              errorMessage: null,
              warnings: [...warnings],
              completedAt,
            });
          }),
          Fiber.interrupt(keepAwakeFiber).pipe(Effect.ignore),
        );
      });

      yield* run.pipe(
        Effect.catch((error) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const cancelled = !entry.committed && (entry.cancelled || error.code === "cancelled");
              yield* cleanupBeforeCommit(cancelled ? "Transfer cancelled" : error.message);
              const completedAt = yield* nowIso();
              yield* transition(transferId, cancelled ? "cancelled" : "failed", {
                phaseDetail: null,
                errorMessage: cancelled ? null : error.message,
                warnings: [...warnings],
                completedAt,
              }).pipe(Effect.ignore);
            }),
          ),
        ),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            if (entry.committed) return;
            yield* cleanupBeforeCommit("Transfer cancelled");
            const completedAt = yield* nowIso();
            yield* transition(transferId, "cancelled", {
              phaseDetail: null,
              errorMessage: null,
              warnings: [...warnings],
              completedAt,
            }).pipe(Effect.ignore);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            activeTransfers.delete(transferId);
          }),
        ),
      );
    },
  );

  const start: SessionTransferCoordinatorShape["start"] = Effect.fn(
    "SessionTransferCoordinator.start",
  )(function* (input) {
    if (input.direction === "local_to_boat" && input.target.kind !== "boat") {
      return yield* toSessionTransferError(
        "unsupported",
        "local_to_boat transfer requires a Boat target.",
      );
    }
    if (input.direction === "boat_to_local" && input.target.kind !== "local") {
      return yield* toSessionTransferError(
        "unsupported",
        "boat_to_local transfer requires a local target.",
      );
    }

    const transferId = input.transferId ?? (yield* generateTransferId());

    // Idempotent retry by transferId.
    const existingById = yield* repository
      .getById(transferId)
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError("internal", error.message, transferId, error),
        ),
      );
    if (Option.isSome(existingById)) {
      return existingById.value;
    }

    // Reject duplicate in-flight transfer for the same source thread.
    const existingForThread = yield* repository
      .findInFlightForThread({
        sourceEnvironmentId: input.sourceEnvironmentId,
        sourceThreadId: input.sourceThreadId,
      })
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError("internal", error.message, transferId, error),
        ),
      );
    if (Option.isSome(existingForThread)) {
      return yield* toSessionTransferError(
        "already_in_flight",
        `A session transfer (${existingForThread.value.transferId}) is already in progress for this thread.`,
        existingForThread.value.transferId,
      );
    }

    const localEnv = yield* serverEnvironment.getDescriptor;

    // Resolve initial source projectId & environment names for the durable record.
    let sourceProjectId: ProjectId;
    let sourceEnvironmentName: typeof TrimmedNonEmptyString.Type | null;
    let sourceMachineId: typeof TrimmedNonEmptyString.Type | null = null;
    let destinationEnvironmentId: EnvironmentId | null = null;
    let destinationEnvironmentName: typeof TrimmedNonEmptyString.Type | null = null;
    let destinationMachineId: typeof TrimmedNonEmptyString.Type | null = null;

    if (input.direction === "local_to_boat" && input.target.kind === "boat") {
      const thread = yield* projectionStore
        .getThread(input.sourceThreadId)
        .pipe(
          Effect.mapError((error) =>
            toSessionTransferError(
              error._tag === "ProjectionStoreThreadNotFoundError" ? "not_found" : "internal",
              error.message,
              transferId,
              error,
            ),
          ),
        );
      sourceProjectId = thread.projectId;
      sourceEnvironmentName = toNonEmptyTrimmed(localEnv.label);
      destinationMachineId = toNonEmptyTrimmed(input.target.machineId);
      destinationEnvironmentId = input.target.environmentId ?? null;
      destinationEnvironmentName = input.target.machineName ?? null;
    } else {
      const boatAccess = yield* getMachineProxyAccess({
        environmentId: input.sourceEnvironmentId,
      });
      const boatEndpoint: BoatRemoteEndpoint = {
        localUrl: boatAccess.localUrl,
        bearerToken: boatAccess.bearerToken,
      };
      const shell = yield* remoteClient.getShellSnapshot(boatEndpoint).pipe(Effect.option);
      const threadShell = Option.isSome(shell)
        ? shell.value.threads.find((t) => t.id === input.sourceThreadId)
        : undefined;
      sourceProjectId = threadShell?.projectId ?? ProjectId.make("unknown");
      sourceEnvironmentName = toNonEmptyTrimmed(boatAccess.machineName);
      sourceMachineId = toNonEmptyTrimmed(boatAccess.machineId);
      destinationEnvironmentId = localEnv.environmentId;
      destinationEnvironmentName = toNonEmptyTrimmed(localEnv.label);
    }

    const createdAt = yield* nowIso();
    const initialRecord: SessionTransferRecord = {
      transferId,
      direction: input.direction,
      sourceEnvironmentId: input.sourceEnvironmentId,
      sourceEnvironmentName,
      sourceMachineId,
      sourceProjectId,
      sourceThreadId: input.sourceThreadId,
      destinationEnvironmentId,
      destinationEnvironmentName,
      destinationMachineId,
      destinationProjectId: input.targetProjectId ?? null,
      destinationThreadId: null,
      phase: "queued",
      phaseDetail: "Queued transfer...",
      sourceWasRunning: false,
      autoResume: input.autoResume ?? true,
      hadPendingRuntimeRequest: false,
      destinationBranch: null,
      destinationWorktreePath: null,
      modelSelectionOverride: input.modelSelectionOverride ?? null,
      cloneDestinationPath: input.cloneDestinationPath ?? null,
      warnings: [],
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };

    const persisted = yield* repository
      .upsert(initialRecord)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SessionTransferConflictError"
            ? toSessionTransferError("already_in_flight", error.message, transferId, error)
            : toSessionTransferError("internal", error.message, transferId, error),
        ),
      );
    yield* publishRecord(persisted);

    const entry: ActiveTransferEntry = {
      cancelled: false,
      committed: false,
      fiber: null,
    };
    activeTransfers.set(transferId, entry);

    const fiber = yield* Effect.forkIn(
      executeTransfer({
        transferId,
        direction: input.direction,
        sourceEnvironmentId: input.sourceEnvironmentId,
        sourceThreadId: input.sourceThreadId,
        ...(input.target.kind === "boat"
          ? {
              targetMachineId: input.target.machineId,
              ...(input.target.environmentId !== undefined
                ? { targetEnvironmentId: input.target.environmentId }
                : {}),
            }
          : {}),
        targetProjectId: input.targetProjectId ?? null,
        cloneDestinationPath: input.cloneDestinationPath ?? null,
        modelSelectionOverride: input.modelSelectionOverride ?? null,
        autoResume: input.autoResume ?? true,
        entry,
      }),
      serviceScope,
    );
    entry.fiber = fiber;

    return persisted;
  });

  const cancel: SessionTransferCoordinatorShape["cancel"] = Effect.fn(
    "SessionTransferCoordinator.cancel",
  )(function* (input) {
    const existingOption = yield* repository
      .getById(input.transferId)
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError("internal", error.message, input.transferId, error),
        ),
      );
    if (Option.isNone(existingOption)) {
      return yield* toSessionTransferError(
        "not_found",
        `Session transfer ${input.transferId} does not exist.`,
        input.transferId,
      );
    }
    const existing = existingOption.value;
    if (existing.phase === "cancelled") {
      return existing;
    }
    if (
      existing.phase === "completed" ||
      existing.phase === "committing_target" ||
      existing.phase === "resuming_target" ||
      existing.phase === "finalizing_source"
    ) {
      return yield* toSessionTransferError(
        "invalid_phase",
        `Cannot cancel session transfer ${input.transferId} in phase ${existing.phase}.`,
        input.transferId,
      );
    }
    if (isTerminalSessionTransferPhase(existing.phase)) {
      return existing;
    }

    const active = activeTransfers.get(input.transferId);
    if (active) {
      if (active.committed) {
        return yield* toSessionTransferError(
          "invalid_phase",
          `Session transfer ${input.transferId} has already committed and cannot be cancelled.`,
          input.transferId,
        );
      }
      active.cancelled = true;
      if (active.fiber) {
        yield* Fiber.interrupt(active.fiber).pipe(
          Effect.timeout(Duration.seconds(5)),
          Effect.ignore,
        );
      }
      const afterAbort = yield* repository
        .getById(input.transferId)
        .pipe(Effect.orElseSucceed(() => Option.none<SessionTransferRecord>()));
      if (Option.isSome(afterAbort) && afterAbort.value.phase === "cancelled") {
        return afterAbort.value;
      }
    }

    // Best-effort abort local side if no active fiber handled it.
    yield* localEndpoints
      .abort({
        transferId: input.transferId,
        role: existing.direction === "local_to_boat" ? "source" : "destination",
        threadId: existing.sourceThreadId,
        reason: "Cancelled by user",
      })
      .pipe(Effect.ignore);

    const completedAt = yield* nowIso();
    return yield* transition(input.transferId, "cancelled", {
      phaseDetail: null,
      errorMessage: null,
      completedAt,
    });
  });

  const retry: SessionTransferCoordinatorShape["retry"] = Effect.fn(
    "SessionTransferCoordinator.retry",
  )(function* (input) {
    const existingOption = yield* repository
      .getById(input.transferId)
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError("internal", error.message, input.transferId, error),
        ),
      );
    if (Option.isNone(existingOption)) {
      return yield* toSessionTransferError(
        "not_found",
        `Session transfer ${input.transferId} does not exist.`,
        input.transferId,
      );
    }
    const existing = existingOption.value;
    if (existing.phase !== "failed" && existing.phase !== "cancelled") {
      return yield* toSessionTransferError(
        "invalid_phase",
        `Only failed or cancelled transfers can be retried (current phase: ${existing.phase}).`,
        input.transferId,
      );
    }

    const inFlight = yield* repository
      .findInFlightForThread({
        sourceEnvironmentId: existing.sourceEnvironmentId,
        sourceThreadId: existing.sourceThreadId,
      })
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError("internal", error.message, input.transferId, error),
        ),
      );
    if (Option.isSome(inFlight)) {
      return yield* toSessionTransferError(
        "already_in_flight",
        `Another transfer (${inFlight.value.transferId}) is already in progress for this thread.`,
        inFlight.value.transferId,
      );
    }

    const nextTargetProjectId = input.targetProjectId ?? existing.destinationProjectId;
    const nextModelOverride =
      input.modelSelectionOverride !== undefined
        ? input.modelSelectionOverride
        : existing.modelSelectionOverride;
    const nextCloneDestinationPath =
      input.cloneDestinationPath !== undefined
        ? input.cloneDestinationPath
        : existing.cloneDestinationPath;
    const nextAutoResume = input.autoResume ?? existing.autoResume;

    const reset = yield* transition(input.transferId, "queued", {
      expectedPhases: ["failed", "cancelled"],
      phaseDetail: "Retrying transfer...",
      errorMessage: null,
      completedAt: null,
      destinationProjectId: nextTargetProjectId,
      modelSelectionOverride: nextModelOverride,
      cloneDestinationPath: nextCloneDestinationPath,
      autoResume: nextAutoResume,
      warnings: [],
    });

    const entry: ActiveTransferEntry = {
      cancelled: false,
      committed: false,
      fiber: null,
    };
    activeTransfers.set(input.transferId, entry);

    const fiber = yield* Effect.forkIn(
      executeTransfer({
        transferId: input.transferId,
        direction: existing.direction,
        sourceEnvironmentId: existing.sourceEnvironmentId,
        sourceThreadId: existing.sourceThreadId,
        ...(existing.direction === "local_to_boat"
          ? {
              ...(existing.destinationMachineId !== null
                ? { targetMachineId: existing.destinationMachineId }
                : {}),
              ...(existing.destinationEnvironmentId !== null
                ? { targetEnvironmentId: existing.destinationEnvironmentId }
                : {}),
            }
          : {}),
        targetProjectId: nextTargetProjectId,
        cloneDestinationPath: nextCloneDestinationPath,
        modelSelectionOverride: nextModelOverride,
        autoResume: nextAutoResume,
        entry,
      }),
      serviceScope,
    );
    entry.fiber = fiber;

    return reset;
  });

  const list: SessionTransferCoordinatorShape["list"] = Effect.fn(
    "SessionTransferCoordinator.list",
  )(function* (input) {
    const transfers = yield* (
      input.activeOnly ? repository.listActive(input.limit) : repository.listRecent(input.limit)
    ).pipe(
      Effect.mapError((error) =>
        toSessionTransferError("internal", error.message, undefined, error),
      ),
    );
    return { transfers };
  });

  const subscribe: Stream.Stream<SessionTransferProgressEvent> = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(progressPubSub);
      const transfers = yield* repository
        .listRecent()
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SessionTransferRecord>));
      return Stream.concat(
        Stream.fromIterable<SessionTransferProgressEvent>([{ _tag: "snapshot", transfers }]),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  const reconcileOnStartup: Effect.Effect<void> = Effect.gen(function* () {
    const active = yield* repository
      .listActive()
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SessionTransferRecord>));
    if (active.length === 0) {
      return;
    }

    for (const record of active) {
      if (
        record.phase === "finalizing_source" &&
        record.destinationThreadId !== null &&
        record.destinationProjectId !== null &&
        record.destinationEnvironmentId !== null
      ) {
        const finalizedAt = yield* nowIso();
        const finalizeInput: SessionTransferFinalizeSourceInput = {
          transferId: record.transferId,
          threadId: record.sourceThreadId,
          destination: {
            transferId: record.transferId,
            environmentId: record.destinationEnvironmentId,
            environmentName: record.destinationEnvironmentName,
            machineId: record.destinationMachineId,
            projectId: record.destinationProjectId,
            threadId: record.destinationThreadId,
            transferredAt: finalizedAt,
          },
        };
        const finalized = yield* Effect.gen(function* () {
          if (record.direction === "local_to_boat") {
            yield* localEndpoints.finalizeSource(finalizeInput);
          } else {
            const access = yield* getMachineProxyAccess({
              environmentId: record.sourceEnvironmentId,
            });
            yield* remoteClient.finalizeSource(
              { localUrl: access.localUrl, bearerToken: access.bearerToken },
              finalizeInput,
            );
          }
        }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Failed to finalize source during startup reconciliation", {
              transferId: record.transferId,
              error: error.message,
            }).pipe(Effect.as(false)),
          ),
        );

        const completedAt = yield* nowIso();
        if (finalized) {
          yield* transition(record.transferId, "completed", {
            phaseDetail: null,
            errorMessage: null,
            completedAt,
          }).pipe(Effect.ignore);
        } else {
          yield* transition(record.transferId, "failed", {
            phaseDetail: null,
            errorMessage:
              "Transfer committed on destination before restart, but archiving the source thread could not finish.",
            completedAt,
          }).pipe(Effect.ignore);
        }
        continue;
      }

      // Crashed before commit: unlock local side best-effort and mark failed.
      yield* localEndpoints
        .abort({
          transferId: record.transferId,
          role: record.direction === "local_to_boat" ? "source" : "destination",
          threadId: record.sourceThreadId,
          reason: "Interrupted by server restart",
        })
        .pipe(Effect.ignore);

      const completedAt = yield* nowIso();
      yield* transition(record.transferId, "failed", {
        phaseDetail: null,
        errorMessage: "Interrupted by server restart",
        completedAt,
      }).pipe(Effect.ignore);
    }
  });

  return SessionTransferCoordinator.of({
    preflight,
    start,
    cancel,
    retry,
    list,
    subscribe,
    reconcileOnStartup,
  });
});

export const layer = Layer.effect(SessionTransferCoordinator, make);

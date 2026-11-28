// @effect-diagnostics-next-line nodeBuiltinImport:off -- Direct Node HTTP/socket streaming keeps 35 MiB transfer RSS bounded.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Direct Node HTTPS fallback with write-callback backpressure.
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import {
  ChatAttachmentId,
  CommandId,
  EnvironmentId,
  type GitRefName as GitRefNameSchema,
  IsoDateTime,
  type ModelSelection,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
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
  type SessionTransferThreadOrigin,
  ThreadId,
  TrimmedNonEmptyString,
  WS_METHODS,
  isProviderAvailable,
  isTerminalSessionTransferPhase,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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
import * as Semaphore from "effect/Semaphore";
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
const STREAM_HIGH_WATER_MARK = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 1024;
const MAX_RESPONSE_HEADER_BYTES = 32 * 1024;

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
  readonly transferOrigin?: SessionTransferThreadOrigin | null;
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

function redactSignedPathSegments(value: string): string {
  return value.replace(
    /(\/api\/(?:session-transfers|attachments|assets)\/)[^?#\s)'"<>]+/g,
    "$1[REDACTED]",
  );
}

function sanitizeUrlForError(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${redactSignedPathSegments(parsed.pathname)}`;
  } catch {
    const queryIndex = rawUrl.indexOf("?");
    const hashIndex = rawUrl.indexOf("#");
    const cut =
      queryIndex >= 0 && hashIndex >= 0
        ? Math.min(queryIndex, hashIndex)
        : queryIndex >= 0
          ? queryIndex
          : hashIndex;
    const withoutQuery = cut >= 0 ? rawUrl.slice(0, cut) : rawUrl;
    return redactSignedPathSegments(withoutQuery);
  }
}

function redactSignedUrlsInMessage(message: string): string {
  const withoutQueries = message.replace(
    /(https?:\/\/[^\s)'"<>]+?|\/api\/(?:session-transfers|attachments|assets)\/[^\s)'"<>]+?)([?#][^\s)'"<>]+)/g,
    "$1",
  );
  return redactSignedPathSegments(withoutQueries);
}

function parseStrictContentLength(
  rawValues: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly reason: string } {
  if (rawValues.length === 0) {
    return { ok: true, value: undefined };
  }
  let resolved: number | undefined = undefined;
  for (const raw of rawValues) {
    const parts = raw.split(",");
    for (const part of parts) {
      const trimmed = part.trim();
      if (!/^[0-9]+$/.test(trimmed)) {
        return {
          ok: false,
          reason: `Invalid Content-Length header value "${raw}" from source.`,
        };
      }
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return {
          ok: false,
          reason: `Out-of-range Content-Length header value "${raw}" from source.`,
        };
      }
      if (resolved !== undefined && resolved !== parsed) {
        return {
          ok: false,
          reason: `Conflicting Content-Length header values (${resolved} vs ${parsed}) from source.`,
        };
      }
      resolved = parsed;
    }
  }
  return { ok: true, value: resolved };
}

function normalizeCanonicalWorkspaceRoot(workspaceRoot: string): string {
  const forward = workspaceRoot.trim().replaceAll("\\", "/");
  if (forward.length === 0) return "";
  const segments = forward.split("/");
  const isAbsolute = forward.startsWith("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
        resolved.pop();
      } else if (!isAbsolute) {
        resolved.push("..");
      }
      continue;
    }
    resolved.push(segment);
  }
  return (isAbsolute ? "/" : "") + resolved.join("/");
}

function readBoundedErrorBody(
  res: NodeHttp.IncomingMessage,
  maxBytes = MAX_ERROR_BODY_BYTES,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let collected = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      res.removeListener("data", onData);
      res.removeListener("end", onEnd);
      res.removeListener("close", onEnd);
      res.removeListener("error", onEnd);
      resolve(
        collected === 0
          ? ""
          : Buffer.concat(chunks, Math.min(collected, maxBytes)).toString("utf8"),
      );
    };

    const onData = (chunk: Buffer | string) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - collected;
      if (remaining > 0) {
        chunks.push(buf.byteLength <= remaining ? buf : buf.subarray(0, remaining));
        collected += Math.min(buf.byteLength, remaining);
      }
      if (collected >= maxBytes) {
        finish();
        res.destroy();
      }
    };

    const onEnd = () => {
      finish();
    };

    res.on("data", onData);
    res.once("end", onEnd);
    res.once("close", onEnd);
    res.once("error", onEnd);
  });
}

function parseAddProjectResult(data: unknown): {
  readonly projectId: ProjectId | null;
  readonly workspaceRoot: string | null;
} {
  if (typeof data !== "object" || data === null) {
    return { projectId: null, workspaceRoot: null };
  }
  const obj = data as Record<string, unknown>;
  const nested =
    typeof obj.project === "object" && obj.project !== null
      ? (obj.project as Record<string, unknown>)
      : null;
  const rawProjectId =
    typeof obj.projectId === "string"
      ? obj.projectId
      : typeof nested?.id === "string"
        ? nested.id
        : null;
  const rawWorkspaceRoot =
    typeof obj.workspaceRoot === "string"
      ? obj.workspaceRoot
      : typeof obj.cwd === "string"
        ? obj.cwd
        : typeof nested?.workspaceRoot === "string"
          ? nested.workspaceRoot
          : null;
  const trimmedId = rawProjectId?.trim();
  const trimmedRoot = rawWorkspaceRoot?.trim();
  return {
    projectId: trimmedId && trimmedId.length > 0 ? ProjectId.make(trimmedId) : null,
    workspaceRoot: trimmedRoot && trimmedRoot.length > 0 ? trimmedRoot : null,
  };
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
    message: redactSignedUrlsInMessage(message),
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

interface WireThreadSnapshotBody {
  readonly thread?: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly branch?: GitRefName | null;
    readonly worktreePath?: string | null;
    readonly transferOrigin?: SessionTransferThreadOrigin | null;
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
}

interface WireThreadBoundedSnapshot extends WireThreadSnapshotBody {
  readonly projection?: WireThreadSnapshotBody;
}

export function makeLiveBoatRemoteClient(
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
    extraHeaders?: Readonly<Record<string, string>>,
  ) {
    const httpClient = yield* requireHttpClient();
    const safePath = sanitizeUrlForError(relativePath);
    let request = HttpClientRequest.get(`${endpoint.localUrl}${relativePath}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${endpoint.bearerToken}`),
    );
    if (extraHeaders !== undefined) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        request = HttpClientRequest.setHeader(key, value)(request);
      }
    }
    const response = yield* httpClient
      .execute(request)
      .pipe(
        Effect.mapError((error) =>
          toSessionTransferError(
            "target_unavailable",
            `Boat HTTP request ${safePath} failed: ${error.message}`,
            undefined,
            error,
          ),
        ),
      );
    if (response.status === 404) {
      return yield* toSessionTransferError("not_found", `Remote resource not found: ${safePath}`);
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* toSessionTransferError(
        "target_unavailable",
        `Boat HTTP request ${safePath} failed with HTTP ${response.status}.`,
      );
    }
    return (yield* response.json.pipe(
      Effect.mapError((error) =>
        toSessionTransferError(
          "internal",
          `Boat HTTP response ${safePath} could not be decoded as JSON.`,
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
      }>(endpoint, "/api/orchestration/shell", {
        [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      }).pipe(
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
      fetchJson<WireThreadBoundedSnapshot>(
        endpoint,
        `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`,
        {
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        },
      ).pipe(
        Effect.flatMap((snapshot) => {
          const body: WireThreadSnapshotBody = snapshot.projection ?? snapshot;
          const thread = body.thread;
          if (!thread) {
            return Effect.fail(
              toSessionTransferError("not_found", `Thread ${threadId} was not found on Boat.`),
            );
          }
          const runs = body.runs ?? [];
          const wasRunning = runs.some(
            (run) =>
              run.status !== undefined &&
              WORKING_RUN_STATUSES.has(run.status as OrchestrationV2Run["status"]),
          );
          const heldQueuedRunCount = runs.filter((run) => run.status === "queued").length;
          const pendingRuntimeRequests: SessionTransferPendingRuntimeRequest[] = (
            body.runtimeRequests ?? []
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
          const activeSubagentCount = (body.subagents ?? []).filter(
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
            ...(thread.transferOrigin !== undefined
              ? { transferOrigin: thread.transferOrigin }
              : {}),
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
      Effect.callback<
        { readonly bytesTransferred: number; readonly status: number },
        SessionTransferError
      >((resume) => {
        let sourceUrl: URL;
        let targetUrl: URL;
        try {
          sourceUrl = new URL(input.sourceUrl);
          targetUrl = new URL(input.targetUrl);
        } catch (error) {
          resume(
            Effect.fail(
              toSessionTransferError(
                "workspace_error",
                "Invalid source or target URL for transfer stream.",
                undefined,
                error,
              ),
            ),
          );
          return;
        }

        if (
          (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") ||
          (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:")
        ) {
          resume(
            Effect.fail(
              toSessionTransferError(
                "workspace_error",
                "Transfer URLs must use http or NodeHttps.",
              ),
            ),
          );
          return;
        }

        const hasCrLf = (value: string | undefined): boolean =>
          value !== undefined && /[\r\n]/.test(value);
        if (
          hasCrLf(input.sourceBearerToken) ||
          hasCrLf(input.targetBearerToken) ||
          hasCrLf(input.contentType) ||
          hasCrLf(sourceUrl.host) ||
          hasCrLf(`${sourceUrl.pathname}${sourceUrl.search}`)
        ) {
          resume(
            Effect.fail(
              toSessionTransferError(
                "workspace_error",
                "Invalid control characters in transfer request metadata.",
              ),
            ),
          );
          return;
        }

        const safeSourceUrl = sanitizeUrlForError(input.sourceUrl);
        let settled = false;
        let targetRejected = false;
        let sourceBodyComplete = false;
        let targetSuccessStatus: number | null = null;
        let sourceSocket: NodeNet.Socket | null = null;
        let sourceReq: NodeHttp.ClientRequest | null = null;
        let sourceRes: NodeHttp.IncomingMessage | null = null;
        let targetReq: NodeHttp.ClientRequest | null = null;
        let targetRes: NodeHttp.IncomingMessage | null = null;
        let bytesTransferred = 0;

        const destroySource = () => {
          try {
            sourceSocket?.destroy();
          } catch {
            // ignore destroy errors
          }
          try {
            sourceRes?.destroy();
          } catch {
            // ignore destroy errors
          }
          try {
            sourceReq?.destroy();
          } catch {
            // ignore destroy errors
          }
        };

        const destroyAll = () => {
          destroySource();
          try {
            targetRes?.destroy();
          } catch {
            // ignore destroy errors
          }
          try {
            targetReq?.destroy();
          } catch {
            // ignore destroy errors
          }
        };

        const finish = (
          effect: Effect.Effect<
            { readonly bytesTransferred: number; readonly status: number },
            SessionTransferError
          >,
        ) => {
          if (settled) return;
          settled = true;
          resume(effect);
        };

        const maybeFinishSuccess = () => {
          if (settled || targetRejected) return;
          if (sourceBodyComplete && targetSuccessStatus !== null) {
            finish(Effect.succeed({ bytesTransferred, status: targetSuccessStatus }));
          }
        };

        const failAndDestroy = (error: SessionTransferError) => {
          if (settled) return;
          settled = true;
          destroyAll();
          resume(Effect.fail(error));
        };

        const startTargetUpload = (
          contentType: string,
          contentLength: number | undefined,
          useChunkedEncoding: boolean,
        ): NodeHttp.ClientRequest => {
          const targetHeaders: NodeHttp.OutgoingHttpHeaders = {
            "content-type": contentType,
          };
          if (useChunkedEncoding) {
            targetHeaders["transfer-encoding"] = "chunked";
          } else if (contentLength !== undefined) {
            targetHeaders["content-length"] = String(contentLength);
          }
          if (input.targetBearerToken !== undefined) {
            targetHeaders.authorization = `Bearer ${input.targetBearerToken}`;
          }

          const uploadReq = (
            targetUrl.protocol === "https:" ? NodeHttps.request : NodeHttp.request
          )(targetUrl, {
            method: "POST",
            headers: targetHeaders,
          });
          targetReq = uploadReq;

          uploadReq.on("error", (error) => {
            if (targetRejected) return;
            failAndDestroy(
              toSessionTransferError(
                "workspace_error",
                `Failed to upload transfer payload: ${error.message}`,
                undefined,
                error,
              ),
            );
          });

          uploadReq.on("response", (uploadRes) => {
            targetRes = uploadRes;
            if (settled) {
              uploadRes.destroy();
              return;
            }
            const targetStatus = uploadRes.statusCode ?? 0;
            if (targetStatus < 200 || targetStatus >= 300) {
              // Mark targetRejected BEFORE destroying source so source close/error events
              // cannot race ahead of reading the target's bounded error body.
              targetRejected = true;
              destroySource();
              void readBoundedErrorBody(uploadRes, MAX_ERROR_BODY_BYTES).then((detail) => {
                const trimmed = redactSignedUrlsInMessage(detail.trim());
                failAndDestroy(
                  toSessionTransferError(
                    targetStatus === 413 ? "bundle_too_large" : "workspace_error",
                    `Failed to upload transfer payload (HTTP ${targetStatus})${trimmed ? `: ${trimmed.slice(0, 200)}` : ""}.`,
                  ),
                );
              });
              return;
            }

            uploadRes.on("error", (error) => {
              if (targetRejected) return;
              failAndDestroy(
                toSessionTransferError(
                  "workspace_error",
                  `Failed reading upload confirmation: ${error.message}`,
                  undefined,
                  error,
                ),
              );
            });
            uploadRes.once("end", () => {
              targetSuccessStatus = targetStatus;
              maybeFinishSuccess();
            });
            uploadRes.once("close", () => {
              if (settled || targetRejected || targetSuccessStatus !== null) return;
              if (!uploadRes.complete) {
                failAndDestroy(
                  toSessionTransferError(
                    "workspace_error",
                    "Target upload response stream closed before completing.",
                  ),
                );
              }
            });
            uploadRes.resume();
          });

          return uploadReq;
        };

        if (sourceUrl.protocol === "http:") {
          // Use a fixed reusable 64 KiB read buffer via NodeNet.connect({ onread }) so
          // high-throughput loopback transfers do not allocate per-read ArrayBuffers
          // that inflate V8 external memory / RSS before GC catches up.
          const readBuf = Buffer.allocUnsafe(STREAM_HIGH_WATER_MARK);
          const host =
            sourceUrl.hostname.startsWith("[") && sourceUrl.hostname.endsWith("]")
              ? sourceUrl.hostname.slice(1, -1)
              : sourceUrl.hostname;
          const port = sourceUrl.port ? Number(sourceUrl.port) : 80;
          const requestLines = [
            `GET ${sourceUrl.pathname}${sourceUrl.search} HTTP/1.1`,
            `Host: ${sourceUrl.host}`,
            "Connection: close",
          ];
          if (input.sourceBearerToken !== undefined) {
            requestLines.push(`Authorization: Bearer ${input.sourceBearerToken}`);
          }
          requestLines.push("", "");
          const rawRequest = requestLines.join("\r\n");

          let phase: "headers" | "body" | "error-body" | "done" = "headers";
          const headerChunks: Buffer[] = [];
          let headerBytes = 0;
          let framing: "content-length" | "chunked" | "eof" = "eof";
          let remainingBodyBytes = 0;
          let chunkState:
            | "size-line"
            | "chunk-data"
            | "chunk-cr"
            | "chunk-lf"
            | "trailer-line"
            | "done" = "size-line";
          let chunkLine = "";
          let chunkRemaining = 0;
          let trailerLineLength = 0;
          let trailerLastByteWasCr = false;
          let totalTrailerBytes = 0;
          let errorStatus = 0;
          const errorBodyBufs: Buffer[] = [];
          let errorCollected = 0;
          let errorLimit = MAX_ERROR_BODY_BYTES;
          let uploadReq: NodeHttp.ClientRequest | null = null;
          let inFlightWrite = false;
          let sourceEnded = false;
          let sourceClosed = false;

          const finishErrorBody = () => {
            if (settled || targetRejected) return;
            phase = "done";
            const detail =
              errorCollected === 0
                ? ""
                : Buffer.concat(
                    errorBodyBufs,
                    Math.min(errorCollected, MAX_ERROR_BODY_BYTES),
                  ).toString("utf8");
            const trimmed = redactSignedUrlsInMessage(detail.trim());
            failAndDestroy(
              toSessionTransferError(
                "workspace_error",
                `Failed to download transfer payload (HTTP ${errorStatus})${trimmed ? `: ${trimmed.slice(0, 200)}` : ""}.`,
              ),
            );
          };

          const finishSourceBody = () => {
            if (sourceBodyComplete || settled || targetRejected) return;
            sourceBodyComplete = true;
            phase = "done";
            uploadReq?.end();
            destroySource();
            maybeFinishSuccess();
          };

          const handleSourceEofIfIdle = () => {
            if (settled || targetRejected || sourceBodyComplete || inFlightWrite) return;
            if (phase === "headers") {
              failAndDestroy(
                toSessionTransferError(
                  "workspace_error",
                  `Source closed connection before sending response headers (${safeSourceUrl}).`,
                ),
              );
              return;
            }
            if (phase === "error-body") {
              finishErrorBody();
              return;
            }
            if (phase === "body") {
              if (framing === "eof") {
                finishSourceBody();
              } else {
                failAndDestroy(
                  toSessionTransferError(
                    "workspace_error",
                    "Source transfer stream ended prematurely.",
                  ),
                );
              }
            }
          };

          const handleSourceCloseIfIdle = () => {
            if (settled || targetRejected || sourceBodyComplete || inFlightWrite) return;
            if (phase === "error-body") {
              finishErrorBody();
              return;
            }
            if (phase === "body" && framing === "eof" && sourceEnded) {
              finishSourceBody();
              return;
            }
            failAndDestroy(
              toSessionTransferError(
                "workspace_error",
                "Source transfer stream was aborted before completing.",
              ),
            );
          };

          const pumpChunked = (data: Buffer, startPos: number): void => {
            let pos = startPos;
            while (pos < data.byteLength) {
              if (settled || targetRejected || sourceBodyComplete) return;
              if (chunkState === "done") {
                if (phase === "error-body") {
                  finishErrorBody();
                } else {
                  finishSourceBody();
                }
                return;
              }
              if (chunkState === "size-line") {
                let foundNewline = false;
                while (pos < data.byteLength) {
                  const byte = data[pos++]!;
                  if (byte === 0x0a) {
                    foundNewline = true;
                    break;
                  }
                  if (chunkLine.length >= 128) {
                    failAndDestroy(
                      toSessionTransferError(
                        "workspace_error",
                        "Malformed chunked transfer encoding from source.",
                      ),
                    );
                    return;
                  }
                  chunkLine += String.fromCharCode(byte);
                }
                if (!foundNewline) {
                  break;
                }
                if (!chunkLine.endsWith("\r")) {
                  failAndDestroy(
                    toSessionTransferError(
                      "workspace_error",
                      "Malformed chunked transfer encoding: expected CRLF after chunk size.",
                    ),
                  );
                  return;
                }
                const cleaned = chunkLine.slice(0, -1).split(";")[0]?.trim() ?? "";
                chunkLine = "";
                if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
                  failAndDestroy(
                    toSessionTransferError(
                      "workspace_error",
                      "Invalid chunk size in source transfer response.",
                    ),
                  );
                  return;
                }
                const parsedSize = Number.parseInt(cleaned, 16);
                if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) {
                  failAndDestroy(
                    toSessionTransferError(
                      "workspace_error",
                      "Out-of-range chunk size in source transfer response.",
                    ),
                  );
                  return;
                }
                if (parsedSize === 0) {
                  chunkState = "trailer-line";
                  trailerLineLength = 0;
                  trailerLastByteWasCr = false;
                  continue;
                }
                chunkRemaining = parsedSize;
                chunkState = "chunk-data";
                continue;
              }
              if (chunkState === "chunk-data") {
                const take = Math.min(chunkRemaining, data.byteLength - pos);
                const slice = data.subarray(pos, pos + take);
                pos += take;
                chunkRemaining -= take;
                if (chunkRemaining === 0) {
                  chunkState = "chunk-cr";
                }
                if (phase === "error-body") {
                  const copyLen = Math.min(slice.byteLength, errorLimit - errorCollected);
                  if (copyLen > 0) {
                    errorBodyBufs.push(Buffer.from(slice.subarray(0, copyLen)));
                    errorCollected += copyLen;
                  }
                  if (errorCollected >= errorLimit) {
                    finishErrorBody();
                    return;
                  }
                  continue;
                }
                bytesTransferred += slice.byteLength;
                input.onProgress?.(bytesTransferred);
                inFlightWrite = true;
                sourceSocket?.pause();
                uploadReq!.write(slice, (err) => {
                  inFlightWrite = false;
                  if (settled || targetRejected) return;
                  if (err) {
                    failAndDestroy(
                      toSessionTransferError(
                        "workspace_error",
                        `Failed to upload transfer payload: ${err.message}`,
                        undefined,
                        err,
                      ),
                    );
                    return;
                  }
                  pumpChunked(data, pos);
                });
                return;
              }
              if (chunkState === "chunk-cr") {
                const byte = data[pos++]!;
                if (byte !== 0x0d) {
                  failAndDestroy(
                    toSessionTransferError(
                      "workspace_error",
                      "Malformed chunked transfer encoding: expected CR after chunk data.",
                    ),
                  );
                  return;
                }
                chunkState = "chunk-lf";
                continue;
              }
              if (chunkState === "chunk-lf") {
                const byte = data[pos++]!;
                if (byte !== 0x0a) {
                  failAndDestroy(
                    toSessionTransferError(
                      "workspace_error",
                      "Malformed chunked transfer encoding: expected LF after chunk data.",
                    ),
                  );
                  return;
                }
                chunkState = "size-line";
                chunkLine = "";
                continue;
              }
              if (chunkState === "trailer-line") {
                const byte = data[pos++]!;
                totalTrailerBytes += 1;
                if (totalTrailerBytes > MAX_RESPONSE_HEADER_BYTES) {
                  failAndDestroy(
                    toSessionTransferError(
                      "workspace_error",
                      "Chunked transfer trailers exceeded maximum allowed size.",
                    ),
                  );
                  return;
                }
                if (byte === 0x0a) {
                  if (!trailerLastByteWasCr) {
                    failAndDestroy(
                      toSessionTransferError(
                        "workspace_error",
                        "Malformed chunked transfer encoding: expected CRLF in trailer section.",
                      ),
                    );
                    return;
                  }
                  if (trailerLineLength === 1) {
                    chunkState = "done";
                    if (phase === "error-body") {
                      finishErrorBody();
                    } else {
                      finishSourceBody();
                    }
                    return;
                  }
                  trailerLineLength = 0;
                  trailerLastByteWasCr = false;
                  continue;
                }
                if (trailerLastByteWasCr) {
                  failAndDestroy(
                    toSessionTransferError(
                      "workspace_error",
                      "Malformed chunked transfer encoding: bare CR in trailer section.",
                    ),
                  );
                  return;
                }
                trailerLineLength += 1;
                trailerLastByteWasCr = byte === 0x0d;
                continue;
              }
            }

            if (settled || targetRejected || sourceBodyComplete) return;
            if (sourceEnded) {
              handleSourceEofIfIdle();
              return;
            }
            if (sourceClosed) {
              handleSourceCloseIfIdle();
              return;
            }
            sourceSocket?.resume();
          };

          const processBodySlice = (data: Buffer): void => {
            if (settled || targetRejected || sourceBodyComplete) return;
            if (framing === "chunked") {
              if (data.byteLength > 0) {
                pumpChunked(data, 0);
              } else if (sourceEnded) {
                handleSourceEofIfIdle();
              } else if (sourceClosed) {
                handleSourceCloseIfIdle();
              }
              return;
            }
            if (phase === "error-body") {
              const avail =
                framing === "content-length"
                  ? Math.min(data.byteLength, remainingBodyBytes)
                  : data.byteLength;
              const take = Math.min(avail, errorLimit - errorCollected);
              if (take > 0) {
                errorBodyBufs.push(Buffer.from(data.subarray(0, take)));
                errorCollected += take;
              }
              if (framing === "content-length") {
                remainingBodyBytes -= avail;
              }
              if (
                errorCollected >= errorLimit ||
                (framing === "content-length" && remainingBodyBytes <= 0)
              ) {
                finishErrorBody();
              }
              return;
            }

            const toWrite =
              framing === "content-length"
                ? data.subarray(0, Math.min(data.byteLength, remainingBodyBytes))
                : data;
            if (toWrite.byteLength === 0) {
              if (framing === "content-length" && remainingBodyBytes <= 0) {
                finishSourceBody();
              }
              return;
            }
            if (framing === "content-length") {
              remainingBodyBytes -= toWrite.byteLength;
            }
            bytesTransferred += toWrite.byteLength;
            input.onProgress?.(bytesTransferred);
            inFlightWrite = true;
            sourceSocket?.pause();
            uploadReq!.write(toWrite, (err) => {
              inFlightWrite = false;
              if (settled || targetRejected) return;
              if (err) {
                failAndDestroy(
                  toSessionTransferError(
                    "workspace_error",
                    `Failed to upload transfer payload: ${err.message}`,
                    undefined,
                    err,
                  ),
                );
                return;
              }
              if (framing === "content-length" && remainingBodyBytes <= 0) {
                finishSourceBody();
                return;
              }
              if (sourceEnded) {
                handleSourceEofIfIdle();
                return;
              }
              if (sourceClosed) {
                handleSourceCloseIfIdle();
                return;
              }
              sourceSocket?.resume();
            });
          };

          sourceSocket = NodeNet.connect({
            host,
            port,
            onread: {
              buffer: readBuf,
              callback(nread, buf) {
                if (settled || targetRejected || sourceBodyComplete || nread <= 0) {
                  return true;
                }
                const view = Buffer.from(buf.buffer, buf.byteOffset, nread);
                if (phase === "headers") {
                  headerChunks.push(Buffer.from(view));
                  headerBytes += view.byteLength;
                  const combined =
                    headerChunks.length === 1
                      ? headerChunks[0]!
                      : Buffer.concat(headerChunks, headerBytes);
                  const headerEnd = combined.indexOf("\r\n\r\n");
                  if (headerEnd < 0) {
                    if (headerBytes > MAX_RESPONSE_HEADER_BYTES) {
                      failAndDestroy(
                        toSessionTransferError(
                          "workspace_error",
                          `Source response headers exceeded ${MAX_RESPONSE_HEADER_BYTES} bytes (${safeSourceUrl}).`,
                        ),
                      );
                    }
                    return true;
                  }

                  headerChunks.length = 0;
                  const headerText = combined.subarray(0, headerEnd).toString("latin1");
                  const leftover = combined.subarray(headerEnd + 4);
                  const lines = headerText.split("\r\n");
                  const statusLine = lines[0] ?? "";
                  const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})\b/.exec(statusLine);
                  if (!statusMatch) {
                    failAndDestroy(
                      toSessionTransferError(
                        "workspace_error",
                        `Malformed HTTP status line from source (${safeSourceUrl}).`,
                      ),
                    );
                    return true;
                  }
                  const sourceStatus = Number(statusMatch[1]);
                  const responseHeaders = new Map<string, string>();
                  const contentLengthValues: string[] = [];
                  for (let idx = 1; idx < lines.length; idx += 1) {
                    const line = lines[idx]!;
                    const colon = line.indexOf(":");
                    if (colon <= 0) continue;
                    const name = line.slice(0, colon).trim().toLowerCase();
                    const value = line.slice(colon + 1).trim();
                    if (name === "content-length") {
                      contentLengthValues.push(value);
                    }
                    const existing = responseHeaders.get(name);
                    responseHeaders.set(name, existing ? `${existing}, ${value}` : value);
                  }

                  if (sourceStatus === 404) {
                    failAndDestroy(
                      toSessionTransferError(
                        "not_found",
                        `Transfer payload not found at source (${safeSourceUrl}).`,
                      ),
                    );
                    return true;
                  }

                  const contentLengthParsed = parseStrictContentLength(contentLengthValues);
                  if (!contentLengthParsed.ok) {
                    failAndDestroy(
                      toSessionTransferError("workspace_error", contentLengthParsed.reason),
                    );
                    return true;
                  }

                  const rawTransferEncoding = responseHeaders.get("transfer-encoding") ?? "";
                  const hasTransferEncoding = rawTransferEncoding.trim().length > 0;
                  // Per RFC 9112 §6.3, Transfer-Encoding overrides Content-Length: ignore source
                  // Content-Length whenever Transfer-Encoding is present so target upload uses
                  // chunked framing instead of a potentially mismatched Content-Length header.
                  const parsedHeaderLength = hasTransferEncoding
                    ? undefined
                    : contentLengthParsed.value;

                  if (/\bchunked\b/i.test(rawTransferEncoding)) {
                    framing = "chunked";
                  } else if (parsedHeaderLength !== undefined) {
                    framing = "content-length";
                    remainingBodyBytes = parsedHeaderLength;
                  } else {
                    framing = "eof";
                  }

                  if (sourceStatus < 200 || sourceStatus >= 300) {
                    phase = "error-body";
                    errorStatus = sourceStatus;
                    errorLimit =
                      framing === "content-length"
                        ? Math.min(MAX_ERROR_BODY_BYTES, remainingBodyBytes)
                        : MAX_ERROR_BODY_BYTES;
                    if (errorLimit === 0) {
                      finishErrorBody();
                      return true;
                    }
                    if (leftover.byteLength > 0) {
                      processBodySlice(leftover);
                    }
                    return true;
                  }

                  const contentType =
                    input.contentType ??
                    responseHeaders.get("content-type") ??
                    "application/octet-stream";
                  const contentLength = hasTransferEncoding
                    ? undefined
                    : framing === "content-length"
                      ? parsedHeaderLength
                      : input.expectedSizeBytes !== undefined && input.expectedSizeBytes !== null
                        ? input.expectedSizeBytes
                        : undefined;

                  uploadReq = startTargetUpload(contentType, contentLength, hasTransferEncoding);
                  phase = "body";
                  if (framing === "content-length" && remainingBodyBytes === 0) {
                    finishSourceBody();
                    return true;
                  }
                  if (leftover.byteLength > 0) {
                    processBodySlice(leftover);
                  }
                  return true;
                }

                processBodySlice(view);
                return true;
              },
            },
          });

          sourceSocket.on("connect", () => {
            if (settled || targetRejected) {
              sourceSocket?.destroy();
              return;
            }
            sourceSocket?.write(rawRequest);
          });

          sourceSocket.on("error", (error) => {
            if (sourceBodyComplete || targetRejected) return;
            failAndDestroy(
              toSessionTransferError(
                "workspace_error",
                `Failed to download transfer payload from ${safeSourceUrl}: ${error.message}`,
                undefined,
                error,
              ),
            );
          });

          sourceSocket.once("end", () => {
            sourceEnded = true;
            handleSourceEofIfIdle();
          });

          sourceSocket.once("close", () => {
            sourceClosed = true;
            handleSourceCloseIfIdle();
          });

          return Effect.sync(() => {
            settled = true;
            destroyAll();
          });
        }

        // HTTPS fallback using node:https with explicit write-callback backpressure.
        const sourceHeaders: NodeHttp.OutgoingHttpHeaders = {};
        if (input.sourceBearerToken !== undefined) {
          sourceHeaders.authorization = `Bearer ${input.sourceBearerToken}`;
        }

        sourceReq = NodeHttps.request(sourceUrl, {
          method: "GET",
          headers: sourceHeaders,
        });

        sourceReq.on("error", (error) => {
          if (sourceBodyComplete || targetRejected) return;
          failAndDestroy(
            toSessionTransferError(
              "workspace_error",
              `Failed to download transfer payload from ${safeSourceUrl}: ${error.message}`,
              undefined,
              error,
            ),
          );
        });

        sourceReq.on("response", (res) => {
          sourceRes = res;
          if (settled || targetRejected) {
            res.destroy();
            return;
          }

          const sourceStatus = res.statusCode ?? 0;
          if (sourceStatus === 404) {
            res.destroy();
            failAndDestroy(
              toSessionTransferError(
                "not_found",
                `Transfer payload not found at source (${safeSourceUrl}).`,
              ),
            );
            return;
          }
          if (sourceStatus < 200 || sourceStatus >= 300) {
            void readBoundedErrorBody(res, MAX_ERROR_BODY_BYTES).then((detail) => {
              const trimmed = redactSignedUrlsInMessage(detail.trim());
              failAndDestroy(
                toSessionTransferError(
                  "workspace_error",
                  `Failed to download transfer payload (HTTP ${sourceStatus})${trimmed ? `: ${trimmed.slice(0, 200)}` : ""}.`,
                ),
              );
            });
            return;
          }

          const rawContentType = res.headers["content-type"];
          const contentType =
            input.contentType ??
            (typeof rawContentType === "string" ? rawContentType : undefined) ??
            "application/octet-stream";

          const rawTransferEncoding = res.headers["transfer-encoding"];
          const hasTransferEncoding =
            rawTransferEncoding !== undefined &&
            (Array.isArray(rawTransferEncoding)
              ? rawTransferEncoding.some((v) => v.trim().length > 0)
              : rawTransferEncoding.trim().length > 0);
          const rawContentLength = res.headers["content-length"];
          const contentLengthValues =
            rawContentLength === undefined
              ? []
              : Array.isArray(rawContentLength)
                ? rawContentLength
                : [rawContentLength];
          const contentLengthParsed = parseStrictContentLength(contentLengthValues);
          if (!contentLengthParsed.ok) {
            res.destroy();
            failAndDestroy(toSessionTransferError("workspace_error", contentLengthParsed.reason));
            return;
          }
          const parsedHeaderLength = hasTransferEncoding ? undefined : contentLengthParsed.value;
          const contentLength = hasTransferEncoding
            ? undefined
            : (parsedHeaderLength ??
              (input.expectedSizeBytes !== undefined && input.expectedSizeBytes !== null
                ? input.expectedSizeBytes
                : undefined));

          const uploadReq = startTargetUpload(contentType, contentLength, hasTransferEncoding);
          let inFlightWrite = false;
          let sourceEnded = false;

          const finishHttpsSource = () => {
            if (settled || targetRejected || sourceBodyComplete) return;
            if (
              !res.complete ||
              (parsedHeaderLength !== undefined && bytesTransferred !== parsedHeaderLength)
            ) {
              failAndDestroy(
                toSessionTransferError(
                  "workspace_error",
                  "Source transfer stream ended prematurely.",
                ),
              );
              return;
            }
            sourceBodyComplete = true;
            uploadReq.end();
            maybeFinishSuccess();
          };

          res.on("data", (chunk: Buffer | string) => {
            if (settled || targetRejected) {
              res.destroy();
              return;
            }
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytesTransferred += buf.byteLength;
            input.onProgress?.(bytesTransferred);
            inFlightWrite = true;
            res.pause();
            uploadReq.write(buf, (err) => {
              inFlightWrite = false;
              if (settled || targetRejected) return;
              if (err) {
                failAndDestroy(
                  toSessionTransferError(
                    "workspace_error",
                    `Failed to upload transfer payload: ${err.message}`,
                    undefined,
                    err,
                  ),
                );
                return;
              }
              if (sourceEnded) {
                finishHttpsSource();
                return;
              }
              res.resume();
            });
          });

          res.once("end", () => {
            if (targetRejected) return;
            sourceEnded = true;
            if (!inFlightWrite) {
              finishHttpsSource();
            }
          });

          res.once("aborted", () => {
            if (sourceBodyComplete || targetRejected) return;
            failAndDestroy(
              toSessionTransferError(
                "workspace_error",
                "Source transfer stream was aborted before completing.",
              ),
            );
          });

          res.on("error", (error) => {
            if (sourceBodyComplete || targetRejected) return;
            failAndDestroy(
              toSessionTransferError(
                "workspace_error",
                `Failed to download transfer payload: ${error.message}`,
                undefined,
                error,
              ),
            );
          });
        });

        sourceReq.end();

        return Effect.sync(() => {
          settled = true;
          destroyAll();
        });
      }),
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
  readonly attemptId: number;
  cancelled: boolean;
  committed: boolean;
  fiber: Fiber.Fiber<void, never> | null;
}

const PRE_SOURCE_PREPARE_PHASES: ReadonlySet<SessionTransferPhase> = new Set([
  "queued",
  "waking_target",
  "pausing_source",
]);

const PRE_DESTINATION_STAGE_PHASES: ReadonlySet<SessionTransferPhase> = new Set([
  "queued",
  "waking_target",
  "pausing_source",
  "exporting_source",
  "preparing_target_project",
]);

function hasDestinationStagingMetadata(record: SessionTransferRecord): boolean {
  return (
    record.destinationThreadId !== null ||
    record.destinationBranch !== null ||
    record.destinationWorktreePath !== null
  );
}

function mayHaveStagedDestination(record: SessionTransferRecord): boolean {
  return !PRE_DESTINATION_STAGE_PHASES.has(record.phase) || hasDestinationStagingMetadata(record);
}

function mayHavePreparedSource(record: SessionTransferRecord): boolean {
  return !PRE_SOURCE_PREPARE_PHASES.has(record.phase) || hasDestinationStagingMetadata(record);
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

function validateModelSelectionForDestination(input: {
  readonly desiredModel: ModelSelection;
  readonly isOverride: boolean;
  readonly destinationProviders: ReadonlyArray<ServerProvider>;
  readonly sourceDriverKind?: ProviderDriverKind | undefined;
  readonly transferId?: SessionTransferId | undefined;
}): Effect.Effect<ModelSelection, SessionTransferError> {
  const resolution = resolveModelSelectionOnDestination(
    input.desiredModel,
    input.destinationProviders,
    input.isOverride ? undefined : input.sourceDriverKind,
  );
  if (resolution.needsModelSelection || resolution.resolved === null) {
    return Effect.fail(
      toSessionTransferError(
        "preflight_required",
        `Model "${input.desiredModel.model}" on provider "${input.desiredModel.instanceId}" is not available on the destination.`,
        input.transferId,
      ),
    );
  }
  return Effect.succeed(resolution.resolved);
}

function enforceRunningConfirmation(input: {
  readonly wasRunning: boolean;
  readonly hasPendingRuntimeRequest: boolean;
  readonly activeSubagentCount: number;
  readonly confirmedRunningPause: boolean | undefined;
  readonly transferId?: SessionTransferId | undefined;
}): Effect.Effect<void, SessionTransferError> {
  const needsConfirmation =
    input.wasRunning || input.hasPendingRuntimeRequest || input.activeSubagentCount > 0;
  if (needsConfirmation && input.confirmedRunningPause !== true) {
    return Effect.fail(
      toSessionTransferError(
        "preflight_required",
        "Source thread has active work, pending runtime requests, or active subagents; set confirmedRunningPause=true to pause and transfer.",
        input.transferId,
      ),
    );
  }
  return Effect.void;
}

function normalizeRepoKey(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) return null;
  return repositoryGroupingKeyOf(identity).trim().toLowerCase();
}

function repoKeysMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

interface BoatProjectResolutionCandidate {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot?: string | undefined;
  readonly originProjectId: string | null;
  readonly repoKey: string | null;
  readonly repositoryIdentity?: RepositoryIdentity | undefined;
}

type BoatProjectResolutionResult =
  | {
      readonly kind: "matched";
      readonly match: BoatProjectResolutionCandidate;
      readonly matchReason: "manual" | "origin_project_id" | "repository_identity";
    }
  | {
      readonly kind: "ambiguous";
      readonly matches: ReadonlyArray<BoatProjectResolutionCandidate>;
      readonly matchReason: "origin_project_id" | "repository_identity";
    }
  | { readonly kind: "missing" }
  | { readonly kind: "not_found"; readonly targetProjectId: ProjectId }
  | { readonly kind: "unverified_explicit"; readonly targetProjectId: ProjectId };

function resolveBoatTargetProject(input: {
  readonly candidates: ReadonlyArray<BoatProjectResolutionCandidate> | null;
  readonly explicitTargetProjectId?: ProjectId | null | undefined;
  readonly sourceProjectId: ProjectId;
  readonly localRepoKey: string | null;
}): BoatProjectResolutionResult {
  if (input.explicitTargetProjectId != null) {
    if (input.candidates === null) {
      return { kind: "unverified_explicit", targetProjectId: input.explicitTargetProjectId };
    }
    const explicit = input.candidates.find((c) => c.id === input.explicitTargetProjectId);
    if (!explicit) {
      return { kind: "not_found", targetProjectId: input.explicitTargetProjectId };
    }
    return { kind: "matched", match: explicit, matchReason: "manual" };
  }

  const candidates = input.candidates ?? [];
  const originMatches = candidates.filter((c) => c.originProjectId === input.sourceProjectId);
  if (originMatches.length === 1 && originMatches[0]) {
    return { kind: "matched", match: originMatches[0], matchReason: "origin_project_id" };
  }
  if (originMatches.length > 1) {
    // Never fall through from multiple origin matches to repository matching.
    return { kind: "ambiguous", matches: originMatches, matchReason: "origin_project_id" };
  }

  const repoMatches =
    input.localRepoKey === null
      ? []
      : candidates.filter((c) => repoKeysMatch(input.localRepoKey, c.repoKey));
  if (repoMatches.length === 1 && repoMatches[0]) {
    return { kind: "matched", match: repoMatches[0], matchReason: "repository_identity" };
  }
  if (repoMatches.length > 1) {
    return { kind: "ambiguous", matches: repoMatches, matchReason: "repository_identity" };
  }

  return { kind: "missing" };
}

function buildAwakeBoatProjectCandidates(
  shellProjects: ReadonlyArray<RemoteShellProject>,
  daemonProjects: ReadonlyArray<typeof BoatDaemonProjectView.Type>,
): ReadonlyArray<BoatProjectResolutionCandidate> {
  return shellProjects.map((bp) => {
    const daemonMeta = daemonProjects.find((dp) => dp.id === bp.id);
    return {
      id: bp.id,
      title: bp.title,
      workspaceRoot: bp.workspaceRoot,
      originProjectId: daemonMeta?.originProjectId ?? null,
      repoKey: normalizeRepoKey(bp.repositoryIdentity) ?? daemonMeta?.repoKey ?? null,
      ...(bp.repositoryIdentity != null ? { repositoryIdentity: bp.repositoryIdentity } : {}),
    };
  });
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
  const getLiveActiveTransfer = (
    transferId: SessionTransferId,
  ): ActiveTransferEntry | undefined => {
    const entry = activeTransfers.get(transferId);
    if (entry === undefined) {
      return undefined;
    }
    // Prune stale entries whose worker fiber already terminated (e.g. interrupted before
    // entering `executeTransfer` so its inner `Effect.ensuring` finalizer never ran).
    if (entry.fiber !== null && entry.fiber.pollUnsafe() !== undefined) {
      activeTransfers.delete(transferId);
      return undefined;
    }
    return entry;
  };
  const hasLiveActiveTransfer = (transferId: SessionTransferId): boolean =>
    getLiveActiveTransfer(transferId) !== undefined;
  const startingTransfers = new Map<
    SessionTransferId,
    Deferred.Deferred<SessionTransferRecord, SessionTransferError>
  >();

  // Per-transferId mutex serializing mutating lifecycle operations (start/retry registration,
  // cancel, and per-transfer startup reconciliation) without ever being acquired by the background
  // worker fiber (preventing deadlock while cancel interrupts and joins the worker).
  const transferLocks = new Map<
    SessionTransferId,
    { readonly semaphore: Semaphore.Semaphore; activeCount: number }
  >();
  let nextTransferAttemptSeq = 0;
  const latestAttemptByTransfer = new Map<SessionTransferId, number>();
  const MAX_TRACKED_TRANSFER_ATTEMPTS = 1024;

  const currentTransferAttempt = (transferId: SessionTransferId): number =>
    latestAttemptByTransfer.get(transferId) ?? 0;

  const bumpTransferAttempt = (transferId: SessionTransferId): number => {
    nextTransferAttemptSeq += 1;
    latestAttemptByTransfer.delete(transferId);
    latestAttemptByTransfer.set(transferId, nextTransferAttemptSeq);
    if (latestAttemptByTransfer.size > MAX_TRACKED_TRANSFER_ATTEMPTS) {
      for (const candidateId of latestAttemptByTransfer.keys()) {
        if (latestAttemptByTransfer.size <= MAX_TRACKED_TRANSFER_ATTEMPTS) break;
        if (!hasLiveActiveTransfer(candidateId) && !transferLocks.has(candidateId)) {
          latestAttemptByTransfer.delete(candidateId);
        }
      }
    }
    return nextTransferAttemptSeq;
  };

  const withTransferLock = <A, E, R>(
    transferId: SessionTransferId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let lock = transferLocks.get(transferId);
      if (lock === undefined) {
        lock = { semaphore: Semaphore.makeUnsafe(1), activeCount: 0 };
        transferLocks.set(transferId, lock);
      }
      lock.activeCount += 1;
      const lockedEntry = lock;
      return lockedEntry.semaphore
        .withPermits(1)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lockedEntry.activeCount -= 1;
              if (lockedEntry.activeCount === 0 && transferLocks.get(transferId) === lockedEntry) {
                transferLocks.delete(transferId);
              }
            }),
          ),
        );
    });

  // Defense-in-depth ownership check before invoking source aborts or persisting terminal states:
  // ensures an obsolete caller can never stomp a newer retry attempt on the same transferId.
  const verifyAttemptOwnership = Effect.fn("SessionTransferCoordinator.verifyAttemptOwnership")(
    function* (input: {
      readonly transferId: SessionTransferId;
      readonly expectedAttempt: number;
      readonly expectedPhase: SessionTransferPhase;
      readonly expectedUpdatedAt: IsoDateTime;
    }): Effect.fn.Return<SessionTransferRecord | null> {
      if (
        currentTransferAttempt(input.transferId) !== input.expectedAttempt ||
        hasLiveActiveTransfer(input.transferId)
      ) {
        return null;
      }
      const latestOption = yield* repository
        .getById(input.transferId)
        .pipe(Effect.orElseSucceed(() => Option.none<SessionTransferRecord>()));
      if (Option.isNone(latestOption)) {
        return null;
      }
      const latest = latestOption.value;
      if (
        isTerminalSessionTransferPhase(latest.phase) ||
        latest.phase !== input.expectedPhase ||
        latest.updatedAt !== input.expectedUpdatedAt
      ) {
        return null;
      }
      return latest;
    },
  );

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
    options?: { readonly onPersistedBeforePublish?: () => void },
  ) {
    const updatedAt = yield* nowIso();
    const sanitizedErrorMessage =
      typeof fields.errorMessage === "string"
        ? redactSignedUrlsInMessage(fields.errorMessage)
        : fields.errorMessage;
    const updated = yield* repository
      .transitionPhase({
        ...fields,
        ...(sanitizedErrorMessage !== undefined ? { errorMessage: sanitizedErrorMessage } : {}),
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
    options?.onPersistedBeforePublish?.();
    yield* publishRecord(updated);
    return updated;
  });

  const inspectDestinationCommitOutcome = Effect.fn(
    "SessionTransferCoordinator.inspectDestinationCommitOutcome",
  )(function* (input: {
    readonly transferId: SessionTransferId;
    readonly direction: SessionTransferDirection;
    readonly destinationThreadId: ThreadId | null;
    readonly destinationMachineId: string | null;
    readonly destinationEnvironmentId: EnvironmentId | null;
    readonly boatEndpoint?: BoatRemoteEndpoint | null | undefined;
  }): Effect.fn.Return<"committed" | "not_committed" | "unknown"> {
    if (input.destinationThreadId === null) {
      return "not_committed";
    }
    if (input.direction === "boat_to_local") {
      return yield* projectionStore.getThread(input.destinationThreadId).pipe(
        Effect.map((thread) =>
          thread.transferOrigin?.transferId === input.transferId
            ? ("committed" as const)
            : ("not_committed" as const),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            error._tag === "ProjectionStoreThreadNotFoundError"
              ? ("not_committed" as const)
              : ("unknown" as const),
          ),
        ),
      );
    }

    // Destination is Boat (`local_to_boat`).
    let endpoint = input.boatEndpoint ?? null;
    if (endpoint === null) {
      if (input.destinationMachineId === null && input.destinationEnvironmentId === null) {
        return "unknown";
      }
      const accessOption = yield* getMachineProxyAccess({
        ...(input.destinationMachineId !== null ? { machineId: input.destinationMachineId } : {}),
        ...(input.destinationEnvironmentId !== null
          ? { environmentId: input.destinationEnvironmentId }
          : {}),
      }).pipe(Effect.option);
      if (Option.isNone(accessOption)) {
        return "unknown";
      }
      if (!RUNNING_BOAT_STATES.has(accessOption.value.state)) {
        return "unknown";
      }
      endpoint = {
        localUrl: accessOption.value.localUrl,
        bearerToken: accessOption.value.bearerToken,
      };
    }

    return yield* remoteClient.getThreadSummary(endpoint, input.destinationThreadId).pipe(
      Effect.map((summary) =>
        summary.transferOrigin?.transferId === input.transferId
          ? ("committed" as const)
          : ("not_committed" as const),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          error.code === "not_found" ? ("not_committed" as const) : ("unknown" as const),
        ),
      ),
    );
  });

  const abortDestinationSide = Effect.fn("SessionTransferCoordinator.abortDestinationSide")(
    function* (input: {
      readonly transferId: SessionTransferId;
      readonly direction: SessionTransferDirection;
      readonly destinationEnvironmentId: EnvironmentId | null;
      readonly destinationMachineId: string | null;
      readonly destinationThreadId: ThreadId | null;
      readonly boatEndpoint?: BoatRemoteEndpoint | null | undefined;
      readonly reason: string;
    }): Effect.fn.Return<"cleaned_up" | "not_cleaned_up" | "not_needed" | "failed"> {
      const abortInput: SessionTransferAbortInput = {
        transferId: input.transferId,
        role: "destination",
        ...(input.destinationThreadId !== null ? { threadId: input.destinationThreadId } : {}),
        reason: input.reason,
      };

      if (input.direction === "boat_to_local") {
        return yield* localEndpoints.abort(abortInput).pipe(
          Effect.map((result) =>
            result.cleanedUp ? ("cleaned_up" as const) : ("not_cleaned_up" as const),
          ),
          Effect.catch((error) => {
            if (error.code === "not_found") {
              return Effect.succeed("not_cleaned_up" as const);
            }
            return Effect.logWarning("Failed to abort local destination side of session transfer", {
              transferId: input.transferId,
              code: error.code,
              error: error.message,
            }).pipe(Effect.as("failed" as const));
          }),
        );
      }

      let endpoint = input.boatEndpoint ?? null;
      if (endpoint === null) {
        if (input.destinationMachineId === null && input.destinationEnvironmentId === null) {
          return "not_needed";
        }
        const accessResult = yield* Effect.result(
          getMachineProxyAccess({
            ...(input.destinationMachineId !== null
              ? { machineId: input.destinationMachineId }
              : {}),
            ...(input.destinationEnvironmentId !== null
              ? { environmentId: input.destinationEnvironmentId }
              : {}),
          }),
        );
        if (accessResult._tag === "Failure") {
          yield* Effect.logWarning(
            "Failed to resolve Boat proxy access while aborting destination side",
            {
              transferId: input.transferId,
              error: accessResult.failure.message,
            },
          );
          return "failed";
        }
        endpoint = {
          localUrl: accessResult.success.localUrl,
          bearerToken: accessResult.success.bearerToken,
        };
      }

      return yield* remoteClient.abort(endpoint, abortInput).pipe(
        Effect.map((result) =>
          result.cleanedUp ? ("cleaned_up" as const) : ("not_cleaned_up" as const),
        ),
        Effect.catch((error) => {
          if (error.code === "not_found") {
            return Effect.succeed("not_cleaned_up" as const);
          }
          return Effect.logWarning("Failed to abort remote destination side of session transfer", {
            transferId: input.transferId,
            code: error.code,
            error: error.message,
          }).pipe(Effect.as("failed" as const));
        }),
      );
    },
  );

  const abortSourceSide = Effect.fn("SessionTransferCoordinator.abortSourceSide")(
    function* (input: {
      readonly transferId: SessionTransferId;
      readonly direction: SessionTransferDirection;
      readonly sourceEnvironmentId: EnvironmentId;
      readonly sourceMachineId: string | null;
      readonly sourceThreadId: ThreadId;
      readonly boatEndpoint?: BoatRemoteEndpoint | null | undefined;
      readonly reason: string;
    }): Effect.fn.Return<"aborted" | "failed"> {
      const abortInput: SessionTransferAbortInput = {
        transferId: input.transferId,
        role: "source",
        threadId: input.sourceThreadId,
        reason: input.reason,
      };

      if (input.direction === "local_to_boat") {
        return yield* localEndpoints.abort(abortInput).pipe(
          Effect.as("aborted" as const),
          Effect.catch((error) => {
            if (error.code === "not_found") {
              return Effect.succeed("aborted" as const);
            }
            return Effect.logWarning("Failed to abort local source side of session transfer", {
              transferId: input.transferId,
              code: error.code,
              error: error.message,
            }).pipe(Effect.as("failed" as const));
          }),
        );
      }

      let endpoint = input.boatEndpoint ?? null;
      if (endpoint === null) {
        const accessResult = yield* Effect.result(
          getMachineProxyAccess({
            ...(input.sourceMachineId !== null ? { machineId: input.sourceMachineId } : {}),
            environmentId: input.sourceEnvironmentId,
          }),
        );
        if (accessResult._tag === "Failure") {
          yield* Effect.logWarning(
            "Failed to resolve Boat proxy access while aborting source side",
            {
              transferId: input.transferId,
              error: accessResult.failure.message,
            },
          );
          return "failed";
        }
        endpoint = {
          localUrl: accessResult.success.localUrl,
          bearerToken: accessResult.success.bearerToken,
        };
      }

      return yield* remoteClient.abort(endpoint, abortInput).pipe(
        Effect.as("aborted" as const),
        Effect.catch((error) => {
          if (error.code === "not_found") {
            return Effect.succeed("aborted" as const);
          }
          return Effect.logWarning("Failed to abort remote source side of session transfer", {
            transferId: input.transferId,
            code: error.code,
            error: error.message,
          }).pipe(Effect.as("failed" as const));
        }),
      );
    },
  );

  const resolveUncertainDestinationAndAbort = Effect.fn(
    "SessionTransferCoordinator.resolveUncertainDestinationAndAbort",
  )(function* (input: {
    readonly transferId: SessionTransferId;
    readonly direction: SessionTransferDirection;
    readonly destinationThreadId: ThreadId | null;
    readonly destinationMachineId: string | null;
    readonly destinationEnvironmentId: EnvironmentId | null;
    readonly boatEndpoint?: BoatRemoteEndpoint | null | undefined;
    readonly reason: string;
  }): Effect.fn.Return<"committed" | "confirmed_not_committed" | "unknown" | "abort_failed"> {
    const inspectInput = {
      transferId: input.transferId,
      direction: input.direction,
      destinationThreadId: input.destinationThreadId,
      destinationMachineId: input.destinationMachineId,
      destinationEnvironmentId: input.destinationEnvironmentId,
      ...(input.boatEndpoint !== undefined ? { boatEndpoint: input.boatEndpoint } : {}),
    };

    const initialOutcome = yield* inspectDestinationCommitOutcome(inspectInput);
    if (initialOutcome === "committed") {
      return "committed";
    }
    if (initialOutcome === "unknown") {
      return "unknown";
    }

    // Destination abort serializes behind any in-flight commitImport. If abort returns
    // { cleanedUp: false } (or not_found), re-inspect afterward to guarantee linearizability.
    const destAbortOutcome = yield* abortDestinationSide({
      transferId: input.transferId,
      direction: input.direction,
      destinationEnvironmentId: input.destinationEnvironmentId,
      destinationMachineId: input.destinationMachineId,
      destinationThreadId: input.destinationThreadId,
      ...(input.boatEndpoint !== undefined ? { boatEndpoint: input.boatEndpoint } : {}),
      reason: input.reason,
    });

    if (destAbortOutcome === "failed") {
      return "abort_failed";
    }
    if (destAbortOutcome === "cleaned_up" || destAbortOutcome === "not_needed") {
      return "confirmed_not_committed";
    }

    const postAbortOutcome = yield* inspectDestinationCommitOutcome(inspectInput);
    if (postAbortOutcome === "committed") {
      return "committed";
    }
    if (postAbortOutcome === "unknown") {
      return "unknown";
    }
    return "confirmed_not_committed";
  });

  const finalizeSourceAndComplete = Effect.fn(
    "SessionTransferCoordinator.finalizeSourceAndComplete",
  )(function* (input: {
    readonly transferId: SessionTransferId;
    readonly direction: SessionTransferDirection;
    readonly sourceEnvironmentId: EnvironmentId;
    readonly sourceMachineId: string | null;
    readonly sourceThreadId: ThreadId;
    readonly destinationEnvironmentId: EnvironmentId;
    readonly destinationEnvironmentName: typeof TrimmedNonEmptyString.Type | null;
    readonly destinationMachineId: typeof TrimmedNonEmptyString.Type | null;
    readonly destinationProjectId: ProjectId;
    readonly destinationThreadId: ThreadId;
    readonly warnings?: ReadonlyArray<string> | undefined;
    readonly currentPhase?: SessionTransferPhase | undefined;
    readonly boatEndpoint?: BoatRemoteEndpoint | null | undefined;
  }): Effect.fn.Return<"completed" | "pending_finalization"> {
    if (input.currentPhase !== "finalizing_source") {
      yield* transition(input.transferId, "finalizing_source", {
        phaseDetail: "Archiving source thread...",
        destinationEnvironmentId: input.destinationEnvironmentId,
        destinationEnvironmentName: input.destinationEnvironmentName,
        destinationMachineId: input.destinationMachineId,
        destinationProjectId: input.destinationProjectId,
        destinationThreadId: input.destinationThreadId,
        ...(input.warnings !== undefined ? { warnings: [...input.warnings] } : {}),
      }).pipe(Effect.ignore);
    }

    const finalizedAt = yield* nowIso();
    const finalizeInput: SessionTransferFinalizeSourceInput = {
      transferId: input.transferId,
      threadId: input.sourceThreadId,
      destination: {
        transferId: input.transferId,
        environmentId: input.destinationEnvironmentId,
        environmentName: input.destinationEnvironmentName,
        machineId: input.destinationMachineId,
        projectId: input.destinationProjectId,
        threadId: input.destinationThreadId,
        transferredAt: finalizedAt,
      },
    };

    const finalized = yield* Effect.gen(function* () {
      if (input.direction === "local_to_boat") {
        yield* localEndpoints.finalizeSource(finalizeInput);
      } else {
        let endpoint = input.boatEndpoint ?? null;
        if (endpoint === null) {
          const access = yield* getMachineProxyAccess({
            ...(input.sourceMachineId !== null ? { machineId: input.sourceMachineId } : {}),
            environmentId: input.sourceEnvironmentId,
          });
          endpoint = { localUrl: access.localUrl, bearerToken: access.bearerToken };
        }
        yield* remoteClient.finalizeSource(endpoint, finalizeInput);
      }
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Failed to finalize source; keeping transfer in finalizing_source", {
          transferId: input.transferId,
          error: error.message,
        }).pipe(Effect.as(false)),
      ),
    );

    if (finalized) {
      const completedAt = yield* nowIso();
      yield* transition(input.transferId, "completed", {
        phaseDetail: null,
        errorMessage: null,
        ...(input.warnings !== undefined ? { warnings: [...input.warnings] } : {}),
        completedAt,
      }).pipe(Effect.ignore);
      return "completed";
    }

    yield* transition(input.transferId, "finalizing_source", {
      phaseDetail: "Destination committed; awaiting source archival retry...",
      ...(input.warnings !== undefined ? { warnings: [...input.warnings] } : {}),
    }).pipe(Effect.ignore);
    return "pending_finalization";
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

    const boatMachineMeta = yield* getBoatDaemonMachineMeta({
      machineId: boatAccess.machineId,
      environmentId: boatAccess.environmentId,
    });

    // Read-scoped preflight must NEVER wake a sleeping/stopped Boat via authenticated HTTP/WS calls.
    if (!RUNNING_BOAT_STATES.has(boatAccess.state)) {
      warnings.push(
        `Boat machine "${boatAccess.machineName}" is currently ${boatAccess.state} and will wake when the transfer starts.`,
      );

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

        const sourceState: SessionTransferSourceState = {
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

        let unsupportedReason: string | null = null;
        let resolvedTargetProjectId: ProjectId | null = null;
        let needsProjectSelection = false;
        let willAutoCloneProject = false;
        const sleepingCandidates: ReadonlyArray<BoatProjectResolutionCandidate> | null =
          boatMachineMeta?.projects !== undefined
            ? boatMachineMeta.projects.map((dp) => ({
                id: ProjectId.make(dp.id),
                title: dp.title ?? dp.id,
                originProjectId: dp.originProjectId ?? null,
                repoKey: dp.repoKey ?? null,
              }))
            : null;

        if (!gitProbe.isGitRepo) {
          unsupportedReason = "Only git repositories can be transferred between Local and Boat.";
        } else {
          const resolution = resolveBoatTargetProject({
            candidates: sleepingCandidates,
            explicitTargetProjectId: input.targetProjectId,
            sourceProjectId: localProject.id,
            localRepoKey: normalizeRepoKey(localRepoIdentity),
          });
          if (resolution.kind === "not_found") {
            return yield* toSessionTransferError(
              "not_found",
              `Target Boat project ${resolution.targetProjectId} was not found on ${boatAccess.machineName}.`,
            );
          }
          if (resolution.kind === "unverified_explicit") {
            needsProjectSelection = true;
            warnings.push(
              `Boat machine "${boatAccess.machineName}" is ${boatAccess.state} and its project list is unavailable; wake the machine to verify target project "${resolution.targetProjectId}".`,
            );
          } else if (resolution.kind === "matched") {
            resolvedTargetProjectId = resolution.match.id;
          } else if (resolution.kind === "ambiguous") {
            needsProjectSelection = true;
          } else {
            willAutoCloneProject = true;
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

        return {
          ready: unsupportedReason === null && !needsProjectSelection && !needsRunningConfirmation,
          warnings,
          needsProjectSelection,
          candidateProjects: [],
          needsCloneDestination: false,
          needsModelSelection: false,
          availableModels: [],
          needsRunningConfirmation,
          unsupportedReason,
          sourceState,
          resolvedTargetProjectId,
          resolvedModelSelection: input.modelSelectionOverride ?? null,
          willAutoCloneProject,
        } satisfies SessionTransferPreflightResult;
      }

      // boat_to_local while Boat is asleep: inspect only local state, issue zero Boat HTTP calls.
      const [localProjects, localProviders] = yield* Effect.all([
        listAllLocalProjects(),
        providerRegistry.getProviders,
      ]);

      let resolvedTargetProjectId: ProjectId | null = null;
      let candidateProjects: SessionTransferCandidateProject[] = [];
      if (input.targetProjectId !== undefined) {
        const explicit = localProjects.find((p) => p.id === input.targetProjectId);
        if (!explicit) {
          return yield* toSessionTransferError(
            "not_found",
            `Target local project ${input.targetProjectId} was not found.`,
          );
        }
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

      const availableModels = collectAvailableModels(localProviders);
      let needsModelSelection = false;
      let resolvedModelSelection: ModelSelection | null = null;
      if (input.modelSelectionOverride !== undefined) {
        const modelRes = resolveModelSelectionOnDestination(
          input.modelSelectionOverride,
          localProviders,
        );
        needsModelSelection = modelRes.needsModelSelection;
        resolvedModelSelection = modelRes.resolved;
        if (needsModelSelection) {
          warnings.push(
            `Model "${input.modelSelectionOverride.model}" on provider "${input.modelSelectionOverride.instanceId}" is not available on the destination; select a replacement model.`,
          );
        }
      }

      return {
        ready: !needsModelSelection,
        warnings,
        needsProjectSelection: false,
        candidateProjects,
        needsCloneDestination: false,
        needsModelSelection,
        availableModels,
        needsRunningConfirmation: false,
        unsupportedReason: null,
        resolvedTargetProjectId,
        resolvedModelSelection,
        willAutoCloneProject: false,
      } satisfies SessionTransferPreflightResult;
    }

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
        const awakeCandidates = buildAwakeBoatProjectCandidates(boatShell.projects, daemonProjects);
        const resolution = resolveBoatTargetProject({
          candidates: awakeCandidates,
          explicitTargetProjectId: input.targetProjectId,
          sourceProjectId: localProject.id,
          localRepoKey: normalizeRepoKey(localRepoIdentity),
        });

        const toCandidateProject = (
          candidate: BoatProjectResolutionCandidate,
          matchReason: SessionTransferCandidateProject["matchReason"],
        ): SessionTransferCandidateProject => ({
          projectId: candidate.id,
          name: TrimmedNonEmptyString.make(candidate.title),
          workspaceRoot: TrimmedNonEmptyString.make(candidate.workspaceRoot ?? candidate.title),
          ...(candidate.repositoryIdentity !== undefined
            ? { repositoryIdentity: candidate.repositoryIdentity }
            : {}),
          matchReason,
        });

        if (resolution.kind === "not_found") {
          return yield* toSessionTransferError(
            "not_found",
            `Target Boat project ${resolution.targetProjectId} was not found on ${boatAccess.machineName}.`,
          );
        }
        if (resolution.kind === "matched") {
          resolvedTargetProjectId = resolution.match.id;
          candidateProjects = [toCandidateProject(resolution.match, resolution.matchReason)];
        } else if (resolution.kind === "ambiguous") {
          needsProjectSelection = true;
          candidateProjects = resolution.matches.map((match) =>
            toCandidateProject(match, resolution.matchReason),
          );
        } else if (resolution.kind === "missing") {
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
        if (!explicit) {
          return yield* toSessionTransferError(
            "not_found",
            `Target local project ${input.targetProjectId} was not found.`,
          );
        }
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
      input.modelSelectionOverride !== undefined ? undefined : sourceDriverKind,
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
      if (Option.isNone(existing)) {
        return yield* toSessionTransferError(
          "not_found",
          `Target local project ${input.explicitTargetProjectId} was not found.`,
          input.transferId,
        );
      }
      return existing.value.id;
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

    const canonicalCloneDest = normalizeCanonicalWorkspaceRoot(cloneDest);
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
    const existingByCanonical = localProjects.find(
      (lp) => normalizeCanonicalWorkspaceRoot(lp.workspaceRoot) === canonicalCloneDest,
    );
    if (existingByCanonical) {
      return existingByCanonical.id;
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
    const machineMeta = yield* getBoatDaemonMachineMeta({
      machineId: input.boatAccess.machineId,
      environmentId: input.boatAccess.environmentId,
    });
    const daemonProjects = machineMeta?.projects ?? [];
    const localKey = normalizeRepoKey(input.manifest.workspace.repositoryIdentity);
    const resolution = resolveBoatTargetProject({
      candidates: buildAwakeBoatProjectCandidates(boatShell.projects, daemonProjects),
      explicitTargetProjectId: input.explicitTargetProjectId,
      sourceProjectId: input.manifest.sourceProjectId,
      localRepoKey: localKey,
    });

    if (resolution.kind === "not_found") {
      return yield* toSessionTransferError(
        "not_found",
        `Target Boat project ${resolution.targetProjectId} was not found on ${input.boatAccess.machineName}.`,
        input.transferId,
      );
    }
    if (resolution.kind === "matched") {
      return resolution.match.id;
    }
    if (resolution.kind === "ambiguous") {
      const detail =
        resolution.matchReason === "origin_project_id"
          ? `Multiple projects on Boat machine ${input.boatAccess.machineName} match source project ${input.manifest.sourceProjectId}; specify targetProjectId.`
          : `Multiple projects on Boat machine ${input.boatAccess.machineName} match this repository; specify targetProjectId.`;
      return yield* toSessionTransferError("preflight_required", detail, input.transferId);
    }

    // Project is missing on Boat: clone via sail-boatd `add_project` if remote exists, else init fresh project.
    if (localKey !== null) {
      const previousProjectIds = new Set(boatShell.projects.map((p) => p.id));
      const addResult = yield* boatSupervisor
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
      const parsedAdd = parseAddProjectResult(addResult.data);

      // 1. Identify strictly by returned projectId.
      if (parsedAdd.projectId !== null) {
        const foundById = refreshedShell.projects.find((p) => p.id === parsedAdd.projectId);
        if (foundById) return foundById.id;
        return yield* toSessionTransferError(
          "workspace_error",
          `Cloned project ${parsedAdd.projectId} was not found on Boat machine ${input.boatAccess.machineName} after add_project.`,
          input.transferId,
        );
      }

      // 2. Identify strictly by canonical normalized workspaceRoot path.
      if (parsedAdd.workspaceRoot !== null) {
        const targetCanonical = normalizeCanonicalWorkspaceRoot(parsedAdd.workspaceRoot);
        const foundByRoot = refreshedShell.projects.find(
          (p) => normalizeCanonicalWorkspaceRoot(p.workspaceRoot) === targetCanonical,
        );
        if (foundByRoot) return foundByRoot.id;
        return yield* toSessionTransferError(
          "workspace_error",
          `Cloned project at ${parsedAdd.workspaceRoot} was not found on Boat machine ${input.boatAccess.machineName} after add_project.`,
          input.transferId,
        );
      }

      // 3. Identify by daemon originProjectId recorded by add_project.
      const refreshedMeta = yield* getBoatDaemonMachineMeta({
        machineId: input.boatAccess.machineId,
        environmentId: input.boatAccess.environmentId,
      });
      const refreshedCandidates = buildAwakeBoatProjectCandidates(
        refreshedShell.projects,
        refreshedMeta?.projects ?? [],
      );
      const refreshedOriginMatches = refreshedCandidates.filter(
        (c) => c.originProjectId === input.manifest.sourceProjectId,
      );
      if (refreshedOriginMatches.length === 1 && refreshedOriginMatches[0]) {
        return refreshedOriginMatches[0].id;
      }
      if (refreshedOriginMatches.length > 1) {
        return yield* toSessionTransferError(
          "preflight_required",
          `Multiple projects on Boat machine ${input.boatAccess.machineName} match source project ${input.manifest.sourceProjectId}; specify targetProjectId.`,
          input.transferId,
        );
      }

      // 4. Identify strictly by unique newly-added repository-identity match (never by title).
      const newlyAddedByRepo = refreshedCandidates.filter(
        (c) => !previousProjectIds.has(c.id) && repoKeysMatch(c.repoKey, localKey),
      );
      if (newlyAddedByRepo.length === 1 && newlyAddedByRepo[0]) {
        return newlyAddedByRepo[0].id;
      }

      return yield* toSessionTransferError(
        "workspace_error",
        `Could not strictly identify the cloned project on Boat machine ${input.boatAccess.machineName} after add_project.`,
        input.transferId,
      );
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
      readonly confirmedRunningPause: boolean;
      readonly entry: ActiveTransferEntry;
    }) {
      const { transferId, direction, entry } = params;
      const warnings: string[] = [];

      let boatAccess: BoatSupervisor.BoatMachineProxyAccess | null = null;
      let boatEndpoint: BoatRemoteEndpoint | null = null;
      let localEnvDescriptor: Effect.Success<typeof serverEnvironment.getDescriptor> | null = null;
      let prepareAttempted = false;
      let stageAttempted = false;
      let commitAttempted = false;
      let commitConfirmed = false;
      let stagedDestinationProjectId: ProjectId | null = null;
      let stagedDestinationThreadId: ThreadId | null = null;

      const isCurrentAttempt = (): boolean =>
        currentTransferAttempt(transferId) === entry.attemptId;
      const releaseActiveEntry = (): void => {
        if (activeTransfers.get(transferId) === entry) {
          activeTransfers.delete(transferId);
        }
      };

      const checkCancelled = (): Effect.Effect<void, SessionTransferError> =>
        entry.cancelled
          ? Effect.fail(toSessionTransferError("cancelled", "Transfer cancelled.", transferId))
          : Effect.void;

      const cleanupBeforeCommit = Effect.fn("SessionTransferCoordinator.cleanupBeforeCommit")(
        function* (
          reason: string,
          options?: { readonly skipDestination?: boolean },
        ): Effect.fn.Return<{
          readonly allAborted: boolean;
          readonly destinationFailed: boolean;
          readonly sourceFailed: boolean;
        }> {
          if (commitConfirmed || entry.committed || !isCurrentAttempt()) {
            return { allAborted: true, destinationFailed: false, sourceFailed: false };
          }
          let destinationFailed = false;
          if (stageAttempted && !options?.skipDestination) {
            const destAbortOutcome = yield* abortDestinationSide({
              transferId,
              direction,
              destinationEnvironmentId:
                direction === "local_to_boat"
                  ? (boatAccess?.environmentId ?? params.targetEnvironmentId ?? null)
                  : (localEnvDescriptor?.environmentId ?? null),
              destinationMachineId:
                direction === "local_to_boat"
                  ? (boatAccess?.machineId ?? params.targetMachineId ?? null)
                  : null,
              destinationThreadId: stagedDestinationThreadId,
              boatEndpoint,
              reason,
            });
            if (destAbortOutcome === "failed") {
              destinationFailed = true;
            }
          }
          let sourceFailed = false;
          if (prepareAttempted) {
            const sourceAbortOutcome = yield* abortSourceSide({
              transferId,
              direction,
              sourceEnvironmentId: params.sourceEnvironmentId,
              sourceMachineId:
                direction === "boat_to_local" ? (boatAccess?.machineId ?? null) : null,
              sourceThreadId: params.sourceThreadId,
              boatEndpoint,
              reason,
            });
            if (sourceAbortOutcome === "failed") {
              sourceFailed = true;
            }
          }
          return {
            allAborted: !destinationFailed && !sourceFailed,
            destinationFailed,
            sourceFailed,
          };
        },
      );

      const recordPendingCleanup = Effect.fn("SessionTransferCoordinator.recordPendingCleanup")(
        function* (input: {
          readonly cancelled: boolean;
          readonly errorMessage: string;
          readonly destinationFailed: boolean;
          readonly sourceFailed: boolean;
        }) {
          const failedSides = [
            ...(input.destinationFailed ? ["destination"] : []),
            ...(input.sourceFailed ? ["source"] : []),
          ].join(" and ");
          const safeErrorMessage = redactSignedUrlsInMessage(input.errorMessage);
          yield* Effect.logWarning(
            "Pre-commit abort incomplete; keeping transfer non-terminal for retry",
            {
              transferId,
              cancelled: input.cancelled,
              failedSides,
              error: safeErrorMessage,
            },
          );
          if (!isCurrentAttempt()) {
            return;
          }
          const currentOption = yield* repository
            .getById(transferId)
            .pipe(Effect.orElseSucceed(() => Option.none<SessionTransferRecord>()));
          if (
            Option.isNone(currentOption) ||
            isTerminalSessionTransferPhase(currentOption.value.phase)
          ) {
            return;
          }
          const current = currentOption.value;
          yield* transition(
            transferId,
            current.phase,
            {
              expectedPhases: [current.phase],
              phaseDetail: input.cancelled
                ? `Cancellation awaiting ${failedSides} cleanup...`
                : `Transfer failed; awaiting ${failedSides} cleanup...`,
              errorMessage: safeErrorMessage,
              warnings: [...warnings],
              ...(direction === "local_to_boat" && boatAccess !== null
                ? {
                    ...(current.destinationEnvironmentId === null
                      ? { destinationEnvironmentId: boatAccess.environmentId }
                      : {}),
                    ...(current.destinationMachineId === null
                      ? { destinationMachineId: toNonEmptyTrimmed(boatAccess.machineId) }
                      : {}),
                  }
                : {}),
              ...(stagedDestinationProjectId !== null && current.destinationProjectId === null
                ? { destinationProjectId: stagedDestinationProjectId }
                : {}),
              ...(stagedDestinationThreadId !== null && current.destinationThreadId === null
                ? { destinationThreadId: stagedDestinationThreadId }
                : {}),
            },
            { onPersistedBeforePublish: releaseActiveEntry },
          ).pipe(Effect.ignore);
        },
      );

      const handleUncertainCommit = Effect.fn("SessionTransferCoordinator.handleUncertainCommit")(
        function* (
          reason: string,
        ): Effect.fn.Return<"resolved_committed" | "confirmed_not_committed" | "unknown"> {
          if (!isCurrentAttempt()) {
            return "unknown";
          }
          if (!commitAttempted || commitConfirmed) {
            return commitConfirmed ? "resolved_committed" : "confirmed_not_committed";
          }
          const destEnvId =
            direction === "local_to_boat"
              ? (boatAccess?.environmentId ?? params.targetEnvironmentId ?? null)
              : (localEnvDescriptor?.environmentId ?? null);
          const destMachineId =
            direction === "local_to_boat"
              ? (boatAccess?.machineId ?? params.targetMachineId ?? null)
              : null;
          const resolution = yield* resolveUncertainDestinationAndAbort({
            transferId,
            direction,
            destinationThreadId: stagedDestinationThreadId,
            destinationMachineId: destMachineId,
            destinationEnvironmentId: destEnvId,
            boatEndpoint,
            reason,
          });
          if (resolution === "committed") {
            commitConfirmed = true;
            entry.committed = true;
            if (
              destEnvId !== null &&
              stagedDestinationProjectId !== null &&
              stagedDestinationThreadId !== null
            ) {
              yield* finalizeSourceAndComplete({
                transferId,
                direction,
                sourceEnvironmentId: params.sourceEnvironmentId,
                sourceMachineId:
                  direction === "boat_to_local" ? (boatAccess?.machineId ?? null) : null,
                sourceThreadId: params.sourceThreadId,
                destinationEnvironmentId: destEnvId,
                destinationEnvironmentName:
                  direction === "local_to_boat"
                    ? toNonEmptyTrimmed(boatAccess?.machineName)
                    : toNonEmptyTrimmed(localEnvDescriptor?.label),
                destinationMachineId:
                  direction === "local_to_boat" ? toNonEmptyTrimmed(boatAccess?.machineId) : null,
                destinationProjectId: stagedDestinationProjectId,
                destinationThreadId: stagedDestinationThreadId,
                warnings,
                boatEndpoint,
              });
            }
            return "resolved_committed";
          }
          if (resolution === "confirmed_not_committed") {
            return "confirmed_not_committed";
          }
          return "unknown";
        },
      );

      const run = Effect.gen(function* () {
        yield* checkCancelled();
        const localEnv = yield* serverEnvironment.getDescriptor;
        localEnvDescriptor = localEnv;

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

        // Validate running confirmation and destination model availability BEFORE calling prepareSource.
        let resolvedModelSelectionOverride: ModelSelection | undefined = undefined;
        if (direction === "local_to_boat") {
          const [projection, localProviders, remoteConfig] = yield* Effect.all([
            projectionStore
              .getThreadProjection(params.sourceThreadId)
              .pipe(
                Effect.mapError((error) =>
                  toSessionTransferError(
                    error._tag === "ProjectionStoreThreadNotFoundError" ? "not_found" : "internal",
                    error.message,
                    transferId,
                    error,
                  ),
                ),
              ),
            providerRegistry.getProviders,
            remoteClient.getServerConfig(boatEndpoint),
          ]);
          if (!remoteConfig.sessionTransferSupported) {
            return yield* toSessionTransferError(
              "unsupported",
              "This Boat machine runs an older Sail server that does not support session transfer yet.",
              transferId,
            );
          }
          yield* enforceRunningConfirmation({
            wasRunning: projection.runs.some((run) => WORKING_RUN_STATUSES.has(run.status)),
            hasPendingRuntimeRequest: projection.runtimeRequests.some(
              (req) => req.status === "pending",
            ),
            activeSubagentCount: projection.subagents.filter((sub) =>
              ACTIVE_SUBAGENT_STATUSES.has(sub.status),
            ).length,
            confirmedRunningPause: params.confirmedRunningPause,
            transferId,
          });
          const sourceModelSelection = projection.thread.modelSelection;
          const desiredModel = params.modelSelectionOverride ?? sourceModelSelection;
          const sourceDriverKind = localProviders.find(
            (p) => p.instanceId === sourceModelSelection.instanceId,
          )?.driver;
          const resolvedModel = yield* validateModelSelectionForDestination({
            desiredModel,
            isOverride: params.modelSelectionOverride != null,
            destinationProviders: remoteConfig.providers,
            sourceDriverKind,
            transferId,
          });
          if (
            params.modelSelectionOverride != null ||
            resolvedModel.instanceId !== sourceModelSelection.instanceId ||
            resolvedModel.model !== sourceModelSelection.model
          ) {
            resolvedModelSelectionOverride = resolvedModel;
          }
        } else {
          const [remoteThread, localProviders, remoteConfigOption] = yield* Effect.all([
            remoteClient.getThreadSummary(boatEndpoint, params.sourceThreadId),
            providerRegistry.getProviders,
            remoteClient.getServerConfig(boatEndpoint).pipe(Effect.option),
          ]);
          yield* enforceRunningConfirmation({
            wasRunning: remoteThread.wasRunning,
            hasPendingRuntimeRequest: remoteThread.pendingRuntimeRequests.length > 0,
            activeSubagentCount: remoteThread.activeSubagentCount,
            confirmedRunningPause: params.confirmedRunningPause,
            transferId,
          });
          const sourceModelSelection = remoteThread.modelSelection;
          const desiredModel = params.modelSelectionOverride ?? sourceModelSelection;
          const sourceDriverKind =
            remoteThread.providerDriverKind ??
            (Option.isSome(remoteConfigOption)
              ? remoteConfigOption.value.providers.find(
                  (p) => p.instanceId === sourceModelSelection.instanceId,
                )?.driver
              : undefined);
          const resolvedModel = yield* validateModelSelectionForDestination({
            desiredModel,
            isOverride: params.modelSelectionOverride != null,
            destinationProviders: localProviders,
            sourceDriverKind,
            transferId,
          });
          if (
            params.modelSelectionOverride != null ||
            resolvedModel.instanceId !== sourceModelSelection.instanceId ||
            resolvedModel.model !== sourceModelSelection.model
          ) {
            resolvedModelSelectionOverride = resolvedModel;
          }
        }

        yield* checkCancelled();

        // Step 2: Pause & export source thread.
        // Build payload before writing `exporting_source` so the crash-safety WAL transition
        // happens immediately ahead of the `prepareSource` RPC.
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
        yield* transition(transferId, "pausing_source", {
          phaseDetail: "Pausing active work on source thread...",
        });
        yield* checkCancelled();
        yield* transition(transferId, "exporting_source", {
          phaseDetail: "Exporting thread history and workspace bundle...",
        });

        // Mark attempted BEFORE invoking RPC so interruption/drop still calls idempotent abort.
        prepareAttempted = true;
        const prepared = yield* direction === "local_to_boat"
          ? localEndpoints.prepareSource(prepareInput)
          : remoteClient.prepareSource(boatEndpoint, prepareInput);
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
        // Build the RPC payload before persisting the durable `transferring_workspace` WAL phase
        // so the phase write happens immediately before `stageImport` (required for crash safety
        // so recovery aborts destination staging if the process crashes during or after the RPC).
        const stageInput: SessionTransferStageImportInput = {
          transferId,
          manifest: prepared.manifest,
          targetProjectId: destinationProjectId,
          ...(resolvedModelSelectionOverride !== undefined
            ? { modelSelectionOverride: resolvedModelSelectionOverride }
            : {}),
        };
        yield* transition(transferId, "transferring_workspace", {
          phaseDetail: "Staging workspace import...",
          destinationProjectId,
        });

        // Mark attempted BEFORE invoking RPC so interruption/drop still calls idempotent abort.
        stageAttempted = true;
        const staged = yield* direction === "local_to_boat"
          ? remoteClient.stageImport(boatEndpoint, stageInput)
          : localEndpoints.stageImport(stageInput);
        stagedDestinationProjectId = staged.destinationProjectId;
        stagedDestinationThreadId = staged.destinationThreadId;
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
            // Do NOT mark entry.committed until commitImport actually succeeds.
            const commitInput: SessionTransferCommitImportInput = {
              transferId,
              manifest: prepared.manifest,
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              ...(resolvedModelSelectionOverride !== undefined
                ? { modelSelectionOverride: resolvedModelSelectionOverride }
                : {}),
              autoResume: params.autoResume,
              attachmentIdMap,
            };
            yield* transition(transferId, "committing_target", {
              phaseDetail: "Importing workspace and history on destination...",
              destinationProjectId: staged.destinationProjectId,
              destinationThreadId: staged.destinationThreadId,
              destinationBranch: staged.destinationBranch,
              destinationWorktreePath: staged.destinationWorktreePath,
              warnings: [...warnings],
            });

            commitAttempted = true;
            const committed = yield* direction === "local_to_boat"
              ? remoteClient.commitImport(boatEndpoint!, commitInput)
              : localEndpoints.commitImport(commitInput);
            commitConfirmed = true;
            entry.committed = true;
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
            yield* transition(
              transferId,
              "completed",
              {
                phaseDetail: null,
                errorMessage: null,
                warnings: [...warnings],
                completedAt,
              },
              { onPersistedBeforePublish: releaseActiveEntry },
            );
          }),
          Fiber.interrupt(keepAwakeFiber).pipe(Effect.ignore),
        );
      });

      yield* run.pipe(
        Effect.catch((error) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (!isCurrentAttempt()) {
                return;
              }
              if (commitConfirmed || entry.committed) {
                // Destination already committed; never transition to terminal `failed` on a
                // post-commit finalizeSource error (including internal/transient errors). Keep
                // the transfer in `finalizing_source` so startup reconciliation can finish archival.
                const safeMessage = redactSignedUrlsInMessage(error.message);
                yield* Effect.logWarning(
                  "Post-commit source finalization failed; keeping transfer in finalizing_source",
                  { transferId, code: error.code, error: safeMessage },
                );
                yield* transition(
                  transferId,
                  "finalizing_source",
                  {
                    phaseDetail: "Destination committed; awaiting source archival retry...",
                    errorMessage: safeMessage,
                    warnings: [...warnings],
                  },
                  { onPersistedBeforePublish: releaseActiveEntry },
                ).pipe(Effect.ignore);
                return;
              }

              const cancelled = entry.cancelled || error.code === "cancelled";
              const safeMessage = redactSignedUrlsInMessage(error.message);
              const abortReason = cancelled ? "Transfer cancelled" : safeMessage;
              let destinationAlreadyAborted = false;
              if (commitAttempted) {
                const outcome = yield* handleUncertainCommit(abortReason);
                if (outcome === "resolved_committed" || outcome === "unknown") {
                  return;
                }
                destinationAlreadyAborted = true;
              }

              const cleanupOutcome = yield* cleanupBeforeCommit(abortReason, {
                skipDestination: destinationAlreadyAborted,
              });
              if (!cleanupOutcome.allAborted) {
                const failedSides = [
                  ...(cleanupOutcome.destinationFailed ? ["destination"] : []),
                  ...(cleanupOutcome.sourceFailed ? ["source"] : []),
                ].join(" and ");
                yield* recordPendingCleanup({
                  cancelled,
                  errorMessage: cancelled
                    ? `Failed to abort ${failedSides} during cancellation; transfer remains non-terminal for cleanup retry.`
                    : safeMessage,
                  destinationFailed: cleanupOutcome.destinationFailed,
                  sourceFailed: cleanupOutcome.sourceFailed,
                });
                return;
              }
              if (!isCurrentAttempt()) {
                return;
              }
              const completedAt = yield* nowIso();
              yield* transition(
                transferId,
                cancelled ? "cancelled" : "failed",
                {
                  phaseDetail: null,
                  errorMessage: cancelled ? null : safeMessage,
                  warnings: [...warnings],
                  completedAt,
                },
                { onPersistedBeforePublish: releaseActiveEntry },
              ).pipe(Effect.ignore);
            }),
          ),
        ),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            if (commitConfirmed || entry.committed || !isCurrentAttempt()) return;
            let destinationAlreadyAborted = false;
            if (commitAttempted) {
              const outcome = yield* handleUncertainCommit("Transfer cancelled");
              if (outcome === "resolved_committed" || outcome === "unknown") {
                return;
              }
              destinationAlreadyAborted = true;
            }
            const cleanupOutcome = yield* cleanupBeforeCommit("Transfer cancelled", {
              skipDestination: destinationAlreadyAborted,
            });
            if (!cleanupOutcome.allAborted) {
              const failedSides = [
                ...(cleanupOutcome.destinationFailed ? ["destination"] : []),
                ...(cleanupOutcome.sourceFailed ? ["source"] : []),
              ].join(" and ");
              yield* recordPendingCleanup({
                cancelled: true,
                errorMessage: `Failed to abort ${failedSides} during cancellation; transfer remains non-terminal for cleanup retry.`,
                destinationFailed: cleanupOutcome.destinationFailed,
                sourceFailed: cleanupOutcome.sourceFailed,
              });
              return;
            }
            if (!isCurrentAttempt()) return;
            const completedAt = yield* nowIso();
            yield* transition(
              transferId,
              "cancelled",
              {
                phaseDetail: null,
                errorMessage: null,
                warnings: [...warnings],
                completedAt,
              },
              { onPersistedBeforePublish: releaseActiveEntry },
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (activeTransfers.get(transferId) === entry) {
              activeTransfers.delete(transferId);
            }
          }),
        ),
      );
    },
  );

  const startBody = Effect.fn("SessionTransferCoordinator.startBody")(function* (
    input: SessionTransferStartInput,
    transferId: SessionTransferId,
  ) {
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

    // Resolve initial source projectId & environment names, and enforce running confirmation +
    // destination model validation BEFORE persisting / launching the worker or calling prepareSource.
    let sourceProjectId: ProjectId;
    let sourceEnvironmentName: typeof TrimmedNonEmptyString.Type | null;
    let sourceMachineId: typeof TrimmedNonEmptyString.Type | null = null;
    let destinationEnvironmentId: EnvironmentId | null = null;
    let destinationEnvironmentName: typeof TrimmedNonEmptyString.Type | null = null;
    let destinationMachineId: typeof TrimmedNonEmptyString.Type | null = null;
    let sourceWasRunning = false;
    let hadPendingRuntimeRequest = false;

    if (input.direction === "local_to_boat" && input.target.kind === "boat") {
      const projection = yield* projectionStore
        .getThreadProjection(input.sourceThreadId)
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
      sourceWasRunning = projection.runs.some((run) => WORKING_RUN_STATUSES.has(run.status));
      hadPendingRuntimeRequest = projection.runtimeRequests.some((req) => req.status === "pending");
      const activeSubagentCount = projection.subagents.filter((sub) =>
        ACTIVE_SUBAGENT_STATUSES.has(sub.status),
      ).length;
      yield* enforceRunningConfirmation({
        wasRunning: sourceWasRunning,
        hasPendingRuntimeRequest: hadPendingRuntimeRequest,
        activeSubagentCount,
        confirmedRunningPause: input.confirmedRunningPause,
        transferId,
      });

      const boatAccessOption = yield* getMachineProxyAccess({
        machineId: input.target.machineId,
        ...(input.target.environmentId !== undefined
          ? { environmentId: input.target.environmentId }
          : {}),
      }).pipe(Effect.option);
      if (
        Option.isSome(boatAccessOption) &&
        RUNNING_BOAT_STATES.has(boatAccessOption.value.state)
      ) {
        const boatEndpoint: BoatRemoteEndpoint = {
          localUrl: boatAccessOption.value.localUrl,
          bearerToken: boatAccessOption.value.bearerToken,
        };
        const [remoteConfig, localProviders] = yield* Effect.all([
          remoteClient.getServerConfig(boatEndpoint),
          providerRegistry.getProviders,
        ]);
        if (!remoteConfig.sessionTransferSupported) {
          return yield* toSessionTransferError(
            "unsupported",
            "This Boat machine runs an older Sail server that does not support session transfer yet.",
            transferId,
          );
        }
        const desiredModel = input.modelSelectionOverride ?? projection.thread.modelSelection;
        const sourceDriverKind = localProviders.find(
          (p) => p.instanceId === projection.thread.modelSelection.instanceId,
        )?.driver;
        yield* validateModelSelectionForDestination({
          desiredModel,
          isOverride: input.modelSelectionOverride !== undefined,
          destinationProviders: remoteConfig.providers,
          sourceDriverKind,
          transferId,
        });
      }

      sourceProjectId = projection.thread.projectId;
      sourceEnvironmentName = toNonEmptyTrimmed(localEnv.label);
      destinationMachineId = toNonEmptyTrimmed(input.target.machineId);
      destinationEnvironmentId = input.target.environmentId ?? null;
      destinationEnvironmentName = input.target.machineName ?? null;
    } else {
      const [boatAccess, localProviders] = yield* Effect.all([
        getMachineProxyAccess({
          environmentId: input.sourceEnvironmentId,
        }),
        providerRegistry.getProviders,
      ]);
      const boatEndpoint: BoatRemoteEndpoint = {
        localUrl: boatAccess.localUrl,
        bearerToken: boatAccess.bearerToken,
      };
      if (RUNNING_BOAT_STATES.has(boatAccess.state)) {
        const [remoteThread, remoteConfigOption] = yield* Effect.all([
          remoteClient.getThreadSummary(boatEndpoint, input.sourceThreadId),
          remoteClient.getServerConfig(boatEndpoint).pipe(Effect.option),
        ]);
        sourceWasRunning = remoteThread.wasRunning;
        hadPendingRuntimeRequest = remoteThread.pendingRuntimeRequests.length > 0;
        yield* enforceRunningConfirmation({
          wasRunning: sourceWasRunning,
          hasPendingRuntimeRequest: hadPendingRuntimeRequest,
          activeSubagentCount: remoteThread.activeSubagentCount,
          confirmedRunningPause: input.confirmedRunningPause,
          transferId,
        });
        const desiredModel = input.modelSelectionOverride ?? remoteThread.modelSelection;
        const sourceDriverKind =
          remoteThread.providerDriverKind ??
          (Option.isSome(remoteConfigOption)
            ? remoteConfigOption.value.providers.find(
                (p) => p.instanceId === remoteThread.modelSelection.instanceId,
              )?.driver
            : undefined);
        yield* validateModelSelectionForDestination({
          desiredModel,
          isOverride: input.modelSelectionOverride !== undefined,
          destinationProviders: localProviders,
          sourceDriverKind,
          transferId,
        });
        sourceProjectId = remoteThread.projectId;
      } else {
        if (input.modelSelectionOverride !== undefined) {
          yield* validateModelSelectionForDestination({
            desiredModel: input.modelSelectionOverride,
            isOverride: true,
            destinationProviders: localProviders,
            transferId,
          });
        }
        sourceProjectId = ProjectId.make("unknown");
      }
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
      sourceWasRunning,
      autoResume: input.autoResume ?? true,
      hadPendingRuntimeRequest,
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

    return yield* withTransferLock(
      transferId,
      Effect.gen(function* () {
        const latestExistingById = yield* repository
          .getById(transferId)
          .pipe(
            Effect.mapError((error) =>
              toSessionTransferError("internal", error.message, transferId, error),
            ),
          );
        if (Option.isSome(latestExistingById)) {
          return latestExistingById.value;
        }

        const latestInFlightForThread = yield* repository
          .findInFlightForThread({
            sourceEnvironmentId: input.sourceEnvironmentId,
            sourceThreadId: input.sourceThreadId,
          })
          .pipe(
            Effect.mapError((error) =>
              toSessionTransferError("internal", error.message, transferId, error),
            ),
          );
        if (Option.isSome(latestInFlightForThread)) {
          return yield* toSessionTransferError(
            "already_in_flight",
            `A session transfer (${latestInFlightForThread.value.transferId}) is already in progress for this thread.`,
            latestInFlightForThread.value.transferId,
          );
        }

        const insertResult = yield* repository
          .insertIfAbsent(initialRecord)
          .pipe(
            Effect.mapError((error) =>
              error._tag === "SessionTransferConflictError"
                ? toSessionTransferError("already_in_flight", error.message, transferId, error)
                : toSessionTransferError("internal", error.message, transferId, error),
            ),
          );
        if (!insertResult.created) {
          return insertResult.record;
        }

        // Synchronous atomic guard so only the single winning creator registers and forks a worker.
        if (hasLiveActiveTransfer(transferId)) {
          return insertResult.record;
        }
        const entry: ActiveTransferEntry = {
          attemptId: bumpTransferAttempt(transferId),
          cancelled: false,
          committed: false,
          fiber: null,
        };
        activeTransfers.set(transferId, entry);

        const clearUnforkedEntry = Effect.sync(() => {
          if (activeTransfers.get(transferId) === entry && entry.fiber === null) {
            activeTransfers.delete(transferId);
          }
        });

        yield* publishRecord(insertResult.record).pipe(Effect.onError(() => clearUnforkedEntry));

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
            confirmedRunningPause: input.confirmedRunningPause === true,
            entry,
          }),
          serviceScope,
        ).pipe(Effect.onError(() => clearUnforkedEntry));
        entry.fiber = fiber;

        return insertResult.record;
      }),
    );
  });

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

    if (input.transferId !== undefined) {
      // Synchronous deduplication BEFORE any yield* so concurrent callers with the same
      // transferId wait for the single winning creator instead of racing to launch two workers.
      const transferId = input.transferId;
      const inFlightStart = startingTransfers.get(transferId);
      if (inFlightStart !== undefined) {
        return yield* Deferred.await(inFlightStart);
      }
      const gate = Deferred.makeUnsafe<SessionTransferRecord, SessionTransferError>();
      startingTransfers.set(transferId, gate);
      return yield* startBody(input, transferId).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            startingTransfers.delete(transferId);
          }).pipe(Effect.andThen(Deferred.done(gate, exit)), Effect.ignore),
        ),
      );
    }

    const generatedId = yield* generateTransferId();
    return yield* startBody(input, generatedId);
  });

  const cancel: SessionTransferCoordinatorShape["cancel"] = Effect.fn(
    "SessionTransferCoordinator.cancel",
  )(function* (input) {
    return yield* withTransferLock(
      input.transferId,
      Effect.gen(function* () {
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
        if (existing.phase === "completed" || existing.phase === "finalizing_source") {
          return yield* toSessionTransferError(
            "invalid_phase",
            `Cannot cancel session transfer ${input.transferId} in phase ${existing.phase}.`,
            input.transferId,
          );
        }
        if (isTerminalSessionTransferPhase(existing.phase)) {
          return existing;
        }

        let current = existing;
        const active = getLiveActiveTransfer(input.transferId);
        if (active) {
          if (active.committed) {
            return yield* toSessionTransferError(
              "invalid_phase",
              `Session transfer ${input.transferId} has already committed and cannot be cancelled.`,
              input.transferId,
            );
          }
          active.cancelled = true;
          let fiberTerminated = active.fiber === null;
          if (active.fiber) {
            const interrupted = yield* Fiber.interrupt(active.fiber).pipe(
              Effect.as(true),
              Effect.timeoutOption(Duration.seconds(5)),
            );
            fiberTerminated = Option.isSome(interrupted) || active.fiber.pollUnsafe() !== undefined;
          }
          // If the fiber terminated (including when interrupted before its first step, before
          // `executeTransfer`'s inner `Effect.ensuring` ran), remove the stale entry immediately.
          if (fiberTerminated && activeTransfers.get(input.transferId) === active) {
            activeTransfers.delete(input.transferId);
          }
          const afterAbort = yield* repository
            .getById(input.transferId)
            .pipe(Effect.orElseSucceed(() => Option.none<SessionTransferRecord>()));
          if (Option.isSome(afterAbort)) {
            current = afterAbort.value;
          }
          if (current.phase === "cancelled" || current.phase === "failed") {
            return current;
          }
          if (
            active.committed ||
            current.phase === "completed" ||
            current.phase === "finalizing_source"
          ) {
            return yield* toSessionTransferError(
              "invalid_phase",
              `Cannot cancel session transfer ${input.transferId} in phase ${current.phase}.`,
              input.transferId,
            );
          }
          if (getLiveActiveTransfer(input.transferId) === active) {
            return yield* toSessionTransferError(
              "target_unavailable",
              `Session transfer ${input.transferId} worker is still winding down; retry cancellation once cleanup settles.`,
              input.transferId,
            );
          }
        }

        const observedAttempt = currentTransferAttempt(input.transferId);
        const observedPhase = current.phase;
        const observedUpdatedAt = current.updatedAt;

        const assertCancelOwnership = Effect.fn(
          "SessionTransferCoordinator.cancel.assertOwnership",
        )(function* (): Effect.fn.Return<
          | { readonly kind: "owned" }
          | { readonly kind: "already_terminal"; readonly record: SessionTransferRecord },
          SessionTransferError
        > {
          const verified = yield* verifyAttemptOwnership({
            transferId: input.transferId,
            expectedAttempt: observedAttempt,
            expectedPhase: observedPhase,
            expectedUpdatedAt: observedUpdatedAt,
          });
          if (verified !== null) {
            return { kind: "owned" as const };
          }
          const latestOption = yield* repository
            .getById(input.transferId)
            .pipe(Effect.orElseSucceed(() => Option.none<SessionTransferRecord>()));
          if (
            Option.isSome(latestOption) &&
            (latestOption.value.phase === "cancelled" || latestOption.value.phase === "failed")
          ) {
            return { kind: "already_terminal" as const, record: latestOption.value };
          }
          return yield* toSessionTransferError(
            "invalid_phase",
            `Session transfer ${input.transferId} state changed concurrently during cancellation.`,
            input.transferId,
          );
        });

        if (current.phase === "committing_target" || current.phase === "resuming_target") {
          const resolution = yield* resolveUncertainDestinationAndAbort({
            transferId: current.transferId,
            direction: current.direction,
            destinationThreadId: current.destinationThreadId,
            destinationMachineId: current.destinationMachineId,
            destinationEnvironmentId: current.destinationEnvironmentId,
            reason: "Cancelled by user",
          });
          if (resolution === "committed") {
            const localEnv = yield* serverEnvironment.getDescriptor;
            const destEnvId =
              current.destinationEnvironmentId ??
              (current.direction === "boat_to_local" ? localEnv.environmentId : null);
            if (
              destEnvId !== null &&
              current.destinationProjectId !== null &&
              current.destinationThreadId !== null
            ) {
              yield* finalizeSourceAndComplete({
                transferId: current.transferId,
                direction: current.direction,
                sourceEnvironmentId: current.sourceEnvironmentId,
                sourceMachineId: current.sourceMachineId,
                sourceThreadId: current.sourceThreadId,
                destinationEnvironmentId: destEnvId,
                destinationEnvironmentName:
                  current.destinationEnvironmentName ??
                  (current.direction === "boat_to_local"
                    ? toNonEmptyTrimmed(localEnv.label)
                    : null),
                destinationMachineId: current.destinationMachineId,
                destinationProjectId: current.destinationProjectId,
                destinationThreadId: current.destinationThreadId,
                currentPhase: current.phase,
              });
            }
            return yield* toSessionTransferError(
              "invalid_phase",
              `Session transfer ${input.transferId} has already committed and cannot be cancelled.`,
              input.transferId,
            );
          }
          if (resolution === "unknown") {
            return yield* toSessionTransferError(
              "invalid_phase",
              `Cannot cancel session transfer ${input.transferId} while commit outcome is uncertain (phase ${current.phase}).`,
              input.transferId,
            );
          }
          if (resolution === "abort_failed") {
            return yield* toSessionTransferError(
              "target_unavailable",
              `Failed to abort destination for session transfer ${input.transferId}; cannot safely cancel from phase ${current.phase}.`,
              input.transferId,
            );
          }
          // resolution === "confirmed_not_committed": destination already aborted & verified uncommitted.
          const ownershipBeforeSource = yield* assertCancelOwnership();
          if (ownershipBeforeSource.kind === "already_terminal") {
            return ownershipBeforeSource.record;
          }
          const sourceAbortOutcome = yield* abortSourceSide({
            transferId: current.transferId,
            direction: current.direction,
            sourceEnvironmentId: current.sourceEnvironmentId,
            sourceMachineId: current.sourceMachineId,
            sourceThreadId: current.sourceThreadId,
            reason: "Cancelled by user",
          });
          if (sourceAbortOutcome === "failed") {
            return yield* toSessionTransferError(
              "target_unavailable",
              `Failed to abort source for session transfer ${input.transferId}; transfer remains non-terminal so cleanup can be retried.`,
              input.transferId,
            );
          }
        } else {
          // Pre-commit phase: abort only endpoints that could have been contacted based on the
          // durable phase boundary and destination staging metadata. Never let an unused/uncontacted
          // endpoint block cleanup, while still requiring abort once staging or source export began.
          const destAbortOutcome = mayHaveStagedDestination(current)
            ? yield* abortDestinationSide({
                transferId: current.transferId,
                direction: current.direction,
                destinationEnvironmentId: current.destinationEnvironmentId,
                destinationMachineId: current.destinationMachineId,
                destinationThreadId: current.destinationThreadId,
                reason: "Cancelled by user",
              })
            : ("not_needed" as const);
          const ownershipBeforeSource = yield* assertCancelOwnership();
          if (ownershipBeforeSource.kind === "already_terminal") {
            return ownershipBeforeSource.record;
          }
          const sourceAbortOutcome = mayHavePreparedSource(current)
            ? yield* abortSourceSide({
                transferId: current.transferId,
                direction: current.direction,
                sourceEnvironmentId: current.sourceEnvironmentId,
                sourceMachineId: current.sourceMachineId,
                sourceThreadId: current.sourceThreadId,
                reason: "Cancelled by user",
              })
            : ("aborted" as const);
          if (destAbortOutcome === "failed" || sourceAbortOutcome === "failed") {
            const failedSides = [
              ...(destAbortOutcome === "failed" ? ["destination"] : []),
              ...(sourceAbortOutcome === "failed" ? ["source"] : []),
            ].join(" and ");
            return yield* toSessionTransferError(
              "target_unavailable",
              `Failed to abort ${failedSides} for session transfer ${input.transferId}; transfer remains non-terminal so cleanup can be retried.`,
              input.transferId,
            );
          }
        }

        const ownershipBeforePersist = yield* assertCancelOwnership();
        if (ownershipBeforePersist.kind === "already_terminal") {
          return ownershipBeforePersist.record;
        }
        const completedAt = yield* nowIso();
        return yield* transition(input.transferId, "cancelled", {
          expectedPhases: [observedPhase],
          phaseDetail: null,
          errorMessage: null,
          completedAt,
        });
      }),
    );
  });

  const retry: SessionTransferCoordinatorShape["retry"] = Effect.fn(
    "SessionTransferCoordinator.retry",
  )(function* (input) {
    return yield* withTransferLock(
      input.transferId,
      Effect.gen(function* () {
        if (hasLiveActiveTransfer(input.transferId) || startingTransfers.has(input.transferId)) {
          return yield* toSessionTransferError(
            "already_in_flight",
            `Session transfer ${input.transferId} is already running.`,
            input.transferId,
          );
        }

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
          destinationThreadId: null,
          destinationBranch: null,
          destinationWorktreePath: null,
          modelSelectionOverride: nextModelOverride,
          cloneDestinationPath: nextCloneDestinationPath,
          autoResume: nextAutoResume,
          warnings: [],
        });

        if (hasLiveActiveTransfer(input.transferId)) {
          return reset;
        }

        const entry: ActiveTransferEntry = {
          attemptId: bumpTransferAttempt(input.transferId),
          cancelled: false,
          committed: false,
          fiber: null,
        };
        activeTransfers.set(input.transferId, entry);

        const clearUnforkedEntry = Effect.sync(() => {
          if (activeTransfers.get(input.transferId) === entry && entry.fiber === null) {
            activeTransfers.delete(input.transferId);
          }
        });

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
            confirmedRunningPause: existing.sourceWasRunning || existing.hadPendingRuntimeRequest,
            entry,
          }),
          serviceScope,
        ).pipe(Effect.onError(() => clearUnforkedEntry));
        entry.fiber = fiber;

        return reset;
      }),
    );
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

    for (const initialRecord of active) {
      yield* withTransferLock(
        initialRecord.transferId,
        Effect.gen(function* () {
          if (hasLiveActiveTransfer(initialRecord.transferId)) {
            return;
          }
          const latestOption = yield* repository
            .getById(initialRecord.transferId)
            .pipe(Effect.orElseSucceed(() => Option.none<SessionTransferRecord>()));
          if (
            Option.isNone(latestOption) ||
            isTerminalSessionTransferPhase(latestOption.value.phase)
          ) {
            return;
          }
          const record = latestOption.value;
          const observedAttempt = currentTransferAttempt(record.transferId);
          const observedPhase = record.phase;
          const observedUpdatedAt = record.updatedAt;

          if (
            record.phase === "finalizing_source" ||
            record.phase === "committing_target" ||
            record.phase === "resuming_target"
          ) {
            const resolution = yield* resolveUncertainDestinationAndAbort({
              transferId: record.transferId,
              direction: record.direction,
              destinationThreadId: record.destinationThreadId,
              destinationMachineId: record.destinationMachineId,
              destinationEnvironmentId: record.destinationEnvironmentId,
              reason: "Interrupted by server restart",
            });

            if (resolution === "committed") {
              const localEnv = yield* serverEnvironment.getDescriptor;
              const destEnvId =
                record.destinationEnvironmentId ??
                (record.direction === "boat_to_local" ? localEnv.environmentId : null);
              if (
                destEnvId !== null &&
                record.destinationProjectId !== null &&
                record.destinationThreadId !== null
              ) {
                yield* finalizeSourceAndComplete({
                  transferId: record.transferId,
                  direction: record.direction,
                  sourceEnvironmentId: record.sourceEnvironmentId,
                  sourceMachineId: record.sourceMachineId,
                  sourceThreadId: record.sourceThreadId,
                  destinationEnvironmentId: destEnvId,
                  destinationEnvironmentName:
                    record.destinationEnvironmentName ??
                    (record.direction === "boat_to_local"
                      ? toNonEmptyTrimmed(localEnv.label)
                      : null),
                  destinationMachineId: record.destinationMachineId,
                  destinationProjectId: record.destinationProjectId,
                  destinationThreadId: record.destinationThreadId,
                  currentPhase: record.phase,
                });
                return;
              }
              yield* Effect.logWarning(
                "Destination commit confirmed on startup but destination metadata is incomplete; deferring reconciliation",
                { transferId: record.transferId, phase: record.phase },
              );
              return;
            }

            if (resolution === "unknown" || resolution === "abort_failed") {
              yield* Effect.logWarning(
                "Destination commit/abort outcome could not be verified on startup; deferring reconciliation",
                { transferId: record.transferId, phase: record.phase, resolution },
              );
              return;
            }

            // resolution === "confirmed_not_committed": destination abort succeeded and post-abort
            // verification confirmed no commit. Now abort source side before marking terminally failed.
            const stillOwnedBeforeSource = yield* verifyAttemptOwnership({
              transferId: record.transferId,
              expectedAttempt: observedAttempt,
              expectedPhase: observedPhase,
              expectedUpdatedAt: observedUpdatedAt,
            });
            if (stillOwnedBeforeSource === null) {
              return;
            }
            const sourceAbortOutcome = yield* abortSourceSide({
              transferId: record.transferId,
              direction: record.direction,
              sourceEnvironmentId: record.sourceEnvironmentId,
              sourceMachineId: record.sourceMachineId,
              sourceThreadId: record.sourceThreadId,
              reason: "Interrupted by server restart",
            });
            if (sourceAbortOutcome === "failed") {
              yield* Effect.logWarning(
                "Startup source abort incomplete; keeping transfer non-terminal for retry",
                { transferId: record.transferId, phase: record.phase, sourceAbortOutcome },
              );
              return;
            }

            const stillOwnedBeforePersist = yield* verifyAttemptOwnership({
              transferId: record.transferId,
              expectedAttempt: observedAttempt,
              expectedPhase: observedPhase,
              expectedUpdatedAt: observedUpdatedAt,
            });
            if (stillOwnedBeforePersist === null) {
              return;
            }
            const completedAt = yield* nowIso();
            yield* transition(record.transferId, "failed", {
              expectedPhases: [observedPhase],
              phaseDetail: null,
              errorMessage: "Interrupted by server restart",
              completedAt,
            }).pipe(Effect.ignore);
            return;
          }

          // Crashed before commit: abort only endpoints that could have been contacted based on
          // durable phase and destination staging metadata. Only mark terminally failed once every
          // required side confirms cleanup so temporarily unreachable Boats are retried later.
          const destAbortOutcome = mayHaveStagedDestination(record)
            ? yield* abortDestinationSide({
                transferId: record.transferId,
                direction: record.direction,
                destinationEnvironmentId: record.destinationEnvironmentId,
                destinationMachineId: record.destinationMachineId,
                destinationThreadId: record.destinationThreadId,
                reason: "Interrupted by server restart",
              })
            : ("not_needed" as const);
          const stillOwnedBeforeSource = yield* verifyAttemptOwnership({
            transferId: record.transferId,
            expectedAttempt: observedAttempt,
            expectedPhase: observedPhase,
            expectedUpdatedAt: observedUpdatedAt,
          });
          if (stillOwnedBeforeSource === null) {
            return;
          }
          const sourceAbortOutcome = mayHavePreparedSource(record)
            ? yield* abortSourceSide({
                transferId: record.transferId,
                direction: record.direction,
                sourceEnvironmentId: record.sourceEnvironmentId,
                sourceMachineId: record.sourceMachineId,
                sourceThreadId: record.sourceThreadId,
                reason: "Interrupted by server restart",
              })
            : ("aborted" as const);

          if (destAbortOutcome === "failed" || sourceAbortOutcome === "failed") {
            yield* Effect.logWarning(
              "Startup pre-commit abort incomplete; keeping transfer non-terminal for retry",
              {
                transferId: record.transferId,
                phase: record.phase,
                destAbortOutcome,
                sourceAbortOutcome,
              },
            );
            return;
          }

          const stillOwnedBeforePersist = yield* verifyAttemptOwnership({
            transferId: record.transferId,
            expectedAttempt: observedAttempt,
            expectedPhase: observedPhase,
            expectedUpdatedAt: observedUpdatedAt,
          });
          if (stillOwnedBeforePersist === null) {
            return;
          }
          const completedAt = yield* nowIso();
          yield* transition(record.transferId, "failed", {
            expectedPhases: [observedPhase],
            phaseDetail: null,
            errorMessage: "Interrupted by server restart",
            completedAt,
          }).pipe(Effect.ignore);
        }),
      );
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

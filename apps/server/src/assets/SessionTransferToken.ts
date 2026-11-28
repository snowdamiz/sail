// @effect-diagnostics nodeBuiltinImport:off -- single-handle fstat+sha256+stream avoids download TOCTOU and unique transfer-id hashing is not covered by Effect's sync API.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { IsoDateTime } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import { withAdmission } from "../serverAdmission.ts";
import { ASSET_ROUTE_PREFIX } from "./AssetAccess.ts";
import * as AssetSigner from "./AssetSigner.ts";

export const SESSION_TRANSFER_BUNDLE_ROUTE_PREFIX = "/api/session-transfers";
export const SESSION_TRANSFER_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const SESSION_TRANSFER_MAX_BUNDLE_BYTES = 100 * 1024 * 1024; // 100 MiB
export const SESSION_TRANSFER_STALE_TTL_MS = 60 * 60 * 1000; // 1 hour

const SESSION_TRANSFER_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const lastSweepByRoot = new Map<string, number>();

const SessionTransferBundleOperation = Schema.Literals(["download", "upload"]);
type SessionTransferBundleOperation = typeof SessionTransferBundleOperation.Type;

const SessionTransferBundleTokenClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("session-transfer-bundle"),
  operation: SessionTransferBundleOperation,
  transferId: Schema.String,
  maxBytes: Schema.Number,
  expectedSizeBytes: Schema.optional(Schema.Number),
  expectedSha256: Schema.optional(Schema.String),
  expiresAt: Schema.Number,
});
type SessionTransferBundleTokenClaims = typeof SessionTransferBundleTokenClaims.Type;

class SessionTransferTokenSigningError extends Schema.TaggedError<SessionTransferTokenSigningError>()(
  "SessionTransferTokenSigningError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to sign session transfer bundle URL.";
  }
}

const claimsJsonSchema = Schema.fromJsonString(SessionTransferBundleTokenClaims);
const decodeClaimsOption = Schema.decodeUnknownOption(claimsJsonSchema);
const encodeClaimsSync = Schema.encodeSync(claimsJsonSchema);

const AttachmentDownloadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment"),
  attachmentId: Schema.String,
  download: Schema.Literal(true),
  fileName: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  expiresAt: Schema.Number,
});
const encodeAttachmentDownloadClaimsSync = Schema.encodeSync(
  Schema.fromJsonString(AttachmentDownloadClaims),
);

function decodeClaims(encodedPayload: string): SessionTransferBundleTokenClaims | null {
  try {
    return Option.getOrNull(decodeClaimsOption(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function shortTransferHash(transferId: string): string {
  return NodeCrypto.createHash("sha256").update(transferId).digest("hex").slice(0, 12);
}

function sanitizeTransferSegment(transferId: string): string | null {
  const trimmed = transferId.trim();
  if (trimmed.length === 0) return null;
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (sanitized === "." || sanitized === ".." || sanitized.includes("..")) {
    return null;
  }
  return sanitized;
}

/**
 * Produces a filesystem- and identifier-safe segment incorporating a short SHA-256 hash
 * of the raw `transferId` so distinct IDs differing only in punctuation (e.g. `a/b` vs `a:b`)
 * never collide on staging paths, event IDs, or deterministic destination thread IDs.
 */
export function uniqueTransferSegment(transferId: string): string | null {
  const sanitized = sanitizeTransferSegment(transferId);
  if (sanitized === null) return null;
  const prefix = sanitized.slice(0, 48);
  return `${prefix}-${shortTransferHash(transferId)}`;
}

function sessionTransfersRootDir(stateDir: string, path: Path.Path): string {
  return path.join(stateDir, "session-transfers");
}

export function resolveTransferStagingDir(
  stateDir: string,
  transferId: string,
  path: Path.Path,
): string | null {
  const segment = uniqueTransferSegment(transferId);
  if (segment === null) return null;
  const root = path.resolve(sessionTransfersRootDir(stateDir, path));
  const target = path.resolve(root, segment);
  if (path.dirname(target) !== root) return null;
  return target;
}

export function resolveExportBundlePath(
  stateDir: string,
  transferId: string,
  path: Path.Path,
): string | null {
  const dir = resolveTransferStagingDir(stateDir, transferId, path);
  return dir === null ? null : path.join(dir, "export.bundle");
}

export function resolveImportBundlePath(
  stateDir: string,
  transferId: string,
  path: Path.Path,
): string | null {
  const dir = resolveTransferStagingDir(stateDir, transferId, path);
  return dir === null ? null : path.join(dir, "import.bundle");
}

interface SweepStaleSessionTransferStagingResult {
  readonly deletedFiles: number;
  readonly deletedDirs: number;
}

export const sweepStaleSessionTransferStaging = Effect.fn("SessionTransferToken.sweepStale")(
  function* (input: {
    readonly stateDir: string;
    readonly nowMs?: number;
    readonly ttlMs?: number;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nowMs = input.nowMs ?? (yield* Clock.currentTimeMillis);
    const ttlMs = input.ttlMs ?? SESSION_TRANSFER_STALE_TTL_MS;
    const root = sessionTransfersRootDir(input.stateDir, path);

    const rootExists = yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => false));
    if (!rootExists) {
      return { deletedFiles: 0, deletedDirs: 0 } satisfies SweepStaleSessionTransferStagingResult;
    }

    const entries = yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    let deletedFiles = 0;
    let deletedDirs = 0;

    for (const entry of entries) {
      const entryPath = path.join(root, entry);
      const stat = yield* fileSystem.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
      if (stat === null) continue;

      if (stat.type === "File") {
        const mtimeMs = Option.match(stat.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        if (nowMs - mtimeMs >= ttlMs) {
          yield* fileSystem.remove(entryPath, { force: true }).pipe(Effect.ignore);
          deletedFiles += 1;
        }
        continue;
      }

      if (stat.type !== "Directory") continue;

      const children = yield* fileSystem
        .readDirectory(entryPath)
        .pipe(Effect.orElseSucceed(() => []));
      let remaining = 0;
      for (const child of children) {
        const childPath = path.join(entryPath, child);
        const childStat = yield* fileSystem.stat(childPath).pipe(Effect.orElseSucceed(() => null));
        if (childStat === null) continue;
        const mtimeMs = Option.match(childStat.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        if (nowMs - mtimeMs >= ttlMs) {
          yield* fileSystem.remove(childPath, { recursive: true, force: true }).pipe(Effect.ignore);
          deletedFiles += 1;
        } else {
          remaining += 1;
        }
      }

      const dirMtimeMs = Option.match(stat.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      if (remaining === 0 && (children.length > 0 || nowMs - dirMtimeMs >= ttlMs)) {
        yield* fileSystem.remove(entryPath, { recursive: true, force: true }).pipe(Effect.ignore);
        deletedDirs += 1;
      }
    }

    return { deletedFiles, deletedDirs } satisfies SweepStaleSessionTransferStagingResult;
  },
);

export const cleanupTransferStagingDir = Effect.fn("SessionTransferToken.cleanupStagingDir")(
  function* (transferId: string) {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = resolveTransferStagingDir(config.stateDir, transferId, path);
    if (dir === null) return false;
    const existed = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (!existed) return false;
    yield* fileSystem.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
    return true;
  },
);

interface IssueSessionTransferBundleUrlInput {
  readonly transferId: string;
  readonly operation: SessionTransferBundleOperation;
  readonly maxBytes?: number;
  readonly expectedSizeBytes?: number;
  readonly expectedSha256?: string;
  readonly ttlMs?: number;
}

interface IssuedSessionTransferBundleUrl {
  readonly token: string;
  readonly relativeUrl: string;
  readonly expiresAt: IsoDateTime;
  readonly expiresAtMs: number;
}

export const issueSessionTransferBundleUrl = Effect.fn("SessionTransferToken.issueUrl")(
  function* (input: IssueSessionTransferBundleUrlInput) {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const nowMs = yield* Clock.currentTimeMillis;

    const root = sessionTransfersRootDir(config.stateDir, path);
    const previousSweep = lastSweepByRoot.get(root);
    if (
      previousSweep === undefined ||
      nowMs - previousSweep >= SESSION_TRANSFER_SWEEP_INTERVAL_MS
    ) {
      lastSweepByRoot.set(root, nowMs);
      const swept = yield* sweepStaleSessionTransferStaging({
        stateDir: config.stateDir,
        nowMs,
      }).pipe(Effect.orElseSucceed(() => ({ deletedFiles: 0, deletedDirs: 0 })));
      if (swept.deletedFiles > 0 || swept.deletedDirs > 0) {
        yield* Effect.logInfo("Removed stale session transfer staging files.", swept);
      }
    }

    const ttlMs = input.ttlMs ?? SESSION_TRANSFER_TOKEN_TTL_MS;
    const expiresAtMs = nowMs + ttlMs;
    const maxBytes = Math.min(
      Math.max(1, input.maxBytes ?? SESSION_TRANSFER_MAX_BUNDLE_BYTES),
      SESSION_TRANSFER_MAX_BUNDLE_BYTES,
    );
    const encodedPayload = base64UrlEncode(
      encodeClaimsSync({
        version: 1,
        kind: "session-transfer-bundle",
        operation: input.operation,
        transferId: input.transferId,
        maxBytes,
        ...(input.expectedSizeBytes !== undefined
          ? { expectedSizeBytes: input.expectedSizeBytes }
          : {}),
        ...(input.expectedSha256 !== undefined ? { expectedSha256: input.expectedSha256 } : {}),
        expiresAt: expiresAtMs,
      }),
    );

    const signer = yield* AssetSigner.AssetSigner;
    const signature = yield* signer
      .sign(encodedPayload)
      .pipe(Effect.mapError((cause) => new SessionTransferTokenSigningError({ cause })));

    const token = `${encodedPayload}.${signature}`;
    return {
      token,
      relativeUrl: `${SESSION_TRANSFER_BUNDLE_ROUTE_PREFIX}/${token}/bundle`,
      expiresAt: IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs))),
      expiresAtMs,
    } satisfies IssuedSessionTransferBundleUrl;
  },
  withAdmission("root"),
  Effect.catchTags({
    ServerMaintenanceBusy: (cause) => new SessionTransferTokenSigningError({ cause }),
  }),
);

/**
 * Mint a short-lived signed download URL compatible with `GET /api/assets/*`
 * (`AssetAccess.resolveAsset`) without pulling unrelated preview/orchestrator
 * services into the session transfer service context.
 */
export const issueSessionTransferAttachmentDownloadUrl = Effect.fn(
  "SessionTransferToken.issueAttachmentDownloadUrl",
)(function* (input: {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly ttlMs?: number;
}) {
  const nowMs = yield* Clock.currentTimeMillis;
  const expiresAt = nowMs + (input.ttlMs ?? SESSION_TRANSFER_TOKEN_TTL_MS);
  const claims = {
    version: 1 as const,
    kind: "attachment" as const,
    attachmentId: input.attachmentId,
    download: true as const,
    fileName: input.fileName,
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
    expiresAt,
  };
  const encodedPayload = base64UrlEncode(encodeAttachmentDownloadClaimsSync(claims));
  const signer = yield* AssetSigner.AssetSigner;
  const signature = yield* signer
    .sign(encodedPayload)
    .pipe(Effect.mapError((cause) => new SessionTransferTokenSigningError({ cause })));
  const token = `${encodedPayload}.${signature}`;
  return {
    token,
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(input.fileName)}`,
    expiresAt: IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(expiresAt))),
  };
});

export const validateSessionTransferBundleToken = Effect.fn("SessionTransferToken.validateToken")(
  function* (token: string, expectedOperation: SessionTransferBundleOperation) {
    const [encodedPayload, signature, unexpectedSegment] = token.split(".");
    if (!encodedPayload || !signature || unexpectedSegment) {
      return null;
    }

    const signer = yield* AssetSigner.AssetSigner;
    const verified = yield* signer.verify(encodedPayload, signature).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to verify session transfer bundle token.", { cause }),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (!verified) {
      return null;
    }

    const claims = decodeClaims(encodedPayload);
    if (
      claims === null ||
      claims.operation !== expectedOperation ||
      claims.expiresAt <= (yield* Clock.currentTimeMillis)
    ) {
      return null;
    }
    return claims;
  },
);

const sha256File = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.stream(filePath).pipe(
    Stream.runFold(
      () => NodeCrypto.createHash("sha256"),
      (hash, chunk) => hash.update(chunk),
    ),
    Effect.map((hash) => hash.digest("hex")),
  );

class SessionTransferBundleStreamError extends Schema.TaggedError<SessionTransferBundleStreamError>()(
  "SessionTransferBundleStreamError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to read session transfer bundle stream.";
  }
}

type ResolveExportBundleDownloadResult =
  | {
      readonly ok: true;
      readonly filePath: string;
      readonly sizeBytes: number;
      readonly stream: Stream.Stream<Uint8Array, SessionTransferBundleStreamError>;
      readonly close: Effect.Effect<void>;
    }
  | { readonly ok: false; readonly status: 404 | 409 | 500; readonly detail: string };

interface ResolveExportBundleDownloadOptions {
  readonly onFileOpen?: (handle: NodeFSP.FileHandle) => void;
}

export const resolveExportBundleForDownload = Effect.fn(
  "SessionTransferToken.resolveExportBundleForDownload",
)(function* (
  claims: SessionTransferBundleTokenClaims,
  options?: ResolveExportBundleDownloadOptions,
) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const bundlePath = resolveExportBundlePath(config.stateDir, claims.transferId, path);
  if (bundlePath === null) {
    return {
      ok: false,
      status: 404,
      detail: "Not Found",
    } satisfies ResolveExportBundleDownloadResult;
  }

  // Open the file once, verify fstat + SHA-256 on that open descriptor, and stream directly
  // from the same FileHandle so replacing or unlinking the path cannot introduce a TOCTOU window.
  const openFlags = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);
  const openResult = yield* Effect.tryPromise({
    try: async (signal) => {
      let handle: NodeFSP.FileHandle;
      try {
        handle = await NodeFSP.open(bundlePath, openFlags);
        options?.onFileOpen?.(handle);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
          return { ok: false, status: 404, detail: "Not Found" } as const;
        }
        throw error;
      }

      let handedOff = false;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { ok: false, status: 404, detail: "Not Found" } as const;
        }
        const sizeBytes = stat.size;
        const maxBytes = Math.min(claims.maxBytes, SESSION_TRANSFER_MAX_BUNDLE_BYTES);
        if (sizeBytes > maxBytes) {
          return {
            ok: false,
            status: 409,
            detail: `Exported bundle size (${sizeBytes} bytes) exceeds signed token limit (${maxBytes} bytes).`,
          } as const;
        }
        if (claims.expectedSizeBytes !== undefined && sizeBytes !== claims.expectedSizeBytes) {
          return {
            ok: false,
            status: 409,
            detail: `Exported bundle size (${sizeBytes} bytes) does not match signed size (${claims.expectedSizeBytes} bytes).`,
          } as const;
        }
        if (claims.expectedSha256 !== undefined) {
          const hash = NodeCrypto.createHash("sha256");
          const chunk = new Uint8Array(64 * 1024);
          let offset = 0;
          while (offset < sizeBytes) {
            if (signal.aborted) {
              return {
                ok: false,
                status: 500,
                detail: "Exported session transfer bundle verification was aborted.",
              } as const;
            }
            const toRead = Math.min(chunk.byteLength, sizeBytes - offset);
            const { bytesRead } = await handle.read(chunk, 0, toRead, offset);
            if (bytesRead === 0) break;
            hash.update(chunk.subarray(0, bytesRead));
            offset += bytesRead;
          }
          if (offset !== sizeBytes) {
            return {
              ok: false,
              status: 409,
              detail: "Exported session transfer bundle size changed during verification.",
            } as const;
          }
          const actualSha256 = hash.digest("hex");
          if (actualSha256 !== claims.expectedSha256.toLowerCase()) {
            return {
              ok: false,
              status: 409,
              detail:
                "Exported session transfer bundle SHA-256 checksum does not match signed claims.",
            } as const;
          }
        }

        if (signal.aborted) {
          return {
            ok: false,
            status: 500,
            detail: "Exported session transfer bundle verification was aborted.",
          } as const;
        }

        if (sizeBytes === 0) {
          return {
            ok: true,
            filePath: bundlePath,
            sizeBytes: 0,
            handle: null as NodeFSP.FileHandle | null,
          } as const;
        }

        handedOff = true;
        return {
          ok: true,
          filePath: bundlePath,
          sizeBytes,
          handle,
        } as const;
      } finally {
        if (!handedOff) {
          await handle.close().catch(() => undefined);
        }
      }
    },
    catch: (cause) => new SessionTransferBundleStreamError({ cause }),
  }).pipe(
    Effect.orElseSucceed(() => ({
      ok: false as const,
      status: 500 as const,
      detail: "Failed to verify exported session transfer bundle checksum.",
    })),
  );

  if (!openResult.ok) {
    return openResult satisfies ResolveExportBundleDownloadResult;
  }

  let closed = false;
  const close = Effect.promise(async () => {
    if (closed) return;
    closed = true;
    if (openResult.handle !== null) {
      await openResult.handle.close().catch(() => undefined);
    }
  });

  const stream: Stream.Stream<Uint8Array, SessionTransferBundleStreamError> =
    openResult.handle === null || openResult.sizeBytes === 0
      ? Stream.empty
      : NodeStream.fromReadable<Uint8Array, SessionTransferBundleStreamError>({
          evaluate: () =>
            openResult.handle!.createReadStream({
              start: 0,
              end: openResult.sizeBytes - 1,
              autoClose: true,
            }),
          onError: (cause) => new SessionTransferBundleStreamError({ cause }),
        }).pipe(Stream.ensuring(close));

  return {
    ok: true,
    filePath: openResult.filePath,
    sizeBytes: openResult.sizeBytes,
    stream,
    close,
  } satisfies ResolveExportBundleDownloadResult;
});

type StoreSessionTransferBundleResult =
  | { readonly ok: true; readonly sizeBytes: number; readonly sha256: string }
  | { readonly ok: false; readonly status: number; readonly detail: string };

interface StoreSessionTransferBundleUploadOptions {
  readonly expectedContentLength?: number;
}

export const storeSessionTransferBundleUpload = Effect.fn("SessionTransferToken.storeUpload")(
  function* (
    claims: SessionTransferBundleTokenClaims,
    body: Uint8Array | HttpServerRequest.HttpServerRequest["stream"],
    options?: StoreSessionTransferBundleUploadOptions,
  ) {
    const maxBytes = Math.min(claims.maxBytes, SESSION_TRANSFER_MAX_BUNDLE_BYTES);
    const expectedContentLength = options?.expectedContentLength;
    if (expectedContentLength !== undefined) {
      if (!Number.isSafeInteger(expectedContentLength) || expectedContentLength < 0) {
        return {
          ok: false,
          status: 400,
          detail: "Invalid Content-Length header.",
        } satisfies StoreSessionTransferBundleResult;
      }
      if (expectedContentLength > maxBytes) {
        return {
          ok: false,
          status: 413,
          detail: `Bundle size ${expectedContentLength} bytes exceeds the ${maxBytes}-byte limit.`,
        } satisfies StoreSessionTransferBundleResult;
      }
      if (expectedContentLength === 0) {
        return {
          ok: false,
          status: 400,
          detail: "Bundle upload body cannot be empty.",
        } satisfies StoreSessionTransferBundleResult;
      }
    }

    if (body instanceof Uint8Array && body.byteLength > maxBytes) {
      return {
        ok: false,
        status: 413,
        detail: `Bundle size ${body.byteLength} bytes exceeds the ${maxBytes}-byte limit.`,
      } satisfies StoreSessionTransferBundleResult;
    }

    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;

    const finalPath = resolveImportBundlePath(config.stateDir, claims.transferId, path);
    if (finalPath === null) {
      return {
        ok: false,
        status: 400,
        detail: "Invalid transfer identifier.",
      } satisfies StoreSessionTransferBundleResult;
    }

    const partId = yield* random.uuidV4();
    const partPath = `${finalPath}.${partId}.part`;

    let receivedBytes = 0;
    let exceededLimit = false;
    let exceededDeclaredLength = false;
    const hasher = NodeCrypto.createHash("sha256");
    const bodyStream = body instanceof Uint8Array ? Stream.make(body) : body;

    return yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });

      yield* Stream.run(
        bodyStream.pipe(
          Stream.takeWhile((chunk) => {
            receivedBytes += chunk.byteLength;
            if (receivedBytes > maxBytes) {
              exceededLimit = true;
              return false;
            }
            if (expectedContentLength !== undefined && receivedBytes > expectedContentLength) {
              exceededDeclaredLength = true;
              return false;
            }
            hasher.update(chunk);
            return true;
          }),
        ),
        fileSystem.sink(partPath),
      );

      if (exceededLimit) {
        return {
          ok: false,
          status: 413,
          detail: `Bundle upload exceeds the ${maxBytes}-byte limit.`,
        } satisfies StoreSessionTransferBundleResult;
      }

      if (
        exceededDeclaredLength ||
        (expectedContentLength !== undefined && receivedBytes !== expectedContentLength)
      ) {
        return {
          ok: false,
          status: 400,
          detail: `Bundle upload body length does not match declared Content-Length (${expectedContentLength} bytes).`,
        } satisfies StoreSessionTransferBundleResult;
      }

      if (receivedBytes === 0) {
        return {
          ok: false,
          status: 400,
          detail: "Bundle upload body cannot be empty.",
        } satisfies StoreSessionTransferBundleResult;
      }

      const uploadedSha256 = hasher.digest("hex");
      if (
        claims.expectedSha256 !== undefined &&
        uploadedSha256 !== claims.expectedSha256.toLowerCase()
      ) {
        return {
          ok: false,
          status: 400,
          detail: "Uploaded bundle SHA-256 checksum does not match expected digest.",
        } satisfies StoreSessionTransferBundleResult;
      }

      // Strictly atomic publish via hardlink in the same directory: never exposes a partially
      // copied file and never clobbers a competing published bundle.
      const published = yield* fileSystem.link(partPath, finalPath).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      );

      if (!published) {
        const existingStat = yield* fileSystem.stat(finalPath);
        if (Number(existingStat.size) !== receivedBytes) {
          return {
            ok: false,
            status: 409,
            detail: "Session transfer bundle already uploaded with different content.",
          } satisfies StoreSessionTransferBundleResult;
        }
        const existingSha256 = yield* sha256File(fileSystem, finalPath);
        if (existingSha256 !== uploadedSha256) {
          return {
            ok: false,
            status: 409,
            detail: "Session transfer bundle already uploaded with different content.",
          } satisfies StoreSessionTransferBundleResult;
        }
      }

      return {
        ok: true,
        sizeBytes: receivedBytes,
        sha256: uploadedSha256,
      } satisfies StoreSessionTransferBundleResult;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("Failed to persist session transfer bundle upload.", {
          cause,
          transferId: claims.transferId,
        }).pipe(
          Effect.as({
            ok: false,
            status: 500,
            detail: "Failed to store session transfer bundle.",
          } satisfies StoreSessionTransferBundleResult),
        ),
      ),
      Effect.ensuring(fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore)),
    );
  },
  withAdmission("root"),
  Effect.catchTags({
    ServerMaintenanceBusy: () =>
      Effect.succeed({
        ok: false,
        status: 503,
        detail: "Server is busy; retry the bundle upload shortly.",
      } satisfies StoreSessionTransferBundleResult),
  }),
);

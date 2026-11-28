// @effect-diagnostics nodeBuiltinImport:off -- utimesSync sets deterministic old mtimes for stale-file sweep tests and createHash verifies sha256.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  layerSessionTransferBundleDownloadRoute,
  layerSessionTransferBundleUploadRoute,
} from "../http.ts";
import * as AssetSigner from "./AssetSigner.ts";
import {
  cleanupTransferStagingDir,
  issueSessionTransferBundleUrl,
  resolveExportBundleForDownload,
  resolveExportBundlePath,
  resolveImportBundlePath,
  resolveTransferStagingDir,
  SESSION_TRANSFER_STALE_TTL_MS,
  SESSION_TRANSFER_TOKEN_TTL_MS,
  storeSessionTransferBundleUpload,
  sweepStaleSessionTransferStaging,
  uniqueTransferSegment,
  validateSessionTransferBundleToken,
} from "./SessionTransferToken.ts";

const makeTestLayer = () =>
  AssetSigner.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-transfer-token-" }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
  );

describe("SessionTransferToken", () => {
  it.effect(
    "signs, validates, enforces operation binding, and expires tokens after 15 minutes",
    () =>
      Effect.gen(function* () {
        const issued = yield* issueSessionTransferBundleUrl({
          transferId: "xfer-token-1",
          operation: "download",
        });
        expect(issued.relativeUrl).toBe(`/api/session-transfers/${issued.token}/bundle`);

        const valid = yield* validateSessionTransferBundleToken(issued.token, "download");
        expect(valid?.transferId).toBe("xfer-token-1");
        expect(valid?.operation).toBe("download");

        // Operation mismatch is rejected.
        expect(yield* validateSessionTransferBundleToken(issued.token, "upload")).toBeNull();

        // Tampered signature is rejected.
        const tampered = `${issued.token.slice(0, -4)}aaaa`;
        expect(yield* validateSessionTransferBundleToken(tampered, "download")).toBeNull();

        // Expires after TTL.
        yield* TestClock.adjust(Duration.millis(SESSION_TRANSFER_TOKEN_TTL_MS + 1));
        expect(yield* validateSessionTransferBundleToken(issued.token, "download")).toBeNull();
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "streams GET download with Content-Length + nosniff and POST upload atomically with size cap",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const routeContext = yield* Effect.context<
          | ServerConfig.ServerConfig
          | FileSystem.FileSystem
          | Path.Path
          | AssetSigner.AssetSigner
          | SecureRandom.SecureRandom
        >();

        const routesLayer = Layer.mergeAll(
          layerSessionTransferBundleDownloadRoute,
          layerSessionTransferBundleUploadRoute,
        ).pipe(Layer.provideMerge(Layer.succeedContext(routeContext)));
        const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });

        try {
          const transferId = "xfer-http-1";
          const payload = new TextEncoder().encode("synthetic-git-bundle-payload-0123456789");
          const payloadSha256 = NodeCrypto.createHash("sha256").update(payload).digest("hex");

          // Write export bundle for download.
          const exportPath = resolveExportBundlePath(config.stateDir, transferId, path)!;
          yield* fs.makeDirectory(path.dirname(exportPath), { recursive: true });
          yield* fs.writeFile(exportPath, payload);

          const downloadUrl = yield* issueSessionTransferBundleUrl({
            transferId,
            operation: "download",
            expectedSizeBytes: payload.byteLength,
            expectedSha256: payloadSha256,
          });

          const downloadRes = yield* Effect.promise(() =>
            handler(new Request(`http://127.0.0.1${downloadUrl.relativeUrl}`, { method: "GET" })),
          );
          expect(downloadRes.status).toBe(200);
          expect(downloadRes.headers.get("content-length")).toBe(String(payload.byteLength));
          expect(downloadRes.headers.get("x-content-type-options")).toBe("nosniff");
          const downloadedBytes = new Uint8Array(
            yield* Effect.promise(() => downloadRes.arrayBuffer()),
          );
          expect(downloadedBytes).toEqual(payload);

          // Invalid token returns 404.
          const badRes = yield* Effect.promise(() =>
            handler(new Request("http://127.0.0.1/api/session-transfers/not-valid/bundle")),
          );
          expect(badRes.status).toBe(404);

          // Upload with tight maxBytes cap enforces 413 on oversized Content-Length and streaming body.
          const cappedUploadUrl = yield* issueSessionTransferBundleUrl({
            transferId: "xfer-http-capped",
            operation: "upload",
            maxBytes: 16,
          });
          const tooBigRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${cappedUploadUrl.relativeUrl}`, {
                method: "POST",
                body: payload,
              }),
            ),
          );
          expect(tooBigRes.status).toBe(413);

          // Valid upload with expectedSha256 atomically publishes import.bundle and returns 204.
          const uploadUrl = yield* issueSessionTransferBundleUrl({
            transferId,
            operation: "upload",
            expectedSha256: payloadSha256,
          });

          // Wrong checksum returns 400.
          const wrongHashRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${uploadUrl.relativeUrl}`, {
                method: "POST",
                body: new TextEncoder().encode("different-content"),
              }),
            ),
          );
          expect(wrongHashRes.status).toBe(400);

          // Correct payload publishes atomically and returns 204.
          const uploadRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${uploadUrl.relativeUrl}`, {
                method: "POST",
                body: payload,
              }),
            ),
          );
          expect(uploadRes.status).toBe(204);

          const importPath = resolveImportBundlePath(config.stateDir, transferId, path)!;
          const storedBytes = yield* fs.readFile(importPath);
          expect(new Uint8Array(storedBytes)).toEqual(payload);

          // No leftover .part files remain in the staging directory.
          const stagingEntries = yield* fs.readDirectory(
            resolveTransferStagingDir(config.stateDir, transferId, path)!,
          );
          expect(stagingEntries.some((name) => name.endsWith(".part"))).toBe(false);

          // Idempotent replay with identical payload returns 204.
          const replayRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${uploadUrl.relativeUrl}`, {
                method: "POST",
                body: payload,
              }),
            ),
          );
          expect(replayRes.status).toBe(204);

          // Conflicting upload with different bytes on another token for same transfer returns 409.
          const conflictUrl = yield* issueSessionTransferBundleUrl({
            transferId,
            operation: "upload",
          });
          const conflictRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${conflictUrl.relativeUrl}`, {
                method: "POST",
                body: new TextEncoder().encode("other-bytes"),
              }),
            ),
          );
          expect(conflictRes.status).toBe(409);

          expect(yield* cleanupTransferStagingDir(transferId)).toBe(true);
          expect(yield* fs.exists(importPath)).toBe(false);
        } finally {
          yield* Effect.promise(() => dispose());
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "assigns collision-free staging directories to transferIds differing only in punctuation",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;

        const segSlash = uniqueTransferSegment("xfer/a");
        const segColon = uniqueTransferSegment("xfer:a");
        expect(segSlash).not.toBeNull();
        expect(segColon).not.toBeNull();
        expect(segSlash).not.toBe(segColon);

        const dirSlash = resolveTransferStagingDir(config.stateDir, "xfer/a", path);
        const dirColon = resolveTransferStagingDir(config.stateDir, "xfer:a", path);
        expect(dirSlash).not.toBeNull();
        expect(dirColon).not.toBeNull();
        expect(dirSlash).not.toBe(dirColon);

        expect(resolveExportBundlePath(config.stateDir, "xfer/a", path)).not.toBe(
          resolveExportBundlePath(config.stateDir, "xfer:a", path),
        );
        expect(resolveImportBundlePath(config.stateDir, "xfer/a", path)).not.toBe(
          resolveImportBundlePath(config.stateDir, "xfer:a", path),
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "rejects HTTP bundle download when staged file digest, size, or maxBytes mismatches signed claims",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const routeContext = yield* Effect.context<
          | ServerConfig.ServerConfig
          | FileSystem.FileSystem
          | Path.Path
          | AssetSigner.AssetSigner
          | SecureRandom.SecureRandom
        >();

        const routesLayer = layerSessionTransferBundleDownloadRoute.pipe(
          Layer.provideMerge(Layer.succeedContext(routeContext)),
        );
        const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });

        try {
          const transferId = "xfer-download-verify";
          const original = new TextEncoder().encode("original-bundle-bytes-12345");
          const originalSha = NodeCrypto.createHash("sha256").update(original).digest("hex");

          const exportPath = resolveExportBundlePath(config.stateDir, transferId, path)!;
          yield* fs.makeDirectory(path.dirname(exportPath), { recursive: true });
          yield* fs.writeFile(exportPath, original);

          const signedWithDigestAndSize = yield* issueSessionTransferBundleUrl({
            transferId,
            operation: "download",
            expectedSizeBytes: original.byteLength,
            expectedSha256: originalSha,
          });

          // Same-length tampered payload triggers SHA-256 mismatch (409).
          const sameLengthTampered = new TextEncoder().encode("tampered-bundle-bytes-12345");
          expect(sameLengthTampered.byteLength).toBe(original.byteLength);
          yield* fs.writeFile(exportPath, sameLengthTampered);

          const shaMismatchRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${signedWithDigestAndSize.relativeUrl}`, {
                method: "GET",
              }),
            ),
          );
          expect(shaMismatchRes.status).toBe(409);

          // Different-length file triggers expectedSizeBytes mismatch (409).
          yield* fs.writeFile(exportPath, new TextEncoder().encode("shorter"));
          const sizeMismatchRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${signedWithDigestAndSize.relativeUrl}`, {
                method: "GET",
              }),
            ),
          );
          expect(sizeMismatchRes.status).toBe(409);

          // File exceeding signed maxBytes triggers 409.
          const tightCapUrl = yield* issueSessionTransferBundleUrl({
            transferId,
            operation: "download",
            maxBytes: 4,
          });
          const overMaxRes = yield* Effect.promise(() =>
            handler(new Request(`http://127.0.0.1${tightCapUrl.relativeUrl}`, { method: "GET" })),
          );
          expect(overMaxRes.status).toBe(409);
        } finally {
          yield* Effect.promise(() => dispose());
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces exact Content-Length on upload and cleans up temp .part files on mismatch",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const routeContext = yield* Effect.context<
          | ServerConfig.ServerConfig
          | FileSystem.FileSystem
          | Path.Path
          | AssetSigner.AssetSigner
          | SecureRandom.SecureRandom
        >();

        const routesLayer = layerSessionTransferBundleUploadRoute.pipe(
          Layer.provideMerge(Layer.succeedContext(routeContext)),
        );
        const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });

        try {
          const transferId = "xfer-content-length";
          const payload = new TextEncoder().encode("exact-length-payload");
          const uploadUrl = yield* issueSessionTransferBundleUrl({
            transferId,
            operation: "upload",
          });
          const claims = (yield* validateSessionTransferBundleToken(uploadUrl.token, "upload"))!;
          const importPath = resolveImportBundlePath(config.stateDir, transferId, path)!;
          const stagingDir = resolveTransferStagingDir(config.stateDir, transferId, path)!;

          // Non-numeric Content-Length header via HTTP route is rejected with 400.
          const badHeaderRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${uploadUrl.relativeUrl}`, {
                method: "POST",
                headers: { "content-length": "12abc" },
                body: payload,
              }),
            ),
          );
          expect(badHeaderRes.status).toBe(400);
          expect(yield* fs.exists(importPath)).toBe(false);

          // Truncated stream (fewer bytes than declared Content-Length) returns 400 and cleans .part.
          const truncatedResult = yield* storeSessionTransferBundleUpload(
            claims,
            Stream.make(payload.slice(0, 5)),
            { expectedContentLength: payload.byteLength },
          );
          expect(truncatedResult.ok).toBe(false);
          if (!truncatedResult.ok) {
            expect(truncatedResult.status).toBe(400);
          }
          expect(yield* fs.exists(importPath)).toBe(false);
          const entriesAfterTruncated = yield* fs.readDirectory(stagingDir);
          expect(entriesAfterTruncated.some((name) => name.endsWith(".part"))).toBe(false);

          // Over-long stream (more bytes than declared Content-Length) returns 400 and cleans .part.
          const overlongResult = yield* storeSessionTransferBundleUpload(
            claims,
            Stream.make(payload, new TextEncoder().encode("extra")),
            { expectedContentLength: payload.byteLength },
          );
          expect(overlongResult.ok).toBe(false);
          if (!overlongResult.ok) {
            expect(overlongResult.status).toBe(400);
          }
          expect(yield* fs.exists(importPath)).toBe(false);
          const entriesAfterOverlong = yield* fs.readDirectory(stagingDir);
          expect(entriesAfterOverlong.some((name) => name.endsWith(".part"))).toBe(false);

          // Exact Content-Length succeeds via HTTP route.
          const exactRes = yield* Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${uploadUrl.relativeUrl}`, {
                method: "POST",
                headers: { "content-length": String(payload.byteLength) },
                body: payload,
              }),
            ),
          );
          expect(exactRes.status).toBe(204);
          expect(new Uint8Array(yield* fs.readFile(importPath))).toEqual(payload);
        } finally {
          yield* Effect.promise(() => dispose());
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "publishes competing concurrent uploads atomically without clobbering or leaving .part files",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // 1. Concurrent identical uploads both succeed atomically.
        const sameTransferId = "xfer-race-same";
        const samePayload = new TextEncoder().encode("identical-concurrent-bundle-bytes");
        const sameUrl = yield* issueSessionTransferBundleUrl({
          transferId: sameTransferId,
          operation: "upload",
        });
        const sameClaims = (yield* validateSessionTransferBundleToken(sameUrl.token, "upload"))!;

        const sameResults = yield* Effect.all(
          [
            storeSessionTransferBundleUpload(sameClaims, Stream.make(samePayload), {
              expectedContentLength: samePayload.byteLength,
            }),
            storeSessionTransferBundleUpload(sameClaims, Stream.make(samePayload), {
              expectedContentLength: samePayload.byteLength,
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(sameResults.every((r) => r.ok)).toBe(true);
        const sameImportPath = resolveImportBundlePath(config.stateDir, sameTransferId, path)!;
        expect(new Uint8Array(yield* fs.readFile(sameImportPath))).toEqual(samePayload);
        const sameEntries = yield* fs.readDirectory(
          resolveTransferStagingDir(config.stateDir, sameTransferId, path)!,
        );
        expect(sameEntries.some((name) => name.endsWith(".part"))).toBe(false);

        // 2. Concurrent conflicting uploads: exactly one publishes and the other gets 409 without clobbering.
        const diffTransferId = "xfer-race-conflict";
        const payloadA = new TextEncoder().encode("competing-bundle-payload-AAAA");
        const payloadB = new TextEncoder().encode("competing-bundle-payload-BBBB");
        const diffUrl = yield* issueSessionTransferBundleUrl({
          transferId: diffTransferId,
          operation: "upload",
        });
        const diffClaims = (yield* validateSessionTransferBundleToken(diffUrl.token, "upload"))!;

        const diffResults = yield* Effect.all(
          [
            storeSessionTransferBundleUpload(diffClaims, Stream.make(payloadA), {
              expectedContentLength: payloadA.byteLength,
            }),
            storeSessionTransferBundleUpload(diffClaims, Stream.make(payloadB), {
              expectedContentLength: payloadB.byteLength,
            }),
          ],
          { concurrency: "unbounded" },
        );
        const successes = diffResults.filter((r) => r.ok);
        const conflicts = diffResults.filter((r) => !r.ok && r.status === 409);
        expect(successes).toHaveLength(1);
        expect(conflicts).toHaveLength(1);

        const diffImportPath = resolveImportBundlePath(config.stateDir, diffTransferId, path)!;
        const winningBytes = new Uint8Array(yield* fs.readFile(diffImportPath));
        const matchesA = Buffer.from(winningBytes).equals(Buffer.from(payloadA));
        const matchesB = Buffer.from(winningBytes).equals(Buffer.from(payloadB));
        expect(matchesA || matchesB).toBe(true);

        const diffEntries = yield* fs.readDirectory(
          resolveTransferStagingDir(config.stateDir, diffTransferId, path)!,
        );
        expect(diffEntries.some((name) => name.endsWith(".part"))).toBe(false);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "sweeps orphaned .part and stale transfer bundles past 1-hour TTL while preserving fresh ones",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const staleDir = resolveTransferStagingDir(config.stateDir, "xfer-stale", path)!;
        const freshDir = resolveTransferStagingDir(config.stateDir, "xfer-fresh", path)!;
        yield* fs.makeDirectory(staleDir, { recursive: true });
        yield* fs.makeDirectory(freshDir, { recursive: true });

        const stalePart = path.join(staleDir, "import.bundle.abc.part");
        const staleExport = path.join(staleDir, "export.bundle");
        const freshPart = path.join(freshDir, "import.bundle.xyz.part");
        yield* fs.writeFileString(stalePart, "orphan-part");
        yield* fs.writeFileString(staleExport, "stale-export");
        yield* fs.writeFileString(freshPart, "fresh-part");

        const nowMs = (yield* Clock.currentTimeMillis) + SESSION_TRANSFER_STALE_TTL_MS * 2;
        const staleSec = Math.floor((nowMs - SESSION_TRANSFER_STALE_TTL_MS - 60_000) / 1000);
        const freshSec = Math.floor(nowMs / 1000);
        NodeFS.utimesSync(stalePart, staleSec, staleSec);
        NodeFS.utimesSync(staleExport, staleSec, staleSec);
        NodeFS.utimesSync(staleDir, staleSec, staleSec);
        NodeFS.utimesSync(freshPart, freshSec, freshSec);

        const swept = yield* sweepStaleSessionTransferStaging({
          stateDir: config.stateDir,
          nowMs,
        });
        expect(swept.deletedFiles).toBe(2);
        expect(swept.deletedDirs).toBe(1);
        expect(yield* fs.exists(staleDir)).toBe(false);
        expect(yield* fs.exists(freshPart)).toBe(true);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "streams from the single verified FileHandle with zero TOCTOU on file replacement and closes descriptors on error/cancel",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const routeContext = yield* Effect.context<
          | ServerConfig.ServerConfig
          | FileSystem.FileSystem
          | Path.Path
          | AssetSigner.AssetSigner
          | SecureRandom.SecureRandom
        >();

        const openedHandles: Array<NodeFSP.FileHandle> = [];
        const closeSpies: Array<ReturnType<typeof vi.spyOn>> = [];
        const createReadStreamSpies: Array<ReturnType<typeof vi.spyOn>> = [];
        const trackHandle = (handle: NodeFSP.FileHandle) => {
          openedHandles.push(handle);
          closeSpies.push(vi.spyOn(handle, "close"));
          createReadStreamSpies.push(vi.spyOn(handle, "createReadStream"));
        };

        const routesLayer = layerSessionTransferBundleDownloadRoute.pipe(
          Layer.provideMerge(Layer.succeedContext(routeContext)),
        );
        const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });

        try {
          const transferId = "xfer-toctou-check";
          const originalBytes = new Uint8Array(128 * 1024);
          for (let i = 0; i < originalBytes.byteLength; i += 1) {
            originalBytes[i] = i % 251;
          }
          const originalSha = NodeCrypto.createHash("sha256").update(originalBytes).digest("hex");

          const exportPath = resolveExportBundlePath(config.stateDir, transferId, path)!;
          yield* fs.makeDirectory(path.dirname(exportPath), { recursive: true });
          yield* fs.writeFile(exportPath, originalBytes);

          const issued = yield* issueSessionTransferBundleUrl({
            transferId,
            operation: "download",
            expectedSizeBytes: originalBytes.byteLength,
            expectedSha256: originalSha,
          });
          const claims = (yield* validateSessionTransferBundleToken(issued.token, "download"))!;

          // 1. Verify open handle -> replace path atomically on disk BEFORE consuming stream.
          const resolved = yield* resolveExportBundleForDownload(claims, {
            onFileOpen: trackHandle,
          });
          expect(resolved.ok).toBe(true);
          if (!resolved.ok) return;

          const replacementPath = `${exportPath}.replacement`;
          const tamperedBytes = new TextEncoder().encode("tampered-after-verification!");
          NodeFS.writeFileSync(replacementPath, tamperedBytes);
          NodeFS.renameSync(replacementPath, exportPath);

          // Consuming the stream still yields the exact verified original bytes, never tampered bytes.
          const chunks = yield* Stream.runCollect(resolved.stream);
          const totalLen = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const collected = new Uint8Array(totalLen);
          let cursor = 0;
          for (const chunk of chunks) {
            collected.set(chunk, cursor);
            cursor += chunk.byteLength;
          }
          expect(collected).toEqual(originalBytes);

          // 2. Replacing with wrong bytes (409 size mismatch and 409 SHA mismatch) closes descriptor immediately.
          const sizeMismatch = yield* resolveExportBundleForDownload(claims, {
            onFileOpen: trackHandle,
          });
          expect(sizeMismatch.ok).toBe(false);
          if (!sizeMismatch.ok) {
            expect(sizeMismatch.status).toBe(409);
          }

          const sameLenTampered = new Uint8Array(originalBytes);
          sameLenTampered[0] = (sameLenTampered[0]! + 1) % 256;
          yield* fs.writeFile(exportPath, sameLenTampered);
          const shaMismatch = yield* resolveExportBundleForDownload(claims, {
            onFileOpen: trackHandle,
          });
          expect(shaMismatch.ok).toBe(false);
          if (!shaMismatch.ok) {
            expect(shaMismatch.status).toBe(409);
          }

          // 3. Early stream interruption/cancellation also closes descriptor cleanly (no FD leak).
          yield* fs.writeFile(exportPath, originalBytes);
          const resolvedForCancel = yield* resolveExportBundleForDownload(claims, {
            onFileOpen: trackHandle,
          });
          expect(resolvedForCancel.ok).toBe(true);
          if (!resolvedForCancel.ok) return;
          const partialChunks = yield* Stream.runCollect(Stream.take(resolvedForCancel.stream, 1));
          expect(partialChunks.length).toBe(1);

          // 4. HTTP route serves 200 and handles early web reader cancellation cleanly.
          const cancelRes = yield* Effect.promise(() =>
            handler(new Request(`http://127.0.0.1${issued.relativeUrl}`, { method: "GET" })),
          );
          expect(cancelRes.status).toBe(200);
          const reader = cancelRes.body!.getReader();
          const firstChunk = yield* Effect.promise(() => reader.read());
          expect(firstChunk.done).toBe(false);
          yield* Effect.promise(() => reader.cancel());

          // Stream finalizers and error paths have already completed; assert ZERO leaked FDs
          // and that each FileHandle.close() was invoked deterministically once (no ReadStream double-close).
          expect(openedHandles).toHaveLength(4);
          for (const handle of openedHandles) {
            expect(handle.fd).toBe(-1);
          }
          expect(closeSpies).toHaveLength(4);
          for (const spy of closeSpies) {
            expect(spy).toHaveBeenCalledTimes(1);
          }
          for (const spy of createReadStreamSpies) {
            expect(spy).not.toHaveBeenCalled();
          }
        } finally {
          yield* Effect.promise(() => dispose());
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );
});

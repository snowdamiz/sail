// @effect-diagnostics nodeBuiltinImport:off -- utimesSync sets deterministic old mtimes for stale-file sweep tests and createHash verifies sha256.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
  resolveExportBundlePath,
  resolveImportBundlePath,
  resolveTransferStagingDir,
  SESSION_TRANSFER_STALE_TTL_MS,
  SESSION_TRANSFER_TOKEN_TTL_MS,
  sweepStaleSessionTransferStaging,
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
});

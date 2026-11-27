import { makeAdmission, ServerAdmission } from "../serverAdmission.ts";
import { observeDurableObligations } from "../serverAdmissionObligations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as AssetSigner from "./AssetSigner.ts";
import * as DocumentText from "../provider/DocumentText.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ChatAttachmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import {
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "../orchestration-v2/AttachmentClaims.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  deletePendingAttachment,
  issueAttachmentUploadUrl,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./AttachmentUpload.ts";

const layerTest = AssetSigner.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-upload-" })),
  Layer.provideMerge(
    DocumentText.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 6,
} as const;

const LegacyAttachmentUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
const encodeLegacyAttachmentUploadClaims = Schema.encodeEffect(
  Schema.fromJsonString(LegacyAttachmentUploadClaims),
);

describe("AttachmentUpload", () => {
  it.effect("reads asset signatures during a seal without creating a signing key", () =>
    Effect.gen(function* () {
      const signer = yield* AssetSigner.AssetSigner;
      const store = yield* ServerSecretStore.ServerSecretStore;
      const admission = makeAdmission(Effect.succeed([]));
      const token = Symbol();
      const readSecret = store.get("asset-access-signing-key");
      const verify = (signature: string) =>
        signer.verify("asset", signature).pipe(Effect.provideService(ServerAdmission, admission));
      const sign = signer.sign("asset").pipe(Effect.provideService(ServerAdmission, admission));
      expect(yield* admission.drain(token, "10 seconds")).toEqual({ kind: "sealed" });
      expect(yield* verify("AA")).toBe(false);
      expect(Option.isNone(yield* readSecret)).toBe(true);
      expect((yield* Effect.flip(sign))._tag).toBe("ServerMaintenanceBusy");

      expect(yield* admission.abort(token)).toBe(true);
      const signature = yield* sign;
      expect(Option.isSome(yield* readSecret)).toBe(true);
      expect(yield* admission.drain(Symbol(), "10 seconds")).toEqual({ kind: "sealed" });
      expect(yield* verify(signature)).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "persists and replays immutable uploads (hard links unsupported: %s)",
    (unsupported) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = (claims: Parameters<typeof storeAttachmentUpload>[0], bytes: Uint8Array) =>
          storeAttachmentUpload(claims, bytes).pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              unsupported
                ? {
                    ...fileSystem,
                    link: () =>
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "Unknown",
                          module: "FileSystem",
                          method: "link",
                        }),
                      ),
                  }
                : fileSystem,
            ),
          );
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            cells: [{ cell_type: "markdown", source: ["# Cargo\n", "Violet crates: 19"] }],
          }),
        );
        const issued = yield* issueAttachmentUploadUrl({
          type: "file",
          name: "cargo.ipynb",
          mimeType: "application/x-ipynb+json",
          sizeBytes: bytes.length,
        });
        const claims = yield* validateAttachmentUploadToken(
          issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length),
        );
        if (!claims) throw new Error("Expected upload claims");
        expect(yield* store(claims, bytes)).toEqual({ ok: true });
        expect(yield* store(claims, bytes)).toEqual({ ok: true });
        const path = NodePath.join(config.attachmentsDir, `${issued.attachmentId}.ipynb`);
        expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("Violet crates: 19");
        const replacement = new TextEncoder().encode(
          new TextDecoder().decode(bytes).replace("Violet crates: 19", "Violet crates: 28"),
        );
        expect(yield* store(claims, replacement)).toMatchObject({
          ok: false,
          status: 409,
        });
        expect(NodeFS.readFileSync(path)).toEqual(Buffer.from(bytes));
        expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("Violet crates: 19");
        const claimed = yield* claimPendingAttachments({
          threadId: "document-thread",
          attachments: [
            {
              type: "file",
              id: ChatAttachmentId.make(issued.attachmentId),
              name: claims.name,
              mimeType: claims.mimeType,
              sizeBytes: bytes.length,
            },
          ],
        });
        expect(claimed.claimedPaths).toHaveLength(2);
        expect(NodeFS.readFileSync(claimed.claimedPaths[1]!, "utf8")).toContain(
          "Violet crates: 19",
        );
        yield* deletePendingAttachment(issued.attachmentId);
        expect(NodeFS.existsSync(path)).toBe(false);
        expect(NodeFS.existsSync(`${path}.txt`)).toBe(false);
        expect(NodeFS.existsSync(claimed.claimedPaths[1]!)).toBe(true);
        yield* releaseClaimedAttachments(claimed.claimedPaths);
        expect(NodeFS.existsSync(claimed.claimedPaths[1]!)).toBe(false);
      }).pipe(Effect.provide(layerTest)),
  );
  it.effect(
    "defers a held upload, then preserves the final write barrier with the writer census",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const census = observeDurableObligations().pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        expect(yield* census).toEqual([]);
        const finalScan = yield* Deferred.make<void>();
        const allowSeal = yield* Deferred.make<void>();
        let scans = 0;
        const admission = makeAdmission(
          census.pipe(
            Effect.tap(() =>
              ++scans === 2
                ? Deferred.succeed(finalScan, undefined).pipe(
                    Effect.andThen(Deferred.await(allowSeal)),
                  )
                : Effect.void,
            ),
          ),
        );
        const issued = yield* issueAttachmentUploadUrl(uploadInput);
        const token = issued.relativeUrl.slice(ATTACHMENT_UPLOAD_ROUTE_PREFIX.length + 1);
        const claims = yield* validateAttachmentUploadToken(token);
        if (!claims) throw new Error("Expected upload claims");
        const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const upload = yield* storeAttachmentUpload(
          claims,
          Stream.fromEffect(
            Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(bytes),
            ),
          ),
        ).pipe(Effect.provideService(ServerAdmission, admission), Effect.forkScoped);
        yield* Deferred.await(reading);

        const first = yield* admission
          .drain(Symbol(), "1 second")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const write = storeAttachmentUpload(claims, bytes).pipe(
          Effect.provideService(ServerAdmission, admission),
        );
        expect(yield* write).toMatchObject({ ok: false, status: 503 });
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(first)).toMatchObject({
          kind: "aborted",
          blockers: ["in-flight"],
        });
        expect(upload.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(upload)).toEqual({ ok: true });

        const second = yield* admission.drain(Symbol(), "1 second").pipe(Effect.forkScoped);
        yield* Deferred.await(finalScan);
        expect(yield* write).toMatchObject({ ok: false, status: 503 });
        expect(
          (yield* admission.run("continuation", Effect.void).pipe(Effect.flip)).retryable,
        ).toBe(true);
        expect(yield* validateAttachmentUploadToken(token)).toEqual(claims);
        yield* Deferred.succeed(allowSeal, undefined);
        expect(yield* Fiber.join(second)).toEqual({ kind: "sealed" });
        const config = yield* ServerConfig.ServerConfig;
        const path = NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`);
        expect(NodeFS.readFileSync(path)).toEqual(Buffer.from(bytes));
        expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([`${issued.attachmentId}.png`]);
      }).pipe(Effect.provide(Layer.merge(layerTest, SqlitePersistence.layerMemory))),
  );

  it.effect("rejects tampered and malformed upload tokens", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const [payload, signature] = token.split(".");

      expect(yield* validateAttachmentUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateAttachmentUploadToken(`${token}.extra`)).toBeNull();
      expect(yield* validateAttachmentUploadToken("garbage")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("accepts unexpired image upload tokens issued before file support", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const signer = yield* AssetSigner.AssetSigner;
      const encodedPayload = base64UrlEncode(
        yield* encodeLegacyAttachmentUploadClaims({
          version: 1,
          kind: "attachment-upload",
          attachmentId: issued.attachmentId,
          name: uploadInput.name,
          mimeType: uploadInput.mimeType,
          sizeBytes: uploadInput.sizeBytes,
          expiresAt: issued.expiresAt,
        }),
      );
      const legacyToken = `${encodedPayload}.${yield* signer.sign(encodedPayload)}`;

      expect(yield* validateAttachmentUploadToken(legacyToken)).toMatchObject({
        type: "image",
        attachmentId: issued.attachmentId,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stores the expected bytes without leaving temporary files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, new Uint8Array([1, 2, 3]))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(yield* storeAttachmentUpload(claims, new Uint8Array(6))).toEqual({ ok: true });
      expect(
        NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`)),
      ).toBe(true);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("streams generic files to a path with their original extension", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl({
        type: "file",
        name: "report.PDF",
        mimeType: "application/pdf",
        sizeBytes: 6,
      });
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(
        yield* storeAttachmentUpload(
          claims,
          Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
        ),
      ).toEqual({ ok: true });
      expect(issued.attachmentId).toMatch(/-pdf$/);
      expect(
        NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.pdf`)),
      ).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));

      yield* deletePendingAttachment(issued.attachmentId);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stores MIME-identified SVG files with a previewable signed extension", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
      for (const name of ["diagram", "diagram.bin"]) {
        const issued = yield* issueAttachmentUploadUrl({
          type: "file",
          name,
          mimeType: "image/svg+xml",
          sizeBytes: bytes.length,
        });
        const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
        const claims = yield* validateAttachmentUploadToken(token);
        if (!claims) throw new Error("Expected valid SVG upload claims.");
        expect(claims.name).toBe(`${name}.svg`);
        expect(issued.attachmentId).toMatch(/-svg$/);
        expect(yield* storeAttachmentUpload(claims, bytes)).toEqual({ ok: true });
        expect(
          NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.svg`)),
        ).toEqual(Buffer.from(bytes));
        const claimed = yield* claimPendingAttachments({
          threadId: "svg-upload-thread",
          attachments: [
            {
              type: "file",
              id: ChatAttachmentId.make(issued.attachmentId),
              name,
              mimeType: "image/svg+xml",
              sizeBytes: bytes.length,
            },
          ],
        });
        expect(claimed.attachments[0]?.name).toBe(`${name}.svg`);
        expect(NodeFS.readFileSync(claimed.claimedPaths[0]!)).toEqual(Buffer.from(bytes));
        yield* releaseClaimedAttachments(claimed.claimedPaths);
        yield* deletePendingAttachment(issued.attachmentId);
      }
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("removes partial streamed uploads that exceed their signed size", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, Stream.make(new Uint8Array(7)))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("removes partial streamed uploads when the upload is interrupted", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const nextChunkRequested = yield* Deferred.make<void>();
      const body = Stream.make(new Uint8Array([1, 2, 3])).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.succeed(nextChunkRequested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
      const upload = yield* storeAttachmentUpload(claims, body).pipe(Effect.forkScoped);

      yield* Deferred.await(nextChunkRequested);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toHaveLength(1);

      yield* Fiber.interrupt(upload);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("deletes pending uploads without deleting thread-owned copies", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const uuid = "00000000-0000-4000-8000-0000000000dd";
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${uuid}.png`);
      const claimedPath = NodePath.join(config.attachmentsDir, `thread-1-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      NodeFS.writeFileSync(claimedPath, Buffer.from("pixels"));

      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`thread-1-${uuid}`);

      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(claimedPath)).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );
});

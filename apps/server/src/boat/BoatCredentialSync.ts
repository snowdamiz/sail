import type { ProjectId, SyncedProjectCredentialEntry } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectCredentials from "../secrets/ProjectCredentials.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { BoatSupervisor } from "./BoatSupervisor.ts";

const BoatMachineProjectState = Schema.Struct({
  id: Schema.String,
  originProjectId: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
});

const BoatMachineState = Schema.Struct({
  id: Schema.String,
  state: Schema.optional(Schema.String),
  projects: Schema.optional(Schema.Array(BoatMachineProjectState)),
});

const BoatDaemonState = Schema.Struct({
  machines: Schema.optional(Schema.Array(BoatMachineState)),
});

const decodeBoatDaemonState = Schema.decodeUnknownOption(BoatDaemonState);

const RUNNING_STATES = new Set(["working", "idle"]);

function syncKey(machineId: string, destinationProjectId: string): string {
  return `${machineId}\0${destinationProjectId}`;
}

function fingerprintCredentials(
  digest: Digest.Digest["Service"],
  credentials: ReadonlyArray<SyncedProjectCredentialEntry>,
): Effect.Effect<string> {
  const canonical = JSON.stringify(
    [...credentials]
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        value: entry.value,
        envVar: entry.envVar ?? null,
        autoGrant: entry.autoGrant,
      })),
  );
  return digest
    .digest(Digest.sha256, new TextEncoder().encode(canonical))
    .pipe(Effect.orDie, Effect.map(Hex.encode));
}

export class BoatCredentialSync extends Context.Service<
  BoatCredentialSync,
  {
    readonly syncProject: (originProjectId: ProjectId) => Effect.Effect<void>;
    readonly syncAllRunning: Effect.Effect<void>;
  }
>()("t3/boat/BoatCredentialSync") {}

const make = Effect.gen(function* () {
  const digest = yield* Digest.Digest;
  const boatSupervisor = yield* BoatSupervisor;
  const serverSettings = yield* ServerSettingsService;
  const projectCredentials = yield* ProjectCredentials.ProjectCredentials;

  const syncedFingerprints = new Map<string, string>();
  const lastStateRef = yield* Ref.make<Option.Option<unknown>>(Option.none());
  const syncLock = yield* Semaphore.make(1);

  const syncFromState = Effect.fn("BoatCredentialSync.syncFromState")(function* (
    rawState: unknown,
    options?: {
      readonly filterOriginProjectIds?: ReadonlySet<ProjectId>;
      readonly forceEmptySync?: boolean;
    },
  ) {
    const syncRpc = boatSupervisor.syncProjectCredentials;
    if (syncRpc === undefined) {
      return;
    }
    const parsed = decodeBoatDaemonState(rawState);
    if (Option.isNone(parsed)) {
      return;
    }
    const machines = parsed.value.machines ?? [];

    // Clear fingerprints for any machine that stopped or disappeared so next wake re-syncs.
    const runningMachineIds = new Set<string>();
    for (const machine of machines) {
      if (machine.state !== undefined && RUNNING_STATES.has(machine.state)) {
        runningMachineIds.add(machine.id);
      }
    }
    for (const key of Array.from(syncedFingerprints.keys())) {
      const separator = key.indexOf("\0");
      const machineId = separator === -1 ? key : key.slice(0, separator);
      if (!runningMachineIds.has(machineId)) {
        syncedFingerprints.delete(key);
      }
    }

    // Collect running targets grouped by originProjectId to resolve each project at most once.
    const targetsByOrigin = new Map<
      ProjectId,
      Array<{ readonly machineId: string; readonly destinationProjectId: string }>
    >();
    for (const machine of machines) {
      if (!runningMachineIds.has(machine.id)) {
        continue;
      }
      for (const project of machine.projects ?? []) {
        // While cloning (`status` set), `project.id` is still the local project id, not destination id.
        if (project.status !== undefined && project.status !== null) {
          continue;
        }
        const originId = project.originProjectId?.trim();
        if (!originId || !project.id) {
          continue;
        }
        const originProjectId = originId as ProjectId;
        if (
          options?.filterOriginProjectIds !== undefined &&
          !options.filterOriginProjectIds.has(originProjectId)
        ) {
          continue;
        }
        const list = targetsByOrigin.get(originProjectId) ?? [];
        list.push({ machineId: machine.id, destinationProjectId: project.id });
        targetsByOrigin.set(originProjectId, list);
      }
    }

    if (targetsByOrigin.size === 0) {
      return;
    }

    for (const [originProjectId, targets] of targetsByOrigin) {
      const { hasConfiguredBookmarks, credentials } =
        yield* projectCredentials.resolveForBoatSync(originProjectId);
      const fingerprint =
        credentials.length === 0 ? "" : yield* fingerprintCredentials(digest, credentials);

      for (const target of targets) {
        const key = syncKey(target.machineId, target.destinationProjectId);
        const previous = syncedFingerprints.get(key);
        if (!hasConfiguredBookmarks && previous === undefined && options?.forceEmptySync !== true) {
          continue;
        }
        if (previous === fingerprint) {
          continue;
        }
        const result = yield* syncRpc({
          machineId: target.machineId,
          projectId: target.destinationProjectId,
          credentials,
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to push project credentials to Boat", {
              machineId: target.machineId,
              projectId: target.destinationProjectId,
              cause: cause.message,
            }),
          ),
          Effect.option,
        );
        if (Option.isSome(result) && result.value.synced) {
          if (credentials.length === 0) {
            syncedFingerprints.delete(key);
          } else {
            syncedFingerprints.set(key, fingerprint);
          }
        }
      }
    }
  });

  const runSync = (options?: {
    readonly filterOriginProjectIds?: ReadonlySet<ProjectId>;
    readonly forceEmptySync?: boolean;
  }): Effect.Effect<void> =>
    syncLock.withPermits(1)(
      Effect.gen(function* () {
        const currentState =
          boatSupervisor.currentState === undefined
            ? yield* Ref.get(lastStateRef)
            : yield* boatSupervisor.currentState;
        const effectiveState = Option.isSome(currentState)
          ? currentState
          : yield* Ref.get(lastStateRef);
        if (Option.isNone(effectiveState)) {
          return;
        }
        yield* syncFromState(effectiveState.value, options);
      }),
    );

  const syncProject = (originProjectId: ProjectId): Effect.Effect<void> =>
    runSync({ filterOriginProjectIds: new Set([originProjectId]), forceEmptySync: true });
  const syncAllRunning: Effect.Effect<void> = runSync();

  if (boatSupervisor.passiveEvents !== undefined) {
    yield* boatSupervisor.passiveEvents.pipe(
      Stream.runForEach((event) => {
        if (event._tag !== "state") {
          return Effect.void;
        }
        return Ref.set(lastStateRef, Option.some(event.state)).pipe(
          Effect.andThen(syncLock.withPermits(1)(syncFromState(event.state))),
        );
      }),
      Effect.ignore,
      Effect.forkScoped,
    );
  }

  let lastBookmarks = (yield* serverSettings.getSettings).projectCredentialBookmarks;
  yield* serverSettings.streamChanges.pipe(
    Stream.runForEach((settings) => {
      const nextBookmarks = settings.projectCredentialBookmarks;
      const changedProjects = new Set<ProjectId>();
      const allProjectIds = new Set([...Object.keys(lastBookmarks), ...Object.keys(nextBookmarks)]);
      for (const projectId of allProjectIds) {
        const before = JSON.stringify(lastBookmarks[projectId as ProjectId] ?? {});
        const after = JSON.stringify(nextBookmarks[projectId as ProjectId] ?? {});
        if (before !== after) {
          changedProjects.add(projectId as ProjectId);
        }
      }
      lastBookmarks = nextBookmarks;
      if (changedProjects.size === 0) {
        return Effect.void;
      }
      return runSync({ filterOriginProjectIds: changedProjects, forceEmptySync: true });
    }),
    Effect.ignore,
    Effect.forkScoped,
  );

  return BoatCredentialSync.of({
    syncProject,
    syncAllRunning,
  });
});

export const layer = Layer.effect(BoatCredentialSync, make);

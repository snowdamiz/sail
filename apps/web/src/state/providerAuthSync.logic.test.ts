import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SECRET_REDACTED,
  ServerSettings,
  type ServerProvider,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  clearProviderAuthSyncAttemptOnFailure,
  createProviderAuthSyncTracker,
  markProviderAuthSyncAttempted,
  planProviderAuthSync,
  summarizeProviderAuthEnvironment,
} from "./providerAuthSync.logic";

const decodeSettings = Schema.decodeSync(ServerSettings);
const DESKTOP = EnvironmentId.make("env-desktop");
const WEB = EnvironmentId.make("env-web");

function makeSettings(input: Partial<Record<string, unknown>> = {}): ServerSettingsType {
  return decodeSettings(input);
}

function makeProvider(
  driver: string,
  authStatus: "authenticated" | "unauthenticated",
  label?: string,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: authStatus === "authenticated" ? "ready" : "warning",
    auth: {
      status: authStatus,
      ...(label ? { label } : {}),
    },
    checkedAt: "2026-11-27T12:00:00.000Z" as ServerProvider["checkedAt"],
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("providerAuthSync.logic", () => {
  it("reconciles disjoint authenticated providers between Desktop and Web without echoing", () => {
    const tracker = createProviderAuthSyncTracker();
    const emptySettings = makeSettings();
    const desktopProviders = [
      makeProvider("claudeAgent", "authenticated", "dev@example.com"),
      makeProvider("codex", "unauthenticated"),
    ];
    const webProviders = [
      makeProvider("claudeAgent", "unauthenticated"),
      makeProvider("codex", "authenticated", "dev@example.com"),
    ];

    // Single environment connected -> no actions.
    expect(
      planProviderAuthSync(
        [summarizeProviderAuthEnvironment(DESKTOP, emptySettings, desktopProviders, 0)],
        tracker,
      ),
    ).toEqual([]);

    // Both connect -> additive reconciliation in both directions with preferExistingNewer: true.
    const actions = planProviderAuthSync(
      [
        summarizeProviderAuthEnvironment(DESKTOP, emptySettings, desktopProviders, 0),
        summarizeProviderAuthEnvironment(WEB, emptySettings, webProviders, 0),
      ],
      tracker,
    );
    expect(actions).toHaveLength(2);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: DESKTOP,
          targetId: WEB,
          preferExistingNewer: true,
        }),
        expect.objectContaining({
          sourceId: WEB,
          targetId: DESKTOP,
          preferExistingNewer: true,
        }),
      ]),
    );
    for (const action of actions) {
      markProviderAuthSyncAttempted(tracker, action);
    }

    // Both settle with Claude + Codex authenticated -> zero follow-up echo actions!
    const bothProviders = [
      makeProvider("claudeAgent", "authenticated", "dev@example.com"),
      makeProvider("codex", "authenticated", "dev@example.com"),
    ];
    const followUp = planProviderAuthSync(
      [
        summarizeProviderAuthEnvironment(DESKTOP, emptySettings, bothProviders, 0),
        summarizeProviderAuthEnvironment(WEB, emptySettings, bothProviders, 0),
      ],
      tracker,
    );
    expect(followUp).toEqual([]);
  });

  it("propagates a live login on Web immediately to Desktop in overwrite mode", () => {
    const tracker = createProviderAuthSyncTracker();
    const emptySettings = makeSettings();
    const initialProviders = [makeProvider("claudeAgent", "authenticated", "dev@example.com")];

    // Initial steady state: both aligned.
    expect(
      planProviderAuthSync(
        [
          summarizeProviderAuthEnvironment(DESKTOP, emptySettings, initialProviders, 0),
          summarizeProviderAuthEnvironment(WEB, emptySettings, initialProviders, 0),
        ],
        tracker,
      ),
    ).toEqual([]);

    // User signs into Cursor on Web.
    const webAfterLogin = [
      ...initialProviders,
      makeProvider("cursor", "authenticated", "dev@example.com"),
    ];
    const actions = planProviderAuthSync(
      [
        summarizeProviderAuthEnvironment(DESKTOP, emptySettings, initialProviders, 0),
        summarizeProviderAuthEnvironment(WEB, emptySettings, webAfterLogin, 0),
      ],
      tracker,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      sourceId: WEB,
      targetId: DESKTOP,
      preferExistingNewer: false,
    });
    markProviderAuthSyncAttempted(tracker, actions[0]!);

    // Desktop settles with Cursor -> no echo back to Web.
    expect(
      planProviderAuthSync(
        [
          summarizeProviderAuthEnvironment(DESKTOP, emptySettings, webAfterLogin, 0),
          summarizeProviderAuthEnvironment(WEB, emptySettings, webAfterLogin, 0),
        ],
        tracker,
      ),
    ).toEqual([]);
  });

  it("propagates manual API key rotations even when redacted settings look identical", () => {
    const tracker = createProviderAuthSyncTracker();
    const settingsWithKey = makeSettings({
      providerInstances: {
        antigravity: {
          driver: "antigravity",
          config: { authMethod: "gemini-api-key", apiKey: SECRET_REDACTED },
        },
      },
    });

    expect(
      planProviderAuthSync(
        [
          summarizeProviderAuthEnvironment(DESKTOP, settingsWithKey, [], 0),
          summarizeProviderAuthEnvironment(WEB, settingsWithKey, [], 0),
        ],
        tracker,
      ),
    ).toEqual([]);

    // User rotates Gemini API key on Desktop -> manualRevision bumps to 1.
    const actions = planProviderAuthSync(
      [
        summarizeProviderAuthEnvironment(DESKTOP, settingsWithKey, [], 1),
        summarizeProviderAuthEnvironment(WEB, settingsWithKey, [], 0),
      ],
      tracker,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      sourceId: DESKTOP,
      targetId: WEB,
      preferExistingNewer: false,
    });
  });

  it("clears failed attempt state so a subsequent tick retries", () => {
    const tracker = createProviderAuthSyncTracker();
    const emptySettings = makeSettings();
    const desktopProviders = [makeProvider("claudeAgent", "authenticated")];

    const first = planProviderAuthSync(
      [
        summarizeProviderAuthEnvironment(DESKTOP, emptySettings, desktopProviders, 0),
        summarizeProviderAuthEnvironment(WEB, emptySettings, [], 0),
      ],
      tracker,
    );
    expect(first).toHaveLength(1);
    markProviderAuthSyncAttempted(tracker, first[0]!);
    clearProviderAuthSyncAttemptOnFailure(tracker, first[0]!);

    const retry = planProviderAuthSync(
      [
        summarizeProviderAuthEnvironment(DESKTOP, emptySettings, desktopProviders, 0),
        summarizeProviderAuthEnvironment(WEB, emptySettings, [], 0),
      ],
      tracker,
    );
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ sourceId: DESKTOP, targetId: WEB });
  });
});

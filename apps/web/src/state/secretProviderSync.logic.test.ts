import {
  EnvironmentId,
  SECRET_REDACTED,
  ServerSettings,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  clearPortableSyncAttemptOnFailure,
  createPortableSyncTracker,
  markPortableSyncAttempted,
  planPortableSecretSync,
  summarizePortableEnvironment,
} from "./secretProviderSync.logic";

const decodeSettings = Schema.decodeSync(ServerSettings);
const DESKTOP = EnvironmentId.make("env-desktop");
const WEB = EnvironmentId.make("env-web");

function makeSettings(input: Partial<Record<string, unknown>> = {}): ServerSettingsType {
  return decodeSettings(input);
}

describe("secretProviderSync.logic", () => {
  it("syncs a 1Password service account connected on Desktop to a newly connected Web host", () => {
    const tracker = createPortableSyncTracker();
    const desktopSettings = makeSettings({
      secretProviders: {
        "1password": {
          kind: "one_password",
          label: "1Password",
          config: { serviceAccountToken: SECRET_REDACTED },
        },
      },
      repoCredentialBookmarks: {
        "github.com/acme/app": {
          stripe: {
            label: "Stripe key",
            reference: { provider: "1password", reference: "op://Dev/Stripe/key" },
            envVar: "STRIPE_SECRET_KEY",
          },
        },
      },
    });
    const emptyWebSettings = makeSettings();

    // Only Desktop connected initially -> no actions.
    expect(
      planPortableSecretSync([summarizePortableEnvironment(DESKTOP, desktopSettings, 0)], tracker),
    ).toEqual([]);

    // Web connects -> Desktop pushes portable provider + repo bookmarks to Web.
    const actions = planPortableSecretSync(
      [
        summarizePortableEnvironment(DESKTOP, desktopSettings, 0),
        summarizePortableEnvironment(WEB, emptyWebSettings, 0),
      ],
      tracker,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      sourceId: DESKTOP,
      targetId: WEB,
      removeProviderIds: [],
    });
    markPortableSyncAttempted(tracker, actions[0]!);

    // Web settles with the imported settings -> no echo back to Desktop!
    const followUp = planPortableSecretSync(
      [
        summarizePortableEnvironment(DESKTOP, desktopSettings, 0),
        summarizePortableEnvironment(WEB, desktopSettings, 0),
      ],
      tracker,
    );
    expect(followUp).toEqual([]);
  });

  it("syncs from Web to Desktop when 1Password was connected on Web first", () => {
    const tracker = createPortableSyncTracker();
    const webSettings = makeSettings({
      secretProviders: {
        "1password": {
          kind: "one_password",
          label: "1Password",
          config: { serviceAccountToken: SECRET_REDACTED },
        },
      },
    });
    const actions = planPortableSecretSync(
      [
        summarizePortableEnvironment(DESKTOP, makeSettings(), 0),
        summarizePortableEnvironment(WEB, webSettings, 0),
      ],
      tracker,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      sourceId: WEB,
      targetId: DESKTOP,
      removeProviderIds: [],
    });
  });

  it("ignores local CLI-only 1Password providers", () => {
    const tracker = createPortableSyncTracker();
    const cliDesktop = makeSettings({
      secretProviders: {
        local: {
          kind: "one_password",
          label: "Local CLI",
          config: { account: "my.1password.com" },
        },
      },
    });
    const actions = planPortableSecretSync(
      [
        summarizePortableEnvironment(DESKTOP, cliDesktop, 0),
        summarizePortableEnvironment(WEB, makeSettings(), 0),
      ],
      tracker,
    );
    expect(actions).toEqual([]);
  });

  it("propagates provider removal from one host to the other without resurrecting it", () => {
    const tracker = createPortableSyncTracker();
    const bothConfigured = makeSettings({
      secretProviders: {
        "1password": {
          kind: "one_password",
          label: "1Password",
          config: { serviceAccountToken: SECRET_REDACTED },
        },
      },
    });

    // Already converged.
    expect(
      planPortableSecretSync(
        [
          summarizePortableEnvironment(DESKTOP, bothConfigured, 0),
          summarizePortableEnvironment(WEB, bothConfigured, 0),
        ],
        tracker,
      ),
    ).toEqual([]);

    // User removes 1Password on Desktop.
    const removedActions = planPortableSecretSync(
      [
        summarizePortableEnvironment(DESKTOP, makeSettings(), 0),
        summarizePortableEnvironment(WEB, bothConfigured, 0),
      ],
      tracker,
    );
    expect(removedActions).toHaveLength(1);
    expect(removedActions[0]).toMatchObject({
      sourceId: DESKTOP,
      targetId: WEB,
      removeProviderIds: ["1password"],
    });
    markPortableSyncAttempted(tracker, removedActions[0]!);

    // Web settles with 1Password removed -> converged, no echo.
    expect(
      planPortableSecretSync(
        [
          summarizePortableEnvironment(DESKTOP, makeSettings(), 0),
          summarizePortableEnvironment(WEB, makeSettings(), 0),
        ],
        tracker,
      ),
    ).toEqual([]);
  });

  it("re-syncs when a service account token is rotated via manual revision bump", () => {
    const tracker = createPortableSyncTracker();
    const shared = makeSettings({
      secretProviders: {
        "1password": {
          kind: "one_password",
          label: "1Password",
          config: { serviceAccountToken: SECRET_REDACTED },
        },
      },
    });

    expect(
      planPortableSecretSync(
        [
          summarizePortableEnvironment(DESKTOP, shared, 0),
          summarizePortableEnvironment(WEB, shared, 0),
        ],
        tracker,
      ),
    ).toEqual([]);

    const rotated = planPortableSecretSync(
      [
        summarizePortableEnvironment(DESKTOP, shared, 1),
        summarizePortableEnvironment(WEB, shared, 0),
      ],
      tracker,
    );
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatchObject({
      sourceId: DESKTOP,
      targetId: WEB,
      removeProviderIds: [],
    });

    // If transfer fails, clearing allows retry on next tick.
    markPortableSyncAttempted(tracker, rotated[0]!);
    clearPortableSyncAttemptOnFailure(tracker, rotated[0]!);
    const retried = planPortableSecretSync(
      [
        summarizePortableEnvironment(DESKTOP, shared, 2),
        summarizePortableEnvironment(WEB, shared, 0),
      ],
      tracker,
    );
    expect(retried).toHaveLength(1);
  });
});

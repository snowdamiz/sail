import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  armPotetoMode,
  disarmPotetoMode,
  isPotetoModeActiveInSession,
  readPotetoModeArm,
  resolveComposerPotetoModeState,
  togglePotetoModeArm,
} from "./potetoModeArms";

const NOW = DateTime.makeUnsafe("2026-11-28T00:00:00.000Z");

describe("potetoModeArms", () => {
  it("toggles, reads, and disarms thread-scoped arms with stale-arm protection", () => {
    const key = "env:thread-poteto-arms";
    disarmPotetoMode(key);
    expect(readPotetoModeArm(key)).toBeUndefined();

    expect(togglePotetoModeArm(key)).toBe(true);
    const firstArm = readPotetoModeArm(key);
    expect(firstArm).toBeTypeOf("number");

    // A stale arm timestamp must not clear a newer arm.
    disarmPotetoMode(key, (firstArm ?? 0) - 1);
    expect(readPotetoModeArm(key)).toBe(firstArm);

    disarmPotetoMode(key, firstArm);
    expect(readPotetoModeArm(key)).toBeUndefined();

    armPotetoMode(key);
    expect(togglePotetoModeArm(key)).toBe(false);
    expect(readPotetoModeArm(key)).toBeUndefined();
  });

  it("tracks once-per-session activation across first prompt, mid-session, retries, and /clear", () => {
    expect(isPotetoModeActiveInSession([])).toBe(false);

    // Mid-session: turn 1 did not enable poteto mode -> still inactive.
    expect(isPotetoModeActiveInSession([{ ordinal: 1, status: "completed", startedAt: NOW }])).toBe(
      false,
    );

    // Mid-session: turn 2 enabled poteto mode -> active for this session.
    expect(
      isPotetoModeActiveInSession([
        { ordinal: 1, status: "completed", startedAt: NOW },
        { ordinal: 2, status: "completed", startedAt: NOW, potetoMode: true },
      ]),
    ).toBe(true);

    // Queued run with potetoMode counts as active immediately so follow-ups don't re-trigger.
    expect(
      isPotetoModeActiveInSession([
        { ordinal: 1, status: "running", startedAt: NOW },
        { ordinal: 2, status: "queued", startedAt: null, potetoMode: true },
      ]),
    ).toBe(true);

    // Cancelled or failed before start never reached the provider -> not active.
    expect(
      isPotetoModeActiveInSession([
        { ordinal: 1, status: "cancelled", startedAt: null, potetoMode: true },
        { ordinal: 2, status: "failed", startedAt: null, potetoMode: true },
      ]),
    ).toBe(false);

    // Pending /clear (freshSessionArmed) resets the upcoming session to inactive.
    expect(
      isPotetoModeActiveInSession(
        [{ ordinal: 1, status: "completed", startedAt: NOW, potetoMode: true }],
        true,
      ),
    ).toBe(false);

    // Started freshContext run starts a new session boundary.
    expect(
      isPotetoModeActiveInSession([
        { ordinal: 1, status: "completed", startedAt: NOW, potetoMode: true },
        { ordinal: 2, status: "completed", startedAt: NOW, freshContext: true },
      ]),
    ).toBe(false);

    // Enabling poteto mode again after the fresh session boundary activates the new session.
    expect(
      isPotetoModeActiveInSession([
        { ordinal: 1, status: "completed", startedAt: NOW, potetoMode: true },
        { ordinal: 2, status: "completed", startedAt: NOW, freshContext: true },
        { ordinal: 3, status: "running", startedAt: NOW, potetoMode: true },
      ]),
    ).toBe(true);
  });

  it("resolves composer toggle state with active taking precedence over armed", () => {
    expect(resolveComposerPotetoModeState({ activeInSession: false, armed: false })).toBe("off");
    expect(resolveComposerPotetoModeState({ activeInSession: false, armed: true })).toBe("armed");
    expect(resolveComposerPotetoModeState({ activeInSession: true, armed: false })).toBe("active");
    expect(resolveComposerPotetoModeState({ activeInSession: true, armed: true })).toBe("active");
  });
});

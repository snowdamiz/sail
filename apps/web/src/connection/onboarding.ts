import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export interface OwnerPasswordSignInInput {
  readonly server: Extract<ConnectionOnboarding.OwnerPasswordHost, { readonly kind: "ready" }>;
  readonly password: Redacted.Redacted<string>;
}

export const probeOwnerPassword = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:probe-owner-password",
  execute: (destination: ConnectionOnboarding.OwnerPasswordDestination) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.probeOwnerPasswordHost(destination)),
    ),
});

export const connectOwnerPassword = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-owner-password",
  execute: (input: OwnerPasswordSignInInput) => input.server.signIn(input.password),
});

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});

export const reachesEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:reaches-environment",
  execute: (input: { readonly host: string; readonly environmentId: EnvironmentId }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.reaches(input)),
    ),
});

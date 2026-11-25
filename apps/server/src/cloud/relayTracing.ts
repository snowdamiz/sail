import type { ManagedPolicySummary } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

/** Sail disables T3 Connect relay tracing unconditionally. */
export const allowedFor = (
  _env: Readonly<Record<string, string | undefined>>,
  _policy: ManagedPolicySummary | undefined,
) => false;

/** Sail disables T3 Connect relay tracing unconditionally. */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  _tracingConfig = resolveRelayClientTracingConfig(),
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* ManagedPolicy.ManagedPolicy;
      yield* HostProcess.Environment;
      return RelayTracing.layer(
        null,
        { ...resource, serviceInstanceId: processServiceInstanceId() },
        { isEnabled: () => false },
      );
    }),
  );

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});

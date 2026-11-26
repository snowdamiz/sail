import { WS_METHODS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  acknowledgeRpcRequest,
  subscribeSlowRpcAckRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";

it("gives a Boats command as long as the other slow commands a user starts", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  let slow: ReadonlyArray<string> = [];
  const unsubscribe = subscribeSlowRpcAckRequests((requests) => {
    slow = requests.map((request) => request.tag);
  });
  try {
    trackRpcRequestSent("boats", WS_METHODS.boatsInvoke);
    trackRpcRequestSent("update", WS_METHODS.serverUpdateProvider);
    trackRpcRequestSent("read", WS_METHODS.projectsReadFile);

    vi.advanceTimersByTime(15_000);
    expect(slow).toEqual([WS_METHODS.projectsReadFile]);

    vi.advanceTimersByTime(105_000);
    expect(slow).toEqual([
      WS_METHODS.projectsReadFile,
      WS_METHODS.boatsInvoke,
      WS_METHODS.serverUpdateProvider,
    ]);
  } finally {
    for (const requestId of ["boats", "update", "read"]) acknowledgeRpcRequest(requestId);
    unsubscribe();
    vi.useRealTimers();
  }
});

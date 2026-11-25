import { DesktopBoatStatusSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopBoatSupervisor from "../../boat/DesktopBoatSupervisor.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getBoatStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BOAT_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopBoatStatusSchema,
  handler: Effect.fn("desktop.ipc.boat.getStatus")(function* () {
    const boat = yield* DesktopBoatSupervisor.DesktopBoatSupervisor;
    return yield* boat.getStatus;
  }),
});

export const invokeBoatCommand = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BOAT_INVOKE_CHANNEL,
  payload: Schema.Struct({
    command: Schema.String,
    args: Schema.optional(Schema.Unknown),
  }),
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.boat.invoke")(function* ({ command, args }) {
    const boat = yield* DesktopBoatSupervisor.DesktopBoatSupervisor;
    return yield* boat.invoke(command, args);
  }),
});

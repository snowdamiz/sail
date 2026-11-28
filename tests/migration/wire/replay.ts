import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

import replay from "./incumbent-replay-v2.json" with { type: "json" };
import incumbent from "./incumbent-v2.json" with { type: "json" };
import { openWireSocket, type WireSocket } from "./socket.ts";

const dispatch = "orchestration.dispatchCommand";
const subscribe = "orchestration.subscribeThread";
const projection = "orchestration.getThreadProjection";

type WireRecord = Readonly<Record<string, unknown>>;

function object(value: unknown, context: string): WireRecord {
  NodeAssert.ok(value && typeof value === "object" && !Array.isArray(value), context);
  return value as WireRecord;
}

function array(value: unknown, context: string): ReadonlyArray<unknown> {
  NodeAssert.ok(Array.isArray(value), context);
  return value;
}

function sequence(value: unknown, context: string): number {
  NodeAssert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, context);
  return value;
}

function request(socket: WireSocket, id: string, tag: string, payload: unknown) {
  socket.send({ _tag: "Request", id, tag, payload, headers: [] });
}

function exitFrame(frame: WireRecord, requestId: string) {
  NodeAssert.equal(frame._tag, "Exit");
  NodeAssert.equal(frame.requestId, requestId);
  return object(frame.exit, "Expected an Exit result");
}

async function exit(socket: WireSocket, requestId: string) {
  return exitFrame(object(await socket.receive(), "Expected an RPC Exit"), requestId);
}

async function call(socket: WireSocket, id: string, tag: string, payload: unknown) {
  request(socket, id, tag, payload);
  const result = await exit(socket, id);
  NodeAssert.equal(result._tag, "Success", tag);
  return object(result.value, tag);
}

async function* subscribeThread(
  socket: WireSocket,
  payload: { readonly threadId: string; readonly afterSequence?: number },
) {
  request(socket, "1", subscribe, { ...payload, requestCompletionMarker: true });
  while (true) {
    const frame = object(await socket.receive(), "Thread stream closed before completion");
    NodeAssert.equal(frame._tag, "Chunk");
    NodeAssert.equal(frame.requestId, "1");
    const values = array(frame.values, "Expected thread stream values");
    NodeAssert.ok(values.length > 0, "Expected a nonempty thread stream chunk");
    socket.send({ _tag: "Ack", requestId: "1" });
    for (const value of values) {
      yield object(value, "Expected a thread stream record");
    }
  }
}

type ThreadStream = ReturnType<typeof subscribeThread>;

async function next(stream: ThreadStream) {
  const item = await stream.next();
  NodeAssert.ok(!item.done, "Thread subscription ended");
  return item.value;
}

function threadFields(value: unknown) {
  const thread = object(value, "Expected the thread projection");
  return {
    id: thread.id,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
  };
}

function messageFields(value: unknown) {
  const message = object(value, "Expected a conversation message");
  return { role: message.role, text: message.text, streaming: message.streaming };
}

async function start(stream: ThreadStream, expected: typeof replay.expected) {
  const snapshot = await next(stream);
  NodeAssert.equal(snapshot.kind, "snapshot");
  const state = object(snapshot.projection, "Expected the initial thread projection");
  NodeAssert.deepEqual(threadFields(state.thread), expected.thread);
  for (const key of ["runs", "messages", "turnItems"]) {
    NodeAssert.deepEqual(state[key], [], `Expected empty ${key} in the initial snapshot`);
  }
  NodeAssert.deepEqual(await next(stream), replay.publishedExamples.synchronized);
  return sequence(snapshot.snapshotSequence, "Expected a snapshot cursor");
}

function event(record: WireRecord, cursor: number, threadId: string) {
  NodeAssert.equal(record.kind, "event", "Expected a thread event");
  const nextCursor = sequence(record.sequence, "Expected an event cursor");
  NodeAssert.ok(nextCursor > cursor, `Event ${nextCursor} repeated or preceded cursor ${cursor}`);
  const value = object(record.event, "Expected a domain event");
  NodeAssert.equal(value.threadId, threadId, "Thread event escaped its subscription");
  return {
    cursor: nextCursor,
    type: value.type,
    payload: object(value.payload, "Expected event data"),
  };
}

export async function checkReplay(
  origin: URL,
  tokens: { readonly operate: string; readonly read: string },
  workspaceRoot: string,
  fixture = replay,
) {
  NodeAssert.ok(NodePath.isAbsolute(workspaceRoot), "Pass an absolute Replay workspace path");
  const signal = AbortSignal.timeout(25_000);
  const open = (token: string) => openWireSocket(origin, token, signal, incumbent.socket);
  const { createThread, sendMessage, expected } = fixture;
  const { threadId } = createThread;
  const project = await fetch(new URL("/api/projects/mutate", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.operate}`, "content-type": "application/json" },
    body: JSON.stringify({ ...fixture.project, workspaceRoot }),
    redirect: "error",
    signal,
  });
  NodeAssert.equal(project.status, 200, "Seeding the Replay project");
  await project.body?.cancel();

  await using writer = await open(tokens.operate);
  const created = await call(writer, "1", dispatch, createThread);
  await using initial = await open(tokens.read);
  const initialStream = subscribeThread(initial, { threadId });
  const snapshotCursor = await start(initialStream, expected);
  NodeAssert.equal(created.sequence, snapshotCursor);

  await using witness = await open(tokens.read);
  const witnessStream = subscribeThread(witness, { threadId });
  NodeAssert.equal(await start(witnessStream, expected), snapshotCursor);

  const accepted = await call(writer, "2", dispatch, sendMessage);
  const acceptedSequence = sequence(accepted.sequence, "Expected an accepted command receipt");
  NodeAssert.ok(acceptedSequence > snapshotCursor, "The send must advance the thread's cursor");
  await writer.close();

  const messages = new Map<string, ReturnType<typeof messageFields>>();
  let cursor = snapshotCursor;
  function apply(record: WireRecord) {
    const update = event(record, cursor, threadId);
    cursor = update.cursor;
    if (update.type === "message.updated") {
      const id = update.payload.id;
      NodeAssert.ok(typeof id === "string" && id.length > 0, "Expected a stable message ID");
      messages.set(id, messageFields(update.payload));
    }
    return update;
  }

  const publishedPartial = fixture.publishedExamples.assistantAtDisconnect.event.payload;
  while (true) {
    const update = apply(await next(initialStream));
    if (update.type === "turn-item.updated" && update.payload.type === publishedPartial.type) {
      NodeAssert.equal(update.payload.status, publishedPartial.status, "Expected a running reply");
      NodeAssert.equal(update.payload.streaming, publishedPartial.streaming);
      const text = update.payload.text;
      NodeAssert.ok(
        typeof text === "string" && text.length > 0 && publishedPartial.text.startsWith(text),
        "Expected the first streamed reply text",
      );
      break;
    }
  }
  const disconnectedAt = cursor;
  await initial.close();
  await initialStream.return(undefined);

  let witnessCursor = snapshotCursor;
  const terminal = fixture.publishedExamples.resumedCompletion.event;
  while (true) {
    const update = event(await next(witnessStream), witnessCursor, threadId);
    witnessCursor = update.cursor;
    if (update.type === terminal.type && update.payload.status === terminal.payload.status) break;
  }
  NodeAssert.ok(
    witnessCursor > disconnectedAt,
    "The turn must advance beyond the disconnected cursor",
  );
  await witness.close();
  await witnessStream.return(undefined);

  await using resumed = await open(tokens.read);
  const resumedStream = subscribeThread(resumed, { threadId, afterSequence: disconnectedAt });
  let sawCompletion = false;
  while (true) {
    const record = await next(resumedStream);
    if (record.kind === "synchronized") {
      NodeAssert.deepEqual(record, fixture.publishedExamples.synchronized);
      break;
    }
    const update = apply(record);
    if (update.type === terminal.type && update.payload.status === terminal.payload.status) {
      NodeAssert.equal(update.cursor, witnessCursor, "Replay changed the terminal event's cursor");
      sawCompletion = true;
    }
  }
  NodeAssert.ok(sawCompletion, "The replay must deliver the completed run before synchronization");
  NodeAssert.deepEqual([...messages.values()], expected.messages, "Replayed conversation messages");
  await resumedStream.return(undefined);
  resumed.send({ _tag: "Interrupt", requestId: "1" });
  let interrupted = object(await resumed.receive(), "Expected the subscription to terminate");
  while (interrupted._tag === "Chunk") {
    NodeAssert.equal(interrupted.requestId, "1");
    const pending = array(interrupted.values, "Expected queued live events");
    NodeAssert.ok(pending.length > 0, "Expected a nonempty queued chunk");
    for (const record of pending) apply(object(record, "Expected a queued live event"));
    resumed.send({ _tag: "Ack", requestId: "1" });
    interrupted = object(await resumed.receive(), "Expected the subscription to terminate");
  }
  NodeAssert.deepEqual(
    exitFrame(interrupted, "1"),
    expected.cancelledExit,
    "Subscription cancellation",
  );

  await using retry = await open(tokens.operate);
  const duplicate = await call(retry, "1", dispatch, sendMessage);
  NodeAssert.deepEqual(duplicate, accepted, "Retrying the send must return the original receipt");

  request(resumed, "2", dispatch, {
    ...sendMessage,
    commandId: "wire-replay-denied",
    messageId: "wire-replay-refused",
  });
  NodeAssert.deepEqual(await exit(resumed, "2"), expected.deniedExit, "Read-only send denial");
  const settled = await call(resumed, "3", projection, { threadId });
  NodeAssert.deepEqual(threadFields(settled.thread), expected.thread);
  NodeAssert.deepEqual(
    array(settled.runs, "Expected completed runs").map(
      (run) => object(run, "Expected a run").status,
    ),
    expected.runs,
  );
  NodeAssert.deepEqual(
    array(settled.messages, "Expected final messages").map(messageFields),
    expected.messages,
    "Final conversation messages after retry and denial",
  );
  resumed.send({ _tag: "Ping" });
  NodeAssert.deepEqual(await resumed.receive(), { _tag: "Pong" });
  await resumed.close();
  NodeAssert.equal(await resumed.receive(), undefined, "Unexpected frame after the final Pong");

  return { snapshotCursor, acceptedSequence, disconnectedAt, resumedThrough: cursor };
}

if (import.meta.main) {
  const [origin, workspaceRoot] = process.argv.slice(2);
  const read = process.env.SAIL_WIRE_READ_TOKEN;
  const operate = process.env.SAIL_WIRE_OPERATE_TOKEN;
  NodeAssert.ok(
    origin && workspaceRoot && read && operate,
    "Pass the origin and Replay workspace, and set both fixture tokens",
  );
  const cursors = await checkReplay(new URL(origin), { read, operate }, workspaceRoot);
  process.stdout.write(`Incumbent Replay v2 checks passed. ${JSON.stringify(cursors)}\n`);
}

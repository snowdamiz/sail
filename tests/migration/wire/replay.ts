import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

import replay from "./incumbent-replay-v2.json" with { type: "json" };
import incumbent from "./incumbent-v2.json" with { type: "json" };
import { openWireSocket, type WireSocket } from "./socket.ts";

const dispatch = "orchestration.dispatchCommand";
const subscribe = "orchestration.subscribeThread";
const projection = "orchestration.getThreadProjection";

type WireRecord = Readonly<Record<string, unknown>>;

const entityFields: Readonly<Record<string, string | undefined>> = {
  "run.created": "runs",
  "run.updated": "runs",
  "run-attempt.created": "attempts",
  "run-attempt.updated": "attempts",
  "node.updated": "nodes",
  "subagent.updated": "subagents",
  "provider-session.attached": "providerSessions",
  "provider-session.updated": "providerSessions",
  "provider-thread.updated": "providerThreads",
  "provider-turn.updated": "providerTurns",
  "runtime-request.updated": "runtimeRequests",
  "message.updated": "messages",
  "plan.updated": "plans",
  "turn-item.updated": "turnItems",
  "checkpoint-scope.created": "checkpointScopes",
  "checkpoint.captured": "checkpoints",
  "context-handoff.created": "contextHandoffs",
  "context-handoff.updated": "contextHandoffs",
  "context-transfer.updated": "contextTransfers",
};

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

function threadChunk(socket: WireSocket, frame: WireRecord) {
  NodeAssert.equal(frame._tag, "Chunk");
  NodeAssert.equal(frame.requestId, "1");
  const values = array(frame.values, "Expected thread stream values");
  NodeAssert.ok(values.length > 0, "Expected a nonempty thread stream chunk");
  socket.send({ _tag: "Ack", requestId: "1" });
  return values.map((value) => object(value, "Expected a thread stream record"));
}

async function* subscribeThread(socket: WireSocket, threadId: string) {
  request(socket, "1", subscribe, { threadId, requestCompletionMarker: true });
  while (true) {
    const frame = object(await socket.receive(), "Thread stream closed before completion");
    yield* threadChunk(socket, frame);
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

function checkProjectionShape(state: WireRecord, expected: typeof replay.expected) {
  NodeAssert.deepEqual(
    [...expected.projectionArrays, "thread", "updatedAt"].filter(
      (field) => !Object.hasOwn(state, field),
    ),
    [],
    "Projection is missing published wire fields",
  );
  const thread = object(state.thread, "Expected a thread projection");
  NodeAssert.deepEqual(
    expected.threadFields.filter((field) => !Object.hasOwn(thread, field)),
    [],
    "Thread is missing published wire fields",
  );
  NodeAssert.deepEqual(threadFields(thread), expected.thread);
  NodeAssert.ok(
    typeof state.updatedAt === "string" && Number.isFinite(Date.parse(state.updatedAt)),
    "Expected projection update time",
  );
  for (const field of expected.projectionArrays)
    array(state[field], `Expected projection ${field}`);
}

async function start(stream: ThreadStream, expected: typeof replay.expected) {
  const snapshot = await next(stream);
  NodeAssert.equal(snapshot.kind, "snapshot");
  const state = object(snapshot.projection, "Expected the initial thread projection");
  checkProjectionShape(state, expected);
  for (const key of expected.projectionArrays) {
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

function coalesced(records: ReadonlyArray<WireRecord>) {
  // Live and replay batches can keep different superseded writes to the same running item.
  const latest = new Map<string, WireRecord>();
  const families = new Map<string, string>();
  const superseded = new Set<WireRecord>();
  for (const record of records) {
    const update = object(record.event, "Expected an event while coalescing");
    const item = object(update.payload, "Expected event data while coalescing");
    let family: string | undefined;
    if (update.type === "message.updated" && item.role === "assistant" && item.streaming === true) {
      family = update.type;
    }
    if (
      update.type === "turn-item.updated" &&
      item.status === "running" &&
      ((item.streaming === true &&
        (item.type === "assistant_message" || item.type === "reasoning")) ||
        item.type === "command_execution" ||
        item.type === "file_change" ||
        item.type === "file_search" ||
        item.type === "web_search" ||
        item.type === "dynamic_tool")
    ) {
      family = update.type;
    }
    if (family === undefined) {
      latest.clear();
      families.clear();
      continue;
    }
    const key = JSON.stringify([update.threadId, update.runId, item.type, item.id]);
    const familyKey = families.get(family);
    if (familyKey !== undefined && familyKey !== key) latest.clear();
    families.set(family, key);
    const previous = latest.get(`${family}:${key}`);
    if (previous) superseded.add(previous);
    latest.set(`${family}:${key}`, record);
  }
  return records.filter((record) => !superseded.has(record));
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
  const initialStream = subscribeThread(initial, threadId);
  const snapshotCursor = await start(initialStream, expected);
  NodeAssert.equal(created.sequence, snapshotCursor);

  await using witness = await open(tokens.read);
  const witnessStream = subscribeThread(witness, threadId);
  NodeAssert.equal(await start(witnessStream, expected), snapshotCursor);

  const accepted = await call(writer, "2", dispatch, sendMessage);
  const acceptedSequence = sequence(accepted.sequence, "Expected an accepted command receipt");
  NodeAssert.deepEqual(accepted, { sequence: acceptedSequence }, "Unexpected send receipt fields");
  NodeAssert.ok(acceptedSequence > snapshotCursor, "The send must advance the thread's cursor");
  await writer.close();

  const messages = new Map<string, WireRecord>();
  const entities = new Map(
    expected.projectionArrays
      .filter((field) => field !== "visibleTurnItems")
      .map((field) => [field, field === "messages" ? messages : new Map<string, WireRecord>()]),
  );
  const streamedMessages = new Set<string>();
  let acceptedEvent: WireRecord | undefined;
  let cursor = snapshotCursor;
  function apply(record: WireRecord) {
    const update = event(record, cursor, threadId);
    cursor = update.cursor;
    if (cursor === acceptedSequence) {
      NodeAssert.equal(
        update.type,
        "turn-item.updated",
        "Expected the send's user item at its receipt cursor",
      );
      NodeAssert.equal(update.payload.type, "user_message");
      NodeAssert.equal(update.payload.messageId, sendMessage.messageId);
      acceptedEvent = update.payload;
    }
    NodeAssert.equal(typeof update.type, "string", "Expected a domain event type");
    const field = entityFields[String(update.type)];
    if (field !== undefined) {
      const rows = entities.get(field);
      NodeAssert.ok(rows, `Unexpected projection category ${field}`);
      const id = update.payload.id;
      NodeAssert.ok(typeof id === "string" && id.length > 0, "Expected a stable entity ID");
      if (field === "messages" && update.payload.streaming === true) streamedMessages.add(id);
      if (field === "providerTurns") {
        NodeAssert.ok(typeof update.payload.nodeId === "string", "Expected a provider-turn node");
        if (rows.get(id)?.status === "completed") {
          NodeAssert.equal(
            update.payload.status,
            "completed",
            "A completed provider turn regressed during replay",
          );
        }
      }
      if (field === "runs" && rows.get(id)?.status === "completed") {
        NodeAssert.equal(
          update.payload.status,
          "completed",
          "A completed run regressed during replay",
        );
      }
      if (field === "turnItems" && rows.get(id)?.status === "completed") {
        NodeAssert.equal(update.payload.status, "completed", "A completed turn item regressed");
        NodeAssert.notEqual(
          update.payload.streaming,
          true,
          "A completed turn item resumed streaming",
        );
      }
      rows.set(id, update.payload);
    }
    return update;
  }

  function checkMessages() {
    NodeAssert.deepEqual(
      [...messages.values()].map(messageFields),
      expected.messages,
      "Replayed conversation messages",
    );
    NodeAssert.deepEqual(
      [...messages.keys()].map((id) => streamedMessages.has(id)),
      expected.messageStreamingObserved,
      "Expected the captured streaming message transitions",
    );
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
  NodeAssert.ok(acceptedEvent, "The live stream did not deliver the send receipt's event");
  await initial.close();
  await initialStream.return(undefined);

  let witnessCursor = snapshotCursor;
  let completedRun: WireRecord | undefined;
  let completedSequence: number | undefined;
  const witnessed: WireRecord[] = [];
  const terminal = fixture.publishedExamples.resumedCompletion.event;
  const idle = fixture.publishedExamples.resumedIdle.event;
  while (true) {
    const record = await next(witnessStream);
    const update = event(record, witnessCursor, threadId);
    witnessCursor = update.cursor;
    if (witnessCursor > disconnectedAt) witnessed.push(record);
    if (update.type === terminal.type && update.payload.status === terminal.payload.status) {
      completedRun = update.payload;
      completedSequence = witnessCursor;
    }
    if (completedRun && update.type === idle.type && update.payload.status === idle.payload.status)
      break;
  }
  NodeAssert.ok(
    completedSequence !== undefined && completedSequence > disconnectedAt,
    "The turn must advance beyond the disconnected cursor",
  );
  await witness.close();
  await witnessStream.return(undefined);

  await using resumed = await open(tokens.read);
  request(resumed, "1", subscribe, {
    threadId,
    afterSequence: disconnectedAt,
    requestCompletionMarker: true,
  });
  const replayOverlap: WireRecord[] = [];
  let resumedThrough: number | undefined;
  while (resumedThrough === undefined) {
    const frame = object(await resumed.receive(), "Replay closed before synchronization");
    for (const record of threadChunk(resumed, frame)) {
      if (record.kind === "synchronized") {
        NodeAssert.equal(resumedThrough, undefined, "Duplicate replay completion marker");
        NodeAssert.deepEqual(record, fixture.publishedExamples.synchronized);
        resumedThrough = cursor;
      } else {
        const update = apply(record);
        if (resumedThrough === undefined && update.cursor <= witnessCursor)
          replayOverlap.push(record);
      }
    }
  }
  NodeAssert.deepEqual(
    coalesced(replayOverlap),
    coalesced(witnessed),
    "Replay changed or omitted witnessed events",
  );
  checkMessages();
  resumed.send({ _tag: "Interrupt", requestId: "1" });
  let interrupted = object(await resumed.receive(), "Expected the subscription to terminate");
  while (interrupted._tag === "Chunk") {
    for (const record of threadChunk(resumed, interrupted)) apply(record);
    interrupted = object(await resumed.receive(), "Expected the subscription to terminate");
  }
  NodeAssert.deepEqual(
    exitFrame(interrupted, "1"),
    expected.cancelledExit,
    "Subscription cancellation",
  );

  checkMessages();

  const settled = await call(resumed, "2", projection, { threadId });
  checkProjectionShape(settled, expected);
  for (const [field, applied] of entities) {
    const projected = new Map<string, WireRecord>();
    for (const entry of array(settled[field], `Expected ${field}`)) {
      const row = object(entry, `Expected a ${field} row`);
      const id = row.id;
      NodeAssert.ok(typeof id === "string" && id.length > 0, `Expected a ${field} ID`);
      NodeAssert.ok(!projected.has(id), `Duplicate ${field} ID ${id}`);
      projected.set(id, row);
    }
    NodeAssert.deepEqual(projected, applied, `Projection disagrees with streamed ${field}`);
  }
  NodeAssert.deepEqual(
    array(settled.messages, "Expected projected messages").map(messageFields),
    expected.messages,
    "Projection changed conversation order",
  );
  const runs = array(settled.runs, "Expected completed runs").map((run) =>
    object(run, "Expected a run"),
  );
  NodeAssert.deepEqual(
    runs.map((run) => run.status),
    expected.runs,
  );
  NodeAssert.deepEqual(runs, [completedRun], "Projection disagrees with the witnessed run");
  const run = runs[0];
  NodeAssert.ok(run);
  NodeAssert.equal(run.userMessageId, sendMessage.messageId);
  for (const [id, message] of messages) {
    NodeAssert.equal(message.runId, run.id);
    NodeAssert.equal(message.threadId, threadId);
    if (message.role === "user") NodeAssert.equal(id, sendMessage.messageId);
  }
  NodeAssert.equal(acceptedEvent.runId, run.id);
  const attempts = array(settled.attempts, "Expected run attempts").map((attempt) =>
    object(attempt, "Expected a run attempt"),
  );
  NodeAssert.deepEqual(
    attempts.map((attempt) => attempt.status),
    expected.attempts,
  );
  for (const attempt of attempts) {
    NodeAssert.equal(attempt.id, run.activeAttemptId);
    NodeAssert.equal(attempt.runId, run.id);
  }
  const attempt = attempts[0];
  NodeAssert.ok(attempt, "Expected the completed run attempt");
  const activeProviderThreadId = object(
    settled.thread,
    "Expected a settled thread",
  ).activeProviderThreadId;
  NodeAssert.ok(typeof activeProviderThreadId === "string", "Expected an active provider thread");
  const activeProviderThread = entities.get("providerThreads")?.get(activeProviderThreadId);
  NodeAssert.ok(activeProviderThread, "Active provider thread is missing from the projection");
  NodeAssert.equal(activeProviderThread.appThreadId, threadId);
  NodeAssert.equal(run.providerThreadId, activeProviderThreadId);
  const providerTurns = entities.get("providerTurns");
  NodeAssert.ok(providerTurns?.size, "Expected the completed provider turn");
  for (const turn of providerTurns.values()) {
    NodeAssert.equal(turn.providerThreadId, activeProviderThreadId);
    NodeAssert.equal(turn.runAttemptId, attempt.id);
    NodeAssert.equal(turn.status, "completed", "Expected a completed provider turn");
    NodeAssert.ok(
      typeof turn.completedAt === "string" && Number.isFinite(Date.parse(turn.completedAt)),
      "Expected the provider turn completion time",
    );
    NodeAssert.equal(
      turn.nodeId,
      attempt.rootNodeId,
      "Provider turn must belong to the attempt root",
    );
    NodeAssert.ok(
      typeof turn.nodeId === "string" && entities.get("nodes")?.has(turn.nodeId),
      "Provider turn points to a missing node",
    );
  }

  const items = array(settled.turnItems, "Expected turn items").map((item) =>
    object(item, "Expected a turn item"),
  );
  NodeAssert.deepEqual(
    items.map((item) => item.type),
    expected.turnItemTypes,
  );
  let lastOrdinal = -1;
  const itemMessageIds: string[] = [];
  for (const item of items) {
    const ordinal = sequence(item.ordinal, "Expected a turn item ordinal");
    NodeAssert.ok(ordinal > lastOrdinal, "Transcript items are out of order");
    lastOrdinal = ordinal;
    if (item.type === "user_message" || item.type === "assistant_message") {
      const messageId = item.messageId;
      NodeAssert.ok(typeof messageId === "string");
      itemMessageIds.push(messageId);
      const message = messages.get(messageId);
      NodeAssert.ok(message, "Turn item points to a missing message");
      NodeAssert.equal(item.text, message.text);
      NodeAssert.equal(item.runId, message.runId);
      NodeAssert.equal(item.status, "completed", "Expected a completed transcript message");
      if (item.type === "assistant_message") NodeAssert.equal(item.streaming, false);
    }
  }
  NodeAssert.deepEqual(
    itemMessageIds,
    [...messages.keys()],
    "Transcript messages are out of order",
  );
  const visible = array(settled.visibleTurnItems, "Expected visible transcript items").map(
    (entry) => object(entry, "Expected a visible turn item"),
  );
  NodeAssert.deepEqual(
    visible.map((entry) => entry.item),
    items,
    "Visible transcript disagrees with the turn items",
  );
  for (const [position, entry] of visible.entries()) {
    NodeAssert.equal(entry.position, position);
    NodeAssert.equal(entry.visibility, "local");
    NodeAssert.equal(entry.sourceThreadId, threadId);
    NodeAssert.equal(entry.sourceItemId, object(entry.item, "Expected an item reference").id);
  }

  await using retry = await open(tokens.operate);
  const duplicate = await call(retry, "1", dispatch, sendMessage);
  NodeAssert.deepEqual(duplicate, accepted, "Retrying the send must return the original receipt");
  await retry.close();
  NodeAssert.deepEqual(
    await call(resumed, "3", projection, { threadId }),
    settled,
    "Retry changed the settled projection",
  );

  request(resumed, "4", dispatch, {
    ...sendMessage,
    commandId: "wire-replay-denied",
    messageId: "wire-replay-refused",
  });
  NodeAssert.deepEqual(await exit(resumed, "4"), expected.deniedExit, "Read-only send denial");
  NodeAssert.deepEqual(
    await call(resumed, "5", projection, { threadId }),
    settled,
    "Denied send changed the settled projection",
  );
  resumed.send({ _tag: "Ping" });
  NodeAssert.deepEqual(await resumed.receive(), { _tag: "Pong" });
  await resumed.close();
  NodeAssert.equal(await resumed.receive(), undefined, "Unexpected frame after the final Pong");

  return { snapshotCursor, acceptedSequence, disconnectedAt, resumedThrough };
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

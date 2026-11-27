// Sail Boat watchdog. Runs on the Boat sandbox next to the server and sleeps it after `sleepAfterSecs` idle.
// Drains by publishing a final orchestration manifest so the desktop proxy can answer while sleeping.
// Saves a Boat snapshot on every sleep (after proxy ack or grace period) so stopped disks persist past 14 days.

import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  acknowledgeResume,
  enrolled,
  finishSnapshot,
  maintenanceEligible,
  readyReceipt,
  reservePower,
  sandboxBoot,
} from "./boat-lifecycle.mjs";

const HOME = NodeOS.homedir();
const CONFIG_PATH = NodePath.join(HOME, ".sail-boat", "config.json");
// On disk, so it survives watchdog restarts (upgrades); a stop ends it (see BOOT_ID).
const KEEP_AWAKE_PATH = NodePath.join(HOME, ".sail-boat", "keep-awake-until");
const MAX_KEEP_AWAKE_MINUTES = 24 * 60;
const DB_PATH = NodePath.join(HOME, ".t3", "userdata", "statev2.sqlite");
const T3_ORIGIN = "http://127.0.0.1:3773";
const PORT = 3774;
const TICK_MS = 5_000;
// The app's ack can take a poll, a capture of up to 12 s and the post. A miss costs a ~2 min save
// while awake.
const DRAIN_GRACE_MS = 45_000;
// A tick that arrives this late means the VM was frozen: a warm resume after a stop.
const RESUMED_GAP_MS = 30_000;
// Still running this long after asking Boat to stop: the stop failed or a fast resume undid it.
const STOP_SETTLE_MS = 90_000;
// A save makes a fresh capture of the disk: about 2 min on a new small machine, more with a
// fuller disk. One that hangs must not keep the machine up.
const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;

const config = JSON.parse(NodeFS.readFileSync(CONFIG_PATH, "utf8"));
const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * draining: the manifest is published, waiting for the app's ack or the grace period, or after a
 * failed stop for the app's stop or its own retry. saving: this watchdog saves the snapshot after
 * an unacked drain, manifest still published.
 * @type {"active" | "draining" | "saving" | "stopping"}
 */
let phase = "active";
/** Last time anything held the machine up, CPU load included: the idle countdown starts here. */
let lastActivityAt = Date.now();
/** Last time an agent, the user or a keep-awake held it up: CPU load holds it only so long after. */
let lastUsedAt = Date.now();
/** Agent runs in flight (top-level threads and subagents), and runs waiting on a person. */
let working = { threads: 0, subagents: 0, waiting: 0 };
// T3 not answering: an agent might be mid-turn, so count it as working, but only this long, so a
// broken server cannot keep the machine billing.
const UNKNOWN_BUSY_MS = 30 * 60_000;
let unknownSince = 0;
// T3 boots after this watchdog: until it first answers it is starting, not failing, and no agent
// can be mid-turn on it.
let t3Answered = false;
const unknownBusy = () => unknownSince > 0 && Date.now() - unknownSince < UNKNOWN_BUSY_MS;
const agentsWorking = () => working.threads + working.subagents > 0;
const agentsBusy = () => agentsWorking() || unknownBusy();

/**
 * One busy check for the tick, "Sleep now" and the delete guard. A failure starts (or continues)
 * "can't tell".
 */
async function refreshWorking() {
  try {
    working = await checkWorking();
    unknownSince = 0;
    t3Answered = true;
  } catch (e) {
    working = { threads: 0, subagents: 0, waiting: 0 };
    if (t3Answered) unknownSince ||= Date.now();
    log(e.message);
  }
}
// Background builds show as CPU use (>0.5 cores smoothed over ~30s) and hold the machine up to CPU_HOLD_MS.
// Longer jobs require an explicit keep-awake.
const CPU_BUSY_CORES = 0.5;
const CPU_HOLD_MS = 30 * 60_000;
const CPU_COUNT = NodeOS.availableParallelism();
/** Cores in use. */
let cpuLoad = 0;
/** "Sleep now" was asked for: CPU load no longer holds the machine up, agents still do. */
let sleepRequested = false;
let cpuPrev = readCpu();
const cpuBusy = () =>
  !sleepRequested && cpuLoad > CPU_BUSY_CORES && Date.now() - lastUsedAt < CPU_HOLD_MS;
const isBusy = () => agentsBusy() || cpuBusy();

/** Busy and total jiffies across all cores since boot, from /proc/stat. */
function readCpu() {
  const fields = NodeFS.readFileSync("/proc/stat", "utf8")
    .split("\n")[0]
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const idle = fields[3] + (fields[4] ?? 0);
  const total = fields.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

function sampleCpu() {
  const now = readCpu();
  const total = now.total - cpuPrev.total;
  const usage = total > 0 ? ((now.busy - cpuPrev.busy) / total) * CPU_COUNT : 0;
  cpuPrev = now;
  cpuLoad = cpuLoad * 0.8 + usage * 0.2;
}
let manifest = null;
let drainStartedAt = 0;
/**
 * This sleep's snapshot is seen to: the laptop app acked the drain (it saves the snapshot once
 * the machine has stopped), or this watchdog saved it. The next tick that finds the machine idle
 * stops it. Only hold() clears it.
 */
let snapshotCovered = false;
let stopFenced = false;
/** A `boat snapshot` this watchdog started still runs, whether or not its sleep was called off. */
let saveRunning = false;
let lastTickAt = Date.now();
let stopRequestedAt = 0;
/** This watchdog's own last stop: within sleepAfterSecs of it the app gets the first try. */
let selfStopAt = 0;
/** Its last stop failed, and nobody used it since: it drains on, manifest kept, and retries. */
let stopFailed = false;
/** The latest tick found it idle right after a failed stop: the laptop app stops it. */
let sleepBroken = false;
/** "Keep awake": no sleeping before this (ms since epoch), working or not; Infinity = until stopped. */
// A stop ends any hold: after a cold resume (new boot) the stored one is void. A warm resume
// keeps the boot, so the resume check in tick() ends it there.
const BOOT_ID = readFileSafe("/proc/sys/kernel/random/boot_id").trim();
let currentSandbox = config.bootId === sandboxBoot;
const [storedUntil, storedBoot] = readFileSafe(KEEP_AWAKE_PATH).split(" ");
let keepAwakeUntil = storedBoot === BOOT_ID ? Number(storedUntil) || 0 : 0;
const keptAwake = () => Date.now() < keepAwakeUntil;

function readFileSafe(path) {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** null: until stopped; 0: off. */
function setKeepAwake(minutes) {
  keepAwakeUntil = minutes === null ? Infinity : minutes > 0 ? Date.now() + minutes * 60_000 : 0;
  NodeFS.writeFileSync(KEEP_AWAKE_PATH, `${keepAwakeUntil} ${BOOT_ID}`);
}

// Work T3 starts on its own at a set time: an automation, a webhook run it held back, an agent
// resuming after a usage limit. Due this soon, the machine waits for it instead of sleeping and
// waking again. Overdue this long, it is not coming (T3 runs due work within seconds), or the
// time stays behind in T3's rows after it ran.
const DUE_SOON_MS = 5 * 60_000;
const OVERDUE_MS = 2 * 60_000;
/** When T3 next starts work on its own, ms since epoch; null for never. Sail wakes the machine for it. */
let nextDueAt = null;
const dueSoon = () => nextDueAt !== null && nextDueAt - Date.now() < DUE_SOON_MS;

// Events only a person causes, from any client: Sail through Sail Boat, but also a phone or
// another computer through T3 Connect, which Sail Boat never sees.
const PERSON_EVENTS = [
  "thread.created",
  "thread.visit-recorded",
  "thread.visited",
  "thread.marked-unread",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.tags-updated",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
];
/** Last orchestration event looked at; null until the first look. */
let eventCursor = null;

/**
 * Reads T3's database for the tick: sets `nextDueAt`, and says whether a person acted since the
 * last tick. A table this T3 version lacks has nothing due.
 */
function readT3State() {
  const db = new NodeSqlite.DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const times = (sql) => {
      try {
        return db
          .prepare(sql)
          .all()
          .map((r) => (typeof r.t === "string" ? Date.parse(r.t) : r.t));
      } catch {
        return [];
      }
    };
    const recovering = `FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND json_extract(payload_json, '$.limitRecovery.autoResume') = 1`;
    const due = [
      // Parsed here, not compared as text: T3 notes expanded years sort first.
      ...times(`SELECT next_run_at AS t FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND last_run_status <> 'running'`),
      ...times(
        `SELECT MIN(due_at) AS t FROM scheduled_task_webhook_pending WHERE state = 'pending'`,
      ),
      ...times(`SELECT json_extract(payload_json, '$.limitRecovery.resetAt') AS t ${recovering}`),
      ...times(`SELECT json_extract(payload_json, '$.snoozedUntil') AS t ${recovering}`),
    ].filter((t) => Number.isFinite(t) && Date.now() - t < OVERDUE_MS);
    nextDueAt = due.length > 0 ? Math.min(...due) : null;

    if (eventCursor === null) {
      eventCursor = db.prepare("SELECT MAX(sequence) AS s FROM orchestration_events").get()?.s ?? 0;
      return false;
    }
    const events = db
      .prepare(
        `SELECT MAX(sequence) AS last, SUM(event_type IN (${PERSON_EVENTS.map(() => "?").join(",")})) AS person
         FROM orchestration_events WHERE sequence > ?`,
      )
      .get(...PERSON_EVENTS, eventCursor);
    eventCursor = events?.last ?? eventCursor;
    return (events?.person ?? 0) > 0;
  } finally {
    db.close();
  }
}

const LIVE_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);
/** Request kinds T3 settles itself: nobody is waited on. */
const SELF_SETTLED = ["auth_refresh", "dynamic_tool_call"];

/** True when the run stopped at a blocking human prompt (approval or question), which does not hold the machine awake. */
function waitsOnPerson(thread) {
  const request = thread.pendingRuntimeRequest;
  if (request == null || request.blocking === false) return false;
  if (SELF_SETTLED.includes(request.kind)) return false;
  // A secret or a link card. The shell can't tell them apart, and a link card's agent works on.
  if (request.userOnly) return false;
  // A delegated child's question goes to the agent that delegated it, here or on another machine.
  const delegated =
    thread.lineage?.relationshipToParent === "subagent" || thread.delegatedFrom != null;
  return !(delegated && request.kind === "user_input");
}

/** Threads among `waiting` whose run still has active background work beside a pending prompt. Reads SQLite directly; treats unreadable DB as all working. */
function workingBesidePrompt(waiting, ownWork) {
  if (waiting.size === 0) return new Set();
  try {
    const db = new NodeSqlite.DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `WITH waiting(thread_id, provider_thread_id, run_id, request_id) AS (
             SELECT json_extract(value, '$.id'), json_extract(value, '$.activeProviderThreadId'),
               json_extract(value, '$.activeRunId'), json_extract(value, '$.requestId')
             FROM json_each(?)
           )
           SELECT waiting.thread_id AS threadId, item.type AS kind,
             json_extract(item.payload_json, '$.childThreadId') AS childThreadId
           FROM waiting
           JOIN orchestration_v2_projection_turn_items AS item ON item.thread_id = waiting.thread_id
           LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
           WHERE item.type IN ('command_execution', 'dynamic_tool', 'subagent')
             AND item.status IN ('pending', 'running', 'waiting')
             AND run.status IS NOT 'rolled_back'
             AND json_extract(item.payload_json, '$.input.persistent') IS NOT 1
             AND (item.type = 'subagent' OR NOT EXISTS (
               SELECT 1 FROM orchestration_v2_projection_runtime_requests AS request
               JOIN orchestration_v2_projection_nodes AS gate ON gate.node_id = request.node_id
               WHERE request.thread_id = waiting.thread_id AND request.status = 'pending'
                 AND request.kind NOT IN (${SELF_SETTLED.map((k) => `'${k}'`).join(", ")})
                 AND (gate.parent_node_id = item.node_id
                   OR request.provider_turn_id = item.provider_turn_id
                     AND json_extract(request.payload_json, '$.nativeRequestRef.nativeId')
                       = json_extract(item.payload_json, '$.nativeItemRef.nativeId'))
             ))
           UNION ALL
           SELECT waiting.thread_id, json_extract(task.value, '$.kind'),
             json_extract(task.value, '$.childThreadId')
           FROM waiting
           JOIN orchestration_v2_projection_provider_threads AS roster
             ON roster.thread_id = waiting.thread_id
             AND roster.provider_thread_id = COALESCE(waiting.provider_thread_id, roster.provider_thread_id)
           JOIN json_each(roster.payload_json, '$.pendingBackgroundTasks') AS task
           UNION ALL
           SELECT waiting.thread_id, 'run', NULL
           FROM waiting
           LEFT JOIN orchestration_v2_projection_runtime_requests AS request
             ON request.runtime_request_id = waiting.request_id
           LEFT JOIN orchestration_v2_projection_nodes AS gate ON gate.node_id = request.node_id
           WHERE gate.run_id IS NOT waiting.run_id`,
        )
        .all(
          JSON.stringify(
            Array.from(waiting, (t) => ({
              id: t.id,
              activeProviderThreadId: t.activeProviderThreadId,
              activeRunId: t.activeRunId,
              requestId: t.pendingRuntimeRequest.id,
            })),
          ),
        );
      return new Set(rows.filter(ownWork).map((r) => r.threadId));
    } finally {
      db.close();
    }
  } catch (e) {
    log("background work unavailable", e.message);
    return new Set(Array.from(waiting, (t) => t.id));
  }
}

/**
 * Agent runs in flight and background work, but not runs waiting on a person with nothing else
 * running: those count apart.
 */
async function checkWorking() {
  const res = await fetch(`${T3_ORIGIN}/api/orchestration/shell`, {
    headers: { authorization: `Bearer ${config.t3Token}`, "x-t3-orchestration-protocol": "2" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`shell snapshot: HTTP ${res.status}`);
  const { threads } = await res.json();
  if (!Array.isArray(threads)) throw new Error("shell snapshot: missing threads");
  // A subagent T3 runs as its own thread on this machine counts by its own state: waiting for it
  // holds nothing more, so a child waiting on a person doesn't keep its parent's machine up. A
  // provider's own background agent shows no runs of its own, and one elsewhere isn't seen here:
  // both hold it through the parent.
  const here = new Set(threads.filter((t) => t.creationSource !== "provider").map((t) => t.id));
  const ownWork = (task) => !(task.kind === "subagent" && here.has(task.childThreadId));
  // T3 lists a watched pull request as a task, awaited only while its checks run: after that a
  // person moves it next, so it holds nothing. T3 adds these to the shell's list alone, never to
  // the provider roster read beside a prompt.
  const holds = (task) =>
    ownWork(task) && !(task.taskId.startsWith("pull-request-watch:") && task.awaited !== true);
  // A pending request alone is no run: one left after a restart has none.
  const running = (t) =>
    t.activeRunId != null || t.activityRunStatus != null || LIVE_STATUSES.has(t.status);
  const waiting = new Set(threads.filter((t) => running(t) && waitsOnPerson(t)));
  const besidePrompt = workingBesidePrompt(waiting, ownWork);
  const live = threads.filter(
    (t) =>
      (t.pendingBackgroundTasks ?? []).some(holds) ||
      (running(t) && (!waiting.has(t) || besidePrompt.has(t.id))),
  );
  const subagents = live.filter((t) => t.lineage?.relationshipToParent === "subagent").length;
  return { threads: live.length - subagents, subagents, waiting: waiting.size };
}

/** The orchestration high-water marks T3 itself compares resume cursors against. */
function readManifest() {
  const db = new NodeSqlite.DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const global = db
      .prepare(
        `SELECT MAX(sequence) AS s FROM orchestration_events
         WHERE aggregate_kind = 'project' OR (application_event_version = 2 AND aggregate_kind = 'thread')`,
      )
      .get();
    const rows = db
      .prepare(
        `SELECT stream_id AS id, MAX(sequence) AS s FROM orchestration_events
         WHERE application_event_version = 2 AND aggregate_kind = 'thread' GROUP BY stream_id`,
      )
      .all();
    return {
      sequence: global?.s ?? 0,
      threads: Object.fromEntries(rows.map((r) => [r.id, r.s])),
    };
  } finally {
    db.close();
  }
}

/**
 * Saves the snapshot awake after an unacked drain, then drains on with it seen to: the next tick
 * that finds the machine idle stops it. Any use meanwhile calls the sleep off; the save runs on
 * and covers nothing. The drain's manifest stays: events since it call the stop off too.
 */
async function save() {
  let fd;
  try {
    if (enrolled()) fd = reservePower("snapshot", config.sandbox);
  } catch (error) {
    log("deferring snapshot", error.message);
    return;
  }
  phase = "saving";
  saveRunning = true;
  log("saving snapshot", config.snapshot);
  try {
    await boat(["snapshot", config.sandbox, config.snapshot], SNAPSHOT_TIMEOUT_MS, fd);
    if (fd !== undefined) {
      const completed = fd;
      fd = undefined;
      finishSnapshot(completed);
    }
  } catch (error) {
    log("snapshot outcome unavailable", error.message);
  } finally {
    if (fd !== undefined) NodeFS.closeSync(fd);
  }
  saveRunning = false;
  // Called off: it covers nothing. Still saving, it is this sleep's own: none starts beside one.
  if (phase !== "saving") return;
  snapshotCovered = true;
  phase = "draining";
}

/** Publishes the manifest. Only right after a fresh check found no agent working. */
function drain() {
  try {
    manifest = readManifest();
  } catch (e) {
    log("manifest unavailable", e.message);
    manifest = null;
  }
  phase = "draining";
  drainStartedAt = Date.now();
  log("draining", manifest?.sequence);
}

/** Someone uses the machine: it stays up, and CPU load may hold it up again. */
function touch(reason) {
  lastUsedAt = Date.now();
  stopFailed = false;
  hold(reason);
}

/** Keeps the machine up and restarts the idle countdown, calling off a sleep in progress. */
function hold(reason) {
  sleepRequested = false;
  lastActivityAt = Date.now();
  if (phase !== "active") log(`back to active: ${reason}`);
  phase = "active";
  stopFenced = false;
  manifest = null;
  snapshotCovered = false;
  sleepBroken = false;
}

/** Runs the Boat CLI, in a login shell for its PATH. */
function boat(args, timeout, fd) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "bash",
      ["-lc", 'exec boat "$@" --json', "boat", ...args],
      { stdio: ["ignore", "ignore", "ignore", ...(fd === undefined ? [] : [fd])] },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve();
      else reject(new Error(`Boat command exited with status ${code}.`));
    });
  });
}

/** Use is turned away from here on; still running STOP_SETTLE_MS later, the stop failed. */
function markStopping(how) {
  phase = "stopping";
  stopRequestedAt = Date.now();
  sleepBroken = false;
  log(how);
}

function stopSelf() {
  let fd;
  try {
    if (enrolled()) fd = reservePower("stop", config.sandbox);
  } catch (error) {
    log("deferring stop", error.message);
    return;
  }
  stopFenced = fd !== undefined;
  markStopping("stopping sandbox");
  selfStopAt = stopRequestedAt;
  const started = stopRequestedAt;
  boat(["stop", config.sandbox], STOP_SETTLE_MS, fd)
    .catch((e) => {
      log("boat stop failed", e.message);
      // An error from an older attempt (one a warm resume woke) says nothing about this machine.
      if (phase === "stopping" && stopRequestedAt === started) stopFailedNow();
    })
    .finally(() => {
      if (fd !== undefined) NodeFS.closeSync(fd);
    });
}

/**
 * Not use, so no hold(): it drains on with its manifest, which keeps the laptop app's capture
 * confirmed, and the next tick that finds it idle reports its sleep broken (see finishDrain).
 */
function stopFailedNow() {
  stopFailed = true;
  phase = "draining";
}

async function tick() {
  if (!currentSandbox) return;
  const now = Date.now();
  // A drain begun during this tick's checks (by "Sleep now") waits for the next tick's.
  const drainBefore = drainStartedAt;
  if (now - lastTickAt > RESUMED_GAP_MS) {
    setKeepAwake(0);
    touch("resumed");
  }
  lastTickAt = now;
  if (phase === "stopping") {
    if (now - stopRequestedAt > STOP_SETTLE_MS) stopFailedNow();
    return;
  }

  sampleCpu();
  await refreshWorking();
  // The app was granted a stop during the check: it wins, and the event cursor stays for a retry.
  if (phase === "stopping") return;
  let personActed = false;
  try {
    personActed = readT3State();
  } catch (e) {
    log("T3 state unavailable", e.message);
  }
  if (agentsWorking()) return touch("agent working");
  if (personActed) return touch("used in T3");
  if (keptAwake()) return touch("kept awake");
  if (cpuBusy()) return hold("cpu busy");
  if (dueSoon()) return hold("work due");
  // Can't tell: don't sleep, but it isn't activity either, so flaky checks can't hold it up forever.
  if (unknownBusy()) return;

  const idleMs = now - lastActivityAt;
  if (phase === "active" && idleMs >= config.sleepAfterSecs * 1000) drain();
  // Only here, past every check above, or on /overdue-stop's own fresh check, does a drain end in
  // a stop. Not while a save of its own runs: one called off could finish after the app's.
  else if (
    phase === "draining" &&
    drainStartedAt === drainBefore &&
    !saveRunning &&
    (snapshotCovered || now - drainStartedAt >= DRAIN_GRACE_MS)
  )
    finishDrain();
}

/** Anything happened since the manifest: someone uses the machine after all. */
function newEvents() {
  let current = null;
  try {
    current = readManifest();
  } catch {}
  return manifest !== null && current !== null && current.sequence !== manifest.sequence;
}

/** Stops once the snapshot is seen to, else saves it first. */
function finishDrain() {
  if (newEvents()) return touch("new events");
  // Right after a failed stop the laptop app stops it. Later, or with no app to, it retries:
  // counted from its own stop, so the app's retries can't put that off.
  sleepBroken = !enrolled() && stopFailed && Date.now() - selfStopAt < config.sleepAfterSecs * 1000;
  if (sleepBroken) return;
  if (snapshotCovered) stopSelf();
  // Not awaited: ticks go on during a save, so an agent starting to work calls it off.
  else save();
}

function status() {
  let receipt;
  let eligible = false;
  try {
    if (currentSandbox) {
      receipt = readyReceipt();
      eligible = maintenanceEligible();
    }
  } catch {}
  return {
    ...(receipt === undefined ? {} : { maintenanceReady: receipt }),
    sandbox: config.sandbox,
    maintenanceEligible: eligible,
    stopFenced: phase === "stopping" && stopFenced,
    phase,
    busy: isBusy(),
    cpuBusy: !agentsBusy() && cpuBusy(),
    agentsUnknown: unknownBusy(),
    workingThreads: working.threads,
    workingSubagents: working.subagents,
    // Not busy, but a T3 restart would expire what they wait on.
    waitingThreads: working.waiting,
    keepAwakeForever: keepAwakeUntil === Infinity,
    keepAwakeSecs: Number.isFinite(keepAwakeUntil)
      ? Math.max(0, Math.ceil((keepAwakeUntil - Date.now()) / 1000))
      : 0,
    idleSecs: Math.floor((Date.now() - lastActivityAt) / 1000),
    // Its own stop failed and it is still idle: the laptop app stops it.
    sleepBroken,
    // A snapshot save still runs, maybe called off: restarting this watchdog would kill it.
    saving: saveRunning,
    sleepAfterSecs: config.sleepAfterSecs,
    nextDueAt,
    workDue: dueSoon(),
    // While stopping, it names the sequence the machine stops at: the proxy trusts its
    // capture only when they match.
    manifest: phase === "active" ? null : manifest,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 64_000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = NodeHttp.createServer(async (req, res) => {
  const reply = (code, value) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(value === undefined ? "" : JSON.stringify(value));
  };
  if (req.headers.authorization !== `Bearer ${config.secret}`)
    return reply(401, { error: "unauthorized" });
  try {
    if (req.method === "GET" && req.url === "/status") return reply(200, status());
    if (req.method === "GET" && req.url === "/status?fresh") {
      // The delete guard: agents as of now, not as of the last tick.
      await refreshWorking();
      return reply(200, status());
    }
    if (req.method === "POST" && req.url === "/activity") {
      // { resumed }: the proxy just resumed the sandbox, so the stop asked for here is over. A
      // tick only notices a freeze of RESUMED_GAP_MS or more.
      const { resumed, sandbox } = JSON.parse((await readBody(req)) || "{}");
      if (resumed && sandbox === config.sandbox) {
        if (enrolled()) acknowledgeResume(sandbox);
        currentSandbox = true;
        setKeepAwake(0);
        touch("resumed");
        return reply(200, status());
      }
      if (!currentSandbox) return reply(409, { error: "sandbox identity pending", ...status() });
      // Too late to call off a stop: the proxy waits for it and resumes the machine.
      if (phase === "stopping") return reply(409, { error: "stopping", ...status() });
      touch("user activity");
      return reply(200, status());
    }
    if (!currentSandbox) return reply(409, { error: "sandbox identity pending", ...status() });
    if (req.method === "POST" && req.url === "/drain") {
      // "Sleep now". Never mid-turn; it does end a keep-awake. Drains on this fresh
      // check; the tick decides the stop as usual.
      await refreshWorking();
      // A busy CPU alone doesn't refuse: "Sleep now" is the user's explicit call.
      if (agentsBusy()) {
        const error = agentsWorking() ? "an agent is working" : "could not check agents";
        return reply(409, { error, ...status() });
      }
      setKeepAwake(0);
      if (phase === "active") drain();
      sleepRequested = true;
      return reply(200, status());
    }
    if (req.method === "POST" && req.url === "/keep-awake") {
      // { minutes }: null = until stopped, 0 ends it. Counted on this machine's clock, never the laptop's.
      const { minutes } = JSON.parse((await readBody(req)) || "{}");
      // Too late during a stop (checked after the body: a stop can begin meanwhile): the proxy
      // waits for it, resumes the machine and asks again.
      if (phase === "stopping") return reply(409, { error: "stopping", ...status() });
      const valid =
        minutes === null ||
        (Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_KEEP_AWAKE_MINUTES);
      if (!valid)
        return reply(400, {
          error: "minutes must be null (until stopped) or 0 to " + MAX_KEEP_AWAKE_MINUTES,
        });
      setKeepAwake(minutes);
      if (minutes !== 0) touch("keep awake");
      return reply(200, status());
    }
    if (req.method === "POST" && req.url === "/sleep-ack") {
      // The proxy captured this state and saves the snapshot once stopped: no need to wait out
      // the grace period. The next tick decides the stop, after its usual checks.
      const { sequence } = JSON.parse((await readBody(req)) || "{}");
      if (!enrolled() && phase === "draining" && manifest && sequence === manifest.sequence)
        snapshotCovered = true;
      return reply(200, status());
    }
    if (req.method === "POST" && req.url === "/overdue-stop") {
      // The app stops a machine whose own stop failed, but only on this fresh check: use since the
      // tick that found it idle wins. 200 says go; the app's stop then settles like this
      // watchdog's own.
      const { failed } = JSON.parse((await readBody(req)) || "{}");
      // The app's stop failed: drains on as after its own; the watchdog retries once its window ends.
      if (failed) {
        // Only the app's own stop: a report that comes late must not call off this watchdog's retry.
        if (phase === "stopping" && stopRequestedAt !== selfStopAt) stopFailedNow();
        return reply(200, status());
      }
      const notNow = () => reply(409, { error: "not now", ...status() });
      if (enrolled() || !sleepBroken) return notNow();
      await refreshWorking();
      // A tick may have stopped or held it meanwhile.
      if (!sleepBroken) return notNow();
      // Refreshes nextDueAt, and moves the event cursor: a person's event is handled here.
      let personActed = false;
      try {
        personActed = readT3State();
      } catch {}
      if (personActed) touch("used in T3");
      if (!sleepBroken || isBusy() || dueSoon() || newEvents()) return notNow();
      markStopping("stopping sandbox from the app");
      return reply(200, status());
    }
    reply(404, { error: "not found" });
  } catch (e) {
    reply(400, { error: e.message });
  }
});

// One tick at a time: a slow T3 check must never finish after a newer tick started a stop.
async function loop() {
  await tick().catch((e) => log("tick failed", e.message));
  setTimeout(loop, TICK_MS);
}
server.listen(PORT, "127.0.0.1", () =>
  log(`watchdog on ${PORT}, sleep after ${config.sleepAfterSecs}s`),
);
loop();

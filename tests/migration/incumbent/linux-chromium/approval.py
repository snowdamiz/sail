from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import time
from urllib.parse import unquote
from uuid import uuid4

from browser_capture import PROFILE, SETTLE, snapshot


ORIGIN = "http://127.0.0.1:47717"
READ_ORIGIN = "http://localhost:47717"
PROMPT = "Give me a short tour"
PENDING = "Waiting for approval"
COMPOSER = 'main [contenteditable="true"]'
PERMISSIONS = 'button[aria-label^="Permissions: "]'
OBSERVE = """(() => {
  const body = document.querySelector("main")?.innerText ?? "";
  const controls = [...document.querySelectorAll("main button")]
    .filter(button => button.getClientRects().length)
    .map(button => ({
      name: button.getAttribute("aria-label") || button.textContent.trim(),
      disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
    }))
    .filter(button => ["Decline", "Approve", "More approval options"].includes(button.name));
  return {
    profile: """ + PROFILE + """,
    observed: {
      pending: body.includes("Waiting for approval"),
      detail: document.querySelector('[data-approval-detail="complete"]')?.textContent?.trim() ?? null,
      controls,
      replayReply: body.includes("This turn is a replay."),
      permission: document.querySelector('main button[aria-label^="Permissions: "]')?.getAttribute("aria-label") ?? null,
      focusedElement: document.activeElement?.tagName ?? null,
    },
  };
})()"""
SESSION = """(async () => {
  const response = await fetch("/api/auth/session");
  const session = await response.json();
  return {authenticated: response.ok && session.authenticated, method: session.sessionMethod,
          scopes: [...(session.scopes ?? [])].sort()};
})()"""
PIN_SHINE = """(async () => {
  const shine = document.getAnimations().filter(animation =>
    animation.animationName === "live-tool-shine" && animation.playState === "running"
  );
  for (const animation of shine) {
    animation.pause();
    animation.currentTime = 0;
  }
  await Promise.all(shine.map(animation => animation.ready));
  return shine.length;
})()"""
RESUME_SHINE = """(() => {
  for (const animation of document.getAnimations()) {
    if (animation.animationName === "live-tool-shine" && animation.currentTime === 0) animation.play();
  }
})()"""
DENIAL = """(async (threadId, requestId) => {
  const response = await fetch("/api/auth/websocket-ticket/rpc", {method: "POST"});
  if (!response.ok) throw new Error("Read-only socket ticket rejected");
  const {ticket} = await response.json();
  const url = new URL("/ws?orchestrationProtocol=2", location.origin);
  url.protocol = "ws:";
  url.searchParams.set("wsTicket", ticket);
  const ws = new WebSocket(url);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Approval RPC timed out")), 8000);
      ws.addEventListener("error", () => reject(new Error("Approval RPC socket failed")), {once: true});
      ws.addEventListener("open", () => ws.send(JSON.stringify({
        _tag: "Request", id: "1", tag: "orchestration.dispatchCommand",
        payload: {type: "runtime-request.respond", commandId: "p01-read-only-decision",
                  threadId, requestId, decision: "accept"},
        headers: [],
      })), {once: true});
      ws.addEventListener("message", message => {
        const frame = JSON.parse(message.data);
        if (frame._tag === "Exit" && frame.requestId === "1") resolve(frame.exit);
      });
    });
  } finally {
    clearTimeout(timer);
    ws.close();
  }
})"""


def read_request(root, thread):
    database = root / "state/userdata/statev2.sqlite"
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        requests = db.execute(
            "SELECT runtime_request_id, status, payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?",
            (thread,),
        ).fetchall()
        threads = db.execute(
            "SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE thread_id=?", (thread,),
        ).fetchall()
        runs = db.execute(
            "SELECT status FROM orchestration_v2_projection_runs WHERE thread_id=?", (thread,),
        ).fetchall()
    assert len(threads) == len(runs) == len(requests) == 1
    request_id, status, payload = requests[0]
    facts = {"status": status, "runStatus": runs[0][0], "mode": threads[0][0],
             "decision": json.loads(payload).get("decision")}
    return request_id, facts


def request_approval(root, call, tab):
    call("preview_act", **tab, action="click", selector='button[aria-label="New thread in Compatibility demo"]')
    call("preview_wait_for", **tab, text="What should we build?")
    call("preview_wait_for", **tab, text="Showcase")
    call("preview_act", **tab, action="click", selector=PERMISSIONS)
    call("preview_act", **tab, action="click", selector='[role="menuitemradio"][aria-label="Supervised"]')
    call("preview_wait_for", **tab, selector='button[aria-label="Permissions: Supervised"]')
    call("preview_act", **tab, action="type", selector=COMPOSER, text=PROMPT)
    call("preview_act", **tab, action="click", selector='button[aria-label="Submit message"]')
    call("preview_wait_for", **tab, text=PENDING, timeoutMs=35000)
    path = call("preview_evaluate", **tab, expression="location.pathname")["value"]
    thread = unquote(path.rsplit("/", 1)[1])
    request, facts = read_request(root, thread)
    assert facts["status"] == "pending" and facts["mode"] == "approval-required"
    return path, thread, request, facts


def observe(call, tab):
    call("preview_act", **tab, action="hover", x=1, y=45)
    call("preview_evaluate", **tab, expression=SETTLE)
    return call("preview_evaluate", **tab, expression=OBSERVE)["value"]


def readonly_check(root, call, pair, path, thread, request, pending):
    opened = call("preview_open", open=False, reuseExistingTab=False)
    tab = {"tabId": opened["tabId"]}
    call("preview_resize", **tab, mode="freeform", width=640, height=600)
    call("preview_set_appearance", **tab, colorScheme="light")
    pair(call, tab, READ_ORIGIN, scope="orchestration:read")
    call("preview_navigate", **tab, url=READ_ORIGIN + path)
    call("preview_wait_for", **tab, text=PENDING)
    auth = call("preview_evaluate", **tab, expression=SESSION)["value"]
    assert auth == {"authenticated": True, "method": "browser-session-cookie", "scopes": ["orchestration:read"]}
    view = observe(call, tab)["observed"]
    assert view["pending"] and view["controls"] and all(button["disabled"] for button in view["controls"])
    args = ", ".join(map(json.dumps, (thread, request)))
    denial = call("preview_evaluate", **tab, expression=f"{DENIAL}({args})")["value"]
    assert denial["_tag"] == "Failure" and len(denial["cause"]) == 1
    error = denial["cause"][0]["error"]
    assert error == {
        "_tag": "EnvironmentAuthorizationError",
        "message": "The authenticated token is missing required scope: orchestration:operate.",
        "requiredScope": "orchestration:operate",
        "requiredPermission": "orchestration:operate",
    }
    assert read_request(root, thread) == (request, pending)
    return {"session": auth, "controls": view["controls"], "denial": error, "requestUnchanged": True}


def decide(root, call, tab, thread, request, label, decision):
    selector = f'main button:has-text("{label}")'
    call("preview_wait_for", **tab, selector=selector)
    if decision == "decline":
        call("preview_wait_for", **tab, text="Working for 12s")
    call("preview_act", **tab, action="click", selector=selector)
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        current, facts = read_request(root, thread)
        assert current == request
        if facts["status"] == "resolved" and facts["runStatus"] == "completed":
            assert facts["decision"] == decision
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("The Replay approval did not settle")
    if decision == "accept":
        call("preview_wait_for", **tab, selector="main .chat-markdown-shiki pre code .line:first-child")
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        view = observe(call, tab)
        if not view["observed"]["pending"] and not view["observed"]["controls"]:
            assert view["observed"]["replayReply"] == (decision == "accept")
            return view, facts
        time.sleep(0.1)
    raise RuntimeError("The browser still shows approval controls after resolution")


def capture_approval(root, source, call, prepare, pair):
    tab, seed_path, identity = prepare(call, source)
    call("preview_navigate", **tab, url=ORIGIN + seed_path)
    call("preview_wait_for", **tab, text="This turn is a replay.")
    operator = call("preview_evaluate", **tab, expression=SESSION)["value"]
    assert operator["authenticated"] and "orchestration:operate" in operator["scopes"]

    path, thread, request, pending = request_approval(root, call, tab)
    requested = observe(call, tab)
    assert requested["observed"]["pending"] and requested["observed"]["controls"]
    assert not any(button["disabled"] for button in requested["observed"]["controls"])
    assert call("preview_evaluate", **tab, expression=PIN_SHINE)["value"] > 0
    try:
        call("preview_wait_for", **tab, text="Working for 8s")
        requested = snapshot(root, call, tab, "requested", requested)
    finally:
        call("preview_evaluate", **tab, expression=RESUME_SHINE)
    read_only = readonly_check(root, call, pair, path, thread, request, pending)
    approved, accepted = decide(root, call, tab, thread, request, "Approve", "accept")
    approved = snapshot(root, call, tab, "approved", approved)

    _, other_thread, other_request, other_pending = request_approval(root, call, tab)
    assert other_thread != thread and other_request != request
    denied, declined = decide(root, call, tab, other_thread, other_request, "Decline", "decline")
    denied = snapshot(root, call, tab, "denied", denied)

    runtime = json.loads((root / "state/userdata/server-runtime.json").read_text())
    receipt = {
        "schemaVersion": 1, "captureRunId": str(uuid4()), "sourceSha": source["sourceSha"],
        "packageSha256": source["archiveSha256"], "arch": "arm64", "osVersion": identity["distribution"],
        "browser": identity["browser"], "pairing": identity["pairing"],
        "runtimeOwnerSha256": sha256(runtime["ownerId"].encode()).hexdigest(),
        "operator": operator, "readOnly": read_only,
        "server": {"requested": pending, "approved": accepted,
                   "declineRequested": other_pending, "denied": declined},
        "approvalStates": {"requested": requested, "approved": approved, "denied": denied},
    }
    (root / "state.json").write_text(json.dumps(receipt, indent=2) + "\n")

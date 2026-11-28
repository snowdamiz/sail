from hashlib import file_digest, sha256
import http.client
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import time
from contextlib import closing, contextmanager
from runpy import run_path
from uuid import uuid4

from browser_capture import PROFILE, SETTLE, snapshot

PORT = 47719
ORIGIN = f"http://127.0.0.1:{PORT}"
LABEL = "Compatibility fixture"
DRAFT = "P01 draft survives reconnect"
COMPOSER = 'main [contenteditable="true"][aria-label="Message Compatibility replay"]'
RETRY = "Retry now"
BANNER = f"{LABEL} is reconnecting"
TABLE = [
    ["Step", "Tool", "Result"], ["Read", "read", "1 file"], ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"],
]
OBSERVE = """(() => {
  const main = document.querySelector("main");
  const composer = main?.querySelector('[contenteditable="true"]');
  const code = main?.querySelector(".chat-markdown-shiki pre code");
  const text = main?.innerText ?? "";
  const profile = """ + PROFILE + """;
  if (code) profile.fonts.push(getComputedStyle(code).fontFamily);
  return {
    profile,
    document: {path: location.pathname, timeOrigin: performance.timeOrigin},
    observed: {
      title: main?.querySelector("h2")?.textContent ?? null,
      reply: text.includes("This turn is a replay."),
      code: code?.innerText.trim() ?? null,
      table: [...(main?.querySelector("table")?.rows ?? [])].map(row =>
        [...row.cells].map(cell => cell.innerText.trim())),
      draft: composer?.innerText.trim() ?? null,
      sendAvailable: !!main?.querySelector('button[aria-label="Submit message"]:enabled'),
      focusedElement: document.activeElement?.tagName ?? null,
      banner: [
        "Compatibility fixture is reconnecting",
        "Compatibility fixture is offline",
        "Retry now",
      ].filter(label => text.includes(label)),
    },
  };
})()"""


def descriptor():
    with closing(http.client.HTTPConnection("127.0.0.1", PORT, timeout=3)) as connection:
        connection.request("GET", "/.well-known/t3/environment")
        response = connection.getresponse()
        assert response.status == 200
        return json.load(response)


@contextmanager
def host(root, base, phase):
    with (root / f"target-{phase}.private.log").open("w") as output, subprocess.Popen(
        [root / "runtime/t3", "serve", "--base-dir", base, "--host", "127.0.0.1",
         "--port", str(PORT), "--startup-pairing", "off"],
        env=os.environ | {"SAIL_HOME": str(base), "T3CODE_HOME": str(base), "T3CODE_ENVIRONMENT_LABEL": LABEL},
        stdout=output, stderr=subprocess.STDOUT,
    ) as process:
        try:
            deadline = time.monotonic() + 45
            runtime = base / "userdata/server-runtime.json"
            while time.monotonic() < deadline and process.poll() is None:
                if runtime.is_file():
                    try:
                        published = descriptor()
                    except OSError:
                        pass
                    else:
                        owner = json.loads(runtime.read_text())
                        assert owner["pid"] == process.pid and owner["origin"] == ORIGIN
                        assert published["label"] == LABEL
                        assert published["environmentId"] == (base / "userdata/environment-id").read_text().strip()
                        yield process, published, sha256(owner["ownerId"].encode()).hexdigest()
                        return
                time.sleep(0.1)
            raise RuntimeError("Packaged reconnect target did not start")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def require_stopped(base):
    assert not (base / "userdata/server-runtime.json").exists()
    try:
        descriptor()
    except ConnectionRefusedError:
        return
    raise RuntimeError("Target still listens after shutdown")


def saved_session(database):
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        sessions = db.execute(
            """SELECT session_id, scopes, issued_at, expires_at, last_connected_at FROM auth_sessions
               WHERE method = 'browser-session-cookie' AND revoked_at IS NULL"""
        ).fetchall()
    assert len(sessions) == 1
    return sessions[0]


def observe(call, tab, document, banners):
    call("preview_act", **tab, action="hover", x=1, y=45)
    call("preview_evaluate", **tab, expression=SETTLE)
    value = call("preview_evaluate", **tab, expression=OBSERVE)["value"]
    if document is not None:
        assert value["document"] == document
    actual = value["observed"]
    assert actual["title"] == "Compatibility replay" and actual["reply"] and actual["table"] == TABLE
    assert actual["code"] == "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0"
    assert actual["draft"] == DRAFT and actual["focusedElement"] == "BODY" and actual["banner"] == banners
    assert actual["sendAvailable"] == (not banners)
    return value


def capture(root, call, tab, name, observed):
    observed.pop("document")
    return snapshot(root, call, tab, name, observed)


def capture_reconnect(root, source, call, prepare):
    base = root / "reconnect-state"
    database = base / "userdata/statev2.sqlite"
    database.parent.mkdir(parents=True)
    with closing(sqlite3.connect("file:/seed.sqlite?immutable=1", uri=True)) as seed:
        with closing(sqlite3.connect(database)) as target:
            seed.backup(target)
    settings = json.loads((root / "state/userdata/settings.json").read_text())
    settings["providerInstances"].pop("captureProbe")
    (database.parent / "settings.json").write_text(json.dumps(settings))
    runtime_tools = Path(__file__).parent.parent / "runtime"
    state_api = run_path(str(runtime_tools / "upgrade_state.py"))
    pin = json.loads((runtime_tools / "cli-lifecycle-seed.json").read_text())
    with Path("/seed.sqlite").open("rb") as seed:
        seed_digest = file_digest(seed, "sha256").hexdigest()
    assert seed_digest == pin["seedDatabaseSha256"]
    thread = Path("/thread-id").read_text().strip()

    def fingerprint():
        records = state_api["recorded_state"](database, thread)
        assert [row[3] for row in records["messages"]] == pin["roles"]
        assert len(records["runs"]) == 1 and records["runs"][0][1] == "completed"
        current = state_api["state_fingerprint"](records)
        assert current == pin["fingerprint"]
        return current

    before = fingerprint()
    states = {}
    with host(root, base, "before") as (process, published, owner):
        tab, path, identity = prepare(call, source, ORIGIN, base=base, descriptor=published)
        call("preview_navigate", **tab, url=ORIGIN + path)
        call("preview_wait_for", **tab, selector="main .chat-markdown-shiki pre code .line:first-child")
        call("preview_act", **tab, action="type", selector=COMPOSER, text=DRAFT)
        online = observe(call, tab, None, [])
        document = online["document"]
        assert document["path"] == path
        states["online"] = capture(root, call, tab, "online", online)
        session = saved_session(database)
        assert session[-1] is not None
        process.send_signal(signal.SIGINT)
        exit_status = process.wait(timeout=12)
        assert exit_status == 128 + signal.SIGINT, f"Unexpected SIGINT exit status {exit_status}"
        require_stopped(base)

    call("preview_wait_for", **tab, text=BANNER, timeoutMs=30000)
    offline = observe(call, tab, document, [BANNER, RETRY])
    states["offline"] = capture(root, call, tab, "offline", offline)
    call("preview_act", **tab, action="click", selector='button:has-text("Retry now")')
    call("preview_wait_for", **tab, text=BANNER, timeoutMs=30000)
    retry = observe(call, tab, document, [BANNER, RETRY])
    states["reconnecting"] = capture(root, call, tab, "reconnecting", retry)
    require_stopped(base)

    with host(root, base, "after") as (process, restored, new_owner):
        assert restored == published and owner != new_owner
        call("preview_wait_for", **tab, selector='main:not(:has([data-slot="composer-banner"]))', timeoutMs=45000)
        recovered = observe(call, tab, document, [])
        auth = call("preview_evaluate", **tab, expression="""(async () => {
          const response = await fetch("/api/auth/session");
          const state = await response.json();
          return response.ok && state.authenticated === true && state.sessionMethod === "browser-session-cookie";
        })()""")["value"]
        same_session = saved_session(database)
        assert auth is True and same_session[:-1] == session[:-1]
        assert same_session[-1] is not None and same_session[-1] > session[-1]
        after = fingerprint()
        states["recovered"] = capture(root, call, tab, "recovered", recovered)

    assert states["offline"]["screenshotSha256"] != states["recovered"]["screenshotSha256"]
    receipt = {
        "schemaVersion": 1, "captureRunId": str(uuid4()), "sourceSha": source["sourceSha"],
        "packageSha256": source["archiveSha256"], "arch": "arm64", "osVersion": identity["distribution"],
        "browser": identity["browser"], "pairing": identity["pairing"], "reconnectStates": states,
        "host": {
            "initialOwnerSha256": owner, "restartedOwnerSha256": new_owner,
            "shutdown": {"signal": "SIGINT", "exitStatus": exit_status, "listener": "connection refused",
                         "runtimeRecordRemoved": True, "listenerStillRefusedAfterRetry": True},
            "sameEnvironment": restored["environmentId"] == published["environmentId"],
            "version": restored["serverVersion"], "protocol": restored["orchestrationProtocolVersion"],
            "databaseMigration": restored["databaseMigration"],
        },
        "session": {"sameBrowserDocument": True, "sameBrowserCookieSession": True,
                    "webSocketReconnected": True},
        "database": {"seedSha256": seed_digest, "before": before, "after": after},
    }
    (root / "state.json").write_text(json.dumps(receipt, indent=2) + "\n")

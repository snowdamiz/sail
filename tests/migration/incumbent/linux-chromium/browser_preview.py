from contextlib import closing, contextmanager
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sqlite3
import sys
from threading import Thread
import time
from urllib.parse import quote
from uuid import uuid4

from browser_capture import PROFILE, SETTLE, snapshot


PORT = 47720
URL = f"http://127.0.0.1:{PORT}/"
ORIGIN = "http://127.0.0.1:47717"
ADDRESS = '[aria-label="Search or enter URL"]'
CANVAS = 'canvas:has(~ textarea[aria-label="Browser page"])'
EXPRESSION = "({title: document.title, body: document.body.textContent.trim()})"
OBSERVE = """(() => {
  const address = document.querySelector('[aria-label="Search or enter URL"]');
  const canvas = document.querySelector('canvas:has(~ textarea[aria-label="Browser page"])');
  const edges = canvas?.getBoundingClientRect();
  return {
    profile: """ + PROFILE + """,
    observed: {
      address: address?.value ?? null,
      canvasVisible: !!edges?.width && !!edges.height,
      panelMaximized: !!document.querySelector('button[aria-label="Restore panel size"]'),
      originalTitle: document.body.innerText.includes('Original title'),
      updatedTitle: document.body.innerText.includes('Updated title'),
      focusedElement: document.activeElement?.tagName ?? null,
    },
  };
})()"""


@contextmanager
def page_server():
    source = Path("/preview-scenario.ts").read_text()
    html = re.search(r"const PAGE = `([^\x60]*)`;", source)[1].encode()

    class FixturePage(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

        def log_message(self, _format, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", PORT), FixturePage) as server:
        worker = Thread(target=server.serve_forever)
        worker.start()
        try:
            yield sha256(html).hexdigest()
        finally:
            server.shutdown()
            worker.join()


def provider_path(root):
    base = root / "state/userdata"
    with closing(sqlite3.connect((base / "statev2.sqlite").as_uri() + "?mode=ro", uri=True)) as db:
        threads = db.execute(
            "SELECT thread_id FROM orchestration_v2_projection_threads WHERE title = 'Capture fixture'"
        ).fetchall()
    assert len(threads) == 1
    env = (base / "environment-id").read_text().strip()
    return f"/{env}/{quote(threads[0][0], safe='')}"


def record_provider_reply(root):
    path = root / "state.json"
    state = json.loads(path.read_text())
    database = root / "state/userdata/statev2.sqlite"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
            replies = db.execute(
                """SELECT r.status, m.payload_json
                   FROM orchestration_v2_projection_runs r
                   JOIN orchestration_v2_projection_threads t USING (thread_id)
                   JOIN orchestration_v2_projection_messages m USING (run_id, thread_id)
                   WHERE t.title = 'Capture fixture' AND m.role = 'assistant' AND m.streaming = 0"""
            ).fetchall()
        if replies:
            assert len(replies) == 1
            status, payload = replies[0]
            if status == "completed":
                value = json.loads(json.loads(payload)["text"])
                assert value == state["tool"]["value"]
                state["providerRun"] = {"status": status, "reply": value}
                path.write_text(json.dumps(state, indent=2) + "\n")
                return
        time.sleep(0.1)
    raise RuntimeError("The packaged provider reply did not settle")


def inner_status(call, outer, title):
    status = call("preview_status")
    tabs = [tab for tab in status["tabs"] if tab["url"] == URL]
    assert len(tabs) == 1 and tabs[0]["tabId"] != outer["tabId"]
    inner = {"tabId": tabs[0]["tabId"]}
    status = call("preview_status", **inner)
    assert status["tabId"] == inner["tabId"]
    assert status["url"] == URL and status["title"] == title and not status["loading"]
    return inner, status


def capture_panel(root, call, outer, state):
    call("preview_act", **outer, action="hover", x=1, y=45)
    call("preview_evaluate", **outer, expression=SETTLE)
    value = call("preview_evaluate", **outer, expression=OBSERVE)["value"]
    assert value["observed"] == {
        "address": URL, "canvasVisible": True, "panelMaximized": True, "originalTitle": False,
        "updatedTitle": True, "focusedElement": "BODY",
    }
    return snapshot(root, call, outer, state, value)


def capture_browser_preview(root, source, call, prepare):
    with page_server() as page_sha:
        outer, _, identity = prepare(call, source)
        call("preview_navigate", **outer, url=ORIGIN + provider_path(root))
        call("preview_wait_for", **outer, selector='button[aria-label="Toggle right panel"]')
        call("preview_act", **outer, action="click", selector='button[aria-label="Toggle right panel"]')
        call("preview_act", **outer, action="click", selector='button:has-text("Browser")')
        call("preview_act", **outer, action="click", selector='button[aria-label="Maximize panel"]')
        call("preview_wait_for", **outer, selector='button[aria-label="Restore panel size"]')
        call("preview_evaluate", **outer, expression=SETTLE)
        call("preview_wait_for", **outer, selector=ADDRESS + ":enabled")
        call("preview_act", **outer, action="type", selector=ADDRESS, text=URL, clear=True)
        call("preview_act", **outer, action="press", key="Enter")
        call("preview_wait_for", **outer, text="Original title")
        inner, _ = inner_status(call, outer, "Original title")
        call("preview_wait_for", **outer, selector=CANVAS)
        call("preview_act", **outer, action="click", selector=CANVAS)
        call("preview_wait_for", **outer, text="Updated title")
        after, _ = inner_status(call, outer, "Updated title")
        assert after == inner
        call("preview_act", **outer, action="click", selector='button:has-text("Release control")')
        call("preview_wait_for", **outer, text="Take control")
        rendered = capture_panel(root, call, outer, "preview-rendered")
        released_tab, released = inner_status(call, outer, "Updated title")
        assert released_tab == inner, "Browser panel tab changed after releasing control"
        assert released["control"]["owner"] == "unclaimed"
        value = call("preview_evaluate", **released_tab, expression=EXPRESSION)["value"]
        assert value == {"title": "Updated title", "body": "Click to rename"}
        evaluated, _ = inner_status(call, outer, "Updated title")
        assert evaluated == inner
        result = capture_panel(root, call, outer, "tool-result")

    runtime = json.loads((root / "state/userdata/server-runtime.json").read_text())
    receipt = {
        "schemaVersion": 1, "captureRunId": str(uuid4()), "sourceSha": source["sourceSha"],
        "packageSha256": source["archiveSha256"], "arch": "arm64", "osVersion": identity["distribution"],
        "browser": identity["browser"], "pairing": identity["pairing"],
        "runtimeOwnerSha256": sha256(runtime["ownerId"].encode()).hexdigest(),
        "pageSha256": page_sha,
        "tabIdentity": {
            phase: sha256(tab["tabId"].encode()).hexdigest()
            for phase, tab in (("opened", inner), ("renamed", after), ("released", released_tab),
                               ("evaluated", evaluated))
        },
        "titleChange": {"before": "Original title", "after": "Updated title", "url": URL,
                        "sameInnerTab": True, "releasedByClient": True},
        "tool": {"name": "preview_evaluate", "expression": EXPRESSION, "value": value},
        "previewStates": {"preview-rendered": rendered, "tool-result": result},
    }
    (root / "state.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return json.dumps(value, separators=(",", ":"))


if __name__ == "__main__":
    record_provider_reply(Path(sys.argv[1]))

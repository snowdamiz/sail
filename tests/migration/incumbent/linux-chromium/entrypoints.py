from hashlib import file_digest, sha256
import json
from pathlib import Path
from runpy import run_path
from urllib.parse import quote
from uuid import uuid4

from browser_capture import PROFILE, SETTLE, snapshot


ORIGIN = "http://127.0.0.1:47717"
TITLE = "Compatibility replay"
SOURCE = "Navigation source"
LINK = 'a[aria-label="Thread, Compatibility replay"]'
PALETTE = 'input[placeholder="Search commands, projects, and threads..."]'
COMPOSER = 'main [contenteditable="true"][aria-label="Message Compatibility replay"]'
CODE = "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0"
TABLE = [
    ["Step", "Tool", "Result"], ["Read", "read", "1 file"], ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"],
]
OBSERVE = """(() => {
  const main = document.querySelector("main");
  const code = main?.querySelector(".chat-markdown-shiki pre code");
  const profile = """ + PROFILE + """;
  if (code) profile.fonts.push(getComputedStyle(code).fontFamily);
  return {
    path: location.pathname,
    profile,
    destination: {
      title: main?.querySelector("h2")?.textContent ?? null,
      paletteClosed: !document.querySelector('input[placeholder="Search commands, projects, and threads..."]'),
      reply: main?.innerText.includes("This turn is a replay.") ?? false,
      code: code?.innerText.trim() ?? null,
      table: [...(main?.querySelector("table")?.rows ?? [])].map(row =>
        [...row.cells].map(cell => cell.innerText.trim())),
    },
  };
})()"""
RESULT = """(() => {
  const input = document.querySelector('input[placeholder="Search commands, projects, and threads..."]');
  const option = document.getElementById(input?.getAttribute("aria-activedescendant") ?? "");
  return {
    focused: document.activeElement === input,
    query: input?.value ?? null,
    highlighted: !!option?.matches('[role="option"]') &&
      [...option.querySelectorAll("span")].some(label => label.textContent.trim() === "Compatibility replay"),
  };
})()"""


def open_source(call, tab, route):
    call("preview_navigate", **tab, url=ORIGIN + route)
    call("preview_wait_for", **tab, text=SOURCE)
    assert call(
        "preview_evaluate", **tab,
        expression='({path: location.pathname, title: document.querySelector("main h2")?.textContent})',
    )["value"] == {"path": route, "title": SOURCE}


def click_link(call, tab, destination):
    call("preview_wait_for", **tab, selector=LINK)
    selector = json.dumps(LINK)
    target = call("preview_evaluate", **tab, expression=f"document.querySelector({selector})?.pathname")["value"]
    assert target == destination
    call("preview_act", **tab, action="click", selector=LINK)
    return {"sourceTitle": SOURCE, "linkLabel": f"Thread, {TITLE}", "clickedDestinationLink": True}


def use_palette(call, tab):
    call("preview_act", **tab, action="press", key="k", modifiers=["Control"])
    call("preview_wait_for", **tab, selector=PALETTE + ":focus")
    call("preview_act", **tab, action="type", selector=PALETTE, text=TITLE)
    call("preview_wait_for", **tab, selector='[role="option"]:has-text("Compatibility replay")')
    result = call("preview_evaluate", **tab, expression=RESULT)["value"]
    assert result == {"focused": True, "query": TITLE, "highlighted": True}, result
    call("preview_act", **tab, action="press", key="Enter")
    return {"sourceTitle": SOURCE, "accelerator": "Ctrl+K", "query": TITLE,
            "highlightedResult": TITLE, "selection": "Enter"}


def capture_destination(root, call, tab, name, route, action):
    call("preview_wait_for", **tab, selector=COMPOSER + ":focus")
    arrival = call("preview_evaluate", **tab, expression="""({
      path: location.pathname, control: document.activeElement?.getAttribute("aria-label"),
      windowFocused: document.hasFocus(),
    })""")["value"]
    assert arrival == {"path": route, "control": f"Message {TITLE}", "windowFocused": True}, arrival
    call("preview_wait_for", **tab, selector="main .chat-markdown-shiki pre code .line:first-child")
    call("preview_act", **tab, action="hover", x=1, y=45)
    call("preview_evaluate", **tab, expression=SETTLE)
    value = call("preview_evaluate", **tab, expression=OBSERVE)["value"]
    assert value.pop("path") == route
    assert value["destination"] == {
        "title": TITLE, "paletteClosed": True, "reply": True, "code": CODE, "table": TABLE,
    }
    value["destination"].update(
        sameSavedRoute=True, sameActiveEnvironment=True, focus=arrival["control"],
        windowFocusedOnArrival=arrival["windowFocused"],
    )
    value["action"] = action
    return snapshot(root, call, tab, name, value)


def capture_entrypoints(root, source, call, prepare):
    state_api = run_path("/fixture/runtime/upgrade_state.py")
    database = root / "state/userdata/statev2.sqlite"
    thread = Path("/thread-id").read_text().strip()
    source_thread = Path("/source-thread-id").read_text().strip()
    assert source_thread and source_thread != thread
    with Path("/seed.sqlite").open("rb") as seed:
        seed_sha = file_digest(seed, "sha256").hexdigest()
    original = state_api["recorded_state"](database, thread)

    tab, destination, identity = prepare(call, source)
    source_route = destination.rsplit("/", 1)[0] + "/" + quote(source_thread, safe="")
    captures = {}
    for name in ("chat-link", "palette-link"):
        open_source(call, tab, source_route)
        action = click_link(call, tab, destination) if name == "chat-link" else use_palette(call, tab)
        captures[name] = capture_destination(root, call, tab, name, destination, action)

    assert state_api["recorded_state"](database, thread) == original
    runtime = json.loads((root / "state/userdata/server-runtime.json").read_text())
    receipt = {
        "schemaVersion": 1, "captureRunId": str(uuid4()), "sourceSha": source["sourceSha"],
        "packageSha256": source["archiveSha256"], "arch": "arm64", "osVersion": identity["distribution"],
        "browser": identity["browser"], "pairing": identity["pairing"],
        "seedSha256": seed_sha, "stateFingerprint": state_api["state_fingerprint"](original),
        "runtimeOwnerSha256": sha256(runtime["ownerId"].encode()).hexdigest(),
        "entrypointCaptures": captures,
    }
    (root / "state.json").write_text(json.dumps(receipt, indent=2) + "\n")

from hashlib import file_digest, sha256
import json
from pathlib import Path
from runpy import run_path
from urllib.parse import unquote
from uuid import uuid4

from browser_capture import PROFILE, REPLAY_CODE, REPLAY_TABLE, REPLAY_TITLE, SETTLE, snapshot
from browser_preview import provider_path


ORIGIN = "http://127.0.0.1:47717"
SIDEBAR = 'button[data-sidebar="trigger"]:visible'
MOBILE = '[data-slot="sidebar"][data-mobile="true"][data-open]'
DOCKED = '[data-slot="sidebar"][data-side="left"][data-state="expanded"]'
ATTACHMENT = {"en": "Attach files", "de": "Dateien anhängen"}
ZOOM = """(async (threadId, tabId, zoomFactor) => {
  const response = await fetch("/api/auth/websocket-ticket/rpc", {method: "POST"});
  if (!response.ok) throw new Error("Preview zoom ticket rejected");
  const {ticket} = await response.json();
  const url = new URL("/ws?orchestrationProtocol=2", location.origin);
  url.protocol = "ws:";
  url.searchParams.set("wsTicket", ticket);
  const socket = new WebSocket(url);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Preview zoom timed out")), 5000);
      socket.addEventListener("error", () => reject(new Error("Preview zoom socket failed")), {once: true});
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        _tag: "Request", id: "1", tag: "preview.adjust",
        payload: {threadId, tabId, zoomFactor}, headers: [],
      })), {once: true});
      socket.addEventListener("message", event => {
        const frame = JSON.parse(event.data);
        if (frame._tag === "Exit" && frame.requestId === "1") resolve(frame.exit);
      });
    });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
})"""
OBSERVE = """((attachment, mobile, docked) => {
  const main = document.querySelector("main");
  const code = main?.querySelector(".chat-markdown-shiki pre code");
  const profile = """ + PROFILE + """;
  if (code) profile.fonts.push(getComputedStyle(code).fontFamily);
  return {
    path: location.pathname,
    profile,
    compact: matchMedia("(max-width: 767px)").matches,
    attachmentControl: main?.querySelector('[aria-label="' + attachment + '"]')?.ariaLabel,
    chat: {
      title: main?.querySelector("h2")?.textContent,
      reply: main?.innerText.includes("This turn is a replay.") ?? false,
      highlightedCode: !!code?.querySelector(".line"),
      code: code?.innerText.trim(),
      table: [...(main?.querySelector("table")?.rows ?? [])].map(
        row => [...row.cells].map(cell => cell.innerText.trim())),
      composerFocused: !!document.activeElement?.matches('main [contenteditable="true"]'),
      sidebarOpen: !!document.querySelector(mobile + ", " + docked),
      menuOpen: [...document.querySelectorAll('[role="menu"],[role="dialog"]')].some(
        element => element.getClientRects().length > 0),
    },
  };
})"""


def evaluate(call, tab, expression):
    return call("preview_evaluate", **tab, expression=expression)["value"]


def click(call, tab, selector):
    call("preview_wait_for", **tab, selector=selector)
    call("preview_act", **tab, action="click", selector=selector)


def resize(call, tab, width, height):
    call("preview_resize", **tab, mode="freeform", width=width, height=height)


def theme(call, tab, name):
    call("preview_navigate", **tab, url=ORIGIN + "/settings/appearance")
    label = f"Use {name} mode"
    selector = f'button[aria-label="{label}"]'
    click(call, tab, selector)
    call("preview_wait_for", **tab, selector=selector + '[aria-pressed="true"]')
    return {"control": label, "selected": True}


def language(call, tab, label, option, locale):
    call("preview_navigate", **tab, url=ORIGIN + "/settings/general")
    click(call, tab, f'[data-slot="select-trigger"][aria-label="{label}"]')
    click(call, tab, f'[role="option"]:has-text("{option}")')
    call("preview_wait_for", **tab, selector=f'html[lang="{locale}"]')
    return {"control": label, "selected": option}


def zoom(call, tab, thread, factor, width, height):
    expression = f"({ZOOM})(...{json.dumps([thread, tab['tabId'], factor])})"
    result = evaluate(call, tab, expression)
    assert result["_tag"] == "Success", result.get("_tag")
    response = result["value"]
    assert (response["threadId"], response["tabId"], response["zoomFactor"]) == (thread, tab["tabId"], factor)
    assert evaluate(call, tab, f"""(async () => {{
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {{
        if (innerWidth === {round(width / factor)} && innerHeight === {round(height / factor)} &&
            devicePixelRatio === {2 * factor}) return true;
        await new Promise(requestAnimationFrame);
      }}
      return false;
    }})()"""), "Preview renderer did not apply zoom"
    return {"control": "Browser panel zoom", "rpc": "preview.adjust", "acceptedFactor": response["zoomFactor"]}


def sidebar(call, tab, compact):
    present = MOBILE if compact else DOCKED
    if evaluate(call, tab, f"!!document.querySelector({json.dumps(present)})"):
        if compact:
            call("preview_act", **tab, action="press", key="Escape")
        else:
            click(call, tab, SIDEBAR)
    click(call, tab, SIDEBAR)
    call("preview_wait_for", **tab, selector=present)
    if compact:
        call("preview_act", **tab, action="press", key="Escape")
    else:
        click(call, tab, SIDEBAR)
    return {"sidebar": "mobile sheet" if compact else "docked", "closedAfterCheck": True}


def capture_variant(root, call, tab, path, name, action, *, width=960, height=720,
                    color="light", locale="en", factor=1):
    call("preview_wait_for", **tab, selector="main .chat-markdown-shiki pre code .line:first-child")
    label = ATTACHMENT[locale]
    call("preview_wait_for", **tab, selector=f'main [aria-label="{label}"]')
    if name not in ("compact", "wide") and evaluate(call, tab, f"!!document.querySelector({json.dumps(DOCKED)})"):
        click(call, tab, SIDEBAR)
    call("preview_act", **tab, action="hover", x=1, y=45)
    evaluate(call, tab, SETTLE)
    observed = evaluate(call, tab, f"({OBSERVE})(...{json.dumps([label, MOBILE, DOCKED])})")
    assert observed.pop("path") == path
    assert observed["chat"] == {
        "title": REPLAY_TITLE, "reply": True, "highlightedCode": True, "code": REPLAY_CODE,
        "table": REPLAY_TABLE, "composerFocused": False, "sidebarOpen": False, "menuOpen": False,
    }, (name, observed["chat"])
    assert observed["compact"] == (width / factor <= 767) and observed["attachmentControl"] == label
    profile = observed["profile"]
    assert (profile["theme"], profile["locale"], profile["motion"]) == (color, locale, "standard")
    renderer = profile["viewport"]
    assert renderer == {"width": round(width / factor), "height": round(height / factor),
                        "scale": 2 * factor, "zoom": 1}, (name, renderer)
    observed["rendererViewport"] = renderer
    profile["viewport"] = {"width": width, "height": height, "scale": 2, "zoom": factor}
    observed["action"] = action
    return snapshot(root, call, tab, name, observed, dimensions=(width * 2, height * 2))


def capture_display(root, source, call, prepare):
    state_api = run_path("/fixture/runtime/upgrade_state.py")
    database = root / "state/userdata/statev2.sqlite"
    thread = Path("/thread-id").read_text().strip()
    original = state_api["recorded_state"](database, thread)
    with Path("/seed.sqlite").open("rb") as seed:
        seed_hash = file_digest(seed, "sha256").hexdigest()

    descriptor = json.loads((root / "descriptor.private.json").read_text())
    assert descriptor["label"] == "Compatibility fixture"
    tab, path, identity = prepare(call, source, descriptor=descriptor)
    controller = unquote(provider_path(root).rsplit("/", 1)[1])
    resize(call, tab, 960, 720)
    captures = {}
    for color in ("light", "dark"):
        action = theme(call, tab, color)
        call("preview_navigate", **tab, url=ORIGIN + path)
        captures[color] = capture_variant(root, call, tab, path, color, action, color=color)
    theme(call, tab, "light")
    action = language(call, tab, "Language", "Deutsch", "de")
    call("preview_navigate", **tab, url=ORIGIN + path)
    captures["translated"] = capture_variant(root, call, tab, path, "translated", action, locale="de")
    language(call, tab, "Sprache", "English", "en")
    call("preview_navigate", **tab, url=ORIGIN + path)
    for name, width, height in (("compact", 640, 600), ("wide", 1280, 780)):
        resize(call, tab, width, height)
        action = sidebar(call, tab, compact=name == "compact")
        captures[name] = capture_variant(root, call, tab, path, name, action, width=width, height=height)
    resize(call, tab, 960, 720)
    action = zoom(call, tab, controller, 1.25, 960, 720)
    captures["zoomed"] = capture_variant(root, call, tab, path, "zoomed", action, factor=1.25)

    assert state_api["recorded_state"](database, thread) == original
    runtime = json.loads((root / "state/userdata/server-runtime.json").read_text())
    receipt = {
        "schemaVersion": 1, "captureRunId": str(uuid4()), "sourceSha": source["sourceSha"],
        "packageSha256": source["archiveSha256"], "arch": "arm64", "osVersion": identity["distribution"],
        "browser": identity["browser"], "pairing": identity["pairing"], "environmentLabel": descriptor["label"],
        "seedSha256": seed_hash, "stateFingerprint": state_api["state_fingerprint"](original),
        "runtimeOwnerSha256": sha256(runtime["ownerId"].encode()).hexdigest(), "displayCaptures": captures,
    }
    (root / "state.json").write_text(json.dumps(receipt, indent=2) + "\n")

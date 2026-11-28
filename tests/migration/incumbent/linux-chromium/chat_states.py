from contextlib import contextmanager
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import time
from uuid import uuid4


UNPAIRED = "00000000-0000-4000-8000-000000000000"
TABLE = [
    ["Step", "Tool", "Result"], ["Read", "read", "1 file"], ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"],
]
OBSERVE = """(() => {
  const main = document.querySelector("main");
  const body = document.body.innerText;
  const composer = main?.querySelector('[contenteditable="true"]');
  const loading = [...document.querySelectorAll('[role="status"]')].find(
    element => element.getClientRects().length && element.textContent.includes("Loading messages...")
  );
  const recovery = [...document.querySelectorAll("a")].find(link => link.textContent.trim() === "Open Environments");
  return {
    profile: {
      browser: navigator.userAgent.match(/Chrome\\/[^ ]+/)?.[0],
      locale: document.documentElement.lang,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "standard",
      fonts: [getComputedStyle(document.body).fontFamily],
      viewport: {width: innerWidth, height: innerHeight, scale: devicePixelRatio, zoom: visualViewport.scale},
    },
    observed: {
      heading: main?.querySelector("h2")?.textContent ?? null,
      composer: composer?.getAttribute("aria-label") ?? null,
      focusedElement: document.activeElement?.tagName ?? null,
      mainBranch: !!main?.querySelector('[aria-label="Branch: main"]'),
      emptyHint: body.includes("What should we build?"),
      submitDisabled: !!main?.querySelector('[aria-label="Submit message"]:disabled'),
      loadingLabel: loading?.textContent.trim() ?? null,
      loadingRole: loading?.getAttribute("role") ?? null,
      loadingSubmitDisabled: !!main?.querySelector('[aria-label="Messages loading"]:disabled'),
      replayReply: body.includes("This turn is a replay."),
      unavailable: body.includes("Thread unavailable"),
      unpairedMessage: body.includes("This thread is on an environment this app is not connected to."),
      recoveryHref: recovery?.getAttribute("href") ?? null,
    },
  };
})()"""
SETTLE = """(async () => {
  document.activeElement?.blur();
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const animations = document.getAnimations().filter(animation =>
    animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)
  );
  await Promise.allSettled(animations.map(animation => animation.finished));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
})()"""


@contextmanager
def gate(root):
    marker = root / "gate"
    marker.write_text("hold\n")
    events = root / "chat-states-gate.log"
    thread = Path("/thread-id").read_text().strip()
    with events.open("w") as output, subprocess.Popen(
        ["node", "/fixture/thread-load-gate.mjs", "0", "47717", thread, marker],
        stdout=output, stderr=subprocess.STDOUT,
        env=os.environ | {"SAIL_MIGRATION_WS_MODULE": "/usr/share/nodejs/ws"},
    ) as proxy:
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and proxy.poll() is None:
                if bound := re.search(r"^Listening on (127\.0\.0\.1:[0-9]+)$", events.read_text(), re.M):
                    yield f"http://{bound[1]}", marker, events
                    return
                time.sleep(0.1)
            raise RuntimeError("Loopback thread gate did not start")
        finally:
            if proxy.poll() is None:
                proxy.terminate()
                try:
                    proxy.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proxy.kill()
                    proxy.wait()


def observe(call, tab, state):
    call("preview_act", **tab, action="hover", x=1, y=45)
    call("preview_evaluate", **tab, expression=SETTLE)
    value = call("preview_evaluate", **tab, expression=OBSERVE)["value"]
    profile = value["profile"]
    assert profile["viewport"] == {"width": 640, "height": 600, "scale": 2, "zoom": 1}
    assert profile["theme"] == "light" and profile["locale"] == "en"
    actual = value["observed"]
    assert not actual["replayReply"] and actual["focusedElement"] == "BODY"
    if state == "empty":
        assert actual["emptyHint"] and actual["composer"] == "Message New thread"
        assert actual["submitDisabled"] and actual["mainBranch"] and actual["loadingLabel"] is None
    elif state == "initial-loading":
        assert not actual["emptyHint"] and actual["composer"] == "Message Compatibility replay"
        assert actual["loadingLabel"] == "Loading messages..." and actual["loadingRole"] == "status"
        assert actual["loadingSubmitDisabled"]
    elif state == "error":
        assert actual["unavailable"] and actual["unpairedMessage"]
        assert actual["composer"] is None and actual["recoveryHref"] == "/settings/connections"
    return value


def snapshot(root, call, tab, state, observation):
    directory = root / state
    directory.mkdir()
    path = directory / "capture.png"
    screenshot = call("preview_snapshot", **tab, save=True)
    shutil.copyfile(screenshot["screenshotPath"], path)
    with path.open("rb") as source:
        assert struct.unpack(">II", source.read(24)[16:24]) == (1280, 1200)
        source.seek(0)
        observation["screenshotSha256"] = file_digest(source, "sha256").hexdigest()
    return observation


def capture_states(root, source, call, prepare):
    states = {}
    with gate(root) as (origin, marker, events):
        tab, path, identity = prepare(call, source, origin)
        call("preview_wait_for", **tab, text="What should we build?")
        call("preview_wait_for", **tab, selector='main [aria-label="Branch: main"]')
        states["empty"] = snapshot(root, call, tab, "empty", observe(call, tab, "empty"))

        call("preview_navigate", **tab, url=origin + path)
        call("preview_wait_for", **tab, text="Loading messages...")
        loading = observe(call, tab, "initial-loading")
        assert any(
            json.loads(line)["event"] == "held-thread-rpc"
            for line in events.read_text().splitlines() if line.startswith("{")
        )
        loading["observed"]["heldThreadRpc"] = True
        states["initial-loading"] = snapshot(root, call, tab, "initial-loading", loading)

        marker.write_text("open\n")
        call("preview_wait_for", **tab, selector="main .chat-markdown-shiki pre code .line:first-child")
        restored = call("preview_evaluate", **tab, expression="""(() => {
          const main = document.querySelector("main");
          return {path: location.pathname, title: main.querySelector("h2")?.textContent,
                  reply: main.innerText.includes("This turn is a replay."),
                  table: [...main.querySelector("table").rows].map(row =>
                    [...row.cells].map(cell => cell.innerText.trim()))};
        })()""")["value"]
        assert restored.pop("path") == path and restored["title"] == "Compatibility replay"
        assert restored["reply"] and restored["table"] == TABLE
        restored["openedExpectedThread"] = True

        unknown = "/" + UNPAIRED + "/" + path.rsplit("/", 1)[1]
        call("preview_navigate", **tab, url=origin + unknown)
        call("preview_wait_for", **tab, text="Thread unavailable")
        states["error"] = snapshot(root, call, tab, "error", observe(call, tab, "error"))
        recovery = states["error"]["observed"]["recoveryHref"]
        call("preview_act", **tab, action="click", selector=f'a[href="{recovery}"]')
        call("preview_wait_for", **tab, urlIncludes=recovery)
        opened_settings = call("preview_evaluate", **tab, expression="location.pathname")["value"]
        assert opened_settings == recovery

    runtime = json.loads((root / "state/userdata/server-runtime.json").read_text())
    result = {
        "schemaVersion": 1, "captureRunId": str(uuid4()), "sourceSha": source["sourceSha"],
        "packageSha256": source["archiveSha256"], "arch": "arm64", "osVersion": identity["distribution"],
        "runtimeOwnerSha256": sha256(runtime["ownerId"].encode()).hexdigest(),
        "browser": identity["browser"], "pairing": identity["pairing"], "chatStates": states,
        "afterRelease": restored, "afterRecovery": {"path": opened_settings},
    }
    (root / "state.json").write_text(json.dumps(result, indent=2) + "\n")

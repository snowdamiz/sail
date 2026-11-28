from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote, urlsplit
from urllib.request import urlopen
from uuid import uuid4

import websocket

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from upgrade_state import recorded_state, state_fingerprint


RELEASE = "18fd0e5d66291fc007163512d783d7268218db16"
OUT = Path("/out")
INPUT = Path("/input")
CODE = "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0"
TABLE = [["Step", "Tool", "Result"], ["Read", "read", "1 file"], ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"]]
OBSERVE = """(() => {
  const main = document.querySelector("main");
  const code = main?.querySelector(".chat-markdown-shiki pre code");
  return {
    route: location.hash,
    title: main?.querySelector("h2")?.textContent,
    reply: main?.innerText.includes("This turn is a replay."),
    highlightedCode: code?.querySelectorAll(".line").length > 0,
    code: code?.textContent.trim(),
    table: [...(main?.querySelectorAll("table tr") ?? [])].map(
      row => [...row.cells].map(cell => cell.innerText.trim())),
    composerFocused: document.activeElement?.matches("main [contenteditable=true]"),
    windowFocused: document.hasFocus(),
    sidebarOpen: document.querySelector('[aria-label="Toggle main sidebar"]')?.getAttribute("aria-pressed") === "true",
    detailsOpen: main?.querySelector('[aria-label="Toggle thread details panel"]')?.getAttribute("aria-pressed") === "true",
    desktopBridge: !!window.desktopBridge,
    showcase: !![...(main?.querySelectorAll("button") ?? [])].find(button => button.innerText.trim() === "Showcase"),
    menuOpen: [...document.querySelectorAll('[role=menu],[role=dialog]')].some(el => el.getClientRects().length),
    locale: document.documentElement.lang,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "standard",
    fonts: code ? [getComputedStyle(document.body).fontFamily, getComputedStyle(code).fontFamily] : [],
    viewport: {width: innerWidth, height: innerHeight, scale: devicePixelRatio, zoom: visualViewport.scale},
    userAgent: navigator.userAgent,
    resourceOrigins: [...new Set(performance.getEntriesByType("resource").map(entry => new URL(entry.name).origin))]
  };
})()"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def command(*args):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, check=True, timeout=60).stdout.strip()


def port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def read_json(url):
    with urlopen(url, timeout=3) as response:
        return json.load(response)


def wait_for(probe, child, description, seconds=240):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        require(child.poll() is None, f"Desktop exited before {description}: {child.returncode}")
        try:
            result = probe()
        except OSError:
            result = None
        if result:
            return result
        time.sleep(0.15)
    raise RuntimeError(f"Timed out waiting for {description}")


class Page:
    def __init__(self, url, debug_port):
        endpoint = urlsplit(url)
        require(endpoint.scheme == "ws" and endpoint.netloc == f"127.0.0.1:{debug_port}", "DevTools endpoint must be local")
        self.socket = websocket.create_connection(url, timeout=18, suppress_origin=True)
        self.sequence = 0

    def call(self, method, **params):
        self.sequence += 1
        self.socket.send(json.dumps({"id": self.sequence, "method": method, "params": params}))
        while True:
            message = json.loads(self.socket.recv())
            if message.get("id") == self.sequence:
                require("result" in message, f"CDP command failed: {method}")
                return message["result"]

    def evaluate(self, expression):
        result = self.call("Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True)
        require("exceptionDetails" not in result, "Fixture renderer evaluation failed")
        return result["result"].get("value")


def bootstrap_sessions(database):
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        return db.execute(
            "SELECT method, scopes FROM auth_sessions WHERE subject = ? AND revoked_at IS NULL",
            ("desktop-bootstrap",),
        ).fetchall()


def launch_inputs(root, backend_port):
    env = os.environ.copy()
    for name, directory in {
        "HOME": "home", "XDG_CONFIG_HOME": "config", "XDG_CACHE_HOME": "cache",
        "XDG_DATA_HOME": "data", "XDG_STATE_HOME": "xdg-state",
        "XDG_RUNTIME_DIR": "runtime", "TMPDIR": "tmp",
    }.items():
        path = root / directory
        path.mkdir(mode=0o700)
        env[name] = str(path)
    env.update(
        SAIL_HOME=str(root / "state"), T3CODE_HOME=str(root / "state"),
        T3CODE_PORT=str(backend_port), T3CODE_DISABLE_AUTO_UPDATE="true",
        T3CODE_TELEMETRY_ENABLED="false", LANG="C.UTF-8", GTK_THEME="Adwaita:light",
    )
    state = root / "state/userdata"
    state.mkdir(parents=True)
    database = state / "statev2.sqlite"
    database.write_bytes((INPUT / "seed.sqlite").read_bytes())
    environment_id = str(uuid4())
    (state / "environment-id").write_text(environment_id + "\n")
    replay = INPUT / "replay.tar"
    with replay.open("rb") as stream:
        source = subprocess.run(["git", "get-tar-commit-id"], stdin=stream, check=True, text=True, stdout=subprocess.PIPE).stdout.strip()
    require(source == RELEASE and digest(replay) == "d5e4734da563609b752e0b4e1452fdc4c7ac539a750ed60f45ce211f8daed449", "Unexpected Replay source archive")
    provider = root / "replay"
    provider.mkdir()
    command("tar", "-xf", replay, "-C", provider)
    (state / "settings.json").write_text(json.dumps({"providerInstances": {"devReplay": {
        "displayName": "Replay (dev)", "driver": "acpRegistry", "config": {
            "source": "local", "commandPath": "/usr/local/bin/node",
            "commandArgs": [str(provider / "apps/server/scripts/dev-replay-agent.ts")],
        },
    }}}))
    return env, database, environment_id


def installed_launcher(arch):
    architecture = {"arm64": "arm64", "x64": "amd64"}[arch]
    status = command("dpkg-query", "-W", "-f=${Status}|${Version}|${Architecture}", "sail")
    require(status == f"install ok installed|0.1.17|{architecture}", "Installed Sail package identity differs")
    files = command("dpkg", "-L", "sail").splitlines()
    entry = next(path for path in files if path.startswith("/usr/share/applications/") and path.endswith(".desktop"))
    exec_line = next(line for line in Path(entry).read_text().splitlines() if line.startswith("Exec="))
    launcher = Path(shlex.split(exec_line.removeprefix("Exec="))[0])
    require(str(launcher) in files and launcher.is_file(), "Desktop entry does not select an installed executable")
    return launcher


def x11_window(page):
    title = page.evaluate("document.title")
    windows = command("xdotool", "search", "--onlyvisible", "--name", "^" + re.escape(title) + "$").splitlines()
    require(len(windows) == 1, "Expected exactly one fixture X11 window")
    return windows[0]


def capture_window(window, expected):
    png = OUT / "capture.png"
    require(not png.exists(), "Capture output already exists")
    command("scrot", "--window", window, str(png))
    with png.open("rb") as stream:
        header = stream.read(24)
    require(header[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", header[16:24]) == expected, "Physical screenshot dimensions changed")
    return digest(png)


def observe(page, child, browser, route):
    def ready():
        state = page.evaluate(OBSERVE)
        return state if state.get("route") == route and state.get("reply") and state.get("highlightedCode") and state.get("showcase") else None

    opened = wait_for(ready, child, "native link, saved reply and Replay provider")
    require(opened["desktopBridge"] and browser in opened["resourceOrigins"], "Renderer did not connect to the bundled backend")
    require(opened["title"] == "Compatibility replay" and opened["code"] == CODE and opened["table"] == TABLE, "Saved Replay content changed")
    require(opened["composerFocused"] and opened["windowFocused"], "Native link did not focus the seeded composer")
    require(not opened["menuOpen"], "Unexpected menu or dialog on the seeded thread")
    command("xdotool", "mousemove", "1399", "999")
    page.evaluate("""(async () => {
      const sidebar = document.querySelector('[aria-label="Toggle main sidebar"]');
      if (sidebar?.getAttribute("aria-pressed") === "true") sidebar.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const details = document.querySelector('main [aria-label="Toggle thread details panel"]');
      if (details?.getAttribute("aria-pressed") === "true") details.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.activeElement?.blur();
      await document.fonts.ready;
    })()""")
    window = x11_window(page)
    # X11 can retain different shadow pixels from the initial layout paint.
    for width in (1101, 1100):
        command("xdotool", "windowsize", window, str(width), "780")
        wait_for(lambda: page.evaluate(f"innerWidth === {width}"), child, "X11 resize", seconds=15)
    page.evaluate("""(async () => {
      let lastLayout;
      let stableFrames = 0;
      const deadline = performance.now() + 5000;
      while (stableFrames < 8 && performance.now() < deadline) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const elements = [document.querySelector("main .chat-markdown-shiki pre")];
        for (let el = document.querySelector("main [contenteditable=true]"); el && el.tagName !== "MAIN"; el = el.parentElement) {
          elements.push(el);
        }
        const layout = JSON.stringify(elements.map(el => el.getBoundingClientRect()));
        const moving = document.getAnimations().some(animation =>
          animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);
        stableFrames = !moving && layout === lastLayout ? stableFrames + 1 : 0;
        lastLayout = layout;
      }
      if (stableFrames < 8) throw new Error("Transcript and composer did not settle");
    })()""")
    settled = page.evaluate(OBSERVE)
    require(
        settled["route"] == route and settled["reply"] and settled["table"] == TABLE
        and not settled["composerFocused"] and not settled["sidebarOpen"] and not settled["detailsOpen"],
        "Unexpected settled thread, transcript, composer focus or panels: "
        + repr({key: settled[key] for key in ("title", "reply", "composerFocused", "sidebarOpen", "detailsOpen")}),
    )
    require(settled["viewport"] == {"width": 1100, "height": 780, "scale": 1, "zoom": 1}, "Unexpected X11 viewport")
    require(settled["theme"] == "light" and settled["locale"] == "en" and not settled["menuOpen"], "Unexpected desktop display profile")
    return opened, settled, window


def run(arch, package_sha):
    launcher = installed_launcher(arch)
    backend_port, debug_port = port(), port()
    require(backend_port != debug_port, "Backend and CDP ports collide")
    browser = f"http://127.0.0.1:{backend_port}"
    debugger = f"http://127.0.0.1:{debug_port}"
    with tempfile.TemporaryDirectory(prefix="sail-desktop-") as directory:
        root = Path(directory)
        env, database, environment = launch_inputs(root, backend_port)
        seed_sha = digest(database)
        thread = (INPUT / "thread-id").read_text().strip()
        encoded = quote(thread, safe="")
        link = f"sail://threads/{environment}/{encoded}"
        route = f"#/{environment}/{encoded}"
        runtime_path = database.parent / "server-runtime.json"
        initial = recorded_state(database, thread)
        require(len(initial["messages"]) == 3 and len(initial["runs"]) == 1, "Expected the completed Replay seed")
        require(not bootstrap_sessions(database), "Seed includes an active desktop bootstrap session")
        launch = [launcher, "--no-sandbox", "--disable-gpu-compositing", "--force-device-scale-factor=1",
                  "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={debug_port}", link]
        with (OUT / "desktop.private.log").open("w") as log, subprocess.Popen(
            launch, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        ) as child:
            try:
                descriptor = wait_for(lambda: read_json(browser + "/.well-known/t3/environment"), child, "bundled backend")
                require(descriptor["environmentId"] == environment and descriptor["platform"]["os"] == "linux" and descriptor["platform"]["arch"] == arch, "Bundled environment identity changed")
                require(descriptor["serverVersion"] == "0.1.17" and descriptor["orchestrationProtocolVersion"] == 2 and descriptor["databaseMigration"] == 118 and descriptor["capabilities"]["serverSelfUpdate"] == "desktop-managed", "Unexpected bundled backend contract")
                runtime = wait_for(lambda: json.loads(runtime_path.read_text()), child, "bundled runtime record")
                backend_pid = runtime["pid"]
                process_status = Path(f"/proc/{backend_pid}/status").read_text()
                require(re.search(r"^PPid:\s+(\d+)$", process_status, re.M)[1] == str(child.pid), "Backend is not a child of the installed desktop")
                pages = wait_for(lambda: [p for p in read_json(debugger + "/json/list") if p["type"] == "page" and p["url"].startswith("sail://app/")], child, "installed renderer")
                require(len(pages) == 1, "Expected one installed renderer")
                page = Page(pages[0]["webSocketDebuggerUrl"], debug_port)
                try:
                    opened, settled, window = observe(page, child, browser, route)
                    sessions = bootstrap_sessions(database)
                    require(len(sessions) == 1 and sessions[0][0] == "bearer-access-token", "Expected one new desktop bootstrap bearer session")
                    scopes = json.loads(sessions[0][1])
                    require({"orchestration:read", "orchestration:operate"} <= set(scopes), "Bootstrap bearer cannot operate the thread")
                    screenshot_sha = capture_window(window, (1100, 780))
                finally:
                    page.socket.close()
                browser_page = Page(read_json(debugger + "/json/version")["webSocketDebuggerUrl"], debug_port)
                try:
                    browser_page.call("Browser.close")
                except websocket.WebSocketConnectionClosedException:
                    pass
                finally:
                    browser_page.socket.close()
                require(child.wait(timeout=35) == 0, "Desktop did not exit cleanly")
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
        require(not runtime_path.exists(), "Desktop left a bundled runtime record")
        with socket.socket() as test:
            test.settimeout(3)
            require(test.connect_ex(("127.0.0.1", backend_port)) != 0, "Bundled listener survived desktop exit")
        require(recorded_state(database, thread) == initial, "Desktop changed saved Replay payloads")

    result = {
        "schemaVersion": 1, "captureRunId": str(uuid4()), "sourceSha": RELEASE,
        "packageSha256": package_sha, "arch": arch, "osVersion": "Debian " + Path("/etc/debian_version").read_text().strip(),
        "electronVersion": re.search(r"Electron/([0-9.]+)", settled["userAgent"])[1],
        "seedSha256": seed_sha, "stateFingerprint": state_fingerprint(initial),
        "backend": {"version": descriptor["serverVersion"], "protocol": 2, "databaseMigration": 118,
                    "capability": "desktop-managed", "ownedChild": True, "rendererRequestsMatch": True,
                    "bootstrapSessionMethod": sessions[0][0], "scopes": scopes,
                    "shutdown": "CDP Browser.close", "listenerClosed": True, "runtimeRecordRemoved": True},
        "activation": {"source": "native launch argv", "openedExpectedThread": True, "title": opened["title"],
                       "composerFocused": opened["composerFocused"], "windowFocused": opened["windowFocused"]},
        "chat": {key: value for key, value in settled.items() if key not in {"route", "userAgent", "resourceOrigins"}},
        "screenshotSha256": screenshot_sha,
    }
    (OUT / "state.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Sail v0.1.17 {arch} desktop bootstrap and saved Replay capture verified")


if __name__ == "__main__":
    run(*sys.argv[1:])

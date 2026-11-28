from contextlib import contextmanager
from hashlib import file_digest
import json
import os
from pathlib import Path
from queue import Queue
import re
import shutil
import subprocess
import sys
from threading import Thread
import time
import traceback
from urllib.parse import quote, urlsplit
import uuid


ROOT = Path(sys.argv[1])
ORIGIN = "http://127.0.0.1:47717"


def capture_source():
    path = Path("/capture-source.json")
    if path.is_file():
        source = json.loads(path.read_text())
        assert re.fullmatch(r"[0-9a-f]{40}", source["sourceSha"])
        return source
    inventory = json.loads(Path("/fixture/release-inventory.json").read_text())
    asset = next(
        item for item in inventory["githubRelease"]["assets"]
        if item["name"] == "t3-0.1.17-linux-arm64.tar.gz"
    )
    return {
        "version": "0.1.17",
        "sourceSha": inventory["incumbentSourceSha"],
        "archiveSha256": asset["digest"].removeprefix("sha256:"),
        "databaseMigration": 118,
    }


def command(argv, **options):
    return subprocess.run(
        argv, text=True, capture_output=True, check=True, timeout=60, **options
    ).stdout


def mcp_executable():
    argv = [os.environ["T3_ACP_MCP_NODE"]]
    if entry := os.environ.get("T3_ACP_MCP_ENTRYPOINT"):
        argv.append(entry)
    return argv


def preview_result(result, name):
    if result.get("isError") or "structuredContent" not in result:
        raise RuntimeError(f"{name} failed")
    return result["structuredContent"]


def preview(name, **params):
    result = json.loads(
        command([*mcp_executable(), "acp-mcp-call", name, "-"], input=json.dumps(params))
    )
    return preview_result(result, name)


@contextmanager
def preview_session():
    with (ROOT / "bridge.private.log").open("w") as log:
        bridge = subprocess.Popen(
            [*mcp_executable(), "acp-mcp-bridge"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=log,
            text=True,
        )
        replies = Queue()

        def receive():
            for line in bridge.stdout:
                replies.put(line)
            replies.put(None)

        reader = Thread(target=receive)
        reader.start()
        request_id = 0

        def send_rpc(message):
            bridge.stdin.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
            bridge.stdin.flush()

        def rpc(method, params):
            nonlocal request_id
            request_id += 1
            send_rpc({"id": request_id, "method": method, "params": params})
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                line = replies.get(timeout=max(0, deadline - time.monotonic()))
                if line is None:
                    raise RuntimeError("The packaged MCP bridge exited")
                message = json.loads(line)
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(message["error"]["message"])
                    return message["result"]
            raise RuntimeError(f"Timed out waiting for {method}")

        def call(name, **params):
            return preview_result(rpc("tools/call", {"name": name, "arguments": params}), name)

        try:
            rpc("initialize", {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "sail-migration-capture", "version": "1"},
            })
            send_rpc({"method": "notifications/initialized"})
            yield call
        finally:
            bridge.stdin.close()
            try:
                bridge.wait(timeout=5)
            except subprocess.TimeoutExpired:
                bridge.kill()
                bridge.wait()
            reader.join()
            bridge.stdout.close()


def pair(call, tab, origin=ORIGIN, base=ROOT / "state"):
    output = command([ROOT / "runtime/t3", "pair", "--base-dir", base])
    link = urlsplit(re.search(r"^Pairing URL: (.+)$", output, re.MULTILINE)[1])
    assert link.path == "/pair" and link.fragment.startswith("token=")
    call("preview_navigate", **tab, url=f"{origin}/pair#{link.fragment}")
    call("preview_wait_for", **tab, selector='main [contenteditable="true"]')
    expression = """(async () => {
        if (location.pathname === '/pair' || location.hash) return false;
        const auth = await (await fetch('/api/auth/session')).json();
        return auth.authenticated === true && auth.sessionMethod === 'browser-session-cookie';
    })()"""
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if call("preview_evaluate", **tab, expression=expression)["value"]:
                return
        except (subprocess.CalledProcessError, RuntimeError) as error:
            detail = getattr(error, "stderr", None) or str(error)
            if "Execution context was destroyed" not in detail:
                raise
        time.sleep(0.1)
    raise RuntimeError("Browser pairing did not complete")


def chrome_identity():
    executable = ROOT / "state/tools/chrome-headless-shell/linux-arm64/158.0.8127.88/chrome-headless-shell"
    with executable.open("rb") as source:
        header = source.read(20)
    assert header[:6] == b"\x7fELF\x02\x01" and int.from_bytes(header[18:20], "little") == 183
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            running = (process / "exe").readlink()
        except OSError:
            continue
        if running == executable:
            return command([executable, "--version"]).strip()
    raise RuntimeError("The packaged Browser panel did not launch the pinned arm64 executable")


def record_capture(profile, trace, state, source):
    name = "chrome-158.0.8127.88-debian-arm64-en-light-640x600-2x"
    assert profile["viewport"] == {"width": 640, "height": 600, "scale": 2, "zoom": 1}
    assert profile["locale"] == "en" and profile["theme"] == "light" and profile["motion"] == "standard"
    assert profile["browser"] == "Chrome/158.0.0.0"
    assert state["browser"] == "Google Chrome for Testing 158.0.8127.88"
    assert state["distribution"] == "Debian 12.15"
    assert state["systemFontPackage"] == "fonts-dejavu-core 2.37-6"
    with (ROOT / "capture.png").open("rb") as screenshot:
        sha = file_digest(screenshot, "sha256").hexdigest()
    receipt = {
        "schemaVersion": 1,
        "fixtureId": "chat-turn",
        "sourceSha": source["sourceSha"],
        "client": state["browser"] + " through the Sail Browser panel",
        "server": f"Sail v{source['version']} Linux arm64 CLI server",
        "profile": {
            **profile,
            "surface": "server-served-web",
            "platform": state["distribution"] + " Linux arm64",
            "origin": "server-served loopback",
        },
        "trace": trace,
        "screenshotSha256": sha,
        "coverage": {
            "caseId": "chat-turn",
            "platformId": "served-chromium-linux",
            "state": "settled",
            "entrypoint": "chat",
            "configurationId": name,
        },
        "packageSha256": source["archiveSha256"],
        "captureRunId": name + "-" + (
            str(uuid.uuid4()) if "captureRounds" in source else ROOT.name
        ),
    }
    state["captureRunId"] = receipt["captureRunId"]
    (ROOT / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (ROOT / "state.json").write_text(json.dumps(state, indent=2) + "\n")


def prepare(call, source, origin=ORIGIN, *, base=ROOT / "state", descriptor=None):
    if descriptor is None:
        descriptor = json.loads((ROOT / "descriptor.private.json").read_text())
    assert descriptor["serverVersion"] == source["version"]
    assert descriptor["orchestrationProtocolVersion"] == 2
    assert descriptor["databaseMigration"] == source["databaseMigration"]
    assert descriptor["platform"] == {"os": "linux", "arch": "arm64"}
    thread = Path("/thread-id").read_text().strip()
    path = f"/{descriptor['environmentId']}/{quote(thread, safe='')}"
    call("preview_status")
    opened = call("preview_open", open=False, reuseExistingTab=False)
    tab = {"tabId": opened["tabId"]}
    call("preview_resize", **tab, mode="freeform", width=640, height=600)
    call("preview_set_appearance", **tab, colorScheme="light")
    pair(call, tab, origin, base)
    return tab, path, {
        "platform": descriptor["platform"],
        "version": descriptor["serverVersion"],
        "protocol": descriptor["orchestrationProtocolVersion"],
        "databaseMigration": descriptor["databaseMigration"],
        "browser": chrome_identity(),
        "distribution": "Debian " + Path("/etc/debian_version").read_text().strip(),
        "systemFontPackage": " ".join(command(["dpkg-query", "-W", "fonts-dejavu-core"]).split()),
        "pairing": "browser-session-cookie",
    }


def settled(call, tab, path, probe, output, include_composer=False):
    started = time.perf_counter_ns()
    call("preview_navigate", **tab, url=ORIGIN + path)
    navigated = time.perf_counter_ns()
    call("preview_wait_for", **tab, selector="main .chat-markdown-shiki pre code .line:first-child")
    call("preview_wait_for", **tab, text="Showcase")
    highlighted = time.perf_counter_ns()
    call("preview_act", **tab, action="press", key="Tab")
    call("preview_act", **tab, action="hover", x=1, y=45)
    focused = time.perf_counter_ns()
    evidence = call("preview_evaluate", **tab, expression=probe)["value"]
    observed = call(
        "preview_evaluate",
        **tab,
        expression="""(() => {
            const main = document.querySelector('main');
            return {
                pathname: location.pathname,
                timeOrigin: performance.timeOrigin,
                browserPlatform: navigator.platform,
                availableModel: main.innerText.includes('Showcase') && !main.innerText.includes('Unavailable'),
                providerWarning: document.body.innerText.includes('could not create a test session'),
                table: [...main.querySelector('table').rows].map(row => [...row.cells].map(cell => cell.innerText.trim())),
            };
        })()""",
    )["value"]
    assert observed.pop("pathname") == path
    navigation = observed.pop("timeOrigin")
    assert observed["availableModel"] and not observed["providerWarning"]
    assert observed["table"] == [
        ["Step", "Tool", "Result"],
        ["Read", "read", "1 file"],
        ["Edit", "edit", "+4 lines"],
        ["Test", "execute", "12 passed"],
    ]
    traced = time.perf_counter_ns()
    if include_composer:
        evidence["trace"][0]["observed"].update({
            "availableModel": observed["availableModel"],
            "table": observed["table"],
        })
        evidence["trace"].append({
            "action": "readComposerControls",
            "observed": {"controls": compare_composer(call, tab)},
        })
    composer_read = time.perf_counter_ns() if include_composer else traced
    image = call("preview_snapshot", **tab, save=True)
    captured = time.perf_counter_ns()
    shutil.copyfile(image["screenshotPath"], output)
    durations = {
        "elapsedNs": captured - started,
        "stagesNs": {
            "navigate": navigated - started,
            "highlight": highlighted - navigated,
            "focus": focused - highlighted,
            "trace": traced - focused,
            "screenshot": captured - composer_read,
        },
    }
    if include_composer:
        durations["stagesNs"]["composer"] = composer_read - traced
    return evidence, {"openedExpectedThread": True, **observed}, durations, navigation


def compare_composer(call, tab):
    return call("preview_evaluate", **tab, expression="""(() => {
        const main = document.querySelector('main');
        const form = main.querySelector('[contenteditable=true]').closest('form') ?? main;
        return [...form.querySelectorAll('button')]
            .filter(button => button.getClientRects().length)
            .map(button => ({
                name: button.getAttribute('aria-label') ?? button.textContent.trim(),
                pressed: button.getAttribute('aria-pressed'),
            }))
            .filter(button => /showcase|poteto|submit|attach files/i.test(button.name));
    })()""")["value"]


def sample_series(call, source, probe):
    tab, path, state = prepare(call, source)
    samples = ROOT / "samples"
    samples.mkdir()
    (ROOT / "ready").touch()
    previous_navigation = None
    for index in range(source["captureRounds"]):
        grant = ROOT / f"capture-{index}.request"
        deadline = time.monotonic() + 300
        while not grant.is_file():
            if time.monotonic() >= deadline:
                raise RuntimeError("Timed out waiting for the next capture")
            time.sleep(0.05)
        request = json.loads(grant.read_text())
        assert request["round"] == index and request["host"] == ROOT.name
        image = samples / f"{index:02}.png"
        evidence, observed, durations, navigation = settled(
            call, tab, path, probe, image, include_composer=True
        )
        assert navigation != previous_navigation
        previous_navigation = navigation
        with image.open("rb") as screenshot:
            digest = file_digest(screenshot, "sha256").hexdigest()
        if request["representative"]:
            shutil.copyfile(image, ROOT / "capture.png")
            record_capture(evidence["profile"], evidence["trace"], {**state, **observed}, source)
        sample = {
            **request,
            **durations,
            **evidence,
            "timingScope": "fullTraceAndScreenshot",
            "screenshotSha256": digest,
            "sourceSha": source["sourceSha"],
            "packageSha256": source["archiveSha256"],
            "runtimeSha256": source["runtimeSha256"],
        }
        temporary = samples / f"{index:02}.pending"
        temporary.write_text(json.dumps(sample) + "\n")
        temporary.rename(samples / f"{index:02}.json")


def capture():
    source = capture_source()
    if (ROOT / "chat-states").is_file():
        from chat_states import capture_states

        with preview_session() as call:
            capture_states(ROOT, source, call, prepare)
        return
    if (ROOT / "reconnect").is_file():
        from reconnect import capture_reconnect

        with preview_session() as call:
            capture_reconnect(ROOT, source, call, prepare)
        return
    if (ROOT / "browser-preview").is_file():
        from browser_preview import capture_browser_preview

        with preview_session() as call:
            return capture_browser_preview(ROOT, source, call, prepare)
    probe = Path("/fixture/settled-replay-browser.js").read_text().strip()
    if "captureRounds" in source:
        with preview_session() as call:
            sample_series(call, source, probe)
        return
    tab, path, state = prepare(preview, source)
    evidence, observed, _, _ = settled(preview, tab, path, probe, ROOT / "capture.png")
    record_capture(evidence["profile"], evidence["trace"], {**state, **observed}, source)


def send(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    message_id = request["id"]
    method = request["method"]
    try:
        if method == "initialize":
            result = {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": False},
                "authMethods": [],
                "agentInfo": {"name": "browser-capture-fixture", "version": "1"},
            }
        elif method == "session/new":
            result = {"sessionId": str(uuid.uuid4())}
        elif method in ("session/set_model", "session/set_mode", "session/close", "authenticate"):
            result = {}
        elif method == "session/prompt":
            reply = capture() or "Captured settled Replay."
            send({
                "method": "session/update",
                "params": {
                    "sessionId": request["params"]["sessionId"],
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": reply},
                    },
                },
            })
            result = {"stopReason": "end_turn"}
        else:
            raise ValueError(f"Unexpected ACP method {method}")
    except Exception:
        (ROOT / "provider-error.private").write_text(traceback.format_exc())
        send({"id": message_id, "error": {"code": -32603, "message": "Browser panel fixture failed"}})
    else:
        send({"id": message_id, "result": result})

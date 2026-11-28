from hashlib import file_digest
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import traceback
from urllib.parse import quote, urlsplit
import uuid


ROOT = Path(sys.argv[1])
ORIGIN = "http://127.0.0.1:47717"


def command(argv, **options):
    return subprocess.run(
        argv, text=True, capture_output=True, check=True, timeout=60, **options
    ).stdout


def preview(name, **params):
    argv = [os.environ["T3_ACP_MCP_NODE"]]
    if entry := os.environ.get("T3_ACP_MCP_ENTRYPOINT"):
        argv.append(entry)
    result = json.loads(command([*argv, "acp-mcp-call", name, "-"], input=json.dumps(params)))
    if result.get("isError") or "structuredContent" not in result:
        raise RuntimeError(f"{name} failed")
    return result["structuredContent"]


def pair(tab):
    output = command([ROOT / "runtime/t3", "pair", "--base-dir", ROOT / "state"])
    link = urlsplit(re.search(r"^Pairing URL: (.+)$", output, re.MULTILINE)[1])
    assert link.path == "/pair" and link.fragment.startswith("token=")
    preview("preview_navigate", **tab, url=f"{ORIGIN}/pair#{link.fragment}")
    expression = """(async () => {
        if (location.pathname === '/pair' || location.hash) return false;
        const auth = await (await fetch('/api/auth/session')).json();
        return auth.authenticated === true && auth.sessionMethod === 'browser-session-cookie';
    })()"""
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if preview("preview_evaluate", **tab, expression=expression)["value"]:
                return
        except subprocess.CalledProcessError as error:
            if "Execution context was destroyed" not in error.stderr:
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


def record_capture(profile, trace, state):
    inventory = json.loads(Path("/fixture/release-inventory.json").read_text())
    asset = next(
        item for item in inventory["githubRelease"]["assets"]
        if item["name"] == "t3-0.1.17-linux-arm64.tar.gz"
    )
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
        "sourceSha": inventory["incumbentSourceSha"],
        "client": state["browser"] + " through the Sail Browser panel",
        "server": "Sail v0.1.17 Linux arm64 CLI server",
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
        "packageSha256": asset["digest"].removeprefix("sha256:"),
        "captureRunId": name + "-" + ROOT.name,
    }
    state["captureRunId"] = receipt["captureRunId"]
    (ROOT / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (ROOT / "state.json").write_text(json.dumps(state, indent=2) + "\n")


def capture():
    descriptor = json.loads((ROOT / "descriptor.private.json").read_text())
    assert descriptor["serverVersion"] == "0.1.17"
    assert descriptor["orchestrationProtocolVersion"] == 2
    assert descriptor["databaseMigration"] == 118
    assert descriptor["platform"] == {"os": "linux", "arch": "arm64"}
    thread = Path("/thread-id").read_text().strip()
    path = f"/{descriptor['environmentId']}/{quote(thread, safe='')}"
    preview("preview_status")
    opened = preview("preview_open", open=False, reuseExistingTab=False)
    tab = {"tabId": opened["tabId"]}
    preview("preview_resize", **tab, mode="freeform", width=640, height=600)
    preview("preview_set_appearance", **tab, colorScheme="light")
    pair(tab)
    preview("preview_navigate", **tab, url=ORIGIN + path)
    preview("preview_wait_for", **tab, selector="main .chat-markdown-shiki pre code .line:first-child")
    preview("preview_wait_for", **tab, text="Showcase")
    preview("preview_act", **tab, action="press", key="Tab")
    preview("preview_act", **tab, action="hover", x=1, y=45)
    probe = Path("/fixture/settled-replay-browser.js").read_text().strip()
    evidence = preview("preview_evaluate", **tab, expression=probe)["value"]
    observed = preview(
        "preview_evaluate",
        **tab,
        expression="""(() => {
            const main = document.querySelector('main');
            return {
                pathname: location.pathname,
                browserPlatform: navigator.platform,
                availableModel: main.innerText.includes('Showcase') && !main.innerText.includes('Unavailable'),
                providerWarning: document.body.innerText.includes('could not create a test session'),
                table: [...main.querySelector('table').rows].map(row => [...row.cells].map(cell => cell.innerText.trim())),
            };
        })()""",
    )["value"]
    assert observed.pop("pathname") == path
    assert observed["availableModel"] and not observed["providerWarning"]
    assert observed["table"] == [
        ["Step", "Tool", "Result"],
        ["Read", "read", "1 file"],
        ["Edit", "edit", "+4 lines"],
        ["Test", "execute", "12 passed"],
    ]
    image = preview("preview_snapshot", **tab, save=True)
    shutil.copyfile(image["screenshotPath"], ROOT / "capture.png")
    state = {
        "platform": descriptor["platform"],
        "version": descriptor["serverVersion"],
        "protocol": descriptor["orchestrationProtocolVersion"],
        "databaseMigration": descriptor["databaseMigration"],
        "browser": chrome_identity(),
        "distribution": "Debian " + Path("/etc/debian_version").read_text().strip(),
        "systemFontPackage": " ".join(command(["dpkg-query", "-W", "fonts-dejavu-core"]).split()),
        "pairing": "browser-session-cookie",
        "openedExpectedThread": True,
        **observed,
    }
    record_capture(evidence["profile"], evidence["trace"], state)


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
            capture()
            send({
                "method": "session/update",
                "params": {
                    "sessionId": request["params"]["sessionId"],
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "Captured settled Replay."},
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

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import runpy
import shutil
import subprocess
import time
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import urlopen

from PIL import Image
from websocket import create_connection

HERE = Path(__file__).resolve().parent
MIGRATION = HERE.parent
VIEWPORT = {"width": 640, "height": 600, "scale": 2, "zoom": 1}
BROWSER = "153.8.0"
HOSTS = ("a", "head-a", "b", "head-b")
PROBE = (HERE / "settled-replay-browser.js").read_text().strip().removesuffix(";")
WebDriver = runpy.run_path(MIGRATION / "gpui/browser-verify.py")["WebDriver"]


def wait_http(url, child):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError("Fixture process exited before readiness")
        try:
            with urlopen(url, timeout=2) as response:
                return json.load(response)
        except (URLError, OSError):
            time.sleep(0.1)
    raise RuntimeError("Fixture never became ready")


def execute(args, env=None, cwd=None):
    return subprocess.check_output(args, env=env, cwd=cwd, text=True, timeout=55)


@contextmanager
def process(args, log, env=None):
    with (
        log.open("w") as output,
        subprocess.Popen(
            args,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
        ) as child,
    ):
        try:
            yield child
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def wait_page(driver, script):
    result = driver.script(
        "const done = arguments[arguments.length-1]; const end = performance.now() + 12000;"
        "function check() { const result = (() => {" + script + "})();"
        "if(result || performance.now() >= end) done(result); else requestAnimationFrame(check); } check();",
        asynchronous=True,
    )
    if not result:
        raise RuntimeError("Firefox never reached the required fixture state")
    return result


@contextmanager
def firefox(out, thread_id):
    endpoint = "http://127.0.0.1:4444"
    with process(
        ["geckodriver", "--host", "127.0.0.1", "--port", "4444", "--log", "error"],
        out / "driver.log",
    ) as gecko:
        wait_http(endpoint + "/status", gecko)
        driver = WebDriver(endpoint)
        caps = driver.start(
            {
                "browserName": "firefox",
                "webSocketUrl": True,
                "moz:firefoxOptions": {
                    "prefs": {
                        "intl.accept_languages": "en",
                        "layout.css.devPixelsPerPx": "2.0",
                        "accessibility.tabfocus": 7,
                        "browser.newtabpage.enabled": False,
                        "ui.systemUsesDarkTheme": 0,
                        "ui.prefersReducedMotion": 0,
                    }
                },
            }
        )
        try:
            assert caps["browserVersion"] == BROWSER
            driver.request(
                "POST",
                "/timeouts",
                {"pageLoad": 15000, "script": 16000, "implicit": 1000},
            )
            outer = driver.request("GET", "/window/rect")
            inner = driver.script("return {width:innerWidth,height:innerHeight};")
            driver.request(
                "POST",
                "/window/rect",
                {
                    "width": 640 + outer["width"] - inner["width"],
                    "height": 600 + outer["height"] - inner["height"],
                },
            )
            with closing(
                create_connection(
                    caps["webSocketUrl"], timeout=10, suppress_origin=True
                )
            ) as bidi:
                observer = (
                    (HERE / "firefox-thread-sync.js")
                    .read_text()
                    .strip()
                    .removeprefix("export default ")
                )
                function = f"() => ({observer})({json.dumps(thread_id)})"
                bidi.send(
                    json.dumps(
                        {
                            "id": 1,
                            "method": "script.addPreloadScript",
                            "params": {
                                "functionDeclaration": function,
                            },
                        }
                    )
                )
                result = json.loads(bidi.recv())
                assert "script" in result.get("result", {}), result
                yield driver
        finally:
            driver.request("DELETE", "")


@contextmanager
def installed_host(driver, name, index, state, args):
    released = name in ("a", "b")
    expected_version = "0.1.17" if released else "0.1.18"
    expected_migration = 118 if released else 119
    root = state / name
    for folder in (
        "home",
        "runtime",
        "state/userdata",
        "tmp",
        "config",
        "cache",
        "local-share",
    ):
        (root / folder).mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.seed, root / "state/userdata/statev2.sqlite")
    shutil.copyfile(args.settings, root / "state/userdata/settings.json")
    archive = args.incumbent_archive if released else args.candidate_archive
    execute(["tar", "-xzf", archive, "-C", root / "runtime"])
    (runtime,) = (root / "runtime").glob("t3-*")
    cli = runtime / "t3"
    env = os.environ | {
        "HOME": str(root / "home"),
        "TMPDIR": str(root / "tmp"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_DATA_HOME": str(root / "local-share"),
        "SAIL_HOME": str(root / "state"),
        "T3CODE_HOME": str(root / "state"),
        "T3CODE_DISABLE_AUTO_UPDATE": "true",
        "T3CODE_TELEMETRY_ENABLED": "false",
    }
    assert execute([cli, "--version"], env).strip() == f"t3 v{expected_version}"
    server_port = 47670 + index
    address = f"127.0.0.{11 + index}"
    origin = f"http://{address}:{server_port}"
    server_args = [
        cli,
        "serve",
        "--host",
        address,
        "--port",
        str(server_port),
        "--startup-pairing",
        "off",
    ]
    with process(server_args, args.out / f"{name}-server.log", env) as server:
        descriptor = wait_http(origin + "/.well-known/t3/environment", server)
        assert descriptor["serverVersion"] == expected_version
        assert descriptor["orchestrationProtocolVersion"] == 2
        assert descriptor["databaseMigration"] == expected_migration
        assert descriptor["platform"] == {"os": "linux", "arch": "arm64"}
        assert execute(
            [cli, "thread", "show", "--json", "--messages", "10", args.thread_id], env
        )
        output = execute([cli, "pair", "--base-dir", root / "state"], env)
        pair = urlsplit(re.search(r"^Pairing URL: (.+)$", output, re.MULTILINE)[1])
        assert pair.scheme == "http" and pair.path == "/pair" and pair.fragment
        try:
            driver.request(
                "POST",
                "/url",
                {"url": urlunsplit(pair._replace(netloc=f"{address}:{server_port}"))},
            )
        except RuntimeError:
            raise RuntimeError(
                "The isolated Firefox profile could not open its pairing link"
            ) from None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                authenticated = driver.script(
                    "const done=arguments[arguments.length-1];fetch('/api/auth/session')"
                    ".then(r=>r.json()).then(v=>done(v.authenticated===true),()=>done(false));",
                    asynchronous=True,
                )
            except RuntimeError as exc:
                if "Document was unloaded" not in str(exc):
                    raise
            else:
                if authenticated:
                    break
        else:
            raise RuntimeError("Firefox failed to establish its cookie session")
        url = f"{origin}/{descriptor['environmentId']}/{quote(args.thread_id, safe='')}"
        result = {
            "name": name,
            "browser": BROWSER,
            "serverVersion": expected_version,
            "migration": expected_migration,
            "sourceSha": args.incumbent_sha if released else args.candidate_sha,
        }
        yield url, result


def sampled(driver, url, label, iteration, out):
    execute(["xdotool", "mousemove", "1919", "1399"])
    before = time.monotonic_ns()
    driver.request("POST", "/url", {"url": url})
    navigated = time.monotonic_ns()
    try:
        wait_page(
            driver,
            "return window.__sailCaptureSync?.active"
            " && document.querySelector('main h2')?.textContent === 'Compatibility replay'"
            " && !!document.querySelector('main .chat-markdown-shiki pre code .line:first-child')"
            " && !document.querySelector('[data-composer-sync-status]');",
        )
    except RuntimeError as error:
        debug = driver.script("""return {title:document.querySelector("main h2")?.textContent,
            hasCode:!!document.querySelector("main .chat-markdown-shiki pre code"),
            sync:window.__sailCaptureSync, status:document.querySelector("[data-composer-sync-status]")?.textContent};""")
        raise RuntimeError(f"{label} round {iteration}: {debug}") from error
    sync = driver.script("return window.__sailCaptureSync")
    ready = time.monotonic_ns()
    driver.tap("\ue004")
    driver.request(
        "POST",
        "/actions",
        {
            "actions": [
                {
                    "type": "pointer",
                    "id": "mouse",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [
                        {
                            "type": "pointerMove",
                            "duration": 0,
                            "origin": "viewport",
                            "x": 1,
                            "y": 45,
                        }
                    ],
                }
            ]
        },
    )
    focused = time.monotonic_ns()
    layout = driver.script(
        """
      const done = arguments[arguments.length-1];
      const end = performance.now() + 8500;
      let previous = null;
      let identicalFrames = 0;
      function check(now) {
        const scroll = document.querySelector(".messages-timeline-scroll");
        const code = document.querySelector("main .chat-markdown-shiki pre");
        const status = document.querySelector("[data-composer-sync-status]");
        if (scroll && code && !status && window.__sailCaptureSync?.active) {
          scroll.scrollTo({top:scroll.scrollHeight, behavior:"instant"});
          const geometry = code.getBoundingClientRect();
          const meta = [...document.querySelectorAll('[aria-label="Reply to this response"]')]
            .map(button => getComputedStyle(button.closest(".transition-opacity") ?? button).opacity);
          const current = JSON.stringify([scroll.scrollHeight, scroll.clientHeight, scroll.scrollTop,
              geometry.x, geometry.y, geometry.width, geometry.height, meta]);
          identicalFrames = current === previous ? identicalFrames+1 : 0;
          if (identicalFrames >= 2) {
            done({status:"settled", scrollAtEnd:Math.abs(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop)<=1,
                  metaOpacity:meta, transcript:[geometry.x, geometry.y, geometry.width, geometry.height]});
            return;
          }
          previous = current;
        } else {
          previous = null;
          identicalFrames = 0;
        }
        if (now >= end) done(null); else requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    """,
        asynchronous=True,
    )
    assert layout and layout["scrollAtEnd"], (
        f"{label} {iteration}: transcript did not settle at end: {layout}"
    )
    settled = time.monotonic_ns()
    result = driver.script(
        "const done=arguments[arguments.length-1]; ("
        + PROBE
        + ").then(v=>done({value:v}),e=>done({error:e.message}));",
        asynchronous=True,
    )
    if "error" in result:
        debug = driver.script(
            'return {focus:document.activeElement?.getAttribute("aria-label"),title:document.querySelector("h2")?.textContent};'
        )
        raise RuntimeError(f"{label} round {iteration}: {result['error']}; {debug}")
    value = result["value"]
    assert value["profile"]["viewport"] == VIEWPORT
    value["trace"].append({"action": "settleTranscriptAtEnd", "observed": layout})
    traced = time.monotonic_ns()
    png = base64.b64decode(driver.request("GET", "/screenshot"), validate=True)
    captured = time.monotonic_ns()
    target = out / f"{iteration:02}-{label}.png"
    target.write_bytes(png)
    with Image.open(target) as image:
        assert image.size == (1280, 1200)
        rgba = hashlib.sha256(image.convert("RGBA").tobytes()).hexdigest()
    stages = [
        navigated - before,
        ready - navigated,
        focused - ready,
        settled - focused,
        traced - settled,
        captured - traced,
    ]
    return {
        "host": label,
        "round": iteration,
        "warmup": iteration < 2,
        "file": target.name,
        **value,
        "sync": sync,
        "stagesMs": dict(
            zip(
                (
                    "navigation",
                    "highlighting",
                    "focusAndPointer",
                    "stabilization",
                    "trace",
                    "screenshot",
                ),
                (v / 1e6 for v in stages),
            )
        ),
        "totalMs": (captured - before) / 1e6,
        "pngSha256": hashlib.sha256(png).hexdigest(),
        "rgbaSha256": rgba,
    }


def controls(driver):
    return driver.script("""return [...document.querySelectorAll("main button")].filter(b=>b.getClientRects().length)
       .map(button=>({name:button.getAttribute("aria-label")??button.innerText.trim(),pressed:button.getAttribute("aria-pressed")}))
       .filter(x=>/^(Enable Poteto mode for this session|Attach files|Showcase|Submit message|Open provider settings)$/.test(x.name));""")


def main():
    parser = argparse.ArgumentParser(
        description="Capture the paired Linux arm64 Firefox Replay fixture"
    )
    parser.add_argument("--incumbent-archive", required=True, type=Path)
    parser.add_argument("--candidate-archive", required=True, type=Path)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--seed", required=True, type=Path)
    parser.add_argument("--settings", required=True, type=Path)
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--rounds", type=int, default=24)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be positive")
    if not re.fullmatch(r"[0-9a-f]{40}", args.candidate_sha):
        parser.error("--candidate-sha must be a full Git commit SHA")
    args.incumbent_sha = json.loads((HERE / "release-inventory.json").read_text())[
        "incumbentSourceSha"
    ]
    args.out.mkdir()
    with (
        TemporaryDirectory(prefix="sail-firefox-capture-") as root,
        ExitStack() as stack,
    ):
        driver = stack.enter_context(firefox(args.out, args.thread_id))
        hosts = {
            label: stack.enter_context(
                installed_host(driver, label, index, Path(root), args)
            )
            for index, label in enumerate(HOSTS)
        }
        profiles = {}
        with (args.out / "samples.ndjson").open("w") as samples:
            for iteration in range(2 + args.rounds):
                rotation = (iteration - 2 if iteration >= 2 else iteration) % len(HOSTS)
                for label in HOSTS[rotation:] + HOSTS[:rotation]:
                    url, identity = hosts[label]
                    capture = sampled(driver, url, label, iteration, args.out)
                    profiles[label] = identity | {"controls": controls(driver)}
                    samples.write(json.dumps(capture, separators=(",", ":")) + "\n")
                    samples.flush()
                    print(label, iteration, round(capture["totalMs"], 2), flush=True)
        (args.out / "hosts.json").write_text(json.dumps(profiles, indent=2) + "\n")


if __name__ == "__main__":
    main()

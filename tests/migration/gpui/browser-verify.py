#!/usr/bin/env python3
import argparse
import base64
import json
import math
import struct
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen


ELEMENT = "element-6066-11e4-a52e-4f735466cecf"
TAB, SHIFT, LEFT = "\ue004", "\ue008", "\ue012"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

OBSERVE = """
const [probeRenderer, marker] = arguments;
const root = document.documentElement;
const canvas = document.querySelector('canvas');
const link = document.querySelector('a#incumbent[href]');
const viewport = window.visualViewport;
function visible(element) {
    if (!element || getComputedStyle(element).visibility !== 'visible') return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 ||
        rect.left >= innerWidth || rect.top >= innerHeight) return false;
    if (element.checkVisibility) {
        return element.checkVisibility({opacityProperty: true, contentVisibilityAuto: true});
    }
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
    }
    return true;
}
function renderer(canvas) {
    // getContext may claim an idle canvas. A new WebGL2 context has no bound VAO,
    // and a new WebGPU context has no configuration. GPUI's wgpu binds a VAO.
    const gl = canvas.getContext('webgl2');
    if (gl && !gl.isContextLost() && gl.getParameter(gl.VERTEX_ARRAY_BINDING) &&
        gl.drawingBufferWidth === canvas.width && gl.drawingBufferHeight === canvas.height) {
        return 'webgl';
    }
    const gpu = canvas.getContext('webgpu');
    return gpu?.getConfiguration?.() ? 'webgpu' : null;
}
const canvasRect = visible(canvas) ? canvas.getBoundingClientRect() : null;
return {
    url: location.href,
    responseStatus: performance.getEntriesByType('navigation')[0]?.responseStatus ?? null,
    userAgent: navigator.userAgent,
    fixture: Object.fromEntries(['status', 'graphics', 'focus', 'draft', 'selection',
        'scale', 'error'].map(name => [name, root.getAttribute('data-' + name)])),
    viewport: {width: innerWidth, height: innerHeight, devicePixelRatio,
        visualWidth: viewport?.width, visualHeight: viewport?.height},
    canvas: canvasRect ? {
        width: canvas.width, height: canvas.height,
        cssWidth: canvasRect.width, cssHeight: canvasRect.height,
    } : null,
    renderer: probeRenderer && root.dataset.status === 'ready' && canvasRect ? renderer(canvas) : null,
    incumbent: visible(link) ? {url: link.href, text: link.innerText.trim()} : null,
    hasFallbackLink: Boolean(link),
    incumbentMarkerVisible: Boolean(marker && marker !== root && marker !== document.body &&
        visible(marker)),
};
"""

WAIT_FOR_FIXTURE = """
const [expected, limit, done] = arguments;
const root = document.documentElement;
const observer = new MutationObserver(check);
const timer = setTimeout(() => finish(false), limit);
function finish(matched) {
    clearTimeout(timer);
    observer.disconnect();
    done(matched);
}
function check() {
    if (Object.entries(expected).every(([name, value]) =>
        root.getAttribute('data-' + name) === value)) finish(true);
    else if (root.dataset.status === 'failed') finish(false);
}
observer.observe(root, {attributes: true});
check();
"""

COMPARE_SCREENSHOTS = """
const [screenshots, done] = arguments;
async function pixels(png) {
    const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
    try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
    } finally {
        bitmap.close();
    }
}
Promise.all(screenshots.map(pixels)).then(([ready, typed, selected]) => {
    const differs = (before, after) => before.some((value, index) => value !== after[index]);
    done({readyToTyped: differs(ready, typed), typedToSelected: differs(typed, selected),
        readyToSelected: differs(ready, selected)});
}).catch(error => done({error: String(error)}));
"""


class WebDriver:
    def __init__(self, endpoint):
        self.endpoint = endpoint.rstrip("/")
        self.session_path = ""

    def request(self, method, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        request = Request(self.endpoint + self.session_path + path, data=data,
                          headers={"Content-Type": "application/json"}, method=method)
        try:
            with urlopen(request, timeout=65) as response:
                return json.load(response)["value"]
        except HTTPError as error:
            result = json.load(error)["value"]
            raise RuntimeError(f"{method} {path}: {result['error']}: {result['message']}") from error

    def start(self, capabilities):
        session = self.request("POST", "/session", {"capabilities": {"alwaysMatch": capabilities}})
        self.session_path = f"/session/{session['sessionId']}"
        return session["capabilities"]

    def script(self, script, *args, asynchronous=False):
        kind = "async" if asynchronous else "sync"
        return self.request("POST", f"/execute/{kind}", {"script": script, "args": args})

    def keys(self, *events):
        actions = [{"type": f"key{direction}", "value": key} for direction, key in events]
        self.request("POST", "/actions", {"actions": [{"id": "keyboard", "type": "key",
                                                       "actions": actions}]})

    def tap(self, *keys):
        self.keys(*((direction, key) for key in keys for direction in ("Down", "Up")))

    def find(self, selector):
        return self.request("POST", "/element", {"using": "css selector", "value": selector})[ELEMENT]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify(driver, args, record):
    def observe(action, *, probe_renderer=False, marker=None, **details):
        state = driver.script(OBSERVE, probe_renderer, marker)
        record["actions"].append({"action": action, **details, "observed": state})
        return state

    def wait(action, *, probe_renderer=False, **expected):
        expected = {"status": args.expect, **expected}
        matched = driver.script(WAIT_FOR_FIXTURE, expected, args.timeout * 1000, asynchronous=True)
        state = observe(action, probe_renderer=probe_renderer and matched, expected=expected)
        require(matched and all(state["fixture"][k] == v for k, v in expected.items()),
                f"{action} expected {expected}, observed {state['fixture']}")
        return state

    def screenshot(label, suffix=""):
        encoded = driver.request("GET", "/screenshot")
        png = base64.b64decode(encoded, validate=True)
        require(len(png) > 24 and png[:8] == PNG_MAGIC and png[12:16] == b"IHDR",
                "WebDriver did not return a PNG")
        path = args.out / f"{args.name}{suffix}.png"
        path.write_bytes(png)
        width, height = struct.unpack(">II", png[16:24])
        record["actions"].append({"action": label, "png": path.name,
                                  "pixels": {"width": width, "height": height}})
        return encoded, (width, height)

    driver.request("POST", "/timeouts", {"pageLoad": args.timeout * 1000,
                                         "script": (args.timeout + 2) * 1000,
                                         "implicit": args.timeout * 1000})
    if args.viewport:
        width, height = args.viewport
        outer = driver.request("GET", "/window/rect")
        inner = driver.script("return {width: innerWidth, height: innerHeight};")
        driver.request("POST", "/window/rect", {"width": width + outer["width"] - inner["width"],
                                               "height": height + outer["height"] - inner["height"]})
    record["actions"].append({"action": "Navigate", "url": args.url})
    driver.request("POST", "/url", {"url": args.url})
    if args.expect == "failed":
        state = wait("Start fixture", error="graphics")
    else:
        state = wait("Start fixture")
    viewport = state["viewport"]
    if args.viewport:
        require((viewport["width"], viewport["height"]) == args.viewport,
                f"Requested viewport {args.viewport}, observed {viewport}")
    if args.dpr is not None:
        require(viewport["devicePixelRatio"] == args.dpr,
                f"Requested device pixel ratio {args.dpr}, observed {viewport}")

    if args.expect == "failed":
        incumbent = state["incumbent"]
        require(incumbent and incumbent["text"], "Expected a visible, labeled a#incumbent[href]")
        href = incumbent["url"]
        require(urlsplit(href).scheme in ("http", "https"), f"Expected an HTTP(S) link, observed {href!r}")
        expected_url = driver.script("return new URL(arguments[0]).href;", args.incumbent_url)
        preview_entry = urlsplit(state["url"])._replace(query="", fragment="")
        for url in (href, expected_url):
            require(urlsplit(url)._replace(query="", fragment="") != preview_entry,
                    f"Incumbent entry points back to the GPUI preview: {url!r}")
        screenshot("Capture graphics fallback")
        link = driver.find("a#incumbent[href]")
        record["actions"].append({"action": "Click incumbent link", "url": href})
        driver.request("POST", f"/element/{link}/click", {})
        destination = observe("Open incumbent entry")
        require(destination["url"] == expected_url,
                f"Unexpected incumbent destination {destination['url']!r}")
        require(not destination["hasFallbackLink"], "Incumbent destination is another GPUI preview")
        status = destination["responseStatus"]
        require(not status or 200 <= status < 400, f"Incumbent navigation returned HTTP {status}")
        marker = driver.find(args.incumbent_selector)
        entry = observe("Confirm visible incumbent page marker", marker={ELEMENT: marker},
                        selector=args.incumbent_selector)
        require(entry["url"] == expected_url and entry["incumbentMarkerVisible"],
                f"Missing visible incumbent page marker {args.incumbent_selector!r} at {expected_url!r}")
        screenshot("Capture incumbent entry", "-incumbent")
        return

    project = wait("Confirm initial project focus", probe_renderer=True, focus="project",
                   graphics=args.backend)
    canvas = project["canvas"]
    require(canvas and all(value > 0 for value in canvas.values()), "Expected a visible GPUI canvas")
    actual = project["renderer"]
    record["actualGraphics"] = actual
    require(actual in ("webgpu", "webgl") and args.backend in ("auto", actual),
            f"Requested graphics backend {args.backend!r}, observed active canvas renderer {actual!r}")
    dpr = project["viewport"]["devicePixelRatio"]
    scale = project["fixture"]["scale"]
    require(math.isclose(float(scale or "nan"), dpr, rel_tol=1e-6),
            f"GPUI scale {scale!r} does not match browser device pixel ratio {dpr}")
    require(abs(canvas["width"] - canvas["cssWidth"] * dpr) <= 0.5 + 1e-6 and
            abs(canvas["height"] - canvas["cssHeight"] * dpr) <= 0.5 + 1e-6,
            f"Canvas backing dimensions do not match its CSS size at DPR {dpr}: {canvas}")
    ready, ready_size = screenshot("Capture ready fixture")

    driver.tap(TAB)
    composer = wait("Tab to GPUI composer", focus="composer")["fixture"]
    require(composer["draft"] == "" and composer["selection"] == "0:0",
            f"Expected an empty composer, observed {composer}")
    draft = "gpui"
    driver.tap(*draft)
    wait(f"Type {draft}", focus="composer", draft=draft, selection="4:4")
    typed, typed_size = screenshot("Capture typed draft", "-typed")
    driver.keys(("Down", SHIFT), ("Down", LEFT), ("Up", LEFT), ("Up", SHIFT))
    wait("Shift+ArrowLeft", focus="composer", draft=draft, selection="3:4")
    selected, selected_size = screenshot("Capture selected text", "-selection")
    require(ready_size == typed_size == selected_size, "Fixture screenshots have different dimensions")
    differences = driver.script(COMPARE_SCREENSHOTS, [ready, typed, selected], asynchronous=True)
    record["actions"].append({"action": "Compare decoded screenshot pixels", **differences})
    require("error" not in differences, f"Screenshot decoding failed: {differences.get('error')}")
    require(all(differences.values()), f"Fixture screenshots must differ in all three states: {differences}")


def parse_viewport(value):
    try:
        width, height = map(int, value.lower().split("x"))
        if width > 0 and height > 0:
            return width, height
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("expected WIDTHxHEIGHT in CSS pixels")


def main():
    parser = argparse.ArgumentParser(
        description="Capture and verify the GPUI WASM fixture with WebDriver.",
        epilog="Pixel qualification requires a reviewed visible baseline PNG and compare-pixels.py.",
    )
    parser.add_argument("url", help="Fixture URL, optionally with ?backend=webgpu or ?backend=webgl")
    parser.add_argument("--browser", required=True, choices=("chrome", "firefox", "safari"))
    parser.add_argument("--webdriver", required=True, help="Running W3C WebDriver endpoint URL")
    parser.add_argument("--out", required=True, type=Path, help="New evidence directory")
    parser.add_argument("--name", help="Screenshot and receipt basename, e.g. wasm-webgl")
    parser.add_argument("--expect", default="ready", choices=("ready", "failed"))
    parser.add_argument("--incumbent-url", help="Expected final HTTP(S) URL, required with --expect failed")
    parser.add_argument("--incumbent-selector", help="Visible, page-specific CSS marker required with --expect failed")
    parser.add_argument("--viewport", type=parse_viewport, help="Require this WIDTHxHEIGHT in CSS pixels")
    parser.add_argument("--dpr", type=float, help="Require this device pixel ratio")
    parser.add_argument("--capabilities", type=json.loads, default={}, help="Extra W3C capabilities as JSON")
    parser.add_argument("--timeout", default=30, type=int, help="Seconds allowed per navigation or state wait")
    args = parser.parse_args()

    if args.expect == "failed":
        if not args.incumbent_url or not (args.incumbent_selector or "").strip():
            parser.error("--expect failed requires --incumbent-url and a page-specific --incumbent-selector")
        incumbent = urlsplit(args.incumbent_url)
        if incumbent.scheme not in ("http", "https") or not incumbent.hostname:
            parser.error("--incumbent-url must be an absolute HTTP(S) URL")

    requested = parse_qs(urlsplit(args.url).query, keep_blank_values=True).get("backend", ["auto"])
    if len(requested) != 1 or requested[0] not in ("auto", "webgpu", "webgl"):
        parser.error("backend must be auto, webgpu, or webgl")
    args.backend = requested[0]
    args.name = args.name or ("wasm-chromium" if args.browser == "chrome" else f"wasm-{args.browser}")
    if not isinstance(args.capabilities, dict) or not 1 <= args.timeout <= 60:
        parser.error("capabilities must be an object and timeout must be between 1 and 60 seconds")
    if Path(args.name).name != args.name or args.name in (".", ".."):
        parser.error("name must be a basename")

    try:
        args.out.mkdir(parents=True)
    except OSError as error:
        parser.exit(2, f"{error}\n")
    requested_capabilities = {**args.capabilities, "browserName": args.browser}
    record = {"url": args.url, "expectedStatus": args.expect, "requestedGraphics": args.backend,
              "actualGraphics": None, "requestedViewport": args.viewport, "requestedDpr": args.dpr,
              "actions": []}
    driver = WebDriver(args.webdriver)
    try:
        capabilities = driver.start(requested_capabilities)
        record["browser"] = {key: capabilities.get(key) for key in
                             ("browserName", "browserVersion", "platformName")}
        require(record["browser"]["browserVersion"], "WebDriver did not report a browser version")
        verify(driver, args, record)
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        record["error"] = str(error)
    finally:
        if driver.session_path:
            try:
                driver.request("DELETE", "")
            except (RuntimeError, OSError, ValueError, KeyError) as error:
                record["cleanupError"] = str(error)
        record["passed"] = "error" not in record and "cleanupError" not in record
        receipt = args.out / f"{args.name}.json"
        receipt.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if not record["passed"]:
        print(record.get("error", record.get("cleanupError")), file=sys.stderr)
    print(receipt)
    return 0 if record["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Verify a fresh sail-client in an X11 session with AT-SPI already enabled."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time

TITLE = "Sail GPUI preview"
PROJECT = "Release checklist"
COMPOSER = "Message"
INPUT = "sail"


class DriverError(Exception):
    pass


class Evidence:
    def __init__(self, executable):
        self.start = time.monotonic()
        self.result = {
            "schema_version": 1,
            "platform": "linux",
            "accessibility": "AT-SPI",
            "pid": None,
            "executable": str(executable),
            "title": TITLE,
            "status": "pass",
            "steps": [],
            "gaps": [],
        }

    def record(self, step, **details):
        elapsed_ms = int((time.monotonic() - self.start) * 1_000)
        self.result["steps"].append(dict(step=step, elapsed_ms=elapsed_ms, **details))

    def write(self, output):
        data = json.dumps(self.result, indent=2, sort_keys=True).encode() + b"\n"
        write_atomic(output / "native-evidence.json", data)


def write_atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        pending = Path(temporary.name)
        try:
            temporary.write(data)
            temporary.close()
            pending.replace(path)
        finally:
            pending.unlink(missing_ok=True)


def wait_for(description, probe):
    deadline = time.monotonic() + 6
    while True:
        found = probe()
        if found is not None:
            return found
        if time.monotonic() >= deadline:
            raise DriverError(f"Timed out waiting for {description}")
        time.sleep(0.05)


def command(*args, check=True, input=None):
    result = subprocess.run(args, input=input, capture_output=True, check=False, timeout=6)
    if check and result.returncode:
        stderr = result.stderr.decode(errors="replace").strip()
        raise DriverError(f"{args[0]} {args[1]} failed ({result.returncode}): {stderr}")
    return result


def validate_executable(path):
    try:
        executable = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise DriverError(f"Could not resolve fixture executable {path}: {error}") from error
    if executable.name != "sail-client" or not executable.is_file() or not os.access(executable, os.X_OK):
        raise DriverError(f"Expected an executable sail-client file, got {path}")
    return executable


@contextmanager
def launch_fixture(executable):
    process = subprocess.Popen(
        [str(executable)], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        yield process
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def require_clean_exit(process, evidence):
    try:
        code = process.wait(timeout=6)
    except subprocess.TimeoutExpired:
        raise DriverError("Timed out waiting for the original sail-client process to exit") from None
    if code < 0:
        evidence.record("process_exited", pid=process.pid, signal=-code)
        raise DriverError(f"Original sail-client terminated by signal {-code}")
    evidence.record("process_exited", pid=process.pid, exit_code=code)
    if code != 0:
        raise DriverError(f"Original sail-client exited with status {code}")


def find_x11_window(pid):
    result = command(
        "xdotool", "search", "--onlyvisible", "--all",
        "--pid", str(pid), "--name", f"^{TITLE}$", check=False,
    )
    if result.returncode and result.stderr:
        raise DriverError(result.stderr.decode(errors="replace").strip())
    windows = result.stdout.decode().split()
    if len(windows) > 1:
        raise DriverError("Multiple visible X11 fixture windows")
    return windows[0] if windows else None


def png_dimensions(data):
    if (
        len(data) < 45
        or data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        or data[-12:] != b"\x00\x00\x00\x00IEND\xaeB\x60\x82"
    ):
        raise DriverError("Window capture did not return a complete PNG")
    width, height = struct.unpack(">II", data[16:24])
    if not width or not height:
        raise DriverError("Window capture returned an empty image")
    return width, height


def children(node):
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            yield child


def descendants(root):
    pending = [root]
    for node in pending:
        pending.extend(children(node))
        if len(pending) > 1_000:
            raise DriverError("The fixture AT-SPI tree exceeded 1,000 elements")
        yield node


class Fixture:
    def __init__(self, process, executable, atspi, glib):
        self.process = process
        self.pid = process.pid
        self.atspi = atspi
        self.glib = glib
        self.require_running()
        try:
            running_executable = Path(os.readlink(f"/proc/{self.pid}/exe"))
        except FileNotFoundError:
            self.require_running()
            raise
        if running_executable != executable:
            raise DriverError(f"PID {self.pid} is running {running_executable}, expected {executable}")
        self.xid = wait_for("the visible X11 fixture window", self.visible_window)
        self.window = wait_for(f"the AT-SPI fixture window for PID {self.pid}", self.find_accessible_window)

    def require_running(self):
        code = self.process.poll()
        if code is not None:
            raise DriverError(f"sail-client PID {self.pid} exited (return code {code})")

    def visible_window(self):
        self.require_running()
        return find_x11_window(self.pid)

    def find_accessible_window(self):
        self.require_window()
        desktop = self.atspi.get_desktop(0)
        if desktop is None:
            raise DriverError("AT-SPI desktop unavailable. Use an X11 session with AT-SPI already enabled.")
        desktop.clear_cache()
        matches = []
        for app in children(desktop):
            try:
                if app.get_process_id() != self.pid:
                    continue
            except self.glib.Error:
                continue
            matches.extend(
                node for node in children(app)
                if node.get_role() == self.atspi.Role.FRAME and node.get_name() == TITLE
            )
        if len(matches) > 1:
            raise DriverError("Multiple AT-SPI fixture windows")
        return matches[0] if matches else None

    def controls(self):
        def probe():
            self.require_window()
            button = getattr(self.atspi.Role, "BUTTON", None) or self.atspi.Role.PUSH_BUTTON
            wanted = {PROJECT: button, COMPOSER: self.atspi.Role.ENTRY}
            found = {}
            for node in descendants(self.window):
                name = node.get_name()
                if name not in wanted or node.get_role() != wanted[name]:
                    continue
                if name in found:
                    raise DriverError(f"Multiple fixture AT-SPI controls named {name}")
                found[name] = node
            project = found.get(PROJECT)
            if project is not None and COMPOSER in found and self.focused(project):
                return project, found[COMPOSER]
            return None

        return wait_for("a focused project button and Message entry through AT-SPI", probe)

    def focused(self, node):
        node.clear_cache()
        return node.get_state_set().contains(self.atspi.StateType.FOCUSED)

    def require_window(self):
        if self.visible_window() != self.xid:
            raise DriverError("The verified sail-client X11 window changed")

    def send_keys(self, *keys):
        self.require_window()
        focus = command("xdotool", "getwindowfocus", "-f").stdout.decode().strip()
        if focus != self.xid:
            raise DriverError("The verified sail-client window must own X11 keyboard focus")
        # --window sends XSendEvent directly to the verified XID even if the
        # window manager changes focus between the check and the send.
        command("xdotool", "key", "--window", self.xid, *keys)

    def capture(self, name, output, evidence, *, selected=False):
        snapshot = None

        def rendered_fixture():
            nonlocal snapshot
            self.require_window()
            png = command("import", "-silent", "-window", self.xid, "png:-").stdout
            width, height = png_dimensions(png)
            snapshot = png, width, height
            pixels = command("convert", "png:-", "-alpha", "off", "-depth", "8", "rgb:-", input=png).stdout
            sidebar, transcript, selection = 0, 0, 0
            for index in range(0, len(pixels), 3):
                pixel = pixels[index:index + 3]
                sidebar += pixel == b"\x20\x20\x24"
                transcript += pixel == b"\x18\x18\x1b"
                selection += pixel == b"\x43\x5d\x87"
            if min(sidebar, transcript) >= width * height // 20 and (selection >= 16) == selected:
                return True
            return None

        try:
            state = "with a visible selection" if selected else "with an empty selection"
            wait_for(f"{name} to show the rendered fixture {state}", rendered_fixture)
        finally:
            if snapshot:
                png, width, height = snapshot
                write_atomic(output / name, png)
                evidence.record("screenshot", file=name, window_id=int(self.xid), width=width, height=height)


def verify_text(description, read, evidence):
    observed = None

    def probe():
        nonlocal observed
        observed = read()
        return observed if observed == INPUT else None

    try:
        wait_for(description, probe)
    except DriverError:
        evidence.record(description, expected=INPUT, observed=observed)
        raise DriverError(f"Expected {description} {INPUT!r}, got {observed!r}") from None
    evidence.record(description, expected=INPUT, observed=observed)


def selected_text(interface, text):
    if not interface.get_n_selections(text):
        return ""
    selected = interface.get_selection(text, 0)
    return interface.get_text(text, selected.start_offset, selected.end_offset)


def verify(executable, output, reopen, evidence):
    if not os.environ.get("DISPLAY"):
        raise DriverError("Set DISPLAY to the isolated fixture's X11 display")
    for name in ("xdotool", "import", "convert", "wmctrl"):
        if shutil.which(name) is None:
            raise DriverError(f"Missing {name} in PATH")
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, GLib
    except (ImportError, ValueError) as error:
        raise DriverError("Use Python with PyGObject and the Atspi 2.0 typelib") from error

    if Atspi.init() != 0:
        raise DriverError("AT-SPI initialization failed")
    Atspi.set_timeout(500, 1_000)
    with launch_fixture(executable) as process:
        evidence.result["pid"] = process.pid
        evidence.record("process_launched", pid=process.pid)
        fixture = Fixture(process, executable, Atspi, GLib)
        verify_window(fixture, output, evidence)
        fixture.require_window()
        command("wmctrl", "-i", "-c", f"0x{int(fixture.xid):x}")
        evidence.record("window_close", pid=process.pid, action="_NET_CLOSE_WINDOW")
        require_clean_exit(process, evidence)

    if reopen:
        with launch_fixture(executable) as process:
            evidence.record("process_relaunched", pid=process.pid)
            restarted = Fixture(process, executable, Atspi, GLib)
            restarted.controls()
            evidence.record("window_reopened", pid=process.pid, title=TITLE, composer=COMPOSER)
            restarted.capture("gpui-reopen.png", output, evidence)


def verify_window(fixture, output, evidence):
    project, composer = fixture.controls()
    evidence.record("initial_focus", role=project.get_role_name(), name=project.get_name())
    evidence.record("composer", role=composer.get_role_name(), name=composer.get_name())
    text = composer.get_text_iface()
    text_interface = fixture.atspi.Text
    if text is not None and text_interface.get_text(text, 0, -1):
        raise DriverError("Expected a fresh composer with an empty value")
    fixture.capture("gpui-native.png", output, evidence)

    fixture.send_keys("Tab")
    evidence.record("keyboard", key="Tab")
    wait_for("Tab to focus Message", lambda: fixture.focused(composer) or None)
    evidence.record("tab_focus", name=COMPOSER)
    fixture.send_keys(*INPUT)
    evidence.record("keyboard", text=INPUT)
    if text is not None:
        verify_text("value", lambda: text_interface.get_text(text, 0, -1), evidence)
    fixture.send_keys(*(["Shift+Left"] * len(INPUT)))
    evidence.record("keyboard", key="Shift+Left", repeat=len(INPUT))
    if text is not None:
        verify_text("selection", lambda: selected_text(text_interface, text), evidence)
    else:
        for description in ("value", "selection"):
            evidence.result["gaps"].append(f"AT-SPI Text did not expose {description}")
            evidence.record(description, expected=INPUT, observed=None)
    fixture.capture("gpui-input.png", output, evidence, selected=True)
    evidence.record("visible_composer_selection")


    fixture.send_keys("Shift+Tab")
    evidence.record("keyboard", key="Shift+Tab")
    wait_for("Shift+Tab to restore project focus", lambda: fixture.focused(project) or None)
    fixture.require_window()
    component = composer.get_component_iface()
    if component is None or not component.grab_focus():
        raise DriverError("AT-SPI Component.GrabFocus failed for Message")
    wait_for("AT-SPI focus on Message", lambda: fixture.focused(composer) or None)
    evidence.record("accessibility_focus", action="Component.GrabFocus", name=COMPOSER)
    fixture.capture("gpui-a11y.png", output, evidence, selected=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path, help="Path to the sail-client executable")
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--close-reopen", action="store_true", help="Relaunch after verifying a clean window close")
    args = parser.parse_args()
    try:
        executable = validate_executable(args.executable)
        args.output_dir.mkdir(parents=True)
    except FileExistsError:
        print(f"Output directory must be new: {args.output_dir}", file=sys.stderr)
        return 1
    except (DriverError, OSError) as error:
        print(error, file=sys.stderr)
        return 1

    evidence = Evidence(executable)
    status = 0
    try:
        verify(executable, args.output_dir, args.close_reopen, evidence)
        if evidence.result["gaps"]:
            evidence.result["status"] = "partial"
            status = 2
    except Exception as error:
        evidence.result.update(status="fail", error=str(error))
        print(error, file=sys.stderr)
        status = 1
    try:
        evidence.write(args.output_dir)
    except OSError as error:
        print(f"Could not write evidence: {error}", file=sys.stderr)
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main())

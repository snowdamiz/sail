#!/usr/bin/env python3
"""Capture the pinned macOS release's headless launcher and server contract."""

import argparse
import hashlib
import hmac
import http.client
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import platform
import plistlib
import secrets
import shlex
import socket
import stat
import subprocess
import tempfile
import time
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile


HERE = Path(__file__).resolve().parent
DESCRIPTOR = "/.well-known/t3/environment"
BROWSER_SESSION = "/api/auth/browser-session"
SESSION = "/api/auth/session"
READINESS = "/.well-known/t3/desktop-readiness?challenge=p01"
HOST = "127.0.0.1"
LABEL = "P01 launcher fixture"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(stream):
    return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_artifact(fixture, inventory):
    asset = next(
        asset for asset in inventory["githubRelease"]["assets"]
        if asset["name"] == "Sail-0.1.17-arm64.zip"
    )
    archive = fixture / asset["name"]
    app = fixture / "installer-home/Applications/Sail.app"
    with archive.open("rb") as file:
        require("sha256:" + digest(file) == asset["digest"], "Release archive digest mismatch")
    require(app.is_dir() and app.resolve() == app, "Expected the installed app directory")
    with ZipFile(archive) as zipped:
        members = {}
        for member in zipped.infolist():
            relative = Path(*Path(member.filename).parts[1:])
            if relative != Path("."):
                members[relative] = member
        require(
            set(members) == {path.relative_to(app) for path in app.rglob("*")},
            "Installed app and archive have different entries",
        )
        for relative, member in members.items():
            path = app / relative
            mode = member.external_attr >> 16
            require(stat.S_IFMT(path.lstat().st_mode) == stat.S_IFMT(mode),
                    f"Installed app entry type differs: {relative}")
            if stat.S_ISREG(mode):
                with zipped.open(member) as released, path.open("rb") as installed:
                    require(digest(released) == digest(installed),
                            f"Installed app entry differs: {relative}")
            if stat.S_ISLNK(mode):
                require(os.fsencode(os.readlink(path)) == zipped.read(member),
                        f"Installed app symlink differs: {relative}")

    launcher = fixture / "installer-home/bin/sail"
    require(launcher.is_file() and not launcher.is_symlink(), "Expected the installed launcher file")
    shebang, invocation = launcher.read_text().splitlines()
    exec_word, opener, target, args_flag, args_word = shlex.split(invocation)
    require(
        shebang == "#!/bin/sh"
        and (exec_word, opener, args_flag, args_word) == ("exec", "/usr/bin/open", "--args", "$@")
        and Path(target).is_absolute()
        and Path(target).resolve() == app
        and invocation.endswith(' --args "$@"')
        and os.access(launcher, os.X_OK),
        "Installed macOS launcher differs from the generated open wrapper",
    )
    with (app / "Contents/Info.plist").open("rb") as file:
        plist = plistlib.load(file)
    command = [
        str(app / "Contents/MacOS" / plist["CFBundleExecutable"]),
        str(app / "Contents/Resources/app.asar/apps/server/dist/bin.mjs"),
    ]
    return command, {
        "tag": inventory["githubRelease"]["tag_name"],
        "sourceSha": inventory["incumbentSourceSha"],
        "assetId": asset["id"],
        "archive": asset["name"],
        "archiveDigest": asset["digest"],
        "installedAppEntriesMatched": len(members),
        "bundleVersion": plist["CFBundleShortVersionString"],
        "serverCommand": [str(Path(command[0]).relative_to(app)), str(Path(command[1]).relative_to(app))],
        "installedLauncherInspection": 'exec /usr/bin/open "$APP" --args "$@"',
    }


def cli(command, env, cwd):
    result = subprocess.run(command, env=env, cwd=cwd, capture_output=True, timeout=30, check=False)
    require(result.returncode == 0, f"CLI command failed with exit {result.returncode}")
    return result.stdout.decode()


def call(port, path, payload=None, headers=None):
    connection = http.client.HTTPConnection(HOST, port, timeout=5)
    try:
        request_headers = {} if headers is None else dict(headers)
        if payload is None:
            connection.request("GET", path, headers=request_headers)
        else:
            request_headers["Content-Type"] = "application/json"
            connection.request("POST", path, json.dumps(payload), request_headers)
        response = connection.getresponse()
        return response.status, response.read(), response.headers.get_all("Set-Cookie", [])
    finally:
        connection.close()


def await_runtime(path, process, headless_log):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        require(process.poll() is None, f"Server exited before readiness ({process.returncode})")
        startup = b""
        if headless_log is not None:
            fd = headless_log.fileno()
            startup = os.pread(fd, os.fstat(fd).st_size, 0)
        # The serve startup presentation runs independently of runtime record publication.
        if path.is_file() and (headless_log is None or b"T3 Code server is ready." in startup):
            return json.loads(path.read_text()), startup
        time.sleep(0.05)
    raise RuntimeError("Server did not publish its scratch runtime record and readiness")


def public_descriptor(body, base):
    descriptor = json.loads(body)
    require(descriptor.pop("environmentId") == (base / "userdata/environment-id").read_text().strip(),
            "Descriptor identity does not match selected home")
    require(descriptor["label"] == LABEL, "Unexpected environment label")
    host = descriptor["platform"]
    require(host["os"] == "darwin" and host["arch"] == "arm64", "Unexpected server platform")
    capabilities = descriptor["capabilities"]
    for key, value in capabilities.items():
        if type(value) is bool:
            continue
        if key == "fileAttachments":
            require(set(value) == {"maxUploadBytes"} and type(value["maxUploadBytes"]) is int,
                    "Unexpected attachment capability")
        elif key == "serverSelfUpdate":
            require(value in ("boot-service", "respawn", "desktop-managed"), "Unexpected update mode")
        else:
            raise RuntimeError("Unexpected non-boolean capability needs a receipt projection")
    require(type(descriptor["databaseMigration"]) is int, "Unexpected database migration field")
    return {
        "environmentIdMatchesSelectedHome": True,
        "label": LABEL,
        "platform": {
            "os": host["os"],
            "arch": host["arch"],
            **({"machine": host["machine"]} if host.get("machine") in (
                "server", "cloud", "linux", "desktop", "laptop", "mac-mini", "mac-studio"
            ) else {}),
        },
        "serverVersion": descriptor["serverVersion"],
        "orchestrationProtocolVersion": descriptor["orchestrationProtocolVersion"],
        "databaseMigration": descriptor["databaseMigration"],
        "capabilities": capabilities,
    }


def pair_credential(output, port):
    token_line = next((line for line in output.splitlines() if line.startswith("Pairing URL: ")), "")
    require(token_line, "Expected a pairing URL")
    url = urlsplit(token_line.removeprefix("Pairing URL: "))
    require((url.scheme, url.netloc, url.path, url.query) == ("http", f"{HOST}:{port}", "/pair", ""),
            "Pairing URL does not target the scratch listener")
    fragment = parse_qs(url.fragment)
    require(set(fragment) == {"token"} and len(fragment["token"]) == 1,
            "Pairing URL has an unexpected fragment")
    return fragment["token"][0]


def redeem(port, credential, one_time):
    payload = {"credential": credential}
    status, body, cookie_headers = call(port, BROWSER_SESSION, payload)
    session = json.loads(body)
    require(status == 200 and session["authenticated"] is True
            and session["sessionMethod"] == "browser-session-cookie",
            f"Browser session was not issued as expected (HTTP {status})")
    cookies = SimpleCookie()
    for header in cookie_headers:
        cookies.load(header)
    cookie = "; ".join(f"{name}={value.coded_value}" for name, value in cookies.items() if value.value)
    require(cookie, "Browser session response did not set a session cookie")

    anonymous_status, anonymous_body, _ = call(port, SESSION)
    require(anonymous_status == 200 and json.loads(anonymous_body).get("authenticated") is False,
            "Session endpoint did not distinguish the anonymous request")
    session_status, session_body, _ = call(port, SESSION, headers={"Cookie": cookie})
    authenticated = json.loads(session_body)
    require(session_status == 200 and authenticated.get("authenticated") is True
            and authenticated.get("sessionMethod") == session["sessionMethod"],
            "Browser session cookie did not authenticate a follow-up request")
    result = {"path": BROWSER_SESSION, "status": status, "sessionMethod": session["sessionMethod"],
              "cookieCheck": {"path": SESSION, "anonymousAuthenticated": False,
                              "authenticated": True, "status": session_status}}
    if one_time:
        reused, _, _ = call(port, BROWSER_SESSION, payload)
        require(reused == 401, "A consumed pairing credential was not rejected")
        result["reuseStatus"] = reused
    return result


def probe(command, scratch, spec):
    name, args, home_env, selected_home, pairing = spec
    case = scratch / name
    case.mkdir()
    for directory in ("home", "tmp", "cwd", "config", "cache", "data", "state"):
        (case / directory).mkdir()
    env = {
        "HOME": str(case / "home"),
        "TMPDIR": str(case / "tmp"),
        "XDG_CONFIG_HOME": str(case / "config"),
        "XDG_CACHE_HOME": str(case / "cache"),
        "XDG_DATA_HOME": str(case / "data"),
        "XDG_STATE_HOME": str(case / "state"),
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "ELECTRON_RUN_AS_NODE": "1",
        "T3CODE_ENVIRONMENT_LABEL": LABEL,
        "T3CODE_TELEMETRY_ENABLED": "false",
        "T3CODE_DISABLE_AUTO_UPDATE": "1",
    }
    env.update({key: str(case / value) for key, value in home_env.items()})
    with socket.socket() as listener:
        listener.bind((HOST, 0))
        port = listener.getsockname()[1]

    base = case / selected_home
    runtime_path = base / "userdata/server-runtime.json"
    cwd = case / "cwd"
    desktop = "--bootstrap-fd" in args
    headless = args[0] == "serve"
    envelope = None
    readiness_secret = None
    if desktop:
        readiness_secret = secrets.token_hex(32)
        envelope = {
            "mode": "desktop",
            "host": HOST,
            "port": port,
            "noBrowser": True,
            "t3Home": str(base),
            "desktopBootstrapToken": secrets.token_hex(32),
            "desktopReadinessSecret": readiness_secret,
            "shellEnvironmentPrepared": True,
            "tailscaleServeEnabled": False,
            "tailscaleServePort": 443,
        }
        if name == "desktop-fd3-invalid":
            del envelope["mode"]
        # Duplicate the parent's pipe onto fd 3 and exec so runtime PID verification stays exact.
        argv = ["/bin/sh", "-c", 'exec 3<&0; exec "$@" </dev/null', "fd3", *command, *args]
    else:
        args = [*args, "--host", HOST, "--port", "$PORT"]
        argv = [*command, *(arg.replace("$CASE", str(case)).replace("$PORT", str(port)) for arg in args)]

    result = {"case": name, "arguments": args, "homeEnvironment": home_env}
    with tempfile.TemporaryFile(dir=case) as log:
        process = subprocess.Popen(
            argv, env=env, cwd=cwd, stdout=log, stderr=log,
            stdin=subprocess.PIPE if desktop else subprocess.DEVNULL,
        )
        try:
            if desktop:
                with process.stdin as pipe:
                    pipe.write((json.dumps(envelope) + "\n").encode())
            if name == "desktop-fd3-invalid":
                exit_code = process.wait(timeout=30)
                log.seek(0)
                require(exit_code != 0 and b"Failed to decode bootstrap envelope" in log.read(),
                        "Malformed desktop envelope was not rejected for decoding")
                require(not runtime_path.exists(), "Malformed envelope published a runtime record")
                return {**result, "omittedBootstrapKey": "mode", "exitCode": exit_code,
                        "bootstrapDecodeError": True, "runtimeRecordCreated": False}

            record, startup_output = await_runtime(runtime_path, process, log if headless else None)
            require(record["pid"] == process.pid and record["origin"] == f"http://{HOST}:{port}"
                    and record["host"] == HOST and record["port"] == port,
                    "Scratch runtime record does not match the owned loopback process")
            status, body, _ = call(port, DESCRIPTOR)
            require(status == 200, "Environment descriptor unavailable")
            descriptor = public_descriptor(body, base)
            require(descriptor["serverVersion"] == record["serverVersion"] == "0.1.17"
                    and descriptor["orchestrationProtocolVersion"] == 2, "Release or protocol mismatch")
            require((base / "userdata/statev2.sqlite").is_file(), "Selected home has no database")
            require(not any((case / other / "userdata/server-runtime.json").exists()
                            for other in {*home_env.values(), "home/.sail"} - {selected_home}),
                    "A competing home published a runtime record")
            result.update({
                "selectedHome": selected_home,
                "runtime": {"version": record["version"], "bindHost": HOST, "pidMatchesChild": True,
                            "database": "userdata/statev2.sqlite"},
                "environmentDescriptor": {"path": DESCRIPTOR, "status": status, "body": descriptor},
            })

            if desktop:
                status, proof, _ = call(port, READINESS)
                expected = hmac.digest(readiness_secret.encode(), b"t3-desktop-readiness:p01", "sha256")
                require(status == 200 and hmac.compare_digest(proof.strip(), expected.hex().encode()),
                        "Desktop backend did not prove receipt of the fd 3 envelope")
                result["bootstrap"] = {
                    "fd": 3,
                    "encoding": "newline-delimited JSON",
                    "envelope": {
                        **envelope,
                        "port": "$PORT",
                        "t3Home": "$SELECTED_HOME",
                        "desktopBootstrapToken": "[redacted]",
                        "desktopReadinessSecret": "[redacted]",
                    },
                    "readinessPath": READINESS,
                    "readinessStatus": status,
                    "readinessProofVerified": True,
                }
                result["browserSession"] = redeem(port, envelope["desktopBootstrapToken"], False)
            if pairing == "cli":
                path = "/ws?orchestrationProtocol=1"
                status, body, _ = call(port, path)
                rejection = json.loads(body)
                require(status == 426
                        and rejection["code"] == "orchestration_protocol_incompatible"
                        and rejection["orchestrationProtocolVersion"] == 2,
                        "Protocol 1 was not rejected as expected")
                result["protocolRejection"] = {"path": path, "status": status, "body": {
                    "code": rejection["code"],
                    "orchestrationProtocolVersion": rejection["orchestrationProtocolVersion"],
                }}
                output = cli([*command, "pair", "--base-dir", str(base)], env, cwd)
                result["pair"] = {"command": "pair --base-dir $SELECTED_HOME", "exitCode": 0,
                                  "url": "http://127.0.0.1:$PORT/pair#token=[redacted]",
                                  "browserSession": redeem(port, pair_credential(output, port), True)}
            if pairing == "startup":
                result["startupPairing"] = {
                    "headlessReadyPrinted": True,
                    "url": "http://127.0.0.1:$PORT/pair#token=[redacted]",
                    "browserSession": redeem(port, pair_credential(startup_output.decode(), port), True),
                }
            require(process.poll() is None, "Server exited before the shutdown probe")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise RuntimeError("Owned server did not stop on SIGTERM") from None
        if headless and pairing != "startup":
            log.seek(0)
            startup_log = log.read()
            require(b"T3 Code server is ready." in startup_log and b"Pairing URL: " not in startup_log,
                    "serve --startup-pairing off emitted unexpected startup output")
            result["startupPairing"] = {"headlessReadyPrinted": True, "pairingUrlPrinted": False}

    require(not runtime_path.exists(), "Server left its runtime record after SIGTERM")
    with socket.socket() as client:
        client.settimeout(1)
        require(client.connect_ex((HOST, port)) != 0, "Listener remains after server shutdown")
    result["stop"] = {"signal": "SIGTERM", "exitCode": process.returncode,
                      "runtimeRecordRemoved": True, "listenerClosed": True}
    return result


def capture(fixture):
    require(platform.system() == "Darwin" and platform.machine() == "arm64", "Requires macOS arm64")
    inventory = json.loads((HERE.parent / "release-inventory.json").read_text())
    command, artifact = verify_artifact(fixture, inventory)
    cases = [
        ("serve-explicit", ["serve", "--base-dir", "$CASE/explicit", "--startup-pairing", "off"],
         {"SAIL_HOME": "sail", "T3CODE_HOME": "legacy"}, "explicit", "cli"),
        ("default-command", ["--no-browser", "--no-auto-bootstrap-project-from-cwd", "--startup-pairing", "off"],
         {"SAIL_HOME": "sail", "T3CODE_HOME": "legacy"}, "sail", None),
        ("serve-control-plane", ["serve", "--local-sessions", "off"],
         {"T3CODE_HOME": "legacy"}, "legacy", "startup"),
        ("serve-default-home", ["serve", "--startup-pairing", "off"], {}, "home/.sail", None),
        ("desktop-fd3", ["--bootstrap-fd", "3"], {}, "envelope", None),
        ("desktop-fd3-invalid", ["--bootstrap-fd", "3"], {}, "envelope", None),
    ]
    with tempfile.TemporaryDirectory(prefix="sail-p01-runtime-", dir="/tmp") as temp:
        scratch = Path(temp).resolve()
        cli_version = cli(
            [*command, "--version"],
            {"HOME": str(scratch), "TMPDIR": str(scratch), "PATH": "/usr/bin:/bin",
             "ELECTRON_RUN_AS_NODE": "1"},
            scratch,
        ).strip()
        require(cli_version == "t3 v0.1.17" and artifact["bundleVersion"] == "0.1.17",
                "CLI and bundle version mismatch")
        observations = []
        for spec in cases:
            try:
                observations.append(probe(command, scratch, spec))
            except RuntimeError as error:
                raise RuntimeError(f"{spec[0]}: {error}") from None
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                raise RuntimeError(f"{spec[0]}: could not complete ({type(error).__name__})") from None
    descriptors = {}
    for observation in observations:
        if "environmentDescriptor" in observation:
            exchange = observation["environmentDescriptor"]
            body = exchange.pop("body")
            profile = next(
                (name for name, descriptor in descriptors.items() if descriptor == body),
                observation["case"],
            )
            descriptors[profile] = body
            exchange["profile"] = profile
    return {
        "schemaVersion": 1,
        "artifact": artifact,
        "cliVersion": cli_version,
        "descriptorProfiles": descriptors,
        "cases": observations,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path, help="Release ZIP and installer-home directory")
    parser.add_argument("--output", type=Path, required=True, help="New sanitized receipt path")
    parser.add_argument("--expect", type=Path, help="Compare the capture against an existing receipt")
    args = parser.parse_args()
    try:
        require(not args.output.exists(), "Output already exists")
        fixture = args.fixture.resolve()
        require(not args.output.resolve().is_relative_to(fixture), "Output must be outside the fixture")
        receipt = capture(fixture)
        with args.output.open("x") as file:
            file.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        if args.expect is not None:
            expected = json.loads(args.expect.read_text())
            require(json.dumps(receipt, sort_keys=True) == json.dumps(expected, sort_keys=True),
                    "Runtime receipt differs from expected")
    except RuntimeError as error:
        parser.exit(1, f"{error}\n")
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Runtime probe could not complete ({type(error).__name__})\n")


if __name__ == "__main__":
    main()

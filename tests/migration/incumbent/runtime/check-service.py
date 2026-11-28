#!/usr/bin/env python3
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from upgrade_state import recorded_state, state_fingerprint


HERE = Path(__file__).resolve().parent
OLD, NEW = "0.1.17", "0.1.18"
PORT = 3773
HOME = "/probe/state"
LAUNCHER = f"{HOME}/runtime/versions/{OLD}/t3"
DESCRIPTOR = "/.well-known/t3/environment"
START = f"""
if [ ! -f {HOME}/runtime/versions/{OLD}/.install-complete ]; then
    mkdir -p {HOME}/runtime/versions/{OLD} /probe/home
    tar -xzf /release/v{OLD}/t3-{OLD}-linux-arm64.tar.gz --strip-components=1 \\
      -C {HOME}/runtime/versions/{OLD}
    printf '%s\\n' {OLD} > {HOME}/runtime/versions/{OLD}/.install-complete
fi
exec env -i PATH=/usr/bin:/bin HOME=/probe/home T3CODE_HOME={HOME} \\
  T3CODE_TELEMETRY_ENABLED=false T3CODE_RELEASE_BASE_URL=http://127.0.0.1:8877 \\
  {LAUNCHER} __service-launcher
"""
MIRROR = """
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/v0.1.18/SHA256SUMS" and not Path("/probe/checksum-valid").exists():
            original = Path("/release" + self.path).read_text()
            line, = [row for row in original.splitlines() if row.endswith("t3-0.1.18-linux-arm64.tar.gz")]
            data = original.replace(line, "0" * 64 + line[64:]).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            super().do_GET()

ThreadingHTTPServer(("127.0.0.1", 8877), Handler).serve_forever()
"""


def run(*command, **kwargs):
    return subprocess.run(
        command, check=True, text=True, stdout=subprocess.PIPE, timeout=180, **kwargs
    ).stdout.strip()


def docker(*args):
    return run("docker", *args)


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def http(origin, path, token=None):
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    try:
        response = urlopen(Request(origin + path, headers=headers), timeout=3)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


def await_version(origin, container, version, runtime_file):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if docker("inspect", "--format", "{{.State.Running}}", container) != "true":
            raise RuntimeError("The service launcher exited before the expected runtime was ready")
        try:
            status, descriptor = http(origin, DESCRIPTOR)
            if status == 200 and descriptor["serverVersion"] == version:
                return descriptor, json.loads(runtime_file.read_text())
        except (URLError, ConnectionError, TimeoutError, FileNotFoundError):
            pass
        time.sleep(0.25)
    raise RuntimeError(f"The service launcher did not select {version}")


def origin_for(container):
    address = docker("port", container, f"{PORT}/tcp")
    assert address.startswith("127.0.0.1:")
    return "http://" + address


def process_pair(container, runtime, version):
    assert runtime["serviceManaged"] is True and runtime["port"] == PORT
    command = """
import os, sys
pid = int(sys.argv[1])
with open(f"/proc/{pid}/stat") as status:
    ppid = int(status.read().rsplit(") ", 1)[1].split()[1])
print(ppid)
print(os.readlink(f"/proc/{ppid}/exe"))
print(os.readlink(f"/proc/{pid}/exe"))
"""
    parent, launcher, server = docker(
        "exec", container, "python3", "-c", command, str(runtime["pid"])
    ).splitlines()
    assert launcher == LAUNCHER
    assert server == f"{HOME}/runtime/versions/{version}/t3"
    return int(parent), runtime["pid"]


def stop(container, origin, runtime_file):
    docker("stop", "--timeout", "30", container)
    assert not runtime_file.exists(), "The runtime record survived shutdown"
    try:
        connection = socket.create_connection(("127.0.0.1", urlsplit(origin).port), timeout=3)
    except ConnectionRefusedError:
        return
    connection.close()
    raise AssertionError("The service listener survived shutdown")


def verify(releases, seed, thread, image, scratch):
    pinned = json.loads((HERE / "v0.1.17-to-v0.1.18-cli.json").read_text())
    expected = pinned["platforms"]["arm64"]["archives"]
    archives = {
        version: digest(releases / f"v{version}/t3-{version}-linux-arm64.tar.gz")
        for version in (OLD, NEW)
    }
    assert archives == expected, "Published CLI archive digest mismatch"
    scratch.mkdir(mode=0o700)
    (scratch / "mirror.py").write_text(MIRROR)
    runtime = scratch / "state/runtime"
    runtime.mkdir(parents=True)
    selection = runtime / "service-state.json"
    initial_selection = {"protocol": 4, "activeVersion": OLD}
    selection.write_text(json.dumps(initial_selection) + "\n")
    (scratch / "state/service.env").write_text(
        f"T3CODE_HOST=0.0.0.0\nT3CODE_PORT={PORT}\nSAIL_STARTUP_PAIRING=off\n"
    )
    userdata = scratch / "state/userdata"
    userdata.mkdir()
    database = userdata / "statev2.sqlite"
    runtime_file = userdata / "server-runtime.json"
    with closing(sqlite3.connect(seed.as_uri() + "?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(database)) as target:
            source.backup(target)
    saved = recorded_state(database, thread)
    assert len(saved["messages"]) == 3 and len(saved["runs"]) == 1

    container = docker(
        "run", "-d", "--init", "--platform", "linux/arm64", "--user", f"{os.getuid()}:{os.getgid()}",
        "-p", f"127.0.0.1::{PORT}", "-v", f"{scratch}:/probe", "-v", f"{releases}:/release:ro",
        image, "sh", "-ec", START,
    )
    try:
        observed = exercise(container, selection, runtime_file, database, thread, saved, scratch)
        return {
            "schemaVersion": 1,
            "from": pinned["from"],
            "to": pinned["to"],
            "archives": archives,
            **observed,
        }
    finally:
        try:
            (scratch / "launcher.private.log").write_text(
                run("docker", "logs", container, stderr=subprocess.STDOUT) + "\n"
            )
        finally:
            if docker("inspect", "--format", "{{.State.Running}}", container) == "true":
                docker("stop", "--timeout", "30", container)
            docker("rm", container)


def exercise(container, selection, runtime_file, database, thread, saved, scratch):
    def issue(scope):
        return docker(
            "exec", container, LAUNCHER, "auth", "session", "issue",
            "--base-dir", HOME, "--token-only", "--scope", scope,
        )

    def update(token):
        return json.loads(run(
            "node", str(HERE / "request-service-update.mjs"), origin, NEW, input=token + "\n"
        ))

    def read_selection():
        return json.loads(selection.read_text())

    def snapshot(version):
        descriptor, runtime = await_version(origin, container, version, runtime_file)
        assert descriptor["platform"] == {"os": "linux", "arch": "arm64"}
        assert descriptor["orchestrationProtocolVersion"] == 2
        assert descriptor["capabilities"]["serverSelfUpdate"] == "boot-service"
        assert descriptor["databaseMigration"] == 118
        assert recorded_state(database, thread) == saved
        status, rejection = http(origin, "/ws?orchestrationProtocol=1")
        assert status == 426 and rejection["orchestrationProtocolVersion"] == 2
        processes = process_pair(container, runtime, version)
        return descriptor["environmentId"], processes

    def session(token, scopes, permissions):
        status, auth = http(origin, "/api/auth/session", token)
        assert status == 200 and auth["authenticated"] is True
        assert auth["sessionMethod"] == "bearer-access-token"
        assert (
            auth["scopes"] == scopes and auth["permissions"] == permissions
        ), "Unexpected bearer grants"
        return {field: auth[field] for field in ("expiresAt", "scopes", "permissions")}

    origin = origin_for(container)
    environment_id, (launcher_pid, server_pid) = snapshot(OLD)
    before = read_selection()
    assert before == {"protocol": 4, "activeVersion": OLD}
    docker("exec", "-d", "-w", "/release", container, "python3", "/probe/mirror.py")
    docker(
        "exec", container, "curl", "--retry", "4", "--retry-connrefused", "--max-time", "5",
        "-fsS", f"http://127.0.0.1:8877/v{NEW}/SHA256SUMS",
    )
    read_token, maintain_token = issue("orchestration:read"), issue("environment:maintain")
    bearer_sessions = [
        (read_token, ["orchestration:read"], ["orchestration:read"]),
        (maintain_token, [], ["environment:maintain"]),
    ]
    original_sessions = [session(*bearer) for bearer in bearer_sessions]
    denied = update(read_token)
    assert denied["_tag"] == "Failure"
    denial, = denied["cause"]
    assert denial["_tag"] == "Fail" and denial["error"]["_tag"] == "EnvironmentAuthorizationError"
    assert denial["error"]["requiredPermission"] == "environment:maintain"
    bad = update(maintain_token)
    assert bad["_tag"] == "Failure"
    failure, = bad["cause"]
    assert failure["_tag"] == "Fail" and failure["error"]["_tag"] == "ServerSelfUpdateError"
    assert "verifying the t3 release archive checksum" in failure["error"]["reason"]
    assert read_selection() == before
    assert snapshot(OLD) == (environment_id, (launcher_pid, server_pid))
    assert not (selection.parent / f"versions/{NEW}/.install-complete").exists()

    (scratch / "checksum-valid").touch()
    accepted = update(maintain_token)
    assert accepted["_tag"] == "Success"
    result = accepted["value"]
    assert result["method"] == "boot-service" and result["targetVersion"] == NEW
    update_id = result["updateId"]
    assert (
        isinstance(update_id, str) and update_id and update_id == update_id.strip()
    ), "Invalid update ID"
    resumed_identity, (same_launcher, new_server) = snapshot(NEW)
    assert resumed_identity == environment_id and same_launcher == launcher_pid and new_server != server_pid
    committed = read_selection()
    assert committed == {
        "protocol": 4,
        "activeVersion": NEW,
        "update": {"id": update_id, "fromVersion": OLD, "targetVersion": NEW, "status": "committed"},
    }
    assert [session(*bearer) for bearer in bearer_sessions] == original_sessions

    stop(container, origin, runtime_file)
    docker("start", container)
    origin = origin_for(container)
    assert snapshot(NEW)[0] == environment_id and read_selection() == committed
    assert [session(*bearer) for bearer in bearer_sessions] == original_sessions
    debian_version = docker("exec", container, "cat", "/etc/debian_version")
    stop(container, origin, runtime_file)
    return {
        "platform": "linux/arm64",
        "distribution": f"Debian {debian_version}",
        "launcher": {"version": OLD, "entrypoint": "__service-launcher", "protocol": 4, "supervisor": "Docker init"},
        "server": {
            "protocol": 2,
            "protocol1HttpStatus": 426,
            "databaseMigration": 118,
            "updateCapability": "boot-service",
        },
        "scopeDenial": denial["error"],
        "checksumRejection": failure["error"],
        "selectionAfterRejection": before,
        "acceptance": {"targetVersion": NEW, "method": result["method"], "idMatchesCommit": True},
        "committedSelection": {**committed, "update": {key: value for key, value in committed["update"].items() if key != "id"}},
        "activation": {"originalLauncherStayedAlive": True, "newChildServed": True},
        "restart": {"originalLauncherSelectedCommittedVersion": True, "sameEnvironment": True, "sessionsPreserved": 2},
        "bearerGrants": [
            {field: auth[field] for field in ("scopes", "permissions")} for auth in original_sessions
        ],
        "savedThread": {
            "messageCount": len(saved["messages"]),
            "runCount": len(saved["runs"]),
            "payloadSha256": state_fingerprint(saved),
        },
        "bothShutdownsClearedListenerAndRuntimeRecord": True,
    }


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Run the launcher probe with assertions enabled")
    parser = argparse.ArgumentParser(description="Probe the published arm64 service launcher in Docker")
    parser.add_argument("releases", type=Path)
    parser.add_argument("seed", type=Path)
    parser.add_argument("thread")
    parser.add_argument("image")
    parser.add_argument("scratch", type=Path)
    parser.add_argument("--expect", type=Path)
    args = parser.parse_args()
    actual = verify(
        args.releases.resolve(), args.seed.resolve(), args.thread, args.image, args.scratch.resolve()
    )
    if args.expect:
        assert actual == json.loads(args.expect.read_text()), "The live receipt disagrees with the reference"
    print(json.dumps(actual, indent=2))

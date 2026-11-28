#!/usr/bin/env python3
"""Capture the published OCI image's default lifecycle in isolated Docker containers."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import parse_qs, urlsplit

from check import DESCRIPTOR, HOST, call, digest, redeem, require
from upgrade_state import recorded_state, state_fingerprint


HERE = Path(__file__).resolve().parent
MIGRATION = HERE.parent.parent
WIRE = MIGRATION / "wire/incumbent-v2.json"
ENTRYPOINT = ["/usr/bin/tini", "--", "/usr/local/bin/sail-entrypoint"]
BASE = "/data/sail"
SCOPE = "orchestration:read"


def run(*command, env=None):
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
    require(result.returncode == 0, f"{' '.join(map(str, command[:2]))} exited {result.returncode}")
    return result.stdout.strip()


def sha(path):
    with path.open("rb") as stream:
        return digest(stream)


def inspect_container(container):
    return json.loads(run("docker", "inspect", container))[0]


def probe_readiness(container, runtime, port):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if runtime.is_file():
            try:
                status, body, _ = call(port, DESCRIPTOR)
            except OSError:
                pass
            else:
                if status == 200:
                    return json.loads(body), json.loads(runtime.read_text())
        require(inspect_container(container)["State"]["Running"], "OCI image exited before readiness")
        time.sleep(0.25)
    raise RuntimeError("OCI image did not become ready")


def pair(port, inside):
    output = inside("t3", "pair", "--base-dir", BASE, "--scope", SCOPE)
    line = next((line for line in output.splitlines() if line.startswith("Pairing URL: ")), "")
    url = urlsplit(line.removeprefix("Pairing URL: "))
    require((url.scheme, url.netloc, url.path, url.query) == ("http", "localhost:8080", "/pair", ""),
            "Container did not issue a pairing URL at its default origin")
    fragment = parse_qs(url.fragment)
    require(set(fragment) == {"token"} and len(fragment["token"]) == 1,
            "Container pairing URL has an unexpected fragment")
    return redeem(port, fragment["token"][0], True, [SCOPE])


def check_wire(port, inside):
    wire = json.loads(WIRE.read_text())

    def issue(scope):
        return inside("t3", "auth", "session", "issue", "--base-dir", BASE, "--token-only", "--scope", scope)

    project = "/data/home/wire-project"
    inside("/usr/local/bin/as-sail", "mkdir", project)
    writer = {"Authorization": f"Bearer {issue('orchestration:operate')}"}
    for payload in (wire["seed"]["create"] | {"workspaceRoot": project}, wire["seed"]["remove"]):
        status, _, _ = call(port, "/api/projects/mutate", payload, writer)
        require(status == 200, "Could not seed the wire fixture")
    reader = issue(SCOPE)
    result = run(
        "node", MIGRATION / "wire/check.ts", f"http://{HOST}:{port}",
        env=os.environ | {"SAIL_WIRE_READ_TOKEN": reader},
    )
    require(result == "Incumbent v2 wire checks passed.", "Wire checker did not confirm success")
    return {"result": "pass", "fixtureSha256": sha(WIRE)}


def read_thread(inside, thread_id, seed):
    result = json.loads(inside("t3", "thread", "show", "--base-dir", BASE, "--json", thread_id))
    thread = result["thread"]
    expected = [{"role": row[3], "runId": row[1], "text": row[-1]["text"]} for row in seed["messages"]]
    require(thread["threadId"] == thread_id and thread["title"] == "Compatibility replay"
            and thread["runCount"] == 1 and result["error"] is None
            and result["messages"] == expected and len(expected) == 3, "Live OCI thread read differs from the seed")
    return {"title": thread["title"], "roles": [message["role"] for message in expected],
            "runCount": thread["runCount"], "messagesMatchSeed": True}


def observe_runtime(inside, descriptor, record, storage, arch, execution):
    pid = record["pid"]
    status = inside("/usr/local/bin/as-sail", "cat", f"/proc/{pid}/status")
    uids = next(line for line in status.splitlines() if line.startswith("Uid:")).split()[1:]
    ppid = next(line for line in status.splitlines() if line.startswith("PPid:")).split()[1]
    require(uids == ["1000"] * 4 and ppid == "1", "Expected an unprivileged server child of container init")
    cwd = inside("/usr/local/bin/as-sail", "readlink", f"/proc/{pid}/cwd")
    require(cwd == "/data/home", "Invalid container process home")
    args = inside("/usr/local/bin/as-sail", "cat", f"/proc/{pid}/cmdline").rstrip("\0").split("\0")
    expected_args = ["/usr/local/bin/node", "/opt/sail/server/bin.mjs", "serve",
                     "--host", "0.0.0.0", "--port", "8080"]
    emulated_args = ["--no-opt", "-r", "/proc/.reset"]
    if execution == "emulated" and args[1:4] == emulated_args:
        expected_args[1:1] = emulated_args
    require(args == expected_args, "Default OCI server command changed")
    require(record["host"] == "0.0.0.0" and record["port"] == 8080
            and record["serverVersion"] == "0.1.17"
            and descriptor["environmentId"] == (storage / "sail/userdata/environment-id").read_text().strip(),
            "Runtime does not identify the mounted home and listener")
    server_arch = {"arm64": "arm64", "amd64": "x64"}[arch]
    require(descriptor["platform"] == {"os": "linux", "arch": server_arch}
            and descriptor["serverVersion"] == "0.1.17"
            and descriptor["orchestrationProtocolVersion"] == 2
            and descriptor["databaseMigration"] == 118, "Unexpected published OCI descriptor")
    require(record["ownerId"] and record["startedAt"], "Missing OCI server owner or start time")
    return {
        "runtimeOwnerSha256": hashlib.sha256(record["ownerId"].encode()).hexdigest(),
        "startedAt": record["startedAt"], "command": args, "uid": int(uids[0]), "parentPid": int(ppid),
        "workingDirectory": cwd, "serverHome": BASE, "hostPortBinding": "127.0.0.1",
        "startupPairingUrlPrinted": False,
        "descriptor": {key: descriptor[key] for key in (
            "platform", "serverVersion", "orchestrationProtocolVersion", "databaseMigration", "capabilities",
        )},
    }


def boot(image, details, assembly, seed_path, thread_id, mode):
    arch = assembly["arch"]
    with tempfile.TemporaryDirectory(prefix="sail-oci-") as directory:
        storage = Path(directory).resolve() / "data"
        storage.mkdir()
        storage.chmod(0o777)
        database = storage / "sail/userdata/statev2.sqlite"
        state = {"homeMode": mode, "database": "sail/userdata/statev2.sqlite"}
        seed = None
        if mode == "copied":
            database.parent.mkdir(parents=True)
            database.parent.parent.chmod(0o777)
            database.parent.chmod(0o777)
            shutil.copyfile(seed_path, database)
            database.chmod(0o666)
            require(sha(seed_path) == sha(database), "Copied seed digest differs")
            seed = recorded_state(database, thread_id)
            state.update(seedDatabaseSha256=sha(database), beforeStart=state_fingerprint(seed))
        else:
            state["databaseAbsentBeforeStart"] = not database.exists()

        container = run(
            "docker", "create", "--platform", f"linux/{arch}", "--pull", "never",
            "--publish", "127.0.0.1::8080",
            "--env", "T3CODE_TELEMETRY_ENABLED=false",
            "--mount", f"type=bind,source={storage},target=/data", image,
        )
        try:
            run("docker", "start", container)
            live = inspect_container(container)
            require(live["Image"] == details["Id"] and live["Config"]["Image"] == image, "Container image identity differs")
            mounts = [mount for mount in live["Mounts"] if mount["Destination"] == "/data"]
            require(len(mounts) == 1 and mounts[0]["Type"] == "bind" and mounts[0]["RW"]
                    and Path(mounts[0]["Source"]).resolve() == storage, "Container did not select the scratch data mount")
            address = urlsplit("http://" + run("docker", "port", container, "8080/tcp"))
            require(address.hostname == HOST and address.port, "Expected a loopback host port")
            port = address.port
            runtime = database.with_name("server-runtime.json")
            descriptor, record = probe_readiness(container, runtime, port)
            require(database.is_file() and "Pairing URL:" not in run("docker", "logs", container),
                    "Unexpected startup pairing or missing mounted database")

            def inside(*command):
                return run("docker", "exec", container, *command)

            version = inside("t3", "--version")
            require(version == "t3 v0.1.17", "Unexpected packaged CLI version")
            os_version = "Debian " + inside("cat", "/etc/debian_version")
            start = observe_runtime(inside, descriptor, record, storage, arch, assembly["execution"])
            pairing = pair(port, inside)
            if seed is None:
                state["wire"] = check_wire(port, inside)
            else:
                state["threadRead"] = read_thread(inside, thread_id, seed)
            run("docker", "stop", "--time", "10", container)
            exited = inspect_container(container)["State"]
            require(exited["Status"] == "exited" and exited["ExitCode"] == 130,
                    "Unexpected OCI exit status")
            with socket.socket() as listener:
                listener.settimeout(5)
                require(listener.connect_ex((HOST, port)) != 0, "OCI listener survived Docker stop")
            require(not runtime.exists(), "OCI runtime record survived Docker stop")
            if seed is not None:
                after = recorded_state(database, thread_id)
                require(after == seed, "Container changed the saved Replay payloads")
                state["afterStop"] = state_fingerprint(after)
            boot_id = hashlib.sha256(container.encode()).hexdigest()
            state.update(bootId=boot_id, runtimeOwnerSha256=start["runtimeOwnerSha256"])
            process = {
                "schemaVersion": 1, "bootId": boot_id, "homeMode": mode,
                "image": assembly | {"osVersion": os_version},
                "version": version, "start": start, "pair": pairing,
                "stop": {"command": ["docker", "stop"], "exitCode": exited["ExitCode"],
                         "listenerClosed": True, "runtimeRecordRemoved": True},
            }
            return process, {"schemaVersion": 1, **state}
        finally:
            run("docker", "rm", "--force", container)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arch", choices=("arm64", "amd64"))
    parser.add_argument("seed", type=Path)
    parser.add_argument("thread_id", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir()
    inventory = json.loads((HERE.parent / "release-inventory.json").read_text())
    oci = inventory["ociServer"]
    manifest = next(manifest["digest"] for manifest in oci["manifests"]
                    if manifest["platform"] == {"os": "linux", "architecture": args.arch})
    image = f"{oci['repository']}@{manifest}"
    details = json.loads(run("docker", "image", "inspect", image))[0]
    require(details["Architecture"] == args.arch and details["Os"] == "linux"
            and image in details["RepoDigests"] and details["Config"]["Entrypoint"] == ENTRYPOINT,
            "Pulled image does not match the published manifest and entrypoint")
    engine_arch = run("docker", "info", "--format", "{{.Architecture}}")
    execution = "native" if engine_arch in {
        "arm64": {"arm64", "aarch64"}, "amd64": {"amd64", "x86_64"},
    }[args.arch] else "emulated"
    assembly = {
        "arch": args.arch, "os": "linux", "execution": execution, "entrypoint": ENTRYPOINT,
        "manifestDigest": manifest, "indexDigest": oci["indexDigest"], "repository": oci["repository"],
        "tag": inventory["githubRelease"]["tag_name"], "sourceSha": inventory["incumbentSourceSha"],
    }
    thread = args.thread_id.read_text().strip()
    require(not Path(str(args.seed) + "-wal").exists(), "Use a standalone SQLite seed backup")
    for mode in ("fresh", "copied"):
        for sample in ("first", "repeat"):
            process, state = boot(image, details, assembly, args.seed, thread, mode)
            output = args.output / f"{mode}-{sample}"
            output.mkdir()
            for name, value in (("process", process), ("state", state)):
                (output / f"{name}.json").write_text(json.dumps(value, indent=2) + "\n")
            print(f"{args.arch} {mode} {sample}: published OCI lifecycle passed", flush=True)


if __name__ == "__main__":
    main()

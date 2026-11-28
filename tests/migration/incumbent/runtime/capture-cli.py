#!/usr/bin/env python3
"""Capture the installed v0.1.17 Linux CLI lifecycle in isolated homes."""

import argparse
import errno
from hashlib import sha256 as hash_value
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import socket
import subprocess
import tarfile
import tempfile
import uuid

from check import (
    DESCRIPTOR, HOST, LABEL, await_runtime, call, cli, digest,
    pair_credential, redeem, require,
)
from upgrade_state import recorded_state, state_fingerprint


def sha256(path):
    with path.open("rb") as stream:
        return digest(stream)


def verify_package(archive, install, arch):
    inventory = json.loads((Path(__file__).resolve().parent.parent / "release-inventory.json").read_text())
    target = f"linux-{arch}"
    edition = next(item for item in inventory["installerTargets"] if item["id"] == target)
    name = edition["cliArchive"]
    asset = next(item for item in inventory["githubRelease"]["assets"] if item["name"] == name)
    archive_sha = sha256(archive)
    require(archive_sha == asset["digest"].removeprefix("sha256:"), "Wrong published archive")
    require(archive.stat().st_size == asset["size"], "Wrong published archive size")
    entry_names = set()
    executable = install / "t3"
    with tarfile.open(archive, "r|gz") as package:
        for entry in package:
            parts = PurePosixPath(entry.name).parts
            require(parts[0] == name.removesuffix(".tar.gz") and ".." not in parts,
                    "Unexpected release archive path")
            relative = Path(*parts[1:])
            if relative == Path("."):
                require(entry.isdir(), "Expected a package root directory")
                continue
            require(relative not in entry_names, "Duplicate archive entry")
            entry_names.add(relative)
            installed = install / relative
            if entry.isfile():
                require(installed.is_file() and not installed.is_symlink()
                        and digest(package.extractfile(entry)) == sha256(installed),
                        f"Installed file differs: {relative}")
            elif entry.issym():
                require(installed.is_symlink() and os.readlink(installed) == entry.linkname,
                        f"Installed symlink differs: {relative}")
            else:
                require(entry.isdir() and installed.is_dir() and not installed.is_symlink(),
                        f"Installed directory differs: {relative}")
    require(entry_names == {path.relative_to(install) for path in install.rglob("*")},
            "Installed package has different entries")
    with executable.open("rb") as file:
        header = file.read(20)
    require(header[:6] == b"\x7fELF\x02\x01" and int.from_bytes(header[18:20], "little")
            == {"arm64": 183, "x64": 62}[arch], "Wrong installed executable architecture")
    return {
        "target": target,
        "tag": inventory["githubRelease"]["tag_name"],
        "sourceSha": inventory["incumbentSourceSha"],
        "archive": name,
        "archiveSha256": archive_sha,
        "archiveBytes": archive.stat().st_size,
        "installedEntries": len(entry_names),
        "runtimeSha256": sha256(executable),
    }


def environment(arch, execution):
    return {
        "os": "linux",
        "arch": arch,
        "osVersion": "Debian " + Path("/etc/debian_version").read_text().strip(),
        "execution": execution,
        "origin": "http://127.0.0.1",
        "connectionMode": "loopback",
    }


def executable_proof(process, executable, execution):
    proc = Path(f"/proc/{process.pid}")
    actual = (proc / "exe").resolve()
    if execution == "native":
        require(actual == executable, "Serving executable differs from installed t3")
        return {"kind": "proc-exe"}
    require(actual.name == "rosetta", "Expected the Rosetta interpreter")
    argv = (proc / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
    require(argv == [os.fsencode(arg) for arg in process.args], "Translated CLI argv differs")
    installed_inode = str(executable.stat().st_ino)
    require(any(
        len(fields) == 6 and fields[4] == installed_inode and fields[5] == str(executable)
        for fields in (line.split(maxsplit=5) for line in (proc / "maps").read_text().splitlines())
    ), "Translated CLI is missing the installed executable mapping")
    return {"kind": "proc-mapped-exe", "interpreter": actual.name}


def runtime_witness(process, record, executable, boot_id, host, mode):
    stat = Path(f"/proc/{process.pid}/stat").read_text()
    prefix, separator, suffix = stat.rpartition(")")
    require(separator and prefix.startswith(f"{process.pid} ("), "Kernel process record differs")
    start_ticks = int(suffix.split()[19])
    require(start_ticks > 0, "Missing kernel process start time")
    kernel_boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    kernel_identity = hash_value(f"{kernel_boot}\0{process.pid}\0{start_ticks}".encode()).hexdigest()
    owner = record["ownerId"]
    require(isinstance(owner, str) and owner, "Missing runtime owner identity")
    return {
        "bootId": boot_id,
        "platform": host["arch"],
        "execution": host["execution"],
        "homeMode": mode,
        "runtimeSha256": sha256(executable),
        "runtimeIdentity": {"ownerSha256": hash_value(owner.encode()).hexdigest(),
                            "startedAt": record["startedAt"]},
        "kernelProcessSha256": kernel_identity,
    }


def copied_thread(command, env, cwd, thread_id, seed):
    result = json.loads(cli([*command, "--json", thread_id], env, cwd))
    thread = result["thread"]
    require(thread["threadId"] == thread_id and thread["title"] == "Compatibility replay"
            and thread["runCount"] == 1 and result["error"] is None, "Wrong live thread")
    expected = [{"role": row[3], "runId": row[1], "text": row[-1]["text"]} for row in seed["messages"]]
    require(result["messages"] == expected and len(expected) == 3,
            "Live CLI messages differ from the saved fixture")
    return {
        "command": ["t3", "thread", "show", "--base-dir", "$BASE", "--json", "$THREAD"],
        "exitCode": 0,
        "threadTitle": thread["title"],
        "roles": [message["role"] for message in expected],
        "messageCount": len(expected),
        "runCount": thread["runCount"],
        "messagesMatchSeed": True,
    }


def boot(executable, package, host, seed_path, thread_id, mode):
    boot_id = str(uuid.uuid4())
    fixture = {"bootId": boot_id, "homeMode": mode, "fixtureId": "linux-cli-lifecycle"}
    with tempfile.TemporaryDirectory(prefix="sail-cli-") as directory:
        scratch = Path(directory)
        base = scratch / "selected"
        data = base / "userdata"
        data.mkdir(parents=True)
        database = data / "statev2.sqlite"
        state = {**fixture, "database": "userdata/statev2.sqlite"}
        seed = None
        if mode == "copied":
            require(not Path(str(seed_path) + "-wal").exists(), "Expected a standalone seed database")
            shutil.copyfile(seed_path, database)
            seed = recorded_state(database, thread_id)
            require(len(seed["messages"]) == 3 and len(seed["runs"]) == 1,
                    "Unexpected copied seed rows")
            state.update(seedDatabaseSha256=sha256(seed_path), beforeStart=state_fingerprint(seed))
            require(sha256(database) == state["seedDatabaseSha256"], "Copied database differs")
        else:
            state["databaseAbsentBeforeStart"] = not database.exists()

        env = {
            "HOME": str(scratch / "home"),
            "XDG_CONFIG_HOME": str(scratch / "config"),
            "XDG_CACHE_HOME": str(scratch / "cache"),
            "XDG_DATA_HOME": str(scratch / "xdg-data"),
            "XDG_STATE_HOME": str(scratch / "xdg-state"),
            "SAIL_HOME": str(scratch / "sail-home"),
            "T3CODE_HOME": str(scratch / "legacy-home"),
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "T3CODE_ENVIRONMENT_LABEL": LABEL,
            "T3CODE_TELEMETRY_ENABLED": "false",
            "T3CODE_DISABLE_AUTO_UPDATE": "1",
        }
        Path(env["HOME"]).mkdir()
        version = cli([executable, "--version"], env, scratch).strip()
        require(version == f"t3 {package['tag']}", "Incorrect CLI version")
        with socket.socket() as listener:
            listener.bind((HOST, 0))
            port = listener.getsockname()[1]
        args = ["--base-dir", str(base)]
        serve = ["serve", *args, "--host", HOST, "--port", str(port), "--startup-pairing", "off"]
        runtime = data / "server-runtime.json"
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen([executable, *serve], env=env, cwd=scratch,
                                       stdout=log, stderr=log, stdin=subprocess.DEVNULL)
            try:
                record, startup = await_runtime(runtime, process, log,
                                                timeout=90 if host["execution"] == "emulated" else 30)
                require(record["pid"] == process.pid
                        and (record["host"], record["port"], record["origin"])
                        == (HOST, port, f"http://{HOST}:{port}"), "Runtime does not identify owned listener")
                runtime_executable = executable_proof(process, executable, host["execution"])
                witness = runtime_witness(process, record, executable, boot_id, host, mode)
                runtime_identity = witness["runtimeIdentity"]
                state["runtimeOwnerSha256"] = runtime_identity["ownerSha256"]
                require(b"Pairing URL:" not in startup and database.is_file(), "Unexpected startup behavior")
                require(not any((other / "userdata/server-runtime.json").exists() for other in (
                        Path(env["SAIL_HOME"]), Path(env["T3CODE_HOME"]), Path(env["HOME"]) / ".sail")),
                        "Runtime started in a competing home")
                http, body, _ = call(port, DESCRIPTOR)
                descriptor = json.loads(body)
                require(http == 200 and descriptor.pop("environmentId")
                        == (data / "environment-id").read_text().strip(), "Wrong environment identity")
                require(descriptor["label"] == LABEL
                        and descriptor["platform"] == {"os": "linux", "arch": host["arch"]}
                        and descriptor["serverVersion"] == record["serverVersion"] == version.removeprefix("t3 v")
                        and descriptor["orchestrationProtocolVersion"] == 2
                        and descriptor["databaseMigration"] == 118, "Unexpected release descriptor")
                descriptor = {key: descriptor[key] for key in (
                    "label", "platform", "serverVersion", "orchestrationProtocolVersion",
                    "databaseMigration", "capabilities",
                )}
                pair = cli([executable, "pair", *args, "--scope", "orchestration:read"], env, scratch)
                grants = redeem(port, pair_credential(pair, port), True, ["orchestration:read"])
                if seed is not None:
                    state["threadRead"] = copied_thread([executable, "thread", "show", *args],
                                                        env, scratch, thread_id, seed)
                require(process.poll() is None, "Server exited before Ctrl-C")
                process.send_signal(signal.SIGINT)
                exit_code = process.wait(timeout=20)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)
        with socket.socket() as listener:
            listener.settimeout(1)
            refused = listener.connect_ex((HOST, port)) == errno.ECONNREFUSED
        require(exit_code == 130 and refused and not runtime.exists(), "Foreground shutdown leaked state")
        if seed is not None:
            after = recorded_state(database, thread_id)
            require(after == seed, "Boot changed the saved message or run payloads")
            state["afterStop"] = state_fingerprint(after)
        return {
            "schemaVersion": 1,
            **fixture,
            "package": package,
            "platform": host,
            "version": {"command": ["t3", "--version"], "exitCode": 0, "stdout": version},
            "start": {
                "command": ["t3", "serve", "--base-dir", "$BASE", "--host", HOST,
                            "--port", "$PORT", "--startup-pairing", "off"],
                "readiness": "T3 Code server is ready.",
                "startupPairingUrlPrinted": False,
                "runtimeRecord": "userdata/server-runtime.json",
                "runtimeRecordVersion": record["version"],
                "runtimeIdentity": runtime_identity,
                "runtimeMatchesOwnedChild": True,
                "runtimeExecutable": runtime_executable,
                "environmentMatchesSelectedHome": True,
                "competingRuntimeRecordPresent": False,
                "descriptorStatus": http,
                "descriptor": descriptor,
            },
            "pair": {"command": ["t3", "pair", "--base-dir", "$BASE", "--scope", "orchestration:read"],
                     "exitCode": 0, "browserSession": grants},
            "stop": {"signal": "SIGINT", "exitCode": exit_code,
                     "listenerRefused": refused, "runtimeRecordRemoved": True},
        }, state, witness


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("install", type=Path)
    parser.add_argument("seed", type=Path)
    parser.add_argument("thread_id", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--emulated", action="store_true")
    args = parser.parse_args()
    arch = {"aarch64": "arm64", "x86_64": "x64"}[os.uname().machine]
    package = verify_package(args.archive, args.install, arch)
    host = environment(arch, "emulated" if args.emulated else "native")
    for mode in ("fresh", "copied"):
        for ordinal in ("first", "repeat"):
            process, state, witness = boot(args.install / "t3", package, host, args.seed,
                                           args.thread_id.read_text().strip(), mode)
            output = args.output / f"{mode}-{ordinal}"
            output.mkdir()
            for name, value in (("process", process), ("state", state), ("witness", witness)):
                (output / f"{name}.json").write_text(json.dumps(value, indent=2) + "\n")
            print(f"{arch} {mode} {ordinal}: CLI lifecycle passed", flush=True)


if __name__ == "__main__":
    main()

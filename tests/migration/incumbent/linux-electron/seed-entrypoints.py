"""Build an isolated navigation fixture through the published OCI runtime."""

import json
from contextlib import closing
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote


HERE = Path(__file__).resolve().parent
ENTRY_TITLE = "Navigation source"
SERVER_HOME = "/data/sail"


def docker(*args):
    return subprocess.run(
        ["docker", *map(str, args)], check=True, text=True, stdout=subprocess.PIPE, timeout=90,
    ).stdout.strip()


def replace_replay_reply(recording, link):
    frames = [json.loads(line) for line in recording.read_text().splitlines()]
    replies = []
    for row in frames:
        frame = row.get("frame")
        if row["type"] == "emit_inbound" and isinstance(frame, dict) and frame.get("method") == "session/update":
            update = frame["params"]["update"]
            if update["sessionUpdate"] == "agent_message_chunk" and update["content"]["text"].startswith("## Done"):
                replies.append(update["content"])
    reply, = replies
    reply["text"] = f"Open {link}."
    recording.write_text("".join(json.dumps(frame) + "\n" for frame in frames))


def main(original, output):
    inventory = json.loads((HERE.parent / "release-inventory.json").read_text())
    oci = inventory["ociServer"]
    manifest = next(item["digest"] for item in oci["manifests"]
                    if item["platform"] == {"os": "linux", "architecture": "arm64"})
    image = f"{oci['repository']}@{manifest}"
    output.mkdir()
    dest = (original / "thread-id").read_text().strip()
    for asset in ("replay.tar", "thread-id"):
        shutil.copyfile(original / asset, output / asset)
    with tempfile.TemporaryDirectory(prefix="sail-entrypoints-seed-") as temp:
        root = Path(temp).resolve()
        storage = root / "data"
        state = storage / "sail/userdata"
        state.mkdir(parents=True)
        for directory in (storage, state.parent, state):
            directory.chmod(0o777)
        database = state / "statev2.sqlite"
        shutil.copyfile(original / "seed.sqlite", database)
        database.chmod(0o666)
        archive = output / "replay.tar"
        with archive.open("rb") as stream:
            commit = subprocess.run(
                ["git", "get-tar-commit-id"], stdin=stream,
                stdout=subprocess.PIPE, check=True, text=True,
            ).stdout.strip()
        if commit != inventory["incumbentSourceSha"]:
            raise RuntimeError("Replay source archive does not match the release")
        replay = root / "replay"
        replay.mkdir()
        subprocess.run(["tar", "-xf", archive, "-C", replay], check=True)
        recording = replay / "apps/server/scripts/dev-replay/showcase_transcript.ndjson"
        link = f"[Compatibility replay](t3-thread://v1/{quote(dest, safe='')})"
        replace_replay_reply(recording, link)
        (state / "settings.json").write_text(json.dumps({"providerInstances": {"devReplay": {
            "displayName": "Replay (dev)", "driver": "acpRegistry",
            "config": {"source": "local", "commandPath": "/usr/local/bin/node",
                       "commandArgs": ["/replay/apps/server/scripts/dev-replay-agent.ts"]},
        }}}))

        container = docker(
            "create", "--pull", "never", "--platform", "linux/arm64",
            "--network", "none", "--env", "T3CODE_TELEMETRY_ENABLED=false",
            "--mount", f"type=bind,src={storage},dst=/data",
            "--mount", f"type=bind,src={replay},dst=/replay,readonly", image,
        )
        try:
            docker("start", container)
            runtime = state / "server-runtime.json"
            deadline = time.monotonic() + 60
            while not runtime.is_file() and time.monotonic() < deadline:
                if docker("inspect", "--format", "{{.State.Running}}", container) != "true":
                    raise RuntimeError("Published seed server exited before readiness")
                time.sleep(0.25)
            if not runtime.is_file():
                raise RuntimeError("Published seed server did not start")
            workspace = "/data/home/entrypoints-fixture"
            docker("exec", container, "/usr/local/bin/as-sail", "mkdir", "-p", workspace)
            docker("exec", container, "t3", "project", "add", "--base-dir", SERVER_HOME,
                   "--title", "Navigation fixture", workspace)
            result = json.loads(docker(
                "exec", container, "t3", "thread", "start", "--base-dir", SERVER_HOME,
                "--provider", "devReplay", "--model", "showcase", "--title", ENTRY_TITLE,
                "--wait", "--json", workspace,
                "Link to the saved replay thread.",
            ))
            if result["status"] != "completed" or result["threadId"] == dest or link not in result["reply"]:
                raise RuntimeError("Could not create the distinct Replay source thread")
            docker("stop", "--time", "15", container)
            if runtime.exists():
                raise RuntimeError("Published seed server did not clear the runtime record")
            with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as source:
                if source.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise RuntimeError("Navigation seed failed SQLite integrity check")
                with closing(sqlite3.connect(output / "seed.sqlite")) as target:
                    source.backup(target)
            (output / "source-thread-id").write_text(result["threadId"] + "\n")
        finally:
            docker("rm", "--force", container)


if __name__ == "__main__":
    main(*(Path(argument).resolve() for argument in sys.argv[1:]))

#!/usr/bin/env python3
"""Render the sanitized CLI receipt and bind the image to its recorded inputs."""

import argparse
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin


def render(directory):
    process_bytes = (directory / "process.json").read_bytes()
    state_bytes = (directory / "state.json").read_bytes()
    process = json.loads(process_bytes)
    state = json.loads(state_bytes)
    if process["bootId"] != state["bootId"]:
        raise ValueError("Process and state receipts belong to different boots")
    host = process["platform"]
    descriptor = process["start"]["descriptor"]
    pairing = process["pair"]["browserSession"]
    shutdown = process["stop"]
    rows = [
        f'{host["osVersion"]} / {host["arch"]} ({host["execution"]}) / {process["homeMode"]} home',
        f'Boot {process["bootId"]}',
        f'$ t3 --version    {process["version"]["stdout"]}',
        f'$ t3 serve      Ready. Protocol {descriptor["orchestrationProtocolVersion"]}, '
        f'database migration {descriptor["databaseMigration"]}.',
        f'$ t3 pair       {pairing["cookieCheck"]["scopes"][0]}, '
        f'HTTP {pairing["status"]}, reuse HTTP {pairing["reuseStatus"]}',
    ]
    if "threadRead" in state:
        thread = state["threadRead"]
        rows.append(f'$ t3 thread show    {thread["threadTitle"]}, {thread["messageCount"]} messages')
    rows.append(
        f'^C    Exit {shutdown["exitCode"]}. '
        f'Listener refused: {shutdown["listenerRefused"]}. '
        f'Runtime removed: {shutdown["runtimeRecordRemoved"]}.'
    )
    image = Image.new("RGB", (1024, 318), "#151b23")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=19)
    draw.text((24, 20), "Sail CLI lifecycle", font=font, fill="#f0f3f6")
    for index, line in enumerate(rows):
        draw.text((24, 60 + 32 * index), line, font=font, fill="#dce5ed")
    meta = PngImagePlugin.PngInfo()
    meta.add_text("SailBoot", process["bootId"])
    meta.add_text("SailTranscriptSha256", sha256(process_bytes).hexdigest())
    meta.add_text("SailStateSha256", sha256(state_bytes).hexdigest())
    with (directory / "terminal.png").open("xb") as file:
        image.save(file, format="PNG", pnginfo=meta)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    render(parser.parse_args().capture)

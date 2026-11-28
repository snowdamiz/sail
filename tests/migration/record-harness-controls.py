#!/usr/bin/env python3
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


MIGRATION = Path(__file__).resolve().parent
COMPARATOR = MIGRATION / "compare.py"
REFERENCE = MIGRATION / "incumbent/observations/served-chromium-macos/settled"


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def write_json(path, payload):
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def probe(root, baseline, candidate, source_sha, name, expected):
    diff = root / f"{name}.png"
    result = subprocess.run(
        [
            sys.executable, str(COMPARATOR), "compare", str(baseline), str(candidate),
            "--baseline-sha", source_sha, "--candidate-sha", source_sha, "--diff", str(diff),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != expected[0]:
        raise ValueError(f"{name}: expected exit {expected[0]}, got {result.returncode}: {result.stderr}")
    comparison = json.loads(result.stdout)
    pixels = comparison["pixels"]
    actual = (result.returncode, pixels["differentPixels"], comparison["changedSteps"])
    if actual != expected:
        raise ValueError(f"{name}: expected {expected}, got {actual}")
    for key in ("baseline", "candidate", "diff"):
        pixels[key] = Path(pixels[key]).relative_to(root).as_posix()
    return {"name": name, "exitCode": result.returncode, "comparison": comparison}


def change_pixel(path, receipt):
    with Image.open(path) as original:
        image = original.convert("RGBA")
    red, green, blue, alpha = image.getpixel((0, 0))
    image.putpixel((0, 0), (red ^ 1, green, blue, alpha))
    image.save(path)
    receipt["screenshotSha256"] = digest(path)
    return {"x": 0, "y": 0, "channel": "red", "before": red, "after": red ^ 1}


def change_reply(_path, receipt):
    observed = receipt["trace"][0]["observed"]
    if observed["replyVisible"] is not True:
        raise ValueError("expected a visible reply in the first trace step")
    observed["replyVisible"] = False
    return {"step": 1, "field": "replyVisible", "before": True, "after": False}


def remove_widget_state(_path, receipt):
    observed = receipt["trace"][0]["observed"]
    if observed.pop("stopVisible") is not False:
        raise ValueError("expected a hidden Stop control in the first trace step")
    return {"step": 1, "field": "stopVisible", "before": False, "removed": True}


def render_results(path, fixture, controls):
    rows = [("Probe", "Exit", "Pixels", "Changed steps")]
    for control in controls:
        comparison = control["comparison"]
        steps = ", ".join(map(str, comparison["changedSteps"])) or "none"
        rows.append((
            control["name"], str(control["exitCode"]),
            str(comparison["pixels"]["differentPixels"]), steps,
        ))
    font = ImageFont.load_default(size=18)
    image = Image.new("RGB", (620, 232), "#151b23")
    draw = ImageDraw.Draw(image)
    draw.text((18, 18), f"compare.py  /  {fixture}", font=font, fill="#f0f3f6")
    for i, row in enumerate(rows):
        for x, value in zip((18, 290, 362, 440), row, strict=True):
            draw.text((x, 58 + 25 * i), value, font=font, fill="#f0f3f6")
    image.save(path)


def record(output):
    with tempfile.TemporaryDirectory(prefix="sail-negative-controls-") as directory:
        root = Path(directory)
        baseline = root / "baseline"
        repeat = root / "repeat"
        for target, archive in ((baseline, "a"), (repeat, "b")):
            target.mkdir()
            for name in ("capture.png", "receipt.json"):
                shutil.copyfile(REFERENCE / archive / name, target / name)
        reference = json.loads((baseline / "receipt.json").read_text(encoding="utf-8"))
        source_sha = reference["sourceSha"]
        controls = [
            probe(root, baseline, repeat, source_sha, "unchanged-first", (0, 0, [])),
            probe(root, baseline, repeat, source_sha, "unchanged-repeat", (0, 0, [])),
        ]
        mutations = []
        for name, mutate, expected in (
            ("pixel-changed", change_pixel, (1, 1, [])),
            ("replay-result-changed", change_reply, (1, 0, [1])),
            ("widget-state-missing", remove_widget_state, (1, 0, [1])),
        ):
            candidate = root / name
            shutil.copytree(repeat, candidate)
            receipt_path = candidate / "receipt.json"
            image_path = candidate / "capture.png"
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            mutation = mutate(image_path, receipt)
            write_json(receipt_path, receipt)
            controls.append(probe(root, baseline, candidate, source_sha, name, expected))
            mutations.append({"name": name, "change": mutation, "receiptSha256": digest(receipt_path)})

    output.mkdir(parents=True)
    write_json(output / "receipt.json", {
        "schemaVersion": 1,
        "fixtureId": reference["fixtureId"],
        "sourceSha": source_sha,
        "comparatorSha256": digest(COMPARATOR),
        "pixelComparatorSha256": digest(MIGRATION / "gpui/compare-pixels.py"),
        "referenceDirectories": [
            (REFERENCE / name).relative_to(MIGRATION).as_posix() for name in ("a", "b")
        ],
        "mutations": mutations,
    })
    write_json(output / "comparisons.json", {
        "schemaVersion": 1,
        "pixelPathScope": "Temporary comparison directory",
        "controls": controls,
    })
    render_results(output / "ref-negative.png", reference["fixtureId"], controls)


def main():
    parser = argparse.ArgumentParser(description="Record the published Replay comparator controls")
    parser.add_argument("output", type=Path, help="New output directory")
    args = parser.parse_args()
    record(args.output)


if __name__ == "__main__":
    main()

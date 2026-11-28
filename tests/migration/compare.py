#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path


PIXEL_CHECK = Path(__file__).with_name("gpui") / "compare-pixels.py"
PROFILE_FIELDS = {
    "surface", "platform", "browser", "origin", "locale", "theme", "motion", "fonts", "viewport",
}


def load_receipt(path):
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(receipt, dict)
        or type(receipt.get("schemaVersion")) is not int
        or receipt["schemaVersion"] != 1
    ):
        raise ValueError(f"{path}: expected a version 1 capture receipt")
    for field in ("fixtureId", "sourceSha", "client", "server"):
        if not isinstance(receipt.get(field), str) or not receipt[field].strip():
            raise ValueError(f"{path}: missing {field}")
    if not re.fullmatch(r"[0-9a-f]{40}", receipt["sourceSha"]):
        raise ValueError(f"{path}: sourceSha must be a full commit SHA")

    profile = receipt.get("profile")
    if not isinstance(profile, dict) or profile.keys() != PROFILE_FIELDS:
        raise ValueError(f"{path}: missing or unknown display profile fields")
    for field in PROFILE_FIELDS - {"browser", "fonts", "viewport"}:
        if not isinstance(profile[field], str) or not profile[field].strip():
            raise ValueError(f"{path}: missing profile.{field}")
    browser = profile["browser"]
    if profile["surface"] == "desktop":
        if browser is not None:
            raise ValueError(f"{path}: record the desktop renderer in client")
    elif not isinstance(browser, str) or not browser.strip():
        raise ValueError(f"{path}: missing profile.browser")
    if not isinstance(profile["fonts"], list) or not profile["fonts"] or any(
        not isinstance(font, str) or not font.strip() for font in profile["fonts"]
    ):
        raise ValueError(f"{path}: expected a nonempty list of pinned fonts")
    viewport = profile["viewport"]
    if not isinstance(viewport, dict) or viewport.keys() != {"width", "height", "scale", "zoom"}:
        raise ValueError(f"{path}: expected viewport width, height, scale, and zoom")
    if any(type(viewport[key]) is not int or viewport[key] <= 0 for key in ("width", "height")):
        raise ValueError(f"{path}: viewport dimensions must be positive integers")
    for key in ("scale", "zoom"):
        if type(viewport[key]) not in (int, float) or not 0 < viewport[key] < float("inf"):
            raise ValueError(f"{path}: viewport {key} must be a finite positive number")

    trace = receipt.get("trace")
    if not isinstance(trace, list) or not trace:
        raise ValueError(f"{path}: expected an ordered, nonempty action trace")
    for step in trace:
        if (
            not isinstance(step, dict)
            or step.keys() != {"action", "observed"}
            or not isinstance(step["action"], str)
            or not step["action"].strip()
            or not isinstance(step["observed"], dict)
            or not step["observed"]
        ):
            raise ValueError(f"{path}: each trace step must name its action and record its outcome")
    canonical(receipt)
    return receipt


def canonical(value):
    return json.dumps(value, sort_keys=True, allow_nan=False)


def screenshot_hash(path):
    with path.open("rb") as image:
        return hashlib.file_digest(image, "sha256").hexdigest()


def load_capture(directory):
    image = directory / "capture.png"
    receipt = load_receipt(directory / "receipt.json")
    if receipt.get("screenshotSha256") != screenshot_hash(image):
        raise ValueError(f"{directory}: screenshot SHA-256 does not match receipt.json")
    return receipt, image


def compare(args):
    baseline, baseline_png = load_capture(args.baseline)
    candidate, candidate_png = load_capture(args.candidate)
    if baseline["sourceSha"] != args.baseline_sha:
        raise ValueError(f"{args.baseline}: expected reference source {args.baseline_sha}")
    if candidate["sourceSha"] != args.candidate_sha:
        raise ValueError(f"{args.candidate}: expected candidate source {args.candidate_sha}")
    for field in ("fixtureId", "profile"):
        if canonical(baseline[field]) != canonical(candidate[field]):
            raise ValueError(f"Captures disagree on {field}")

    pixels = subprocess.run(
        [sys.executable, str(PIXEL_CHECK), "compare", str(baseline_png), str(candidate_png),
         "--diff", str(args.diff)],
        check=False,
        capture_output=True,
        text=True,
    )
    if pixels.returncode not in (0, 1):
        raise ValueError(pixels.stderr.strip() or "Pixel comparison failed")
    pixel_result = json.loads(pixels.stdout)
    viewport = baseline["profile"]["viewport"]
    physical_size = [round(viewport[key] * viewport["scale"]) for key in ("width", "height")]
    for size_field, image in (("baselineSize", baseline_png), ("candidateSize", candidate_png)):
        if pixel_result[size_field] != physical_size:
            raise ValueError(f"{image}: expected screenshot dimensions {physical_size}")

    expected = baseline["trace"]
    observed = candidate["trace"]
    changed_steps = [
        index + 1
        for index, (left, right) in enumerate(zip(expected, observed))
        if canonical(left) != canonical(right)
    ]
    first_missing = min(len(expected), len(observed)) + 1
    changed_steps.extend(range(first_missing, max(len(expected), len(observed)) + 1))
    print(json.dumps({
        "fixtureId": baseline["fixtureId"],
        "baselineSha": baseline["sourceSha"],
        "candidateSha": candidate["sourceSha"],
        "changedSteps": changed_steps,
        "pixels": pixel_result,
    }))
    return int(bool(pixels.returncode or changed_steps))


def main():
    parser = argparse.ArgumentParser(description="Compare Sail migration captures and action traces.")
    commands = parser.add_subparsers(dest="command", required=True)
    digest = commands.add_parser("digest", help="Print the screenshot SHA-256 for a receipt")
    digest.add_argument("screenshot", type=Path)
    diff = commands.add_parser("compare", help="Write a pixel diff and compare ordered action traces")
    diff.add_argument("baseline", type=Path)
    diff.add_argument("candidate", type=Path)
    diff.add_argument("--baseline-sha", required=True)
    diff.add_argument("--candidate-sha", required=True)
    diff.add_argument("--diff", required=True, type=Path, help="New path for the diff PNG")
    args = parser.parse_args()
    try:
        if args.command == "digest":
            print(screenshot_hash(args.screenshot))
            return 0
        return compare(args)
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    sys.exit(main())

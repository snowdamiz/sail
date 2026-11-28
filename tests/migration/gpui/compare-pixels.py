#!/usr/bin/env python3
import argparse
import json
import sys
from functools import reduce
from pathlib import Path

from PIL import Image, ImageChops


def read_png(path):
    with path.open("rb") as source:
        header = source.read(25)
        if len(header) != 25 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
            raise ValueError(f"Expected a PNG screenshot at {path}")
        if header[24] > 8:
            raise ValueError(f"Unsupported bit depth {header[24]} in {path}")
        source.seek(0)
        with Image.open(source) as image:
            if getattr(image, "n_frames", 1) != 1:
                raise ValueError(f"Expected a single-frame PNG at {path}")
            return image.convert("RGBA")


def save_png(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as output:
        image.save(output, format="PNG")


def compare(baseline_path, candidate_path, diff_path):
    baseline = read_png(baseline_path)
    candidate = read_png(candidate_path)
    common = (0, 0, min(baseline.width, candidate.width), min(baseline.height, candidate.height))
    channels = ImageChops.difference(baseline.crop(common), candidate.crop(common)).split()
    changed = reduce(ImageChops.lighter, channels).point(lambda value: 255 if value else 0)

    size = (max(baseline.width, candidate.width), max(baseline.height, candidate.height))
    mask = Image.new("L", size)
    for image in (baseline, candidate):
        mask.paste(255, (0, 0, image.width, image.height))
    mask.paste(changed, (0, 0))
    diff = Image.new("RGBA", size, (255, 0, 255))
    diff.putalpha(mask)
    save_png(diff, diff_path)

    return {
        "baseline": str(baseline_path),
        "candidate": str(candidate_path),
        "diff": str(diff_path),
        "baselineSize": baseline.size,
        "candidateSize": candidate.size,
        "differentPixels": mask.histogram()[255],
        "bounds": mask.getbbox(),
    }


def main():
    parser = argparse.ArgumentParser(description="Compare screenshot PNGs exactly by decoded RGBA pixels.")
    commands = parser.add_subparsers(dest="command", required=True)
    comparison = commands.add_parser("compare", help="Write a diff and fail on any changed pixel")
    comparison.add_argument("baseline", type=Path)
    comparison.add_argument("candidate", type=Path)
    comparison.add_argument("--diff", required=True, type=Path, help="New path for the diff PNG")
    control = commands.add_parser("control", help="Prove a one-pixel change produces a mismatch")
    control.add_argument("baseline", type=Path)
    control.add_argument("--out", required=True, type=Path, help="New directory for the changed PNG and diff")
    args = parser.parse_args()

    try:
        if args.command == "compare":
            result = compare(args.baseline, args.candidate, args.diff)
            print(json.dumps(result))
            return int(result["differentPixels"] != 0)

        image = read_png(args.baseline)
        red, green, blue, alpha = image.getpixel((0, 0))
        image.putpixel((0, 0), (red ^ 1, green, blue, alpha))
        args.out.mkdir(parents=True)
        candidate = args.out / "deliberate-change.png"
        save_png(image, candidate)
        result = compare(args.baseline, candidate, args.out / "diff.png")
        print(json.dumps(result))
        return int(result["differentPixels"] != 1 or result["bounds"] != (0, 0, 1, 1))
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    sys.exit(main())

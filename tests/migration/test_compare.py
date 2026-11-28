import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


CHECK = Path(__file__).with_name("compare.py")
BASELINE_SHA = "1" * 40
CANDIDATE_SHA = "2" * 40


class CaptureComparisonTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.trace = [
            {"action": "openThread", "observed": {"threadTitle": "Compatibility replay"}},
            {"action": "focusComposer", "observed": {"focused": True}},
        ]
        self.baseline = self.capture("baseline", BASELINE_SHA, self.trace)

    def capture(self, name, sha, trace, changed_pixel=False, scale=1):
        directory = self.root / name
        directory.mkdir()
        screenshot = directory / "capture.png"
        image = Image.new("RGB", (8, 8), (100, 100, 100))
        if changed_pixel:
            image.putpixel((0, 0), (101, 100, 100))
        image.save(screenshot)
        receipt = {
            "schemaVersion": 1,
            "fixtureId": "chat-turn",
            "sourceSha": sha,
            "client": name,
            "server": "Node",
            "profile": {
                "surface": "web",
                "platform": "fixture",
                "browser": "Chromium",
                "origin": "server-served",
                "locale": "en",
                "theme": "light",
                "motion": "reduce",
                "fonts": ["Fixture font"],
                "viewport": {"width": 8, "height": 8, "scale": scale, "zoom": 1},
            },
            "trace": trace,
            "screenshotSha256": hashlib.sha256(screenshot.read_bytes()).hexdigest(),
        }
        (directory / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
        return directory

    def compare(self, candidate, name="diff", candidate_sha=CANDIDATE_SHA):
        return subprocess.run(
            [sys.executable, str(CHECK), "compare", str(self.baseline), str(candidate),
             "--baseline-sha", BASELINE_SHA, "--candidate-sha", candidate_sha,
             "--diff", str(self.root / f"{name}.png")],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_equivalent_pixels_and_actions_pass_twice(self):
        candidate = self.capture("candidate", CANDIDATE_SHA, self.trace)
        for name in ("first", "second"):
            result = self.compare(candidate, name)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["changedSteps"], [])
            self.assertEqual(receipt["pixels"]["differentPixels"], 0)

    def test_changed_pixel_fails_with_valid_checksum(self):
        candidate = self.capture("candidate", CANDIDATE_SHA, self.trace, changed_pixel=True)
        result = self.compare(candidate)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["pixels"]["differentPixels"], 1)

    def test_wrong_event_and_missing_state_each_fail(self):
        for name, trace in (
            ("wrong", [self.trace[0], {"action": "blurComposer", "observed": {"focused": False}}]),
            ("missing", self.trace[:1]),
        ):
            with self.subTest(name=name):
                candidate = self.capture(name, CANDIDATE_SHA, trace)
                result = self.compare(candidate, name)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(json.loads(result.stdout)["changedSteps"], [2])

    def test_wrong_source_or_screenshot_digest_is_an_error(self):
        candidate = self.capture("candidate", CANDIDATE_SHA, self.trace)
        self.assertIn("expected candidate source", self.compare(candidate, candidate_sha=BASELINE_SHA).stderr)
        (candidate / "capture.png").write_bytes(b"Other file")
        result = self.compare(candidate)
        self.assertEqual(result.returncode, 2)
        self.assertIn("screenshot SHA-256 does not match", result.stderr)

    def test_two_equally_undersized_captures_are_an_error(self):
        self.baseline = self.capture("undersized-baseline", BASELINE_SHA, self.trace, scale=2)
        candidate = self.capture("undersized-candidate", CANDIDATE_SHA, self.trace, scale=2)
        result = self.compare(candidate)
        self.assertEqual(result.returncode, 2)
        self.assertIn("expected screenshot dimensions [16, 16]", result.stderr)


if __name__ == "__main__":
    unittest.main()

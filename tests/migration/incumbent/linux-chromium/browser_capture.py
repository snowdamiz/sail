from hashlib import file_digest
import shutil
import struct


REPLAY_TITLE = "Compatibility replay"
REPLAY_CODE = "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0"
REPLAY_TABLE = [
    ["Step", "Tool", "Result"], ["Read", "read", "1 file"], ["Edit", "edit", "+4 lines"], ["Test", "execute", "12 passed"],
]

PROFILE = r"""{
      browser: navigator.userAgent.match(/Chrome\/[^ ]+/)?.[0],
      locale: document.documentElement.lang,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "standard",
      fonts: [getComputedStyle(document.body).fontFamily],
      viewport: {width: innerWidth, height: innerHeight, scale: devicePixelRatio, zoom: visualViewport.scale},
    }"""
SETTLE = """(async () => {
  document.activeElement?.blur();
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const animations = document.getAnimations().filter(animation =>
    animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)
  );
  await Promise.allSettled(animations.map(animation => animation.finished));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
})()"""


def snapshot(root, call, tab, state, observation, *, dimensions=(1280, 1200)):
    directory = root / state
    directory.mkdir()
    path = directory / "capture.png"
    screenshot = call("preview_snapshot", **tab, save=True)
    shutil.copyfile(screenshot["screenshotPath"], path)
    with path.open("rb") as source:
        size = struct.unpack(">II", source.read(24)[16:24])
        assert size == dimensions, (size, dimensions)
        source.seek(0)
        observation["screenshotSha256"] = file_digest(source, "sha256").hexdigest()
    return observation

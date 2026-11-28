import json
import sys

from probe import (
    CODE, OBSERVE, OUT, TABLE, capture_window, click, command, navigate, require, resize_window, run,
    selector, settle_layout, wait_for,
)


SIDEBAR = '[aria-label="Toggle main sidebar"]'
ENGLISH_ATTACH = "Attach files"
GERMAN_ATTACH = "Dateien anhängen"


def choose_theme(page, child, theme):
    navigate(page, "#/settings/appearance")
    control = selector(f"Use {theme} mode")
    click(page, child, control, f"{theme} theme setting")
    selected = json.dumps(control + '[aria-pressed="true"]')
    expected = json.dumps(theme == "dark")
    wait_for(lambda: page.evaluate(f"""
      location.hash === "#/settings/appearance" && !!document.querySelector({selected})
      && document.documentElement.classList.contains("dark") === {expected}
    """), child, f"selected {theme} theme", seconds=35)
    return {"control": f"Use {theme} mode", "selected": True}


def choose_language(page, child, old_label, option, locale):
    navigate(page, "#/settings/general")
    click(page, child, selector(old_label, '[data-slot="select-trigger"]'), "language selector")
    click(page, child, "[role=option]", option, text=option)
    wait_for(lambda: page.evaluate(f"document.documentElement.lang === {json.dumps(locale)}"),
             child, "selected language", seconds=35)
    return {"control": old_label, "selected": option}


def native_zoom(page, child, window, factor):
    command("xdotool", "windowfocus", window)
    command("xdotool", "key", "--clearmodifiers", "ctrl+0")
    wait_for(lambda: page.evaluate("window.desktopBridge.getWindowZoomFactor() === 1"),
             child, "native actual size", seconds=20)
    if factor == 1.2:
        command("xdotool", "key", "--clearmodifiers", "ctrl+equal", "ctrl+equal")
    wait_for(lambda: page.evaluate(f"Math.abs(window.desktopBridge.getWindowZoomFactor() - {factor}) < 0.001"),
             child, f"native zoom {factor}", seconds=20)


def toggle_sidebar(page, child, window, compact):
    click(page, child, SIDEBAR, "Toggle main sidebar")
    opened = ('[data-slot="sidebar"][data-mobile="true"][data-open]' if compact else
              '[data-slot="sidebar"][data-side="left"][data-state="expanded"]')
    expression = f"!!document.querySelector({json.dumps(opened)})"
    wait_for(lambda: page.evaluate(expression), child, "opened responsive sidebar", seconds=20)
    if compact:
        command("xdotool", "key", "--clearmodifiers", "Escape")
    else:
        click(page, child, SIDEBAR, "Close main sidebar")
    wait_for(lambda: page.evaluate(f"!({expression})"), child, "closed responsive sidebar", seconds=20)
    return {"sidebar": "mobile sheet" if compact else "docked", "closedAfterCheck": True}


def render_profile(page, child, route, window, name, width, zoom, theme, locale, action):
    def ready():
        state = page.evaluate(OBSERVE)
        return state if state["route"] == route and state.get("highlightedCode") and state.get("reply") else None

    wait_for(ready, child, f"{name} Replay view", seconds=45)
    command("xdotool", "mousemove", "1399", "999")
    page.evaluate("""(async () => {
      const sidebar = document.querySelector('[aria-label="Toggle main sidebar"]');
      if (sidebar?.getAttribute("aria-pressed") === "true") sidebar.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const details = document.querySelector('main [aria-label="Toggle thread details panel"]');
      if (details?.getAttribute("aria-pressed") === "true") details.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.activeElement?.blur();
    })()""")
    for current in (width + 2, width):
        resize_window(page, child, window, current, 780)
    settle_layout(page)
    state = ready()
    require(state and state["theme"] == theme and state["locale"] == locale
            and not state["composerFocused"] and not state["menuOpen"] and not state["sidebarOpen"]
            and state["title"] == "Compatibility replay" and state["code"] == CODE and state["table"] == TABLE,
            f"Unexpected settled {name} thread or display state")
    attach = GERMAN_ATTACH if locale == "de" else ENGLISH_ATTACH
    wait_for(lambda: page.evaluate(f"!!document.querySelector({json.dumps(selector(attach))})"), child,
             f"localized attachment control {attach}", seconds=12)
    measured = page.evaluate(f"""({{
      zoom: window.desktopBridge.getWindowZoomFactor(),
      compact: matchMedia("(max-width: 767px)").matches,
      attachmentControl: document.querySelector({json.dumps(selector(attach))})?.ariaLabel
    }})""")
    require(abs(measured["zoom"] - zoom) < 0.001 and measured["compact"] == (name == "compact")
            and measured.get("attachmentControl") == attach and abs(state["viewport"]["scale"] - zoom) < 0.001,
            f"Incorrect live zoom, breakpoint or attachment label for {name}: {measured!r}, {state['viewport']!r}")
    chat = {key: state[key] for key in ("title", "reply", "code", "highlightedCode", "table",
                                       "composerFocused", "sidebarOpen", "detailsOpen", "menuOpen")}
    profile = {"locale": locale, "theme": theme, "motion": state["motion"], "fonts": state["fonts"],
               "viewport": {"width": width, "height": 780, "scale": 1, "zoom": zoom}}
    directory = OUT / name
    directory.mkdir()
    screenshot = capture_window(window, (width, 780), directory / "capture.png")
    return {"profile": profile, "action": action, "chat": chat, "rendererViewport": state["viewport"],
            **measured, "screenshotSha256": screenshot}


def capture_variants(page, child, route, window):
    command("xdotool", "windowmove", window, "0", "0")
    variants = {}
    for theme in ("light", "dark"):
        action = choose_theme(page, child, theme)
        navigate(page, route)
        variants[theme] = render_profile(page, child, route, window, theme, 1100, 1, theme, "en", action)
    choose_theme(page, child, "light")
    navigate(page, route)
    native_zoom(page, child, window, 1.2)
    variants["zoomed"] = render_profile(page, child, route, window, "zoomed", 1100, 1.2, "light", "en",
                                       {"accelerators": ["Ctrl+0", "Ctrl+=", "Ctrl+="]})
    native_zoom(page, child, window, 1)
    action = choose_language(page, child, "Language", "Deutsch", "de")
    navigate(page, route)
    variants["translated"] = render_profile(page, child, route, window, "translated", 1100, 1, "light", "de", action)
    choose_language(page, child, "Sprache", "English", "en")
    navigate(page, route)
    for name, width in (("compact", 640), ("wide", 1280)):
        resize_window(page, child, window, width, 780)
        action = toggle_sidebar(page, child, window, compact=name == "compact")
        variants[name] = render_profile(page, child, route, window, name, width, 1, "light", "en", action)
    return {"displayCaptures": variants}


if __name__ == "__main__":
    run(*sys.argv[1:], capture_variants=capture_variants)

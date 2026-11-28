import json
import sys
from urllib.parse import quote

from probe import (
    CODE, INPUT, OBSERVE, OUT, TABLE, capture_window, click, command, navigate, require, resize_window, run,
    selector, settle_layout, wait_for,
)


TITLE = "Compatibility replay"
SOURCE = "Navigation source"
PALETTE = 'input[placeholder="Search commands, projects, and threads..."]'
LINK = selector(f"Thread, {TITLE}", "a")


def open_source(page, child, route):
    navigate(page, route)
    wait_for(lambda: page.evaluate(f"""
      location.hash === {json.dumps(route)} &&
      document.querySelector("main h2")?.textContent === {json.dumps(SOURCE)}
    """), child, "distinct source thread", seconds=45)


def click_link(page, child, destination):
    wait_for(lambda: page.evaluate(f"""
      document.querySelector({json.dumps(LINK)})?.hash === {json.dumps(destination)}
    """), child, "rendered link to the saved destination", seconds=35)
    click(page, child, LINK, "chat thread link")
    return {"sourceTitle": SOURCE, "linkLabel": f"Thread, {TITLE}",
            "clickedDestinationLink": True}


def use_palette(page, child, window):
    command("xdotool", "windowfocus", window)
    command("xdotool", "key", "--clearmodifiers", "ctrl+k")
    active_input = f"document.activeElement?.matches({json.dumps(PALETTE)})"
    wait_for(lambda: page.evaluate(active_input), child, "focused command palette", seconds=25)
    command("xdotool", "type", "--clearmodifiers", TITLE)
    wait_for(lambda: page.evaluate(f"""
      {active_input} && document.activeElement.value === {json.dumps(TITLE)}
    """), child, "palette search query", seconds=20)
    selected = """(() => {
      const input = document.querySelector(%s);
      const id = input?.getAttribute("aria-activedescendant");
      const result = id ? document.getElementById(id) : null;
      return !!result?.matches("[role=option]") && [...result.querySelectorAll("span")].some(
        label => label.textContent.trim() === %s
      );
    })()""" % (json.dumps(PALETTE), json.dumps(TITLE))
    wait_for(lambda: page.evaluate(selected), child, "highlighted saved thread in palette", seconds=25)
    command("xdotool", "key", "--clearmodifiers", "Return")
    return {"sourceTitle": SOURCE, "accelerator": "Ctrl+K", "query": TITLE,
            "highlightedResult": TITLE, "selection": "Enter"}


def capture_destination(page, child, route, window, fixture, action):
    def observe():
        state = page.evaluate(OBSERVE)
        if (state.get("route") == route and state.get("title") == TITLE
                and state.get("highlightedCode") and state.get("reply")):
            return state
        return None

    def focused():
        state = observe()
        if not state or not state["composerFocused"] or not state["windowFocused"]:
            return None
        return page.evaluate("document.activeElement?.getAttribute('aria-label')")

    focus = wait_for(focused, child, f"{fixture} focused destination composer", seconds=45)
    require(focus == f"Message {TITLE}", "Destination focus does not identify the seeded thread")
    command("xdotool", "mousemove", "1399", "999")
    page.evaluate("document.activeElement?.blur()")
    for width in (1101, 1100):
        resize_window(page, child, window, width, 780)
    settle_layout(page)
    state = observe()
    require(state and state["table"] == TABLE and state["code"] == CODE and not state["menuOpen"]
            and not state["sidebarOpen"] and not state["detailsOpen"]
            and state["theme"] == "light" and state["locale"] == "en"
            and state["viewport"] == {"width": 1100, "height": 780, "scale": 1, "zoom": 1},
            "Navigation changed the settled destination or display profile")
    require(not page.evaluate("!!document.querySelector(" + json.dumps(PALETTE) + ")"),
            "Palette remained open after selection")
    directory = OUT / fixture
    directory.mkdir()
    return {
        "action": action,
        "profile": {key: state[key] for key in ("locale", "theme", "motion", "fonts", "viewport")},
        "destination": {"sameSavedRoute": True, "title": TITLE, "focus": focus,
                        "windowFocusedOnArrival": True, "paletteClosed": True,
                        "reply": state["reply"], "code": state["code"], "table": state["table"]},
        "screenshotSha256": capture_window(window, (1100, 780), directory / "capture.png"),
    }


def capture_entrypoints(page, child, route, window):
    source_id = (INPUT / "source-thread-id").read_text().strip()
    source_route = route.rsplit("/", 1)[0] + "/" + quote(source_id, safe="")
    require(source_id and source_route != route, "Expected a separate navigation source thread")
    captures = {}
    for fixture in ("chat-link", "palette-link"):
        open_source(page, child, source_route)
        action = click_link(page, child, route) if fixture == "chat-link" else use_palette(page, child, window)
        captures[fixture] = capture_destination(page, child, route, window, fixture, action)
    return {"entrypointCaptures": captures}


if __name__ == "__main__":
    run(*sys.argv[1:], capture_variants=capture_entrypoints)

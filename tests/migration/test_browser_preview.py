from contextlib import nullcontext
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).parent / "incumbent/linux-chromium"))
import browser_preview


class BrowserPreviewTest(unittest.TestCase):
    def test_rejects_replacement_tab_after_releasing_control(self):
        original = {"tabId": "original"}
        replacement = {"tabId": "replacement"}
        statuses = [
            (original, {}),
            (original, {}),
            (replacement, {"control": {"owner": "unclaimed"}}),
        ]
        call = Mock()
        with (
            patch.object(browser_preview, "page_server", return_value=nullcontext("page-digest")),
            patch.object(browser_preview, "provider_path", return_value="/fixture"),
            patch.object(browser_preview, "inner_status", side_effect=statuses),
            patch.object(browser_preview, "capture_panel", return_value={}),
            self.assertRaisesRegex(AssertionError, "Browser panel tab changed after releasing control"),
        ):
            browser_preview.capture_browser_preview(
                Path("/fixture"), {}, call, lambda *_: ({"tabId": "outer"}, None, {})
            )
        self.assertFalse(any(
            arguments.kwargs.get("expression") == browser_preview.EXPRESSION
            for arguments in call.call_args_list
        ))

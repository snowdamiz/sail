import importlib.util
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


PROBE_PATH = Path(__file__).with_name("incumbent") / "runtime" / "check.py"
SPEC = importlib.util.spec_from_file_location("launcher_probe", PROBE_PATH)
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class PairingHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        if self.server.redeemed:
            self.respond(401, {"authenticated": False})
            return
        self.server.redeemed = True
        self.respond(200, {"authenticated": True, "sessionMethod": "browser-session-cookie"},
                     set_cookie=self.server.issue_cookie)

    def do_GET(self):
        authenticated = self.server.accept_cookie and self.headers.get("Cookie") == "sail=fixture"
        body = {"authenticated": authenticated}
        if authenticated:
            body["sessionMethod"] = "browser-session-cookie"
        self.respond(200, body)

    def respond(self, status, body, set_cookie=False):
        self.send_response(status)
        if set_cookie:
            self.send_header("Set-Cookie", "sail=fixture; HttpOnly; Path=/")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, _message, *_args):
        pass


class LauncherCookieTest(unittest.TestCase):
    def redeem(self, issue_cookie, accept_cookie):
        with HTTPServer(("127.0.0.1", 0), PairingHandler) as server:
            server.issue_cookie = issue_cookie
            server.accept_cookie = accept_cookie
            server.redeemed = False
            worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
            worker.start()
            try:
                return PROBE.redeem(server.server_port, "fixture-pairing", one_time=True)
            finally:
                server.shutdown()
                worker.join()

    def test_success_body_without_cookie_fails(self):
        with self.assertRaisesRegex(RuntimeError, "did not set a session cookie"):
            self.redeem(issue_cookie=False, accept_cookie=True)

    def test_issued_cookie_must_authenticate(self):
        with self.assertRaisesRegex(RuntimeError, "did not authenticate"):
            self.redeem(issue_cookie=True, accept_cookie=False)

    def test_receipt_proves_session_without_recording_cookie(self):
        proof = self.redeem(issue_cookie=True, accept_cookie=True)
        self.assertEqual(proof["cookieCheck"], {"path": "/api/auth/session", "status": 200,
                                                "anonymousAuthenticated": False, "authenticated": True})
        self.assertEqual(proof["reuseStatus"], 401)
        self.assertNotIn("sail=fixture", json.dumps(proof))

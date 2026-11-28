from contextlib import closing, contextmanager
from hashlib import sha256
import http.client
import json
import os
import secrets
import subprocess
import time
from uuid import uuid4

from browser_capture import PROFILE, SETTLE, snapshot


ORIGIN = "http://127.0.0.1:47717"
FIXTURE_PORT = 47722
FIXTURE_ORIGIN = f"http://127.0.0.1:{FIXTURE_PORT}"
SETTINGS = "/settings/connections"
LABEL = "P01 simulated older boot service"
REFUSAL = "Server update failed: Simulated boot service. The fixture does not install updates."
REJECTION = {
    "code": "orchestration_protocol_incompatible",
    "message": "Update this client to one that supports orchestration protocol 2.",
    "orchestrationProtocolVersion": 2,
}
STARTED = {"event": "simulated-protocol-1-boot-service", "origin": FIXTURE_ORIGIN}
PAIRED = {"event": "pairing-exchanged"}
SOCKET = {"event": "authenticated-bare-update-socket"}
UPDATE = {"event": "simulated-update-refused", "method": "server.updateServer", "targetVersion": "0.1.17"}
OBSERVE = """(() => {
  const label = [...document.querySelectorAll("p")].find(
    element => element.textContent === "P01 simulated older boot service"
  );
  const row = label?.parentElement?.parentElement;
  const buttons = [...(row?.querySelectorAll("button") ?? [])].filter(button => button.getClientRects().length);
  const supported = buttons.find(button => ["Update", "Retry update"].includes(button.textContent.trim()));
  const box = supported?.getBoundingClientRect();
  const hit = box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return {
    profile: """ + PROFILE + """,
    observed: {
      route: location.pathname,
      label: label?.textContent ?? null,
      diagnosis: row?.innerText.includes("Client not supported") ? "Client not supported" : null,
      action: supported?.textContent.trim() ?? null,
      actionEnabled: !!supported && !supported.disabled && supported.getAttribute("aria-disabled") !== "true",
      actionVisible: !!hit && supported.contains(hit),
      refusal: row?.innerText.includes(
        "Server update failed: Simulated boot service. The fixture does not install updates."
      ) ?? false,
      focusedControl: document.activeElement?.textContent.trim() ?? null,
    },
  };
})()"""


def response(port, path):
    with closing(http.client.HTTPConnection("127.0.0.1", port, timeout=5)) as connection:
        connection.request("GET", path)
        reply = connection.getresponse()
        assert reply.getheader("Content-Type").startswith("application/json")
        return reply.status, json.load(reply)


def rejected_protocols():
    rejects = []
    for requested in (None, 1, 3):
        url = "/ws" if requested is None else f"/ws?orchestrationProtocol={requested}"
        status, body = response(47717, url)
        assert status == 426 and body == REJECTION
        rejects.append({"requested": requested, "status": status, "body": body})
    return rejects


def events(log):
    return [json.loads(line) for line in log.read_text().splitlines()]


@contextmanager
def older_host(root):
    code_path = root / "older-host-code.private"
    code = "".join(secrets.choice("23456789ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(12))
    code_path.write_text(code)
    log = root / "older-host-events.jsonl"
    with log.open("w") as output, subprocess.Popen(
        ["node", "/fixture/version-rejection/fixture.mjs", ORIGIN, code_path, str(FIXTURE_PORT)],
        env=os.environ | {"SAIL_MIGRATION_WS_MODULE": "/usr/share/nodejs/ws"},
        stdout=output, stderr=subprocess.STDOUT,
    ) as simulator:
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and simulator.poll() is None:
                if log.stat().st_size:
                    assert events(log) == [STARTED]
                    yield code, log
                    return
                time.sleep(0.1)
            raise RuntimeError("The simulated boot service did not start")
        finally:
            if simulator.poll() is None:
                simulator.terminate()
                try:
                    simulator.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    simulator.kill()
                    simulator.wait()


def view(call, tab, action, refusal):
    call("preview_act", **tab, action="hover", x=1, y=45)
    call("preview_evaluate", **tab, expression=SETTLE)
    call(
        "preview_evaluate", **tab,
        expression="""(() => {
          const p = [...document.querySelectorAll("p")].find(node => node.textContent === "P01 simulated older boot service");
          const row = p?.parentElement?.parentElement;
          [...row.querySelectorAll("button")].find(button => button.textContent.trim() === "Routes")
            .focus({preventScroll: true});
        })()""",
    )
    value = call("preview_evaluate", **tab, expression=OBSERVE)["value"]
    assert value["observed"] == {
        "route": SETTINGS, "label": LABEL, "diagnosis": "Client not supported", "action": action,
        "actionEnabled": True, "actionVisible": True, "refusal": refusal, "focusedControl": "Routes",
    }, value["observed"]
    return value


def dismiss_notification(call, tab, title):
    notification = f'div[data-position]:has([data-slot="toast-title"]:has-text("{title}"))'
    call("preview_act", **tab, action="click", selector=notification + ' [data-slot="toast-close"]')


def capture_version_rejection(root, source, call, prepare):
    rejects = rejected_protocols()
    with older_host(root) as (code, log):
        status, descriptor = response(FIXTURE_PORT, "/.well-known/t3/environment")
        assert status == 200 and descriptor["label"] == LABEL
        assert descriptor["orchestrationProtocolVersion"] == 1
        assert descriptor["capabilities"]["serverSelfUpdate"] == "boot-service"
        tab, _, identity = prepare(call, source)
        assert call("preview_evaluate", **tab, expression="navigator.onLine")["value"] is True
        call("preview_navigate", **tab, url=ORIGIN + SETTINGS)
        call("preview_act", **tab, action="click", selector='button[aria-label="Add environment"]')
        call("preview_act", **tab, action="click", selector='[role="dialog"] button:has-text("Remote link")')
        call("preview_act", **tab, action="type", selector='[placeholder="backend.example.com"]', text=FIXTURE_ORIGIN)
        call("preview_act", **tab, action="type", selector='[placeholder="PAIRCODE"]', text=code)
        call("preview_act", **tab, action="press", key="Tab")
        submit = call(
            "preview_evaluate", **tab,
            expression='document.activeElement?.tagName === "BUTTON" && document.activeElement.textContent.trim()',
        )["value"]
        assert submit == "Add environment"
        call("preview_act", **tab, action="press", key="Enter")
        call("preview_wait_for", **tab, text=LABEL)
        row = f'div.grid:has(> div > p:has-text("{LABEL}"))'
        update_button = row + ' button:has-text("Update")'
        call("preview_wait_for", **tab, selector=update_button)
        dismiss_notification(call, tab, "Backend added")
        before = snapshot(root, call, tab, "exact-version-rejected", view(call, tab, "Update", False))
        before_events = events(log)
        assert before_events == [STARTED, PAIRED]

        call("preview_act", **tab, action="click", selector=update_button)
        call("preview_wait_for", **tab, text="Retry update")
        call("preview_wait_for", **tab, text=REFUSAL)
        dismiss_notification(call, tab, f"{LABEL} server update failed")
        after = snapshot(root, call, tab, "retry-update", view(call, tab, "Retry update", True))
        after_events = events(log)
        assert after_events == [STARTED, PAIRED, SOCKET, UPDATE]
        assert response(FIXTURE_PORT, "/.well-known/t3/environment") == (status, descriptor)

    runtime = json.loads((root / "state/userdata/server-runtime.json").read_text())
    receipt = {
        "schemaVersion": 1, "captureRunId": str(uuid4()), "sourceSha": source["sourceSha"],
        "packageSha256": source["archiveSha256"], "arch": "arm64", "osVersion": identity["distribution"],
        "browser": identity["browser"], "pairing": identity["pairing"],
        "browserOnline": True,
        "runtimeOwnerSha256": sha256(runtime["ownerId"].encode()).hexdigest(),
        "publishedHttp": rejects,
        "simulatedHost": {"protocol": descriptor["orchestrationProtocolVersion"],
                          "mode": descriptor["capabilities"]["serverSelfUpdate"],
                          "version": descriptor["serverVersion"], "label": LABEL, "descriptorUnchanged": True},
        "beforeUpdateEvents": before_events,
        "afterUpdateEvents": after_events,
        "versionStates": {"exact-version-rejected": before, "retry-update": after},
    }
    (root / "state.json").write_text(json.dumps(receipt, indent=2) + "\n")

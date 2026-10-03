"""/device declaration and heartbeat leases (contract 2026-10-01.1)."""

from __future__ import annotations

import hashlib
import time


from hardwareharness_device_sdk import (
    CONTRACT_REVISION,
    __version__,
    function,
    single_connector_pinout,
)
from hardwareharness_device_sdk import lease as lease_rules
from hardwareharness_device_sdk.manifest import canonical_json
from hardwareharness_device_sdk.testing import check_device, serve

from sdk_demo import DemoDevice

class Pinned(DemoDevice):
    hardware_revision = "B1"

    def pinout(self):
        outputs = {index + 1: (function(f"DO{index}", "output", "ttl", channel_kind="DO", channel_index=index),)
                   for index in range(4)}
        return single_connector_pinout(self.hardware_id, self.manufacturer, self.model, 5, outputs, "demo manual")


def test_device_declaration_shape(hh):
    assert hh.get("/device", token="").status_code == 401
    document = hh.get("/device").json()
    assert list(document)[0] == "manifestRevision"
    assert document["contractRevision"] == CONTRACT_REVISION
    assert document["identity"] == {"serverId": "DEMO1_MCP", "hardwareId": "DEMO1_1", "manufacturer": "Acme",
                                    "model": "DEMO-1", "adapter": {"name": "sdk_demo", "version": "1.2.3"},
                                    "sdkVersion": __version__, "dryRun": True}
    assert document["description"].startswith("Demo board")
    assert document["pinout"] is None
    assert document["streams"] == [
        {"id": "di", "type": "bits", "width": 4, "bitLabels": ["DI0", "DI1", "DI2", "DI3"], "rateHz": 50.0},
        {"id": "ai0", "type": "scalar", "unit": "V", "rateHz": 50.0, "label": "AI0"},
        {"id": "scope", "type": "block", "rateHz": 20.0},
        {"id": "do", "type": "bits", "width": 4, "kind": "setpoint"},
        {"id": "serial1", "type": "bytes", "writable": True},
        {"id": "cam", "type": "blob"}]
    tools = {item["name"]: item["kind"] for item in document["tools"]}
    assert set(tools) == set(hh.tools)
    assert tools["demo_set_level"] == "actuate" and tools["demo_safe_state"] == "safe"
    assert tools["demo_configure"] == "configure" and tools["demo_read_level"] == "read"
    assert tools["lease_acquire"] == "internal" and tools["hardwareharness_prepare_shutdown"] == "internal"
    assert tools["lease_status"] == "read" and tools["get_server_info"] == "read"
    assert document["capabilities"]["declarationPath"] == "/device"


def test_manifest_revision_is_sha256_of_canonical_body(hh):
    document = hh.get("/device").json()
    revision = document.pop("manifestRevision")
    assert revision == "sha256:" + hashlib.sha256(canonical_json(document)).hexdigest()
    assert hh.get("/device").json()["manifestRevision"] == revision
    assert hh.client.get("/health").json()["manifestRevision"] == revision


def test_device_declaration_with_pinout():
    with serve(Pinned) as hh:
        document = hh.get("/device").json()
        assert document["identity"]["hardwareRevision"] == "B1"
        assert document["pinout"]["connectors"][0]["pinIds"][0] == "DEMO1_1.CN1.1"
    assert check_device(Pinned) == []


# --- leases -------------------------------------------------------------
HOLDER = {"terminalId": "term-1", "user": "alice", "host": "bench-pc", "label": "run 42"}


def test_lease_acquire_is_idempotent_per_terminal(hh):
    grant = hh.call("lease_acquire", holder=HOLDER)["data"]
    assert set(grant) == {"leaseId", "holder", "acquiredAt", "heartbeatIntervalMs", "timeoutMs"}
    assert grant["holder"] == HOLDER and grant["heartbeatIntervalMs"] == 2000 and grant["timeoutMs"] == 10_000
    again = hh.call("lease_acquire", holder="term-1")["data"]
    assert again["leaseId"] == grant["leaseId"] and again["holder"] == {"terminalId": "term-1"}
    status = hh.call("lease_status")["data"]
    assert status["held"] and status["holder"] == {"terminalId": "term-1"} and "leaseId" not in status
    assert set(status) == {"held", "holder", "acquiredAt", "lastHeartbeatAt"}
    busy = hh.call("lease_acquire", holder={"terminalId": "term-2", "user": "bob"})
    assert busy["error"]["category"] == "busy" and busy["error"]["details"]["holder"]["terminalId"] == "term-1"
    assert hh.call("lease_acquire", holder={"terminalId": "t", "extra": "x"})["ok"] is False


def test_lease_guards_configure_and_actuate(hh):
    lease_id = hh.call("lease_acquire", holder=HOLDER)["data"]["leaseId"]
    refused = hh.call("set_level", channel=0, level=True)
    assert refused["error"]["category"] == "busy" and refused["error"]["details"]["holder"] == HOLDER
    assert hh.service.device.levels[0] is False
    assert hh.call("set_level", {"leaseId": lease_id}, channel=0, level=True)["ok"]
    assert hh.call("read_level", channel=0)["ok"] and hh.call("safe_state")["ok"]
    beat = hh.call("lease_heartbeat", leaseId=lease_id)["data"]
    assert beat["leaseId"] == lease_id and beat["lastHeartbeatAt"] > 0
    assert hh.call("lease_heartbeat", leaseId="lease-other")["error"]["category"] == "busy"
    assert hh.call("lease_release", leaseId="lease-other")["error"]["category"] == "busy"
    assert hh.call("set_level", channel=0, level=True)["error"]["category"] == "busy"


def test_lease_release_and_force_release_drive_safe_state(hh):
    device = hh.service.device
    lease_id = hh.call("lease_acquire", holder=HOLDER)["data"]["leaseId"]
    hh.call("set_level", {"leaseId": lease_id}, channel=2, level=True)
    before = device.safe_calls
    ended = hh.call("lease_release", leaseId=lease_id)["data"]
    assert ended == {"held": False, "released": True, "holder": HOLDER,
                     "safeResult": [{"hardwareId": "DEMO1_1", "safeResult": {"safe": True}}]}
    assert device.safe_calls == before + 1 and device.levels == [False] * 4
    assert hh.call("lease_heartbeat", leaseId=lease_id)["error"]["category"] == "busy"
    stale = hh.call("set_level", {"leaseId": lease_id}, channel=0, level=True)
    assert stale["error"]["category"] == "busy"
    assert hh.call("lease_release", leaseId=lease_id)["data"] == {"held": False, "released": False}
    assert hh.call("set_level", channel=0, level=True)["ok"]  # a free device accepts calls without a lease

    hh.call("lease_acquire", holder=HOLDER)
    forced = hh.call("lease_force_release", reason="operator took over")["data"]
    assert forced["released"] and forced["holder"] == HOLDER and device.safe_calls == before + 2
    assert hh.call("lease_status")["data"] == {"held": False}
    assert hh.call("lease_force_release", reason="again")["data"] == {"held": False, "released": False}
    assert hh.call_raw("lease_force_release", reason="")["isError"] is True  # a reason is required


def test_lease_times_out_without_heartbeat_and_drives_safe_state(hh, monkeypatch):
    monkeypatch.setattr(lease_rules, "LEASE_TIMEOUT_MS", 300)
    device = hh.service.device
    grant = hh.call("lease_acquire", holder=HOLDER)["data"]
    assert grant["timeoutMs"] == 300
    hh.call("set_level", {"leaseId": grant["leaseId"]}, channel=3, level=True)
    for _ in range(6):  # any call carrying _meta.leaseId is a heartbeat
        time.sleep(0.1)
        assert hh.call("read_level", {"leaseId": grant["leaseId"]}, channel=3)["ok"]
    assert hh.call("lease_status")["data"]["held"] is True
    before = device.safe_calls
    deadline = time.monotonic() + 3
    while device.safe_calls == before and time.monotonic() < deadline:
        time.sleep(0.02)
    assert device.safe_calls == before + 1 and device.levels == [False] * 4
    assert hh.call("lease_status")["data"] == {"held": False}
    assert hh.call("lease_heartbeat", leaseId=grant["leaseId"])["error"]["category"] == "busy"
    assert hh.call("lease_acquire", holder="term-2")["ok"]

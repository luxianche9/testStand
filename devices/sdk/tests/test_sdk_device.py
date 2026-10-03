"""/device declaration (contract 2026-10-01.1)."""

from __future__ import annotations

import hashlib

from teststand_device_sdk import (
    CONTRACT_REVISION,
    __version__,
    function,
    single_connector_pinout,
)
from teststand_device_sdk.manifest import canonical_json
from teststand_device_sdk.testing import check_device, serve

from sdk_demo import DemoDevice

class Pinned(DemoDevice):
    hardware_revision = "B1"

    def pinout(self):
        outputs = {index + 1: (function(f"DO{index}", "output", "ttl", channel_kind="DO", channel_index=index),)
                   for index in range(4)}
        return single_connector_pinout(self.hardware_id, self.manufacturer, self.model, 5, outputs, "demo manual")


def test_device_declaration_shape(hh):
    document = hh.device()
    assert list(document)[0] == "manifestRevision"
    assert document["contractRevision"] == CONTRACT_REVISION
    assert document["identity"] == {"deviceId": "DEMO1_MCP", "hardwareId": "DEMO1_1", "manufacturer": "Acme",
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
    assert tools["teststand_prepare_shutdown"] == "internal" and tools["get_device_info"] == "read"
    assert document["capabilities"]["declarationPath"] == "/device"


def test_manifest_revision_is_sha256_of_canonical_body(hh):
    document = hh.device()
    revision = document.pop("manifestRevision")
    assert revision == "sha256:" + hashlib.sha256(canonical_json(document)).hexdigest()
    assert hh.device()["manifestRevision"] == revision


def test_device_declaration_with_pinout():
    with serve(Pinned) as hh:
        document = hh.device()
        assert document["identity"]["hardwareRevision"] == "B1"
        assert document["pinout"]["connectors"][0]["pinIds"][0] == "DEMO1_1.CN1.1"
    assert check_device(Pinned) == []

from __future__ import annotations

import pytest

from hardwareharness_device_sdk.testing import check_device, receive_until, serve
from hh_adapter_pci1762 import DEVICE, Pci1762
from hh_adapter_pci1762.pinout import pinout

PUBLIC_TOOLS = {
    "get_server_info", "list_hardware", "get_hardware_info", "get_pinout", "list_streams", "get_panel",
    "pci1762_set_relay", "pci1762_set_bank", "pci1762_read_bit", "pci1762_safe_state",
    "pci1762_stream_read", "pci1762_stream_start", "pci1762_stream_stop",
}


@pytest.fixture
def hh():
    with serve(Pci1762) as harness:
        yield harness


def test_entry_point_and_compliance():
    assert DEVICE is Pci1762
    assert check_device(Pci1762) == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["hardwareharness"]["kind"] == "internal"}
    assert internal == {"hardwareharness_prepare_shutdown"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    for name in ("pci1762_set_relay", "pci1762_set_bank"):
        semantics = hh.tools[name]["_meta"]["hardwareharness"]["operationSemantics"]
        assert semantics["retry"] == "never_after_dispatch"
        assert semantics["safetyAction"] == {"toolName": "pci1762_safe_state", "arguments": {}}
    kind = hh.tools["pci1762_read_bit"]["inputSchema"]["properties"]["kind"]
    assert kind["pattern"] == "^(?i:DI|DO|RELAY)$"
    mask = hh.tools["pci1762_set_bank"]["inputSchema"]["properties"]["mask"]
    assert (mask["minimum"], mask["maximum"]) == (0, 65535)


@pytest.mark.parametrize("arguments", [{"channel": 16, "closed": True}, {"channel": -1, "closed": False}])
def test_invalid_relay_rejected(hh, arguments):
    before = len(hh.service.device.cli.commands)
    result = hh.mcp.call_raw("pci1762_set_relay", {"hardwareId": hh.hardware_id, **arguments})
    assert result.get("isError") or not result["structuredContent"]["ok"]
    assert len(hh.service.device.cli.commands) == before


def test_relay_readback_and_stream(hh):
    assert hh.call("set_relay", channel=9, closed=True)["data"] == {"channel": 9, "closed": True, "port": 1, "bit": 1}
    assert hh.call("read_bit", channel=9, kind="relay")["data"]["value"] is True
    assert hh.call("read_bit", channel=9, kind="DO")["data"]["value"] is True
    assert hh.call("read_bit", channel=9)["data"]["value"] is False
    with hh.websocket("relay") as socket:
        batch = receive_until(socket, lambda frame: frame["type"] == "batch")
        assert batch["items"][-1]["value"] == 1 << 9
    assert hh.call("set_bank", mask=0x8001)["data"] == {"mask": 0x8001}
    assert hh.call("safe_state")["data"] == {"relays": "all_open"}
    assert hh.call("read_bit", channel=0, kind="RELAY")["data"]["value"] is False


def test_capability_details(hh):
    details = hh.call("get_hardware_info")["data"]["capabilityDetails"]
    assert details["bankAtomic"] is False and details["contactContinuityMeasurement"] is False


def test_panel_references(hh):
    items = {item["id"]: item for item in hh.call("get_panel")["data"]["items"]}
    assert items["relay0"]["write"]["tool"] == "pci1762_set_relay" and items["relay0"]["confirm"]
    assert items["relay0"]["pins"] == [f"{hh.hardware_id}.CN1.21", f"{hh.hardware_id}.CN1.20"]
    assert len(items["di"]["pins"]) == 16


def test_pinout():
    data = pinout("PC1_MCP.PCI1762_CARD_0")
    assert len(data.pins) == 62 and len({pin.pinId for pin in data.pins}) == 62
    relays = {pin.functions[0].channelIndex for pin in data.pins if pin.functions[0].channelKind == "relay"}
    assert relays == set(range(16))

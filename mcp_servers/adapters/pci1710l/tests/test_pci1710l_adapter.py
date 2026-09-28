from __future__ import annotations

import pytest

from hardwareharness_device_sdk.testing import check_device, dry_run_config, receive_until, serve
from hh_adapter_pci1710l import DEVICE, Pci1710l
from hh_adapter_pci1710l.adapter import configured_safe_mask
from hh_adapter_pci1710l.pinout import pinout

PUBLIC_TOOLS = {
    "get_server_info", "list_hardware", "get_hardware_info", "get_pinout", "list_streams", "get_panel",
    "pci1710l_configure_ai", "pci1710l_read_voltage", "pci1710l_read_bit", "pci1710l_set_level",
    "pci1710l_safe_state", "pci1710l_stream_read", "pci1710l_stream_start", "pci1710l_stream_stop",
}


@pytest.fixture
def hh():
    with serve(Pci1710l) as harness:
        yield harness


def test_entry_point_and_compliance():
    assert DEVICE is Pci1710l
    assert check_device(Pci1710l) == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["hardwareharness"]["kind"] == "internal"}
    assert internal == {"hardwareharness_prepare_shutdown"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    semantics = {name: item["_meta"]["hardwareharness"]["operationSemantics"] for name, item in hh.tools.items()
                 if name.startswith("pci1710l_") and "stream" not in name}
    assert semantics["pci1710l_read_voltage"]["stateRequirements"] == ["analog_input_configured"]
    assert semantics["pci1710l_configure_ai"]["stateEffects"] == ["analog_input_configured"]
    assert semantics["pci1710l_set_level"]["retry"] == "never_after_dispatch"
    assert semantics["pci1710l_read_bit"]["evidenceType"] == "measurement"
    kind = hh.tools["pci1710l_read_bit"]["inputSchema"]["properties"]["kind"]
    assert kind["pattern"] == "^(?i:DI|DO)$" and kind["default"] == "DI"


def test_channel_out_of_range_rejected(hh):
    result = hh.mcp.call_raw("pci1710l_read_bit", {"hardwareId": hh.hardware_id, "channel": 99})
    assert result.get("isError") or not result["structuredContent"]["ok"]


def test_read_voltage_requires_configure(hh):
    failed = hh.call("read_voltage", channel=2)
    assert not failed["ok"] and "data" not in failed
    assert "configure_ai" in failed["error"]["message"]
    configured = hh.call("configure_ai", channel=2, signal_type=1, value_range=2)
    assert configured["data"] == {"channel": 2, "signal_type": 1, "value_range": 2, "signal": "Differential"}
    reading = hh.call("read_voltage", channel=2)["data"]
    assert reading["volts"] == 0.0 and reading["value_range"] == 2


def test_do_readback_and_bitmap_stream(hh):
    assert hh.call("set_level", channel=5, level=True)["data"] == {"channel": 5, "level": True}
    assert hh.call("read_bit", channel=5, kind="do")["data"]["value"] is True
    assert hh.call("read_bit", channel=5)["data"]["value"] is False  # DI is not modelled: reads low
    with hh.websocket("do") as socket:
        batch = receive_until(socket, lambda frame: frame["type"] == "batch")
        assert batch["items"][-1]["value"] == 1 << 5
    assert hh.call("safe_state")["data"] == {"safe_do_mask": 0}


def test_ai_stream_not_configured_then_values(hh):
    with hh.websocket("ai3") as socket:
        status = receive_until(socket, lambda frame: frame["type"] == "status" and frame["state"] == "not_configured")
        assert status["error"]["category"] == "not_configured"
        hh.call("configure_ai", channel=3)
        batch = receive_until(socket, lambda frame: frame["type"] == "batch", limit=500)
        assert batch["items"][0]["value"] == 0.0


def test_ai_noise_is_opt_in(monkeypatch):
    monkeypatch.setenv("HARDWARE_DRY_RUN_AI_NOISE", "1")
    device = Pci1710l(dry_run_config(Pci1710l))
    device.open()
    device.configure_ai(4)
    assert device.read_voltage(4)["volts"] != 0.0


def test_safe_mask_configuration(monkeypatch):
    assert configured_safe_mask({"safeDoMask": "0x10003"}) == 0x0003
    assert configured_safe_mask({"safeDoMask": 7}) == 7
    monkeypatch.setenv("SAFE_DO_MASK", "garbage")
    assert configured_safe_mask({}) == 0
    with serve(Pci1710l, dry_run_config(Pci1710l, settings={"safeDoMask": "0x00F0"})) as harness:
        details = harness.call("get_hardware_info")["data"]["capabilityDetails"]
        assert details["effectiveSafeDoMask"] == 0xF0 and details["safeValueSource"] == "open_session"
        assert harness.call("read_bit", channel=4, kind="DO")["data"]["value"] is True


def test_panel_references(hh):
    items = {item["id"]: item for item in hh.call("get_panel")["data"]["items"]}
    assert items["ai0"]["stream"] == "ai0" and items["ai0"]["read"]["tool"] == "pci1710l_read_voltage"
    assert items["do3"]["write"] == {"tool": "pci1710l_set_level", "args": {"channel": 3, "level": "$value"}}
    assert items["di"]["bits"] == 16


def test_pinout():
    data = pinout("PC1_MCP.PCI1710L_CARD_0")
    assert len(data.pins) == 68 and len({pin.pinId for pin in data.pins}) == 68
    by_position = {pin.position: pin for pin in data.pins}
    for position in (57, 58, 59, 23, 24, 25):
        assert by_position[position].functions[0].direction == "nc"
    assert by_position[68].functions[0].signal == "AI0" and by_position[34].functions[0].signal == "AI1"

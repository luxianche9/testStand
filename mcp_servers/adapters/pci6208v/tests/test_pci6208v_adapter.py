from __future__ import annotations

import math

import pytest

from hardwareharness_device_sdk.testing import check_device, dry_run_config, serve
from hh_adapter_pci6208v import DEVICE, Pci6208v
from hh_adapter_pci6208v.adapter import clamp_volts, configured_safe_volts
from hh_adapter_pci6208v.pinout import pinout

PUBLIC_TOOLS = {
    "get_server_info", "list_hardware", "get_hardware_info", "get_pinout", "list_streams", "get_panel",
    "pci6208v_set_voltage", "pci6208v_read_last", "pci6208v_safe_state",
    "pci6208v_stream_read", "pci6208v_stream_start", "pci6208v_stream_stop",
}


@pytest.fixture
def hh():
    with serve(Pci6208v) as harness:
        yield harness


def test_entry_point_and_compliance():
    assert DEVICE is Pci6208v
    assert check_device(Pci6208v) == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["hardwareharness"]["kind"] == "internal"}
    assert internal == {"hardwareharness_prepare_shutdown"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    semantics = hh.tools["pci6208v_set_voltage"]["_meta"]["hardwareharness"]["operationSemantics"]
    assert semantics["retry"] == "never_after_dispatch"
    assert semantics["safetyAction"]["toolName"] == "pci6208v_safe_state"
    assert hh.tools["pci6208v_read_last"]["_meta"]["hardwareharness"]["operationSemantics"]["evidenceType"] == "software_shadow"
    volts = hh.tools["pci6208v_set_voltage"]["inputSchema"]["properties"]["volts"]
    assert (volts["minimum"], volts["maximum"]) == (-10, 10)


@pytest.mark.parametrize("volts", [float("nan"), float("inf"), float("-inf"), -10.01, 10.01])
def test_invalid_voltage_never_reaches_driver(hh, volts):
    driver = hh.service.device.driver
    before = list(driver.writes)
    result = hh.mcp.call_raw("pci6208v_set_voltage", {"hardwareId": hh.hardware_id, "channel": 0, "volts": volts})
    assert result.get("isError") or not result["structuredContent"]["ok"]
    assert driver.writes == before


@pytest.mark.parametrize("volts", [float("nan"), float("inf"), -10.01, 10.01])
def test_direct_call_rejects_invalid_voltage(volts):
    device = Pci6208v(dry_run_config(Pci6208v))
    device.open()
    with pytest.raises(Exception, match="refused"):
        device.set_voltage(0, volts)
    assert device.driver.writes == []


def test_invalid_channel_rejected(hh):
    result = hh.mcp.call_raw("pci6208v_set_voltage", {"hardwareId": hh.hardware_id, "channel": 8, "volts": 1.0})
    assert result.get("isError") or not result["structuredContent"]["ok"]


def test_write_read_last_and_stream(hh):
    ok = hh.call("set_voltage", channel=3, volts=2.5)
    assert ok["ok"] and "error" not in ok
    assert ok["data"]["channel"] == 3 and ok["data"]["volts"] == 2.5
    assert hh.call("read_last", channel=3)["data"]["volts"] == 2.5
    read = hh.call("stream_read", streamId="ao3", cursor=0)["data"]
    assert read["items"][-1]["value"] == 2.5
    assert read["items"][-1]["source"] == "software_shadow"
    with hh.websocket("ao3", cursor=0) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["unit"] == "V"


def test_read_last_after_safe_state_reports_safe_value(hh):
    # open is followed by safe_state, so every channel has a recorded (safe) write.
    assert hh.call("read_last", channel=0)["data"]["volts"] == 0.0


def test_read_last_refuses_unwritten_channel():
    device = Pci6208v(dry_run_config(Pci6208v))
    device.open()
    with pytest.raises(Exception, match="never written") as caught:
        device.read_last(5)
    assert caught.value.details == {"channel": 5, "last_volts": None}


def test_safe_state_failure_reports_channels():
    device = Pci6208v(dry_run_config(Pci6208v, settings={"safeVolts": 1.5}))
    device.open()
    device.driver.write = lambda handle, channel, volts: -1 if channel in (2, 6) else 0  # type: ignore[method-assign]
    with pytest.raises(Exception, match="2 channel") as caught:
        device.safe_state()
    assert caught.value.details["failures"] == [{"channel": 2, "rc": -1}, {"channel": 6, "rc": -1}]
    assert caught.value.details["safe_volts"] == 1.5


def test_safe_volts_configuration():
    assert configured_safe_volts({"safeVolts": 12}) == 10.0
    assert configured_safe_volts({"safeVolts": "-3.5"}) == -3.5
    for bad in (math.nan, math.inf, -math.inf):
        with pytest.raises(ValueError, match="finite"):
            clamp_volts(bad)
    with pytest.raises(ValueError, match="finite"):
        configured_safe_volts({"safeVolts": "nan"})


def test_capability_details(hh):
    details = hh.call("get_hardware_info")["data"]["capabilityDetails"]
    assert details["outputAdcReadback"] is False
    assert details["effectiveSafeVolts"] == 0.0
    assert details["safeValueSource"] == "open_session"


def test_panel_binds_every_channel(hh):
    items = hh.call("get_panel")["data"]["items"]
    numbers = [item for item in items if item["widget"] == "number"]
    assert [item["stream"] for item in numbers] == [f"ao{n}" for n in range(8)]
    assert all(item["write"]["tool"] == "pci6208v_set_voltage" and item["confirm"] for item in numbers)
    assert numbers[0]["pins"] == [f"{hh.hardware_id}.CN1.19"]


def test_pinout():
    data = pinout("PC1_MCP.PCI6208V_CARD_0")
    assert len(data.pins) == 37
    assert len({pin.pinId for pin in data.pins}) == 37
    by_position = {pin.position: pin for pin in data.pins}
    for position in (9, 12, 15, 18, 27, 30, 33, 36):
        assert by_position[position].functions[0].direction == "nc"
    ao = {pin.functions[0].channelIndex: pin.position for pin in data.pins if pin.functions[0].channelKind == "AO"}
    assert ao == {0: 19, 1: 37, 2: 16, 3: 34, 4: 13, 5: 31, 6: 10, 7: 28}

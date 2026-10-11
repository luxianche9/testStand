from __future__ import annotations

import pytest

from teststand_device_sdk.testing import check_device, dry_run_config, serve
from teststand_adapter_jcxd_da6401 import DEVICE, JcxdDa6401
from teststand_adapter_jcxd_da6401.pinout import AGND_PINS, NC_PINS, ao_positions

PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info", "self_test",
    "da6401_write_voltage", "da6401_set_all", "da6401_read_last", "da6401_safe_state", "da6401_stream_read",
}


@pytest.fixture
def hh():
    with serve(JcxdDa6401) as harness:
        yield harness


def test_entry_point_and_compliance():
    assert DEVICE is JcxdDa6401
    warnings: list[str] = []
    assert check_device(JcxdDa6401, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    semantics = hh.tools["da6401_write_voltage"]["_meta"]["teststand"]["operationSemantics"]
    assert semantics["retry"] == "never_after_dispatch"
    assert semantics["safetyAction"]["toolName"] == "da6401_safe_state"
    channel = hh.tools["da6401_write_voltage"]["inputSchema"]["properties"]["channel"]
    assert (channel["minimum"], channel["maximum"]) == (0, 63)


@pytest.mark.parametrize("volts", [float("nan"), float("inf"), -10.01, 10.01])
def test_invalid_voltage_never_reaches_driver(hh, volts):
    driver = hh.host.device.driver
    before = list(driver.writes)
    result = hh.call_raw("da6401_write_voltage", {"hardwareId": hh.hardware_id, "channel": 0, "volts": volts})
    assert result["ok"] is False
    assert driver.writes == before


def test_write_publishes_setpoint_and_read_last(hh):
    result = hh.call("write_voltage", operation_id="op-1", channel=63, volts=-2.5)
    assert result["data"] == {"channel": 63, "volts": -2.5}
    assert [ref["streamId"] for ref in result["meta"]["streamRefs"]] == ["ao63"]
    assert hh.host.device.driver.values[63] == -2.5
    assert hh.call("read_last", channel=63)["data"]["volts"] == -2.5


def test_read_last_without_a_write_fails():
    device = JcxdDa6401(dry_run_config(JcxdDa6401))
    device.open()
    with pytest.raises(Exception, match="not written"):
        device.read_last(0)


def test_high_range_variant_scales_the_driver_value():
    config = dry_run_config(JcxdDa6401, settings={"outputRangeV": 30})
    device = JcxdDa6401(config)
    device.open()
    device.write_voltage(1, 15.0)
    assert device.driver.values[1] == pytest.approx(5.0)
    with pytest.raises(Exception, match="refused"):
        device.write_voltage(1, 30.5)


def test_safe_state_and_failed_channels(hh):
    hh.call("set_all", volts=3.0)
    driver = hh.host.device.driver
    assert set(driver.values.values()) == {3.0} and len(driver.values) == 64
    assert hh.call("safe_state")["data"] == {"safeVolts": 0.0, "failed": []}
    assert set(driver.values.values()) == {0.0}
    driver.fail_write.add(5)
    result = hh.call_raw("da6401_safe_state", {"hardwareId": hh.hardware_id})
    assert result["ok"] is False and result["error"]["details"]["failed"] == [5]


def test_serial_number_selects_the_card():
    device = JcxdDa6401(dry_run_config(JcxdDa6401, settings={"serialNumber": 637801473}))
    assert device.open()["identity"]["cardId"] == 0
    other = JcxdDa6401(dry_run_config(JcxdDa6401, settings={"serialNumber": 1}))
    with pytest.raises(Exception, match="not found"):
        other.open()


def test_self_test_reads_identity(hh):
    before = list(hh.host.device.driver.writes)
    result = hh.call_raw("self_test", {"hardwareId": hh.hardware_id})
    assert result["ok"] is True
    assert result["data"]["passed"] is True
    assert [check["name"] for check in result["data"]["checks"]][:3] == ["读板卡信息", "板卡类型", "通道数（板卡报告）"]
    assert hh.host.device.driver.writes == before


def test_pinout_matches_the_manual_figure():
    positions = ao_positions()
    assert sorted(positions) == list(range(64))
    spots = {0: 50, 1: 100, 2: 49, 3: 99, 4: 48, 5: 98, 6: 46, 7: 96, 54: 14, 59: 62, 60: 10, 61: 60, 62: 9, 63: 59}
    assert {channel: positions[channel] for channel in spots} == spots
    used = [*positions.values(), *AGND_PINS, *NC_PINS]
    assert sorted(used) == list(range(1, 101))

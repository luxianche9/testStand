from __future__ import annotations

import time

import pytest

from teststand_device_sdk.testing import check_device, dry_run_config, serve
from teststand_adapter_jcxd_rsx8 import DEVICE, JcxdRsx8
from teststand_adapter_jcxd_rsx8.pinout import pins

PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info", "self_test", "rsx8_stream_read", "rsx8_transact",
    "rsx8_configure_port", "rsx8_write_text", "rsx8_write_hex", "rsx8_read_rx", "rsx8_clear_rx", "rsx8_port_info",
    "rsx8_safe_state",
}


@pytest.fixture
def hh():
    with serve(JcxdRsx8) as harness:
        yield harness


@pytest.fixture
def device():
    instance = JcxdRsx8(dry_run_config(JcxdRsx8))
    instance.open()
    yield instance
    instance.close()


def wait_rx(device, channel, size):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        result = device.read_rx(channel)
        if result["bytes"] >= size:
            return result
        time.sleep(0.01)
    raise AssertionError("no RX")


def test_entry_point_and_compliance():
    assert DEVICE is JcxdRsx8
    warnings: list[str] = []
    assert check_device(JcxdRsx8, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS


def test_write_requires_configure(device):
    with pytest.raises(Exception, match="configure_port first"):
        device.write_text(0, "x")


def test_loopback_round_trip_on_stream(device):
    info = device.configure_port(2, 115200)
    assert info["configured"] and info["port"] == "COM5" and info["mode"] == "RS485"
    assert device.write_hex(2, "01 03 00 00 00 0a", clear_rx=True)["bytes"] == 6
    assert wait_rx(device, 2, 6)["hex"] == "01 03 00 00 00 0a"
    device.clear_rx(2)
    assert device.read_rx(2)["bytes"] == 0


def test_rs232_baud_limit():
    instance = JcxdRsx8(dry_run_config(JcxdRsx8, settings={"portMap": "COM3,COM4,COM5,COM6,COM7,COM8,COM9,COM10"}))
    instance.ports[1]["mode"] = "RS232"
    instance.open()
    try:
        with pytest.raises(Exception, match="exceeds 115200"):
            instance.configure_port(1, 230400)
    finally:
        instance.close()


def test_transact_through_the_stream(hh):
    hh.call("configure_port", channel=0, baudrate=9600)
    result = hh.call_raw("rsx8_transact", {"hardwareId": hh.hardware_id, "streamId": "serial0", "data": "aa55", "encoding": "hex",
                                           "expect": "U", "timeoutMs": 500})
    assert result["ok"], result


def test_safe_state_and_self_test(hh):
    hh.call("configure_port", channel=7)
    assert hh.call("safe_state")["data"] == {"flushed": [7]}
    data = hh.call_raw("self_test", {"hardwareId": hh.hardware_id})["data"]
    assert data["passed"] is True, data["checks"]


def test_pinout_matches_the_manual_tables():
    table = pins()
    assert sorted(table) == list(range(1, 69))
    names = {pin: {f.signal for f in functions} for pin, functions in table.items()}
    assert names[33] == {"OUT0-"} and names[34] == {"OUT0+"} and names[67] == {"IN0+"} and names[68] == {"IN0-"}
    assert names[5] == {"OUT7-"} and names[39] == {"IN7+"} and names[3] == {"GD7"} and names[45] == {"VD3"}
    modes = {f.mode for f in table[33]}
    assert modes == {"RS232", "RS422", "RS485"}


def test_expected_modes_are_checked():
    instance = JcxdRsx8(dry_run_config(JcxdRsx8, settings={"expectedModes": "RS422,RS422,RS422,RS422,RS485,RS485,"
                                                                             "RS232,RS232"}))
    instance.open()
    try:
        with instance.io_lock:
            checks = {check.name: check for check in instance.self_test()}
        assert checks["电气模式符合接线"].passed is False
    finally:
        instance.close()

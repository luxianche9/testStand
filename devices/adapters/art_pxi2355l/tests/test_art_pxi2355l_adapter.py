from __future__ import annotations

import pytest

from teststand_device_sdk.testing import check_device, dry_run_config, receive_until, serve
from teststand_adapter_art_pxi2355l import DEVICE, ArtPxi2355l
from teststand_adapter_art_pxi2355l.pinout import signals

PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info", "self_test", "pxi2355_stream_read",
    "pxi2355_write_do", "pxi2355_write_do_mask", "pxi2355_read_do", "pxi2355_read_di", "pxi2355_safe_state",
}


@pytest.fixture
def hh():
    with serve(ArtPxi2355l) as harness:
        yield harness


@pytest.fixture
def device():
    instance = ArtPxi2355l(dry_run_config(ArtPxi2355l))
    instance.open()
    return instance


def test_entry_point_and_compliance():
    assert DEVICE is ArtPxi2355l
    warnings: list[str] = []
    assert check_device(ArtPxi2355l, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    assert hh.tools["pxi2355_write_do"]["_meta"]["teststand"]["operationSemantics"]["safetyAction"]["toolName"] == \
        "pxi2355_safe_state"


def test_write_do_keeps_other_lines_and_reads_back(device):
    device.write_do(0, True)
    assert device.write_do(31, True) == {"mask": (1 << 31) | 1, "on": [0, 31]}
    assert device.write_do(0, False)["on"] == [31]
    assert device.read_do()["mask"] == 1 << 31


def test_write_failure_reports_the_driver_message(device):
    device.driver.fail_write = True
    with pytest.raises(Exception, match="simulated error"):
        device.write_do_mask(5)


def test_di_stream_and_read(hh):
    hh.host.device.driver.di = 0b1001
    assert hh.call("read_di")["data"] == {"mask": 0b1001, "high": [0, 3]}
    with hh.subscribe("di", cursor=0) as events:
        batch = receive_until(events, lambda event: event["type"] == "batch" and event["records"])
    assert batch["records"][-1]["mask"] == 0b1001


def test_safe_state_turns_outputs_off(device):
    device.write_do_mask(0xFFFF)
    assert device.safe_state() == {"mask": 0, "on": []}
    assert device.driver.do == 0


def test_serial_mismatch_is_unreachable():
    device = ArtPxi2355l(dry_run_config(ArtPxi2355l, settings={"serialNumber": 1}))
    with pytest.raises(Exception, match="not found"):
        device.open()


def test_self_test(hh):
    data = hh.call_raw("self_test", {"hardwareId": hh.hardware_id})["data"]
    assert data["passed"] is True, data["checks"]


def test_pinout_matches_the_manual_figure():
    table = signals()
    assert sorted(table) == list(range(1, 101))
    spots = {1: "P0.0", 9: "P0.COM", 13: "P2.0", 25: "NC", 26: "P4.0", 34: "P4.GND", 37: "P4.VCC", 46: "P6.GND",
             50: "P6.+5V", 51: "P1.0", 62: "P1.COM", 74: "P3.COM", 88: "P7.0", 95: "P7.7", 96: "P7.GND",
             100: "P7.+5V"}
    assert {pin: table[pin] for pin in spots} == spots

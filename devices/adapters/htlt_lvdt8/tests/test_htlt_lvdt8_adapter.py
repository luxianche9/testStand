from __future__ import annotations

import pytest

from teststand_device_sdk.testing import check_device, dry_run_config, serve
from teststand_adapter_htlt_lvdt8 import DEVICE, HtltLvdt8
from teststand_adapter_htlt_lvdt8.pinout import signals

PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info", "self_test", "lvdt_stream_read",
    "lvdt_configure_channel", "lvdt_set_position", "lvdt_disable_channel", "lvdt_read_channel", "lvdt_safe_state",
}


@pytest.fixture
def hh():
    with serve(HtltLvdt8) as harness:
        yield harness


@pytest.fixture
def device():
    instance = HtltLvdt8(dry_run_config(HtltLvdt8))
    instance.open()
    return instance


def test_entry_point_and_compliance():
    assert DEVICE is HtltLvdt8
    warnings: list[str] = []
    assert check_device(HtltLvdt8, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    position = hh.tools["lvdt_set_position"]["inputSchema"]["properties"]["position"]
    assert (position["minimum"], position["maximum"]) == (-1, 1)


def test_four_wire_law_with_external_excitation(device):
    device.driver.external[2] = (4.0, 1800.0)
    state = device.set_position(2, 0.5)
    assert state["enabled"] and state["excVrms"] == 4.0
    assert (state["vaVrms"], state["vbVrms"]) == pytest.approx((3.0, 1.0))


def test_two_wire_and_internal_excitation(device):
    device.configure_channel(5, "2-wire", "internal", 2.0, 5.0, 2000.0)
    state = device.set_position(5, 0.5, -0.2)
    assert (state["vaVrms"], state["vbVrms"]) == pytest.approx((5.0, 2.0))
    assert state["positionB"] == -0.2


def test_configure_disables_outputs(device):
    device.driver.external[0] = (5.0, 2000.0)
    device.set_position(0, 1.0)
    state = device.configure_channel(0, "4-wire", "external", 0.5)
    assert state["enabled"] is False and (state["excVrms"], state["vaVrms"], state["vbVrms"]) == (None, None, None)


def test_position_stream_and_excitation_stream(hh):
    hh.host.device.driver.external[1] = (3.5, 2500.0)
    result = hh.call("set_position", operation_id="op-p", channel=1, position=-0.25)
    assert [ref["streamId"] for ref in result["meta"]["streamRefs"]] == ["pos1"]
    with hh.subscribe("exc1", cursor=0) as events:
        batch = None
        while batch is None:
            event = events.receive()
            if event["type"] == "batch" and event["records"]:
                batch = event
    assert batch["records"][-1]["v"] == 3.5


def test_safe_state_disables_everything(device):
    device.driver.external[3] = (5.0, 2000.0)
    device.set_position(3, 0.3)
    assert device.safe_state()["failed"] == []
    assert device.read_channel(3)["vaVrms"] is None


def test_self_test_checks_consistency(device):
    device.driver.external[4] = (5.0, 2000.0)
    device.set_position(4, 0.5)
    with device.io_lock:
        assert all(check.passed for check in device.self_test())
    device.driver.state[4]["tr"] = 2.0
    with device.io_lock:
        checks = {check.name: check for check in device.self_test()}
    assert checks["输出与设定一致"].passed is False


def test_open_by_unknown_serial_fails():
    device = HtltLvdt8(dry_run_config(HtltLvdt8, settings={"serialNumber": 1}))
    with pytest.raises(Exception, match="BOARD_NOT_FOUND_BY_SN"):
        device.open()


def test_pinout_matches_the_manual_table():
    table = signals()
    assert sorted(table) == list(range(1, 63))
    spots = {1: "EXC_0_P", 2: "EXC_0_N", 16: "EXC_7_N", 22: "VA_0_P", 37: "VA_7_N", 43: "VB_0_P", 58: "VB_7_N",
             17: "NC", 21: "NC/GND", 42: "NC/GND", 62: "NC"}
    assert {pin: table[pin] for pin in spots} == spots

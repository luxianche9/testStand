from __future__ import annotations

import pytest

from teststand_device_sdk.testing import check_device, dry_run_config, serve
from teststand_adapter_art_pxi2604 import DEVICE, ArtPxi2604
from teststand_adapter_art_pxi2604.pinout import position, table

PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info", "self_test", "pxi2604_stream_read",
    "pxi2604_set_relay", "pxi2604_set_relays", "pxi2604_read_relays", "pxi2604_safe_state",
}


@pytest.fixture
def hh():
    with serve(ArtPxi2604) as harness:
        yield harness


@pytest.fixture
def device():
    instance = ArtPxi2604(dry_run_config(ArtPxi2604))
    instance.open()
    return instance


def test_entry_point_and_compliance():
    assert DEVICE is ArtPxi2604
    warnings: list[str] = []
    assert check_device(ArtPxi2604, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    relay = hh.tools["pxi2604_set_relay"]["inputSchema"]["properties"]["relay"]
    assert (relay["minimum"], relay["maximum"]) == (0, 39)


def test_set_relay_keeps_others_and_publishes(hh):
    hh.call("set_relay", relay=2, closed=True)
    result = hh.call("set_relay", operation_id="op-k", relay=39, closed=True)
    assert result["data"] == {"mask": (1 << 2) | (1 << 39), "closed": [2, 39]}
    records = hh.call("stream_read", streamId="relays", limit=1)["data"]["records"]
    assert records[-1]["mask"] == (1 << 2) | (1 << 39) and records[-1]["op"] == "op-k"


def test_set_relays_uses_one_call_per_direction(device):
    device.driver.controls.clear()
    assert device.set_relays([0, 1, 20], True)["closed"] == [0, 1, 20]
    assert device.driver.controls == [(("k0", "k1", "k20"), True)]


def test_stuck_relay_is_reported(device):
    device.driver.stuck.add("k7")
    with pytest.raises(Exception, match="relay positions") as caught:
        device.set_relay(7, True)
    assert caught.value.details["differ"] == [7]


def test_safe_state_opens_all(device):
    device.set_relays(list(range(40)), True)
    assert device.safe_state() == {"mask": 0, "closed": []}


def test_wrong_serial_is_unreachable():
    device = ArtPxi2604(dry_run_config(ArtPxi2604, settings={"serialNumber": "123"}))
    with pytest.raises(Exception, match="expected PXI2604"):
        device.open()


def test_self_test_and_wear(device):
    with device.io_lock:
        checks = {check.name: check for check in device.self_test()}
    assert all(check.passed for check in checks.values())
    device.driver.counts["k5"] = 200_000
    with device.io_lock:
        wear = {check.name: check for check in device.self_test()}["继电器动作次数"]
    assert wear.passed is False and wear.measured["relay"] == 5


def test_pinout_matches_the_manual_figure():
    pins = table()
    assert (pins["B32"], pins["C32"], pins["A32"], pins["D32"]) == ("NC0", "COM0", "NC3", "NO0")
    assert (pins["A31"], pins["A30"], pins["B3"], pins["A3"], pins["D3"]) == ("COM3", "NO3", "NC38", "NO39", "NO38")
    assert (pins["A1"], pins["B1"], pins["C1"]) == ("GND", "TRIG_OUT", "TRIG_IN")
    for role in ("NC", "COM", "NO"):
        assert sorted(int(s[len(role):]) for s in pins.values()
                      if s.startswith(role) and s[len(role):].isdigit()) == list(range(40))
    assert (position("A1"), position("A32"), position("B1"), position("D32")) == (1, 32, 33, 128)

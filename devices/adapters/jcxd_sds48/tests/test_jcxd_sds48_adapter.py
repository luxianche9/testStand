from __future__ import annotations

import pytest

from teststand_device_sdk.testing import check_device, dry_run_config, serve
from teststand_adapter_jcxd_sds48 import DEVICE, JcxdSds48
from teststand_adapter_jcxd_sds48.pinout import table

PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info", "self_test", "sds48_stream_read",
    "sds48_set_relay", "sds48_set_relays", "sds48_read_relays", "sds48_safe_state",
}


@pytest.fixture
def hh():
    with serve(JcxdSds48, dry_run_config(JcxdSds48, settings={"settleMs": 0})) as harness:
        yield harness


@pytest.fixture
def device():
    instance = JcxdSds48(dry_run_config(JcxdSds48, settings={"settleMs": 0}))
    instance.open()
    return instance


def test_entry_point_and_compliance():
    assert DEVICE is JcxdSds48
    warnings: list[str] = []
    assert check_device(JcxdSds48, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    semantics = hh.tools["sds48_set_relay"]["_meta"]["teststand"]["operationSemantics"]
    assert semantics["retry"] == "never_after_dispatch"
    assert semantics["safetyAction"]["toolName"] == "sds48_safe_state"
    channel = hh.tools["sds48_set_relay"]["inputSchema"]["properties"]["channel"]
    assert (channel["minimum"], channel["maximum"]) == (0, 47)


def test_set_relay_keeps_the_others_and_publishes(hh):
    hh.call("set_relay", channel=3, energized=True)
    result = hh.call("set_relay", operation_id="op-1", channel=47, energized=True)
    assert result["data"] == {"mask": (1 << 3) | (1 << 47), "energized": [3, 47]}
    records = hh.call("stream_read", streamId="relays", limit=1)["data"]["records"]
    assert records[-1]["mask"] == (1 << 3) | (1 << 47) and records[-1]["op"] == "op-1"
    assert hh.call("set_relay", channel=3, energized=False)["data"]["energized"] == [47]


def test_set_relays_is_one_write(device):
    device.driver.writes.clear()
    assert device.set_relays([0, 12, 24, 36], True)["energized"] == [0, 12, 24, 36]
    assert len(device.driver.writes) == 1
    assert device.set_relays([12, 36], False)["energized"] == [0, 24]


def test_register_mismatch_is_reported(device):
    device.driver.stuck = 1 << 5
    with pytest.raises(Exception, match="register reads") as caught:
        device.set_relay(5, True)
    assert caught.value.details["differ"] == [5]


def test_safe_state_releases_all(device):
    device.set_relays(list(range(48)), True)
    assert device.safe_state() == {"mask": 0, "energized": []}
    assert device.driver.masks[0] == 0


def test_serial_number_selects_the_second_card():
    device = JcxdSds48(dry_run_config(JcxdSds48, settings={"serialNumber": 637797221, "settleMs": 0}))
    assert device.open()["identity"]["cardId"] == 1
    device.set_relay(1, True)
    assert device.driver.masks == [0, 2]


def test_self_test_reads_registers_only(hh):
    hh.call("set_relay", channel=9, energized=True)
    writes = list(hh.host.device.driver.writes)
    data = hh.call_raw("self_test", {"hardwareId": hh.hardware_id})["data"]
    assert data["passed"] is True, data["checks"]
    assert hh.host.device.driver.writes == writes


def test_pinout_matches_the_manual_tables():
    con1, con2 = table("CON1"), table("CON2")
    assert len(con1) == len(con2) == 74
    assert (con1[1], con1[3], con1[21], con1[40], con1[57], con1[60], con1[74]) == (
        "OT_COM0", "OT_CL24", "OT_CL0", "NC", "OT_OP30", "OT_COM11", "OT_CL30")
    assert (con2[1], con2[3], con2[41], con2[43], con2[57], con2[74]) == (
        "OT_COM36", "OT_CL12", "OT_COM23", "OT_CL47", "OT_OP18", "OT_CL18")
    signals = [*con1.values(), *con2.values()]
    for role in ("COM", "OP", "CL"):
        assert sorted(int(s[3 + len(role):]) for s in signals if s.startswith(f"OT_{role}")) == list(range(48))

from __future__ import annotations

import pytest
from teststand_device_sdk.testing import check_device, dry_run_config, serve
from teststand_adapter_lj_co8 import DEVICE, LjCo8
from teststand_adapter_lj_co8.pinout import in_pin, out_pin
from teststand_adapter_lj_co8.sim import SIM_RESOURCE, SIM_SERIAL

PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info",
    "co8_set_capacitance", "co8_set_all", "co8_read_last", "co8_safe_state",
    "co8_stream_read", "self_test",
}


@pytest.fixture
def hh():
    with serve(LjCo8) as harness:
        yield harness


def set_commands(device: LjCo8) -> list[dict]:
    return [command for command in device.cli.commands if command["cmd"] in ("set_cap", "set_all")]


def test_entry_point_and_compliance():
    assert DEVICE is LjCo8
    warnings: list[str] = []
    assert check_device(LjCo8, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    for name in ("co8_set_capacitance", "co8_set_all"):
        semantics = hh.tools[name]["_meta"]["teststand"]["operationSemantics"]
        assert semantics["kind"] == "actuate"
        assert semantics["retry"] == "never_after_dispatch"
        assert semantics["safetyAction"]["toolName"] == "co8_safe_state"
    properties = hh.tools["co8_set_capacitance"]["inputSchema"]["properties"]
    assert (properties["channel"]["minimum"], properties["channel"]["maximum"]) == (0, 7)
    assert (properties["pf"]["minimum"], properties["pf"]["maximum"]) == (5.0, 1000.0)


@pytest.mark.parametrize("arguments", [{"channel": 8, "pf": 100}, {"channel": -1, "pf": 100},
                                       {"channel": 0, "pf": 4.9}, {"channel": 0, "pf": 1000.1}])
def test_out_of_range_never_reaches_driver(hh, arguments):
    device = hh.host.device
    before = set_commands(device)
    result = hh.call_raw("co8_set_capacitance", {"hardwareId": hh.hardware_id, **arguments})
    assert result["ok"] is False
    assert set_commands(device) == before


def test_direct_call_refuses_nonfinite_values():
    device = LjCo8(dry_run_config(LjCo8))
    device.open()
    for value in (float("nan"), float("inf"), 0.0):
        with pytest.raises(Exception, match="refused"):
            device.set_capacitance(0, value)
    assert set_commands(device) == []


def test_set_capacitance_publishes_setpoint(hh):
    result = hh.call("set_capacitance", operation_id="op-1", channel=3, pf=250)
    assert result["ok"] and result["data"] == {"channel": 3, "pf": 250.0}
    assert hh.host.device.cli.values[3] == 250.0
    refs = result["meta"]["streamRefs"]
    assert [ref["streamId"] for ref in refs] == ["c3"]
    records = hh.call("stream_read", streamId="c3", fromSeq=refs[0]["fromSeq"])["data"]["records"]
    assert records[-1]["v"] == 250.0 and records[-1]["op"] == "op-1"
    assert hh.call("read_last", channel=3)["data"] == {"channel": 3, "pf": 250.0}


def test_set_all_uses_one_driver_call(hh):
    device = hh.host.device
    before = len(set_commands(device))
    assert hh.call("set_all", pf=47)["data"] == {"pf": [47.0] * 8}
    sent = set_commands(device)[before:]
    assert sent == [{"cmd": "set_all", **{f"pf{n}": 47.0 for n in range(8)}}]
    assert device.cli.values == [47.0] * 8


def test_safe_state_sets_every_channel_to_safe_pf(hh):
    hh.call("set_capacitance", channel=0, pf=10)
    assert hh.call("safe_state")["data"] == {"safePf": 1000.0}
    assert hh.host.device.cli.values == [1000.0] * 8


def test_safe_pf_setting_is_checked():
    with pytest.raises(ValueError, match="safePf"):
        LjCo8(dry_run_config(LjCo8, settings={"safePf": 2}))
    device = LjCo8(dry_run_config(LjCo8, settings={"safePf": 100}))
    device.open()
    device.safe_state()
    assert device.cli.values == [100.0] * 8


def test_failed_write_keeps_last_accepted_value():
    device = LjCo8(dry_run_config(LjCo8))
    device.open()
    device.set_capacitance(1, 33)
    device.cli.fail_set = True
    with pytest.raises(Exception, match="capSetCapacitance failed"):
        device.set_capacitance(1, 66)
    assert device.last[1] == 33.0


def test_read_last_before_any_write_fails():
    device = LjCo8(dry_run_config(LjCo8))
    device.open()
    with pytest.raises(Exception, match="not set"):
        device.read_last(5)


def test_serial_number_selects_the_card():
    device = LjCo8(dry_run_config(LjCo8, settings={"serialNumber": SIM_SERIAL + 1}))
    device.cli.cards["PXI14::1::INSTR"] = SIM_SERIAL + 1
    device.open()
    assert device.identity["resource"] == "PXI14::1::INSTR"

    missing = LjCo8(dry_run_config(LjCo8, settings={"serialNumber": 1}))
    with pytest.raises(Exception, match="not found"):
        missing.open()


def test_self_test_passes_on_the_simulator():
    device = LjCo8(dry_run_config(LjCo8))
    device.open()
    assert all(check.passed for check in device.self_test())
    assert device.identity["resource"] == SIM_RESOURCE


def test_stream_declarations(hh):
    assert hh.device()["streams"] == [
        {"id": f"c{n}", "type": "scalar", "unit": "pF", "label": f"C{n}", "kind": "setpoint"} for n in range(8)]


def test_pinout_matches_the_manual_figure(hh):
    pins = {pin["position"]: pin["functions"][0] for pin in hh.device()["pinout"]["pins"]}
    assert len(pins) == 37
    # Spot values read off figure 1-3.
    assert pins[20]["signal"] == "Ch0 In" and pins[3]["signal"] == "Ch0 Out"
    assert pins[34]["signal"] == "Ch7 In" and pins[17]["signal"] == "Ch7 Out"
    assert pins[19]["signal"] == "GND"
    assert {n: (in_pin(n), out_pin(n)) for n in (1, 4)} == {1: (22, 5), 4: (28, 11)}
    used = {19, *(in_pin(n) for n in range(8)), *(out_pin(n) for n in range(8))}
    assert all(pins[p]["signal"] == "NC" for p in set(range(1, 38)) - used)


def test_device_declaration(hh):
    document = hh.device()
    assert document["description"].startswith("Sinoder LJ-CO-CPCI-8")
    assert {tool["name"]: tool["kind"] for tool in document["tools"]}["co8_set_capacitance"] == "actuate"

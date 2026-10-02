from __future__ import annotations

import math
import time
from pathlib import Path

import pytest

from hardwareharness_device_sdk.testing import check_device, dry_run_config, serve
from hh_adapter_pci6208v import DEVICE, Pci6208v
from hh_adapter_pci6208v.adapter import clamp_volts, configured_safe_volts
from hh_adapter_pci6208v.pinout import appearance_diagram, pinout, port_diagram

ASSETS = Path(__file__).resolve().parents[1] / "src" / "hh_adapter_pci6208v" / "assets"

PUBLIC_TOOLS = {
    "get_server_info", "list_hardware", "get_hardware_info",
    "lease_acquire", "lease_heartbeat", "lease_release", "lease_force_release", "lease_status",
    "pci6208v_set_voltage", "pci6208v_set_waveform", "pci6208v_stop_waveform", "pci6208v_read_last",
    "pci6208v_safe_state", "pci6208v_stream_read",
}


@pytest.fixture
def hh():
    with serve(Pci6208v) as harness:
        yield harness


def test_entry_point_and_compliance():
    assert DEVICE is Pci6208v
    warnings: list[str] = []
    assert check_device(Pci6208v, warnings=warnings) == []
    assert warnings == []


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


def test_write_publishes_to_stream_and_read_last(hh):
    ok = hh.call("set_voltage", {"operationId": "op-ao"}, channel=3, volts=2.5)
    assert ok["ok"] and "error" not in ok
    assert ok["data"]["channel"] == 3 and ok["data"]["volts"] == 2.5
    assert [ref["streamId"] for ref in ok["meta"]["streamRefs"]] == ["ao3"]
    assert hh.call("read_last", channel=3)["data"]["volts"] == 2.5
    last = hh.call("stream_read", streamId="ao3", limit=1)["data"]["records"][-1]
    assert last["v"] == 2.5 and last["op"] == "op-ao"
    with hh.sse("ao3", cursor=0) as events:
        hello = events.receive()
        assert hello["type"] == "hello" and hello["streamType"] == "scalar"


def test_streams_are_ao_setpoints(hh):
    assert hh.get("/device").json()["streams"] == [
        {"id": f"ao{n}", "type": "scalar", "unit": "V", "label": f"AO{n}", "kind": "setpoint"} for n in range(8)]


def test_device_declaration_images(hh):
    document = hh.get("/device").json()
    assert document["images"]["appearance"]["asset"] == "appearance.svg"
    assert "no output readback" in document["description"]
    image = document["pinout"]["connectors"][0]["image"]
    assert image["asset"] == "ports/CN1.svg" and image["mediaType"] == "image/svg+xml"
    assert len(image["pinPositions"]) == 37
    assert hh.get("/assets/ports/CN1.svg").status_code == 200


def test_shipped_assets_match_pinout():
    data = pinout("X")
    assert (ASSETS / "ports" / "CN1.svg").read_bytes().decode().replace("\r\n", "\n") == port_diagram(data).svg
    assert (ASSETS / "appearance.svg").read_bytes().decode().replace("\r\n", "\n") == appearance_diagram()
    for pin in data.pins:
        assert f">{pin.position}</text>" in port_diagram(data).svg


def wait_for(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert predicate()


def test_waveform_writes_and_publishes_setpoints(hh):
    driver = hh.service.device.driver
    started = hh.call("set_waveform", channel=2, shape="square", frequencyHz=10.0, amplitude=2.0, offset=1.0)
    assert started["ok"], started
    assert started["data"]["mode"] == "software" and started["data"]["updateHz"] == 200.0
    wait_for(lambda: len({volts for channel, volts in driver.writes if channel == 2}) >= 2)
    values = {volts for channel, volts in driver.writes if channel == 2}
    assert values <= {3.0, -1.0, 0.0}
    stopped = hh.call("stop_waveform", channel=2)["data"]
    assert stopped == {"channel": 2, "stopped": True, "holdValue": 1.0}
    count = len(driver.writes)
    time.sleep(0.05)
    assert len(driver.writes) == count and driver.writes[-1] == (2, 1.0)
    assert hh.call("read_last", channel=2)["data"]["volts"] == 1.0
    records = hh.call("stream_read", streamId="ao2", limit=5)["data"]["records"]
    assert records[-1]["v"] == 1.0


def test_waveform_limits(hh):
    for arguments in ({"frequencyHz": 25.0}, {"offset": 9.0, "amplitude": 2.0}, {"channel": 8}):
        call = {"channel": 0, "shape": "sine", "frequencyHz": 1.0, "amplitude": 1.0, "offset": 0.0} | arguments
        result = hh.mcp.call_raw("pci6208v_set_waveform", {"hardwareId": hh.hardware_id, **call})
        assert result.get("isError") or not result["structuredContent"]["ok"], arguments
    details = hh.call("get_hardware_info")["data"]["capabilityDetails"]["waveform"]
    assert details["mode"] == "software" and details["maxUpdateHz"] == 200.0 and details["maxFrequencyHz"] == 20.0
    assert details["channels"] == list(range(8))


def test_safe_state_and_static_write_stop_waveforms(hh):
    device = hh.service.device
    hh.call("set_waveform", channel=0, shape="sine", frequencyHz=5.0, amplitude=1.0, offset=0.0)
    hh.call("set_waveform", channel=1, shape="triangle", frequencyHz=5.0, amplitude=1.0, offset=0.0)
    assert hh.call("set_voltage", channel=1, volts=2.0)["ok"]
    assert set(device.waveform.running()) == {0}
    assert hh.call("safe_state")["ok"]
    assert device.waveform.running() == {}
    count = len(device.driver.writes)
    time.sleep(0.05)
    assert len(device.driver.writes) == count
    assert device.last_volts == [0.0] * 8


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


def test_pinout():
    data = pinout("PC1_MCP.PCI6208V_CARD_0")
    assert len(data.pins) == 37
    assert len({pin.pinId for pin in data.pins}) == 37
    by_position = {pin.position: pin for pin in data.pins}
    for position in (9, 12, 15, 18, 27, 30, 33, 36):
        assert by_position[position].functions[0].direction == "nc"
    ao = {pin.functions[0].channelIndex: pin.position for pin in data.pins if pin.functions[0].channelKind == "AO"}
    assert ao == {0: 19, 1: 37, 2: 16, 3: 34, 4: 13, 5: 31, 6: 10, 7: 28}

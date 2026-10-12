from __future__ import annotations

import time

import pytest

from teststand_device_sdk.testing import check_device, dry_run_config, receive_until, serve
from teststand_adapter_jcxd_mads3210 import DEVICE, JcxdMads3210
from teststand_adapter_jcxd_mads3210.adapter import parse_channels
from teststand_adapter_jcxd_mads3210.pinout import CONNECTOR0, CONNECTOR1, signals

SETTINGS = {"aiChannels": "0-7", "aiRateHz": 1000}
PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info", "self_test", "mads_stream_read",
    "mads_configure_ai", "mads_read_ai", "mads_write_ao", "mads_start_wave", "mads_stop_wave",
    "mads_configure_dio", "mads_write_do", "mads_read_dio", "mads_start_frequency", "mads_read_frequency",
    "mads_start_count", "mads_read_count", "mads_start_pwm", "mads_stop_counter", "mads_safe_state",
}


@pytest.fixture
def hh():
    with serve(JcxdMads3210, dry_run_config(JcxdMads3210, settings=SETTINGS)) as harness:
        yield harness


@pytest.fixture
def device():
    instance = JcxdMads3210(dry_run_config(JcxdMads3210, settings=SETTINGS))
    instance.open()
    yield instance
    instance.close()


def test_entry_point_and_compliance():
    assert DEVICE is JcxdMads3210
    warnings: list[str] = []
    assert check_device(JcxdMads3210, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    assert hh.tools["mads_read_ai"]["_meta"]["teststand"]["operationSemantics"]["evidenceType"] == "measurement"
    semantics = hh.tools["mads_write_ao"]["_meta"]["teststand"]["operationSemantics"]
    assert semantics["safetyAction"]["toolName"] == "mads_safe_state"


def test_read_ai_measures_a_window_of_new_samples(device):
    with device.io_lock:
        result = device.read_ai([0, 3], 200)
    stats = {item["channel"]: item for item in result["channels"]}
    assert stats[3]["mean"] == pytest.approx(0.3, abs=1e-3) and stats[3]["std"] < 1e-3
    assert stats[0]["max"] == pytest.approx(0.5, abs=0.01) and stats[0]["min"] == pytest.approx(-0.5, abs=0.01)
    assert 190 <= stats[0]["n"] <= 260


def test_read_ai_rejects_channels_outside_the_scan(device):
    with pytest.raises(Exception, match="not in the scan list"):
        device.read_ai([12], 10)


def test_ai_streams_carry_hardware_rate_blocks(hh):
    assert hh.device()["streams"][0] == {"id": "ai0", "type": "block", "unit": "V", "label": "AI0",
                                         "rateHz": 20.0, "kind": "measured"}
    with hh.subscribe("ai3", cursor=0) as events:
        assert receive_until(events, lambda event: event["type"] == "hello")["streamType"] == "block"
        batch = receive_until(events, lambda event: event["type"] == "batch" and event["records"])
    record = batch["records"][-1]
    assert record["dt"] == pytest.approx(1.0) and len(record["samples"]) >= 10
    assert all(abs(value - 0.3) < 1e-3 for value in record["samples"])


def test_configure_ai_checks_the_shared_rate(device):
    with pytest.raises(Exception, match="500000"):
        device.configure_ai(list(range(32)), 20_000)
    with pytest.raises(Exception, match="differential"):
        device.configure_ai([20], 1000, "differential")
    assert device.configure_ai([1, 2], 5000)["aggregateHz"] == 10_000


def test_misaligned_frames_are_dropped_and_fail_self_test(device):
    device.driver.ad_skew = True
    with device.io_lock:
        checks = {check.name: check for check in device.self_test()}
    assert checks["AI 帧对齐"].passed is False and checks["AI 帧对齐"].measured > 0


def test_self_test_passes_on_the_simulator(hh):
    data = hh.call_raw("self_test", {"hardwareId": hh.hardware_id})["data"]
    assert data["passed"] is True, data["checks"]
    assert any(check["name"] == "AI 实际采样率" for check in data["checks"])


def test_input_range_scales_readings():
    instance = JcxdMads3210(dry_run_config(JcxdMads3210, settings={**SETTINGS, "inputRangeV": 60}))
    instance.open()
    try:
        with instance.io_lock:
            stats = instance.read_ai([3], 50)["channels"][0]
        assert stats["mean"] == pytest.approx(1.8, abs=0.01)
    finally:
        instance.close()


def test_dio_outputs_read_back_the_register(device):
    state = device.configure_dio([1, 2])
    assert state["outputMask"] == 0b110 and state["outputs"] == 0
    assert device.write_do(2, 1) == {"channel": 2, "level": 1}
    assert device.read_dio()["outputs"] == 0b100
    with pytest.raises(Exception, match="input"):
        device.write_do(5, 1)
    device.driver.di_levels = 0b1000
    assert device.read_dio()["inputs"] == 0b1000


def test_ao_static_and_waveform(device):
    assert device.write_ao(3, -2.5) == {"channel": 3, "volts": -2.5}
    assert device.driver.da[3] == -2.5
    with pytest.raises(Exception, match="10 V"):
        device.start_wave(3, "sine", 8.0, 100.0, 3.0)
    device.start_wave(3, "square", 2.0, 1000.0)
    assert device.driver.waves[3][0] == 1
    assert device.stop_wave(3, 1.0) == {"channel": 3, "volts": 1.0}
    assert 3 not in device.driver.waves and device.driver.da[3] == 1.0


def test_counters(device):
    device.start_frequency(1)
    assert device.read_frequency(1)["frequencyHz"] == 2000.0
    device.start_count(0)
    time.sleep(0.05)
    assert device.read_count(0)["count"] > 0
    with pytest.raises(Exception, match="start_count"):
        device.read_count(1)
    device.start_pwm(1, 1000, 25)
    assert device.driver.counters[1] == ("pwm", 1000, 25)


def test_safe_state_stops_outputs(device):
    device.configure_dio([4])
    device.write_do(4, 1)
    device.write_ao(0, 5.0)
    device.start_wave(1, "sine", 1.0, 10.0)
    device.start_pwm(0, 100, 50)
    assert device.safe_state() == {"aoVolts": 0.0, "doLevel": 0, "failed": []}
    assert set(device.driver.da.values()) == {0.0} and not device.driver.waves
    assert device.driver.do_lines[4] == 0 and 0 not in device.driver.counters


def test_parse_channels():
    assert parse_channels("0-3, 7", 32) == [0, 1, 2, 3, 7]
    with pytest.raises(ValueError):
        parse_channels("30-33", 32)


def test_pinout_matches_the_manual_figure():
    c0, c1 = signals(CONNECTOR0), signals(CONNECTOR1)
    assert sorted(c0) == sorted(c1) == list(range(1, 69))
    assert (c0[68], c0[34], c0[35], c0[1], c0[49], c0[13]) == ("DIO0", "DIO1", "VIN17", "VIN16", "VOUT7", "VOUT4")
    assert (c1[1], c1[35], c1[34], c1[68], c1[56], c1[30]) == ("DIO24", "DIO25", "VIN1", "VIN0", "VOUT0", "VIN6")
    names = [*c0.values(), *c1.values()]
    for prefix, count in (("VIN", 32), ("VOUT", 8), ("DIO", 48)):
        assert sorted(int(name[len(prefix):]) for name in names
                      if name.startswith(prefix) and name[len(prefix):].isdigit()) == list(range(count))


def test_stale_identity_after_a_crash_is_reset_and_read_again():
    instance = JcxdMads3210(dry_run_config(JcxdMads3210, settings={**SETTINGS, "serialNumber": 621216518}))
    instance.driver.stale = True
    try:
        assert instance.open()["identity"]["serialNumber"] == 621216518
    finally:
        instance.close()

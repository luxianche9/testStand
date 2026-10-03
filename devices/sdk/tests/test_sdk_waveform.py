"""Software waveform generator (DEC-06): shapes, validation, setpoint publishing and stop semantics."""

from __future__ import annotations

import threading
import time

import pytest

from teststand_device_sdk import (
    DeviceError,
    ScalarStream,
    SoftwareWaveform,
    sample_value,
    waveform_capability,
)
from teststand_device_sdk.clock import now_ms


def test_sample_value_shapes():
    assert sample_value("dc", 0.3, 0, 0, 1.5) == 1.5
    assert sample_value("sine", 0.0, 1, 2, 1) == pytest.approx(1)
    assert sample_value("sine", 0.25, 1, 2, 1) == pytest.approx(3)
    assert sample_value("square", 0.1, 1, 1, 0) == 1 and sample_value("square", 0.6, 1, 1, 0) == -1
    assert sample_value("square", 0.3, 1, 1, 0, duty_cycle=0.25) == -1
    assert sample_value("triangle", 0.0, 1, 1, 0) == pytest.approx(0)
    assert sample_value("triangle", 0.25, 1, 1, 0) == pytest.approx(1)
    assert sample_value("triangle", 0.75, 1, 1, 0) == pytest.approx(-1)
    assert sample_value("sawtooth", 0.0, 1, 1, 0) == pytest.approx(0)
    assert sample_value("sawtooth", 0.49, 1, 1, 0) == pytest.approx(0.98)
    assert sample_value("sine", 0.0, 1, 1, 0, phase_deg=90) == pytest.approx(1)
    with pytest.raises(DeviceError):
        sample_value("noise", 0, 1, 1, 0)


def test_capability_declaration():
    assert waveform_capability([0, 1], max_update_hz=100) == {"waveform": {
        "channels": [0, 1], "mode": "software", "shapes": ["sine", "square", "triangle", "sawtooth", "dc"],
        "maxUpdateHz": 100, "maxSampleRateHz": None, "maxArbitrarySamples": 4096, "timingAccuracy": "±5 ms jitter"}}
    with pytest.raises(ValueError):
        waveform_capability([0], max_update_hz=500)
    with pytest.raises(ValueError):
        waveform_capability([0], shapes=("chirp",))


@pytest.fixture
def generator():
    writes: list[tuple[int, float]] = []
    streams = {0: ScalarStream("ao0", kind="setpoint", unit="V"), 1: ScalarStream("ao1", kind="setpoint", unit="V")}
    wave = SoftwareWaveform(lambda channel, value: writes.append((channel, value)), lock=threading.RLock(),
                            streams=streams, max_update_hz=100, limits=(-10.0, 10.0))
    yield wave, writes, streams
    wave.close()


def test_set_writes_publishes_and_stops(generator):
    wave, writes, streams = generator
    params = wave.set(0, "sine", 5.0, 2.0, 1.0)
    assert params["channel"] == 0 and params["updateHz"] == 100 and params["mode"] == "software"
    assert writes[0] == (0, pytest.approx(1.0, abs=0.01))  # the first value goes out with the call
    time.sleep(0.3)
    values = [value for channel, value in writes if channel == 0]
    assert len(values) >= 10 and min(values) >= -1.0 - 1e-9 and max(values) <= 3.0 + 1e-9
    assert max(values) - min(values) > 2.0
    records = streams[0].buffer.read(0, 10_000).records
    assert [record["v"] for record in records][:len(values)] == values  # every write is published
    assert set(wave.running()) == {0}
    stopped = wave.stop(0)
    assert stopped == {"channel": 0, "stopped": True, "holdValue": 1.0}
    count = len(writes)
    time.sleep(0.1)
    assert len(writes) == count and writes[-1] == (0, 1.0) and wave.running() == {}
    assert wave.stop(1, hold_value=0.5) == {"channel": 1, "stopped": False, "holdValue": 0.5}


def test_stop_all_writes_nothing(generator):
    wave, writes, _ = generator
    wave.set(0, "square", 2.0, 1.0, 0.0)
    wave.set(1, "triangle", 2.0, 1.0, 0.0)
    assert wave.stop_all() == [0, 1]
    count = len(writes)
    time.sleep(0.1)
    assert len(writes) == count and wave.running() == {}


def test_validation(generator):
    wave, writes, _ = generator
    for kwargs in ({"channel": 7}, {"shape": "noise"}, {"frequency_hz": 0.0}, {"frequency_hz": 60.0},
                   {"amplitude": -1.0}, {"offset": 9.5}, {"amplitude": float("nan")},
                   {"duty_cycle": 1.0}, {"start_at": now_ms() + 120_000}):
        arguments = {"channel": 0, "shape": "sine", "frequency_hz": 1.0, "amplitude": 1.0, "offset": 0.0} | kwargs
        with pytest.raises(DeviceError) as caught:
            wave.set(**arguments)
        assert caught.value.category == "invalid_argument", kwargs
    assert writes == [] and wave.running() == {}
    assert wave.set(0, "dc", 123.0, 5.0, 2.5)["frequencyHz"] == 0.0
    with pytest.raises(DeviceError):
        wave.stop(0, hold_value=11.0)


def test_delayed_start_and_write_errors():
    writes: list[float] = []
    failing = threading.Event()

    def write(channel: int, value: float) -> None:
        if failing.is_set():
            raise OSError("driver gone")
        writes.append(value)

    wave = SoftwareWaveform(write, lock=threading.Lock(), channels=[0], max_update_hz=50)
    try:
        wave.set(0, "sine", 1.0, 1.0, 0.0, start_at=now_ms() + 150)
        assert writes == []
        time.sleep(0.35)
        assert writes
        failing.set()
        time.sleep(0.1)
        assert wave.running() == {} and wave.last_error["channel"] == 0
    finally:
        wave.close()

from __future__ import annotations

import threading
import time

import pytest

from hardwareharness_device_sdk import (
    BitsStream,
    BlockStream,
    ByteStream,
    DeviceError,
    ScalarStream,
    StreamRegistry,
)
from hardwareharness_device_sdk.operation import CURRENT, Operation
from hardwareharness_device_sdk.testing import receive_until


def batch(events, limit: int = 200) -> dict:
    return receive_until(events, lambda frame: frame["type"] == "batch" and frame["records"], limit)


# --- SSE channel -------------------------------------------------------------
def test_hello_then_live_batch(hh):
    stream = hh.service.device.out
    with hh.sse("do") as events:
        hello = events.receive()
        assert hello | {"serverTime": 0} == {"type": "hello", "streamId": "do", "streamType": "bits",
                                             "epoch": stream.buffer.epoch, "fromSeq": stream.buffer.head,
                                             "serverTime": 0}
        assert events.last_id == f"{stream.buffer.epoch}:{stream.buffer.head}"
        hh.call("set_level", {"operationId": "op-ws"}, channel=3, level=True)
        frame = batch(events)
        record = frame["records"][0]
        assert record["mask"] == 8 and record["op"] == "op-ws" and frame["watermark"] >= record["t"]
        assert events.last_id == f"{stream.buffer.epoch}:{record['seq'] + 1}"


def test_history_from_seq(hh):
    head = hh.service.device.out.buffer.head
    for channel in range(3):
        hh.call("set_level", channel=channel, level=True)
    with hh.sse("do", cursor=head + 1) as events:
        assert events.receive()["fromSeq"] == head + 1
        assert [record["mask"] for record in batch(events)["records"]] == [3, 7]


def test_gap_when_resuming_evicted_cursor(hh):
    stream = hh.service.device.out
    for value in range(stream.buffer.capacity + 5):
        stream.publish(value)
    with hh.sse("do", cursor=0) as events:
        events.receive()
        assert events.receive() == {"type": "gap", "fromSeq": 0, "toSeq": stream.buffer.tail - 1,
                                         "reason": "overflow"}


def test_cursor_from_another_epoch_restarts_with_reset_gap(hh):
    with hh.sse("do", last_event_id="stale:0") as events:
        hello = events.receive()
        assert hello["fromSeq"] == hh.service.device.out.buffer.tail
        assert events.receive()["reason"] == "reset"


def test_byte_stream_carries_tx(hh):
    with hh.sse("serial1") as events:
        assert events.receive()["streamType"] == "bytes"
        hh.call("write_text", text="hi\n")
        record = batch(events)["records"][0]
        assert record["dir"] == "tx" and record["data"] == "68690a" and "text" not in record


def test_status_events_advance_watermark_on_idle_clocked_stream(hh):
    with hh.sse("serial1") as events:
        events.receive()
        first = receive_until(events, lambda frame: frame["type"] == "status")
        second = receive_until(events, lambda frame: frame["type"] == "status")
        assert first["state"] == "live" and second["watermark"] > first["watermark"]


def test_sampled_stream_runs_only_while_watched(hh):
    device = hh.service.device
    device.inputs = 0b101
    assert device.di.status()["state"] == "idle"
    with hh.sse("di") as events:
        events.receive()
        assert batch(events)["records"][0]["mask"] == 5
        assert device.di.status()["state"] == "sampling"
    deadline = time.monotonic() + 2
    while device.di.status()["state"] != "idle" and time.monotonic() < deadline:
        time.sleep(0.02)
    assert device.di.status()["state"] == "idle"
    head = device.di.buffer.head
    time.sleep(0.1)
    assert device.di.buffer.head == head


def test_not_configured_status_then_values(hh):
    with hh.sse("ai0") as events:
        events.receive()
        status = receive_until(events, lambda frame: frame["type"] == "status" and frame["state"] == "not_configured")
        assert status["errors"] == 0
        later = receive_until(events, lambda frame: frame["type"] == "status" and frame["watermark"] > status["watermark"])
        assert later["state"] == "not_configured"
        hh.call("configure")
        assert batch(events, limit=500)["records"][0]["v"] == 1.25


def test_sampling_interleaves_with_tool_calls(hh):
    device = hh.service.device
    active = 0
    overlap = False

    def guarded(value):
        nonlocal active, overlap
        active += 1
        overlap = overlap or active > 1
        time.sleep(0.005)
        active -= 1
        return value
    # Two samplers on their own threads plus tool calls: io_lock must serialize all device access.
    device.read_inputs = lambda: guarded(0)
    device.read_ai = lambda: guarded(0.5)
    with hh.sse("di") as events, hh.sse("ai0") as other:
        events.receive()
        other.receive()
        for _ in range(10):
            assert hh.call("configure")["ok"]
        time.sleep(0.1)
    assert not overlap


def test_resume_with_last_event_id(hh):
    stream = hh.service.device.out
    hh.call("set_level", channel=0, level=True)
    with hh.sse("do", cursor=0) as events:
        events.receive()
        batch(events)
        resume = events.last_id
    hh.call("set_level", channel=1, level=True)
    # Last-Event-ID wins over from/since and continues exactly after the last delivered batch.
    with hh.sse("do", cursor="latest", last_event_id=resume) as events:
        assert events.receive()["fromSeq"] == int(resume.rpartition(":")[2])
        assert [record["mask"] for record in batch(events)["records"]] == [3]
    assert stream.buffer.head == int(resume.rpartition(":")[2]) + 1


def test_since_starts_at_first_record_at_or_after_t(hh):
    for channel in range(3):
        hh.call("set_level", channel=channel, level=True)
    records = hh.service.device.out.buffer.read(-2).records
    with hh.sse("do", since=records[0]["t"]) as events:
        assert events.receive()["fromSeq"] == records[0]["seq"]
        assert [record["mask"] for record in batch(events)["records"]] == [3, 7]


def test_since_on_level_stream_starts_at_the_record_in_force(hh):
    hh.call("set_level", channel=2, level=True)
    held = hh.service.device.out.buffer.read(-1).records[-1]
    with hh.sse("do", since=held["t"] + 60_000) as events:
        assert events.receive()["fromSeq"] == held["seq"]
        assert batch(events)["records"][0]["mask"] == held["mask"]


def test_since_on_byte_stream_has_no_held_record(hh):
    hh.call("write_text", text="old\n")
    buffer = hh.service.device.serial.buffer
    with hh.sse("serial1", since=buffer.read(-1).records[-1]["t"] + 60_000) as events:
        assert events.receive()["fromSeq"] == buffer.head


def test_time_endpoint(hh):
    before = time.time() * 1000
    body = hh.client.get("/time", headers={"Authorization": f"Bearer {hh.token}"}).json()
    assert before - 1 <= body["serverTime"] <= time.time() * 1000 + 1
    assert hh.client.get("/time").status_code == 401


def test_unknown_stream_is_404(hh):
    with hh.sse("nope") as events:
        assert events.status_code == 404


def test_wrong_token_is_denied(hh):
    with hh.sse("do", token="wrong") as events:
        assert events.status_code == 401


# --- stream classes ------------------------------------------------------------
def test_typed_streams_validate_payloads():
    with pytest.raises(TypeError):
        ScalarStream("a").publish(True)
    with pytest.raises(TypeError):
        BitsStream("b").publish(-1)
    with pytest.raises(ValueError):
        BlockStream("c").publish([1.0], 0)
    with pytest.raises(ValueError):
        ScalarStream("bad id")
    with pytest.raises(DeviceError):
        ByteStream("d").send(b"x")


def test_byte_stream_records_hex_and_marks():
    stream = ByteStream("s")
    assert stream.rx(b"") is None
    rx = stream.rx(b"\x01\xff")
    mark = stream.mark("baud=9600")
    assert rx["dir"] == "rx" and rx["data"] == "01ff"
    assert mark["dir"] == "mark" and mark["data"] == "" and mark["note"] == "baud=9600"
    assert stream.present(rx)["text"] == "\x01�"


def test_block_record_starts_at_t0():
    stream = BlockStream("scope")
    record = stream.publish([1, 2, 3], 0.5, t0=1000.0)
    assert record["t"] == record["t0"] == 1000.0 and record["samples"] == [1.0, 2.0, 3.0]


def test_operation_tags_records_and_collects_refs():
    stream = ScalarStream("v")
    stream.publish(1)
    op = Operation("op-1")
    token = CURRENT.set(op)
    try:
        a = stream.publish(2)
        b = stream.publish(3)
    finally:
        CURRENT.reset(token)
    assert a["op"] == b["op"] == "op-1" and "op" not in stream.buffer.read(0).records[0]
    assert op.stream_refs() == [{"streamId": "v", "fromSeq": 1, "toSeq": 2}]


def test_registry_rejects_duplicates_and_scans_groups():
    registry = StreamRegistry()
    a = registry.add(ScalarStream("a"))
    b = registry.add(ScalarStream("b"))
    with pytest.raises(ValueError):
        registry.add(ScalarStream("a"))
    with pytest.raises(ValueError):
        registry.scan([ScalarStream("x")], lambda: [1.0])
    sampler = registry.scan([a, b], lambda: [1.0, None])
    assert registry.samplers() == [sampler]
    sampler._attempt()  # noqa: SLF001
    assert a.buffer.latest()["v"] == 1.0 and b.buffer.latest() is None
    assert a.status()["state"] == "sampling" and b.status()["state"] == "not_configured"
    assert b.buffer.watermark() >= a.buffer.latest()["t"]
    with pytest.raises(DeviceError, match="Unknown streamId"):
        registry.require("zz")


def test_failed_attempt_counts_error_and_still_advances_watermark():
    registry = StreamRegistry()
    stream = registry.add(ScalarStream("a"))

    def broken():
        raise DeviceError("wire off", category="device_error")
    sampler = registry.scan([stream], broken)
    before = stream.buffer.watermark()
    time.sleep(0.002)
    sampler._attempt()  # noqa: SLF001
    status = stream.status()
    assert status["state"] == "error" and status["errors"] == 1 and status["lastError"]["message"] == "wire off"
    assert status["watermark"] > before


def test_describe_declares_metadata():
    from hardwareharness_device_sdk import BitsStream, BlockStream, ByteStream, FrameStream, ScalarStream

    assert ScalarStream("ao0", unit="V", label="AO0", kind="setpoint").describe() == {
        "id": "ao0", "type": "scalar", "unit": "V", "label": "AO0", "kind": "setpoint"}
    assert BitsStream("di", bit_labels=("a", "b")).describe() == {"id": "di", "type": "bits", "width": 2,
                                                                   "bitLabels": ["a", "b"]}
    assert BlockStream("ai", read_block=lambda: None, rate_hz=5, unit="V").describe() == {
        "id": "ai", "type": "block", "unit": "V", "rateHz": 5.0}
    assert ByteStream("com1").describe() == {"id": "com1", "type": "bytes", "writable": False}
    assert FrameStream("can0", writer=lambda i, d: None, id_scheme="can").describe() == {
        "id": "can0", "type": "frames", "writable": True, "idScheme": "can"}
    with pytest.raises(ValueError):
        ScalarStream("x", kind="guess")
    with pytest.raises(ValueError):
        FrameStream("x", id_scheme="nope")


def test_idle_advances_event_stream_watermark():
    from hardwareharness_device_sdk import ByteStream, FrameStream

    for stream in (ByteStream("s"), FrameStream("f")):
        assert stream.idle_driven is False
        stream.idle(1000.0)
        assert stream.idle_driven is True and stream.buffer.watermark() == 1000.0
        time.sleep(0.05)
        assert stream.buffer.watermark() == 1000.0  # no longer clocked: only the reader moves it
        stream.idle()
        assert stream.buffer.watermark() > 1000.0


def _reader_device(period: float | None):
    from hardwareharness_device_sdk import ByteStream

    from sdk_demo import DemoDevice

    class Reader(DemoDevice):
        def __init__(self, config):
            super().__init__(config)
            self.port = self.streams.add(ByteStream("port"))
            self.stop = threading.Event()
            threading.Thread(target=self._read, daemon=True).start()

        def _read(self):
            self.port.idle()
            while period is not None and not self.stop.wait(period):
                self.port.idle()  # a read returned (timeout or data)

        def close(self):
            self.stop.set()
            super().close()

    return Reader


def test_compliance_checks_idle_driven_watermark():
    from hardwareharness_device_sdk.testing import check_device

    assert check_device(_reader_device(0.05)) == []
    failures = check_device(_reader_device(None))
    assert any("stream port: watermark trailed" in failure for failure in failures)

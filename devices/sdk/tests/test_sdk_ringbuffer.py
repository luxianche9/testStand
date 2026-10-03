from __future__ import annotations

import threading

from teststand_device_sdk import RingBuffer, now_ms


def test_sequence_and_cursor_resume():
    buffer = RingBuffer(8)
    for value in range(5):
        buffer.append({"v": value}, t=100.0 + value)
    first = buffer.read(0, 3)
    assert [record["seq"] for record in first.records] == [0, 1, 2]
    assert first.next == 3 and first.head == 5 and first.tail == 0 and first.dropped is None
    rest = buffer.read(first.next)
    assert [record["v"] for record in rest.records] == [3, 4]
    assert rest.next == 5
    assert buffer.read(rest.next).records == []


def test_none_starts_live_and_negative_returns_history():
    buffer = RingBuffer(8)
    for value in range(5):
        buffer.append({"v": value})
    assert buffer.read(None).records == [] and buffer.read(None).next == 5
    assert [record["v"] for record in buffer.read(-2).records] == [3, 4]
    assert [record["v"] for record in buffer.read(-50).records] == [0, 1, 2, 3, 4]


def test_overflow_reports_dropped_range():
    buffer = RingBuffer(3)
    for value in range(6):
        buffer.append({"v": value})
    result = buffer.read(1)
    assert result.dropped == (1, 2)
    assert [record["seq"] for record in result.records] == [3, 4, 5]
    assert len(buffer) == 3 and buffer.latest()["seq"] == 5


def test_weight_limit_evicts_oldest():
    buffer = RingBuffer(100, max_weight=10)
    for _ in range(4):
        buffer.append({}, weight=4)
    assert buffer.tail == 2 and len(buffer) == 2


def test_cursor_from_another_epoch_resets_to_tail():
    buffer = RingBuffer(4)
    buffer.append({"v": 1})
    assert buffer.read(99).reset is True
    result = buffer.read(0, epoch="other")
    assert result.reset is True and [record["v"] for record in result.records] == [1]
    assert buffer.read(0, epoch=buffer.epoch).reset is False


def test_timestamps_strictly_increase():
    buffer = RingBuffer(8)
    a = buffer.append({}, t=500.0)
    b = buffer.append({}, t=400.0)
    c = buffer.append({}, t=500.0)
    assert a["t"] < b["t"] < c["t"]


def test_clocked_watermark_follows_now():
    buffer = RingBuffer(8)
    before = now_ms()
    assert buffer.watermark() >= before


def test_sampled_watermark_only_moves_on_advance():
    buffer = RingBuffer(8, clocked=False)
    assert buffer.watermark() == 0.0
    buffer.advance(1000.0)
    buffer.advance(900.0)
    assert buffer.watermark() == 1000.0
    record = buffer.append({}, t=950.0)
    assert record["t"] > 1000.0, "a record may never land at or below the watermark"


def test_reader_watermark_stops_before_unread_records():
    buffer = RingBuffer(8, clocked=False)
    for t in (10.0, 20.0, 30.0):
        buffer.append({}, t=t)
    buffer.advance(40.0)
    partial = buffer.read(0, 1)
    assert partial.watermark < 20.0
    assert buffer.read(0).watermark == 40.0


def test_concurrent_appends_keep_unique_sequence():
    buffer = RingBuffer(10_000)

    def writer() -> None:
        for _ in range(1000):
            buffer.append({})
    threads = [threading.Thread(target=writer) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    records = buffer.read(0, 10_000).records
    assert [record["seq"] for record in records] == list(range(4000))
    assert all(a["t"] < b["t"] for a, b in zip(records, records[1:], strict=False))

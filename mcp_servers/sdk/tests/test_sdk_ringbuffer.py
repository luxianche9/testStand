from __future__ import annotations

import threading

from hardwareharness_device_sdk import RingBuffer


def test_sequence_and_cursor_resume():
    buffer = RingBuffer(8)
    for value in range(5):
        buffer.append({"value": value}, t=100.0 + value)
    first = buffer.read(0, 3)
    assert [item["seq"] for item in first.items] == [0, 1, 2]
    assert first.next == 3 and first.head == 5 and first.tail == 0 and first.dropped is None
    rest = buffer.read(first.next)
    assert [item["value"] for item in rest.items] == [3, 4]
    assert rest.next == 5
    assert buffer.read(rest.next).items == []


def test_none_starts_live_and_negative_returns_history():
    buffer = RingBuffer(8)
    for value in range(5):
        buffer.append({"value": value})
    assert buffer.read(None).items == [] and buffer.read(None).next == 5
    assert [item["value"] for item in buffer.read(-2).items] == [3, 4]
    assert [item["value"] for item in buffer.read(-50).items] == [0, 1, 2, 3, 4]


def test_overflow_reports_dropped_range():
    buffer = RingBuffer(3)
    for value in range(6):
        buffer.append({"value": value})
    result = buffer.read(1)
    assert result.dropped == (1, 3)
    assert [item["seq"] for item in result.items] == [3, 4, 5]
    assert len(buffer) == 3 and buffer.latest()["seq"] == 5


def test_weight_limit_evicts_oldest():
    buffer = RingBuffer(100, max_weight=10)
    for _ in range(4):
        buffer.append({"bytes": 4}, weight=4)
    assert buffer.tail == 2 and len(buffer) == 2


def test_cursor_from_another_epoch_resets_to_tail():
    buffer = RingBuffer(4)
    buffer.append({"value": 1})
    result = buffer.read(99)
    assert result.reset is True
    assert [item["value"] for item in result.items] == [1]


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
    seqs = [item["seq"] for item in buffer.read(0, 10_000).items]
    assert seqs == list(range(4000))

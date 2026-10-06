"""Stream sources: the ring buffer of a loaded device, with gaps, status and reconnects."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.streams import source as source_module
from teststand_backend.streams.clock import SHARED_CLOCK
from teststand_backend.streams.source import StreamSource, StreamSources

Record = dict[str, Any]


class FakeDevice:
    """Serves scripted ``read_stream`` results; ``fail`` raises once on the next read."""

    def __init__(self, reads: list[Record]) -> None:
        self.reads = reads
        self.watched = 0
        self.seeks: list[float] = []
        self.fail: Exception | None = None
        self.missing = False

    async def watch(self, stream_id: str) -> None:
        if self.missing:
            raise KeyError(stream_id)
        self.watched += 1

    async def unwatch(self, stream_id: str) -> None:
        self.watched -= 1

    async def seek(self, stream_id: str, since: float) -> int:
        self.seeks.append(since)
        return 0

    async def read_stream(
        self, stream_id: str, cursor: int | None, limit: int, epoch: str | None = None
    ) -> Record:
        if self.fail is not None:
            failure, self.fail = self.fail, None
            raise failure
        result = self.reads.pop(0) if len(self.reads) > 1 else self.reads[0]
        return {
            "streamType": "scalar",
            "epoch": "E",
            "records": [],
            "next": cursor or 0,
            "watermark": 0.0,
            "status": {"state": "live", "sampling": True, "errors": 0},
            **result,
        }


def record(seq: int, t: float) -> Record:
    return {"seq": seq, "t": t, "v": float(seq)}


async def take(events: Any, count: int) -> list[Record]:
    return [await asyncio.wait_for(anext(events), 2) for _ in range(count)]


async def test_records_gaps_and_status_flow_like_the_sse_channel(monkeypatch: Any) -> None:
    monkeypatch.setattr(source_module, "BATCH_INTERVAL", 0.001)
    device = FakeDevice(
        [
            {"next": 0},
            {"records": [record(0, 10.0), record(1, 11.0)], "next": 2, "watermark": 11.0},
            {
                "records": [record(5, 15.0)],
                "next": 6,
                "watermark": 15.0,
                "gap": {"fromSeq": 2, "toSeq": 4, "reason": "overflow"},
            },
            {"next": 6, "watermark": 16.0},
        ]
    )
    source = StreamSource(device, "ai0", since=5.0)
    events = source.events()
    hello, batch, status = await take(events, 3)
    assert hello == {"type": "hello", "streamType": "scalar", "epoch": "E"}
    assert device.seeks == [5.0] and device.watched == 1
    assert [item["tb"] for item in batch["records"]] == [10.0, 11.0]
    assert status["type"] == "status" and status["state"] == "live"
    gap, second = await take(events, 2)
    assert gap == {
        "type": "gap",
        "reason": "overflow",
        "fromSeq": 2,
        "toSeq": 4,
        "t0": 11.0,
        "t1": 15.0,
    }
    assert second["type"] == "batch" and second["watermark"] == 15.0
    await events.aclose()  # type: ignore[attr-defined]
    assert device.watched == 0


async def test_a_failing_device_reports_disconnected_and_resumes(monkeypatch: Any) -> None:
    monkeypatch.setattr(source_module, "BATCH_INTERVAL", 0.001)
    monkeypatch.setattr(source_module, "BACKOFF_MIN", 0.001)
    device = FakeDevice([{"next": 0}])
    device.fail = RuntimeError("device process exited")
    events = StreamSource(device, "ai0", since=None).events()
    state, hello = await take(events, 2)
    assert state == {"type": "state", "state": "disconnected", "message": "device process exited"}
    assert hello["type"] == "hello"
    await events.aclose()  # type: ignore[attr-defined]


async def test_an_unknown_stream_ends_the_source() -> None:
    device = FakeDevice([{"next": 0}])
    device.missing = True
    events = StreamSource(device, "nope", since=None).events()
    assert (await take(events, 1))[0]["state"] == "unknown_stream"


async def test_sources_resolve_loaded_devices_and_share_the_clock() -> None:
    device = FakeDevice([{"next": 0}])
    sources = StreamSources(lambda hardware_id: device if hardware_id == "H" else None)
    assert isinstance(sources.source("H", "ai0"), StreamSource)
    with pytest.raises(AppError) as missing:
        sources.source("OTHER", "ai0")
    assert missing.value.category == "not_found"
    assert sources.clock("H") is SHARED_CLOCK
    assert SHARED_CLOCK.snapshot() == {"offsetMs": 0.0, "uncertaintyMs": 0.0}
    assert SHARED_CLOCK.to_backend(12.5) == 12.5 == SHARED_CLOCK.to_server(12.5)


async def test_hello_carries_what_the_plugin_declared_for_the_stream(tmp_path: Any) -> None:
    from teststand_backend.streams.store import StreamStore

    class DescribedDevice(FakeDevice):
        async def describe(self) -> Record:
            relay = {"id": "relay", "type": "bits", "width": 2, "bitLabels": ["R0", "R1"]}
            return {"device": {"streams": [{**relay, "display": "switches"}]}}

    events = StreamSource(DescribedDevice([{"next": 0}]), "relay", since=None).events()
    (hello,) = await take(events, 1)
    declaration = {"width": 2, "bitLabels": ["R0", "R1"], "display": "switches"}
    assert hello["declaration"] == declaration
    await events.aclose()  # type: ignore[attr-defined]

    store = StreamStore(tmp_path / "run.sqlite")
    key = store.add_stream("RELAY", "relay")
    store.update_stream(key, stream_type="bits", declaration=declaration)
    assert store.streams()[0]["declaration"] == declaration
    store.close()

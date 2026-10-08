from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import Any

from teststand_device_sdk.ringbuffer import RingBuffer

from teststand_backend.streams.recorder import StreamRecorder
from teststand_backend.streams.source import StreamSources
from teststand_backend.streams.store import StreamStore

from .fake_service import FakeStreamService


def values(store: StreamStore, key: str, field: str = "v") -> list[Any]:
    return [record[field] for record in store.read(key, limit=1000)["records"]]


async def test_records_preroll_live_and_tail(tmp_path: Path) -> None:
    async with FakeStreamService({"v": "scalar", "rx": "bytes"}) as service:
        sources = service.sources()
        store = StreamStore(tmp_path / "streams.sqlite")
        service.publish("v", v=0.5)  # inside the pre-roll
        recorder = StreamRecorder(
            sources, store, [("daq", "v"), ("dut", "rx")], preroll_ms=1000, tail_ms=100
        )
        await recorder.start()
        assert store.meta()["recording"] is True
        for value in (1.0, 2.0, 3.0):
            service.publish("v", v=value)
        service.publish("rx", dir="rx", data=b"hello".hex())
        stored = service.publish("v", v=4.0)
        assert await recorder.wait_watermark("daq", "v", stored["t"], 2.0)
        assert store.stream("daq__v")["count"] == 5
        await recorder.stop()

    meta = store.meta()
    assert meta["recording"] is False and meta["stoppedTb"] >= meta["startedTb"]
    assert meta["preRollMs"] == 1000 and meta["tailMs"] == 100
    info = store.stream("daq__v")
    assert info["type"] == "scalar" and info["watermarkTb"] >= meta["stoppedTb"] - 300
    assert info["clock"] == {"offsetMs": 0.0, "uncertaintyMs": 0.0}
    assert values(store, "daq__v") == [0.5, 1.0, 2.0, 3.0, 4.0]
    record = store.read("daq__v")["records"][0]
    assert record["t"] == record["tb"]
    assert values(store, "dut__rx", "data") == [b"hello".hex()]
    assert store.states("dut__rx")[0]["state"] == "connected"
    store.close()


async def test_old_history_is_outside_preroll_but_the_level_in_force_is_kept(
    tmp_path: Path,
) -> None:
    async with FakeStreamService({"v": "scalar"}) as service:
        service.publish("v", v=-2.0)
        service.publish("v", v=-1.0)
        await asyncio.sleep(0.15)
        sources = service.sources()
        store = StreamStore(tmp_path / "streams.sqlite")
        recorder = StreamRecorder(sources, store, [("daq", "v")], preroll_ms=100, tail_ms=50)
        await recorder.start()
        stored = service.publish("v", v=1.0)
        assert await recorder.wait_watermark("daq", "v", stored["t"], 2.0)
        await recorder.stop()
    assert values(store, "daq__v") == [-1.0, 1.0]
    store.close()


async def test_gaps_and_disconnects_are_stored(tmp_path: Path) -> None:
    async with FakeStreamService({"v": "scalar"}) as service:
        sources = service.sources()
        store = StreamStore(tmp_path / "streams.sqlite")
        recorder = StreamRecorder(sources, store, [("daq", "v")], preroll_ms=0, tail_ms=0)
        await recorder.start()
        first = service.publish("v", v=0)
        assert await recorder.wait_watermark("daq", "v", first["t"], 2.0)
        service.drop()
        for value in range(1, 4):
            service.publish("v", v=value)
        service.evict("v", 3)
        last = service.publish("v", v=4)
        assert await recorder.wait_watermark("daq", "v", last["t"], 3.0)
        await recorder.stop()
    [gap] = store.gaps("daq__v")
    assert (gap["reason"], gap["fromSeq"], gap["toSeq"]) == ("overflow", 1, 2)
    assert gap["tb"] is not None and gap["tb1"] >= gap["tb"]
    assert values(store, "daq__v") == [0, 3, 4]
    states = [state["state"] for state in store.states("daq__v")]
    assert states[:3] == ["connected", "live", "disconnected"] and "connected" in states[3:]
    store.close()


async def test_unavailable_stream_and_blob_fetch(tmp_path: Path) -> None:
    async with FakeStreamService({"shots": "blob"}) as service:
        sources = service.sources()
        store = StreamStore(tmp_path / "streams.sqlite")
        fetched: list[tuple[str, str, str]] = []

        async def fetch(hardware_id: str, stream_id: str, ref: str) -> dict[str, Any]:
            fetched.append((hardware_id, stream_id, ref))
            return {"mime": "image/png", "base64": base64.b64encode(b"PNG!").decode()}

        recorder = StreamRecorder(
            sources,
            store,
            [("cam", "shots"), ("cam", "missing")],
            preroll_ms=0,
            tail_ms=0,
            fetch_blob=fetch,
        )
        await recorder.start()
        record = service.publish("shots", ref="r1")
        assert await recorder.wait_watermark("cam", "shots", record["t"], 2.0)
        missing = recorder.track("cam", "missing")
        assert missing is not None and await missing.wait_until(lambda: missing.ended, 2.0)
        await recorder.stop()
    assert fetched == [("cam", "shots", "r1")]
    assert store.blob("cam__shots", "r1")["content"] == b"PNG!"
    assert store.read("cam__shots")["blobs"]["r1"]["size"] == 4
    assert store.states("cam__missing")[-1]["state"] == "unknown_stream"
    store.close()


async def test_unresolvable_hardware_is_unavailable(tmp_path: Path) -> None:
    async with FakeStreamService({"v": "scalar"}) as service:

        def resolve(hardware_id: str) -> Any:
            raise LookupError(f"no device for {hardware_id}")

        sources = service.sources()
        sources.devices = resolve
        store = StreamStore(tmp_path / "streams.sqlite")
        recorder = StreamRecorder(sources, store, [("ghost", "v")], tail_ms=0)
        await recorder.start()
        assert not await recorder.wait_watermark("ghost", "v", 0, 0.1)
        await recorder.stop()
    assert store.states("ghost__v") == [
        {
            "tb": store.states("ghost__v")[0]["tb"],
            "state": "unavailable",
            "message": "no device for ghost",
        }
    ]
    store.close()


async def test_listeners_receive_batches_and_end(tmp_path: Path) -> None:
    async with FakeStreamService({"v": "scalar"}) as service:
        sources = service.sources()
        store = StreamStore(tmp_path / "streams.sqlite")
        recorder = StreamRecorder(sources, store, [("daq", "v")], preroll_ms=0, tail_ms=0)
        await recorder.start()
        queue = recorder.listen("daq__v")
        assert queue is not None and recorder.listen("nope") is None
        service.publish("v", v=7.0)
        while True:
            frame = await asyncio.wait_for(queue.get(), 2.0)
            if frame["type"] == "batch":
                break
        assert frame["records"][0]["v"] == 7.0 and frame["records"][0]["i"] >= 1
        assert frame["watermarkTb"] is not None
        await recorder.stop()
        while frame["type"] != "end":
            frame = await asyncio.wait_for(queue.get(), 2.0)
    store.close()


class RingDevice:
    """The stream side of an in-process SDK device: reads hand out the ring buffer's own dicts."""

    def __init__(self) -> None:
        self.buffer = RingBuffer()

    async def watch(self, stream_id: str) -> None:
        return None

    async def unwatch(self, stream_id: str) -> None:
        return None

    async def seek(self, stream_id: str, since: float) -> int:
        return self.buffer.seek(since, hold=True)

    async def read_stream(
        self, stream_id: str, cursor: int | None, limit: int, epoch: str | None = None
    ) -> dict[str, Any]:
        result = self.buffer.read(cursor, limit, epoch=epoch)
        status = {"state": "live", "watermark": result.watermark}
        return {
            "streamType": "scalar",
            "epoch": self.buffer.epoch,
            "records": result.records,
            "next": result.next,
            "watermark": result.watermark,
            "status": status,
        }


async def test_two_recorders_of_shared_sdk_records_keep_their_own_ids(tmp_path: Path) -> None:
    device = RingDevice()
    sources = StreamSources(lambda _hardware_id: device)
    first = StreamStore(tmp_path / "first.sqlite")
    first.add_stream("daq", "other")
    first.append("daq__other", [{"seq": n, "t": n, "tb": n, "v": 0.0} for n in range(5)])
    second = StreamStore(tmp_path / "second.sqlite")
    recorders = [
        StreamRecorder(sources, store, [("daq", "v")], preroll_ms=0, tail_ms=0)
        for store in (first, second)
    ]
    for recorder in recorders:
        await recorder.start()
    last: dict[str, Any] = {}
    for value in (1.0, 2.0, 3.0):
        last = device.buffer.append({"v": value})
    for recorder in recorders:
        assert await recorder.wait_watermark("daq", "v", last["t"], 2.0)
        await recorder.stop(tail=False)
    assert not any("i" in record for record in device.buffer.read(0).records)
    assert [r["i"] for r in first.records("daq__v")] == [6, 7, 8]
    assert [r["i"] for r in second.records("daq__v")] == [1, 2, 3] and second.last_i("daq__v") == 3
    first.close()
    second.close()

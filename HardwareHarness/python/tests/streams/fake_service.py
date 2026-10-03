"""A controllable in-process device for backend stream tests.

Implements the stream side of the SDK ``DeviceHandle`` (``watch``/``unwatch``/``seek``/
``read_stream``) over a scripted ring buffer, with the SDK's cursor, epoch and gap rules.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from hardwareharness_backend.streams.clock import backend_ms
from hardwareharness_backend.streams.source import StreamSources


@dataclass
class FakeStream:
    stream_type: str
    records: list[dict[str, Any]] = field(default_factory=list)
    head: int = 0
    state: str = "live"
    last_t: float = 0.0
    sampled: bool = False

    @property
    def tail(self) -> int:
        return self.head - len(self.records)


class FakeStreamService:
    def __init__(self, streams: dict[str, str], *, sampled: frozenset[str] = frozenset()) -> None:
        """``sampled`` streams report their last sample time as the watermark (the SDK's
        unclocked buffer); the others are complete up to now."""
        self.streams = {
            key: FakeStream(kind, sampled=key in sampled) for key, kind in streams.items()
        }
        self.epoch = uuid.uuid4().hex[:8]
        self.watchers: dict[str, int] = {}
        self.seeks: list[tuple[str, float]] = []
        self._dropped = False

    def now(self) -> float:
        return round(backend_ms(), 3)

    async def __aenter__(self) -> FakeStreamService:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def sources(self) -> StreamSources:
        return StreamSources(lambda _hardware_id: self)

    # -- control ---------------------------------------------------------------------------

    def publish(self, stream_id: str, *, at: float | None = None, **payload: Any) -> dict[str, Any]:
        """Append a record at time ``at`` (default now)."""
        stream = self.streams[stream_id]
        t = max(self.now() if at is None else at, round(stream.last_t + 0.001, 3))
        stream.last_t = t
        record = {"seq": stream.head, "t": t, **payload}
        stream.head += 1
        stream.records.append(record)
        return record

    def evict(self, stream_id: str, count: int) -> None:
        del self.streams[stream_id].records[:count]

    def restart(self) -> None:
        """New epoch, empty buffers, and the next read fails like a restarting device."""
        self.epoch = uuid.uuid4().hex[:8]
        for stream in self.streams.values():
            stream.records.clear()
            stream.head = 0
        self.drop()

    def drop(self) -> None:
        """The next read fails (the device went away for a moment)."""
        self._dropped = True

    # -- DeviceHandle ------------------------------------------------------------------------

    async def watch(self, stream_id: str) -> None:
        if stream_id not in self.streams:
            raise KeyError(f"Unknown streamId {stream_id}")
        self.watchers[stream_id] = self.watchers.get(stream_id, 0) + 1

    async def unwatch(self, stream_id: str) -> None:
        self.watchers[stream_id] -= 1

    async def seek(self, stream_id: str, since: float) -> int:
        self.seeks.append((stream_id, since))
        stream = self.streams[stream_id]
        cursor = next((r["seq"] for r in stream.records if r["t"] >= since), stream.head)
        held = [r["seq"] for r in stream.records if r["t"] < since]
        if held and stream.stream_type in ("scalar", "bits"):
            cursor = held[-1]  # level streams start at the record in force at ``since``
        return int(cursor)

    async def read_stream(
        self, stream_id: str, cursor: int | None, limit: int, epoch: str | None = None
    ) -> dict[str, Any]:
        if self._dropped:
            self._dropped = False
            raise RuntimeError("device went away")
        stream = self.streams[stream_id]
        position = stream.head if cursor is None else cursor
        gap: dict[str, Any] | None = None
        if (epoch is not None and epoch != self.epoch) or position > stream.head:
            position = stream.tail
            gap = {"fromSeq": None, "toSeq": stream.tail - 1, "reason": "reset"}
        elif position < stream.tail:
            gap = {"fromSeq": position, "toSeq": stream.tail - 1, "reason": "overflow"}
            position = stream.tail
        records = [dict(item) for item in stream.records[position - stream.tail :][:limit]]
        if records:
            position = records[-1]["seq"] + 1
        watermark = self._watermark(stream, position)
        return {
            "streamType": stream.stream_type,
            "epoch": self.epoch,
            "records": records,
            "next": position,
            "watermark": watermark,
            "status": {
                "state": stream.state,
                "sampling": False,
                "errors": 0,
                "watermark": watermark,
            },
            **({"gap": gap} if gap else {}),
        }

    def _watermark(self, stream: FakeStream, cursor: int) -> float:
        if cursor < stream.head:
            return round(float(stream.records[cursor - stream.tail]["t"]) - 0.001, 3)
        if stream.sampled:
            # Like the SDK's unclocked ring buffer: complete only up to the last sample.
            return stream.last_t
        return self.now()

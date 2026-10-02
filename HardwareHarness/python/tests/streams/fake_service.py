"""A controllable SSE stream service for backend tests (same protocol as the SDK ``sse.py``).

``GET /streams/{id}`` with ``Last-Event-ID``/``since``/``from`` and ``GET /time``,
both behind the bearer token; served by uvicorn on an ephemeral port.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from hardwareharness_backend.streams.source import Endpoint, StreamSources

TOKEN = "stream-token"


def now_ms() -> float:
    return round(time.time_ns() / 1_000_000, 3)


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
    def __init__(
        self,
        streams: dict[str, str],
        *,
        clock_skew_ms: float = 0.0,
        sampled: frozenset[str] = frozenset(),
    ) -> None:
        """``sampled`` streams report their last sample time as the watermark (the SDK's
        unclocked buffer); the others are complete up to now."""
        self.streams = {
            key: FakeStream(kind, sampled=key in sampled) for key, kind in streams.items()
        }
        self.epoch = uuid.uuid4().hex[:8]
        self.skew = clock_skew_ms
        self.requests: list[dict[str, Any]] = []
        self.time_requests = 0
        self.interval = 0.02
        self.closing = False
        self._generation = 0
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None
        self.app = Starlette(
            routes=[
                Route("/time", self._time),
                Route("/streams/{streamId}", self._stream),
            ]
        )

    def now(self) -> float:
        return round(now_ms() + self.skew, 3)

    async def __aenter__(self) -> FakeStreamService:
        config = uvicorn.Config(
            self.app,
            host="127.0.0.1",
            port=0,
            log_level="warning",
            lifespan="off",
            timeout_graceful_shutdown=1,
        )
        self._server = uvicorn.Server(config)
        self._task = asyncio.create_task(self._server.serve())
        while not self._server.started:
            await asyncio.sleep(0.01)
        return self

    async def __aexit__(self, *_: object) -> None:
        self.closing = True
        assert self._server is not None and self._task is not None
        self._server.should_exit = True
        with contextlib.suppress(asyncio.CancelledError):
            await self._task

    @property
    def port(self) -> int:
        assert self._server is not None
        return int(self._server.servers[0].sockets[0].getsockname()[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def resolver(self, hardware_id: str) -> Endpoint:
        return Endpoint(self.base_url, TOKEN, "fake")

    def sources(self, *, clock_interval: float = 0.05) -> StreamSources:
        return StreamSources(self.resolver, clock_interval=clock_interval)

    # -- control ---------------------------------------------------------------------------

    def publish(self, stream_id: str, *, at: float | None = None, **payload: Any) -> dict[str, Any]:
        """Append a record at service time ``at`` (default now)."""
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
        """New epoch, empty buffers, drop every connection."""
        self.epoch = uuid.uuid4().hex[:8]
        for stream in self.streams.values():
            stream.records.clear()
            stream.head = 0
        self.drop()

    def drop(self) -> None:
        """End every open stream response (the client sees the stream close)."""
        self._generation += 1

    # -- protocol --------------------------------------------------------------------------

    def _authorized(self, request: Request) -> bool:
        return request.headers.get("authorization") == f"Bearer {TOKEN}"

    async def _time(self, request: Request) -> Response:
        if not self._authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        self.time_requests += 1
        return JSONResponse({"serverTime": self.now()})

    async def _stream(self, request: Request) -> Response:
        if not self._authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        stream_id = request.path_params["streamId"]
        self.requests.append(
            {
                "streamId": stream_id,
                **dict(request.query_params),
                "lastEventId": request.headers.get("last-event-id"),
            }
        )
        stream = self.streams.get(stream_id)
        if stream is None:
            return JSONResponse({"error": "not_found"}, status_code=404)
        cursor: int | None
        epoch: str | None = None
        last = request.headers.get("last-event-id", "")
        prefix, sep, seq = last.rpartition(":")
        since = request.query_params.get("since")
        if sep and prefix and seq.isdigit():
            cursor, epoch = int(seq), prefix
        elif since:
            cursor = next((r["seq"] for r in stream.records if r["t"] >= float(since)), stream.head)
            held = [r["seq"] for r in stream.records if r["t"] < float(since)]
            if held and stream.stream_type in ("scalar", "bits"):
                cursor = held[-1]  # level streams start at the record in force at ``since``
        else:
            raw = request.query_params.get("from", "latest")
            cursor = None if raw == "latest" else int(raw)
        return StreamingResponse(
            self._events(stream_id, stream, cursor, epoch), media_type="text/event-stream"
        )

    def _watermark(self, stream: FakeStream, cursor: int) -> float:
        if cursor < stream.head:
            return round(float(stream.records[cursor - stream.tail]["t"]) - 0.001, 3)
        if stream.sampled:
            # Like the SDK's unclocked ring buffer: complete only up to the last sample.
            return stream.last_t
        return self.now()

    async def _events(
        self, stream_id: str, stream: FakeStream, cursor: int | None, epoch: str | None
    ) -> AsyncIterator[bytes]:
        generation = self._generation
        position = stream.head if cursor is None else cursor
        gap: dict[str, Any] | None = None
        if (epoch is not None and epoch != self.epoch) or position > stream.head:
            position = stream.tail
            gap = {"fromSeq": None, "toSeq": stream.tail - 1, "reason": "reset"}
        elif position < stream.tail:
            gap = {"fromSeq": position, "toSeq": stream.tail - 1, "reason": "overflow"}
            position = stream.tail
        yield _event(
            "hello",
            {
                "streamId": stream_id,
                "streamType": stream.stream_type,
                "epoch": self.epoch,
                "fromSeq": position,
                "serverTime": self.now(),
            },
            f"{self.epoch}:{position}",
        )
        if gap:
            yield _event("gap", gap)
        while not self.closing and generation == self._generation:
            if position < stream.tail:
                yield _event(
                    "gap", {"fromSeq": position, "toSeq": stream.tail - 1, "reason": "overflow"}
                )
                position = stream.tail
            records = stream.records[position - stream.tail :][:500]
            if records:
                position = records[-1]["seq"] + 1
                yield _event(
                    "batch",
                    {"records": records, "watermark": self._watermark(stream, position)},
                    f"{self.epoch}:{position}",
                )
            yield _event(
                "status",
                {
                    "state": stream.state,
                    "sampling": False,
                    "errors": 0,
                    "watermark": self._watermark(stream, position),
                },
            )
            await asyncio.sleep(self.interval)
        if self.closing:
            yield _event(
                "status",
                {"state": "closed", "sampling": False, "errors": 0, "watermark": self.now()},
            )


def _event(name: str, data: dict[str, Any], event_id: str | None = None) -> bytes:
    head = f"event: {name}\n" + (f"id: {event_id}\n" if event_id is not None else "")
    return (head + "data: " + json.dumps(data) + "\n\n").encode()

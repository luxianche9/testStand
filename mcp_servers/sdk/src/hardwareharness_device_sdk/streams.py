"""Streams published by a device: sampled readings, pushed values and byte traffic.

Streams are read-only views. They share one :class:`RingBuffer` between the
WebSocket channel (``/streams/{streamId}``) and the MCP ``<prefix>_stream_read``
tool, so live widgets and AI/test steps observe the same sequence numbers.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from typing import Any, ClassVar, Protocol

from .errors import INVALID_ARGUMENT, NOT_CONFIGURED, DeviceError
from .ringbuffer import RingBuffer

log = logging.getLogger("hardwareharness_device_sdk.streams")

STREAM_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
MIN_RATE_HZ, MAX_RATE_HZ = 0.1, 100.0
MAX_HOLD_SECONDS = 3600.0

BYTES_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dir": {"enum": ["rx", "tx"], "description": "rx=received from the peer, tx=accepted by the driver for sending."},
        "bytes": {"type": "integer", "description": "Chunk length in bytes."},
        "hex": {"type": "string", "description": "Exact raw bytes as space-separated hexadecimal."},
        "text": {"type": "string", "description": "UTF-8 with replacement; chunk boundaries can split characters."},
    },
    "required": ["dir", "bytes", "hex", "text"],
}


class SampleRunner(Protocol):
    @property
    def available(self) -> bool: ...

    async def sample(self, fn: Callable[[], Any]) -> Any: ...


class Stream:
    """A pushed stream: the device calls :meth:`publish` whenever the value changes."""

    kind: ClassVar[str] = "push"

    def __init__(
        self,
        stream_id: str,
        *,
        label: str,
        description: str = "",
        unit: str | None = None,
        value_schema: Mapping[str, Any] | None = None,
        capacity: int = 4096,
        max_weight: int | None = None,
        requires: tuple[str, ...] | list[str] = (),
        channel: int | None = None,
        meta: Mapping[str, Any] | None = None,
    ) -> None:
        if not STREAM_ID.match(stream_id):
            raise ValueError(f"Invalid streamId {stream_id!r}; use 1-64 of [A-Za-z0-9_.-]")
        self.stream_id = stream_id
        self.label = label
        self.description = description
        self.unit = unit
        self.value_schema = dict(value_schema or {})
        self.requires = tuple(requires)
        self.channel = channel
        self.meta = dict(meta or {})
        self.buffer = RingBuffer(capacity, max_weight=max_weight)
        self._status_lock = threading.Lock()
        self._state = "live"
        self._error: dict[str, Any] | None = None
        self.status_version = 0

    # --- status -------------------------------------------------------
    def set_status(self, state: str, error: Mapping[str, Any] | None = None) -> None:
        with self._status_lock:
            error = dict(error) if error is not None else None
            if (state, error) != (self._state, self._error):
                self._state, self._error = state, error
                self.status_version += 1

    def status(self) -> tuple[str, dict[str, Any] | None, int]:
        with self._status_lock:
            return self._state, self._error, self.status_version

    # --- data ---------------------------------------------------------
    def append(self, fields: dict[str, Any], *, weight: int = 0) -> dict[str, Any]:
        return self.buffer.append(fields, weight=weight)

    def publish(self, value: Any, **extra: Any) -> dict[str, Any]:
        return self.append({"value": value, **extra})

    def describe(self) -> dict[str, Any]:
        state, error, _ = self.status()
        result: dict[str, Any] = {
            "streamId": self.stream_id, "kind": self.kind, "label": self.label, "description": self.description,
            "unit": self.unit, "valueSchema": self.value_schema, "requires": list(self.requires),
            "state": state, "error": error, "epoch": self.buffer.epoch, "head": self.buffer.head,
            "tail": self.buffer.tail, "capacity": self.buffer.capacity,
        }
        if self.channel is not None:
            result["channel"] = self.channel
        if self.meta:
            result["meta"] = dict(self.meta)
        return result

    # --- demand (only sampled streams do work on demand) --------------
    def acquire(self) -> None:
        return None

    def release(self) -> None:
        return None

    def hold(self, seconds: float) -> float:
        return 0.0

    def unhold(self) -> None:
        return None

    def bind(self, runner: SampleRunner) -> None:
        return None

    async def aclose(self) -> None:
        self.set_status("closed")


class ByteStream(Stream):
    """Serial-style traffic: adapter reader threads call :meth:`rx`, write tools call :meth:`tx`."""

    kind: ClassVar[str] = "bytes"

    def __init__(self, stream_id: str, *, label: str, capacity: int = 65536, max_bytes: int = 1 << 20,
                 **kwargs: Any) -> None:
        kwargs.setdefault("value_schema", BYTES_SCHEMA)
        super().__init__(stream_id, label=label, capacity=capacity, max_weight=max_bytes, **kwargs)

    def _chunk(self, direction: str, data: bytes) -> dict[str, Any] | None:
        if not data:
            return None
        return self.append({"dir": direction, "bytes": len(data), "hex": data.hex(" "),
                            "text": data.decode("utf-8", errors="replace")}, weight=len(data))

    def rx(self, data: bytes) -> dict[str, Any] | None:
        return self._chunk("rx", bytes(data))

    def tx(self, data: bytes) -> dict[str, Any] | None:
        return self._chunk("tx", bytes(data))


class SampledStream(Stream):
    """Polls ``sample`` at ``rate_hz`` while someone watches it.

    Sampling runs only with at least one WebSocket subscriber or an explicit
    ``stream_start`` hold, and each sample goes through the device operation
    lock, so it interleaves with (never overlaps) tool calls. ``sample`` raising
    ``DeviceError(category="not_configured")`` reports state ``not_configured``
    instead of an error, e.g. an AI channel read before ``configure_ai``.
    """

    kind: ClassVar[str] = "sampled"

    def __init__(self, stream_id: str, *, label: str, sample: Callable[[], Any], rate_hz: float = 10.0,
                 publish_on_change: bool = False, **kwargs: Any) -> None:
        super().__init__(stream_id, label=label, **kwargs)
        self.sample = sample
        self.rate_hz = min(MAX_RATE_HZ, max(MIN_RATE_HZ, float(rate_hz)))
        self.publish_on_change = publish_on_change
        self._subscribers = 0
        self._hold_until = 0.0
        self._runner: SampleRunner | None = None
        self._task: asyncio.Task[None] | None = None
        self._closed = False
        self._state = "idle"

    def describe(self) -> dict[str, Any]:
        return {**super().describe(), "rateHz": self.rate_hz, "subscribers": self._subscribers,
                "holdSeconds": max(0.0, round(self._hold_until - time.monotonic(), 3))}

    def bind(self, runner: SampleRunner) -> None:
        self._runner = runner
        self._closed = False

    def _wanted(self) -> bool:
        return not self._closed and (self._subscribers > 0 or time.monotonic() < self._hold_until)

    def _kick(self) -> None:
        if self._runner is None or self._closed or (self._task is not None and not self._task.done()):
            return
        if self._wanted():
            self._task = asyncio.get_running_loop().create_task(self._run(), name=f"stream:{self.stream_id}")

    def acquire(self) -> None:
        self._subscribers += 1
        self._kick()

    def release(self) -> None:
        self._subscribers = max(0, self._subscribers - 1)

    def hold(self, seconds: float) -> float:
        seconds = min(MAX_HOLD_SECONDS, max(0.0, float(seconds)))
        self._hold_until = max(self._hold_until, time.monotonic() + seconds)
        self._kick()
        return seconds

    def unhold(self) -> None:
        self._hold_until = 0.0

    async def _run(self) -> None:
        assert self._runner is not None
        period = 1.0 / self.rate_hz
        last: Any = object()
        try:
            while self._wanted():
                started = time.monotonic()
                if not self._runner.available:
                    self.set_status("unavailable")
                    await asyncio.sleep(max(period, 1.0))
                    continue
                try:
                    value = await self._runner.sample(self.sample)
                except DeviceError as exc:
                    state = "not_configured" if exc.category == NOT_CONFIGURED else "error"
                    self.set_status(state, {"category": exc.category, "message": str(exc)})
                    await asyncio.sleep(max(period, 1.0))
                    continue
                except Exception as exc:
                    log.exception("Sampling %s failed", self.stream_id)
                    self.set_status("error", {"category": "internal", "message": str(exc)})
                    await asyncio.sleep(max(period, 1.0))
                    continue
                self.set_status("running")
                if not self.publish_on_change or value != last:
                    self.publish(value)
                    last = value
                await asyncio.sleep(max(0.0, period - (time.monotonic() - started)))
        finally:
            if not self._closed:
                self.set_status("idle")

    async def aclose(self) -> None:
        self._closed = True
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self.set_status("closed")


class StreamRegistry(Mapping[str, Stream]):
    def __init__(self) -> None:
        self._streams: dict[str, Stream] = {}

    def add(self, stream: Stream) -> Stream:
        if stream.stream_id in self._streams:
            raise ValueError(f"Duplicate streamId {stream.stream_id}")
        self._streams[stream.stream_id] = stream
        return stream

    def require(self, stream_id: str) -> Stream:
        stream = self._streams.get(stream_id)
        if stream is None:
            raise DeviceError(f"Unknown streamId {stream_id!r}; read list_streams for exact identifiers",
                              category=INVALID_ARGUMENT, details={"known": sorted(self._streams)})
        return stream

    def __getitem__(self, stream_id: str) -> Stream:
        return self._streams[stream_id]

    def __iter__(self) -> Iterator[str]:
        return iter(self._streams)

    def __len__(self) -> int:
        return len(self._streams)

    def describe(self) -> list[dict[str, Any]]:
        return [stream.describe() for stream in self._streams.values()]

    def bind(self, runner: SampleRunner) -> None:
        for stream in self._streams.values():
            stream.bind(runner)

    async def aclose(self) -> None:
        for stream in self._streams.values():
            await stream.aclose()

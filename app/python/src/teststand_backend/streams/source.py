"""Device stream sources: the ring buffers of the device plugins loaded in this process.

A :class:`StreamSource` follows one stream of a loaded device (``DeviceHandle``) and yields
normalized events, reading the device's ring buffer directly (in this process, or over the
child process's stdio for an isolated device). Records keep the device time ``t`` and gain the
backend time ``tb``; both are the same clock (:mod:`.clock`), so ``tb == t``.

Events yielded by :meth:`StreamSource.events`:

* ``hello``  — ``{streamType, epoch}`` on every (re)start
* ``batch``  — ``{records: [{seq, t, tb, op?, ...}], watermark}``
* ``gap``    — ``{reason, fromSeq, toSeq, t0, t1}``: times ``(t0, t1)`` have missing records
  (``overflow`` evicted from the ring buffer, ``reset`` the device restarted)
* ``status`` — device status ``{state, sampling, errors, lastError?, watermark}``
* ``state``  — connection state ``{state: disconnected | unknown_stream, message}``;
  ``unknown_stream`` ends the iteration

A stream the device does not declare may be *derived* from one it does (a protocol field
decoded from a raw ``bytes``/``frames`` stream): :class:`StreamSources` asks its ``derived``
resolver and then follows the raw stream with a :class:`DerivedSource`, which yields the same
events, so recorders, the live view and verdicts treat both alike.
"""

from __future__ import annotations

import asyncio
import contextlib
import weakref
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from teststand_backend.contracts.errors import app_error
from teststand_backend.util import Record

from .clock import SHARED_CLOCK, SharedClock

BACKOFF_MIN, BACKOFF_MAX = 0.2, 5.0
BATCH_INTERVAL = 0.05
STATUS_INTERVAL = 0.2
MAX_BATCH_RECORDS = 500

DeviceResolver = Callable[[str], Any]
"""``hardwareId`` -> the loaded device (``DeviceHandle``), ``None`` when none is loaded."""


class Decoder(Protocol):
    def on_event(self, event: Record) -> list[Record]:
        """One raw-stream event -> derived events (``batch`` as ``{streams: {id: records}}``)."""
        ...


@dataclass(frozen=True)
class DerivedSpec:
    """A stream computed from another stream of the same device (a protocol field)."""

    source_stream_id: str
    stream_type: str
    decoder: Callable[[], Decoder]
    """A fresh decoder: one per source session, so a restarted device starts clean."""
    declaration: Record | None = None


DerivedResolver = Callable[[str, str], DerivedSpec | None]
"""``(hardwareId, streamId)`` -> how to derive it, ``None`` for a stream the device declares."""


class StreamSources:
    """Creates stream sources for the loaded devices."""

    def __init__(self, devices: DeviceResolver, derived: DerivedResolver | None = None) -> None:
        self.devices = devices
        self.derived = derived

    def source(
        self, hardware_id: str, stream_id: str, *, since: float | None = None
    ) -> EventSource:
        """``since``: time of the first wanted record (pre-roll); ``None`` = new only."""
        device = self.devices(hardware_id)
        if device is None:
            raise app_error(
                "not_found",
                f"No loaded device for hardware {hardware_id}",
                {"hardwareId": hardware_id},
            )
        spec = self.derived(hardware_id, stream_id) if self.derived is not None else None
        if spec is not None:
            raw = StreamSource(device, spec.source_stream_id, since=since)
            return DerivedSource(raw, stream_id, spec)
        return StreamSource(device, stream_id, since=since)

    def clock(self, hardware_id: str) -> SharedClock:
        return SHARED_CLOCK


_DECLARED: weakref.WeakKeyDictionary[Any, asyncio.Task[list[Record]]] = weakref.WeakKeyDictionary()


async def _declared_streams(device: Any) -> list[Record]:
    """The device's stream declarations, read once per loaded device (``describe`` builds every
    tool schema, and every stream of the device asks)."""
    task = _DECLARED.get(device)
    if task is None:
        task = asyncio.ensure_future(_describe_streams(device))
        _DECLARED[device] = task
    return await asyncio.shield(task)


async def _describe_streams(device: Any) -> list[Record]:
    try:
        described = await device.describe()
    except Exception:  # a device without a document still records
        return []
    streams = ((described or {}).get("device") or {}).get("streams") or []
    return [item for item in streams if isinstance(item, dict)]


class StreamSource:
    """One followed device stream. Iterate :meth:`events`; cancel the consumer to stop."""

    def __init__(self, device: Any, stream_id: str, *, since: float | None) -> None:
        self.device = device
        self.stream_id = stream_id
        self.since = since
        self.clock = SHARED_CLOCK
        self.stream_type: str | None = None
        self.watermark: float | None = None
        self._pending_gap: Record | None = None
        self._epoch: str | None = None
        self._cursor: int | None = None

    async def events(self) -> AsyncIterator[Record]:
        backoff = BACKOFF_MIN
        disconnected = False
        while True:
            try:
                await self.device.watch(self.stream_id)
            except Exception as exc:
                yield {"type": "state", "state": "unknown_stream", "message": str(exc)}
                return
            try:
                async for event in self._session():
                    if event["type"] == "hello":
                        backoff, disconnected = BACKOFF_MIN, False
                    yield event
                message = "device stream closed"
            except Exception as exc:
                message = str(exc) or type(exc).__name__
            finally:
                with contextlib.suppress(Exception):
                    await self.device.unwatch(self.stream_id)
            if not disconnected:
                disconnected = True
                yield {"type": "state", "state": "disconnected", "message": message}
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX)

    async def _declaration(self) -> Record | None:
        """The stream's ``/device.streams[]`` entry (label, unit, width, bitLabels, display ...)."""
        streams = await _declared_streams(self.device)
        for item in streams:
            if isinstance(item, dict) and item.get("id") == self.stream_id:
                return {key: value for key, value in item.items() if key not in {"id", "type"}}
        return None

    async def _session(self) -> AsyncIterator[Record]:
        cursor = self._cursor
        if cursor is None and self.since is not None:
            cursor = await self.device.seek(self.stream_id, self.since)
        first = await self.device.read_stream(self.stream_id, cursor, 0, self._epoch)
        self._epoch, position = first["epoch"], first["next"]
        self.stream_type = first["streamType"]
        yield {
            "type": "hello",
            "streamType": first["streamType"],
            "epoch": first["epoch"],
            **({"declaration": declaration} if (declaration := await self._declaration()) else {}),
        }
        if "gap" in first:
            self._open_gap(first["gap"])
        last_status: Record | None = None
        last_sent = 0.0
        loop = asyncio.get_running_loop()
        while True:
            result = await self.device.read_stream(
                self.stream_id, position, MAX_BATCH_RECORDS, self._epoch
            )
            if "gap" in result:
                self._open_gap(result["gap"])
            position = self._cursor = result["next"]
            records: list[Record] = result["records"]
            if records:
                for event in self._close_gap(records[0]["t"]):
                    yield event
                for record in records:
                    record["tb"] = record["t"]
                self._advance(result["watermark"])
                yield {"type": "batch", "records": records, "watermark": self.watermark}
                last_sent = loop.time()
            status = result["status"]
            changed = last_status is None or _without_watermark(status) != _without_watermark(
                last_status
            )
            if changed or loop.time() - last_sent >= STATUS_INTERVAL:
                for event in self._close_gap(status.get("watermark")):
                    yield event
                self._advance(status.get("watermark"))
                yield {"type": "status", **status}
                last_status, last_sent = status, loop.time()
            await asyncio.sleep(0 if len(records) == MAX_BATCH_RECORDS else BATCH_INTERVAL)

    def _advance(self, watermark: Any) -> None:
        if isinstance(watermark, (int, float)) and (
            self.watermark is None or watermark > self.watermark
        ):
            self.watermark = float(watermark)

    def _open_gap(self, data: Record) -> None:
        if self._pending_gap is not None:
            self._pending_gap["toSeq"] = data.get("toSeq")
            return
        t0 = self.watermark
        if t0 is None:
            t0 = self.since if self.since is not None else 0.0
        self._pending_gap = {
            "type": "gap",
            "reason": data.get("reason"),
            "fromSeq": data.get("fromSeq"),
            "toSeq": data.get("toSeq"),
            "t0": round(t0, 3),
        }

    def _close_gap(self, t1: Any) -> list[Record]:
        gap = self._pending_gap
        if gap is None or not isinstance(t1, (int, float)):
            return []
        self._pending_gap = None
        gap["t1"] = round(max(float(t1), gap["t0"]), 3)
        return [gap]


def _without_watermark(status: Record) -> Record:
    return {key: value for key, value in status.items() if key != "watermark"}


class EventSource(Protocol):
    def events(self) -> AsyncIterator[Record]: ...


class DerivedSource:
    """A derived stream: follows the raw stream it is computed from and decodes as it goes.

    Same events as :class:`StreamSource`. ``hello`` carries the derived type and declaration
    (and starts a fresh decoder); each raw ``batch`` becomes a batch of this stream's derived
    records, possibly empty, which still advances the watermark; a raw ``gap`` first flushes
    the decoder's partial bytes, then passes through; ``status`` and ``state`` pass through.
    """

    def __init__(self, raw: EventSource, stream_id: str, spec: DerivedSpec) -> None:
        self.raw, self.stream_id, self.spec = raw, stream_id, spec

    async def events(self) -> AsyncIterator[Record]:
        decoder: Decoder | None = None
        async for event in self.raw.events():
            kind = event.get("type")
            if kind == "hello":
                decoder = self.spec.decoder()
                hello: Record = {**event, "streamType": self.spec.stream_type}
                hello.pop("declaration", None)
                if self.spec.declaration:
                    hello["declaration"] = dict(self.spec.declaration)
                yield hello
            elif kind in ("batch", "gap") and decoder is not None:
                for derived in decoder.on_event(event):
                    if derived.get("type") == "batch":
                        records = (derived.get("streams") or {}).get(self.stream_id) or []
                        yield {
                            "type": "batch",
                            "records": records,
                            "watermark": derived.get("watermark"),
                        }
                    else:
                        yield derived
            else:
                yield event

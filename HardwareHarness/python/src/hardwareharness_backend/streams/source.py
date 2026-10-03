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
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable
from typing import Any

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.util import Record

from .clock import SHARED_CLOCK, SharedClock

BACKOFF_MIN, BACKOFF_MAX = 0.2, 5.0
BATCH_INTERVAL = 0.05
STATUS_INTERVAL = 0.2
MAX_BATCH_RECORDS = 500

DeviceResolver = Callable[[str], Any]
"""``hardwareId`` -> the loaded device (``DeviceHandle``), ``None`` when none is loaded."""


class StreamSources:
    """Creates stream sources for the loaded devices."""

    def __init__(self, devices: DeviceResolver) -> None:
        self.devices = devices

    def source(
        self, hardware_id: str, stream_id: str, *, since: float | None = None
    ) -> StreamSource:
        """``since``: time of the first wanted record (pre-roll); ``None`` = new only."""
        device = self.devices(hardware_id)
        if device is None:
            raise app_error(
                "not_found",
                f"No loaded device for hardware {hardware_id}",
                {"hardwareId": hardware_id},
            )
        return StreamSource(device, stream_id, since=since)

    def clock(self, hardware_id: str) -> SharedClock:
        return SHARED_CLOCK


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

    async def _session(self) -> AsyncIterator[Record]:
        cursor = self._cursor
        if cursor is None and self.since is not None:
            cursor = await self.device.seek(self.stream_id, self.since)
        first = await self.device.read_stream(self.stream_id, cursor, 0, self._epoch)
        self._epoch, position = first["epoch"], first["next"]
        self.stream_type = first["streamType"]
        yield {"type": "hello", "streamType": first["streamType"], "epoch": first["epoch"]}
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

"""SSE data channel ``GET /streams/{streamId}?from=<seq|latest>&since=<t>`` (read-only).

Events (``data:`` is JSON):

* ``hello``  — ``{streamId, streamType, epoch, fromSeq, serverTime}``, ``id: <epoch>:<fromSeq>``
* ``batch``  — ``{records: [{seq, t, op?, ...payload}], watermark}``, ``id: <epoch>:<next seq>``
* ``gap``    — ``{fromSeq, toSeq, reason: overflow|reset}``; records were evicted before they
  could be sent, or the cursor came from another epoch (restart at the oldest record)
* ``status`` — ``{state, sampling, errors, lastError?, watermark}``; on change and at least
  every ``STATUS_INTERVAL`` seconds without other events

``watermark`` promises that every record with ``t <= watermark`` has been
sent, so a consumer can tell "nothing happened" from "not arrived yet"
(event streams advance it through ``idle()`` from their reader thread).
The channel only transports records; it never compares or judges them.
``from`` defaults to ``latest`` (only new records); ``since`` starts at the
first retained record with ``t >= since`` (pre-roll) and wins over ``from``;
on level streams (scalar, bits) it starts at the record still in force at
``since``, so a new subscriber sees a DI mask that has not changed for hours.
A client resumes with the standard ``Last-Event-ID`` header, which overrides
both. Subscribing makes a sampled stream poll the device; control stays on MCP.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

from .clock import now_ms
from .ringbuffer import ReadResult, RingBuffer

if TYPE_CHECKING:
    from .app import DeviceService
    from .streams import Stream

BATCH_INTERVAL = 0.05
STATUS_INTERVAL = 0.2
MAX_BATCH_RECORDS = 500
LEVEL_TYPES = frozenset({"scalar", "bits"})  # a record holds until the next one


def _event(event: str, data: dict[str, Any], event_id: str | None = None) -> bytes:
    head = f"event: {event}\n" + (f"id: {event_id}\n" if event_id is not None else "")
    return (head + "data: " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode()


def _cursor(raw: str | None) -> int | None:
    if raw is None or raw in {"", "latest"}:
        return None
    try:
        return max(0, int(raw))
    except ValueError:
        return None


def _start(request: Request, buffer: RingBuffer, *, hold: bool) -> tuple[int | None, str | None]:
    """``(cursor, epoch)`` from ``Last-Event-ID``, else ``since``, else ``from``."""
    last = request.headers.get("last-event-id", "")
    epoch, sep, seq = last.rpartition(":")
    if sep and epoch and seq.isdigit():
        return int(seq), epoch
    since = request.query_params.get("since")
    if since:
        try:
            return buffer.seek(float(since), hold=hold), None
        except ValueError:
            pass
    return _cursor(request.query_params.get("from")), None


def _gap(result: ReadResult) -> dict[str, Any] | None:
    if result.reset:
        return {"fromSeq": None, "toSeq": result.tail - 1, "reason": "reset"}
    if result.dropped:
        return {"fromSeq": result.dropped[0], "toSeq": result.dropped[1], "reason": "overflow"}
    return None


async def stream_events(request: Request) -> Response:
    service: DeviceService = request.app.state.service
    stream_id = request.path_params["streamId"]
    stream = service.device.streams.get(stream_id)
    if stream is None:
        return JSONResponse({"error": "not_found", "message": f"Unknown streamId {stream_id}"}, status_code=404)
    cursor, epoch = _start(request, stream.buffer, hold=stream.type in LEVEL_TYPES)
    return StreamingResponse(_events(service, stream, cursor, epoch), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _events(service: DeviceService, stream: Stream, cursor: int | None,
                  epoch: str | None) -> AsyncIterator[bytes]:
    buffer = stream.buffer
    stream.acquire()
    try:
        first = buffer.read(cursor, 0, epoch=epoch)
        position = first.next
        yield _event("hello", {"streamId": stream.stream_id, "streamType": stream.type, "epoch": buffer.epoch,
                               "fromSeq": position, "serverTime": now_ms()}, f"{buffer.epoch}:{position}")
        gap = _gap(first)
        if gap:
            yield _event("gap", gap)
        last_status: dict[str, Any] | None = None
        last_sent = 0.0
        while not service.closing:
            result = buffer.read(position, MAX_BATCH_RECORDS)
            gap = _gap(result)
            if gap:
                yield _event("gap", gap)
            position = result.next
            if result.records:
                yield _event("batch", {"records": result.records, "watermark": result.watermark},
                             f"{buffer.epoch}:{position}")
                last_sent = time.monotonic()
            status = {**stream.status(), "watermark": result.watermark}
            changed = last_status is None or {k: v for k, v in status.items() if k != "watermark"} != {
                k: v for k, v in last_status.items() if k != "watermark"}
            if changed or time.monotonic() - last_sent >= STATUS_INTERVAL:
                yield _event("status", status)
                last_status, last_sent = status, time.monotonic()
            await asyncio.sleep(0 if len(result.records) == MAX_BATCH_RECORDS else BATCH_INTERVAL)
        yield _event("status", {**stream.status(), "state": "closed", "watermark": buffer.watermark()})
    finally:
        stream.release()

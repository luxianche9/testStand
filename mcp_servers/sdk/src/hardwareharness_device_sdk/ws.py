"""WebSocket data channel ``/streams/{streamId}?from=<cursor|-N>``.

Frames (JSON text):

* ``hello``  — ``{type, streamId, hardwareId, kind, label, unit, valueSchema, epoch, head, tail, cursor, state, error}``
* ``batch``  — ``{type, items: [{seq, t, ...}], next}``; coalesced every ``BATCH_INTERVAL`` seconds
* ``gap``    — ``{type, from, to, reason}``; entries were evicted (``overflow``) or the cursor
  belonged to another server epoch (``reset``)
* ``status`` — ``{type, state, error}`` whenever the stream state changes

Without ``from`` the channel starts at the current head (live only). Clients
resume after a disconnect with ``from=<last next>`` if ``epoch`` is unchanged.
The channel is read-only; control stays on MCP.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import TYPE_CHECKING, Any

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

if TYPE_CHECKING:
    from .app import DeviceService

BATCH_INTERVAL = 0.05
MAX_BATCH_ITEMS = 500
CLOSE_GOING_AWAY = 1001
CLOSE_UNKNOWN_STREAM = 4404

log = logging.getLogger("hardwareharness_device_sdk.ws")


def _cursor(raw: str | None) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _is_ping(text: str | None) -> bool:
    if not text:
        return False
    try:
        message = json.loads(text)
    except ValueError:
        return False
    return isinstance(message, dict) and message.get("type") == "ping"


async def stream_socket(websocket: WebSocket, service: DeviceService) -> None:
    stream_id = websocket.path_params["streamId"]
    stream = service.device.streams.get(stream_id)
    await websocket.accept()
    if stream is None:
        await websocket.send_json({"type": "status", "state": "error",
                                   "error": {"category": "invalid_argument", "message": f"Unknown streamId {stream_id!r}"}})
        await websocket.close(CLOSE_UNKNOWN_STREAM)
        return
    stream.acquire()
    receiver: asyncio.Task[Any] | None = None
    try:
        first = stream.buffer.read(_cursor(websocket.query_params.get("from")), 0)
        cursor = first.next
        state, error, version = stream.status()
        await websocket.send_json({"type": "hello", "streamId": stream.stream_id, "hardwareId": service.device.hardware_id,
                                   "kind": stream.kind, "label": stream.label, "unit": stream.unit,
                                   "valueSchema": stream.value_schema, "epoch": stream.buffer.epoch,
                                   "head": first.head, "tail": first.tail, "cursor": cursor, "state": state, "error": error})
        if first.dropped or first.reset:
            await websocket.send_json({"type": "gap", "from": first.dropped[0] if first.dropped else None,
                                       "to": first.tail, "reason": "reset" if first.reset else "overflow"})
        receiver = asyncio.ensure_future(websocket.receive())
        while not service.closing:
            result = stream.buffer.read(cursor, MAX_BATCH_ITEMS)
            if result.dropped or result.reset:
                await websocket.send_json({"type": "gap", "from": result.dropped[0] if result.dropped else None,
                                           "to": result.tail, "reason": "reset" if result.reset else "overflow"})
            if result.items:
                await websocket.send_json({"type": "batch", "items": result.items, "next": result.next})
            cursor = result.next
            current = stream.status()
            if current[2] != version:
                state, error, version = current
                await websocket.send_json({"type": "status", "state": state, "error": error})
            if len(result.items) == MAX_BATCH_ITEMS:
                await asyncio.sleep(0)
                continue
            done, _ = await asyncio.wait({receiver}, timeout=BATCH_INTERVAL)
            if done:
                message = receiver.result()
                if message["type"] == "websocket.disconnect":
                    return
                if _is_ping(message.get("text")):
                    await websocket.send_json({"type": "pong"})
                receiver = asyncio.ensure_future(websocket.receive())
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.send_json({"type": "status", "state": "closed", "error": None})
            await websocket.close(CLOSE_GOING_AWAY)
    except WebSocketDisconnect:
        return
    except RuntimeError as exc:  # send after the peer vanished
        log.debug("Stream socket %s ended: %s", stream_id, exc)
    finally:
        stream.release()
        if receiver is not None and not receiver.done():
            receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await receiver

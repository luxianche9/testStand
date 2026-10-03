"""The service's local HTTP API (design doc §9.4).

``POST /api/ops/{name}`` runs one ``@operation`` with its arguments as a named JSON body,
``GET /api/events`` streams events (SSE, resumable with ``Last-Event-ID``) and
``GET /api/live?keys=&width=&window=`` streams live stream frames (design doc 5.9.3; the
frame time is the event id, ``Last-Event-ID`` resumes after it). Bound to 127.0.0.1 on a
random port. ``openapi.json`` is generated at build time (python/scripts/generate_operations.py),
not served.

One bearer token, always in the ``Authorization`` header (the renderer reads SSE with
``fetch``, so it never needs a query-string token). Browsers may only call from the
renderer's origins; requests without an ``Origin`` (the main process, tests) are not browser
requests.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import socket
from collections import deque
from collections.abc import AsyncGenerator, Awaitable, Callable, Collection
from typing import Any
from urllib.parse import parse_qs, unquote

import uvicorn

from hardwareharness_backend.contracts.errors import AppError, to_wire_error
from hardwareharness_backend.contracts.wire import to_json

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
Invoke = Callable[[dict[str, Any], str, bytes | None], Awaitable[Any]]
"""``(context, operation, body)``: the registry call; ``body`` is the raw JSON request."""
Live = Callable[..., AsyncGenerator[dict[str, Any] | None, None]]
"""``(keys, *, width, window_ms, resume_tb)``: validates (raising before the stream starts),
then the frames; ``None`` is a keepalive tick (``LiveStreams.subscribe``)."""
SseItem = tuple[Any, str, Any] | None
"""``(id, event, payload)``, or ``None`` for a keepalive comment."""

MAX_BODY = 64 * 1024 * 1024
KEEPALIVE_S = 15.0
OPS_PREFIX = "/api/ops/"
RENDERER_CONTEXT = {"actor": "human", "source": "desktop"}
STATUS = {
    "invalid_argument": 400,
    "invalid_project_folder": 400,
    "permission_denied": 403,
    "not_found": 404,
    "conflict": 409,
    "project_exists": 409,
    "requires_project": 409,
    "project_uninitialized": 409,
    "invalid_project": 409,
    "cancelled": 409,
    "validation_failed": 422,
    "assertion_failed": 422,
    "loop_limit": 422,
    "unknown_outcome": 502,
    "invalid_response": 502,
    "unavailable": 503,
}
"""HTTP status of each error category; anything else is 500."""
Headers = list[tuple[bytes, bytes]]
_PREFLIGHT: Headers = [
    (b"access-control-allow-headers", b"authorization, content-type, last-event-id"),
    (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
    (b"access-control-max-age", b"600"),
]


class EventBus:
    """Sequenced ring buffer of events; subscribers resume with ``after``."""

    def __init__(self, capacity: int = 2000) -> None:
        self.sequence = 0
        self._events: deque[tuple[int, str, Any]] = deque(maxlen=capacity)
        self._changed = asyncio.Event()
        self._closed = False

    def publish(self, event: str, payload: Any) -> int:
        self.sequence += 1
        self._events.append((self.sequence, event, payload))
        self._changed.set()
        self._changed = asyncio.Event()
        return self.sequence

    def close(self) -> None:
        self._closed = True
        self._changed.set()

    def since(self, after: int) -> tuple[bool, list[tuple[int, str, Any]]]:
        """Events newer than ``after``; the flag is true when older ones already fell off."""
        oldest = self._events[0][0] if self._events else self.sequence + 1
        missed = after + 1 < oldest and after < self.sequence
        return missed, [item for item in self._events if item[0] > after]

    async def subscribe(
        self, after: int | None, keepalive_s: float = KEEPALIVE_S
    ) -> AsyncGenerator[tuple[int, str, Any] | None, None]:
        """Yield ``(sequence, event, payload)``; ``None`` is a keepalive tick; a ``gap``
        event reports events lost before the buffer's oldest entry."""
        cursor = self.sequence if after is None else after
        while not self._closed:
            changed = self._changed
            missed, events = self.since(cursor)
            if missed:
                yield (events[0][0] - 1 if events else self.sequence, "gap", {"after": cursor})
            for item in events:
                yield item
                cursor = item[0]
            if missed and not events:
                cursor = self.sequence
            if events or missed:
                continue
            try:
                await asyncio.wait_for(changed.wait(), keepalive_s)
            except TimeoutError:
                yield None


class LocalApi:
    def __init__(
        self,
        invoke: Invoke,
        bus: EventBus,
        *,
        token: str | None = None,
        origins: Collection[str] = (),
        live: Live | None = None,
    ) -> None:
        """``origins`` are the renderer's (``null`` for a page loaded from ``file://``)."""
        self.invoke, self.bus, self.live = invoke, bus, live
        self.token = token or secrets.token_urlsafe(32)
        self.origins = frozenset(origins)
        self.port = 0
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None
        self._streams: set[asyncio.Event] = set()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> None:
        if self._server is not None:
            return
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.setblocking(False)
            self.port = listener.getsockname()[1]
            config = uvicorn.Config(
                self.handle,
                host="127.0.0.1",
                port=self.port,
                loop="asyncio",
                http="h11",
                ws="none",
                lifespan="off",
                interface="asgi3",
                log_config=None,
                access_log=False,
                log_level="critical",
                timeout_graceful_shutdown=1,
            )
            server = uvicorn.Server(config)
            self._task = asyncio.create_task(server.serve(sockets=[listener]))
            while not server.started:
                if self._task.done():
                    self._task.result()
                    raise RuntimeError("Local API failed to start")
                await asyncio.sleep(0.001)
            self._server = server
        except BaseException:
            listener.close()
            raise

    async def stop(self) -> None:
        for stop in list(self._streams):
            stop.set()
        server, self._server = self._server, None
        if server is not None:
            server.should_exit = True
        if self._task is not None:
            await self._task
            self._task = None

    async def handle(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        headers = {
            key.decode("latin1").lower(): value.decode("latin1")
            for key, value in scope.get("headers", [])
        }
        method, path = scope["method"], scope["path"]
        origin = headers.get("origin")
        cors: Headers = []
        if origin is not None:
            if origin not in self.origins:
                await _respond_error(send, AppError("permission_denied", "Bad origin"), 403)
                return
            cors = [(b"access-control-allow-origin", origin.encode("latin1")), (b"vary", b"origin")]
        if method == "OPTIONS":
            await _respond(send, 204, b"", headers=[*cors, *_PREFLIGHT])
            return
        if headers.get("host") != f"127.0.0.1:{self.port}":
            await _respond_error(send, AppError("permission_denied", "Bad host"), 421, cors)
            return
        supplied = headers.get("authorization", "")
        supplied = supplied[7:] if supplied.startswith("Bearer ") else ""
        if not secrets.compare_digest(supplied.encode(), self.token.encode()):
            await _respond_error(send, AppError("permission_denied", "Bad token"), 401, cors)
            return
        if method == "POST" and path.startswith(OPS_PREFIX):
            await self._operation(unquote(path[len(OPS_PREFIX) :]), receive, send, cors)
        elif method == "GET" and path == "/api/events":
            raw = headers.get("last-event-id")
            try:
                after = int(raw) if raw else None
            except ValueError:
                after = None
            await self._sse(self.bus.subscribe(after), receive, send, cors)
        elif method == "GET" and path == "/api/live":
            query = parse_qs(scope.get("query_string", b"").decode("latin1"))
            try:
                frames = self._live(query, headers.get("last-event-id"))
            except Exception as error:
                await _respond_error(send, error, None, cors)
                return
            await self._sse(_frames(frames), receive, send, cors)
        else:
            await _respond_error(send, AppError("not_found", "No such endpoint"), None, cors)

    async def _operation(self, name: str, receive: Receive, send: Send, cors: Headers) -> None:
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > MAX_BODY:
                too_large = AppError("invalid_argument", "Request too large")
                await _respond_error(send, too_large, 413, cors)
                return
            if not message.get("more_body"):
                break
        try:
            result = to_json(await self.invoke(dict(RENDERER_CONTEXT), name, bytes(body) or None))
        except Exception as error:
            await _respond_error(send, error, None, cors)
            return
        await _respond_json(send, 200, result, cors)

    def _live(
        self, query: dict[str, list[str]], last_event_id: str | None
    ) -> AsyncGenerator[dict[str, Any] | None, None]:
        if self.live is None:
            raise AppError("unavailable", "Live streams are not available")
        keys = [key for key in (query.get("keys") or [""])[0].split(",") if key]
        try:
            width = int((query.get("width") or [""])[0])
            window_ms = float((query.get("window") or [""])[0])
            resume_tb = float(last_event_id) if last_event_id else None
        except ValueError:
            raise AppError(
                "invalid_argument", "width, window and Last-Event-ID must be numbers"
            ) from None
        return self.live(keys, width=width, window_ms=window_ms, resume_tb=resume_tb)

    async def _sse(
        self, items: AsyncGenerator[SseItem, None], receive: Receive, send: Send, cors: Headers
    ) -> None:
        stop = asyncio.Event()
        self._streams.add(stop)

        async def watch_disconnect() -> None:
            while (await receive())["type"] != "http.disconnect":
                pass
            stop.set()

        watcher = asyncio.create_task(watch_disconnect())
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"text/event-stream; charset=utf-8"),
                    (b"cache-control", b"no-cache"),
                    (b"x-accel-buffering", b"no"),
                    *cors,
                ],
            }
        )
        stopped = asyncio.create_task(stop.wait())
        try:
            await send({"type": "http.response.body", "body": b": ready\n\n", "more_body": True})
            while True:
                step: asyncio.Task[SseItem] = asyncio.create_task(_next(items))
                done, _ = await asyncio.wait({step, stopped}, return_when=asyncio.FIRST_COMPLETED)
                if step not in done:
                    step.cancel()
                    await asyncio.gather(step, return_exceptions=True)
                    break
                try:
                    item = step.result()
                except StopAsyncIteration:
                    break
                if item is None:
                    chunk = b": keepalive\n\n"
                else:
                    event_id, event, payload = item
                    data = json.dumps(to_json(payload), separators=(",", ":"), ensure_ascii=False)
                    chunk = f"id: {event_id}\nevent: {event}\ndata: {data}\n\n".encode()
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        except OSError:
            pass
        finally:
            self._streams.discard(stop)
            stopped.cancel()
            watcher.cancel()
            await items.aclose()


async def _next(items: AsyncGenerator[SseItem, None]) -> SseItem:
    return await anext(items)


async def _frames(
    frames: AsyncGenerator[dict[str, Any] | None, None],
) -> AsyncGenerator[SseItem, None]:
    """Live frames as ``frame`` events whose id is the frame time."""
    try:
        async for frame in frames:
            yield None if frame is None else (f"{frame['t']:.3f}", "frame", frame)
    finally:
        await frames.aclose()


async def _respond(
    send: Send,
    status: int,
    body: bytes,
    content_type: bytes = b"text/plain",
    headers: Headers | None = None,
) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", content_type), *(headers or [])],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _respond_error(
    send: Send, error: BaseException, status: int | None = None, headers: Headers | None = None
) -> None:
    wire = to_wire_error(error)
    code = status or STATUS.get(wire["category"], 500)
    await _respond_json(send, code, {"error": to_json(wire)}, headers)


async def _respond_json(
    send: Send, status: int, payload: Any, headers: Headers | None = None
) -> None:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    await _respond(send, status, body.encode(), b"application/json; charset=utf-8", headers)

"""The local HTTP API: tokens, error statuses, event replay and the live stream frames."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Any

import httpx
import pytest
import pytest_asyncio

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.host.http_api import (
    HOST_CONTEXT,
    MAX_BODY,
    RENDERER_CONTEXT,
    EventBus,
    LocalApi,
)


async def take(bus: EventBus, after: int | None, count: int) -> list[tuple[int, str, Any]]:
    items: list[tuple[int, str, Any]] = []
    events = bus.subscribe(after, keepalive_s=0.05)
    try:
        async for item in events:
            if item is not None:
                items.append(item)
            if len(items) >= count:
                break
    finally:
        await events.aclose()
    return items


async def test_resume_after_the_last_seen_id() -> None:
    bus = EventBus()
    for index in range(3):
        bus.publish("testRun", {"index": index})
    assert [item[0] for item in await take(bus, 1, 2)] == [2, 3]
    assert await take(bus, 0, 3) == [
        (1, "testRun", {"index": 0}),
        (2, "testRun", {"index": 1}),
        (3, "testRun", {"index": 2}),
    ]


async def test_new_subscribers_start_at_now_and_wake_on_publish() -> None:
    bus = EventBus()
    bus.publish("old", 1)
    waiting = asyncio.create_task(take(bus, None, 1))
    await asyncio.sleep(0.01)
    bus.publish("new", 2)
    assert await asyncio.wait_for(waiting, 1) == [(2, "new", 2)]


async def test_a_gap_is_reported_before_the_oldest_buffered_event() -> None:
    bus = EventBus(capacity=2)
    for index in range(5):
        bus.publish("testRun", index)
    items = await take(bus, 1, 3)
    assert items[0] == (3, "gap", {"after": 1})
    assert [item[0] for item in items[1:]] == [4, 5]


async def test_close_ends_every_subscription() -> None:
    bus = EventBus()
    waiting = asyncio.create_task(take(bus, None, 1))
    await asyncio.sleep(0.01)
    bus.close()
    assert await asyncio.wait_for(waiting, 1) == []


class Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[dict[str, Any], str, bytes | None]] = []
        self.failure: Exception | None = None

    async def __call__(self, context: dict[str, Any], name: str, body: bytes | None) -> Any:
        self.calls.append((context, name, body))
        if self.failure is not None:
            raise self.failure
        return {"data": b"\x00\xff", "text": "中文"}


@pytest_asyncio.fixture
async def api() -> AsyncIterator[tuple[LocalApi, Recorder]]:
    recorder = Recorder()
    server = LocalApi(recorder, EventBus(), openapi=lambda: {"openapi": "3.1.0"})
    await server.start()
    try:
        yield server, recorder
    finally:
        await server.stop()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": "Bearer " + token}


async def test_each_token_maps_to_its_context(api: tuple[LocalApi, Recorder]) -> None:
    server, recorder = api
    async with httpx.AsyncClient(base_url=server.url) as http:
        renderer = await http.post("/api/ops/a.b", headers=bearer(server.token), content=b"{}")
        host = await http.post("/api/ops/desktop.state", headers=bearer(server.host_token))
    assert renderer.status_code == host.status_code == 200
    assert renderer.json() == {"data": "AP8=", "text": "中文"}  # bytes as base64
    assert [call[0] for call in recorder.calls] == [RENDERER_CONTEXT, HOST_CONTEXT]
    assert recorder.calls[0][2] == b"{}" and recorder.calls[1][2] is None


@pytest.mark.parametrize(
    ("category", "status"),
    [
        ("invalid_argument", 400),
        ("permission_denied", 403),
        ("not_found", 404),
        ("conflict", 409),
        ("requires_project", 409),
        ("validation_failed", 422),
        ("unknown_outcome", 502),
        ("unavailable", 503),
        ("error", 500),
    ],
)
async def test_error_categories_map_to_status(
    api: tuple[LocalApi, Recorder], category: str, status: int
) -> None:
    server, recorder = api
    recorder.failure = AppError(category, "failed", {"outcomeKnown": False})
    async with httpx.AsyncClient(base_url=server.url) as http:
        response = await http.post("/api/ops/a.b", headers=bearer(server.token))
    assert response.status_code == status
    error = response.json()["error"]
    assert error["category"] == category and error["message"] == "failed"


async def test_requests_are_bounded_and_query_tokens_are_only_for_events(
    api: tuple[LocalApi, Recorder],
) -> None:
    server, recorder = api
    async with httpx.AsyncClient(base_url=server.url) as http:
        large = await http.post(
            "/api/ops/a.b", headers=bearer(server.token), content=b"x" * (MAX_BODY + 1)
        )
        query = await http.post("/api/ops/a.b", params={"token": server.token})
        missing = await http.get("/api/nothing", headers=bearer(server.token))
        document = await http.get("/api/openapi.json", params={"token": server.token})
    assert large.status_code == 413
    assert query.status_code == 401
    assert missing.status_code == 404
    assert document.json() == {"openapi": "3.1.0"}
    assert recorder.calls == []


class FakeLive:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.closed = asyncio.Event()

    def __call__(
        self, keys: list[str], *, width: int, window_ms: float, resume_tb: float | None
    ) -> AsyncGenerator[dict[str, Any] | None, None]:
        if not keys:
            raise AppError("invalid_argument", "Give 1 to 64 stream keys")
        self.calls.append({"keys": keys, "width": width, "window": window_ms, "resume": resume_tb})
        return self._frames()

    async def _frames(self) -> AsyncGenerator[dict[str, Any] | None, None]:
        try:
            yield {"t": 1000.5, "colMs": 10.0, "streams": {}}
            yield None
            yield {"t": 1050.25, "colMs": 10.0, "streams": {"a__b": {"points": []}}}
            await asyncio.Event().wait()
        finally:
            self.closed.set()


async def test_live_frames_stream_as_sse_with_the_frame_time_as_id() -> None:
    live = FakeLive()
    server = LocalApi(Recorder(), EventBus(), live=live)
    await server.start()
    try:
        async with httpx.AsyncClient(base_url=server.url, timeout=5) as http:
            params = {"keys": "a__b,c__d", "width": "320", "window": "10000"}
            headers = {**bearer(server.token), "Last-Event-ID": "999.5"}
            lines: list[str] = []
            async with http.stream("GET", "/api/live", params=params, headers=headers) as stream:
                assert stream.status_code == 200
                async for line in stream.aiter_lines():
                    lines.append(line)
                    if line.startswith("data:") and "a__b" in line:
                        break
            invalid = await http.get(
                "/api/live",
                params={"keys": "", "width": "1", "window": "1"},
                headers=bearer(server.token),
            )
            bad_number = await http.get(
                "/api/live",
                params={"keys": "a__b", "width": "x", "window": "1"},
                headers=bearer(server.token),
            )
        await asyncio.wait_for(live.closed.wait(), 5)
    finally:
        await server.stop()
    assert live.calls == [
        {"keys": ["a__b", "c__d"], "width": 320, "window": 10000.0, "resume": 999.5}
    ]
    assert "id: 1000.500" in lines and "event: frame" in lines and ": keepalive" in lines
    assert "id: 1050.250" in lines
    assert invalid.status_code == bad_number.status_code == 400


async def test_live_is_unavailable_without_a_hub(api: tuple[LocalApi, Recorder]) -> None:
    server, _ = api
    async with httpx.AsyncClient(base_url=server.url) as http:
        response = await http.get(
            "/api/live",
            params={"keys": "a__b", "width": "1", "window": "100"},
            headers=bearer(server.token),
        )
    assert response.status_code == 503

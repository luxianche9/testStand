from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest
from httpx_sse import ServerSentEvent
from mcp import types
from mcp.client.streamable_http import RequestContext
from mcp.shared.message import SessionMessage

from hardwareharness_backend.devices.mcp_transport import CompatibleHttpTransport


def source(events: list[ServerSentEvent], status: int = 200) -> Any:
    async def iterate() -> AsyncIterator[ServerSentEvent]:
        for event in events:
            yield event

    return Mock(
        response=httpx.Response(status, request=httpx.Request("GET", "http://host/mcp")),
        aiter_sse=iterate,
    )


@pytest.mark.parametrize("initial_status", [401, 405, 500])
async def test_initial_get_failure_is_optional_and_does_not_retry(initial_status: int) -> None:
    transport = CompatibleHttpTransport("http://host/mcp")
    transport.__dict__["session_id"] = "S"

    @asynccontextmanager
    async def connect(*_args: Any, **_kwargs: Any) -> AsyncIterator[Any]:
        yield source([], initial_status)

    with (
        patch(
            "hardwareharness_backend.devices.mcp_transport.aconnect_sse", side_effect=connect
        ) as get,
        patch(
            "hardwareharness_backend.devices.mcp_transport.anyio.sleep", new_callable=AsyncMock
        ) as sleep,
    ):
        await transport.handle_get_stream(Mock(), Mock())
    assert get.call_count == 1
    sleep.assert_not_awaited()


async def test_sse_resumes_last_event_and_retries_failed_reconnect_five_times() -> None:
    transport = CompatibleHttpTransport("http://host/mcp")
    transport.__dict__["session_id"] = "S"
    calls: list[dict[str, Any]] = []

    @asynccontextmanager
    async def connect(*_args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        calls.append(kwargs["headers"])
        if len(calls) > 1:
            raise httpx.ConnectError("offline")
        yield source([ServerSentEvent(id="event-1", retry=73)])

    with (
        patch("hardwareharness_backend.devices.mcp_transport.aconnect_sse", side_effect=connect),
        patch(
            "hardwareharness_backend.devices.mcp_transport.anyio.sleep", new_callable=AsyncMock
        ) as sleep,
    ):
        await transport.handle_get_stream(Mock(), Mock(send=AsyncMock()))
    assert len(calls) == 6
    assert calls[0]["accept"] == "text/event-stream"
    assert "content-type" not in calls[0]
    assert all(headers["last-event-id"] == "event-1" for headers in calls[1:])
    assert [call.args[0] for call in sleep.call_args_list] == [0.073] * 5


async def test_post_resumption_restores_request_id_and_stops_on_response() -> None:
    transport = CompatibleHttpTransport("http://host/mcp")
    transport.__dict__["session_id"] = "S"
    writer = Mock(send=AsyncMock())
    ctx = RequestContext(
        client=Mock(),
        session_id="S",
        metadata=None,
        read_stream_writer=writer,
        session_message=SessionMessage(
            types.JSONRPCMessage(types.JSONRPCRequest(jsonrpc="2.0", id=41, method="tools/call"))
        ),
    )
    calls: list[dict[str, Any]] = []

    @asynccontextmanager
    async def connect(*_args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        calls.append(kwargs["headers"])
        if len(calls) == 1:
            raise httpx.ConnectError("offline")
        yield source(
            [
                ServerSentEvent(
                    id="next",
                    retry=200,
                    data=json.dumps({"jsonrpc": "2.0", "id": 9, "result": {"content": []}}),
                )
            ]
        )

    with (
        patch("hardwareharness_backend.devices.mcp_transport.aconnect_sse", side_effect=connect),
        patch(
            "hardwareharness_backend.devices.mcp_transport.anyio.sleep", new_callable=AsyncMock
        ) as sleep,
    ):
        await transport._handle_reconnection(ctx, "previous")
    assert [call.args[0] for call in sleep.call_args_list] == [1, 1.8]
    assert all(headers["last-event-id"] == "previous" for headers in calls)
    assert writer.send.call_args.args[0].message.root.id == 41


async def test_resumption_exhaustion_and_no_session_exit() -> None:
    transport = CompatibleHttpTransport("http://host/mcp")
    with patch("hardwareharness_backend.devices.mcp_transport.aconnect_sse") as get:
        await transport.handle_get_stream(Mock(), Mock())
        get.assert_not_called()
    ctx = RequestContext(
        client=Mock(),
        session_id="S",
        metadata=None,
        read_stream_writer=Mock(),
        session_message=SessionMessage(
            types.JSONRPCMessage(types.JSONRPCRequest(jsonrpc="2.0", id=1, method="tools/call"))
        ),
    )

    @asynccontextmanager
    async def connect(*_args: Any, **_kwargs: Any) -> AsyncIterator[Any]:
        yield source([], 500)

    with (
        patch(
            "hardwareharness_backend.devices.mcp_transport.aconnect_sse", side_effect=connect
        ) as get,
        patch("hardwareharness_backend.devices.mcp_transport.anyio.sleep", new_callable=AsyncMock),
    ):
        await transport._handle_reconnection(ctx, "previous")
    assert get.call_count == 5

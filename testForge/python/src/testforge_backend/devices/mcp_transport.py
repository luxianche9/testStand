"""MCP 1.29 transport adapted to the existing TS client's five-attempt backoff.

Session framing and HTTP exchange remain the official SDK implementation. Only its
two fixed-delay reconnection loops and context construction differ from TestForge.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import anyio
import httpx
from httpx_sse import aconnect_sse
from mcp.client.streamable_http import RequestContext, StreamableHTTPTransport, StreamWriter
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCRequest


class CompatibleHttpTransport(StreamableHTTPTransport):
    @staticmethod
    def retry_delay(attempt: int, server_retry_ms: int | None = None) -> float:
        return (
            server_retry_ms if server_retry_ms is not None else min(1000 * 1.8**attempt, 30000)
        ) / 1000

    async def handle_get_stream(
        self, client: httpx.AsyncClient, read_stream_writer: StreamWriter
    ) -> None:
        last_id: str | None = None
        retry_ms: int | None = None
        attempt = 0
        reconnect = False
        while attempt < 5:
            if not self.session_id:
                return
            if reconnect:
                await anyio.sleep(self.retry_delay(attempt, retry_ms))
            headers = {**self._prepare_headers(), "accept": "text/event-stream"}
            headers.pop("content-type", None)
            if last_id:
                headers["last-event-id"] = last_id
            try:
                async with aconnect_sse(client, "GET", self.url, headers=headers) as source:
                    if source.response.status_code == 405:
                        return
                    source.response.raise_for_status()
                    attempt = 0
                    reconnect = True
                    last_id = None
                    async for event in source.aiter_sse():
                        if event.id:
                            last_id = event.id
                        if event.retry is not None:
                            retry_ms = event.retry
                        if await self._handle_sse_event(event, read_stream_writer):
                            return
            except Exception:
                if not reconnect:
                    return
                attempt += 1
            reconnect = True

    async def _handle_reconnection(
        self,
        ctx: RequestContext,
        last_event_id: str,
        retry_interval_ms: int | None = None,
        attempt: int = 0,
    ) -> None:
        request = ctx.session_message.message.root
        original_id = request.id if isinstance(request, JSONRPCRequest) else None
        while attempt < 5:
            await anyio.sleep(self.retry_delay(attempt, retry_interval_ms))
            headers = {**self._prepare_headers(), "accept": "text/event-stream"}
            headers.pop("content-type", None)
            if last_event_id:
                headers["last-event-id"] = last_event_id
            try:
                async with aconnect_sse(ctx.client, "GET", self.url, headers=headers) as source:
                    if source.response.status_code == 405:
                        return
                    source.response.raise_for_status()
                    attempt = 0
                    last_event_id = ""
                    async for event in source.aiter_sse():
                        if event.id:
                            last_event_id = event.id
                        if event.retry is not None:
                            retry_interval_ms = event.retry
                        complete = await self._handle_sse_event(
                            event,
                            ctx.read_stream_writer,
                            original_id,
                            ctx.metadata.on_resumption_token_update if ctx.metadata else None,
                        )
                        if complete:
                            return
            except Exception:
                attempt += 1


@asynccontextmanager
async def compatible_http_client(url: str, client: httpx.AsyncClient) -> AsyncIterator[Any]:
    # Resource lifetime follows the archived bridge's AsyncExitStack / SDK task-group pattern.
    # The context must always be entered and exited by the same owner task.
    read_writer, read = anyio.create_memory_object_stream[SessionMessage | Exception](0)
    write, write_reader = anyio.create_memory_object_stream[SessionMessage](0)
    transport = CompatibleHttpTransport(url)
    async with anyio.create_task_group() as group:
        try:

            def start_get() -> None:
                group.start_soon(transport.handle_get_stream, client, read_writer)

            group.start_soon(
                transport.post_writer, client, write_reader, read_writer, write, start_get, group
            )
            try:
                yield read, write, transport.get_session_id
            finally:
                # TS transport.close only aborts; it never calls DELETE terminateSession.
                group.cancel_scope.cancel()
        finally:
            await read_writer.aclose()
            await write.aclose()

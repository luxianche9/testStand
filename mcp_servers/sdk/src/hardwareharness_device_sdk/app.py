"""HTTP assembly of a :class:`~.host.DeviceHost`: FastMCP tools, Bearer auth, /device, health/admin routes and streams."""

from __future__ import annotations

import asyncio
import hmac
import inspect
import os
import signal
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ._version import __version__
from .clock import now_ms
from .config import ServerConfig
from .device import Device
from .envelope import envelope
from .host import DeviceHost, HostTool
from .sse import stream_events


def _interrupt_process() -> None:
    os.kill(os.getpid(), signal.SIGINT)


class BearerAuth:
    """Pure ASGI Bearer check for HTTP scopes; fails closed without a token."""

    def __init__(self, app: ASGIApp, token: str, public_paths: frozenset[str] = frozenset({"/health"})) -> None:
        self.app = app
        self.expected = f"Bearer {token}".encode() if token else None
        self.public_paths = public_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in self.public_paths:
            await self.app(scope, receive, send)
            return
        supplied = dict(scope.get("headers") or []).get(b"authorization", b"")
        if self.expected is not None and hmac.compare_digest(supplied, self.expected):
            await self.app(scope, receive, send)
            return
        await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)


class DeviceService(DeviceHost):
    """A :class:`DeviceHost` served as a Streamable HTTP MCP server with the stream channel."""

    def __init__(
        self,
        device_cls: type[Device],
        config: ServerConfig,
        *,
        request_exit: Callable[[], None] | None = None,
        exit_delay: float = 0.5,
        retry_delays: tuple[float, ...] = (5, 10, 30),
        watchdog_interval: float = 1.0,
    ) -> None:
        super().__init__(device_cls, config, retry_delays=retry_delays, watchdog_interval=watchdog_interval)
        self._request_exit = request_exit or _interrupt_process
        self._exit_delay = exit_delay
        self._background: set[asyncio.Task[Any]] = set()
        self.mcp = FastMCP(name=config.server_id, instructions=device_cls.instructions, host=config.host,
                           port=config.port or 8000, streamable_http_path="/mcp", json_response=True,
                           stateless_http=False)
        for tool in self.tools.values():
            self._publish(tool)

    def _publish(self, tool: HostTool) -> None:
        async def call(**kwargs: Any) -> dict[str, Any]:
            return await tool.handler(**kwargs)
        call.__name__ = call.__qualname__ = tool.name
        setattr(call, "__signature__", inspect.Signature(tool.params,  # noqa: B010
                                                         return_annotation=envelope(tool.name, tool.output)))
        self.mcp.add_tool(call, name=tool.name, description=tool.description, annotations=tool.annotations,
                          meta={"hardwareharness": tool.meta}, structured_output=True)

    def _request_meta(self) -> dict[str, Any]:
        """``_meta`` of the current MCP request (``operationId``); the in-process request otherwise."""
        try:
            meta = self.mcp.get_context().request_context.meta
        except (LookupError, ValueError):
            return super()._request_meta()
        return meta.model_dump(exclude_none=True) if meta is not None else {}

    def capability_details(self) -> dict[str, Any]:
        details = super().capability_details()
        if self.device.streams:
            details["streamTransport"] = {"protocol": "sse", "path": "/streams/{streamId}", "timePath": "/time",
                                          "auth": "bearer", **details.get("streamTransport", {})}
        return details

    async def prepare_shutdown(self) -> dict[str, Any]:
        result = await super().prepare_shutdown()

        async def request_exit() -> None:
            await asyncio.sleep(self._exit_delay)
            self._request_exit()
        task = asyncio.create_task(request_exit())
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return result

    def app(self) -> Starlette:
        app = self.mcp.streamable_http_app()
        original = app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(application: Starlette) -> AsyncIterator[None]:
            await self.start()
            try:
                async with original(application):
                    yield
            finally:
                await self.stop()
        app.router.lifespan_context = lifespan

        async def health(_: Request) -> JSONResponse:
            item = self.manager.list_hardware()[0]
            return JSONResponse({"healthy": item["state"] == "open", "serverId": self.config.server_id,
                                 "hardwareId": item["hardwareId"], "state": item["state"], "sdkVersion": __version__,
                                 "manifestRevision": self.manifest().revision})

        async def device(_: Request) -> JSONResponse:
            return JSONResponse(self.manifest().document)

        async def admin_shutdown(_: Request) -> JSONResponse:
            return JSONResponse(await self.prepare_shutdown())

        async def server_time(_: Request) -> JSONResponse:
            return JSONResponse({"serverTime": now_ms()})

        app.add_route("/health", health, methods=["GET"])
        app.add_route("/device", device, methods=["GET"])
        app.add_route("/admin/shutdown", admin_shutdown, methods=["POST"])
        app.add_route("/time", server_time, methods=["GET"])
        app.add_route("/streams/{streamId}", stream_events, methods=["GET"])
        app.add_middleware(BearerAuth, token=self.config.token)
        app.state.service = self
        return app


def create_app(device_cls: type[Device], config: ServerConfig, **options: Any) -> Starlette:
    return DeviceService(device_cls, config, **options).app()

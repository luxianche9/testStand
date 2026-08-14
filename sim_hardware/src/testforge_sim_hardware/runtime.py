from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Callable

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from testforge_sim_hardware.config import ServerConfig
from testforge_sim_hardware.contract import (
    CONTRACT_VERSION,
    HardwareInfo,
    HardwareInfoResponse,
    HardwareListResponse,
    HardwareSummary,
    ServerInfo,
    ServerInfoResponse,
    ToolError,
    ToolMeta,
)
from testforge_sim_hardware.drivers import BaseDriver
from testforge_sim_hardware.shutdown import prepare_safe_shutdown


class BearerMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: Any, token: str):
        super().__init__(app)
        self._token = token

    async def dispatch(self, request: Request, call_next: Callable[..., Any]):
        if request.url.path == "/health":
            return await call_next(request)
        supplied = request.headers.get("authorization", "")
        if not hmac.compare_digest(supplied, f"Bearer {self._token}"):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)


class TestForgeSimRuntime:
    describe = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
    hardware_read = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
    hardware_write = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
    internal = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False)

    def __init__(self, config: ServerConfig, driver: BaseDriver) -> None:
        self.config = config
        self.driver = driver
        self.mcp = FastMCP(
            name=config.server_id,
            instructions="One MCP Server process controls exactly one deterministic virtual hardware device.",
            host=config.host,
            port=config.port,
            streamable_http_path="/mcp",
            json_response=True,
            stateless_http=False,
        )
        self._register_contract_tools()

    @staticmethod
    def now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def meta(self) -> ToolMeta:
        return ToolMeta(timestamp=self.now())

    def failure(self, exc: Exception) -> ToolError:
        return ToolError(
            category=str(getattr(exc, "category", "internal")),
            message=str(exc),
            retryable=bool(getattr(exc, "retryable", False)),
            details=getattr(exc, "details", None),
        )

    def require_hardware(self, hardware_id: str) -> None:
        if hardware_id != self.config.hardware_id:
            error = ValueError(f"Unknown hardwareId: {hardware_id}")
            setattr(error, "category", "invalid_argument")
            raise error

    def invoke(self, hardware_id: str, operation: Callable[[], Any]) -> dict[str, Any]:
        try:
            self.require_hardware(hardware_id)
            return {"ok": True, "data": operation(), "meta": {"timestamp": self.now()}}
        except Exception as exc:
            return {"ok": False, "error": self.failure(exc).model_dump(), "meta": {"timestamp": self.now()}}

    def summary(self) -> HardwareSummary:
        return HardwareSummary(
            hardwareId=self.config.hardware_id,
            manufacturer=self.config.manufacturer,
            model=self.config.model,
            capabilities=self.driver.capabilities,
            state=self.driver.state,
            health=self.driver.health,
            lastError=self.driver.last_error,
        )

    async def prepare_shutdown(self) -> dict[str, Any]:
        return await prepare_safe_shutdown(
            self.driver,
            self.config.hardware_id,
            lambda exc: self.failure(exc).model_dump(),
            self.now,
        )

    def create_app(self):
        app = self.mcp.streamable_http_app()
        original_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(application):
            self.driver.open()
            self.driver.safe_stop()
            try:
                async with original_lifespan(application):
                    yield
            finally:
                try:
                    self.driver.safe_stop()
                finally:
                    self.driver.shutdown()

        app.router.lifespan_context = lifespan

        async def health(_: Request) -> JSONResponse:
            return JSONResponse({
                "healthy": self.driver.state == "open",
                "serverId": self.config.server_id,
                "hardwareId": self.config.hardware_id,
                "state": self.driver.state,
            })

        async def admin_shutdown(_: Request) -> JSONResponse:
            return JSONResponse(await self.prepare_shutdown())

        app.add_route("/health", health, methods=["GET"])
        app.add_route("/admin/shutdown", admin_shutdown, methods=["POST"])
        app.add_middleware(BearerMiddleware, token=self.config.token)
        return app

    def main(self) -> None:
        uvicorn.run(self.create_app(), host=self.config.host, port=self.config.port)

    def _register_contract_tools(self) -> None:
        @self.mcp.tool(annotations=self.describe, meta={"testforge": {"kind": "management"}})
        def get_server_info() -> ServerInfoResponse:
            return ServerInfoResponse(
                ok=True,
                data=ServerInfo(
                    serverId=self.config.server_id,
                    serverVersion=self.config.server_version,
                    contractVersion=CONTRACT_VERSION,
                    manufacturer=self.config.manufacturer,
                    model=self.config.model,
                    hardwareIds=(self.config.hardware_id,),
                    driverVersion=self.driver.driver_version,
                    simulated=True,
                ),
                meta=self.meta(),
            )

        @self.mcp.tool(annotations=self.describe, meta={"testforge": {"kind": "management"}})
        def list_hardware() -> HardwareListResponse:
            return HardwareListResponse(ok=True, data=(self.summary(),), meta=self.meta())

        @self.mcp.tool(annotations=self.describe, meta={"testforge": {"kind": "management"}})
        def get_hardware_info(hardwareId: str) -> HardwareInfoResponse:
            if hardwareId != self.config.hardware_id:
                return HardwareInfoResponse(
                    ok=False,
                    error=ToolError(category="invalid_argument", message=f"Unknown hardwareId: {hardwareId}"),
                    meta=self.meta(),
                )
            item = self.summary()
            return HardwareInfoResponse(
                ok=True,
                data=HardwareInfo(
                    hardwareId=item.hardwareId,
                    manufacturer=item.manufacturer,
                    model=item.model,
                    state=item.state,
                    health=item.health,
                    driverVersion=self.driver.driver_version,
                    actions=self.driver.actions,
                    lastError=item.lastError,
                ),
                meta=self.meta(),
            )

        @self.mcp.tool(annotations=self.internal, meta={"testforge": {"kind": "internal"}})
        async def testforge_prepare_shutdown() -> dict[str, Any]:
            return await self.prepare_shutdown()


from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import signal
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from hardwareharness_remote import __version__
from hardwareharness_remote.adapters import AdapterError
from hardwareharness_remote.lifecycle import HardwareManager, iso_now
from hardwareharness_remote.pinouts import PinoutResponse, ToolError, ToolMeta

log = logging.getLogger("hardwareharness_remote")
logging.basicConfig(level=os.environ.get("HARDWAREHARNESS_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

config = json.loads(Path(os.environ["HARDWAREHARNESS_SERVER_CONFIG"]).read_text(encoding="utf-8-sig"))
manager = HardwareManager()
mcp = FastMCP(name=config["serverId"], instructions="One MCP Server controls exactly one hardware device.", host=config.get("host", "0.0.0.0"), port=int(config["port"]), streamable_http_path="/mcp", json_response=True, stateless_http=False)

DESCRIBE = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
OPERATE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)
READ_HARDWARE = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)


def ok(data: Any, message: str = "") -> dict[str, Any]:
    return {"ok": True, "message": message, "data": data, "meta": {"timestamp": iso_now()}}


def error(exc: Exception) -> dict[str, Any]:
    category = exc.category if isinstance(exc, AdapterError) else "internal"
    details = exc.details if isinstance(exc, AdapterError) else None
    if not isinstance(exc, AdapterError):
        log.exception("Unhandled tool error")
    return {"ok": False, "error": {"category": category, "message": str(exc), "retryable": category in {"device_unreachable", "service_unavailable"}, "details": details}, "meta": {"timestamp": iso_now()}}


def occupancy_lease_id(ctx: Context) -> str | None:
    meta = ctx.request_context.meta
    hardwareharness = getattr(meta, "hardwareharness", None)
    if hardwareharness is None:
        hardwareharness = (getattr(meta, "model_extra", None) or {}).get("hardwareharness")
    if isinstance(hardwareharness, dict):
        value = hardwareharness.get("occupancyLeaseId")
        return value if isinstance(value, str) else None
    return None


async def invoke(hardware_id: str, operation: str, ctx: Context, **kwargs: Any) -> dict[str, Any]:
    try:
        return ok(await manager.invoke(hardware_id, operation, occupancy_lease_id(ctx), **kwargs))
    except Exception as exc:
        return error(exc)


@mcp.tool(annotations=DESCRIBE, meta={"hardwareharness": {"kind": "management"}})
def get_server_info() -> dict[str, Any]:
    hardware = manager.list_hardware()
    return ok({"name": config["serverId"], "version": __version__, "computerId": config.get("computerId", "REMOTE_PC_1"), "serverId": config["serverId"], "startupComplete": manager.startup_complete, "draining": manager.draining, "status": "degraded" if hardware[0]["state"] in {"unreachable", "faulted"} else "ready", "hardware": hardware})


@mcp.tool(annotations=DESCRIBE, meta={"hardwareharness": {"kind": "management"}})
def list_hardware() -> dict[str, Any]:
    data = manager.list_hardware()
    if len(data) != 1:
        return error(AdapterError(f"Server invariant failed: expected one hardware, got {len(data)}", category="invalid_response"))
    return ok(data)


@mcp.tool(annotations=DESCRIBE, meta={"hardwareharness": {"kind": "management"}})
def get_hardware_info(hardwareId: str) -> dict[str, Any]:
    try:
        return ok(manager.get_hardware(hardwareId))
    except Exception as exc:
        return error(exc)


@mcp.tool(annotations=DESCRIBE, meta={"hardwareharness": {"kind": "management"}})
def get_pinout(hardwareId: str) -> PinoutResponse:
    try:
        return PinoutResponse(ok=True, data=manager.get_pinout(hardwareId), meta=ToolMeta(timestamp=iso_now()))
    except Exception as exc:
        category = exc.category if isinstance(exc, AdapterError) else "internal"
        return PinoutResponse(ok=False, error=ToolError(category=category, message=str(exc), retryable=False, details=getattr(exc, "details", None)), meta=ToolMeta(timestamp=iso_now()))


def register_hardware_tools() -> None:
    server_id = config["serverId"]
    if server_id == "PCI1710L_MCP":
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci1710l_configure_ai(hardwareId: str, ctx: Context, channel: int, signal_type: int = 0, value_range: int = 1) -> dict[str, Any]: return await invoke(hardwareId, "configure_ai", ctx, channel=channel, signal_type=signal_type, value_range=value_range)
        @mcp.tool(annotations=READ_HARDWARE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci1710l_read_voltage(hardwareId: str, ctx: Context, channel: int) -> dict[str, Any]: return await invoke(hardwareId, "read_voltage", ctx, channel=channel)
        @mcp.tool(annotations=READ_HARDWARE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci1710l_read_bit(hardwareId: str, ctx: Context, channel: int, kind: str = "DI") -> dict[str, Any]: return await invoke(hardwareId, "read_bit", ctx, channel=channel, kind=kind)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci1710l_set_level(hardwareId: str, ctx: Context, channel: int, level: bool) -> dict[str, Any]: return await invoke(hardwareId, "set_level", ctx, channel=channel, level=level)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware", "safeAction": True}})
        async def pci1710l_safe_state(hardwareId: str, ctx: Context) -> dict[str, Any]: return await invoke(hardwareId, "safe_state", ctx)
    elif server_id == "PCI1762_MCP":
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci1762_set_relay(hardwareId: str, ctx: Context, channel: int, closed: bool) -> dict[str, Any]: return await invoke(hardwareId, "set_relay", ctx, channel=channel, closed=closed)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci1762_set_bank(hardwareId: str, ctx: Context, mask: int) -> dict[str, Any]: return await invoke(hardwareId, "set_bank", ctx, mask=mask)
        @mcp.tool(annotations=READ_HARDWARE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci1762_read_bit(hardwareId: str, ctx: Context, channel: int, kind: str = "DI") -> dict[str, Any]: return await invoke(hardwareId, "read_bit", ctx, channel=channel, kind=kind)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware", "safeAction": True}})
        async def pci1762_safe_state(hardwareId: str, ctx: Context) -> dict[str, Any]: return await invoke(hardwareId, "safe_state", ctx)
    elif server_id == "PCI6208V_MCP":
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci6208v_set_voltage(hardwareId: str, ctx: Context, channel: int, volts: float) -> dict[str, Any]: return await invoke(hardwareId, "set_voltage", ctx, channel=channel, volts=volts)
        @mcp.tool(annotations=READ_HARDWARE, meta={"hardwareharness": {"kind": "hardware"}})
        async def pci6208v_read_last(hardwareId: str, ctx: Context, channel: int) -> dict[str, Any]: return await invoke(hardwareId, "read_last", ctx, channel=channel)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware", "safeAction": True}})
        async def pci6208v_safe_state(hardwareId: str, ctx: Context) -> dict[str, Any]: return await invoke(hardwareId, "safe_state", ctx)
    elif server_id == "CP118U_I_MCP":
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def cp118u_configure_port(hardwareId: str, ctx: Context, channel: int, baud: int = 9600, data_bits: int = 8, parity: str = "N", stop_bits: int = 1, flow: int = 0) -> dict[str, Any]: return await invoke(hardwareId, "configure_port", ctx, channel=channel, baud=baud, data_bits=data_bits, parity=parity, stop_bits=stop_bits, flow=flow)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def cp118u_write_text(hardwareId: str, ctx: Context, channel: int, text: str, clear_rx: bool = False) -> dict[str, Any]: return await invoke(hardwareId, "write_text", ctx, channel=channel, text=text, clear_rx=clear_rx)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def cp118u_write_hex(hardwareId: str, ctx: Context, channel: int, hex_data: str, clear_rx: bool = False) -> dict[str, Any]: return await invoke(hardwareId, "write_hex", ctx, channel=channel, hex_data=hex_data, clear_rx=clear_rx)
        @mcp.tool(annotations=READ_HARDWARE, meta={"hardwareharness": {"kind": "hardware"}})
        async def cp118u_read_rx(hardwareId: str, ctx: Context, channel: int, timeout_ms: int = 0, max_bytes: int = 65536) -> dict[str, Any]: return await invoke(hardwareId, "read_rx", ctx, channel=channel, timeout_ms=timeout_ms, max_bytes=max_bytes)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def cp118u_clear_rx(hardwareId: str, ctx: Context, channel: int) -> dict[str, Any]: return await invoke(hardwareId, "clear_rx", ctx, channel=channel)
        @mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
        async def cp118u_flush(hardwareId: str, ctx: Context, channel: int, what: str = "both") -> dict[str, Any]: return await invoke(hardwareId, "flush", ctx, channel=channel, what=what)
        @mcp.tool(annotations=READ_HARDWARE, meta={"hardwareharness": {"kind": "hardware"}})
        async def cp118u_get_line_status(hardwareId: str, ctx: Context, channel: int) -> dict[str, Any]: return await invoke(hardwareId, "get_line_status", ctx, channel=channel)


register_hardware_tools()


async def prepare_shutdown() -> dict[str, Any]:
    manager.draining = True
    results = []
    for item in manager.list_hardware():
        runtime = manager.runtimes[item["hardwareId"]]
        try:
            async with runtime.operation_lock:
                try:
                    safe_result = await runtime.adapter.safe()
                finally:
                    manager.occupancy.clear_locked(runtime.adapter.hardware_id)
                results.append({"hardwareId": runtime.adapter.hardware_id, "safeResult": safe_result})
        except Exception as exc:
            results.append(error(exc))
    async def request_exit() -> None:
        await asyncio.sleep(0.5)
        os.kill(os.getpid(), signal.SIGINT)
    asyncio.create_task(request_exit())
    return ok(results)


@mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "internal"}})
async def hardwareharness_prepare_shutdown() -> dict[str, Any]: return await prepare_shutdown()


@mcp.tool(annotations=OPERATE, meta={"hardwareharness": {"kind": "internal"}})
async def hardwareharness_hardware_occupancy(hardwareId: str, action: str, ctx: Context, holderId: str | None = None, holderLabel: str | None = None, leaseId: str | None = None) -> dict[str, Any]:
    return await manager.occupancy_action(hardwareId, action, holderId, holderLabel, leaseId)


class BearerMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/health": return await call_next(request)
        if not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {config['token']}"):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)


def create_app():
    app = mcp.streamable_http_app()
    original = app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        await manager.start()
        try:
            async with original(application): yield
        finally:
            await manager.stop()
    app.router.lifespan_context = lifespan
    async def health(_: Request) -> JSONResponse:
        item = manager.list_hardware()[0]
        return JSONResponse({"healthy": item["state"] == "open", "serverId": config["serverId"], "hardwareId": item["hardwareId"], "state": item["state"]})
    async def admin_shutdown(_: Request) -> JSONResponse: return JSONResponse(await prepare_shutdown())
    app.add_route("/health", health, methods=["GET"])
    app.add_route("/admin/shutdown", admin_shutdown, methods=["POST"])
    app.add_middleware(BearerMiddleware)
    return app


def main() -> None:
    uvicorn.run(create_app(), host=config.get("host", "0.0.0.0"), port=int(config["port"]), log_level="info")


if __name__ == "__main__": main()

from __future__ import annotations

import asyncio
import argparse
import hmac
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from . import __version__
from .firmware import OperationError, inspect_firmware
from .runtime import Runtime, error, ok

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
OPERATE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)


def lease_id(ctx: Context) -> str | None:
    meta = ctx.request_context.meta
    tf = getattr(meta, "testforge", None) or (getattr(meta, "model_extra", None) or {}).get("testforge", {})
    return tf.get("occupancyLeaseId") if isinstance(tf, dict) else None


def create_app(config: dict):
    if config.get("host", "127.0.0.1") != "127.0.0.1" or len(config.get("token", "")) < 32:
        raise ValueError("Local server requires host=127.0.0.1 and a random token of at least 32 characters")
    if not config.get("probeSerial") or not Path(config["packPath"]).is_file():
        raise ValueError("Configure a probeSerial and an existing STM32F4xx CMSIS packPath")
    if not 10000 <= config.get("frequencyHz", 0) <= 10000000:
        raise ValueError("frequencyHz must be between 10000 and 10000000")
    if not 10 <= config.get("operationTimeoutSeconds", 120) <= 300:
        raise ValueError("operationTimeoutSeconds must be between 10 and 300")
    runtime = Runtime(config)
    mcp = FastMCP(config["serverId"], host="127.0.0.1", port=config["port"],
                  streamable_http_path="/mcp", json_response=True)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "management"}})
    def get_server_info() -> dict[str, Any]:
        return ok({"name": config["serverId"], "version": __version__, "serverId": config["serverId"],
                   "computerId": config["computerId"], "startupComplete": True, "draining": runtime.draining,
                   "hardware": [runtime.hardware()]})

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "management"}})
    async def list_hardware() -> dict[str, Any]:
        try:
            await runtime.discover()
            return ok([runtime.hardware()])
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "management"}})
    def get_hardware_info(hardwareId: str) -> dict[str, Any]:
        try:
            runtime.check_id(hardwareId)
            return ok(runtime.hardware())
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "management"}})
    def get_pinout(hardwareId: str) -> dict[str, Any]:
        try:
            runtime.check_id(hardwareId)
            return ok(json.loads(Path(config["pinoutPath"]).read_text(encoding="utf-8")))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "management"}})
    async def firedap_list_probes() -> dict[str, Any]:
        """Enumerate CMSIS-DAP USB probes without connecting to or resetting the MCU."""
        try:
            return ok(await runtime.discover())
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "management"}})
    def firedap_get_board_reference() -> dict[str, Any]:
        """Read the passive board's common connector model, jumper configuration, shared nets and sources.
        This describes hardware wiring; it does not query or operate the STM32.
        """
        try:
            return ok(json.loads((Path(config["pinoutPath"]).parent / "model.json").read_text(encoding="utf-8")))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "management"}})
    def firedap_inspect_firmware(path: str, base_address: int | None = None) -> dict[str, Any]:
        """Validate a local BIN/HEX/ELF/AXF, addresses and SHA-256 without accessing hardware."""
        try:
            summary, _ = inspect_firmware(path, config["firmwareRoots"], base_address)
            return ok(summary)
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=OPERATE, meta={"testforge": {"kind": "hardware"}})
    async def firedap_flash(hardwareId: str, ctx: Context, path: str, expected_sha256: str,
                            base_address: int | None = None, reset_after: bool = True) -> dict[str, Any]:
        """Start sector programming, preserving unwritten bytes, then byte-for-byte read-back verification.
        Requires occupancy and the inspected SHA-256. Returns a jobId; poll firedap_get_job until terminal.
        Never mass-erases, unlocks read protection, or programs option bytes/external Flash.
        """
        try:
            return ok(await runtime.start_job(hardwareId, lease_id(ctx), "flash", path, base_address, expected_sha256, reset_after))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "hardware"}})
    async def firedap_verify(hardwareId: str, ctx: Context, path: str, expected_sha256: str,
                             base_address: int | None = None) -> dict[str, Any]:
        """Start read-back comparison without programming; poll firedap_get_job. Requires occupancy."""
        try:
            return ok(await runtime.start_job(hardwareId, lease_id(ctx), "verify", path, base_address, expected_sha256))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "hardware"}})
    async def firedap_target_info(hardwareId: str, ctx: Context) -> dict[str, Any]:
        """Start an attach-only target identity read, without reset or Flash writes. Poll firedap_get_job."""
        try:
            return ok(await runtime.start_job(hardwareId, lease_id(ctx), "target_info"))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=OPERATE, meta={"testforge": {"kind": "hardware"}})
    async def firedap_reset(hardwareId: str, ctx: Context) -> dict[str, Any]:
        """Start a target reset. Requires occupancy; poll firedap_get_job."""
        try:
            return ok(await runtime.start_job(hardwareId, lease_id(ctx), "reset"))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "hardware"}})
    async def firedap_read_sram(hardwareId: str, ctx: Context, address: int, length: int = 108) -> dict[str, Any]:
        """Start an attach-only, bounded main-SRAM read for firmware telemetry. No halt, reset or writes.
        Address/length must be 4-byte aligned; maximum 4096 bytes. Returns jobId; use firedap_wait_job.
        """
        try:
            return ok(await runtime.start_job(hardwareId, lease_id(ctx), "read_sram", read_address=address, read_length=length))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "hardware"}})
    async def firedap_wait_job(hardwareId: str, ctx: Context, job_id: str, timeout_seconds: int = 60) -> dict[str, Any]:
        """Wait up to 60 seconds for an existing job, for TestForge workflow tool steps.
        Requires the current occupancy lease. Returns the job including its terminal state/result;
        assert state=succeeded before using the result. Timeout does not cancel a programming job.
        """
        try:
            runtime.check_id(hardwareId)
            runtime.expire()
            if not runtime.lease or runtime.lease["leaseId"] != lease_id(ctx):
                raise OperationError("A current TestForge occupancy lease is required", "occupancy_required")
            if not 1 <= timeout_seconds <= 60:
                raise OperationError("timeout_seconds must be between 1 and 60")
            deadline = asyncio.get_running_loop().time() + timeout_seconds
            while True:
                job = runtime.get_job(job_id)
                if job["state"] != "running" or asyncio.get_running_loop().time() >= deadline:
                    return ok(job)
                await asyncio.sleep(0.1)
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=READ, meta={"testforge": {"kind": "management"}})
    def firedap_get_job(job_id: str) -> dict[str, Any]:
        """Read a job's running/succeeded/failed state. Only succeeded with verified=true proves programming."""
        try:
            return ok(runtime.get_job(job_id))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=OPERATE, meta={"testforge": {"kind": "internal"}})
    async def testforge_hardware_occupancy(hardwareId: str, action: str, holderId: str | None = None,
                                         holderLabel: str | None = None, leaseId: str | None = None) -> dict[str, Any]:
        try:
            return ok(await runtime.occupancy(hardwareId, action, holderId, holderLabel, leaseId))
        except Exception as exc:
            return error(exc)

    @mcp.tool(annotations=OPERATE, meta={"testforge": {"kind": "internal"}})
    async def testforge_prepare_shutdown() -> dict[str, Any]:
        try:
            return ok(await runtime.shutdown())
        except Exception as exc:
            return error(exc)

    app = mcp.streamable_http_app()
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original(application):
            yield
        # Never leave an orphan Flash job on graceful server exit.
        if runtime.busy:
            await asyncio.shield(runtime.task)

    app.router.lifespan_context = lifespan

    async def health(_):
        return JSONResponse({"serverId": config["serverId"], "hardwareId": config["hardwareId"],
                             "serviceReady": not runtime.draining, "busy": runtime.busy,
                             "probePresent": runtime.probe_present, "state": runtime.hardware()["state"]})

    async def shutdown(_):
        result = await testforge_prepare_shutdown()
        if result["ok"] and hasattr(app.state, "request_exit"):
            asyncio.get_running_loop().call_later(0.2, app.state.request_exit)
        return JSONResponse(result, status_code=200 if result["ok"] else 409)

    class BearerMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.url.path != "/health" and not hmac.compare_digest(
                    request.headers.get("authorization", ""), "Bearer " + config["token"]):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            return await call_next(request)

    app.add_route("/health", health, methods=["GET"])
    app.add_route("/admin/shutdown", shutdown, methods=["POST"])
    app.add_middleware(BearerMiddleware)
    app.state.runtime = runtime
    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=os.environ.get("TESTFORGE_SERVER_CONFIG", "server.json"))
    path = Path(parser.parse_args().config).resolve()
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    app = create_app(config)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=config["port"], log_level="info"))
    app.state.request_exit = lambda: setattr(server, "should_exit", True)
    server.run()

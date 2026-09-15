from __future__ import annotations

import asyncio
import argparse
import hmac
import hashlib
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from . import __version__
from .firmware import OperationError, inspect_firmware, import_firmware, configure_firmware_storage
from .runtime import Runtime, error, ok, now
from .contracts import CONTRACT_REVISION, capability_details, contract_tool

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
OPERATE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)
SUBMIT_READ = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
STAGE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)


def create_app(config: dict):
    if config.get("host", "127.0.0.1") != "127.0.0.1" or len(config.get("token", "")) < 32:
        raise ValueError("Local server requires host=127.0.0.1 and a random token of at least 32 characters")
    if not config.get("probeSerial") or not Path(config["packPath"]).is_file():
        raise ValueError("Configure a probeSerial and an existing STM32F4xx CMSIS packPath")
    if not 10000 <= config.get("frequencyHz", 0) <= 10000000:
        raise ValueError("frequencyHz must be between 10000 and 10000000")
    if not 10 <= config.get("operationTimeoutSeconds", 120) <= 300:
        raise ValueError("operationTimeoutSeconds must be between 10 and 300")
    config = configure_firmware_storage(config)
    runtime = Runtime(config)
    mcp = FastMCP(config["serverId"], host="127.0.0.1", port=config["port"],
                  streamable_http_path="/mcp", json_response=True)

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    def get_server_info() -> dict[str, Any]:
        return ok({"name": config["serverId"], "version": __version__, "serverId": config["serverId"],
                   "computerId": config["computerId"], "startupComplete": True, "draining": runtime.draining,
                   "hardware": [runtime.hardware()], "contractRevision": CONTRACT_REVISION,
                   "capabilities": capability_details(config)})

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    async def list_hardware() -> dict[str, Any]:
        try:
            await runtime.discover()
            return ok([runtime.hardware()])
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    def get_hardware_info(hardwareId: str) -> dict[str, Any]:
        try:
            runtime.check_id(hardwareId)
            return ok({**runtime.hardware(), "capabilityDetails": capability_details(config)})
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    def get_pinout(hardwareId: str, connector_id: str | None = None, offset: int = 0,
                   limit: int | None = None) -> dict[str, Any]:
        try:
            runtime.check_id(hardwareId)
            data = json.loads(Path(config["pinoutPath"]).read_text(encoding="utf-8"))
            if connector_id is not None and connector_id not in {item["connectorId"] for item in data["connectors"]}:
                raise OperationError("Unknown connector_id; select an exact connectorId from get_pinout")
            pins = [item for item in data["pins"] if connector_id is None or item["connectorId"] == connector_id]
            page = pins[offset:offset + limit] if limit is not None else pins[offset:]
            data.update(pins=page, connectors=[item for item in data["connectors"] if connector_id is None or item["connectorId"] == connector_id],
                        pagination={"offset": offset, "total": len(pins), "nextOffset": offset + len(page) if offset + len(page) < len(pins) else None})
            return ok(data)
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    async def firedap_list_probes() -> dict[str, Any]:
        """Enumerate CMSIS-DAP USB probes without connecting to or resetting the MCU."""
        try:
            result = await runtime.discover()
            return ok({**result, "observedAt": now(), "evidence": "cached_probe_presence" if result.get("busy") else "usb_enumeration"})
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    def firedap_get_board_reference(section: str | None = None, offset: int = 0,
                                     limit: int | None = None) -> dict[str, Any]:
        """Read the passive board's common connector model, jumper configuration, shared nets and sources.
        This describes hardware wiring; it does not query or operate the STM32.
        """
        try:
            raw = (Path(config["pinoutPath"]).parent / "model.json").read_bytes()
            data = json.loads(raw)
            if section is None:
                if offset or limit is not None:
                    raise OperationError("Select a section before paging; use section='index' to list sections")
                return ok(data)
            summary = {"referenceId": "board-reference", "hardwareId": data.get("hardwareId"),
                       "boardRevision": data.get("boardRevision"), "contentHash": hashlib.sha256(raw).hexdigest()}
            if section == "index":
                return ok({**summary, "sections": list(data)})
            if section not in data:
                raise OperationError("Unknown section; use firedap_get_board_reference(section='index')")
            value = data[section]
            items = value if isinstance(value, list) else [{"key": key, "value": item} for key, item in value.items()] if isinstance(value, dict) else [value]
            count = 50 if limit is None else limit
            page = items[offset:offset + count]
            return ok({**summary, "section": section, "items": page, "offset": offset, "total": len(items),
                       "nextOffset": offset + len(page) if offset + len(page) < len(items) else None})
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=STAGE, meta={"hardwareharness": {"kind": "management"}})
    def firedap_import_firmware(filename: str, content_base64: str, expected_sha256: str) -> dict[str, Any]:
        try:
            return ok(import_firmware(filename, content_base64, expected_sha256, config["firmwareStagingRoot"]))
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    def firedap_inspect_firmware(path: str, base_address: int | None = None) -> dict[str, Any]:
        """Validate a local BIN/HEX/ELF/AXF, addresses and SHA-256 without accessing hardware."""
        try:
            summary, _ = inspect_firmware(path, config["firmwareRoots"], base_address)
            return ok(summary)
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
    async def firedap_flash(hardwareId: str, path: str, expected_sha256: str,
                            base_address: int | None = None, reset_after: bool = True) -> dict[str, Any]:
        """Start sector programming, preserving unwritten bytes, then byte-for-byte read-back verification.
        Requires the inspected SHA-256. Returns a jobId; poll firedap_get_job until terminal.
        Never mass-erases, unlocks read protection, or programs option bytes/external Flash.
        """
        try:
            return ok(await runtime.start_job(hardwareId, "flash", path, base_address, expected_sha256, reset_after))
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=SUBMIT_READ, meta={"hardwareharness": {"kind": "hardware"}})
    async def firedap_verify(hardwareId: str, path: str, expected_sha256: str,
                             base_address: int | None = None) -> dict[str, Any]:
        """Start read-back comparison without programming; poll firedap_get_job."""
        try:
            return ok(await runtime.start_job(hardwareId, "verify", path, base_address, expected_sha256))
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=SUBMIT_READ, meta={"hardwareharness": {"kind": "hardware"}})
    async def firedap_target_info(hardwareId: str) -> dict[str, Any]:
        """Start an attach-only target identity read, without reset or Flash writes. Poll firedap_get_job."""
        try:
            return ok(await runtime.start_job(hardwareId, "target_info"))
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=OPERATE, meta={"hardwareharness": {"kind": "hardware"}})
    async def firedap_reset(hardwareId: str) -> dict[str, Any]:
        """Start a target reset. Poll firedap_get_job."""
        try:
            return ok(await runtime.start_job(hardwareId, "reset"))
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=SUBMIT_READ, meta={"hardwareharness": {"kind": "hardware"}})
    async def firedap_read_sram(hardwareId: str, address: int, length: int = 108) -> dict[str, Any]:
        """Start an attach-only, bounded main-SRAM read for firmware telemetry. No halt, reset or writes.
        Address/length must be 4-byte aligned; maximum 4096 bytes. Returns jobId; use firedap_wait_job.
        """
        try:
            return ok(await runtime.start_job(hardwareId, "read_sram", read_address=address, read_length=length))
        except Exception as exc:
            return error(exc)

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    async def firedap_wait_job(hardwareId: str, job_id: str, timeout_seconds: int = 60) -> dict[str, Any]:
        """Wait up to 60 seconds for an existing job, for HardwareHarness workflow tool steps.
        Returns the job including its terminal state/result;
        assert state=succeeded before using the result. Timeout does not cancel a programming job.
        """
        try:
            runtime.check_id(hardwareId)
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

    @contract_tool(mcp, annotations=READ, meta={"hardwareharness": {"kind": "management"}})
    def firedap_get_job(job_id: str) -> dict[str, Any]:
        """Read a job's running/succeeded/failed state. Only succeeded with verified=true proves programming."""
        try:
            return ok(runtime.get_job(job_id))
        except Exception as exc:
            return error(exc)


    @contract_tool(mcp, annotations=OPERATE, meta={"hardwareharness": {"kind": "internal"}})
    async def hardwareharness_prepare_shutdown() -> dict[str, Any]:
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
        result = await hardwareharness_prepare_shutdown()
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
    app.state.mcp = mcp
    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=os.environ.get("HARDWAREHARNESS_SERVER_CONFIG", "server.json"))
    path = Path(parser.parse_args().config).resolve()
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    app = create_app(config)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=config["port"], log_level="info"))
    app.state.request_exit = lambda: setattr(server, "should_exit", True)
    server.run()

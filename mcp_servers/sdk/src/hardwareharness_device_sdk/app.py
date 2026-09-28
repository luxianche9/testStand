"""Server assembly: FastMCP tools, Bearer auth, health/admin routes and the stream channel."""

from __future__ import annotations

import asyncio
import hmac
import inspect
import logging
import os
import signal
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import WebSocketRoute
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket

from ._version import __version__
from .config import ServerConfig
from .device import Device
from .envelope import CONTRACT_REVISION, TIMEOUT_RECOVERY, envelope, error, model, ok
from .errors import INVALID_ARGUMENT, DeviceError
from .lifecycle import HardwareManager
from .panel import PanelItem, expand
from .pinout import Pinout, page
from .sim import execution_mode
from .streams import SampledStream
from .tool import OPERATE, READ_ONLY, HardwareId, ToolSpec, collect_tools, method_parameters, param
from .ws import stream_socket

log = logging.getLogger("hardwareharness_device_sdk")

Hardware = model("HardwareInfo", hardwareId=(str, "Stable device identifier returned by discovery."),
                 state=(str, "Service lifecycle state; open does not prove external wiring."),
                 health=(str, "Last service/driver health, not end-to-end experiment validation."),
                 capabilities=(list[str], "Declared device capabilities.", []),
                 capabilityDetails=(dict[str, Any], "Versioned limits, effective settings and evidence semantics.", {}),
                 lastError=(dict[str, Any] | None, "Last lifecycle/job error.", None))
ServerInfo = model("ServerInfo", name=(str, "Service name."), version=(str, "Installed adapter package version."),
                   serverId=(str, "Service identity."), computerId=(str, "Configured host identity."),
                   startupComplete=(bool, "Initialization complete; not a measurement."),
                   draining=(bool, "Service is refusing new operations while stopping."),
                   hardware=(list[Hardware], "Exactly one managed active hardware device."),
                   contractRevision=(str, "Public contract revision.", CONTRACT_REVISION),
                   capabilities=(dict[str, Any], "Nonsecret effective configuration and limits.", {}),
                   sdkVersion=(str, "hardwareharness-device-sdk version.", None),
                   adapter=(str, "Adapter model implemented by this service.", None),
                   sourceRevision=(str, "Source revision of the assembled bundle, when known.", None))
StreamInfo = model("StreamInfo", streamId=(str, "Exact identifier for stream_read and the WebSocket channel."),
                   kind=(str, "sampled=polled while watched; push=published on change; bytes=serial traffic."),
                   label=(str, "Human-readable name."), description=(str, "Evidence semantics of entries.", ""),
                   unit=(str, "Physical unit of value, when numeric.", None),
                   valueSchema=(dict[str, Any], "JSON Schema of one entry's payload fields.", {}),
                   requires=(list[str], "State requirements before entries are produced.", []),
                   state=(str, "idle, running, live, not_configured, unavailable, error or closed."),
                   error=(dict[str, Any] | None, "Last sampling error.", None),
                   epoch=(str, "Buffer identity; cursors are only valid within one epoch."),
                   head=(int, "Next sequence number to be assigned."), tail=(int, "Oldest retained sequence number."),
                   capacity=(int, "Maximum retained entries."), rateHz=(float, "Sampling rate while running.", None),
                   channel=(int, "Hardware channel the stream observes.", None))
StreamRead = model("StreamRead", streamId=(str, "Stream identifier."), epoch=(str, "Buffer identity."),
                   items=(list[dict[str, Any]], "Entries {seq, t (UNIX s), ...payload} in sequence order."),
                   next=(int, "Cursor for the following read."), head=(int, "Next sequence number."),
                   tail=(int, "Oldest retained sequence number."),
                   dropped=(dict[str, int] | None, "Evicted range {from,to} skipped before this read.", None),
                   reset=(bool, "Cursor belonged to another epoch; reading restarted at tail.", False))
StreamHold = model("StreamHold", streamId=(str, "Stream identifier."), kind=(str, "Stream kind."),
                   holdSeconds=(float, "Remaining explicit sampling hold; push/bytes streams are always live."),
                   state=(str, "Current stream state."))
Panel = model("Panel", hardwareId=(str, "Device the templates bind to."),
              items=(list[PanelItem], "Widget templates for the canvas; tools and streams are exact names."))

StreamId = param(str, "Exact streamId from list_streams.", min_length=1, max_length=64)
DESCRIPTIONS = {
    "get_server_info": "Read service version, readiness and nonsecret effective capabilities without signal actuation. One service manages exactly one active device; ready does not prove the physical experiment or wiring.",
    "list_hardware": "Discover the single device managed by this service. Use its hardwareId in subsequent calls; presence and service health do not verify every channel or external cable.",
    "get_hardware_info": "Read device identity, lifecycle health, capability limits and effective settings. Static declarations and software state are not physical measurements.",
    "get_pinout": "Read packaged connector/pin functions and sources, optionally filtering one connector and paging pins. This reference cannot detect cable position or DIP switches; use returned identifiers verbatim and verify connector orientation against the cited manual.",
    "list_streams": "List the read-only data streams this device publishes (sampled readings, pushed values, serial traffic) with units, entry schema and buffer cursors. Streams never actuate hardware.",
    "get_panel": "Read widget templates suggested for the canvas: each binds a display to a stream and/or manual control to exact tool names. Templates are declarations; they do not prove wiring or current values.",
    "stream_read": "Read buffered stream entries after cursor without consuming them; omit cursor for the latest max_items entries. Entries carry seq and UNIX time t. dropped reports evicted data; sampled streams only produce entries while watched or started.",
    "stream_start": "Keep a sampled stream polling for the given seconds so stream_read collects history without a live viewer. Sampling interleaves with tool calls under the device lock and never actuates outputs.",
    "stream_stop": "Release an explicit stream_start hold. Sampling continues while live viewers are subscribed; buffered entries are kept.",
    "hardwareharness_prepare_shutdown": "Internal shutdown hook: drive the device to its safe state, refuse new operations and exit the process shortly after. Not for AI or test steps.",
}
PARAMS = {
    "connector_id": param(str | None, "Exact connectorId from this reference; omitted selects all connectors."),
    "offset": param(int, "Zero-based pin/section-item offset in the filtered result.", ge=0),
    "limit": param(int | None, "Maximum returned pins/items; omitted preserves full legacy response.", ge=1, le=200),
    "cursor": param(int | None, "Sequence number to read from (use the previous next); omitted returns the latest entries.", ge=0),
    "max_items": param(int, "Maximum entries returned.", ge=1, le=2000),
    "seconds": param(float, "Hold duration in seconds.", gt=0, le=3600),
}
STREAM_START = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)


def _parameter(name: str, annotation: Any, default: Any = inspect.Parameter.empty) -> inspect.Parameter:
    return inspect.Parameter(name, inspect.Parameter.KEYWORD_ONLY, annotation=annotation, default=default)


def _interrupt_process() -> None:
    os.kill(os.getpid(), signal.SIGINT)


class BearerAuth:
    """Pure ASGI Bearer check for HTTP and WebSocket scopes; fails closed without a token."""

    def __init__(self, app: ASGIApp, token: str, public_paths: frozenset[str] = frozenset({"/health"})) -> None:
        self.app = app
        self.expected = f"Bearer {token}".encode() if token else None
        self.public_paths = public_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"} or scope["path"] in self.public_paths:
            await self.app(scope, receive, send)
            return
        supplied = dict(scope.get("headers") or []).get(b"authorization", b"")
        if self.expected is not None and hmac.compare_digest(supplied, self.expected):
            await self.app(scope, receive, send)
            return
        denied = JSONResponse({"error": "unauthorized"}, status_code=401)
        if scope["type"] == "http":
            await denied(scope, receive, send)
            return
        websocket = WebSocket(scope, receive, send)
        if "websocket.http.response" in scope.get("extensions", {}):
            await websocket.send_denial_response(denied)
        else:
            await websocket.close(1008)


class DeviceService:
    """One device, its lifecycle manager, the FastMCP server and the stream channel."""

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
        if (device_cls.manufacturer, device_cls.model) != (config.manufacturer, config.model):
            raise RuntimeError(f"server.json manufacturer/model {config.manufacturer}/{config.model} does not match "
                               f"the adapter {device_cls.manufacturer}/{device_cls.model}")
        if not device_cls.prefix:
            raise RuntimeError(f"{device_cls.__name__}.prefix is required")
        self.config = config
        self.device = device_cls(config)
        self.manager = HardwareManager(self.device, retry_delays=retry_delays, watchdog_interval=watchdog_interval)
        self.closing = False
        self._request_exit = request_exit or _interrupt_process
        self._exit_delay = exit_delay
        self._background: set[asyncio.Task[Any]] = set()
        self.mcp = FastMCP(name=config.server_id, instructions=device_cls.instructions, host=config.host,
                           port=config.port or 8000, streamable_http_path="/mcp", json_response=True,
                           stateless_http=False)
        self.tool_specs: dict[str, ToolSpec] = {}
        self._register_builtin_tools()
        self._register_device_tools()
        self.panel_items = self._resolve_panel()

    # --- registration -------------------------------------------------
    def _add_tool(self, name: str, handler: Callable[..., Awaitable[dict[str, Any]]], params: list[inspect.Parameter],
                  output: Any, *, annotations: ToolAnnotations, kind: str, semantics: dict[str, Any] | None = None,
                  description: str | None = None, extra_meta: dict[str, Any] | None = None) -> None:
        text = description or DESCRIPTIONS[name.removeprefix(f"{self.device.prefix}_")]

        async def call(**kwargs: Any) -> dict[str, Any]:
            return await handler(**kwargs)
        call.__name__ = call.__qualname__ = name
        setattr(call, "__signature__", inspect.Signature(params, return_annotation=envelope(name, output)))  # noqa: B010
        meta: dict[str, Any] = {"kind": kind}
        if kind != "internal":
            meta.update(contractRevision=CONTRACT_REVISION, resultSemantics=text, timeoutRecovery=TIMEOUT_RECOVERY)
        if semantics is not None:
            meta["operationSemantics"] = semantics
        meta.update(extra_meta or {})
        self.mcp.add_tool(call, name=name, description=text, annotations=annotations,
                          meta={"hardwareharness": meta}, structured_output=True)

    def _management(self, name: str, handler: Callable[..., Awaitable[dict[str, Any]]], params: list[inspect.Parameter],
                    output: Any, evidence: str = "controller_state") -> None:
        spec = ToolSpec(name=name, kind="read", description=DESCRIPTIONS[name], output=output, attr=name, evidence=evidence)
        self._add_tool(name, handler, params, output, annotations=READ_ONLY, kind="management",
                       semantics=spec.semantics(self.device.prefix))

    def _register_builtin_tools(self) -> None:
        hid = _parameter("hardwareId", HardwareId)
        self._management("get_server_info", self._get_server_info, [], ServerInfo)
        self._management("list_hardware", self._list_hardware, [], list[Hardware])
        self._management("get_hardware_info", self._get_hardware_info, [hid], Hardware)
        self._management("get_pinout", self._get_pinout, [
            hid, _parameter("connector_id", PARAMS["connector_id"], None), _parameter("offset", PARAMS["offset"], 0),
            _parameter("limit", PARAMS["limit"], None)], Pinout, evidence="declaration")
        self._management("list_streams", self._list_streams, [hid], list[StreamInfo], evidence="declaration")
        self._management("get_panel", self._get_panel, [hid], Panel, evidence="declaration")
        self._add_tool("hardwareharness_prepare_shutdown", self._prepare_shutdown_tool, [], dict[str, Any] | list[Any],
                       annotations=OPERATE, kind="internal")
        if not self.device.streams:
            return
        prefix = self.device.prefix
        sid = _parameter("streamId", StreamId)
        read = ToolSpec(name="stream_read", kind="read", description=DESCRIPTIONS["stream_read"], output=StreamRead,
                        attr="stream_read", evidence="stream_buffer")
        hold = ToolSpec(name="stream_start", kind="configure", description=DESCRIPTIONS["stream_start"],
                        output=StreamHold, attr="stream_start", evidence="observation")
        self._add_tool(f"{prefix}_stream_read", self._stream_read, [
            hid, sid, _parameter("cursor", PARAMS["cursor"], None), _parameter("max_items", PARAMS["max_items"], 200)],
            StreamRead, annotations=READ_ONLY, kind="hardware", semantics=read.semantics(prefix))
        self._add_tool(f"{prefix}_stream_start", self._stream_start, [hid, sid, _parameter("seconds", PARAMS["seconds"], 60.0)],
                       StreamHold, annotations=STREAM_START, kind="hardware", semantics=hold.semantics(prefix))
        self._add_tool(f"{prefix}_stream_stop", self._stream_stop, [hid, sid], StreamHold, annotations=STREAM_START,
                       kind="hardware", semantics=hold.semantics(prefix))

    def _register_device_tools(self) -> None:
        prefix = self.device.prefix
        for spec in collect_tools(type(self.device)):
            name = spec.full_name(prefix)
            if name in self.mcp._tool_manager._tools:  # noqa: SLF001 - FastMCP has no public lookup
                raise RuntimeError(f"Duplicate tool {name}")
            method = getattr(self.device, spec.attr)
            params = [_parameter("hardwareId", HardwareId), *method_parameters(method)]

            def bind(method: Callable[..., Any]) -> Callable[..., Awaitable[dict[str, Any]]]:
                async def handler(hardwareId: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
                    try:
                        return ok(await self.manager.invoke(hardwareId, method, **kwargs))
                    except Exception as exc:
                        return error(exc)
                return handler
            self._add_tool(name, bind(method), params, spec.output if spec.output is not None else dict[str, Any],
                           annotations=spec.annotations(), kind="hardware", semantics=spec.semantics(prefix),
                           description=spec.description, extra_meta={"safeAction": True} if spec.kind == "safe" else None)
            self.tool_specs[name] = spec
        for name, spec in self.tool_specs.items():
            action = spec.semantics(prefix).get("safetyAction")
            if action is not None and action["toolName"] not in self.tool_specs:
                raise RuntimeError(f"{name} declares unknown safety_action {action['toolName']}")

    def _resolve_panel(self) -> list[PanelItem]:
        known = set(self.mcp._tool_manager._tools)  # noqa: SLF001
        items = [expand(item, self.device.prefix, known) for item in self.device.panel()]
        seen: set[str] = set()
        for item in items:
            if item.id in seen:
                raise RuntimeError(f"Duplicate panel item {item.id}")
            seen.add(item.id)
            missing = [tool for tool in item.tools() if tool not in known]
            if missing:
                raise RuntimeError(f"Panel item {item.id} references unknown tools {missing}")
            if item.stream is not None and item.stream not in self.device.streams:
                raise RuntimeError(f"Panel item {item.id} references unknown stream {item.stream}")
        return items

    # --- builtin handlers ---------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        """Read process configuration and software state only; never load a device DLL."""
        common: dict[str, Any] = {"contractRevision": CONTRACT_REVISION, "hardwareCount": 1,
                                  "executionMode": execution_mode(self.config.dry_run),
                                  "concurrentHardwareOperations": 1,
                                  "hardwareRevision": "unknown", "driverVersion": "unknown",
                                  "pinoutSource": "get_pinout",
                                  "evidence": "Declared limits and process configuration; not physical measurements."}
        if self.device.streams:
            common["streamTransport"] = {"path": "/streams/{streamId}", "auth": "bearer", "listTool": "list_streams",
                                         "readTool": f"{self.device.prefix}_stream_read"}
        common.update(self.device.capability_details())
        return common

    async def _get_server_info(self) -> dict[str, Any]:
        hardware = self.manager.list_hardware()
        return ok({"name": self.config.server_id, "version": self.device.version, "computerId": self.config.computer_id,
                   "serverId": self.config.server_id, "startupComplete": self.manager.startup_complete,
                   "draining": self.manager.draining,
                   "status": "degraded" if hardware[0]["state"] in {"unreachable", "faulted"} else "ready",
                   "hardware": hardware, "contractRevision": CONTRACT_REVISION,
                   "capabilities": self.capability_details(), "sdkVersion": __version__,
                   "adapter": self.device.model,
                   "sourceRevision": self.config.build.get("sourceRevision") or self.config.build.get("gitCommit")})

    async def _list_hardware(self) -> dict[str, Any]:
        data = self.manager.list_hardware()
        if len(data) != 1:
            return error(DeviceError(f"Server invariant failed: expected one hardware, got {len(data)}",
                                     category="invalid_response"))
        return ok(data)

    async def _get_hardware_info(self, hardwareId: str) -> dict[str, Any]:  # noqa: N803
        try:
            return ok({**self.manager.get_hardware(hardwareId), "capabilityDetails": self.capability_details()})
        except Exception as exc:
            return error(exc)

    async def _get_pinout(self, hardwareId: str, connector_id: str | None = None, offset: int = 0,  # noqa: N803
                          limit: int | None = None) -> dict[str, Any]:
        try:
            pinout = self.manager.get_pinout(hardwareId)
            try:
                return ok(page(pinout, connector_id, offset, limit))
            except KeyError:
                raise DeviceError("Unknown connector_id; select an exact connectorId from get_pinout",
                                  category=INVALID_ARGUMENT) from None
        except Exception as exc:
            return error(exc)

    async def _list_streams(self, hardwareId: str) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            return ok(self.device.streams.describe())
        except Exception as exc:
            return error(exc)

    async def _get_panel(self, hardwareId: str) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            return ok({"hardwareId": self.device.hardware_id, "items": self.panel_items})
        except Exception as exc:
            return error(exc)

    async def _stream_read(self, hardwareId: str, streamId: str, cursor: int | None = None,  # noqa: N803
                           max_items: int = 200) -> dict[str, Any]:
        try:
            self.manager.get_hardware(hardwareId)
            stream = self.device.streams.require(streamId)
            result = stream.buffer.read(-max_items if cursor is None else cursor, max_items)
            data: dict[str, Any] = {"streamId": streamId, "epoch": stream.buffer.epoch, "items": result.items,
                                    "next": result.next, "head": result.head, "tail": result.tail, "reset": result.reset}
            if result.dropped:
                data["dropped"] = {"from": result.dropped[0], "to": result.dropped[1]}
            return ok(data)
        except Exception as exc:
            return error(exc)

    def _hold_result(self, streamId: str) -> dict[str, Any]:  # noqa: N803
        stream = self.device.streams.require(streamId)
        described = stream.describe()
        return {"streamId": streamId, "kind": stream.kind, "holdSeconds": described.get("holdSeconds", 0.0),
                "state": described["state"]}

    async def _stream_start(self, hardwareId: str, streamId: str, seconds: float = 60.0) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            stream = self.device.streams.require(streamId)
            stream.hold(seconds)
            message = "" if isinstance(stream, SampledStream) else "Stream is always live; no hold needed."
            return ok(self._hold_result(streamId), message)
        except Exception as exc:
            return error(exc)

    async def _stream_stop(self, hardwareId: str, streamId: str) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            self.device.streams.require(streamId).unhold()
            return ok(self._hold_result(streamId))
        except Exception as exc:
            return error(exc)

    # --- lifecycle ------------------------------------------------------
    async def start(self) -> None:
        self.closing = False
        self.device.streams.bind(self.manager)
        await self.manager.start()

    async def stop(self) -> None:
        self.closing = True
        await self.device.streams.aclose()
        await self.manager.stop()

    async def prepare_shutdown(self) -> dict[str, Any]:
        self.manager.draining = True
        self.closing = True
        try:
            results: list[Any] = await self.manager.safe_all()
        except Exception as exc:
            results = [error(exc)]

        async def request_exit() -> None:
            await asyncio.sleep(self._exit_delay)
            self._request_exit()
        task = asyncio.create_task(request_exit())
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return ok(results)

    async def _prepare_shutdown_tool(self) -> dict[str, Any]:
        return await self.prepare_shutdown()

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
                                 "hardwareId": item["hardwareId"], "state": item["state"], "sdkVersion": __version__})

        async def admin_shutdown(_: Request) -> JSONResponse:
            return JSONResponse(await self.prepare_shutdown())

        async def streams(websocket: WebSocket) -> None:
            await stream_socket(websocket, self)

        app.add_route("/health", health, methods=["GET"])
        app.add_route("/admin/shutdown", admin_shutdown, methods=["POST"])
        app.router.routes.append(WebSocketRoute("/streams/{streamId}", streams))
        app.add_middleware(BearerAuth, token=self.config.token)
        app.state.service = self
        return app


def create_app(device_cls: type[Device], config: ServerConfig, **options: Any) -> Starlette:
    return DeviceService(device_cls, config, **options).app()

"""Server assembly: FastMCP tools, Bearer auth, leases, the /device declaration, health/admin routes and streams."""

from __future__ import annotations

import asyncio
import base64
import hmac
import inspect
import logging
import os
import re
import signal
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ._version import __version__
from .clock import now_ms
from .config import ServerConfig
from .device import Device
from .envelope import CONTRACT_REVISION, TIMEOUT_RECOVERY, envelope, error, model, ok
from .errors import INVALID_ARGUMENT, NOT_SUPPORTED, DeviceError
from . import lease as lease_rules
from .lease import HEARTBEAT_INTERVAL_MS, Lease, LeaseTable
from .lifecycle import HardwareManager
from .manifest import Manifest, build_manifest
from .operation import CURRENT, Operation
from .sim import execution_mode
from .sse import stream_events
from .streams import BlobStream, ByteStream, Stream
from .tool import OPERATE, READ_ONLY, HardwareId, ToolSpec, collect_tools, method_parameters, param

log = logging.getLogger("hardwareharness_device_sdk")

Hardware = model("HardwareInfo", hardwareId=(str, "Stable device identifier returned by discovery."),
                 state=(str, "Service lifecycle state; open does not prove external wiring."),
                 health=(str, "Last service/driver health, not end-to-end experiment validation."),
                 capabilities=(list[str], "Declared device capabilities.", []),
                 capabilityDetails=(dict[str, Any], "Versioned limits, effective settings and evidence semantics.", {}),
                 lease=(dict[str, Any], "Configure/actuate lease status {held, holder?, acquiredAt?, lastHeartbeatAt?}.",
                        None),
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
StreamStatus = model("StreamStatus", state=(str, "live, sampling, idle, not_configured, unavailable, error or closed."),
                     sampling=(bool, "Records are being produced now."), errors=(int, "Failed sample attempts."),
                     lastError=(dict[str, Any], "Last sampling error {category, message, at}.", None),
                     watermark=(float, "No record with t at or before this service time (Unix ms) will follow."))
GapRange = model("GapRange", fromSeq=(int, "First evicted sequence number."), toSeq=(int, "Last evicted sequence number."))
StreamRead = model("StreamRead", streamId=(str, "Stream identifier."), type=(str, "Record type."),
                   epoch=(str, "Buffer identity; cursors are only valid within one epoch."),
                   records=(list[dict[str, Any]], "Records {seq, t (Unix ms), op?, ...payload}; bytes add decoded text."),
                   next=(int, "fromSeq for the following read."), head=(int, "Next sequence number to be assigned."),
                   tail=(int, "Oldest retained sequence number."),
                   watermark=(float, "Every record with t at or before this time has been returned or evicted."),
                   status=(StreamStatus, "Stream production state."),
                   dropped=(GapRange, "Evicted range skipped before this read.", None),
                   reset=(bool, "fromSeq was ahead of head; reading restarted at tail.", False))
BlobRead = model("BlobRead", ref=(str, "Blob reference (sha256)."), mime=(str, "Media type."), size=(int, "Byte length."),
                 base64=(str, "Content, base64 encoded."))
TransactResult = model("TransactResult", sent=(int, "Bytes accepted by the writer."),
                       matched=(bool, "expect matched the received text (true when expect is omitted)."),
                       text=(str, "Text received after sending, until match or timeout."),
                       elapsedMs=(float, "Time from send to match or timeout."))
LeaseHolder = model("LeaseHolder", terminalId=(str, "Persistent UUID of the terminal instance holding the lease."),
                    user=(str, "User logged in at the terminal.", None), host=(str, "Terminal host name.", None),
                    label=(str, "Display label, for example the terminal or run name.", None))
LeaseGrant = model("LeaseGrant", leaseId=(str, "Pass as _meta.leaseId on configure/actuate calls; holder only."),
                   holder=(LeaseHolder, "Holder that owns the lease."),
                   acquiredAt=(float, "Service time (Unix ms) the lease was granted."),
                   heartbeatIntervalMs=(int, "Send lease_heartbeat (or any call with _meta.leaseId) this often."),
                   timeoutMs=(int, "The lease ends, with safe state, after this long without a heartbeat."))
LeaseHeartbeat = model("LeaseHeartbeat", leaseId=(str, "The lease that is still held."),
                       lastHeartbeatAt=(float, "Service time (Unix ms) of this heartbeat."))
LeaseStatus = model("LeaseStatus", held=(bool, "A holder currently leases configure/actuate access."),
                    holder=(LeaseHolder, "Current holder; the leaseId is never disclosed.", None),
                    acquiredAt=(float, "Service time (Unix ms) the lease was granted.", None),
                    lastHeartbeatAt=(float, "Service time (Unix ms) of the last heartbeat.", None))
LeaseEnd = model("LeaseEnd", held=(bool, "False: the device is free after this call."),
                 released=(bool, "A lease ended because of this call (false: nothing was held)."),
                 holder=(LeaseHolder, "Holder of the lease that ended.", None),
                 safeResult=(list[dict[str, Any]], "safe_state results; every lease end drives the device safe.", None))

StreamId = param(str, "Exact streamId from /device streams.", min_length=1, max_length=64)
LeaseId = param(str, "leaseId returned by lease_acquire.", min_length=1, max_length=64)
DESCRIPTIONS = {
    "get_server_info": "Read service version, readiness and nonsecret effective capabilities without signal actuation. One service manages exactly one active device; ready does not prove the physical experiment or wiring.",
    "list_hardware": "Discover the single device managed by this service. Use its hardwareId in subsequent calls; presence and service health do not verify every channel or external cable.",
    "get_hardware_info": "Read device identity, lifecycle health, lease status, capability limits and effective settings. Static declarations and software state are not physical measurements.",
    "lease_acquire": "Internal: lease exclusive configure/actuate access for a terminal instance. The lease has no deadline but ends without a heartbeat for timeoutMs; acquiring again with the same terminalId returns the same leaseId. Another holder gets busy with details.holder.",
    "lease_heartbeat": "Internal: prove the lease holder is alive (every heartbeatIntervalMs); any tool call carrying _meta.leaseId counts as well. busy means the lease is lost (timed out, released or force released): stop using the device and acquire again.",
    "lease_release": "Internal: end the caller's lease. Every lease end, including timeout and force release, drives the device to its safe state; the safe_state results are returned. Releasing a lease that is no longer held reports released=false.",
    "lease_force_release": "Internal: end whatever lease is held, for any authenticated client, after the user confirmed it. The original holder and the reason are logged, and the device is driven to its safe state; the holder's next call fails with busy.",
    "lease_status": "Read whether configure/actuate access is leased, by which holder, since when and the last heartbeat. Read and safe tools and stream subscriptions are never blocked by a lease; the leaseId is never disclosed.",
    "stream_read": "Read buffered records from fromSeq (omit for the latest records) without consuming them. Records carry seq, t (Unix ms) and op when a tool call produced them; bytes records add decoded text. Sampled streams only produce records while watched: status.state idle means nobody watches; HardwareHarness recordings and /streams/{id} subscribers start sampling.",
    "blob_read": "Read the content of one blob record (screenshot, capture file) by its ref as base64 with its media type. Blobs are kept in memory and old ones are evicted; the ref comes from stream_read or a tool result.",
    "transact": "Send data on a byte stream and wait until the received text matches the expect regex or timeoutMs passes. Sending is a physical output: it needs the lease when one is held and is never retried automatically; the tx/rx records are tagged with this call's operation.",
    "hardwareharness_prepare_shutdown": "Internal shutdown hook: drive the device to its safe state, refuse new operations and exit the process shortly after. Not for AI or test steps.",
}
PARAMS = {
    "fromSeq": param(int | None, "Sequence number to read from (the previous next); omitted returns the latest records.",
                     ge=0),
    "records": param(int, "Maximum records returned.", ge=1, le=2000),
    "ref": param(str, "Blob ref from a blob record.", min_length=1, max_length=128),
    "timeoutMs": param(float, "Maximum wait in milliseconds.", gt=0, le=60000),
    "data": param(str, "Payload to send, interpreted by encoding.", max_length=65536),
    "encoding": param(Literal["text", "hex"], "text sends the string as UTF-8 (include \\r\\n yourself); hex sends raw bytes."),
    "expect": param(str | None, "Regex the received text must match; omitted only sends and collects until timeout."),
    "holder": param(str | LeaseHolder, "Lease holder {terminalId, user?, host?, label?} (strings of at most 128 "
                    "characters); a plain string is taken as the terminalId."),
    "reason": param(str, "Why the lease is forced free (logged with the original holder), 1..512 characters.",
                    min_length=1, max_length=512),
}
LEASE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
LEASED_KINDS = frozenset({"configure", "actuate"})
LEASE_TOOLS = ("lease_acquire", "lease_heartbeat", "lease_release", "lease_force_release", "lease_status")
INTERNAL_TOOLS = frozenset({"lease_acquire", "lease_heartbeat", "lease_release", "lease_force_release",
                            "hardwareharness_prepare_shutdown"})
"""Reported as kind ``internal`` in ``/device.tools`` (platform plumbing, not test steps)."""
POLL_INTERVAL = 0.02
LEASE_SWEEP_INTERVAL = 0.1
MAX_BLOB_BYTES = 8 << 20


def _parameter(name: str, annotation: Any, default: Any = inspect.Parameter.empty) -> inspect.Parameter:
    return inspect.Parameter(name, inspect.Parameter.KEYWORD_ONLY, annotation=annotation, default=default)


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


class DeviceService:
    """One device, its lifecycle manager, lease table, the FastMCP server and the stream channel."""

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
        self.leases = LeaseTable()
        self.closing = False
        self._request_exit = request_exit or _interrupt_process
        self._exit_delay = exit_delay
        self._background: set[asyncio.Task[Any]] = set()
        self._lease_sweeper: asyncio.Task[None] | None = None
        self.mcp = FastMCP(name=config.server_id, instructions=device_cls.instructions, host=config.host,
                           port=config.port or 8000, streamable_http_path="/mcp", json_response=True,
                           stateless_http=False)
        self.tool_specs: dict[str, ToolSpec] = {}
        self.tool_kinds: dict[str, str] = {}
        """Tool name -> kind (read, configure, actuate, safe, internal) for ``/device.tools``."""
        self._lease_end_lock = asyncio.Lock()
        self._register_builtin_tools()
        self._register_device_tools()

    # --- registration -------------------------------------------------
    def _add_tool(self, name: str, handler: Callable[..., Awaitable[dict[str, Any]]], params: list[inspect.Parameter],
                  output: Any, *, annotations: ToolAnnotations, kind: str, semantics: dict[str, Any] | None = None,
                  description: str | None = None, extra_meta: dict[str, Any] | None = None) -> None:
        text = description or DESCRIPTIONS[name.removeprefix(f"{self.device.prefix}_")]

        async def call(**kwargs: Any) -> dict[str, Any]:
            # Any call carrying the holder's _meta.leaseId is a heartbeat.
            self.leases.touch(self._request_meta().get("leaseId"))
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
        self.tool_kinds[name] = ("internal" if kind == "internal" or name in INTERNAL_TOOLS
                                 else (semantics or {}).get("kind", "read"))

    def _management(self, name: str, handler: Callable[..., Awaitable[dict[str, Any]]], params: list[inspect.Parameter],
                    output: Any, evidence: str = "controller_state", annotations: ToolAnnotations = READ_ONLY) -> None:
        spec = ToolSpec(name=name, kind="read", description=DESCRIPTIONS[name], output=output, attr=name, evidence=evidence)
        self._add_tool(name, handler, params, output, annotations=annotations, kind="management",
                       semantics=spec.semantics(self.device.prefix))

    def _stream_tool(self, name: str, handler: Callable[..., Awaitable[dict[str, Any]]],
                     params: list[inspect.Parameter], output: Any, kind: Literal["read", "actuate"] = "read") -> None:
        spec = ToolSpec(name=name, kind=kind, description=DESCRIPTIONS[name], output=output, attr=name,
                        evidence="stream_buffer" if kind == "read" else "observation")
        self._add_tool(f"{self.device.prefix}_{name}", handler, params, output, annotations=spec.annotations(),
                       kind="hardware", semantics=spec.semantics(self.device.prefix))

    def _register_builtin_tools(self) -> None:
        hid = _parameter("hardwareId", HardwareId)
        self._management("get_server_info", self._get_server_info, [], ServerInfo)
        self._management("list_hardware", self._list_hardware, [], list[Hardware])
        self._management("get_hardware_info", self._get_hardware_info, [hid], Hardware)
        lid = _parameter("leaseId", LeaseId)
        self._management("lease_acquire", self._lease_acquire, [hid, _parameter("holder", PARAMS["holder"])],
                         LeaseGrant, annotations=LEASE)
        self._management("lease_heartbeat", self._lease_heartbeat, [hid, lid], LeaseHeartbeat, annotations=LEASE)
        self._management("lease_release", self._lease_release, [hid, lid], LeaseEnd, annotations=LEASE)
        self._management("lease_force_release", self._lease_force_release,
                         [hid, _parameter("reason", PARAMS["reason"])], LeaseEnd, annotations=LEASE)
        self._management("lease_status", self._lease_status, [hid], LeaseStatus)
        self._add_tool("hardwareharness_prepare_shutdown", self._prepare_shutdown_tool, [], dict[str, Any] | list[Any],
                       annotations=OPERATE, kind="internal")
        streams = self.device.streams
        if not streams:
            return
        sid = _parameter("streamId", StreamId)
        self._stream_tool("stream_read", self._stream_read, [
            hid, sid, _parameter("fromSeq", PARAMS["fromSeq"], None), _parameter("limit", PARAMS["records"], 200)],
            StreamRead)
        if any(isinstance(stream, BlobStream) for stream in streams.values()):
            self._stream_tool("blob_read", self._blob_read, [hid, sid, _parameter("ref", PARAMS["ref"])], BlobRead)
        if any(isinstance(stream, ByteStream) and stream.writer is not None for stream in streams.values()):
            self._stream_tool("transact", self._transact, [
                hid, sid, _parameter("data", PARAMS["data"]), _parameter("encoding", PARAMS["encoding"], "text"),
                _parameter("expect", PARAMS["expect"], None), _parameter("timeoutMs", PARAMS["timeoutMs"], 2000.0)],
                TransactResult, kind="actuate")

    def _register_device_tools(self) -> None:
        prefix = self.device.prefix
        for spec in collect_tools(type(self.device)):
            name = spec.full_name(prefix)
            if name in self.mcp._tool_manager._tools:  # noqa: SLF001 - FastMCP has no public lookup
                raise RuntimeError(f"Duplicate tool {name}")
            method = getattr(self.device, spec.attr)
            params = [_parameter("hardwareId", HardwareId), *method_parameters(method)]

            def bind(method: Callable[..., Any], kind: str) -> Callable[..., Awaitable[dict[str, Any]]]:
                async def handler(hardwareId: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
                    return await self._operate(kind, lambda: self.manager.invoke(hardwareId, method, **kwargs))
                return handler
            self._add_tool(name, bind(method, spec.kind), params,
                           spec.output if spec.output is not None else dict[str, Any],
                           annotations=spec.annotations(), kind="hardware", semantics=spec.semantics(prefix),
                           description=spec.description, extra_meta={"safeAction": True} if spec.kind == "safe" else None)
            self.tool_specs[name] = spec
        for name, spec in self.tool_specs.items():
            action = spec.semantics(prefix).get("safetyAction")
            if action is not None and action["toolName"] not in self.tool_specs:
                raise RuntimeError(f"{name} declares unknown safety_action {action['toolName']}")

    # --- operation context --------------------------------------------
    def _request_meta(self) -> dict[str, Any]:
        """``_meta`` of the current MCP request (``operationId``, ``leaseId``); empty outside a request."""
        try:
            meta = self.mcp.get_context().request_context.meta
        except (LookupError, ValueError):
            return {}
        return meta.model_dump(exclude_none=True) if meta is not None else {}

    async def _operate(self, kind: str, run: Callable[[], Awaitable[Any]]) -> dict[str, Any]:
        """Run one tool call under its operation: lease check by kind, then envelope with op meta."""
        request = self._request_meta()
        operation_id = request.get("operationId")
        op = Operation(operation_id if isinstance(operation_id, str) and operation_id else None)
        token = CURRENT.set(op)
        try:
            if kind in LEASED_KINDS:
                self.leases.check(request.get("leaseId"))
            return ok(await run(), meta=op.meta())
        except Exception as exc:
            return error(exc, meta=op.meta())
        finally:
            CURRENT.reset(token)

    # --- builtin handlers ---------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        """Read process configuration and software state only; never load a device DLL."""
        common: dict[str, Any] = {"contractRevision": CONTRACT_REVISION, "hardwareCount": 1,
                                  "executionMode": execution_mode(self.config.dry_run),
                                  "concurrentHardwareOperations": 1,
                                  "hardwareRevision": type(self.device).hardware_revision or "unknown",
                                  "driverVersion": "unknown", "declarationPath": "/device",
                                  "leaseTools": list(LEASE_TOOLS),
                                  "lease": {"timeoutMs": lease_rules.LEASE_TIMEOUT_MS,
                                            "heartbeatIntervalMs": HEARTBEAT_INTERVAL_MS},
                                  "evidence": "Declared limits and process configuration; not physical measurements."}
        if self.device.streams:
            common["streamTransport"] = {"protocol": "sse", "path": "/streams/{streamId}", "timePath": "/time",
                                         "auth": "bearer", "declaration": "/device streams",
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
            return ok({**self.manager.get_hardware(hardwareId), "capabilityDetails": self.capability_details(),
                       "lease": self.leases.status()})
        except Exception as exc:
            return error(exc)

    # --- leases ---------------------------------------------------------
    async def _end_lease(self, lease: Lease | None, how: str) -> dict[str, Any]:
        """Every lease end (release, timeout, force release) drives the device to its safe state."""
        if lease is None:
            return {"held": False, "released": False}
        log.warning("Lease %s of %s ended (%s); driving %s to its safe state", lease.lease_id, lease.holder, how,
                    self.device.hardware_id)
        try:
            results: list[dict[str, Any]] = await self.manager.safe_all()
        except Exception as exc:
            log.exception("Safe state after lease end failed")
            results = [{"hardwareId": self.device.hardware_id, "safeResult": error(exc)}]
        return {"held": False, "released": True, "holder": dict(lease.holder), "safeResult": results}

    async def _end_expired(self) -> None:
        async with self._lease_end_lock:
            lease = self.leases.expire()
            if lease is not None:
                await self._end_lease(lease, f"no heartbeat for {lease_rules.LEASE_TIMEOUT_MS} ms")

    async def _lease_acquire(self, hardwareId: str, holder: Any) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            await self._end_expired()
            return ok(self.leases.acquire(holder))
        except Exception as exc:
            return error(exc)

    async def _lease_heartbeat(self, hardwareId: str, leaseId: str) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            return ok(self.leases.heartbeat(leaseId))
        except Exception as exc:
            return error(exc)

    async def _lease_release(self, hardwareId: str, leaseId: str) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            async with self._lease_end_lock:
                return ok(await self._end_lease(self.leases.release(leaseId), "released by its holder"))
        except Exception as exc:
            return error(exc)

    async def _lease_force_release(self, hardwareId: str, reason: str) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            async with self._lease_end_lock:
                lease = self.leases.force_release()
                if lease is not None:
                    log.warning("Lease %s of %s force released: %s", lease.lease_id, lease.holder, reason)
                return ok(await self._end_lease(lease, f"force released: {reason}"))
        except Exception as exc:
            return error(exc)

    async def _lease_status(self, hardwareId: str) -> dict[str, Any]:  # noqa: N803
        try:
            self.manager.get_hardware(hardwareId)
            return ok(self.leases.status())
        except Exception as exc:
            return error(exc)

    async def _sweep_leases(self) -> None:
        while True:
            await asyncio.sleep(LEASE_SWEEP_INTERVAL)
            try:
                await self._end_expired()
            except Exception:
                log.exception("Lease sweep failed")

    # --- declaration ----------------------------------------------------
    def manifest(self) -> Manifest:
        """The generated ``/device`` document (software state only; never touches the driver)."""
        return build_manifest(self)

    # --- stream tools ---------------------------------------------------
    def _stream(self, hardwareId: str, streamId: str) -> Stream:  # noqa: N803
        self.manager.get_hardware(hardwareId)
        return self.device.streams.require(streamId)

    async def _stream_read(self, hardwareId: str, streamId: str, fromSeq: int | None = None,  # noqa: N803
                           limit: int = 200) -> dict[str, Any]:
        try:
            stream = self._stream(hardwareId, streamId)
            result = stream.buffer.read(-limit if fromSeq is None else fromSeq, limit)
            data: dict[str, Any] = {
                "streamId": streamId, "type": stream.type, "epoch": stream.buffer.epoch,
                "records": [stream.present(record) for record in result.records], "next": result.next,
                "head": result.head, "tail": result.tail, "watermark": result.watermark,
                "status": {**stream.status(), "watermark": result.watermark}, "reset": result.reset}
            if result.dropped:
                data["dropped"] = {"fromSeq": result.dropped[0], "toSeq": result.dropped[1]}
            return ok(data)
        except Exception as exc:
            return error(exc)

    async def _blob_read(self, hardwareId: str, streamId: str, ref: str) -> dict[str, Any]:  # noqa: N803
        try:
            stream = self._stream(hardwareId, streamId)
            if not isinstance(stream, BlobStream):
                raise DeviceError(f"{streamId} is a {stream.type} stream, not blob", category=INVALID_ARGUMENT)
            mime, content = stream.read(ref)
            if len(content) > MAX_BLOB_BYTES:
                raise DeviceError(f"Blob is {len(content)} bytes, above the {MAX_BLOB_BYTES} byte tool limit",
                                  category=NOT_SUPPORTED, details={"size": len(content), "mime": mime})
            return ok({"ref": ref, "mime": mime, "size": len(content),
                       "base64": base64.b64encode(content).decode("ascii")})
        except Exception as exc:
            return error(exc)

    async def _transact(self, hardwareId: str, streamId: str, data: str, encoding: str = "text",  # noqa: N803
                        expect: str | None = None, timeoutMs: float = 2000.0) -> dict[str, Any]:
        async def run() -> dict[str, Any]:
            stream = self._stream(hardwareId, streamId)
            if not isinstance(stream, ByteStream) or stream.writer is None:
                raise DeviceError(f"{streamId} is not a writable bytes stream", category=NOT_SUPPORTED)
            try:
                payload = data.encode("utf-8") if encoding == "text" else bytes.fromhex(data)
            except ValueError:
                raise DeviceError("data is not valid hex", category=INVALID_ARGUMENT) from None
            try:
                pattern = re.compile(expect) if expect else None
            except re.error as exc:
                raise DeviceError(f"expect is not a valid regex: {exc}", category=INVALID_ARGUMENT) from None
            op = CURRENT.get()
            cursor = stream.buffer.head
            sent = await self.manager.invoke(hardwareId, stream.send, data=payload)
            started = now_ms()
            matched = False
            text = ""
            while not matched and now_ms() - started < timeoutMs and not self.closing:
                result = stream.buffer.read(cursor, 500)
                cursor = result.next
                for record in result.records:
                    if record["dir"] != "rx":
                        continue
                    if op is not None:
                        op.record(streamId, record["seq"])
                    text += bytes.fromhex(record["data"]).decode("utf-8", "replace")
                    if pattern is not None and pattern.search(text):
                        matched = True
                        break
                if not matched and not result.records:
                    await asyncio.sleep(POLL_INTERVAL)
            return {"sent": sent, "matched": matched or expect is None, "text": text,
                    "elapsedMs": round(now_ms() - started, 3)}
        return await self._operate("actuate", run)

    # --- lifecycle ------------------------------------------------------
    async def start(self) -> None:
        self.closing = False
        self.device.streams.bind(lambda: self.manager.available, self.device.io_lock)
        await self.manager.start()
        self._lease_sweeper = asyncio.create_task(self._sweep_leases(), name="lease-sweeper")

    async def stop(self) -> None:
        self.closing = True
        if self._lease_sweeper is not None:
            self._lease_sweeper.cancel()
            await asyncio.gather(self._lease_sweeper, return_exceptions=True)
            self._lease_sweeper = None
        await asyncio.to_thread(self.device.streams.close)
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

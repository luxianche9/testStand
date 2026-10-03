"""One device hosted in this process: tools, operations, streams and lifecycle, without any transport.

:class:`DeviceHost` is what the HardwareHarness backend loads as a plugin. Every tool is
described as a plain dict (``name``, ``description``, ``inputSchema``, ``outputSchema``,
``annotations``, ``_meta.hardwareharness``) and called with :meth:`DeviceHost.call`, which
validates the arguments, runs the tool under its operation (``operationId``) and returns the
JSON envelope ``{ok, data|error, meta}``.
"""

from __future__ import annotations

import asyncio
import base64
import contextvars
import inspect
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError, create_model

from ._version import __version__
from .clock import now_ms
from .config import DeviceConfig
from .device import Device
from .envelope import CONTRACT_REVISION, TIMEOUT_RECOVERY, envelope, error, model, ok
from .errors import INVALID_ARGUMENT, NOT_SUPPORTED, DeviceError
from .lifecycle import HardwareManager
from .manifest import Manifest, build_manifest
from .operation import CURRENT, Operation
from .ringbuffer import ReadResult
from .sim import execution_mode
from .streams import BlobStream, ByteStream, Stream
from .tool import (
    OPERATE,
    READ_ONLY,
    HardwareId,
    ToolAnnotations,
    ToolSpec,
    collect_tools,
    method_parameters,
    param,
)

Hardware = model("HardwareInfo", hardwareId=(str, "Stable device identifier returned by discovery."),
                 state=(str, "Service lifecycle state; open does not prove external wiring."),
                 health=(str, "Last service/driver health, not end-to-end experiment validation."),
                 capabilities=(list[str], "Declared device capabilities.", []),
                 capabilityDetails=(dict[str, Any], "Versioned limits, effective settings and evidence semantics.", {}),
                 lastError=(dict[str, Any] | None, "Last lifecycle/job error.", None))
DeviceInfo = model("DeviceInfo", name=(str, "Device instance name."), version=(str, "Installed adapter package version."),
                   deviceId=(str, "Device instance identity."), computerId=(str, "Configured host identity."),
                   startupComplete=(bool, "Initialization complete; not a measurement."),
                   draining=(bool, "Plugin is refusing new operations while stopping."),
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
StreamId = param(str, "Exact streamId from /device streams.", min_length=1, max_length=64)
DESCRIPTIONS = {
    "get_device_info": "Read plugin version, readiness and nonsecret effective capabilities without signal actuation. One plugin instance manages exactly one active device; ready does not prove the physical experiment or wiring.",
    "list_hardware": "Discover the single device managed by this plugin instance. Use its hardwareId in subsequent calls; presence and plugin health do not verify every channel or external cable.",
    "get_hardware_info": "Read device identity, lifecycle health, capability limits and effective settings. Static declarations and software state are not physical measurements.",
    "stream_read": "Read buffered records from fromSeq (omit for the latest records) without consuming them. Records carry seq, t (Unix ms) and op when a tool call produced them; bytes records add decoded text. Sampled streams only produce records while watched: status.state idle means nobody watches; HardwareHarness recordings and live views start sampling.",
    "blob_read": "Read the content of one blob record (screenshot, capture file) by its ref as base64 with its media type. Blobs are kept in memory and old ones are evicted; the ref comes from stream_read or a tool result.",
    "transact": "Send data on a byte stream and wait until the received text matches the expect regex or timeoutMs passes. Sending is a physical output and is never retried automatically; the tx/rx records are tagged with this call's operation.",
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
}
INTERNAL_TOOLS = frozenset({"hardwareharness_prepare_shutdown"})
"""Reported as kind ``internal`` in ``/device.tools`` (platform plumbing, not test steps)."""
POLL_INTERVAL = 0.02
MAX_BLOB_BYTES = 8 << 20
LEVEL_TYPES = frozenset({"scalar", "bits"})
"""A record of these types holds until the next one (``seek(..., hold=True)``)."""

REQUEST: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar("hardwareharness_request", default={})
"""Request metadata (``operationId``) of the tool call being served."""


def _parameter(name: str, annotation: Any, default: Any = inspect.Parameter.empty) -> inspect.Parameter:
    return inspect.Parameter(name, inspect.Parameter.KEYWORD_ONLY, annotation=annotation, default=default)


class _Arguments(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)


@dataclass
class HostTool:
    """One published tool: its handler, parameters, envelope model and contract metadata."""

    name: str
    description: str
    handler: Callable[..., Awaitable[dict[str, Any]]]
    params: list[inspect.Parameter]
    output: Any
    annotations: ToolAnnotations
    meta: dict[str, Any]
    arguments: type[BaseModel] = field(init=False)
    result: type[BaseModel] = field(init=False)

    def __post_init__(self) -> None:
        fields: dict[str, Any] = {
            item.name: (item.annotation, ... if item.default is inspect.Parameter.empty else item.default)
            for item in self.params
        }
        self.arguments = create_model(f"{self.name}Arguments", __base__=_Arguments, **fields)
        self.result = envelope(self.name, self.output)

    def describe(self) -> dict[str, Any]:
        """The tool as an MCP ``tools/list`` entry."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.arguments.model_json_schema(by_alias=True),
            "outputSchema": self.result.model_json_schema(),
            "annotations": self.annotations.model_dump(exclude_none=True),
            "_meta": {"hardwareharness": self.meta},
        }

    def structured(self, value: dict[str, Any]) -> dict[str, Any]:
        return self.result.model_validate(value).model_dump(mode="json", by_alias=True)


class DeviceHost:
    """One device, its lifecycle manager, its tools and its streams, in this process."""

    def __init__(
        self,
        device_cls: type[Device],
        config: DeviceConfig,
        *,
        retry_delays: tuple[float, ...] = (5, 10, 30),
        watchdog_interval: float = 1.0,
    ) -> None:
        if (device_cls.manufacturer, device_cls.model) != (config.manufacturer, config.model):
            raise RuntimeError(f"Config manufacturer/model {config.manufacturer}/{config.model} does not match "
                               f"the adapter {device_cls.manufacturer}/{device_cls.model}")
        if not device_cls.prefix:
            raise RuntimeError(f"{device_cls.__name__}.prefix is required")
        self.config = config
        self.device = device_cls(config)
        self.manager = HardwareManager(self.device, retry_delays=retry_delays, watchdog_interval=watchdog_interval)
        self.closing = False
        self.tools: dict[str, HostTool] = {}
        self.tool_specs: dict[str, ToolSpec] = {}
        self.tool_kinds: dict[str, str] = {}
        """Tool name -> kind (read, configure, actuate, safe, internal) for ``/device.tools``."""
        self._register_builtin_tools()
        self._register_device_tools()

    # --- registration -------------------------------------------------
    def _add_tool(self, name: str, handler: Callable[..., Awaitable[dict[str, Any]]], params: list[inspect.Parameter],
                  output: Any, *, annotations: ToolAnnotations, kind: str, semantics: dict[str, Any] | None = None,
                  description: str | None = None, extra_meta: dict[str, Any] | None = None) -> None:
        if name in self.tools:
            raise RuntimeError(f"Duplicate tool {name}")
        text = description or DESCRIPTIONS[name.removeprefix(f"{self.device.prefix}_")]
        meta: dict[str, Any] = {"kind": kind}
        if kind != "internal":
            meta.update(contractRevision=CONTRACT_REVISION, resultSemantics=text, timeoutRecovery=TIMEOUT_RECOVERY)
        if semantics is not None:
            meta["operationSemantics"] = semantics
        meta.update(extra_meta or {})
        self.tools[name] = HostTool(name, text, handler, params, output, annotations, meta)
        self.tool_kinds[name] = ("internal" if kind == "internal" or name in INTERNAL_TOOLS
                                 else (semantics or {}).get("kind", "read"))

    def _management(self, name: str, handler: Callable[..., Awaitable[dict[str, Any]]], params: list[inspect.Parameter],
                    output: Any, evidence: str = "controller_state") -> None:
        spec = ToolSpec(name=name, kind="read", description=DESCRIPTIONS[name], output=output, attr=name, evidence=evidence)
        self._add_tool(name, handler, params, output, annotations=READ_ONLY, kind="management",
                       semantics=spec.semantics(self.device.prefix))

    def _stream_tool(self, name: str, handler: Callable[..., Awaitable[dict[str, Any]]],
                     params: list[inspect.Parameter], output: Any, kind: Literal["read", "actuate"] = "read") -> None:
        spec = ToolSpec(name=name, kind=kind, description=DESCRIPTIONS[name], output=output, attr=name,
                        evidence="stream_buffer" if kind == "read" else "observation")
        self._add_tool(f"{self.device.prefix}_{name}", handler, params, output, annotations=spec.annotations(),
                       kind="hardware", semantics=spec.semantics(self.device.prefix))

    def _register_builtin_tools(self) -> None:
        hid = _parameter("hardwareId", HardwareId)
        self._management("get_device_info", self._get_device_info, [], DeviceInfo)
        self._management("list_hardware", self._list_hardware, [], list[Hardware])
        self._management("get_hardware_info", self._get_hardware_info, [hid], Hardware)
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
            method = getattr(self.device, spec.attr)
            params = [_parameter("hardwareId", HardwareId), *method_parameters(method)]

            def bind(method: Callable[..., Any]) -> Callable[..., Awaitable[dict[str, Any]]]:
                async def handler(hardwareId: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
                    return await self._operate(lambda: self.manager.invoke(hardwareId, method, **kwargs))
                return handler
            self._add_tool(name, bind(method), params,
                           spec.output if spec.output is not None else dict[str, Any],
                           annotations=spec.annotations(), kind="hardware", semantics=spec.semantics(prefix),
                           description=spec.description, extra_meta={"safeAction": True} if spec.kind == "safe" else None)
            self.tool_specs[name] = spec
        for name, spec in self.tool_specs.items():
            action = spec.semantics(prefix).get("safetyAction")
            if action is not None and action["toolName"] not in self.tool_specs:
                raise RuntimeError(f"{name} declares unknown safety_action {action['toolName']}")

    # --- calling ------------------------------------------------------
    def describe_tools(self) -> list[dict[str, Any]]:
        return [tool.describe() for tool in self.tools.values()]

    async def call(self, name: str, arguments: dict[str, Any] | None = None, *,
                   operation_id: str | None = None) -> dict[str, Any]:
        """Run tool ``name``; the result is the JSON envelope (invalid arguments give an error envelope)."""
        tool = self.tools.get(name)
        if tool is None:
            return error(DeviceError(f"Unknown tool {name}", category=NOT_SUPPORTED))
        try:
            parsed = tool.arguments.model_validate(arguments or {})
        except ValidationError as exc:
            return error(DeviceError(f"Invalid arguments for {name}: {exc}", category=INVALID_ARGUMENT))
        token = REQUEST.set({"operationId": operation_id} if operation_id else {})
        try:
            result = await tool.handler(**{key: getattr(parsed, key) for key in tool.arguments.model_fields})
        finally:
            REQUEST.reset(token)
        return tool.structured(result)

    async def _operate(self, run: Callable[[], Awaitable[Any]]) -> dict[str, Any]:
        """Run one tool call under its operation and envelope the result with op meta."""
        operation_id = REQUEST.get().get("operationId")
        op = Operation(operation_id if isinstance(operation_id, str) and operation_id else None)
        token = CURRENT.set(op)
        try:
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
                                  "evidence": "Declared limits and process configuration; not physical measurements."}
        if self.device.streams:
            common["streamTransport"] = {"declaration": "/device streams",
                                         "readTool": f"{self.device.prefix}_stream_read"}
        common.update(self.device.capability_details())
        return common

    async def _get_device_info(self) -> dict[str, Any]:
        hardware = self.manager.list_hardware()
        return ok({"name": self.config.device_id, "version": self.device.version, "computerId": self.config.computer_id,
                   "deviceId": self.config.device_id, "startupComplete": self.manager.startup_complete,
                   "draining": self.manager.draining,
                   "status": "degraded" if hardware[0]["state"] in {"unreachable", "faulted"} else "ready",
                   "hardware": hardware, "contractRevision": CONTRACT_REVISION,
                   "capabilities": self.capability_details(), "sdkVersion": __version__,
                   "adapter": self.device.model,
                   "sourceRevision": self.config.build.get("sourceRevision") or self.config.build.get("gitCommit")})

    async def _list_hardware(self) -> dict[str, Any]:
        data = self.manager.list_hardware()
        if len(data) != 1:
            return error(DeviceError(f"Device invariant failed: expected one hardware, got {len(data)}",
                                     category="invalid_response"))
        return ok(data)

    async def _get_hardware_info(self, hardwareId: str) -> dict[str, Any]:  # noqa: N803
        try:
            return ok({**self.manager.get_hardware(hardwareId), "capabilityDetails": self.capability_details()})
        except Exception as exc:
            return error(exc)

    # --- declaration ----------------------------------------------------
    def manifest(self) -> Manifest:
        """The generated ``/device`` document (software state only; never touches the driver)."""
        return build_manifest(self)

    # --- streams --------------------------------------------------------
    def _stream(self, hardwareId: str, streamId: str) -> Stream:  # noqa: N803
        self.manager.get_hardware(hardwareId)
        return self.device.streams.require(streamId)

    def watch(self, stream_id: str) -> None:
        """Count one reader of ``stream_id``; sampled streams poll the device while watched."""
        self.device.streams.require(stream_id).acquire()

    def unwatch(self, stream_id: str) -> None:
        self.device.streams.require(stream_id).release()

    def seek(self, stream_id: str, since: float) -> int:
        """Cursor of the first record at or after ``since`` (the one in force for level streams)."""
        stream = self.device.streams.require(stream_id)
        return stream.buffer.seek(since, hold=stream.type in LEVEL_TYPES)

    def read_stream(self, stream_id: str, cursor: int | None, limit: int,
                    epoch: str | None = None) -> dict[str, Any]:
        """Records from ``cursor`` (``None``: only new ones) as ``{epoch, records, next, watermark, gap?, status}``."""
        stream = self.device.streams.require(stream_id)
        result = stream.buffer.read(cursor, limit, epoch=epoch)
        data: dict[str, Any] = {"streamType": stream.type, "epoch": stream.buffer.epoch, "records": result.records,
                                "next": result.next, "watermark": result.watermark,
                                "status": {**stream.status(), "watermark": result.watermark}}
        gap = _gap(result)
        if gap is not None:
            data["gap"] = gap
        return data

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

    def read_blob(self, stream_id: str, ref: str) -> tuple[str, bytes]:
        stream = self.device.streams.require(stream_id)
        if not isinstance(stream, BlobStream):
            raise DeviceError(f"{stream_id} is a {stream.type} stream, not blob", category=INVALID_ARGUMENT)
        return stream.read(ref)

    async def _blob_read(self, hardwareId: str, streamId: str, ref: str) -> dict[str, Any]:  # noqa: N803
        try:
            self._stream(hardwareId, streamId)
            mime, content = self.read_blob(streamId, ref)
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
        return await self._operate(run)

    # --- lifecycle ------------------------------------------------------
    async def start(self) -> None:
        """Open the device (``safe_state`` right after); a failed open retries in the background."""
        self.closing = False
        self.device.streams.bind(lambda: self.manager.available, self.device.io_lock)
        await self.manager.start()

    async def stop(self) -> None:
        """``safe_state`` and close the device."""
        self.closing = True
        await asyncio.to_thread(self.device.streams.close)
        await self.manager.stop()

    async def safe_all(self) -> list[dict[str, Any]]:
        return await self.manager.safe_all()

    async def prepare_shutdown(self) -> dict[str, Any]:
        """Safe-state the device and refuse new operations."""
        self.manager.draining = True
        self.closing = True
        try:
            results: list[Any] = await self.manager.safe_all()
        except Exception as exc:
            results = [error(exc)]
        return ok(results)

    async def _prepare_shutdown_tool(self) -> dict[str, Any]:
        return await self.prepare_shutdown()


def _gap(result: ReadResult) -> dict[str, Any] | None:
    if result.reset:
        return {"fromSeq": None, "toSeq": result.tail - 1, "reason": "reset"}
    if result.dropped:
        return {"fromSeq": result.dropped[0], "toSeq": result.dropped[1], "reason": "overflow"}
    return None

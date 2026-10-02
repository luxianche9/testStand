"""Adapter compliance suite, run in-process against the dry-run simulator.

``check_device(MyDevice)`` returns a list of human-readable failures (empty
means compliant). Adapter tests usually just assert it is empty::

    def test_compliance():
        assert check_device(Pci6208v) == []

Pass ``warnings=[]`` to collect non-fatal findings as well (missing appearance
or port images, missing description, event streams whose reader never calls
``idle()``).

``serve()`` exposes the same server (uvicorn on an ephemeral 127.0.0.1 port in
a background thread) for adapter-specific tests. Requires the ``test`` extra
(httpx, jsonschema).
"""

from __future__ import annotations

import itertools
import json
import math
import re
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import httpx
import uvicorn

from .. import lease as lease_module
from ..app import DeviceService
from ..clock import now_ms
from ..config import ServerConfig
from ..device import Device
from ..envelope import CONTRACT_REVISION
from ..lease import HEARTBEAT_INTERVAL_MS
from ..manifest import MEDIA_TYPES
from ..streams import IDLE_INTERVAL_MS, STREAM_KINDS, STREAM_TYPES, ByteStream, FrameStream

TOKEN = "compliance-token"
MIN_DESCRIPTION = 80
ACCEPT = "application/json, text/event-stream"
OPERATION_ID = "compliance-op-1"
WATCH_SECONDS = 1.5
"""How long each stream is watched for records, a status event and watermark progress."""
HEX = re.compile(r"^(?:[0-9a-f]{2})*$")
REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")
TOOL_KINDS = {"read", "configure", "actuate", "safe", "internal"}
MANIFEST_KEYS = {"manifestRevision", "contractRevision", "identity", "description", "images", "pinout", "streams",
                 "capabilities", "tools"}
REMOVED_TOOLS = ("get_pinout", "list_streams", "lease_renew")
"""Replaced by ``/device`` and heartbeat leases (contract 2026-10-01.1)."""
TEST_LEASE_TIMEOUT_MS = 400
"""Lease timeout used while checking timeout semantics (patched into :mod:`..lease`)."""
IDLE_SLACK_MS = 150
"""Scheduling allowance on top of ``IDLE_INTERVAL_MS`` for idle-driven watermarks."""


def dry_run_config(device_cls: type[Device], **overrides: Any) -> ServerConfig:
    data: dict[str, Any] = {"serverId": f"{device_cls.model.upper().replace('-', '')}_MCP",
                            "hardwareId": f"{device_cls.model.upper().replace('-', '')}_1",
                            "manufacturer": device_cls.manufacturer, "model": device_cls.model,
                            "port": 18000, "token": TOKEN, "dryRun": True}
    data.update(overrides)
    return ServerConfig.from_mapping(data, env={})


class McpClient:
    """Minimal Streamable HTTP JSON-RPC client."""

    def __init__(self, client: httpx.Client, token: str) -> None:
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}", "Accept": ACCEPT, "Content-Type": "application/json"}
        self._ids = itertools.count(1)
        result = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                             "clientInfo": {"name": "hardwareharness-compliance", "version": "1"}})
        self.headers["mcp-protocol-version"] = result["protocolVersion"]
        self.notify("notifications/initialized")

    def _post(self, payload: dict[str, Any]) -> Any:
        response = self.client.post("/mcp", headers=self.headers, content=json.dumps(payload))
        if "mcp-session-id" in response.headers:
            self.headers["mcp-session-id"] = response.headers["mcp-session-id"]
        response.raise_for_status()
        return response

    def request(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        body = self._post({"jsonrpc": "2.0", "id": next(self._ids), "method": method, "params": dict(params or {})}).json()
        if "error" in body:
            raise RuntimeError(f"{method}: {body['error']}")
        return body["result"]

    def notify(self, method: str) -> None:
        self._post({"jsonrpc": "2.0", "method": method})

    def list_tools(self) -> list[dict[str, Any]]:
        return list(self.request("tools/list")["tools"])

    def call_raw(self, name: str, arguments: Mapping[str, Any] | None = None,
                 meta: Mapping[str, Any] | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"name": name, "arguments": dict(arguments or {})}
        if meta:
            params["_meta"] = dict(meta)
        return dict(self.request("tools/call", params))

    def call(self, name: str, arguments: Mapping[str, Any] | None = None,
             meta: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Structured envelope ``{ok, data|error, meta}`` of one tool call; ``meta`` is sent as request ``_meta``."""
        result = self.call_raw(name, arguments, meta)
        if result.get("isError"):
            raise RuntimeError(f"{name} raised: {result.get('content')}")
        return dict(result["structuredContent"])


@dataclass
class Harness:
    client: httpx.Client
    service: DeviceService
    mcp: McpClient
    token: str
    tools: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def hardware_id(self) -> str:
        return self.service.device.hardware_id

    def _resolve(self, name: str, arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        full = name if name in self.tools else f"{self.service.device.prefix}_{name}"
        schema = self.tools.get(full, {}).get("inputSchema", {})
        if "hardwareId" in schema.get("properties", {}):
            arguments.setdefault("hardwareId", self.hardware_id)
        return full, arguments

    def call(self, name: str, _meta: Mapping[str, Any] | None = None, **arguments: Any) -> dict[str, Any]:
        """Call ``name`` (short device names are prefixed) with the bound hardwareId; ``_meta`` is request meta."""
        return self.mcp.call(*self._resolve(name, arguments), _meta)

    def call_raw(self, name: str, _meta: Mapping[str, Any] | None = None, **arguments: Any) -> dict[str, Any]:
        return self.mcp.call_raw(*self._resolve(name, arguments), _meta)

    def get(self, path: str, token: str | None = None) -> httpx.Response:
        """GET ``path`` with the Bearer token (``token=""`` sends none)."""
        token = self.token if token is None else token
        return self.client.get(path, headers={"Authorization": f"Bearer {token}"} if token else {})

    @contextmanager
    def sse(self, stream_id: str, *, cursor: int | str | None = None, since: float | None = None,
            last_event_id: str | None = None, token: str | None = None) -> Iterator[EventStream]:
        """Subscribe to ``/streams/{stream_id}``; leaving the block disconnects."""
        params = {key: str(value) for key, value in (("from", cursor), ("since", since)) if value is not None}
        headers = {"Authorization": f"Bearer {token or self.token}", "Accept": "text/event-stream"}
        if last_event_id is not None:
            headers["Last-Event-ID"] = last_event_id
        with self.client.stream("GET", f"/streams/{stream_id}", params=params, headers=headers) as response:
            yield EventStream(response)


class EventStream:
    """Server-sent events of one response; :meth:`receive` returns ``{"type": <event>, **data}``."""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.status_code = response.status_code
        self.last_id: str | None = None
        """``id`` of the last received event that carried one (resume with ``last_event_id``)."""
        self._lines = response.iter_lines()

    def receive(self) -> dict[str, Any]:
        if self.status_code != 200:
            raise AssertionError(f"stream request failed with HTTP {self.status_code}")
        event, event_id = "message", ""
        data: list[str] = []
        for line in self._lines:
            if not line:
                if data:
                    if event_id:
                        self.last_id = event_id
                    return {"type": event, **json.loads("\n".join(data))}
                event, event_id = "message", ""
                continue
            name, _, value = line.partition(":")
            value = value.removeprefix(" ")
            if name == "event":
                event = value
            elif name == "data":
                data.append(value)
            elif name == "id":
                event_id = value
        raise AssertionError("event stream ended")


def receive_until(events: EventStream, predicate: Any, limit: int = 200) -> dict[str, Any]:
    """Read events until ``predicate(event)`` holds; fails after ``limit`` events."""
    for _ in range(limit):
        event = events.receive()
        if predicate(event):
            return event
    raise AssertionError("expected event not received")


@contextmanager
def serve(device_cls: type[Device], config: ServerConfig | None = None, **options: Any) -> Iterator[Harness]:
    config = config or dry_run_config(device_cls)
    options.setdefault("request_exit", lambda: None)
    options.setdefault("retry_delays", (0.05,))
    options.setdefault("watchdog_interval", 0.05)
    service = DeviceService(device_cls, config, **options)
    server = uvicorn.Server(uvicorn.Config(service.app(), host="127.0.0.1", port=0, log_level="warning",
                                           timeout_graceful_shutdown=2))
    thread = threading.Thread(target=server.run, name=f"serve-{device_cls.__name__}", daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        if not thread.is_alive() or time.monotonic() > deadline:
            raise RuntimeError(f"{device_cls.__name__} test server did not start")
        time.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=10) as client:
            mcp = McpClient(client, config.token)
            harness = Harness(client=client, service=service, mcp=mcp, token=config.token)
            harness.tools = {item["name"]: item for item in mcp.list_tools()}
            yield harness
    finally:
        server.should_exit = True
        thread.join(10)


def _schema_errors(schema: dict[str, Any], value: Any) -> list[str]:
    import jsonschema

    validator = jsonschema.Draft202012Validator(schema)
    return [f"{'/'.join(map(str, err.absolute_path)) or '<root>'}: {err.message}" for err in validator.iter_errors(value)]


def _number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def record_errors(stream_type: str, record: Mapping[str, Any]) -> list[str]:
    """Format problems of one stream record: ``seq``, ``t``, optional ``op`` and the per-type payload."""
    problems: list[str] = []
    if not isinstance(record.get("seq"), int) or record["seq"] < 0:
        problems.append("seq must be a non-negative integer")
    if not _number(record.get("t")):
        problems.append("t must be a finite number (Unix ms)")
    if "op" in record and not isinstance(record["op"], str):
        problems.append("op must be a string")
    if stream_type == "scalar" and not _number(record.get("v")):
        problems.append("scalar record needs a numeric v")
    elif stream_type == "bits":
        mask = record.get("mask")
        if not isinstance(mask, int) or isinstance(mask, bool) or mask < 0:
            problems.append("bits record needs a non-negative integer mask")
    elif stream_type in {"bytes", "frames"}:
        if record.get("dir") not in {"tx", "rx", "mark"}:
            problems.append(f"{stream_type} record dir must be tx, rx or mark")
        if not isinstance(record.get("data"), str) or not HEX.match(record["data"]):
            problems.append(f"{stream_type} record data must be lowercase hex")
        if record.get("dir") == "mark" and not isinstance(record.get("note"), str):
            problems.append(f"{stream_type} mark record needs a note")
        if stream_type == "frames" and not isinstance(record.get("id"), int):
            problems.append("frames record needs an integer id")
    elif stream_type == "block":
        if not _number(record.get("dt")) or record["dt"] <= 0 or record.get("t0") != record.get("t"):
            problems.append("block record needs a positive dt and t0 equal to t")
        if not isinstance(record.get("samples"), list) or not all(_number(v) for v in record["samples"]):
            problems.append("block record samples must be numbers")
    elif stream_type == "blob" and not isinstance(record.get("ref"), str):
        problems.append("blob record needs a string ref")
    return problems


def _sample_value(spec: Mapping[str, Any]) -> tuple[bool, Any]:
    """A schema-valid value for one parameter, when one is obvious."""
    if "default" in spec:
        return True, spec["default"]
    if "enum" in spec:
        return True, spec["enum"][0]
    if any(option.get("type") == "null" for option in spec.get("anyOf") or ()):
        return True, None
    kind = spec.get("type")
    if kind in {"integer", "number"}:
        if "minimum" in spec:
            value = spec["minimum"]
        elif "exclusiveMinimum" in spec:
            value = spec["exclusiveMinimum"] + 1
        else:
            value = min(0, spec.get("maximum", 0))
        return True, int(value) if kind == "integer" else float(value)
    if kind == "boolean":
        return True, False
    return False, None


def valid_arguments(schema: Mapping[str, Any]) -> dict[str, Any] | None:
    """Arguments for every required parameter except ``hardwareId``, or ``None`` when not derivable."""
    properties = schema.get("properties") or {}
    arguments: dict[str, Any] = {}
    for key in schema.get("required") or ():
        if key == "hardwareId":
            continue
        known, value = _sample_value(properties.get(key) or {})
        if not known:
            return None
        arguments[key] = value
    return arguments


def _semantics(item: Mapping[str, Any]) -> str | None:
    meta = (item.get("_meta") or {}).get("hardwareharness") or {}
    semantics = meta.get("operationSemantics")
    return semantics.get("kind") if isinstance(semantics, dict) else None


def _check_tool(item: dict[str, Any], failures: list[str]) -> None:
    name = item["name"]
    meta = (item.get("_meta") or {}).get("hardwareharness") or {}
    kind = meta.get("kind")
    if kind not in {"management", "hardware", "internal"}:
        failures.append(f"{name}: _meta.hardwareharness.kind missing or unknown ({kind!r})")
    if kind == "internal":
        return
    if len(item.get("description") or "") < MIN_DESCRIPTION:
        failures.append(f"{name}: description shorter than {MIN_DESCRIPTION} characters; state evidence semantics")
    if not item.get("annotations"):
        failures.append(f"{name}: annotations missing")
    if "data" not in ((item.get("outputSchema") or {}).get("properties") or {}):
        failures.append(f"{name}: outputSchema lacks the envelope data field")
    if meta.get("contractRevision") is None:
        failures.append(f"{name}: contractRevision missing")
    semantics = meta.get("operationSemantics")
    if kind == "hardware":
        if not isinstance(semantics, dict) or semantics.get("kind") not in {"read", "configure", "actuate", "safe"}:
            failures.append(f"{name}: operationSemantics.kind missing")
        elif semantics["kind"] == "actuate" and semantics.get("retry") != "never_after_dispatch":
            failures.append(f"{name}: actuate tools must use retry=never_after_dispatch")
        annotations = item.get("annotations") or {}
        if isinstance(semantics, dict) and semantics.get("kind") == "read" and not annotations.get("readOnlyHint"):
            failures.append(f"{name}: read tools must be readOnlyHint")
    for key, spec in ((item.get("inputSchema") or {}).get("properties") or {}).items():
        if not spec.get("description"):
            failures.append(f"{name}.{key}: parameter description missing (include range and unit)")


def _watch(hh: Harness, stream_id: str, stream_type: str, epoch: str, failures: list[str]) -> None:
    """Hello first, valid increasing records, a status event, and a watermark that advances while watched."""
    with hh.sse(stream_id, cursor=0) as events:
        hello = events.receive()
        if hello.get("type") != "hello" or hello.get("epoch") != epoch or hello.get("streamType") != stream_type:
            failures.append(f"stream {stream_id}: expected hello event, got {hello}")
        last_seq, last_t = -1, -math.inf
        watermarks: list[float] = []
        status_seen = False
        deadline = time.monotonic() + WATCH_SECONDS
        while time.monotonic() < deadline:
            event = events.receive()
            if event.get("type") == "batch":
                for record in event.get("records") or ():
                    failures.extend(f"stream {stream_id} record {record.get('seq')}: {problem}"
                                    for problem in record_errors(stream_type, record))
                    seq, t = record.get("seq", last_seq), record.get("t", last_t)
                    if seq <= last_seq or t <= last_t:
                        failures.append(f"stream {stream_id}: seq and t must strictly increase")
                    last_seq, last_t = seq, t
            elif event.get("type") == "status":
                status_seen = True
                missing = {"state", "sampling", "errors", "watermark"} - event.keys()
                if missing:
                    failures.append(f"stream {stream_id}: status event lacks {sorted(missing)}")
            if _number(event.get("watermark")):
                if watermarks and event["watermark"] < watermarks[-1]:
                    failures.append(f"stream {stream_id}: watermark went backwards")
                watermarks.append(event["watermark"])
            if status_seen and len(watermarks) >= 2 and watermarks[-1] > watermarks[0]:
                return
        if not status_seen:
            failures.append(f"stream {stream_id}: no status event received")
        else:
            failures.append(f"stream {stream_id}: watermark did not advance while watched "
                            "(samplers must advance it after every attempt, also failed ones)")


def _check_idle(hh: Harness, failures: list[str], warnings: list[str]) -> None:
    """Event streams: the reader thread calls ``idle()`` so the watermark trails now by at most ~200 ms."""
    for stream_id, stream in hh.service.device.streams.items():
        if not isinstance(stream, ByteStream | FrameStream):
            continue
        if not stream.idle_driven:
            warnings.append(f"stream {stream_id}: the reader never called idle() in dry-run; its watermark is "
                            "clock-driven, which only holds when every record is published synchronously")
            continue
        worst = 0.0
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            worst = max(worst, now_ms() - stream.buffer.watermark())
            time.sleep(0.02)
        if worst > IDLE_INTERVAL_MS + IDLE_SLACK_MS:
            failures.append(f"stream {stream_id}: watermark trailed now by {worst:.0f} ms; the reader thread must "
                            f"call idle() after every read return (at least every {IDLE_INTERVAL_MS} ms)")


def _check_streams(hh: Harness, failures: list[str]) -> None:
    streams = hh.service.device.streams
    for stream_id, stream in streams.items():
        if stream.type not in STREAM_TYPES:
            failures.append(f"stream {stream_id}: unknown type {stream.type}")
            continue
        try:
            _watch(hh, stream_id, stream.type, stream.buffer.epoch, failures)
        except Exception as exc:
            failures.append(f"stream {stream_id}: SSE channel failed: {exc}")
            continue
        read = hh.call("stream_read", streamId=stream_id, fromSeq=0, limit=50)
        if not read.get("ok"):
            failures.append(f"stream {stream_id}: stream_read failed: {read.get('error')}")
            continue
        records = read["data"]["records"]
        failures.extend(f"stream {stream_id} stream_read record {record.get('seq')}: {problem}"
                        for record in records for problem in record_errors(stream.type, record))
        if any(b["t"] <= a["t"] for a, b in itertools.pairwise(records)):
            failures.append(f"stream {stream_id}: stream_read t must strictly increase")

    with hh.sse(next(iter(streams)), token="wrong") as denied:
        if denied.status_code != 401:
            failures.append(f"stream channel with a wrong token returned HTTP {denied.status_code}, expected 401")


def _check_asset(hh: Harness, image: Mapping[str, Any], where: str, failures: list[str]) -> None:
    asset = image.get("asset")
    if not isinstance(asset, str) or image.get("mediaType") not in MEDIA_TYPES.values():
        failures.append(f"/device {where}: image needs asset and a PNG/JPEG/WebP/SVG mediaType, got {image}")
        return
    response = hh.get(f"/assets/{asset}")
    if response.status_code != 200:
        failures.append(f"/assets/{asset} ({where}) returned HTTP {response.status_code}")
    elif response.headers.get("content-type", "").split(";")[0] != image["mediaType"]:
        failures.append(f"/assets/{asset}: content-type {response.headers.get('content-type')} "
                        f"does not match {image['mediaType']}")


def _check_manifest(hh: Harness, failures: list[str], warnings: list[str]) -> None:
    """``/device`` shape, revision, identity, streams, tools and every referenced asset."""
    for name in REMOVED_TOOLS:
        if name in hh.tools:
            failures.append(f"{name}: removed from the contract; the declaration lives in /device")
    if hh.get("/device", token="").status_code != 401 or hh.get("/device", token="wrong").status_code != 401:
        failures.append("/device must require the Bearer token")
    response = hh.get("/device")
    if response.status_code != 200:
        failures.append(f"/device returned HTTP {response.status_code}")
        return
    document = response.json()
    manifest = hh.service.manifest()
    failures.extend(f"/device: {problem}" for problem in manifest.problems)
    warnings.extend(f"/device: {warning}" for warning in manifest.warnings)
    if set(document) != MANIFEST_KEYS:
        failures.append(f"/device keys must be {sorted(MANIFEST_KEYS)}, got {sorted(document)}")
        return
    revision = document["manifestRevision"]
    if not isinstance(revision, str) or not REVISION.match(revision):
        failures.append(f"/device manifestRevision must be sha256:<hex>, got {revision!r}")
    if hh.get("/device").json().get("manifestRevision") != revision:
        failures.append("/device manifestRevision changed between two reads without any change")
    if hh.client.get("/health").json().get("manifestRevision") != revision:
        failures.append("/health manifestRevision must equal /device manifestRevision")
    if document["contractRevision"] != CONTRACT_REVISION:
        failures.append(f"/device contractRevision must be {CONTRACT_REVISION}")
    identity = document["identity"] if isinstance(document["identity"], dict) else {}
    device = hh.service.device
    expected = {"serverId": hh.service.config.server_id, "hardwareId": device.hardware_id,
                "manufacturer": device.manufacturer, "model": device.model, "dryRun": True}
    wrong = {key: identity.get(key) for key, value in expected.items() if identity.get(key) != value}
    adapter = identity.get("adapter") or {}
    if wrong or not adapter.get("name") or not adapter.get("version") or not identity.get("sdkVersion"):
        failures.append(f"/device identity mismatch {wrong or identity}; expected {expected} plus adapter "
                        "{name, version} and sdkVersion")
    streams = document["streams"]
    if streams != device.streams.describe() or any(not {"id", "type"} <= set(item) for item in streams):
        failures.append(f"/device streams must be Stream.describe() per stream, got {streams}")
    for item in streams:
        if "kind" in item and item["kind"] not in STREAM_KINDS:
            failures.append(f"/device stream {item.get('id')}: kind must be one of {STREAM_KINDS}")
    tools = {item.get("name"): item.get("kind") for item in document["tools"]}
    if set(tools) != set(hh.tools):
        failures.append(f"/device tools must list every MCP tool; differs by {sorted(set(tools) ^ set(hh.tools))}")
    for name, kind in tools.items():
        semantics = _semantics(hh.tools.get(name) or {})
        if kind not in TOOL_KINDS or (kind != "internal" and semantics is not None and kind != semantics):
            failures.append(f"/device tool {name}: kind {kind!r} must be {semantics or 'one of ' + str(TOOL_KINDS)}")
    if not isinstance(document["capabilities"], dict):
        failures.append("/device capabilities must be an object (the former capabilityDetails)")
    appearance = (document["images"] or {}).get("appearance")
    if appearance is not None:
        _check_asset(hh, appearance, "images.appearance", failures)
    pinout = document["pinout"]
    if pinout is not None:
        if not isinstance(pinout, dict) or not {"connectors", "pins"} <= set(pinout):
            failures.append("/device pinout must be the SDK Pinout model")
        else:
            for connector in pinout["connectors"]:
                if connector.get("image") is not None:
                    _check_asset(hh, connector["image"], f"connector {connector.get('connectorId')}", failures)
    for path in ("%2E%2E/pyproject.toml", "..%2Fserver.json", "missing.png", "notes.txt"):
        status = hh.get(f"/assets/{path}").status_code
        if status not in {400, 404}:
            failures.append(f"/assets/{path} must be refused (400/404), got HTTP {status}")
    if hh.get(f"/assets/{appearance['asset']}" if appearance else "/assets/x.png", token="").status_code != 401:
        failures.append("/assets must require the Bearer token")


def _check_operation(hh: Harness, safe_tool: str, failures: list[str]) -> None:
    """``_meta.operationId`` comes back in ``meta`` with timing; every streamRef points at tagged records."""
    meta = hh.call(safe_tool, {"operationId": OPERATION_ID}).get("meta") or {}
    if meta.get("operationId") != OPERATION_ID:
        failures.append(f"{safe_tool}: meta.operationId must echo _meta.operationId, got {meta.get('operationId')}")
    timing = meta.get("timing") or {}
    if not (_number(timing.get("start")) and _number(timing.get("end")) and timing["end"] >= timing["start"]):
        failures.append(f"{safe_tool}: meta.timing {{start, end}} missing")
    for ref in meta.get("streamRefs") or ():
        read = hh.call("stream_read", streamId=ref["streamId"], fromSeq=ref["fromSeq"],
                       limit=ref["toSeq"] - ref["fromSeq"] + 1)
        records = (read.get("data") or {}).get("records") or []
        if not any(record.get("op") == OPERATION_ID for record in records):
            failures.append(f"{safe_tool}: streamRef {ref} points at no record tagged op={OPERATION_ID}")


def _check_ranges(hh: Harness, failures: list[str]) -> None:
    """Every bounded numeric input of a configure/actuate tool must reject max+1 with an error."""
    for name, item in hh.tools.items():
        if _semantics(item) not in {"configure", "actuate"}:
            continue
        schema = item.get("inputSchema") or {}
        base = valid_arguments(schema)
        if base is None:
            continue
        for key, spec in (schema.get("properties") or {}).items():
            options = [spec, *(spec.get("anyOf") or ())]
            bound = next((option.get("maximum", option.get("exclusiveMaximum")) for option in options
                          if option.get("type") in {"integer", "number"}
                          and ("maximum" in option or "exclusiveMaximum" in option)), None)
            if bound is None:
                continue
            raw = hh.call_raw(name, **{**base, key: bound + 1})
            if not raw.get("isError") and (raw.get("structuredContent") or {}).get("ok") is not False:
                failures.append(f"{name}.{key}={bound + 1}: out-of-range input must be rejected with an error")


HOLDER = {"terminalId": "compliance-terminal", "user": "compliance", "host": "localhost", "label": "check"}


def _busy(result: Mapping[str, Any]) -> bool:
    return not result.get("ok") and (result.get("error") or {}).get("category") == "busy"


@contextmanager
def _count_safe_states(hh: Harness) -> Iterator[list[int]]:
    """Count ``safe_state`` runs (``counter[0]``) while the block runs."""
    device = hh.service.device
    original = device.safe_state
    counter = [0]

    def counted(*args: Any, **kwargs: Any) -> Any:
        counter[0] += 1
        return original(*args, **kwargs)
    device.safe_state = counted  # type: ignore[method-assign]
    try:
        yield counter
    finally:
        del device.safe_state


def _wait(predicate: Any, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return bool(predicate())


def _check_lease_ends(hh: Harness, failures: list[str]) -> None:
    """Release, force release and heartbeat timeout all end the lease and run safe_state."""
    with _count_safe_states(hh) as safe:
        lease_id = hh.call("lease_acquire", holder=HOLDER).get("data", {}).get("leaseId")
        before = safe[0]
        forced = hh.call("lease_force_release", reason="compliance check")
        data = forced.get("data") or {}
        if not forced.get("ok") or not data.get("released") or (data.get("holder") or {}).get("terminalId") != \
                HOLDER["terminalId"]:
            failures.append(f"lease_force_release must end the lease and report the original holder, got {forced}")
        if safe[0] <= before:
            failures.append("lease_force_release must drive the device to its safe state")
        if not _busy(hh.call("lease_heartbeat", leaseId=lease_id or "x")):
            failures.append("lease_heartbeat after a force release must fail with busy")

        original = lease_module.LEASE_TIMEOUT_MS
        lease_module.LEASE_TIMEOUT_MS = TEST_LEASE_TIMEOUT_MS
        try:
            grant = hh.call("lease_acquire", holder=HOLDER).get("data") or {}
            if grant.get("timeoutMs") != TEST_LEASE_TIMEOUT_MS:
                failures.append("lease_acquire timeoutMs must report the server constant LEASE_TIMEOUT_MS")
            # Any call carrying _meta.leaseId is a heartbeat.
            for _ in range(int(TEST_LEASE_TIMEOUT_MS * 2 / 100)):
                hh.call("lease_status", {"leaseId": grant.get("leaseId")})
                time.sleep(0.1)
            if not (hh.call("lease_status").get("data") or {}).get("held"):
                failures.append("a tool call carrying _meta.leaseId must count as a lease heartbeat")
            before = safe[0]
            if not _wait(lambda: not (hh.call("lease_status").get("data") or {}).get("held"),
                         TEST_LEASE_TIMEOUT_MS / 1000 + 3):
                failures.append("a lease without heartbeat for LEASE_TIMEOUT_MS must be released")
            elif not _wait(lambda: safe[0] > before, 2):
                failures.append("a lease that timed out must drive the device to its safe state")
            if not _busy(hh.call("lease_heartbeat", leaseId=grant.get("leaseId") or "x")):
                failures.append("lease_heartbeat after a timeout must fail with busy")
        finally:
            lease_module.LEASE_TIMEOUT_MS = original
            hh.call("lease_force_release", reason="compliance cleanup")


def _check_lease(hh: Harness, safe_tools: list[str], failures: list[str]) -> None:
    acquired = hh.call("lease_acquire", holder=HOLDER)
    grant = acquired.get("data") or {}
    lease_id = grant.get("leaseId")
    if not acquired.get("ok") or not lease_id:
        failures.append(f"lease_acquire failed: {acquired.get('error')}")
        return
    if grant.get("holder") != HOLDER or grant.get("heartbeatIntervalMs") != HEARTBEAT_INTERVAL_MS or \
            grant.get("timeoutMs") != lease_module.LEASE_TIMEOUT_MS or not _number(grant.get("acquiredAt")):
        failures.append(f"lease_acquire must return {{leaseId, holder, acquiredAt, heartbeatIntervalMs, timeoutMs}}, "
                        f"got {grant}")
    released_ok = False
    try:
        again = hh.call("lease_acquire", holder=HOLDER["terminalId"])
        if (again.get("data") or {}).get("leaseId") != lease_id:
            failures.append("lease_acquire by the same terminalId must return the existing leaseId")
        status = hh.call("lease_status").get("data") or {}
        if not status.get("held") or (status.get("holder") or {}).get("terminalId") != HOLDER["terminalId"] or \
                "leaseId" in status or not _number(status.get("lastHeartbeatAt")):
            failures.append(f"lease_status must report {{held, holder, acquiredAt, lastHeartbeatAt}} without the "
                            f"leaseId, got {status}")
        beat = hh.call("lease_heartbeat", leaseId=lease_id)
        if not beat.get("ok") or (beat.get("data") or {}).get("leaseId") != lease_id or \
                not _number((beat.get("data") or {}).get("lastHeartbeatAt")):
            failures.append(f"lease_heartbeat must return {{leaseId, lastHeartbeatAt}}, got {beat}")
        if not _busy(hh.call("lease_heartbeat", leaseId="lease-unknown")):
            failures.append("lease_heartbeat with an unknown leaseId must fail with busy")
        second = hh.call("lease_acquire", holder={"terminalId": "other-terminal"})
        details = (second.get("error") or {}).get("details") or {}
        if not _busy(second) or (details.get("holder") or {}).get("terminalId") != HOLDER["terminalId"]:
            failures.append("lease_acquire by a second holder must fail with busy and details.holder")
        for name in safe_tools:
            if not hh.call(name).get("ok"):
                failures.append(f"{name}: safe tools must not be blocked by another holder's lease")
        for name, item in hh.tools.items():
            arguments = valid_arguments(item.get("inputSchema") or {})
            if _semantics(item) in {"configure", "actuate"} and arguments is not None:
                refused = hh.call(name, **arguments)
                if (refused.get("error") or {}).get("category") != "busy":
                    failures.append(f"{name}: configure/actuate without the holder's leaseId must fail with busy")
                allowed = hh.call(name, {"leaseId": lease_id}, **arguments)
                if (allowed.get("error") or {}).get("category") == "busy":
                    failures.append(f"{name}: configure/actuate with the holder's leaseId must not be busy")
                break
        with _count_safe_states(hh) as safe:
            released = hh.call("lease_release", leaseId=lease_id)
            released_ok = True
            data = released.get("data") or {}
            if not released.get("ok") or data.get("held") or not data.get("released"):
                failures.append(f"lease_release did not release the lease: {released}")
            if safe[0] < 1:
                failures.append("lease_release must drive the device to its safe state")
        if not _busy(hh.call("lease_heartbeat", leaseId=lease_id)):
            failures.append("lease_heartbeat after lease_release must fail with busy")
    finally:
        if not released_ok:
            hh.call("lease_release", leaseId=lease_id)
    _check_lease_ends(hh, failures)


def check_device(device_cls: type[Device], config: ServerConfig | None = None, *,
                 warnings: list[str] | None = None, **options: Any) -> list[str]:
    """Failures of the contract (empty: compliant); non-fatal findings are appended to ``warnings``."""
    failures: list[str] = []
    warnings = warnings if warnings is not None else []
    with serve(device_cls, config, **options) as hh:
        tools = hh.tools
        for item in tools.values():
            _check_tool(item, failures)
        safe_tools = [name for name, item in tools.items() if _semantics(item) == "safe"]
        if not safe_tools:
            failures.append("no tool declares kind='safe'; every device needs a safe_state tool")

        def call(name: str, **arguments: Any) -> dict[str, Any] | None:
            try:
                result = hh.call(name, **arguments)
            except Exception as exc:
                failures.append(f"{name}: call failed: {exc}")
                return None
            failures.extend(f"{name}: output {err}" for err in _schema_errors(tools[name]["outputSchema"], result))
            return result

        listed = call("list_hardware")
        if listed is not None:
            data = listed.get("data") or []
            if not listed.get("ok") or len(data) != 1:
                failures.append(f"list_hardware must return exactly one hardware, got {listed}")
            elif data[0]["hardwareId"] != hh.hardware_id or data[0]["state"] != "open":
                failures.append(f"list_hardware: expected open {hh.hardware_id}, got {data[0]}")
        for name in ("get_server_info", "get_hardware_info", "lease_status"):
            result = call(name)
            if result is not None and not result.get("ok"):
                failures.append(f"{name}: not ok: {result.get('error')}")
        _check_manifest(hh, failures, warnings)
        for name in safe_tools:
            results = [call(name), call(name)]
            if not all(result and result.get("ok") for result in results):
                failures.append(f"{name}: safe action must succeed twice in a row (idempotent) in dry-run")

        denied = hh.client.post("/mcp", headers={"Accept": ACCEPT, "Content-Type": "application/json"},
                                content=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        if denied.status_code != 401:
            failures.append(f"/mcp without Bearer token returned {denied.status_code}, expected 401")
        if hh.client.get("/health").status_code != 200:
            failures.append("/health must be reachable without a token")

        if hh.service.device.streams:
            _check_streams(hh, failures)
            _check_idle(hh, failures, warnings)
        if safe_tools:
            _check_operation(hh, safe_tools[0], failures)
        _check_ranges(hh, failures)
        _check_lease(hh, safe_tools, failures)
        if safe_tools:
            hh.call(safe_tools[0])
    return failures

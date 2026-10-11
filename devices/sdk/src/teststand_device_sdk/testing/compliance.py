"""Adapter compliance suite, run in-process against the dry-run simulator.

``check_device(MyDevice)`` returns a list of human-readable failures (empty
means compliant). Adapter tests usually just assert it is empty::

    def test_compliance():
        assert check_device(Pci6208v) == []

Pass ``warnings=[]`` to collect non-fatal findings as well (missing
description, event streams whose reader never calls ``idle()``).

``serve()`` starts the same :class:`~..host.DeviceHost` on an event loop in a
background thread for adapter-specific tests: ``hh.call`` returns tool
envelopes, ``hh.device()`` the ``/device`` declaration and ``hh.subscribe()``
reads a stream as ``hello``/``batch``/``gap``/``status`` events. Requires the
``test`` extra (jsonschema).
"""

from __future__ import annotations

import asyncio
import itertools
import math
import re
import threading
import time
from collections import deque
from collections.abc import Coroutine, Iterator, Mapping
from contextlib import contextmanager
from typing import Any

from ..clock import now_ms
from ..config import DeviceConfig
from ..device import Device
from ..envelope import CONTRACT_REVISION
from ..host import DeviceHost
from ..streams import IDLE_INTERVAL_MS, STREAM_KINDS, STREAM_TYPES, ByteStream, FrameStream

MIN_DESCRIPTION = 80
OPERATION_ID = "compliance-op-1"
WATCH_SECONDS = 1.5
"""How long each stream is watched for records, a status event and watermark progress."""
CALL_TIMEOUT = 30.0
BATCH_INTERVAL = 0.05
STATUS_INTERVAL = 0.2
"""A ``status`` event follows every status change and at least this often (seconds) without other events."""
MAX_BATCH_RECORDS = 500
HEX = re.compile(r"^(?:[0-9a-f]{2})*$")
REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")
TOOL_KINDS = {"read", "configure", "actuate", "safe", "internal"}
MANIFEST_KEYS = {"manifestRevision", "contractRevision", "identity", "description", "pinout", "streams",
                 "capabilities", "tools"}
REMOVED_TOOLS = ("get_pinout", "list_streams")
"""Replaced by ``/device`` (contract 2026-10-01.1)."""
IDLE_SLACK_MS = 150
"""Scheduling allowance on top of ``IDLE_INTERVAL_MS`` for idle-driven watermarks."""


def dry_run_config(device_cls: type[Device], **overrides: Any) -> DeviceConfig:
    data: dict[str, Any] = {"deviceId": f"{device_cls.model.upper().replace('-', '')}_MCP",
                            "hardwareId": f"{device_cls.model.upper().replace('-', '')}_1",
                            "manufacturer": device_cls.manufacturer, "model": device_cls.model, "dryRun": True}
    data.update(overrides)
    return DeviceConfig.from_mapping(data, env={})


class Harness:
    """A started :class:`DeviceHost` whose event loop runs in a background thread; every method blocks."""

    def __init__(self, host: DeviceHost, loop: asyncio.AbstractEventLoop) -> None:
        self.host = host
        self.loop = loop
        self.tools: dict[str, dict[str, Any]] = {item["name"]: item for item in host.describe_tools()}

    @property
    def hardware_id(self) -> str:
        return self.host.device.hardware_id

    def run(self, coroutine: Coroutine[Any, Any, Any]) -> Any:
        """Run ``coroutine`` on the host's event loop and wait for its result."""
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(CALL_TIMEOUT)

    def _resolve(self, name: str, arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        full = name if name in self.tools else f"{self.host.device.prefix}_{name}"
        schema = self.tools.get(full, {}).get("inputSchema", {})
        if "hardwareId" in schema.get("properties", {}):
            arguments.setdefault("hardwareId", self.hardware_id)
        return full, arguments

    def call(self, name: str, /, *, operation_id: str | None = None, **arguments: Any) -> dict[str, Any]:
        """Envelope ``{ok, data|error, meta}`` of ``name`` (short device names are prefixed), bound hardwareId."""
        full, arguments = self._resolve(name, arguments)
        return self.call_raw(full, arguments, operation_id=operation_id)

    def call_raw(self, name: str, arguments: Mapping[str, Any] | None = None, *,
                 operation_id: str | None = None) -> dict[str, Any]:
        """Envelope of exactly ``name`` with exactly ``arguments`` (no prefix, no hardwareId)."""
        return dict(self.run(self.host.call(name, dict(arguments or {}), operation_id=operation_id)))

    def device(self) -> dict[str, Any]:
        """The ``/device`` declaration document."""
        return self.host.manifest().document

    @contextmanager
    def subscribe(self, stream_id: str, *, cursor: int | None = None, since: float | None = None,
                  epoch: str | None = None) -> Iterator[EventStream]:
        """Watch ``stream_id`` and read it as events; leaving the block stops watching.

        ``cursor`` ``None`` delivers only new records, a negative one starts at the last
        ``-cursor`` records; ``since`` starts at the first record with ``t >= since`` (on level
        streams the one still in force) and wins over ``cursor``; ``epoch`` is the epoch
        ``cursor`` came from (another epoch restarts at the oldest record with a reset gap).
        """
        self.host.watch(stream_id)
        try:
            if since is not None:
                cursor = self.host.seek(stream_id, since)
            yield EventStream(self.host, stream_id, cursor, epoch)
        finally:
            self.host.unwatch(stream_id)


class EventStream:
    """Events of one stream read in process; :meth:`receive` returns ``{"type": <event>, **data}``.

    * ``hello``  — ``{streamId, streamType, epoch, fromSeq}``
    * ``batch``  — ``{records: [{seq, t, op?, ...payload}], watermark}``
    * ``gap``    — ``{fromSeq, toSeq, reason: overflow|reset}``
    * ``status`` — ``{state, sampling, errors, lastError?, watermark}``, on change and at least
      every ``STATUS_INTERVAL`` seconds without other events; ``state: closed`` ends the stream
    """

    def __init__(self, host: DeviceHost, stream_id: str, cursor: int | None, epoch: str | None) -> None:
        self.host = host
        self.stream_id = stream_id
        first = host.read_stream(stream_id, cursor, 0, epoch)
        self.epoch: str = first["epoch"]
        self.next: int = first["next"]
        """Cursor after the last delivered batch (resume with ``cursor=next, epoch=epoch``)."""
        self._events: deque[dict[str, Any]] = deque([{"type": "hello", "streamId": stream_id,
                                                      "streamType": first["streamType"], "epoch": self.epoch,
                                                      "fromSeq": self.next}])
        if "gap" in first:
            self._events.append({"type": "gap", **first["gap"]})
        self._status: dict[str, Any] | None = None
        self._last_sent = 0.0
        self._ended = False

    def receive(self) -> dict[str, Any]:
        while not self._events:
            self._poll()
        return self._events.popleft()

    def _poll(self) -> None:
        if self._ended:
            raise AssertionError("event stream ended")
        data = self.host.read_stream(self.stream_id, self.next, MAX_BATCH_RECORDS)
        if self.host.closing:
            self._events.append({"type": "status", **data["status"], "state": "closed"})
            self._ended = True
            return
        if "gap" in data:
            self._events.append({"type": "gap", **data["gap"]})
        self.next = data["next"]
        if data["records"]:
            self._events.append({"type": "batch", "records": data["records"], "watermark": data["watermark"]})
            self._last_sent = time.monotonic()
        status = data["status"]
        changed = self._status is None or _without_watermark(status) != _without_watermark(self._status)
        if changed or time.monotonic() - self._last_sent >= STATUS_INTERVAL:
            self._events.append({"type": "status", **status})
            self._status, self._last_sent = status, time.monotonic()
        if not self._events:
            time.sleep(BATCH_INTERVAL)


def _without_watermark(status: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in status.items() if key != "watermark"}


def receive_until(events: EventStream, predicate: Any, limit: int = 200) -> dict[str, Any]:
    """Read events until ``predicate(event)`` holds; fails after ``limit`` events."""
    for _ in range(limit):
        event = events.receive()
        if predicate(event):
            return event
    raise AssertionError("expected event not received")


async def _cancel_pending() -> None:
    tasks = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


@contextmanager
def serve(device_cls: type[Device], config: DeviceConfig | None = None, **options: Any) -> Iterator[Harness]:
    """Start ``device_cls`` (dry-run by default) in a :class:`DeviceHost`; leaving the block stops it."""
    config = config or dry_run_config(device_cls)
    options.setdefault("retry_delays", (0.05,))
    options.setdefault("watchdog_interval", 0.05)
    host = DeviceHost(device_cls, config, **options)
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, name=f"serve-{device_cls.__name__}", daemon=True)
    thread.start()
    harness = Harness(host, loop)
    try:
        harness.run(host.start())
        try:
            yield harness
        finally:
            harness.run(host.stop())
    finally:
        harness.run(_cancel_pending())
        loop.call_soon_threadsafe(loop.stop)
        thread.join(10)
        loop.close()


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
        if not _number(record.get("dt")) or record["dt"] <= 0 or not _number(record.get("t0"))                 or record["t0"] > record.get("t", 0):
            problems.append("block record needs a positive dt and a t0 no later than t")
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
    meta = (item.get("_meta") or {}).get("teststand") or {}
    semantics = meta.get("operationSemantics")
    return semantics.get("kind") if isinstance(semantics, dict) else None


def _check_tool(item: dict[str, Any], failures: list[str]) -> None:
    name = item["name"]
    meta = (item.get("_meta") or {}).get("teststand") or {}
    kind = meta.get("kind")
    if kind not in {"management", "hardware", "internal"}:
        failures.append(f"{name}: _meta.teststand.kind missing or unknown ({kind!r})")
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
    with hh.subscribe(stream_id, cursor=0) as events:
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
    for stream_id, stream in hh.host.device.streams.items():
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
    streams = hh.host.device.streams
    for stream_id, stream in streams.items():
        if stream.type not in STREAM_TYPES:
            failures.append(f"stream {stream_id}: unknown type {stream.type}")
            continue
        try:
            _watch(hh, stream_id, stream.type, stream.buffer.epoch, failures)
        except Exception as exc:
            failures.append(f"stream {stream_id}: reading the stream failed: {exc}")
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


def _check_manifest(hh: Harness, failures: list[str], warnings: list[str]) -> None:
    """``/device`` shape, revision, identity, streams and tools."""
    for name in REMOVED_TOOLS:
        if name in hh.tools:
            failures.append(f"{name}: removed from the contract; the declaration lives in /device")
    manifest = hh.host.manifest()
    document = manifest.document
    failures.extend(f"/device: {problem}" for problem in manifest.problems)
    warnings.extend(f"/device: {warning}" for warning in manifest.warnings)
    if set(document) != MANIFEST_KEYS:
        failures.append(f"/device keys must be {sorted(MANIFEST_KEYS)}, got {sorted(document)}")
        return
    revision = document["manifestRevision"]
    if not isinstance(revision, str) or not REVISION.match(revision):
        failures.append(f"/device manifestRevision must be sha256:<hex>, got {revision!r}")
    if hh.device().get("manifestRevision") != revision:
        failures.append("/device manifestRevision changed between two reads without any change")
    if document["contractRevision"] != CONTRACT_REVISION:
        failures.append(f"/device contractRevision must be {CONTRACT_REVISION}")
    identity = document["identity"] if isinstance(document["identity"], dict) else {}
    device = hh.host.device
    expected = {"deviceId": hh.host.config.device_id, "hardwareId": device.hardware_id,
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
        failures.append(f"/device tools must list every tool; differs by {sorted(set(tools) ^ set(hh.tools))}")
    for name, kind in tools.items():
        semantics = _semantics(hh.tools.get(name) or {})
        if kind not in TOOL_KINDS or (kind != "internal" and semantics is not None and kind != semantics):
            failures.append(f"/device tool {name}: kind {kind!r} must be {semantics or 'one of ' + str(TOOL_KINDS)}")
    if not isinstance(document["capabilities"], dict):
        failures.append("/device capabilities must be an object (the former capabilityDetails)")
    pinout = document["pinout"]
    if pinout is not None and (not isinstance(pinout, dict) or not {"connectors", "pins"} <= set(pinout)):
        failures.append("/device pinout must be the SDK Pinout model")


def _check_operation(hh: Harness, safe_tool: str, failures: list[str]) -> None:
    """The call's ``operationId`` comes back in ``meta`` with timing; every streamRef points at tagged records."""
    meta = hh.call(safe_tool, operation_id=OPERATION_ID).get("meta") or {}
    if meta.get("operationId") != OPERATION_ID:
        failures.append(f"{safe_tool}: meta.operationId must echo the call's operationId, got {meta.get('operationId')}")
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
            if hh.call(name, **{**base, key: bound + 1}).get("ok") is not False:
                failures.append(f"{name}.{key}={bound + 1}: out-of-range input must be rejected with an error")


def check_device(device_cls: type[Device], config: DeviceConfig | None = None, *,
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
        for name in ("get_device_info", "get_hardware_info"):
            result = call(name)
            if result is not None and not result.get("ok"):
                failures.append(f"{name}: not ok: {result.get('error')}")
        _check_manifest(hh, failures, warnings)
        for name in safe_tools:
            results = [call(name), call(name)]
            if not all(result and result.get("ok") for result in results):
                failures.append(f"{name}: safe action must succeed twice in a row (idempotent) in dry-run")

        if hh.host.device.streams:
            _check_streams(hh, failures)
            _check_idle(hh, failures, warnings)
        if safe_tools:
            _check_operation(hh, safe_tools[0], failures)
        _check_ranges(hh, failures)
        if safe_tools:
            hh.call(safe_tools[0])
    return failures

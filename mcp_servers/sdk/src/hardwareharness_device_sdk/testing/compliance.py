"""Adapter compliance suite, run in-process against the dry-run simulator.

``check_device(MyDevice)`` returns a list of human-readable failures (empty
means compliant). Adapter tests usually just assert it is empty::

    def test_compliance():
        assert check_device(Pci6208v) == []

``serve()`` exposes the same in-process server for adapter-specific tests.
Requires the ``test`` extra (httpx, jsonschema).
"""

from __future__ import annotations

import itertools
import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from starlette.testclient import TestClient

from ..app import DeviceService
from ..config import ServerConfig
from ..device import Device

TOKEN = "compliance-token"
MIN_DESCRIPTION = 80
ACCEPT = "application/json, text/event-stream"


def dry_run_config(device_cls: type[Device], **overrides: Any) -> ServerConfig:
    data: dict[str, Any] = {"serverId": f"{device_cls.model.upper().replace('-', '')}_MCP",
                            "hardwareId": f"{device_cls.model.upper().replace('-', '')}_1",
                            "manufacturer": device_cls.manufacturer, "model": device_cls.model,
                            "port": 18000, "token": TOKEN, "dryRun": True}
    data.update(overrides)
    return ServerConfig.from_mapping(data, env={})


class McpClient:
    """Minimal Streamable HTTP JSON-RPC client over a Starlette TestClient."""

    def __init__(self, client: TestClient, token: str) -> None:
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

    def call_raw(self, name: str, arguments: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return dict(self.request("tools/call", {"name": name, "arguments": dict(arguments or {})}))

    def call(self, name: str, arguments: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Structured envelope ``{ok, data|error, meta}`` of one tool call."""
        result = self.call_raw(name, arguments)
        if result.get("isError"):
            raise RuntimeError(f"{name} raised: {result.get('content')}")
        return dict(result["structuredContent"])


@dataclass
class Harness:
    client: TestClient
    service: DeviceService
    mcp: McpClient
    token: str
    tools: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def hardware_id(self) -> str:
        return self.service.device.hardware_id

    def call(self, name: str, **arguments: Any) -> dict[str, Any]:
        """Call ``name`` (short device names are prefixed) with the bound hardwareId."""
        full = name if name in self.tools else f"{self.service.device.prefix}_{name}"
        schema = self.tools.get(full, {}).get("inputSchema", {})
        if "hardwareId" in schema.get("properties", {}):
            arguments.setdefault("hardwareId", self.hardware_id)
        return self.mcp.call(full, arguments)

    def websocket(self, stream_id: str, *, cursor: int | None = None, token: str | None = None) -> Any:
        query = "" if cursor is None else f"?from={cursor}"
        return self.client.websocket_connect(f"/streams/{stream_id}{query}",
                                             headers={"Authorization": f"Bearer {token or self.token}"})


def receive_until(socket: Any, predicate: Any, limit: int = 200) -> dict[str, Any]:
    """Read WebSocket frames until ``predicate(frame)`` holds; fails after ``limit`` frames."""
    for _ in range(limit):
        frame = socket.receive_json()
        if predicate(frame):
            return frame  # type: ignore[no-any-return]
    raise AssertionError("expected frame not received")


@contextmanager
def serve(device_cls: type[Device], config: ServerConfig | None = None, **options: Any) -> Iterator[Harness]:
    config = config or dry_run_config(device_cls)
    options.setdefault("request_exit", lambda: None)
    options.setdefault("retry_delays", (0.05,))
    options.setdefault("watchdog_interval", 0.05)
    service = DeviceService(device_cls, config, **options)
    with TestClient(service.app()) as client:
        mcp = McpClient(client, config.token)
        harness = Harness(client=client, service=service, mcp=mcp, token=config.token)
        harness.tools = {item["name"]: item for item in mcp.list_tools()}
        yield harness


def _schema_errors(schema: dict[str, Any], value: Any) -> list[str]:
    import jsonschema

    validator = jsonschema.Draft202012Validator(schema)
    return [f"{'/'.join(map(str, err.absolute_path)) or '<root>'}: {err.message}" for err in validator.iter_errors(value)]


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


def check_device(device_cls: type[Device], config: ServerConfig | None = None, **options: Any) -> list[str]:
    failures: list[str] = []
    with serve(device_cls, config, **options) as hh:
        tools = hh.tools
        for item in tools.values():
            _check_tool(item, failures)
        safe_tools = [name for name, item in tools.items()
                      if ((item.get("_meta") or {}).get("hardwareharness") or {}).get("operationSemantics", {}).get("kind") == "safe"]
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
        for name in ("get_server_info", "get_hardware_info", "list_streams", "get_panel"):
            result = call(name)
            if result is not None and not result.get("ok"):
                failures.append(f"{name}: not ok: {result.get('error')}")
        pinout = hh.call("get_pinout")
        if not pinout.get("ok") and (pinout.get("error") or {}).get("category") != "not_supported":
            failures.append(f"get_pinout: {pinout.get('error')}")
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

        for stream_id, stream in hh.service.device.streams.items():
            try:
                with hh.websocket(stream_id) as socket:
                    hello = socket.receive_json()
            except Exception as exc:
                failures.append(f"stream {stream_id}: WebSocket failed: {exc}")
                continue
            if hello.get("type") != "hello" or hello.get("epoch") != stream.buffer.epoch:
                failures.append(f"stream {stream_id}: expected hello frame, got {hello}")
        if hh.service.device.streams:
            from starlette.testclient import WebSocketDenialResponse

            first = next(iter(hh.service.device.streams))
            try:
                with hh.websocket(first, token="wrong") as socket:
                    socket.receive_json()
                failures.append("stream WebSocket accepted a wrong token")
            except WebSocketDenialResponse as exc:
                if exc.status_code != 401:
                    failures.append(f"stream WebSocket denial returned {exc.status_code}, expected 401")
            except Exception:  # closed with 1008 by servers without the denial extension
                pass
    return failures

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest

from teststand_backend.application import OPERATIONS
from teststand_backend.application.registry import OperationRegistry
from teststand_backend.contracts.errors import AppError
from teststand_backend.contracts.validation import ValidationError
from teststand_backend.mcp_gateway import LocalMcpGateway
from teststand_backend.mcp_gateway.gateway import AGENT_INSTRUCTIONS
from teststand_backend.mcp_gateway.tool_registry import BUILTIN_TOOLS, ToolRegistry


def make_gateway() -> tuple[LocalMcpGateway, Any]:
    app = Mock(authorizer=Mock(is_allowed=Mock(return_value=True)))
    app.devices.list_tools.return_value = []
    # The operator confirms every confirm=True operation (remove_hardware_definition).
    operations = OperationRegistry(app, OPERATIONS, confirmer=AsyncMock(return_value=True))
    gateway = LocalMcpGateway(
        app,
        Mock(ensure_token=AsyncMock(return_value="secret"), set=AsyncMock()),
        0,
        operations=operations,
    )
    return gateway, app


_HARDWARE = {"hardwareId": "H", "label": "Hardware", "kind": "passive"}
_TASK = {
    "formatVersion": 2,
    "taskId": "T",
    "name": "Task",
    "inputs": [],
    "variables": [],
    "setup": [],
    "steps": [],
    "cleanup": [],
}
_CASES: list[tuple[str, dict[str, Any], str, str, list[Any]]] = [
    ("list_devices", {}, "devices", "list_devices_with_status", []),
    ("refresh_device", {"deviceId": "S"}, "devices", "refresh_device", ["S"]),
    ("list_managed_hardware", {}, "devices", "list_managed_hardware", []),
    ("list_hardware_catalog", {}, "devices", "list_hardware", []),
    ("get_hardware_definition", {"hardwareId": "H"}, "devices", "get_hardware", ["H"]),
    (
        "save_hardware_definition",
        {"hardware": _HARDWARE},
        "devices",
        "save_hardware",
        [{"formatVersion": 2, **_HARDWARE, "ports": []}],
    ),
    ("remove_hardware_definition", {"hardwareId": "H"}, "devices", "remove_hardware", ["H"]),
    (
        "add_managed_hardware_to_canvas",
        {"hardwareId": "H"},
        "wiring",
        "add_managed_hardware_to_canvas",
        ["H"],
    ),
    (
        "request_wiring_task",
        {"portA": "A.J", "portB": "B.J", "action": "connect"},
        "wiring",
        "request_task",
        [{"portA": "A.J", "portB": "B.J", "pins": [], "action": "connect", "timeoutMs": 1800000}],
    ),
    ("cancel_wiring_task", {"wiringTaskId": "W"}, "wiring", "cancel_task", ["W", None]),
    ("get_wiring_task", {"wiringTaskId": "W"}, "wiring", "get_task", ["W"]),
    ("list_wiring_tasks", {}, "wiring", "list_tasks", [{"limit": 100}]),
]


def keywords(group: str, method: str, values: list[Any]) -> dict[str, Any]:
    """The operation's keyword arguments for positional ``values``."""
    definition = next(
        item for item in OPERATIONS.values() if (item.namespace, item.method) == (group, method)
    )
    return dict(zip([python for _, python in definition.parameters], values, strict=True))


@pytest.mark.parametrize("name,args,group,method,expected", _CASES, ids=[row[0] for row in _CASES])
async def test_all_builtin_routes_and_defaults(
    name: str, args: dict[str, Any], group: str, method: str, expected: list[Any]
) -> None:
    gateway, app = make_gateway()
    result: Any = []
    if name == "update_test_task":
        result = {"task": _TASK, "dirty": True, "extra": "omit"}
    elif name == "get_hardware_definition":
        result = {"hardwareId": "H", "ports": []}
    handler = AsyncMock(return_value=result)
    getattr(app, group).__dict__[method] = handler
    output = await gateway.invoke_tool(name, args)
    assert output == {
        "ok": True,
        "data": {"task": _TASK, "dirty": True} if name == "update_test_task" else result,
    }
    handler.assert_awaited_once_with(
        {"actor": "agent", "source": "mcp"}, **keywords(group, method, expected)
    )


async def test_zod_argument_errors_and_nested_stripping() -> None:
    gateway, app = make_gateway()
    app.wiring.request_task.return_value = {}
    await gateway.invoke_tool(
        "request_wiring_task",
        {
            "portA": "A.J",
            "portB": "B.J",
            "action": "connect",
            "pins": [{"a": "1", "b": "2", "extra": "stripped"}],
        },
    )
    assert app.wiring.request_task.call_args.kwargs["input"]["pins"] == [{"a": "1", "b": "2"}]
    with pytest.raises(ValidationError) as caught:
        await gateway.invoke_tool("get_hardware_definition", {"hardwareId": 5, "extra": True})
    assert [(issue["code"], issue["path"]) for issue in caught.value.issues] == [
        ("invalid_type", ["hardwareId"]),
        ("unrecognized_keys", []),
    ]


def test_permissions_duplicate_builtin_and_snapshot_copy() -> None:
    gateway, app = make_gateway()
    with pytest.raises(RuntimeError, match="Duplicate builtin"):
        ToolRegistry(app, [BUILTIN_TOOLS[0], BUILTIN_TOOLS[0]])
    app.authorizer.is_allowed.return_value = False
    assert gateway.list_tools() == []
    app.devices.list_tools.assert_not_called()
    app.authorizer.is_allowed.return_value = True
    listing = gateway.list_builtin_tools()
    listing[0]["inputSchema"]["properties"]["extra"] = {}
    assert "extra" not in gateway.list_builtin_tools()[0]["inputSchema"]["properties"]


async def test_gateway_lifecycle_durable_token_and_bind_error() -> None:
    gateway, _ = make_gateway()
    notified = Mock()
    gateway.set_change_notifier(notified)
    with pytest.raises(RuntimeError, match="not been initialized"):
        gateway.token()
    with patch("teststand_backend.mcp_gateway.gateway.socket.socket") as factory:
        factory.return_value.bind.side_effect = OSError("binding failed")
        await gateway.start()
    assert gateway.status()["lastError"] == "binding failed"
    assert gateway.status()["running"] is False
    await gateway.start()
    try:
        await gateway.start()
        gateway.secrets.ensure_token.assert_awaited_once()
        assert "lastError" not in gateway.status()
        gateway.secrets.set.side_effect = OSError("write failed")
        with pytest.raises(OSError, match="write failed"):
            await gateway.replace_token("new")
        assert gateway.token() == "secret"
    finally:
        await gateway.stop()
        await gateway.stop()
    assert notified.call_count >= 4


_HEADERS = {
    "authorization": "Bearer secret",
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
}
_INITIALIZE: dict[str, Any] = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "boundary", "version": "1"},
    },
}


def result_body(response: httpx.Response) -> Any:
    for line in response.text.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])["result"]
    raise AssertionError(response.text)


async def test_http_routes_and_tool_errors() -> None:
    gateway, app = make_gateway()
    app.wiring.get_task.return_value = _TASK
    await gateway.start()
    try:
        async with httpx.AsyncClient(headers=_HEADERS) as client:
            url = gateway.status()["endpoint"]
            for method, suffix in [("PUT", ""), ("POST", "/extra")]:
                response = await client.request(method, url + suffix)
                assert response.status_code == 405
                assert response.headers["allow"] == "GET, POST, DELETE"
            # Only ?mode=<work mode> is accepted as a query (design doc 8.2).
            for suffix in ["?extra=1", "?mode=bogus", "?mode=run&mode=plan", "?mode=run&x=1"]:
                response = await client.get(url + suffix)
                assert response.status_code == 400
                assert "mode" in response.json()["error"]
            initialized = await client.post(url, json=_INITIALIZE)
            initialization = result_body(initialized)
            # Application building adds only Agent guidance; retain every historical
            # protocol-version, capability and server-info assertion below unchanged.
            assert initialization.pop("instructions") == AGENT_INSTRUCTIONS
            assert initialization == {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": {"name": "teststand", "version": "0.1.0"},
            }
            client.headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
            await client.post(url, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
            success = await client.post(
                url,
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {"name": "get_wiring_task", "arguments": {"wiringTaskId": "W"}},
                },
            )
            assert result_body(success) == {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {"ok": True, "data": _TASK}, ensure_ascii=False, separators=(",", ":")
                        ),
                    }
                ],
                "structuredContent": {"ok": True, "data": _TASK},
            }
            response = await client.post(
                url,
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "get_wiring_task", "arguments": {}},
                },
            )
            result = result_body(response)
            assert result["isError"] is True
            error = result["structuredContent"]["error"]
            assert error["category"] == "invalid_argument"
            assert error["validationIssues"][0]["path"] == ["wiringTaskId"]
            assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
            response = await client.post(
                url,
                json={
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "missing"},
                },
            )
            assert result_body(response)["structuredContent"]["error"] == {
                "category": "not_found",
                "message": "Unknown MCP tool: missing",
            }
            app.devices.refresh_device.side_effect = AppError(
                "conflict",
                "Active run",
                {
                    "hardwareIds": ["H"],
                    "token": "private",
                    "recovery": "Read get_execution_availability",
                },
            )
            response = await client.post(
                url,
                json={
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "refresh_device", "arguments": {"deviceId": "S"}},
                },
            )
            recovery = result_body(response)["structuredContent"]["error"]["details"]
            assert recovery == {
                "hardwareIds": ["H"],
                "token": "[REDACTED]",
                "recovery": "Read get_execution_availability",
            }
    finally:
        await gateway.stop()


async def test_initialize_validation_and_failed_transport_do_not_leak_sessions() -> None:
    gateway, _ = make_gateway()
    await gateway.start()
    try:
        async with httpx.AsyncClient(headers=_HEADERS) as client:
            url = gateway.status()["endpoint"]
            for body in [[], {"method": "initialize"}, {**_INITIALIZE, "params": None}]:
                response = await client.post(url, json=body)
                assert response.status_code == 400
                assert response.json() == {"error": "missing MCP session"}
            assert gateway._sessions == {}
            response = await client.post(url, json=_INITIALIZE, headers={"accept": "text/plain"})
            assert response.status_code == 406
            await asyncio.sleep(0)
            assert gateway._sessions == {}
            assert gateway.status()["lastClient"]["name"] == "boundary"
            integration = {
                **_INITIALIZE,
                "params": {
                    **_INITIALIZE["params"],
                    "clientInfo": {"name": "teststand-integration-check", "version": "1"},
                },
            }
            await client.post(url, json=integration, headers={"accept": "text/plain"})
            assert gateway.status()["lastClient"]["name"] == "boundary"
    finally:
        await gateway.stop()


async def test_mcp_cancellation_keeps_application_operation_running() -> None:
    gateway, app = make_gateway()
    started, finish, completed = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def run(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        started.set()
        await finish.wait()
        completed.set()
        return {"runId": "R"}

    app.wiring.request_task = run
    await gateway.start()
    try:
        async with httpx.AsyncClient(headers=_HEADERS) as client:
            url = gateway.status()["endpoint"]
            initialized = await client.post(url, json=_INITIALIZE)
            client.headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
            await client.post(url, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
            calling = asyncio.create_task(
                client.post(
                    url,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {
                            "name": "request_wiring_task",
                            "arguments": {"portA": "A.J", "portB": "B.J", "action": "connect"},
                        },
                    },
                )
            )
            try:
                await asyncio.wait_for(started.wait(), 1)
                await client.post(
                    url,
                    json={
                        "jsonrpc": "2.0",
                        "method": "notifications/cancelled",
                        "params": {"requestId": 2, "reason": "client moved on"},
                    },
                )
                finish.set()
                await asyncio.wait_for(completed.wait(), 1)
            finally:
                finish.set()
                calling.cancel()
                await asyncio.gather(calling, return_exceptions=True)
    finally:
        await gateway.stop()

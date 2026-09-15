from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from hardwareharness_backend.application import HardwareHarnessApplication
from hardwareharness_backend.mcp_gateway import LocalMcpGateway

PREFIX = "packages/mcp-gateway/src/gateway.test.ts::"


def application(overrides: dict[str, Any] | None = None) -> tuple[Any, Any, Any, Any]:
    devices = Mock(
        store=Mock(
            put_image_bytes=AsyncMock(return_value={}),
            put_image=AsyncMock(return_value={}),
            remove_image=AsyncMock(),
        ),
        list_computers=Mock(return_value=[]),
        list_statuses=Mock(return_value=[]),
        list_servers=Mock(return_value=[{"serverId": "S1", "hardwareId": "HW1", "enabled": True}]),
        list_server_statuses=Mock(return_value=[]),
        list_hardware=Mock(return_value=[]),
        list_availability=Mock(return_value=[]),
        list_tools=Mock(return_value=[]),
        refresh_computer=AsyncMock(return_value={}),
        refresh_server=AsyncMock(return_value={}),
        refresh_all_servers=AsyncMock(return_value=[]),
        read_server_logs=AsyncMock(return_value={"lines": [], "truncated": False}),
        refresh_hardware=AsyncMock(return_value=[]),
        call_aggregated_tool=AsyncMock(return_value="ok"),
    )
    for key, value in (overrides or {}).items():
        setattr(devices, key, value)
    catalog = Mock(
        list_hardware=Mock(return_value=[]),
        get_hardware=Mock(
            side_effect=lambda ident: {"hardwareId": ident, "kind": "managed", "ports": []}
        ),
        save_hardware=AsyncMock(),
    )
    projects = Mock(document=Mock(return_value={"dirty": False, "file": {"task": {}}}))
    wiring = Mock(
        request_task=AsyncMock(return_value={"wiringTaskId": "WT"}),
        add_managed_hardware_to_canvas=AsyncMock(return_value={"added": True}),
        get_task=Mock(return_value={"wiringTaskId": "WT"}),
        list_tasks=Mock(return_value=[]),
        cancel_task=AsyncMock(),
    )
    orchestration = Mock(
        get_task=Mock(return_value={"taskId": "TASK"}),
        start_run=AsyncMock(return_value={"run": {"runId": "RUN"}, "nodeRuns": [], "events": []}),
        cancel_run=AsyncMock(),
        get_run=AsyncMock(return_value={}),
    )
    from hardwareharness_backend.application import (
        ApplicationsApplication,
        DefaultAuthorizer,
        ExecutionCoordinator,
    )

    applications = ApplicationsApplication(
        DefaultAuthorizer(), Mock(), devices, Mock(), ExecutionCoordinator()
    )
    applications.runner = orchestration
    app = HardwareHarnessApplication(
        {
            "devices": devices,
            "catalog": catalog,
            "projects": projects,
            "wiring": wiring,
            "applications": applications,
            "system": {"gateway_status": lambda: {"running": False}},
        }
    )
    return app, devices, wiring, orchestration


def secrets(initial: str = "test-token") -> Any:
    return Mock(ensure_token=AsyncMock(return_value=initial), set=AsyncMock())


@pytest.fixture
async def gateway() -> AsyncIterator[LocalMcpGateway]:
    instance = LocalMcpGateway(application()[0], secrets(), 0)
    await instance.start()
    try:
        yield instance
    finally:
        await instance.stop()


async def request(
    gateway: LocalMcpGateway,
    headers: dict[str, str] | None = None,
    body: str = "{}",
    method: str = "POST",
) -> httpx.Response:
    async with httpx.AsyncClient() as client:
        return await client.request(
            method, gateway.status()["endpoint"], headers=headers, content=body
        )


@pytest.mark.ts_case(PREFIX + "binds loopback and requires its bearer token")
async def test_token(gateway: LocalMcpGateway) -> None:
    assert gateway.status()["running"] is True
    assert gateway.status()["endpoint"].startswith("http://127.0.0.1:")
    assert (await request(gateway)).status_code == 401


@pytest.mark.ts_case(PREFIX + "rejects untrusted Host and Origin before protocol handling")
async def test_origin(gateway: LocalMcpGateway) -> None:
    for header in [{"host": "192.168.3.50:18002"}, {"origin": "http://192.168.3.50"}]:
        response = await request(gateway, {**header, "authorization": "Bearer test-token"})
        assert response.status_code == 403


@pytest.mark.ts_case(PREFIX + "applies a durably rotated token immediately")
async def test_rotate(gateway: LocalMcpGateway) -> None:
    token = await gateway.rotate_token()
    gateway.secrets.set.assert_awaited_once()
    assert (await request(gateway, {"authorization": "Bearer test-token"})).status_code == 401
    assert (await request(gateway, {"authorization": "Bearer " + token})).status_code != 401


@pytest.mark.ts_case(PREFIX + "rejects request bodies larger than one MiB")
async def test_body_limit(gateway: LocalMcpGateway) -> None:
    response = await request(
        gateway,
        {"authorization": "Bearer test-token", "content-type": "application/json"},
        json.dumps({"value": "x" * 1048576}),
    )
    assert response.status_code == 413


@pytest.mark.ts_case(PREFIX + "falls back to an ephemeral port when the preferred port is occupied")
async def test_port_fallback() -> None:
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        port = occupied.getsockname()[1]
        gateway = LocalMcpGateway(application()[0], secrets(), port)
        try:
            await gateway.start()
            status = gateway.status()
            assert status["running"] is True
            assert httpx.URL(status["endpoint"]).port != port
            assert "port was occupied" in status["lastError"].lower()
        finally:
            await gateway.stop()


@pytest.mark.ts_case(
    PREFIX + "maintains a stateful session and exposes only authorized Agent tools"
)
async def test_stateful_session() -> None:
    app, _, _, _ = application()
    app.authorizer.authorize = Mock(wraps=app.authorizer.authorize)
    gateway = LocalMcpGateway(app, secrets(), 0)
    await gateway.start()
    headers = {
        "authorization": "Bearer test-token",
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }
    try:
        response = await request(
            gateway,
            headers,
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "codex", "version": "1.0"},
                    },
                }
            ),
        )
        assert response.status_code == 200
        session_id = response.headers.get("mcp-session-id")
        assert session_id
        headers["mcp-session-id"] = session_id
        await request(
            gateway, headers, json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
        )
        tools = await request(
            gateway,
            headers,
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
        )
        for name in ["request_wiring_task", "start_python_run", "save_hardware_definition"]:
            assert name in tools.text
        for name in [
            "save_remote_computer",
            "register_mcp_server",
            "ssh_execute",
            "force_stop_remote_mcp_service",
        ]:
            assert name not in tools.text
        assert gateway.status()["lastClient"]["name"] == "codex"
        assert gateway.status()["lastClient"]["version"] == "1.0"
        await request(
            gateway,
            headers,
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "get_python_run", "arguments": {"runId": "R"}},
                }
            ),
        )
        contexts = [
            call.args[0]
            for call in app.authorizer.authorize.call_args_list
            if call.args[1] == "applications.read"
        ]
        assert contexts
        assert {key: contexts[0][key] for key in ["actor", "source", "subjectId"]} == {
            "actor": "agent",
            "source": "mcp",
            "subjectId": "codex@1.0",
        }
        assert isinstance(contexts[0]["requestId"], str)
        assert (await request(gateway, headers, method="DELETE")).status_code == 200
    finally:
        await gateway.stop()


@pytest.mark.ts_case(PREFIX + "omits permanently unsupported privileged tools")
async def test_unsupported_tools() -> None:
    gateway = LocalMcpGateway(application()[0], secrets())
    names = [tool["name"] for tool in gateway.list_builtin_tools()]
    for name in [
        "save_remote_computer",
        "register_mcp_server",
        "ssh_execute",
        "force_stop_remote_mcp_service",
    ]:
        assert name not in names
    for name in ["save_remote_computer", "ssh_execute"]:
        with pytest.raises(Exception) as failure:
            await gateway.invoke_tool(name, {})
        assert getattr(failure.value, "category", None) == "not_found"


@pytest.mark.ts_case(PREFIX + "routes allowed wiring, orchestration and aggregated hardware calls")
async def test_tool_routes() -> None:
    remote = {
        "externalName": "S1.measure",
        "remoteName": "measure",
        "serverId": "S1",
        "inputSchema": {"type": "object"},
        "kind": "hardware",
    }
    app, devices, wiring, orchestration = application({"list_tools": Mock(return_value=[remote])})
    gateway = LocalMcpGateway(app, secrets())
    await gateway.invoke_tool(
        "request_wiring_task", {"portA": "A.J1", "portB": "B.J1", "action": "connect"}
    )
    await gateway.invoke_tool("start_python_run", {"entrypoint": "scripts/main.py"})
    await gateway.invoke_tool("S1.measure", {"voltage": 5})
    assert wiring.request_task.call_args.args[0]["requestedBy"] == "agent"
    orchestration.start_run.assert_awaited_once_with(
        {"entrypoint": "scripts/main.py", "inputs": {}, "inputSchema": {}, "hardwareIds": []}
    )
    devices.call_aggregated_tool.assert_awaited_once_with("S1.measure", {"voltage": 5})


@pytest.mark.ts_case(
    PREFIX + "has unique names and valid object schemas, including aggregated tools"
)
def test_tool_schemas() -> None:
    remote = {
        "externalName": "S1.measure",
        "remoteName": "measure",
        "serverId": "S1",
        "inputSchema": {"type": "object", "properties": {}},
        "kind": "hardware",
    }
    gateway = LocalMcpGateway(
        application({"list_tools": Mock(return_value=[remote])})[0], secrets()
    )
    tools = gateway.list_tools()
    assert len({tool["name"] for tool in tools}) == len(tools)
    assert all(tool["inputSchema"]["type"] == "object" for tool in tools)


@pytest.mark.ts_case(PREFIX + "rejects a remote tool name that collides with a builtin")
def test_duplicate_tool() -> None:
    remote = {
        "externalName": "get_python_run",
        "remoteName": "duplicate",
        "serverId": "S1",
        "inputSchema": {"type": "object"},
        "kind": "hardware",
    }
    gateway = LocalMcpGateway(
        application({"list_tools": Mock(return_value=[remote])})[0], secrets()
    )
    with pytest.raises(Exception, match="Duplicate MCP tool name"):
        gateway.list_tools()


async def test_body_errors_and_shutdown(gateway: LocalMcpGateway) -> None:
    headers = {"authorization": "Bearer test-token"}
    assert (await request(gateway, headers, "{broken")).status_code == 500
    assert (await request(gateway, headers, method="DELETE")).status_code == 400
    assert (await request(gateway, {**headers, "mcp-session-id": "missing"})).status_code == 404
    await asyncio.sleep(0)

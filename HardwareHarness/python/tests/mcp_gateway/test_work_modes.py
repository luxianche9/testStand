from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from hardwareharness_backend.application import OPERATIONS, DefaultAuthorizer
from hardwareharness_backend.application.registry import OperationRegistry
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.mcp_gateway import LocalMcpGateway
from hardwareharness_backend.mcp_gateway.gateway import _work_mode
from hardwareharness_backend.mcp_gateway.tool_registry import ToolRegistry
from hardwareharness_backend.storage.audit_log import AuditLog

AGENT = {"actor": "agent", "source": "mcp"}
REMOTE = {
    "externalName": "S1__pulse",
    "remoteName": "pulse",
    "deviceId": "S1",
    "kind": "device",
    "inputSchema": {"type": "object"},
}


def application() -> Any:
    authorizer = DefaultAuthorizer()
    devices = SimpleNamespace(
        authorizer=authorizer,
        list_tools=Mock(return_value=[REMOTE]),
        call_tool=AsyncMock(return_value={"pulsed": True}),
        get_definition=Mock(return_value={"hardwareId": "H"}),
    )
    testing = SimpleNamespace(
        authorizer=authorizer, current_run=Mock(return_value={"runId": "run"})
    )
    return SimpleNamespace(authorizer=authorizer, devices=devices, testing=testing)


def names(registry: ToolRegistry, mode: str | None = None) -> set[str]:
    context = {**AGENT, "mode": mode} if mode else AGENT
    return {tool["name"] for tool in registry.list(context)}


def test_work_modes_limit_the_catalog_to_profiled_tools() -> None:
    registry = ToolRegistry(application())
    everything = names(registry)
    run, adapter, explore = (
        names(registry, "run"),
        names(registry, "adapter"),
        names(registry, "explore"),
    )
    assert run < everything and adapter < everything and explore < everything
    # Unprofiled gateway tools are in every mode.
    assert {"get_agent_context", "wait_for_status"} <= run & adapter & explore
    # Design doc 8.2: device tools are not expanded in run mode.
    assert "S1__pulse" not in run
    assert "S1__pulse" in adapter and "S1__pulse" in explore and "S1__pulse" in everything
    assert "start_test_run" in run and "start_test_run" not in adapter
    assert "save_hardware_definition" in adapter and "save_hardware_definition" not in run


async def test_out_of_mode_tools_are_rejected() -> None:
    registry = ToolRegistry(application())
    with pytest.raises(AppError, match="not available in run mode") as error:
        await registry.invoke({**AGENT, "mode": "run"}, "save_hardware_definition", {})
    assert error.value.category == "not_found"
    with pytest.raises(AppError, match="Unknown MCP tool"):
        await registry.invoke({**AGENT, "mode": "run"}, "S1__pulse", {})


async def test_generated_tools_come_from_profiled_operations() -> None:
    app = application()
    registry = ToolRegistry(app)
    tools = {tool["name"]: tool for tool in registry.list(AGENT)}
    definition = tools["devices_getDefinition"]
    assert definition["_meta"]["hardwareharness"]["operation"] == "devices.getDefinition"
    assert definition["annotations"] == {
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
    assert definition["inputSchema"]["required"] == ["hardwareId"]
    save = tools["testing_savePlan"]["annotations"]
    assert save["destructiveHint"] and save["idempotentHint"] and not save["readOnlyHint"]
    # Operations without profiles and the remote-call operations are never generated.
    assert "devices_removeComputer" not in tools and "devices_callTool" not in tools
    result = await registry.invoke(AGENT, "devices_getDefinition", {"hardwareId": "H"})
    assert result == {"ok": True, "data": {"hardwareId": "H"}}
    app.devices.get_definition.assert_called_once_with(AGENT, hardware_id="H")
    with pytest.raises(AppError) as invalid:
        await registry.invoke(AGENT, "devices_getDefinition", {})
    assert invalid.value.category == "invalid_argument"


async def test_remote_tools_run_through_the_devices_call_tool_middleware(tmp_path: Path) -> None:
    app = application()
    audit = AuditLog(tmp_path / "audit.jsonl")
    registry = ToolRegistry(app, operations=OperationRegistry(app, OPERATIONS, audit=audit))
    result = await registry.invoke(AGENT, "S1__pulse", {"width": 5})
    assert result == {"ok": True, "data": {"pulsed": True}}
    app.devices.call_tool.assert_awaited_once_with(AGENT, name="S1__pulse", args={"width": 5})
    [record] = [json.loads(line) for line in audit.path.read_text("utf-8").splitlines()]
    assert record["operation"] == "devices.callTool"
    assert record["actor"] == "agent"


def test_work_mode_query() -> None:
    assert _work_mode(b"") == ""
    assert _work_mode(b"mode=plan") == "plan"
    for query in [b"mode=bogus", b"mode=", b"mode=run&mode=plan", b"mode=run&x=1", b"x=1"]:
        assert _work_mode(query) is None


async def test_session_mode_comes_from_the_endpoint_query() -> None:
    app = application()
    gateway = LocalMcpGateway(
        app, Mock(ensure_token=AsyncMock(return_value="secret"), set=AsyncMock()), 0
    )
    headers = {
        "authorization": "Bearer secret",
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
    }
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1"},
        },
    }
    await gateway.start()
    try:
        async with httpx.AsyncClient(headers=headers) as client:
            url = gateway.status()["endpoint"]
            initialized = await client.post(url + "?mode=run", json=initialize)
            assert initialized.status_code == 200
            client.headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
            await client.post(url, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
            listed = await client.post(
                url, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
            )
            body = next(
                json.loads(line[6:])
                for line in listed.text.splitlines()
                if line.startswith("data: ")
            )
            tools = {tool["name"] for tool in body["result"]["tools"]}
            assert "start_test_run" in tools
            assert "S1__pulse" not in tools and "save_hardware_definition" not in tools
    finally:
        await gateway.stop()

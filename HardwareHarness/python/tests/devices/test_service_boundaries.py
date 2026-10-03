from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.devices import DeviceService


def service_fixture() -> tuple[DeviceService, dict[str, Any]]:
    server = {"serverId": "S", "hardwareId": "H"}
    store = Mock(
        get_server=Mock(return_value=server),
        list_servers=Mock(return_value=[server]),
        remove_server=AsyncMock(),
    )
    transport = Mock(
        connect=AsyncMock(return_value={}),
        disconnect=AsyncMock(),
        list_hardware=AsyncMock(return_value=[]),
        list_tools=Mock(return_value=[]),
        call_tool=AsyncMock(return_value={"value": 3}),
    )
    service = DeviceService(store, transport)
    return service, server


async def test_direct_tool_metadata_and_faulted_hardware_refresh() -> None:
    service, _ = service_fixture()
    transport: Any = service.transport
    hardware = {
        "hardwareId": "H",
        "serverId": "S",
        "state": "faulted",
        "lastError": {"message": "driver fault"},
    }
    transport.connect.return_value = {"hardware": hardware}
    assert (await service.refresh_server("S"))["transport"]["state"] == "online"
    assert service.list_availability()[0]["message"] == "driver fault"
    assert service.list_availability()[0]["state"] == "faulted"
    transport.list_tools.return_value = [
        {"externalName": "S__measure", "serverId": "S", "kind": "hardware"},
        {"externalName": "S__status", "serverId": "S", "kind": "service"},
    ]
    options: dict[str, Any] = {"timeoutMs": 500, "metadata": {"attempt": 2, "hardwareId": "WRONG"}}
    assert await service.call_tool("S__measure", {"channel": 1}, options) == {"value": 3}
    transport.call_tool.assert_awaited_with(
        "S__measure",
        {"channel": 1},
        {"timeoutMs": 500, "metadata": {"attempt": 2, "hardwareId": "H"}},
    )
    await service.call_tool("S__status", {})
    assert options["metadata"]["hardwareId"] == "WRONG"
    with pytest.raises(RuntimeError, match="Unknown aggregated"):
        await service.call_tool("missing", {})


SAFE = {"kind": "hardware", "operationSemantics": {"kind": "safe"}}
ACTUATE = {"kind": "hardware", "operationSemantics": {"kind": "actuate"}}


async def test_safe_all_calls_every_safe_tool_and_tolerates_failures() -> None:
    servers = [
        {"serverId": "A", "hardwareId": "HA", "enabled": True},
        {"serverId": "B", "hardwareId": "HB", "enabled": True},
    ]
    tools = [
        {"externalName": "A__a_safe_state", "serverId": "A", "contractMetadata": SAFE},
        {"externalName": "A__a_set", "serverId": "A", "contractMetadata": ACTUATE},
        {"externalName": "B__b_safe_state", "serverId": "B", "contractMetadata": SAFE},
    ]
    calls: list[str] = []

    async def call_tool(name: str, args: dict[str, Any], options: dict[str, Any]) -> Any:
        calls.append(name)
        if name.startswith("B__"):
            raise RuntimeError("offline")
        return {}

    store = Mock(
        get_server=lambda server_id: next(s for s in servers if s["serverId"] == server_id)
    )
    transport = Mock(list_tools=Mock(return_value=tools), call_tool=call_tool)
    await DeviceService(store, transport).safe_all()
    assert sorted(calls) == ["A__a_safe_state", "B__b_safe_state"]

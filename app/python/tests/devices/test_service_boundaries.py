from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from teststand_backend.devices import DeviceService


def service_fixture() -> tuple[DeviceService, dict[str, Any]]:
    instance = {"deviceId": "S", "hardwareId": "H"}
    store = Mock(
        get_device=Mock(return_value=instance),
        list_devices=Mock(return_value=[instance]),
        remove_device=AsyncMock(),
    )
    transport = Mock(
        connect=AsyncMock(return_value={}),
        disconnect=AsyncMock(),
        list_hardware=AsyncMock(return_value=[]),
        list_tools=Mock(return_value=[]),
        call_tool=AsyncMock(return_value={"value": 3}),
    )
    service = DeviceService(store, transport)
    return service, instance


async def test_direct_tool_metadata_and_faulted_hardware_refresh() -> None:
    service, _ = service_fixture()
    transport: Any = service.transport
    hardware = {
        "hardwareId": "H",
        "deviceId": "S",
        "state": "faulted",
        "lastError": {"message": "driver fault"},
    }
    transport.connect.return_value = {"hardware": hardware}
    assert (await service.refresh_device("S"))["transport"]["state"] == "online"
    assert service.list_availability()[0]["message"] == "driver fault"
    assert service.list_availability()[0]["state"] == "faulted"
    transport.list_tools.return_value = [
        {"externalName": "S__measure", "deviceId": "S", "kind": "hardware"},
        {"externalName": "S__status", "deviceId": "S", "kind": "service"},
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
    instances = [
        {"deviceId": "A", "hardwareId": "HA", "enabled": True},
        {"deviceId": "B", "hardwareId": "HB", "enabled": True},
    ]
    tools = [
        {"externalName": "A__a_safe_state", "deviceId": "A", "contractMetadata": SAFE},
        {"externalName": "A__a_set", "deviceId": "A", "contractMetadata": ACTUATE},
        {"externalName": "B__b_safe_state", "deviceId": "B", "contractMetadata": SAFE},
    ]
    calls: list[str] = []

    async def call_tool(name: str, args: dict[str, Any], options: dict[str, Any]) -> Any:
        calls.append(name)
        if name.startswith("B__"):
            raise RuntimeError("offline")
        return {}

    store = Mock(
        get_device=lambda device_id: next(s for s in instances if s["deviceId"] == device_id)
    )
    transport = Mock(list_tools=Mock(return_value=tools), call_tool=call_tool)
    await DeviceService(store, transport).safe_all()
    assert sorted(calls) == ["A__a_safe_state", "B__b_safe_state"]

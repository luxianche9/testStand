from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.devices import DeviceService, DeviceStore

SERVICE = "packages/devices/src/device-service.test.ts::"


def server(identifier: str = "PCI1710L_MCP") -> dict[str, Any]:
    return {
        "serverId": identifier,
        "label": identifier,
        "hardwareId": identifier + ".HARDWARE_0",
        "type": "pci1710l",
        "enabled": True,
    }


async def fixture(tmp_path: Path, broken: str) -> DeviceService:
    store = DeviceStore(tmp_path)
    await store.initialize()

    async def connect(target: dict[str, Any]) -> dict[str, Any]:
        if target["serverId"] == broken:
            raise RuntimeError("vendor SDK hung: " + broken)
        return {}

    pool = Mock(
        connect=AsyncMock(side_effect=connect),
        disconnect=AsyncMock(),
        list_tools=Mock(return_value=[]),
        list_hardware=AsyncMock(return_value=[]),
    )
    service = DeviceService(store, pool)
    for identifier in ["PCI1710L_MCP", "PCI1762_MCP", "PCI6208V_MCP"]:
        await service.save_server(server(identifier))
    return service


@pytest.mark.ts_case(SERVICE + "reports every server when one of them fails to connect")
async def test_server_isolation(tmp_path: Path) -> None:
    service = await fixture(tmp_path, "PCI1762_MCP")
    statuses = await service.refresh_all_servers()
    assert len(statuses) == 3
    assert (
        next(s for s in statuses if s["serverId"] == "PCI1762_MCP")["transport"]["state"]
        == "offline"
    )
    assert [s["serverId"] for s in statuses if s["transport"]["state"] == "online"] == [
        "PCI1710L_MCP",
        "PCI6208V_MCP",
    ]


@pytest.mark.ts_case(
    SERVICE + "keeps a failing server's error on its own status instead of throwing"
)
async def test_error_status(tmp_path: Path) -> None:
    status = await (await fixture(tmp_path, "PCI1762_MCP")).refresh_server("PCI1762_MCP")
    assert status["transport"]["state"] == "offline"
    assert "vendor SDK hung" in status["transport"]["message"]


@pytest.mark.ts_case(
    SERVICE + "resolves an unknown serverId into an error status rather than an exception"
)
async def test_unknown_server(tmp_path: Path) -> None:
    status = await (await fixture(tmp_path, "none")).refresh_server("NOT_REGISTERED")
    assert status["transport"]["state"] == "error"

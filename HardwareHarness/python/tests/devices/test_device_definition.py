"""A managed device's ``/device`` declaration: cached, read-only (§9.7)."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from hardwareharness_backend.devices import DeviceService, DeviceStore
from hardwareharness_backend.devices.device_manifest import (
    declared_streams,
    fetch_device,
    service_base_url,
)

HARDWARE = "PCI1710L_MCP.HARDWARE_0"


def declaration(revision: str = "sha256:1") -> dict[str, Any]:
    return {
        "manifestRevision": revision,
        "identity": {"serverId": "PCI1710L_MCP", "hardwareId": HARDWARE, "dryRun": False},
        "description": "Multifunction DAQ",
        "pinout": {
            "connectors": [
                {
                    "connectorId": "CN1",
                    "name": "CN1",
                    "connectorType": "SCSI-68",
                    "pinIds": ["CN1.1"],
                }
            ],
            "pins": [{"pinId": "CN1.1", "connectorId": "CN1", "position": 1, "functions": []}],
        },
        "streams": [{"id": "ai0", "type": "scalar", "unit": "V"}, {"id": "broken"}],
        "tools": [],
    }


def server() -> dict[str, Any]:
    return {
        "transport": "mcp-http",
        "serverId": "PCI1710L_MCP",
        "label": "PCI-1710L",
        "hardwareId": HARDWARE,
        "url": "http://127.0.0.1:8011/mcp",
        "enabled": True,
    }


def test_manifest_helpers() -> None:
    assert service_base_url("http://10.0.0.2:8011/mcp/") == "http://10.0.0.2:8011"
    document = declaration()
    assert declared_streams(document) == [{"id": "ai0", "type": "scalar", "unit": "V"}]


async def test_fetch_device_treats_404_as_an_older_service() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/device"
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        assert await fetch_device(http, "http://127.0.0.1:8011/mcp") is None


async def test_fetch_device_rejects_a_document_without_revision() -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"identity": {}}))
    ) as http:
        with pytest.raises(RuntimeError, match="not a device declaration"):
            await fetch_device(http, "http://127.0.0.1:8011/mcp")


async def test_store_keeps_the_definition(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path)
    await store.initialize()
    assert store.get_definition(HARDWARE) is None
    await store.save_definition(HARDWARE, declaration())
    cached = store.get_definition(HARDWARE)
    assert cached is not None and cached["document"]["manifestRevision"] == "sha256:1"

    await store.save_definition(HARDWARE, declaration("sha256:2"))
    replaced = store.get_definition(HARDWARE)
    assert replaced is not None and replaced["document"]["manifestRevision"] == "sha256:2"
    hardware_dir = tmp_path / "hardware" / HARDWARE
    assert not [item for item in hardware_dir.iterdir() if item.name.endswith(".tmp")]


async def service_with(
    tmp_path: Path, document: dict[str, Any] | None
) -> tuple[DeviceService, Mock]:
    store = DeviceStore(tmp_path)
    await store.initialize()
    transports = Mock(
        connect=AsyncMock(return_value={}),
        disconnect=AsyncMock(),
        list_tools=Mock(return_value=[]),
        list_hardware=AsyncMock(return_value=[]),
        describe_device=AsyncMock(return_value=document),
    )
    service = DeviceService(store, Mock(set=AsyncMock(), remove=AsyncMock()), transports)
    await service.save_server(server(), {"mcpToken": "token"})
    return service, transports


async def test_refresh_caches_the_declaration_once_per_revision(tmp_path: Path) -> None:
    service, transports = await service_with(tmp_path, declaration())
    await service.refresh_server("PCI1710L_MCP")
    definition = service.get_definition(HARDWARE)
    assert definition is not None and definition["offline"] is False
    assert definition["document"]["pinout"]["connectors"][0]["connectorId"] == "CN1"
    assert service.known_streams(HARDWARE) == [{"id": "ai0", "type": "scalar", "unit": "V"}]

    await service.refresh_server("PCI1710L_MCP")
    again = service.get_definition(HARDWARE)
    assert again is not None and again["fetchedAt"] == definition["fetchedAt"]

    transports.connect.side_effect = RuntimeError("offline")
    await service.refresh_server("PCI1710L_MCP")
    offline = service.get_definition(HARDWARE)
    assert offline is not None and offline["offline"] is True
    assert offline["manifestRevision"] == "sha256:1"


async def test_services_without_a_declaration_keep_no_definition(tmp_path: Path) -> None:
    service, _ = await service_with(tmp_path, None)
    await service.refresh_server("PCI1710L_MCP")
    assert service.get_definition(HARDWARE) is None

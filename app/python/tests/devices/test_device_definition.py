"""A managed device's ``/device`` declaration: cached, read-only (§9.7)."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

from teststand_backend.devices import DeviceService, DeviceStore
from teststand_backend.devices.plugin_transport import declared_streams

HARDWARE = "PCI1710L_MCP.HARDWARE_0"


def declaration(revision: str = "sha256:1") -> dict[str, Any]:
    return {
        "manifestRevision": revision,
        "identity": {"deviceId": "PCI1710L_MCP", "hardwareId": HARDWARE, "dryRun": False},
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


def instance() -> dict[str, Any]:
    return {
        "deviceId": "PCI1710L_MCP",
        "label": "PCI-1710L",
        "hardwareId": HARDWARE,
        "type": "pci1710l",
        "enabled": True,
    }


def test_declared_streams_keep_entries_with_id_and_type() -> None:
    assert declared_streams(declaration()) == [{"id": "ai0", "type": "scalar", "unit": "V"}]


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
    service = DeviceService(store, transports)
    await service.save_device(instance())
    return service, transports


async def test_refresh_caches_the_declaration_once_per_revision(tmp_path: Path) -> None:
    service, transports = await service_with(tmp_path, declaration())
    await service.refresh_device("PCI1710L_MCP")
    definition = service.get_definition(HARDWARE)
    assert definition is not None and definition["offline"] is False
    assert definition["document"]["pinout"]["connectors"][0]["connectorId"] == "CN1"
    assert service.known_streams(HARDWARE) == [{"id": "ai0", "type": "scalar", "unit": "V"}]

    await service.refresh_device("PCI1710L_MCP")
    again = service.get_definition(HARDWARE)
    assert again is not None and again["fetchedAt"] == definition["fetchedAt"]

    transports.connect.side_effect = RuntimeError("offline")
    await service.refresh_device("PCI1710L_MCP")
    offline = service.get_definition(HARDWARE)
    assert offline is not None and offline["offline"] is True
    assert offline["manifestRevision"] == "sha256:1"


async def test_services_without_a_declaration_keep_no_definition(tmp_path: Path) -> None:
    service, _ = await service_with(tmp_path, None)
    await service.refresh_device("PCI1710L_MCP")
    assert service.get_definition(HARDWARE) is None

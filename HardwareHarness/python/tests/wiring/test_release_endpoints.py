from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.devices import DeviceCatalogService, DeviceStore
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.storage import SettingsStore
from hardwareharness_backend.wiring import ProjectWiringService


def hardware(identifier: str, port_id: str) -> dict[str, Any]:
    return {
        "hardwareId": identifier,
        "label": identifier,
        "kind": "passive",
        "ports": [
            {
                "portId": port_id,
                "name": "Serial connector",
                "pins": [
                    {"pinId": "RX", "position": 1},
                    {"pinId": "TX", "position": 2},
                ],
            }
        ],
    }


async def test_alias_resolution_preserves_canonical_ids_and_rejects_ambiguity(
    tmp_path: Path,
) -> None:
    store = DeviceStore(tmp_path)
    await store.initialize()
    catalog = DeviceCatalogService(store)
    await catalog.save_hardware(hardware("CARD", "CARD.P1"))
    assert catalog.resolve_port("CARD.P1") == catalog.resolve_port("CARD.CARD.P1")
    await catalog.save_hardware(hardware("ONE", "J1"))
    assert catalog.resolve_port("J1") == catalog.resolve_port("ONE.J1")
    await catalog.save_hardware(hardware("TWO", "J1"))
    with pytest.raises(AppError) as ambiguous:
        catalog.resolve_port("J1")
    assert ambiguous.value.category == "conflict"
    assert set(ambiguous.value.details["candidates"]) == {"ONE.J1", "TWO.J1"}
    assert "endpointRef" in ambiguous.value.details["recovery"]
    assert catalog.resolve_port("ONE.J1")["hardware"]["hardwareId"] == "ONE"
    await catalog.remove_hardware("TWO")
    assert catalog.resolve_port("J1")["hardware"]["hardwareId"] == "ONE"


async def test_same_port_loopback_keeps_real_identity_and_persists_after_confirmation(
    tmp_path: Path,
) -> None:
    store = DeviceStore(tmp_path / "devices")
    await store.initialize()
    catalog = DeviceCatalogService(store)
    await catalog.save_hardware(hardware("CARD", "CARD.P1"))
    settings = SettingsStore(tmp_path / "settings.json")
    await settings.initialize()
    projects = ProjectService(settings)
    (tmp_path / "project").mkdir()
    await projects.initialize_folder(tmp_path / "project")
    service = ProjectWiringService(projects, catalog)
    task = await service.request_task(
        {
            "action": "connect",
            "portA": " CARD.P1 ",
            "portB": "CARD.CARD.P1",
            "pins": [{"a": "TX", "b": "RX"}],
        }
    )
    assert task["portA"] == task["portB"] == "CARD.CARD.P1"
    assert task["hardwareIds"] == ["CARD"]
    assert task["pins"] == [{"a": "RX", "b": "TX"}]
    assert projects.wiring()["connections"] == []
    with pytest.raises(AppError) as conflict:
        await service.request_task(
            {
                "action": "connect",
                "portA": "CARD.CARD.P1",
                "portB": "CARD.P1",
                "pins": [{"a": "RX", "b": "TX"}],
            }
        )
    assert conflict.value.details["existingTaskId"] == task["wiringTaskId"]
    completed = await service.complete_task(task["wiringTaskId"], "confirmed")
    assert completed["status"] == "confirmed"
    connection = projects.wiring()["connections"][0]
    assert connection["portA"] == connection["portB"] == "CARD.CARD.P1"
    service.clear_session()
    assert service.list_tasks() == []
    assert projects.wiring()["connections"][0] == connection
    await service.close()
    await projects.close()


@pytest.mark.parametrize(
    "pins",
    [
        [],
        [{"a": "RX", "b": "RX"}],
        [{"a": "RX", "b": "TX"}, {"a": "TX", "b": "RX"}],
        [{"a": "TX", "b": "missing"}],
    ],
)
async def test_same_port_rejects_invalid_and_reversed_duplicate_pins(
    tmp_path: Path,
    pins: list[dict[str, str]],
) -> None:
    store = DeviceStore(tmp_path / "devices")
    await store.initialize()
    catalog = DeviceCatalogService(store)
    await catalog.save_hardware(hardware("CARD", "CARD.P1"))
    settings = SettingsStore(tmp_path / "settings.json")
    await settings.initialize()
    projects = ProjectService(settings)
    (tmp_path / "project").mkdir()
    await projects.initialize_folder(tmp_path / "project")
    service = ProjectWiringService(projects, catalog)
    with pytest.raises(AppError) as invalid:
        await service.request_task(
            {
                "action": "connect",
                "portA": "CARD.P1",
                "portB": "CARD.P1",
                "pins": pins,
            }
        )
    assert invalid.value.category == "invalid_argument"
    assert service.list_tasks() == []
    assert projects.wiring()["connections"] == []
    await projects.close()

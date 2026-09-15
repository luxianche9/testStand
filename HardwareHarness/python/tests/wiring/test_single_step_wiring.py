import asyncio
from pathlib import Path

import pytest

from hardwareharness_backend.compat import Record, iso_from_ms
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.devices import DeviceCatalogService, DeviceStore
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.storage import SettingsStore
from hardwareharness_backend.wiring import ProjectWiringService


async def setup(root: Path) -> tuple[ProjectWiringService, ProjectService]:
    store = DeviceStore(root / "devices")
    await store.initialize()
    await store.save_hardware(
        {
            "formatVersion": 2,
            "hardwareId": "DUT",
            "label": "DUT",
            "kind": "passive",
            "ports": [
                {
                    "portId": "J1",
                    "name": "J1",
                    "pins": [
                        {"pinId": str(index), "position": index, "label": f"PIN {index}"}
                        for index in range(1, 5)
                    ],
                }
            ],
        }
    )
    settings = SettingsStore(root / "settings.json")
    await settings.initialize()
    projects = ProjectService(settings)
    (root / "project").mkdir()
    await projects.initialize_folder(root / "project")
    return ProjectWiringService(projects, DeviceCatalogService(store)), projects


async def test_direct_completion_saves_same_port_pins_and_history(tmp_path: Path) -> None:
    service, projects = await setup(tmp_path)
    events: list[Record] = []
    service.set_notifier(events.append)
    task = await service.request_task(
        {
            "portA": "DUT.J1",
            "portB": "DUT.J1",
            "action": "connect",
            "pins": [{"a": "2", "b": "1"}, {"a": "3", "b": "4"}],
        }
    )
    assert len(task["warnings"]) == 1
    assert projects.wiring()["connections"] == []
    result = await service.complete_task(task["wiringTaskId"], "confirmed")
    assert result["status"] == "confirmed"
    assert [event["status"] for event in events] == ["pending", "confirmed"]
    connection = projects.wiring()["connections"][0]
    assert connection["portA"] == connection["portB"] == "DUT.J1"
    assert connection["pins"] == [{"a": "1", "b": "2"}, {"a": "3", "b": "4"}]
    assert connection["confirmedBy"] == "operator"
    assert service.list_tasks()[0] == result
    await projects.save()
    await projects.open_folder(str(tmp_path / "project"))
    assert projects.wiring()["connections"][0] == connection
    disconnect = await service.request_task(
        {
            "portA": "DUT.J1",
            "portB": "DUT.J1",
            "action": "disconnect",
            "pins": task["pins"],
        }
    )
    await service.complete_task(disconnect["wiringTaskId"], "confirmed")
    assert projects.wiring()["connections"] == []


@pytest.mark.parametrize(
    "pins",
    [
        [],
        [{"a": "1", "b": "1"}],
        [{"a": "1", "b": "9"}],
        [{"a": "1", "b": "2"}, {"a": "2", "b": "1"}],
    ],
)
async def test_invalid_same_port_pins_rejected_in_tasks_and_document(
    tmp_path: Path, pins: list[Record]
) -> None:
    service, projects = await setup(tmp_path)
    with pytest.raises(AppError):
        await service.request_task(
            {
                "portA": "DUT.J1",
                "portB": "DUT.J1",
                "action": "connect",
                "pins": pins,
            }
        )
    with pytest.raises(AppError):
        service.validate_document_connections(
            {
                "nodes": [],
                "connections": [
                    {
                        "connectionId": "self",
                        "portA": "DUT.J1",
                        "portB": "DUT.J1",
                        "pins": pins,
                    }
                ],
            }
        )
    assert service.list_tasks() == []
    assert projects.wiring()["connections"] == []


async def test_completion_is_serialized_and_terminal_tasks_cannot_be_confirmed(
    tmp_path: Path,
) -> None:
    service, projects = await setup(tmp_path)
    task = await service.request_task(
        {
            "portA": "DUT.J1",
            "portB": "DUT.J1",
            "action": "connect",
            "pins": [{"a": "1", "b": "2"}],
        }
    )
    outcomes = await asyncio.gather(
        service.complete_task(task["wiringTaskId"], "confirmed"),
        service.complete_task(task["wiringTaskId"], "confirmed"),
        return_exceptions=True,
    )
    assert sum(isinstance(outcome, AppError) for outcome in outcomes) == 1
    assert len(projects.wiring()["connections"]) == 1


async def test_expired_task_cannot_update_wiring(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = "hardwareharness_backend.wiring.project_wiring_service"
    monkeypatch.setattr(module + ".now_ms", lambda: 1000)
    service, projects = await setup(tmp_path)
    task = await service.request_task(
        {
            "portA": "DUT.J1",
            "portB": "DUT.J1",
            "action": "connect",
            "pins": [{"a": "1", "b": "2"}],
            "timeoutMs": 1000,
        }
    )
    assert task["expiresAt"] == iso_from_ms(2000)
    monkeypatch.setattr(module + ".now_ms", lambda: 2000)
    with pytest.raises(AppError, match="timed_out"):
        await service.complete_task(task["wiringTaskId"], "confirmed")
    assert projects.wiring()["connections"] == []


async def test_pending_task_can_be_rejected_without_starting(tmp_path: Path) -> None:
    service, projects = await setup(tmp_path)
    task = await service.request_task(
        {
            "portA": "DUT.J1",
            "portB": "DUT.J1",
            "action": "connect",
            "pins": [{"a": "1", "b": "2"}],
        }
    )
    result = await service.complete_task(task["wiringTaskId"], "rejected", "Cannot connect")
    assert result["status"] == "rejected"
    assert result["message"] == "Cannot connect"
    assert projects.wiring()["connections"] == []

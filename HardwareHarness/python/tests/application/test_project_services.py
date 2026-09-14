from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.devices import DeviceCatalogService, DeviceStore
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.storage import SettingsStore
from hardwareharness_backend.wiring import ProjectWiringService

Json = dict[str, Any]


async def fixture(root: Path) -> tuple[ProjectService, ProjectWiringService, Path]:
    settings = SettingsStore(str(root / "settings.json"))
    await settings.initialize()
    projects = ProjectService(settings)
    await projects.initialize()
    project_root = root / "project"
    project_root.mkdir()
    await projects.initialize_folder(str(project_root))
    store = DeviceStore(str(root / "devices"))
    await store.initialize()
    catalog = DeviceCatalogService(store)
    for hardware_id in ["DUT_A", "DUT_B"]:
        await catalog.save_hardware(
            {
                "formatVersion": 2,
                "hardwareId": hardware_id,
                "label": hardware_id,
                "kind": "passive",
                "ports": [
                    {
                        "portId": "J1",
                        "name": "J1",
                        "pins": [
                            {"pinId": "1", "position": 1, "label": "A"},
                            {"pinId": "2", "position": 2, "label": "B"},
                        ],
                    },
                    {"portId": "FIBER", "name": "光纤口", "pins": []},
                ],
            }
        )
    wiring = ProjectWiringService(projects, catalog)
    await wiring.initialize()
    return projects, wiring, project_root


@pytest.mark.ts_case(
    "packages/application/src/project-services.test.ts::keeps the wiring canvas "
    "documentary while the operator processes a task"
)
async def test_documentary_canvas(tmp_path: Path) -> None:
    projects, wiring, _ = await fixture(tmp_path)
    projects.update_wiring(
        {
            "nodes": [
                {"hardwareId": "DUT_A", "x": 10, "y": 20, "showImage": True, "portPositions": {}}
            ],
            "connections": [],
        }
    )
    pins = [{"a": "1", "b": "1"}, {"a": "2", "b": "2"}]
    task = await wiring.request_task(
        {"portA": "DUT_A.J1", "portB": "DUT_B.J1", "pins": pins, "action": "connect"}
    )
    assert task["status"] == "pending" and len(task["warnings"]) > 0
    assert (await wiring.start_task(task["wiringTaskId"], "tester"))["status"] == "in_progress"
    assert (await wiring.complete_task(task["wiringTaskId"], "confirmed"))["status"] == "confirmed"
    assert (
        len(projects.wiring()["connections"]) == 1
        and projects.wiring()["connections"][0]["pins"] == pins
    )
    assert projects.document()["dirty"] is True
    await projects.close()


@pytest.mark.ts_case(
    "packages/application/src/project-services.test.ts::records a pinless "
    "connection for connectors that have no pins"
)
async def test_pinless(tmp_path: Path) -> None:
    projects, wiring, _ = await fixture(tmp_path)
    task = await wiring.request_task(
        {"portA": "DUT_A.FIBER", "portB": "DUT_B.FIBER", "action": "connect"}
    )
    await wiring.start_task(task["wiringTaskId"], "tester")
    await wiring.complete_task(task["wiringTaskId"], "confirmed")
    assert (
        len(projects.wiring()["connections"]) == 1
        and projects.wiring()["connections"][0]["pins"] == []
    )
    await projects.close()


@pytest.mark.ts_case(
    "packages/application/src/project-services.test.ts::normalises port order so "
    "one cable cannot be requested twice under swapped ends"
)
async def test_swapped_ports(tmp_path: Path) -> None:
    projects, wiring, _ = await fixture(tmp_path)
    first = await wiring.request_task(
        {
            "portA": "DUT_B.J1",
            "portB": "DUT_A.J1",
            "pins": [{"a": "1", "b": "2"}],
            "action": "connect",
        }
    )
    assert first["portA"] == "DUT_A.J1" and first["pins"] == [{"a": "2", "b": "1"}]
    with pytest.raises(Exception, match="already exists"):
        await wiring.request_task({"portA": "DUT_A.J1", "portB": "DUT_B.J1", "action": "connect"})
    await projects.close()


@pytest.mark.ts_case(
    "packages/application/src/project-services.test.ts::refuses pin pairs that "
    "name a pin the port does not have"
)
async def test_invalid_pin(tmp_path: Path) -> None:
    projects, wiring, _ = await fixture(tmp_path)
    with pytest.raises(Exception, match="has no pin 9"):
        await wiring.request_task(
            {
                "portA": "DUT_A.J1",
                "portB": "DUT_B.J1",
                "pins": [{"a": "9", "b": "1"}],
                "action": "connect",
            }
        )
    await projects.close()

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.devices import DeviceCatalogService, DeviceStore
from hardwareharness_backend.orchestration import set_workflow_path, validate_test_task
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


@pytest.mark.ts_case(
    "packages/application/src/project-services.test.ts::round-trips one folder "
    "project with wiring and one task"
)
async def test_project_roundtrip(tmp_path: Path) -> None:
    projects, _, project_root = await fixture(tmp_path)
    projects.update_wiring(
        {
            "nodes": [
                {"hardwareId": "DUT_A", "x": 1, "y": 2, "showImage": True, "portPositions": {}}
            ],
            "connections": [],
        }
    )
    projects.update_task(
        {
            "formatVersion": 2,
            "taskId": "TASK_A",
            "name": "Voltage",
            "inputs": [],
            "variables": [],
            "setup": [],
            "steps": [],
            "cleanup": [],
        }
    )
    await projects.save()
    assert projects.document()["dirty"] is False
    other_root = tmp_path / "other"
    other_root.mkdir()
    await projects.initialize_folder(str(other_root))
    assert projects.wiring()["nodes"] == []
    await projects.open_folder(str(project_root))
    assert (
        projects.wiring()["nodes"][0]["hardwareId"] == "DUT_A"
        and projects.task()["taskId"] == "TASK_A"
    )
    await projects.close()


@pytest.mark.ts_case(
    "packages/application/src/project-services.test.ts::rejects prototype paths "
    "and parallel shared writes"
)
def test_prototype_and_parallel_writes() -> None:
    with pytest.raises(Exception, match="Unsafe"):
        set_workflow_path({}, "__proto__.polluted", True)
    context = {"declared": 0}
    with pytest.raises(Exception, match="top-level"):
        set_workflow_path(context, "declared.child", True)
    with pytest.raises(Exception, match="Unknown"):
        set_workflow_path(context, "misspelled", True)
    set_workflow_path(context, "declared", 1)
    assert context["declared"] == 1 and "polluted" not in {}
    task: Json = {
        "formatVersion": 2,
        "taskId": "TASK",
        "name": "Task",
        "inputs": [],
        "variables": [{"name": "result", "type": "number", "defaultValue": 0}],
        "setup": [],
        "cleanup": [],
        "steps": [
            {
                "stepId": "P",
                "label": "Parallel",
                "enabled": True,
                "type": "parallel",
                "branches": [
                    {
                        "branchId": "A",
                        "name": "A",
                        "steps": [
                            {
                                "stepId": "WRITE",
                                "label": "Write",
                                "enabled": True,
                                "type": "set_variable",
                                "variable": "result",
                                "value": {"kind": "literal", "value": 1},
                            }
                        ],
                    },
                    {"branchId": "B", "name": "B", "steps": []},
                ],
            }
        ],
    }
    assert any(
        issue["code"] == "parallel_shared_write" for issue in validate_test_task(task)["issues"]
    )


@pytest.mark.ts_case(
    "packages/application/src/project-services.test.ts::keeps inputs read-only "
    "and validates statically known assignment types"
)
def test_readonly_inputs_types() -> None:
    task: Json = {
        "formatVersion": 2,
        "taskId": "TYPES",
        "name": "Types",
        "inputs": [{"name": "input", "type": "number"}],
        "variables": [{"name": "result", "type": "number"}],
        "setup": [],
        "cleanup": [],
        "steps": [
            {
                "stepId": "INPUT_WRITE",
                "label": "Input write",
                "enabled": True,
                "type": "set_variable",
                "variable": "input",
                "value": {"kind": "literal", "value": 1},
            },
            {
                "stepId": "BAD_TYPE",
                "label": "Bad type",
                "enabled": True,
                "type": "set_variable",
                "variable": "result",
                "value": {"kind": "literal", "value": "wrong"},
            },
        ],
    }
    issues = validate_test_task(task)["issues"]
    assert any(
        issue.get("nodeId") == "INPUT_WRITE" and issue["code"] == "undeclared_variable"
        for issue in issues
    )
    assert any(
        issue.get("nodeId") == "BAD_TYPE" and issue["code"] == "variable_type" for issue in issues
    )

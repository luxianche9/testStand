import asyncio
from pathlib import Path
from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.projects import ProjectService
from teststand_backend.storage import SettingsStore
from teststand_backend.wiring import ProjectWiringService

PREFIX = "packages/wiring/src/project-wiring-agent.test.ts::Agent canvas permissions::"
APP_PREFIX = "packages/application/src/project-services.test.ts::project-oriented services::"


class Catalog:
    def get_hardware(self, hardware_id: str) -> dict[str, Any]:
        if hardware_id not in ("CARD_A", "DUT_A", "DUT_B"):
            raise RuntimeError(f"Unknown hardwareId: {hardware_id}")
        return {
            "hardwareId": hardware_id,
            "kind": "managed" if hardware_id == "CARD_A" else "passive",
            "ports": [
                {"portId": "P1", "pins": [{"pinId": "1"}, {"pinId": "2"}]},
                {"portId": "P2", "pins": []},
            ],
        }

    def resolve_port(self, ref: str) -> dict[str, Any]:
        hardware_id, port_id = ref.split(".")
        hardware = self.get_hardware(hardware_id)
        return {
            "hardware": hardware,
            "port": next(port for port in hardware["ports"] if port["portId"] == port_id),
        }

    def validate_pins(self, port_a: str, port_b: str, pins: list[dict[str, Any]]) -> None:
        for pair in pins:
            for ref, side in ((port_a, "a"), (port_b, "b")):
                if pair[side] not in [
                    pin["pinId"] for pin in self.resolve_port(ref)["port"]["pins"]
                ]:
                    raise RuntimeError(f"Port {ref} has no pin {pair[side]}")

    def warnings_for_ports(self, port_a: str, port_b: str) -> list[str]:
        return [f"Missing image: {port_a}", f"Missing image: {port_b}"]


async def fixture(root: Path) -> tuple[ProjectWiringService, ProjectService, list[bool]]:
    settings = SettingsStore(root / "settings.json")
    await settings.initialize()
    projects = ProjectService(settings)
    await projects.initialize_folder(root)
    projects.update_wiring(
        {
            "connections": [
                {
                    "connectionId": "C1",
                    "portA": "DUT_A.P1",
                    "portB": "DUT_B.P1",
                    "pins": [],
                    "confirmedAt": "2026-08-07T00:00:00.000Z",
                    "confirmedBy": "operator",
                }
            ],
        }
    )
    service = ProjectWiringService(projects, Catalog())
    notifications: list[bool] = []
    service.set_project_notifier(lambda: notifications.append(True))
    return service, projects, notifications


@pytest.mark.ts_case(
    APP_PREFIX + "keeps the wiring canvas documentary while the operator processes a task"
)
@pytest.mark.asyncio
async def test_task_cable(tmp_path: Path) -> None:
    service, projects, _ = await fixture(tmp_path)
    projects.update_wiring({"connections": []})
    pins = [{"a": "1", "b": "1"}, {"a": "2", "b": "2"}]
    task = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "pins": pins, "action": "connect"}
    )
    assert task["status"] == "pending"
    assert projects.wiring()["connections"] == []
    done = await service.complete_task(task["wiringTaskId"], "confirmed", operator_name="tester")
    assert done["status"] == "confirmed"
    assert len(projects.wiring()["connections"]) == 1
    assert projects.wiring()["connections"][0]["pins"] == pins
    assert projects.wiring()["connections"][0]["confirmedBy"] == "tester"
    # A confirmed task is saved: the wiring is what the operator confirmed on the bench.
    assert projects.document()["dirty"] is False
    [entry] = service.list_changes()
    assert entry["kind"] == "added"
    assert entry["wiringTaskId"] == task["wiringTaskId"]
    await projects.close()


@pytest.mark.ts_case(APP_PREFIX + "records a pinless connection for connectors that have no pins")
@pytest.mark.asyncio
async def test_pinless(tmp_path: Path) -> None:
    service, projects, _ = await fixture(tmp_path)
    projects.update_wiring({"connections": []})
    task = await service.request_task(
        {"portA": "DUT_A.P2", "portB": "DUT_B.P2", "action": "connect"}
    )
    await service.complete_task(task["wiringTaskId"], "confirmed")
    assert len(projects.wiring()["connections"]) == 1
    assert projects.wiring()["connections"][0]["pins"] == []


@pytest.mark.ts_case(
    APP_PREFIX + "normalises port order so one cable cannot be requested twice under swapped ends"
)
@pytest.mark.asyncio
async def test_canonical(tmp_path: Path) -> None:
    service, _, _ = await fixture(tmp_path)
    task = await service.request_task(
        {
            "portA": "DUT_B.P1",
            "portB": "DUT_A.P1",
            "pins": [{"a": "1", "b": "2"}],
            "action": "connect",
        }
    )
    [change] = task["changes"]
    assert change["portA"] == "DUT_A.P1"
    assert change["pins"] == [{"a": "2", "b": "1"}]
    with pytest.raises(AppError, match="already changes this port pair") as raised:
        await service.request_task({"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect"})
    assert raised.value.details["existingTaskId"] == task["wiringTaskId"]


@pytest.mark.ts_case(APP_PREFIX + "refuses pin pairs that name a pin the port does not have")
@pytest.mark.asyncio
async def test_invalid_pin(tmp_path: Path) -> None:
    service, _, _ = await fixture(tmp_path)
    with pytest.raises(RuntimeError, match="has no pin 9"):
        await service.request_task(
            {
                "portA": "DUT_A.P1",
                "portB": "DUT_B.P1",
                "pins": [{"a": "9", "b": "1"}],
                "action": "connect",
            }
        )


@pytest.mark.asyncio
async def test_batch_is_answered_once(tmp_path: Path) -> None:
    service, projects, notifications = await fixture(tmp_path)
    changes: list[dict[str, Any]] = [
        {"action": "connect", "portA": "CARD_A.P1", "portB": "DUT_A.P1", "pins": []},
        {"action": "connect", "portA": "DUT_A.P2", "portB": "DUT_B.P2"},
    ]
    task = await service.request_task({"changes": changes, "replaceAll": True, "note": "why"})
    # replaceAll disconnects the saved connection the batch does not name.
    assert [(item["action"], item["portA"]) for item in task["changes"]] == [
        ("connect", "CARD_A.P1"),
        ("connect", "DUT_A.P2"),
        ("disconnect", "DUT_A.P1"),
    ]
    assert task["hardwareIds"] == ["CARD_A", "DUT_A", "DUT_B"]
    assert task["note"] == "why"
    await service.complete_task(task["wiringTaskId"], "confirmed")
    pairs = sorted((item["portA"], item["portB"]) for item in projects.wiring()["connections"])
    assert pairs == [("CARD_A.P1", "DUT_A.P1"), ("DUT_A.P2", "DUT_B.P2")]
    assert sorted(entry["kind"] for entry in service.list_changes()) == [
        "added",
        "added",
        "removed",
    ]
    assert notifications == [True]
    with pytest.raises(AppError, match="at least one change"):
        await service.request_task({"changes": []})
    with pytest.raises(AppError, match="once in one request"):
        await service.request_task(
            {"changes": [changes[1], {**changes[1], "action": "disconnect"}]}
        )


@pytest.mark.asyncio
async def test_wait_for_answer(tmp_path: Path) -> None:
    service, _, _ = await fixture(tmp_path)
    task = await service.request_task(
        {"portA": "DUT_A.P2", "portB": "DUT_B.P2", "action": "connect"}
    )
    waiting = asyncio.create_task(service.wait_for_answer(task["wiringTaskId"]))
    await asyncio.sleep(0)
    assert not waiting.done()
    await service.complete_task(task["wiringTaskId"], "rejected", "wrong cable")
    answered = await asyncio.wait_for(waiting, 1)
    assert (answered["status"], answered["message"]) == ("rejected", "wrong cable")
    assert (await service.wait_for_answer(task["wiringTaskId"]))["status"] == "rejected"
    with pytest.raises(AppError, match="not pending"):
        await service.complete_task(task["wiringTaskId"], "confirmed")


@pytest.mark.asyncio
async def test_finish_failure_rejection_disconnect_shutdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, projects, notifications = await fixture(tmp_path)
    task = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "disconnect"}
    )
    await service.complete_task(task["wiringTaskId"], "confirmed")
    assert projects.wiring()["connections"] == []
    assert len(notifications) == 1
    rejected = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect"}
    )
    await service.complete_task(rejected["wiringTaskId"], "rejected", "no")
    assert projects.wiring()["connections"] == []
    failed = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect"}
    )

    def fail_update(wiring: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("diskless state failed")

    monkeypatch.setattr(projects, "update_wiring", fail_update)
    result = await service.complete_task(failed["wiringTaskId"], "confirmed")
    assert result["status"] == "failed"
    assert result["message"] == "Failed to update wiring: diskless state failed"
    monkeypatch.undo()
    pending = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect"}
    )
    await service.close()
    assert service.get_task(pending["wiringTaskId"])["status"] == "pending"

    # Nobody waits for a pending task of an earlier session any more.
    restored = ProjectWiringService(projects, service.catalog)
    await restored.initialize()
    cancelled = restored.get_task(pending["wiringTaskId"])
    assert cancelled["status"] == "cancelled"
    assert cancelled["message"] == "testStand restarted before the operator answered"
    assert restored.get_task(task["wiringTaskId"])["status"] == "confirmed"
    service.clear_session()
    assert service.list_tasks() == []

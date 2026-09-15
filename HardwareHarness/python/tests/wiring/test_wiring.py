from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.compat import clone, iso_from_ms
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.storage import SettingsStore
from hardwareharness_backend.wiring import ProjectWiringService

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
            "nodes": [
                {"hardwareId": "DUT_A", "x": 10, "y": 20, "showImage": True, "portPositions": {}}
            ],
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


@pytest.mark.ts_case(PREFIX + "adds a managed node without changing physical connections")
@pytest.mark.asyncio
async def test_canvas(tmp_path: Path) -> None:
    service, projects, notifications = await fixture(tmp_path)
    before = clone(projects.wiring()["connections"])
    added = await service.add_managed_hardware_to_canvas("CARD_A")
    assert added["added"] is True and added["dirty"] is True
    assert added["node"]["x"] == 410 and added["node"]["y"] == 80
    assert added["node"]["portPositions"] == {
        "P1": {"side": "left", "offset": 0.5},
        "P2": {"side": "right", "offset": 0.5},
    }
    assert projects.wiring()["connections"] == before
    assert len(notifications) == 1


@pytest.mark.ts_case(PREFIX + "is idempotent and refuses passive hardware")
@pytest.mark.asyncio
async def test_canvas_idempotence(tmp_path: Path) -> None:
    service, projects, notifications = await fixture(tmp_path)
    first = await service.add_managed_hardware_to_canvas("CARD_A")
    assert await service.add_managed_hardware_to_canvas("CARD_A") == {
        "added": False,
        "dirty": True,
        "node": first["node"],
    }
    assert sum(node["hardwareId"] == "CARD_A" for node in projects.wiring()["nodes"]) == 1
    assert len(notifications) == 1
    with pytest.raises(AppError) as error:
        await service.add_managed_hardware_to_canvas("DUT_A")
    assert error.value.category == "permission_denied"


@pytest.mark.ts_case(
    APP_PREFIX + "keeps the wiring canvas documentary while the operator processes a task"
)
@pytest.mark.asyncio
async def test_task_cable(tmp_path: Path) -> None:
    service, projects, _ = await fixture(tmp_path)
    projects.update_wiring({"nodes": [], "connections": []})
    pins = [{"a": "1", "b": "1"}, {"a": "2", "b": "2"}]
    task = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "pins": pins, "action": "connect"}
    )
    assert task["status"] == "pending" and task["warnings"]
    assert (await service.start_task(task["wiringTaskId"], "tester"))["status"] == "in_progress"
    assert (await service.complete_task(task["wiringTaskId"], "confirmed"))["status"] == "confirmed"
    assert len(projects.wiring()["connections"]) == 1
    assert projects.wiring()["connections"][0]["pins"] == pins
    assert projects.document()["dirty"] is True
    await projects.close()


@pytest.mark.ts_case(APP_PREFIX + "records a pinless connection for connectors that have no pins")
@pytest.mark.asyncio
async def test_pinless(tmp_path: Path) -> None:
    service, projects, _ = await fixture(tmp_path)
    projects.update_wiring({"nodes": [], "connections": []})
    task = await service.request_task(
        {"portA": "DUT_A.P2", "portB": "DUT_B.P2", "action": "connect"}
    )
    await service.start_task(task["wiringTaskId"], "tester")
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
    assert task["portA"] == "DUT_A.P1"
    assert task["pins"] == [{"a": "2", "b": "1"}]
    with pytest.raises(AppError, match="already exists"):
        await service.request_task({"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect"})


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
async def test_lazy_timeout_only_pending(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from hardwareharness_backend.wiring import project_wiring_service as implementation

    clock = [1000]
    monkeypatch.setattr(implementation, "now_ms", lambda: clock[0])
    monkeypatch.setattr(implementation, "utc_now_iso", lambda: iso_from_ms(clock[0]))
    service, _, _ = await fixture(tmp_path)
    notifications: list[dict[str, Any]] = []
    service.set_notifier(notifications.append)
    task = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect", "timeoutMs": 1}
    )
    assert task["expiresAt"] == iso_from_ms(2000)
    clock[0] = 2000
    with pytest.raises(AppError, match="already exists"):
        await service.request_task(
            {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "disconnect"}
        )
    assert service.get_task(task["wiringTaskId"])["status"] == "timed_out"
    assert [item["status"] for item in notifications] == ["pending", "timed_out"]
    await service.cancel_task(task["wiringTaskId"])
    assert len(notifications) == 2
    task = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect", "timeoutMs": 1000}
    )
    started = await service.start_task(task["wiringTaskId"], " ")
    assert started["operatorName"] == "operator"
    clock[0] = 10_000
    assert service.get_task(task["wiringTaskId"])["status"] == "in_progress"
    assert (await service.complete_task(task["wiringTaskId"], "confirmed"))["status"] == "confirmed"


@pytest.mark.asyncio
async def test_finish_failure_rejection_disconnect_shutdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, projects, notifications = await fixture(tmp_path)
    task = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "disconnect"}
    )
    await service.start_task(task["wiringTaskId"], "tester")
    await service.complete_task(task["wiringTaskId"], "confirmed")
    assert projects.wiring()["connections"] == []
    assert len(notifications) == 1
    rejected = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect"}
    )
    await service.start_task(rejected["wiringTaskId"])
    await service.complete_task(rejected["wiringTaskId"], "rejected", "no")
    assert projects.wiring()["connections"] == []
    failed = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect"}
    )
    await service.start_task(failed["wiringTaskId"])

    def fail_update(wiring: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("diskless state failed")

    monkeypatch.setattr(projects, "update_wiring", fail_update)
    result = await service.complete_task(failed["wiringTaskId"], "confirmed")
    assert result["status"] == "failed"
    assert result["message"] == "Failed to update wiring: diskless state failed"
    pending = await service.request_task(
        {"portA": "DUT_A.P1", "portB": "DUT_B.P1", "action": "connect"}
    )
    active = await service.request_task(
        {"portA": "DUT_A.P2", "portB": "DUT_B.P2", "action": "connect"}
    )
    await service.start_task(active["wiringTaskId"])
    await service.close()
    assert service.get_task(pending["wiringTaskId"])["status"] == "pending"
    assert service.get_task(active["wiringTaskId"])["message"] == "Application shutdown"
    service.clear_session()
    assert service.list_tasks() == []

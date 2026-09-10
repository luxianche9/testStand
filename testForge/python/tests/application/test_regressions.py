from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from testforge_backend.application import (
    AGENT_REQUEST_CONTEXT as AGENT,
)
from testforge_backend.application import (
    HUMAN_REQUEST_CONTEXT as HUMAN,
)
from testforge_backend.application import (
    SYSTEM_REQUEST_CONTEXT,
    DefaultAuthorizer,
    DevicesApplication,
    ExecutionCoordinator,
    OrchestrationApplication,
    ProjectsApplication,
    SystemApplication,
    WiringApplication,
    control,
)
from testforge_backend.contracts.agents import CAPABILITIES
from testforge_backend.orchestration.cancellation import AbortError

from .test_application import HARDWARE, invocation, manual_fixture, occupancy_fixture

Json = dict[str, Any]


@pytest.mark.parametrize("operation", ["get", "acquire", "reject", "reconcile"])
async def test_expired_occupancy_never_confirms(
    operation: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    application, held, acquired, _ = occupancy_fixture()
    now = 1000000
    monkeypatch.setattr(control, "now_ms", lambda: now)
    notifications: list[str] = []
    application.set_notifier(lambda request: notifications.append(request["status"]))
    request = application.request(AGENT, {"hardwareIds": ["H2"], "timeoutMs": 1000})
    request_id = request["occupancyRequestId"]
    now += 1000
    if operation == "get":
        assert application.get_request(HUMAN, request_id)["status"] == "timed_out"
    elif operation == "acquire":
        with pytest.raises(Exception, match="timed_out, not pending"):
            await application.acquire_request(HUMAN, request_id)
    elif operation == "reject":
        with pytest.raises(Exception, match="timed_out, not pending"):
            application.reject_request(HUMAN, request_id)
    else:
        application.reconcile([{"hardwareId": "H2", "state": "occupied_by_self"}])
    assert application.get_request(HUMAN, request_id)["status"] == "timed_out"
    assert acquired == [] and held == {"H1"}
    assert notifications == ["pending", "timed_out"]


async def test_occupancy_request_lifecycle_and_facade(monkeypatch: pytest.MonkeyPatch) -> None:
    application, held, _, released = occupancy_fixture()
    monkeypatch.setattr(application.devices.occupancy, "list", Mock(return_value=[]))
    monkeypatch.setattr(application.devices.occupancy, "refresh_all", AsyncMock(return_value=[]))
    assert application.list(HUMAN) == []
    assert await application.refresh(HUMAN) == []
    assert (await application.acquire(HUMAN, "H2"))["state"] == "occupied_by_self"
    assert (await application.release(HUMAN, "H2"))["state"] == "unoccupied"
    assert "H2" not in held and released == ["H2"]
    request = application.request(
        HUMAN, {"hardwareIds": ["H2", "H2"], "reason": "  reason  ", "requestedBy": "explicit"}
    )
    assert request["reason"] == "reason" and request["requestedBy"] == "explicit"
    assert request["hardwareIds"] == ["H2"]
    assert len(application.list_requests(HUMAN, {"status": "pending", "limit": 1})) == 1
    cancelled = application.cancel_request(AGENT, request["occupancyRequestId"], "cancel")
    assert cancelled["status"] == "cancelled"
    assert application.cancel_request(AGENT, request["occupancyRequestId"]) == cancelled
    rejected = application.request(AGENT, {"hardwareIds": ["H3"]})
    assert (
        application.reject_request(HUMAN, rejected["occupancyRequestId"], "no")["status"]
        == "rejected"
    )
    confirmed = application.request(AGENT, {"hardwareIds": ["H1"]})
    application.reconcile([{"hardwareId": "H1", "state": "occupied_by_self"}])
    assert application.get_request(HUMAN, confirmed["occupancyRequestId"])["status"] == "confirmed"
    with pytest.raises(Exception, match="Unknown managed hardware"):
        application.request(AGENT, {"hardwareIds": ["missing"]})
    with pytest.raises(Exception, match="Unknown occupancy request"):
        application.get_request(HUMAN, "missing")


async def test_manual_hardware_abort_is_scoped() -> None:
    async def call(name: str, args: Json, options: Json) -> None:
        await options["signal"].wait()
        raise options["signal"].reason

    manual, execution, _ = manual_fixture(call=AsyncMock(side_effect=call))
    pending = asyncio.create_task(manual.invoke_tool(HUMAN, invocation()))
    await asyncio.sleep(0)
    await manual.abort_hardware("OTHER", "other")
    assert not pending.done()
    await manual.abort_hardware("HW1", "lease lost")
    with pytest.raises(AbortError, match="lease lost"):
        await pending
    assert execution.current()["state"] == "idle"


async def test_device_application_crud_and_binary_boundaries() -> None:
    computer: Json = {
        "id": "PC1",
        "label": "Lab",
        "address": "10.0.0.2",
        "ssh": {"port": 22, "username": "u", "shell": "powershell"},
    }
    server: Json = {
        "serverId": "S",
        "computerId": "PC1",
        "hardwareId": "H1",
        "label": "S",
        "enabled": True,
        "endpoint": {"url": "http://localhost:8001/mcp"},
        "process": {"kind": "external"},
    }
    # Valid server details are parsed in contracts tests; these adapters must preserve call data.
    devices = Mock()
    for name in [
        "remove_computer",
        "remove_server",
        "refresh_computer",
        "execute",
        "refresh_all_servers",
        "save_server",
        "refresh_server",
        "server_action",
        "read_server_logs",
        "refresh_hardware",
    ]:
        setattr(devices, name, AsyncMock(return_value={"result": name}))
    devices.list_computers.return_value = [computer]
    devices.list_servers.return_value = [
        server,
        {**server, "serverId": "OTHER", "computerId": "PC2"},
    ]
    devices.list_tools.return_value = [{"externalName": "S__tool"}]
    devices.refresh_hardware.return_value = [{"result": "refresh_hardware"}]
    devices.store = Mock(
        put_image_bytes=AsyncMock(return_value={"assetId": "bytes"}),
        put_image=AsyncMock(return_value={"assetId": "path"}),
        remove_image=AsyncMock(return_value={"removed": True}),
        export_bundle=AsyncMock(return_value=b"zip"),
        import_bundle=AsyncMock(return_value={"hardwareId": "H1"}),
        inspect_bundle=AsyncMock(return_value={"hardwareId": "H1"}),
    )
    catalog = Mock(
        list_hardware=Mock(return_value=[HARDWARE]),
        get_hardware=Mock(return_value=HARDWARE),
        save_hardware=AsyncMock(side_effect=lambda hardware: hardware),
        remove_hardware=AsyncMock(),
    )
    app = DevicesApplication(DefaultAuthorizer(), devices, catalog)
    assert app.list_computers(HUMAN) == [computer]
    assert await app.remove_computer(HUMAN, "PC1") == {"computerId": "PC1"}
    status = await app.get_computer_status(HUMAN, "PC1")
    assert status["result"] == "refresh_computer" and status["servers"] == [
        {"result": "refresh_server"}
    ]
    devices.refresh_server.assert_awaited_once_with("S")
    await app.execute_ssh(HUMAN, "PC1", "whoami")
    devices.execute.assert_awaited_with("PC1", "whoami")
    await app.execute_ssh(HUMAN, "PC1", "whoami", 100)
    devices.execute.assert_awaited_with("PC1", "whoami", 100)
    assert len(app.list_servers(HUMAN)) == 2
    assert (await app.list_servers_with_status(HUMAN))["statuses"] == {
        "result": "refresh_all_servers"
    }
    assert await app.remove_server(HUMAN, "S") == {"serverId": "S"}
    await app.refresh_server(HUMAN, "S")
    await app.server_action(AGENT, "S", "start")
    await app.read_server_logs(HUMAN, "S")
    devices.read_server_logs.assert_awaited_with("S")
    await app.read_server_logs(HUMAN, "S", 5)
    devices.read_server_logs.assert_awaited_with("S", 5)
    assert await app.list_managed_hardware(HUMAN) == [{"result": "refresh_hardware"}]
    assert app.list_hardware(HUMAN) == [HARDWARE] and app.get_hardware(HUMAN, "HW1") == HARDWARE
    assert app.list_tools(AGENT) == [{"externalName": "S__tool"}]
    assert await app.remove_hardware(HUMAN, "H1") == {"hardwareId": "H1"}
    assert await app.set_hardware_image_bytes(HUMAN, "H1", None, b"image", ".png") == {
        "assetId": "bytes"
    }
    devices.store.put_image_bytes.assert_awaited_once_with("H1", None, b"image", ".png")
    assert await app.set_hardware_image_from_path(HUMAN, "H1", "P1", "photo.png") == {
        "assetId": "path"
    }
    assert await app.remove_hardware_image(HUMAN, "H1") == {"removed": True}
    assert await app.export_bundle(HUMAN, "H1") == b"zip"
    assert await app.import_bundle(HUMAN, b"zip") == {"hardwareId": "H1"}
    assert await app.inspect_bundle(HUMAN, b"zip") == {"hardwareId": "H1"}
    assert await app.import_bundle_for_server(HUMAN, b"zip", "H1", "S") == {"hardwareId": "H1"}
    devices.store.import_bundle.assert_awaited_with(
        b"zip", {"expectedHardwareId": "H1", "allowManagedServerId": "S"}
    )
    with pytest.raises(ValueError, match="not found"):
        await app.import_bundle_for_server(HUMAN, b"zip", "H1", "absent")
    with pytest.raises(ValueError, match="not H2"):
        await app.import_bundle_for_server(HUMAN, b"zip", "H2", "S")
    passive: Json = {
        "formatVersion": 2,
        "hardwareId": "P",
        "label": "P",
        "kind": "passive",
        "ports": [],
    }
    assert (await app.save_hardware(AGENT, passive))["hardwareId"] == "P"
    with pytest.raises(Exception, match="register_mcp_server first"):
        await app.save_hardware(HUMAN, HARDWARE)
    with pytest.raises(Exception, match="unregister that server"):
        await app.save_hardware(HUMAN, {**passive, "hardwareId": "H1"})
    assert (await app.save_hardware(HUMAN, {**HARDWARE, "hardwareId": "H1"}))["hardwareId"] == "H1"


async def test_project_switch_reinitializes_on_success_and_failure() -> None:
    trace: list[str] = []

    def sync(name: str, result: Any = None) -> Mock:
        def call(*args: Any) -> Any:
            trace.append(name)
            return result

        return Mock(side_effect=call)

    def asynchronous(name: str, result: Any = None) -> AsyncMock:
        async def call(*args: Any) -> Any:
            trace.append(name)
            return result

        return AsyncMock(side_effect=call)

    projects = Mock(
        current=sync("current", {"dirty": False}),
        inspect_folder=asynchronous("inspect", {"status": "ready"}),
        initialize_folder=asynchronous("initializeFolder", {"dirty": False}),
        open_folder=asynchronous("openFolder", {"dirty": False}),
        save=asynchronous("save", {"dirty": False}),
        leave=asynchronous("leave"),
        list_recent=asynchronous("recent", []),
        forget_recent=asynchronous("forget"),
        close=asynchronous("project.close"),
    )
    wiring = Mock(
        close=asynchronous("wiring.close"),
        clear_session=sync("wiring.clear"),
        initialize=asynchronous("wiring.initialize"),
    )
    orchestration = Mock(
        close=asynchronous("orchestration.close"),
        clear_session=sync("orchestration.clear"),
        initialize=asynchronous("orchestration.initialize"),
    )
    app = ProjectsApplication(DefaultAuthorizer(), projects, wiring, orchestration)
    assert app.document(HUMAN) == {"dirty": False}
    assert await app.inspect_folder(HUMAN, "path") == {"status": "ready"}
    trace.clear()
    assert await app.initialize_folder(HUMAN, "path") == {"dirty": False}
    assert trace == [
        "orchestration.close",
        "wiring.close",
        "orchestration.clear",
        "wiring.clear",
        "initializeFolder",
        "wiring.initialize",
        "orchestration.initialize",
    ]
    await app.open_folder(HUMAN, "path")
    assert await app.save_project(HUMAN) == {"dirty": False}
    await app.leave_project(HUMAN)
    assert await app.list_recent(HUMAN) == []
    await app.forget_recent(HUMAN, "path")
    projects.open_folder.side_effect = ValueError("bad project")
    trace.clear()
    with pytest.raises(ValueError, match="bad project"):
        await app.open_folder(HUMAN, "path")
    assert trace == [
        "orchestration.close",
        "wiring.close",
        "orchestration.clear",
        "wiring.clear",
        "wiring.initialize",
        "orchestration.initialize",
    ]
    trace.clear()
    await app.close()
    assert trace == ["orchestration.close", "wiring.close", "project.close"]


async def test_wiring_orchestration_and_dashboard_facades() -> None:
    authorizer = DefaultAuthorizer()
    assert authorizer.allowed_capabilities(SYSTEM_REQUEST_CONTEXT) == list(CAPABILITIES)
    wiring = Mock(
        add_managed_hardware_to_canvas=AsyncMock(return_value={"added": True}),
        request_task=AsyncMock(return_value={"status": "pending"}),
        start_task=AsyncMock(return_value={"status": "in_progress"}),
        complete_task=AsyncMock(return_value={"status": "confirmed"}),
        cancel_task=AsyncMock(return_value={"status": "cancelled"}),
        get_task=Mock(return_value={"id": "W"}),
        list_tasks=Mock(return_value=[]),
    )
    projects = Mock(update_wiring=Mock(return_value={"dirty": True}))
    app = WiringApplication(authorizer, projects, wiring)
    assert app.update_document(HUMAN, {}) == {"dirty": True}
    assert await app.add_managed_hardware_to_canvas(AGENT, "H") == {"added": True}
    await app.request_task(
        HUMAN, {"portA": "A", "portB": "B", "action": "connect", "timeoutMs": 1000}
    )
    wiring.request_task.assert_awaited_with(
        {"portA": "A", "portB": "B", "action": "connect", "timeoutMs": 1000, "pins": []}
    )
    await app.start_task(HUMAN, "W")
    wiring.start_task.assert_awaited_with("W")
    assert (await app.complete_task(HUMAN, "W", "confirmed", "ok"))["status"] == "confirmed"
    assert (await app.cancel_task(AGENT, "W", "cancel"))["status"] == "cancelled"
    assert app.get_task(HUMAN, "W") == {"id": "W"} and app.list_tasks(HUMAN) == []
    service = Mock(
        get_task=Mock(return_value={"taskId": "T"}),
        update_task=Mock(return_value={"dirty": True, "file": {"task": {"taskId": "T"}}}),
        validate_task=Mock(return_value={"valid": True}),
        get_run=Mock(return_value={"run": {"runId": "R"}}),
        list_runs=Mock(return_value={"items": []}),
        export_run=Mock(return_value={"formatVersion": 1}),
        list_operator_decisions=Mock(return_value=[]),
        cancel_run=AsyncMock(return_value={"status": "cancelling"}),
        delete_run=AsyncMock(return_value={"runId": "R"}),
        clear_completed_runs=AsyncMock(return_value={"deleted": 0}),
    )
    runs = OrchestrationApplication(authorizer, service)
    assert runs.get_task(HUMAN) == {"taskId": "T"}
    assert runs.update_task(AGENT, {}) == {
        "task": {"taskId": "T"},
        "dirty": True,
        "document": {"dirty": True, "file": {"task": {"taskId": "T"}}},
    }
    assert runs.validate_task(AGENT, {}) == {"valid": True}
    assert (await runs.cancel_run(AGENT, "R"))["status"] == "cancelling"
    assert runs.get_run(AGENT, "R", 3, 2, 1) == {"run": {"runId": "R"}}
    service.get_run.assert_called_once_with("R", 3, 2, 1)
    assert runs.list_runs(AGENT) == {"items": []}
    assert runs.export_run(AGENT, "R") == {"formatVersion": 1}
    assert await runs.delete_run(HUMAN, "R") == {"runId": "R"}
    assert await runs.clear_completed_runs(HUMAN) == {"deleted": 0}
    assert runs.list_operator_decisions(AGENT) == []
    devices = Mock()
    for name in [
        "list_computers",
        "list_statuses",
        "list_servers",
        "list_server_statuses",
        "list_hardware",
        "list_tools",
        "list_availability",
    ]:
        getattr(devices, name).return_value = [name]
    devices.occupancy.list.return_value = ["occupancy"]
    dashboard = SystemApplication(
        authorizer, devices, Mock(gateway_status=lambda: {"running": True}), ExecutionCoordinator()
    ).dashboard(HUMAN)
    assert dashboard == {
        "computers": ["list_computers"],
        "statuses": ["list_statuses"],
        "servers": ["list_servers"],
        "serverStatuses": ["list_server_statuses"],
        "hardware": ["list_hardware"],
        "tools": ["list_tools"],
        "availability": ["list_availability"],
        "occupancy": ["occupancy"],
        "gateway": {"running": True},
        "execution": {"state": "idle"},
    }

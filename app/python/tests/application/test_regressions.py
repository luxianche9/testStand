from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from teststand_backend.application import (
    AGENT_REQUEST_CONTEXT as AGENT,
)
from teststand_backend.application import (
    HUMAN_REQUEST_CONTEXT as HUMAN,
)
from teststand_backend.application import (
    SYSTEM_REQUEST_CONTEXT,
    DefaultAuthorizer,
    DevicesApplication,
    ExecutionCoordinator,
    ProjectsApplication,
    SystemApplication,
    WiringApplication,
)
from teststand_backend.application.cancellation import AbortError
from teststand_backend.contracts.agents import CAPABILITIES
from teststand_backend.contracts.errors import AppError

from .test_application import HARDWARE, invocation, make_app, manual_fixture

Json = dict[str, Any]


async def test_shutdown_cancels_agent_hardware_call_and_rejects_new_work() -> None:
    app, devices, _ = make_app()
    started = asyncio.Event()

    async def call(*args: Any) -> None:
        started.set()
        await asyncio.Event().wait()

    devices.call_aggregated_tool.side_effect = call
    pending = asyncio.create_task(app.devices.call_tool(AGENT, "S1.measure", {}))
    await asyncio.wait_for(started.wait(), 1)
    assert app.devices.execution.current()["hardwareId"] == "H1"
    await app.devices.close_calls()
    with pytest.raises(AppError) as cancelled:
        await pending
    assert cancelled.value.category == "cancelled"
    assert cancelled.value.details == {
        "outcomeKnown": False,
        "automaticRetry": False,
        "toolName": "S1.measure",
    }
    assert app.devices.execution.current() == {"state": "idle"}
    assert not app.devices.active
    with pytest.raises(AppError, match="shutting down"):
        await app.devices.call_tool(AGENT, "S1.measure", {})
    devices.call_aggregated_tool.assert_awaited_once()


async def test_project_shutdown_rejects_future_switches() -> None:
    projects = Mock(close=AsyncMock(), open_folder=AsyncMock())
    wiring = Mock(close=AsyncMock())
    app = ProjectsApplication(DefaultAuthorizer(), projects, wiring)
    await app.close()
    with pytest.raises(AppError, match="shutting down"):
        await app.open_folder(HUMAN, "project")
    projects.open_folder.assert_not_called()
    wiring.close.assert_awaited_once()


async def test_manual_hardware_abort_is_scoped() -> None:
    async def call(name: str, args: Json, options: Json) -> None:
        await options["signal"].wait()
        raise options["signal"].reason

    manual, execution, _ = manual_fixture(call=AsyncMock(side_effect=call))
    pending = asyncio.create_task(manual.invoke_tool(HUMAN, invocation()))
    await asyncio.sleep(0)
    await manual.abort_hardware("OTHER", "other")
    assert not pending.done()
    await manual.abort_hardware("HW1", "device unplugged")
    with pytest.raises(AbortError, match="device unplugged"):
        await pending
    assert execution.current()["state"] == "idle"


async def test_device_application_crud_and_binary_boundaries() -> None:
    instance: Json = {
        "deviceId": "S",
        "hardwareId": "H1",
        "label": "S",
        "enabled": True,
        "endpoint": {"url": "http://localhost:8001/mcp"},
        "process": {"kind": "external"},
    }
    # Valid instance details are parsed in contracts tests; these adapters must preserve call data.
    devices = Mock()
    for name in [
        "remove_device",
        "refresh_all_devices",
        "save_device",
        "refresh_device",
        "refresh_hardware",
    ]:
        setattr(devices, name, AsyncMock(return_value={"result": name}))
    devices.list_devices.return_value = [instance, {**instance, "deviceId": "OTHER"}]
    devices.list_tools.return_value = [{"externalName": "S__tool"}]
    devices.refresh_hardware.return_value = [{"result": "refresh_hardware"}]
    devices.store = Mock(
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
    assert len(app.list_devices(HUMAN)) == 2
    assert (await app.list_devices_with_status(HUMAN))["statuses"] == {
        "result": "refresh_all_devices"
    }
    assert await app.remove_device(HUMAN, "S") == {"deviceId": "S"}
    await app.refresh_device(HUMAN, "S")
    devices.refresh_device.assert_awaited_once_with("S")
    assert await app.list_managed_hardware(HUMAN) == [{"result": "refresh_hardware"}]
    assert app.list_hardware(HUMAN) == [HARDWARE] and app.get_hardware(HUMAN, "HW1") == HARDWARE
    assert app.list_tools(AGENT) == [{"externalName": "S__tool"}]
    assert await app.remove_hardware(HUMAN, "H1") == {"hardwareId": "H1"}
    assert await app.export_bundle(HUMAN, "H1") == b"zip"
    assert await app.import_bundle(HUMAN, b"zip") == {"hardwareId": "H1"}
    assert await app.inspect_bundle(HUMAN, b"zip") == {"hardwareId": "H1"}
    passive: Json = {
        "formatVersion": 2,
        "hardwareId": "P",
        "label": "P",
        "kind": "passive",
        "ports": [],
    }
    assert (await app.save_hardware(AGENT, passive))["hardwareId"] == "P"
    with pytest.raises(Exception, match="save_device first"):
        await app.save_hardware(HUMAN, HARDWARE)
    with pytest.raises(Exception, match="unregister that instance"):
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
    app = ProjectsApplication(DefaultAuthorizer(), projects, wiring)
    assert app.document(HUMAN) == {"dirty": False}
    assert await app.inspect_folder(HUMAN, "path") == {"status": "ready"}
    trace.clear()
    assert await app.initialize_folder(HUMAN, "path") == {"dirty": False}
    assert trace == [
        "wiring.close",
        "wiring.clear",
        "initializeFolder",
        "wiring.initialize",
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
        "wiring.close",
        "wiring.clear",
        "wiring.initialize",
    ]
    trace.clear()
    await app.close()
    assert trace == ["wiring.close", "project.close"]


async def test_wiring_orchestration_and_dashboard_facades() -> None:
    authorizer = DefaultAuthorizer()
    assert authorizer.allowed_capabilities(SYSTEM_REQUEST_CONTEXT) == list(CAPABILITIES)
    wiring = Mock(
        request_task=AsyncMock(return_value={"status": "pending"}),
        start_task=AsyncMock(return_value={"status": "in_progress"}),
        complete_task=AsyncMock(return_value={"status": "confirmed"}),
        cancel_task=AsyncMock(return_value={"status": "cancelled"}),
        get_task=Mock(return_value={"id": "W"}),
        list_tasks=Mock(return_value=[]),
        list_changes=Mock(return_value=[]),
    )
    saved = {"dirty": True, "file": {"wiring": {"connections": []}}}
    projects = Mock(
        wiring=Mock(return_value={"connections": []}),
        update_wiring=Mock(return_value=saved),
    )
    app = WiringApplication(authorizer, projects, wiring)
    assert await app.update_document(HUMAN, {}) == saved
    wiring.record_manual_changes.assert_called_once_with([], [])
    assert app.list_changes(HUMAN) == []
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
    devices = Mock()
    for name in [
        "list_devices",
        "list_device_statuses",
        "list_hardware",
        "list_tools",
        "list_availability",
    ]:
        getattr(devices, name).return_value = [name]
    instances = [{"deviceId": "R"}, {"deviceId": "P"}]
    devices.list_devices.return_value = instances
    dashboard = SystemApplication(
        authorizer, devices, Mock(gateway_status=lambda: {"running": True}), ExecutionCoordinator()
    ).dashboard(HUMAN)
    assert dashboard == {
        "devices": instances,
        "deviceStatuses": ["list_device_statuses"],
        "hardware": ["list_hardware"],
        "tools": ["list_tools"],
        "availability": ["list_availability"],
        "gateway": {"running": True},
        "execution": {"state": "idle"},
    }

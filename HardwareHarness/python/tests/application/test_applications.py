from __future__ import annotations

import asyncio
import inspect
import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.application import (
    ApplicationsApplication,
    DefaultAuthorizer,
    DevicesApplication,
    ExecutionCoordinator,
    ProjectsApplication,
)
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.storage import SettingsStore

HUMAN = {"actor": "human", "source": "desktop"}
AGENT = {"actor": "agent", "source": "mcp"}


async def fixture(tmp_path: Path) -> tuple[ApplicationsApplication, Mock]:
    settings = SettingsStore(tmp_path / "settings.json")
    await settings.initialize()
    projects = ProjectService(settings)
    await projects.initialize_folder(tmp_path)
    devices = Mock()
    devices.list_servers.return_value = [{"serverId": "S", "enabled": True}]
    devices.list_tools.return_value = [
        {"externalName": "S__call", "serverId": "S", "kind": "hardware"}
    ]
    devices.list_availability.return_value = [{"hardwareId": "H", "state": "available"}]
    devices.call_tool = AsyncMock(return_value={"content": [{"type": "text", "text": "ok"}]})
    catalog = Mock(
        get_hardware=Mock(return_value={"hardwareId": "H", "kind": "managed", "serverId": "S"})
    )
    return ApplicationsApplication(
        DefaultAuthorizer(), projects, devices, catalog, ExecutionCoordinator()
    ), devices


async def test_hardware_execution_is_atomic_without_manual_setup(tmp_path: Path) -> None:
    app, devices = await fixture(tmp_path)
    release = await app._acquire(["H"], {"runId": "R", "startedAt": "2026-01-01T00:00:00Z"})
    assert app.execution.is_hardware_busy("H")
    with pytest.raises(AppError, match="already active"):
        await app._acquire(["H"], {"runId": "OTHER", "startedAt": "2026-01-01T00:00:00Z"})
    assert await app._invoke("H", "S__call", {"value": 3}, 1000) == {
        "content": [{"type": "text", "text": "ok"}]
    }
    devices.call_tool.assert_awaited_once_with(
        "S__call",
        {"value": 3},
        {"timeoutMs": 1000, "metadata": {"hardwareId": "H"}, "preserveEnvelope": True},
    )
    release()
    assert not app.execution.is_hardware_busy("H")


@pytest.mark.parametrize(
    "condition",
    ["passive", "server", "hidden", "unknown", "foreign", "offline", "unchecked"],
)
async def test_hardware_gates_before_remote_send(tmp_path: Path, condition: str) -> None:
    app, devices = await fixture(tmp_path)
    if condition == "passive":
        app.catalog = Mock(get_hardware=Mock(return_value={"kind": "passive"}))
    elif condition == "server":
        devices.list_servers.return_value = []
    elif condition in {"hidden", "foreign"}:
        devices.list_tools.return_value = [
            {
                "externalName": "S__call",
                "serverId": "OTHER" if condition == "foreign" else "S",
                "kind": "internal" if condition == "hidden" else "hardware",
            }
        ]
    elif condition == "unknown":
        devices.list_tools.return_value = []
    else:
        devices.list_availability.return_value = (
            [] if condition == "unchecked" else [{"hardwareId": "H", "state": "offline"}]
        )
    with pytest.raises(AppError):
        await app._invoke("H", "S__call", {}, 1000)
    devices.call_tool.assert_not_called()


async def test_public_nonhardware_tools_still_require_claim(tmp_path: Path) -> None:
    app, devices = await fixture(tmp_path)
    devices.list_tools.return_value[0]["kind"] = "metadata"
    devices.list_availability.return_value = []
    await app._invoke("H", "S__call", {}, 1000)


async def test_workspace_real_files_and_explicit_save(tmp_path: Path) -> None:
    app, _ = await fixture(tmp_path)
    app.create_file(AGENT, {"path": "scripts/main.py", "kind": "file", "content": "x = 1\n"})
    file = app.read_file(AGENT, "scripts/main.py")
    assert len(file["hash"]) == 64
    assert app.search(AGENT, "x")[0]["path"] == "scripts/main.py"
    saved = app.write_file(
        AGENT, {"path": file["path"], "content": "x = 2\n", "expectedHash": file["hash"]}
    )
    assert saved["hash"] != file["hash"]
    with pytest.raises(AppError):
        app.write_file(
            AGENT, {"path": file["path"], "content": "lost", "expectedHash": file["hash"]}
        )
    app.rename_file(AGENT, {"path": file["path"], "target": "scripts/other.py"})
    assert any(entry["name"] == "other.py" for entry in app.list_files(AGENT))
    errors = await app.diagnostics(AGENT, "scripts/other.py", "def broken(")
    assert errors and errors[0]["severity"] == "error"
    app.delete_file(AGENT, "scripts/other.py")
    await app.projects.leave()
    with pytest.raises(AppError) as caught:
        app.list_files(AGENT)
    assert caught.value.category == "requires_project"


async def test_production_diagnostics_run_ruff_with_project_python(tmp_path: Path) -> None:
    app, _ = await fixture(tmp_path)
    app.create_file(AGENT, {"path": "scripts/main.py", "kind": "file", "content": "print(1)\n"})
    project_python = AsyncMock(return_value=sys.executable)
    app.environment = Mock(python=project_python)
    diagnostics = await app.diagnostics(AGENT, "scripts/main.py", "import os\n")
    assert any(item["code"] == "F401" for item in diagnostics)
    project_python.assert_awaited_once_with(str(tmp_path))
    assert app.read_file(AGENT, "scripts/main.py")["content"] == "print(1)\n"


async def test_syntax_diagnostics_do_not_prepare_environment(tmp_path: Path) -> None:
    app, _ = await fixture(tmp_path)
    project_python = AsyncMock()
    app.environment = Mock(python=project_python)
    assert (await app.diagnostics(AGENT, "scripts/main.py", "def broken("))[0]["code"] == "syntax"
    with pytest.raises(AppError, match="only accepts"):
        await app.diagnostics(AGENT, "scripts/index.html", "<html></html>")
    project_python.assert_not_called()


async def test_lifecycle_facade_and_scope(tmp_path: Path) -> None:
    app, _ = await fixture(tmp_path)
    first = app.runner
    notifications = Mock()
    app.notifier = notifications
    app._notify({"type": "run", "run": {"runId": "R"}})
    app._notify({"type": "runEvent", "event": {"sequence": 1}})
    assert notifications.call_count == 2
    app.notifier = None
    app._notify({"type": "run", "run": {}})
    runtime = Mock(
        active={"R": object()},
        close=AsyncMock(),
        read_run_source=AsyncMock(return_value="code"),
        read_run_attachment=AsyncMock(return_value={"content": b"hi"}),
    )
    app.runner = runtime
    assert app._busy()
    for path in ("pyproject.toml", "uv.lock"):
        with pytest.raises(AppError, match="Stop Python runs"):
            app._write_guard(path)
    app._write_guard("scripts/main.py")
    for name, args in [("delete_run", ["R"]), ("clear_completed_runs", [])]:
        with pytest.raises(AppError) as denied:
            await getattr(app, name)(AGENT, *args)
        assert denied.value.category == "permission_denied"
    assert (await app.read_run_source(HUMAN, "R", "scripts/main.py"))["content"] == "code"
    assert (await app.read_run_attachment(HUMAN, "R", "x"))["content"] == b"hi"
    await app.close()
    assert app.runner is runtime
    app.resume()
    assert app.runner is not runtime and app.runner is not first
    runtime.close.assert_awaited_once()
    await app.close()


@pytest.mark.parametrize(
    "method,args,delegate",
    [
        ("start_run", [{"entrypoint": "scripts/main.py"}], "start_run"),
        ("cancel_run", ["R"], "cancel_run"),
        ("get_run", ["R"], "get_run"),
        ("list_runs", [], "list_runs"),
        ("run_events", ["R", 1, 2], "run_events"),
        ("clear_completed_runs", [], "clear_completed_runs"),
    ],
)
async def test_run_facade_contracts(
    tmp_path: Path, method: str, args: list[Any], delegate: str
) -> None:
    app, _ = await fixture(tmp_path)
    runtime = Mock()
    handler = AsyncMock(return_value={"result": True})
    setattr(runtime, delegate, handler)
    app.runner = runtime
    result = getattr(app, method)(HUMAN, *args)
    assert inspect.isawaitable(result)
    assert await result == {"result": True}
    handler.assert_awaited_once()


async def test_export_all_pages_and_delete(tmp_path: Path) -> None:
    app, _ = await fixture(tmp_path)
    app.runner = Mock(
        get_run=AsyncMock(return_value={"run": {"runId": "R"}, "events": [], "hasMore": True}),
        run_events=AsyncMock(side_effect=[[{"sequence": 1}], [{"sequence": 2}], []]),
        delete_run=AsyncMock(),
    )
    exported = await app.export_run(HUMAN, "R")
    assert exported["events"] == [{"sequence": 1}, {"sequence": 2}]
    assert exported["hasMore"] is False
    assert await app.delete_run(HUMAN, "R") == {"runId": "R"}


async def test_environment_facade(tmp_path: Path) -> None:
    app, _ = await fixture(tmp_path)
    app.environment = Mock(
        prepare=AsyncMock(return_value={"status": "ready"}),
        python=AsyncMock(return_value="python.exe"),
    )
    assert not app._busy()
    assert await app.initialize_workspace(HUMAN) == {"status": "ready"}
    assert await app._python() == "python.exe"


@pytest.mark.parametrize("options,online", [(None, False), ({}, False), ({"online": True}, True)])
async def test_dependency_installation_is_offline_unless_explicit(
    tmp_path: Path, options: dict[str, Any] | None, online: bool
) -> None:
    app, _ = await fixture(tmp_path)
    app.environment = Mock(prepare=AsyncMock(return_value={"status": "ready"}))
    assert await app.initialize_workspace(HUMAN, options) == {"status": "ready"}
    app.environment.prepare.assert_awaited_once_with(str(tmp_path), online=online)


@pytest.mark.parametrize("options", [{"online": "true"}, {"online": 1}, {"extra": True}])
async def test_dependency_installation_rejects_ambiguous_options(
    tmp_path: Path, options: dict[str, Any]
) -> None:
    app, _ = await fixture(tmp_path)
    app.environment = Mock(prepare=AsyncMock())
    with pytest.raises(ValueError):
        await app.initialize_workspace(HUMAN, options)
    app.environment.prepare.assert_not_called()


async def test_project_switch_rejects_calls_until_new_session_is_ready(tmp_path: Path) -> None:
    app, _ = await fixture(tmp_path)
    waiting, proceed = asyncio.Event(), asyncio.Event()

    async def close_wiring() -> None:
        waiting.set()
        await proceed.wait()

    wiring = Mock(close=AsyncMock(side_effect=close_wiring), initialize=AsyncMock())
    projects = ProjectsApplication(DefaultAuthorizer(), app.projects, wiring, app)
    next_root = tmp_path / "next"
    next_root.mkdir()
    switching = asyncio.create_task(projects.initialize_folder(HUMAN, str(next_root)))
    await waiting.wait()
    with pytest.raises(AppError, match="switching or closed"):
        await app.start_run(HUMAN, {"entrypoint": "scripts/main.py"})
    proceed.set()
    await switching
    assert app._root() == str(next_root)
    assert app.list_files(HUMAN) == [{"path": "scripts", "name": "scripts", "kind": "directory"}]
    await app.close()
    with pytest.raises(AppError, match="switching or closed"):
        app.list_files(HUMAN)


async def test_agent_direct_calls_share_run_execution_claims(tmp_path: Path) -> None:
    app, devices = await fixture(tmp_path)
    devices.list_servers.return_value = [{"serverId": "S", "hardwareId": "H", "enabled": True}]
    devices.call_aggregated_tool = AsyncMock(return_value={"value": 1})
    control = DevicesApplication(DefaultAuthorizer(), devices, app.catalog, app.execution)
    release = await app._acquire(["H"], {"runId": "R", "startedAt": "2026-01-01T00:00:00Z"})
    with pytest.raises(AppError) as conflict:
        await control.call_tool(AGENT, "S__call", {})
    assert conflict.value.category == "conflict"
    devices.call_aggregated_tool.assert_not_called()
    release()
    assert await control.call_tool(AGENT, "S__call", {}) == {"value": 1}
    assert not app.execution.is_hardware_busy("H")


async def test_agent_call_cancellation_and_closing_release_claims(tmp_path: Path) -> None:
    app, devices = await fixture(tmp_path)
    devices.list_servers.return_value = [{"serverId": "S", "hardwareId": "H"}]
    running = asyncio.Event()

    async def blocked(name: str, arguments: dict[str, Any]) -> None:
        running.set()
        await asyncio.Event().wait()

    devices.call_aggregated_tool = blocked
    control = DevicesApplication(DefaultAuthorizer(), devices, app.catalog, app.execution)
    task = asyncio.create_task(control.call_tool(AGENT, "S__call", {}))
    await running.wait()
    await control.abort_hardware("OTHER")
    assert not task.done()
    await control.abort_hardware("H")
    with pytest.raises(AppError) as cancelled:
        await task
    assert cancelled.value.category == "cancelled"
    assert not app.execution.is_hardware_busy("H")
    running.clear()
    second = asyncio.create_task(control.call_tool(AGENT, "S__call", {}))
    await running.wait()
    await control.close_calls()
    with pytest.raises(AppError):
        await second
    with pytest.raises(AppError, match="shutting down"):
        await control.call_tool(AGENT, "S__call", {})


@pytest.mark.parametrize("kind", ["hidden", "unknown", "missing-server"])
async def test_agent_public_tool_validation(tmp_path: Path, kind: str) -> None:
    app, devices = await fixture(tmp_path)
    if kind == "hidden":
        devices.list_tools.return_value[0]["kind"] = "internal"
    elif kind == "unknown":
        devices.list_tools.return_value = []
    else:
        devices.list_servers.return_value = []
    control = DevicesApplication(DefaultAuthorizer(), devices, app.catalog)
    with pytest.raises(AppError):
        await control.call_tool(AGENT, "S__call", {})


async def test_closed_project_service_rejects_queued_switch(tmp_path: Path) -> None:
    app, _ = await fixture(tmp_path)
    wiring = Mock(close=AsyncMock(), initialize=AsyncMock())
    projects = ProjectsApplication(DefaultAuthorizer(), app.projects, wiring, app)
    await projects.close()
    with pytest.raises(AppError, match="shutting down"):
        await projects.open_folder(HUMAN, str(tmp_path))

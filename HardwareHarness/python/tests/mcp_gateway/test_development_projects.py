from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.application.authorization import (
    AGENT_REQUEST_CONTEXT,
    DefaultAuthorizer,
)
from hardwareharness_backend.application.services import ProjectsApplication
from hardwareharness_backend.contracts.validation import ValidationError
from hardwareharness_backend.mcp_gateway.tool_registry import BUILTIN_TOOL_DEFINITIONS


def setup(dirty: bool = False, state: str = "idle") -> tuple[Any, Any]:
    projects = SimpleNamespace(
        document=Mock(return_value={"dirty": dirty}),
        initialize_folder=AsyncMock(return_value={"dirty": False}),
        open_folder=AsyncMock(return_value={"dirty": False}),
        save_project=AsyncMock(return_value={"dirty": False}),
    )
    application = SimpleNamespace(
        projects=projects,
        system=SimpleNamespace(dashboard=lambda context: {"execution": {"state": state}}),
    )

    async def invoke(name: str, value: dict[str, Any]) -> Any:
        tool = next(item for item in BUILTIN_TOOL_DEFINITIONS if item.tool["name"] == name)
        return await tool.execute(application, AGENT_REQUEST_CONTEXT, tool.parse(value))

    return projects, invoke


async def test_project_tools_forward_agent_context(tmp_path: Path) -> None:
    projects, invoke = setup()
    for name, method in [
        ("initialize_project", projects.initialize_folder),
        ("open_project", projects.open_folder),
    ]:
        await invoke(name, {"rootPath": str(tmp_path)})
        method.assert_awaited_once_with(AGENT_REQUEST_CONTEXT, str(tmp_path))
    assert await invoke("get_project", {}) == {"ok": True, "data": {"dirty": False}}
    projects.document.assert_called_with(AGENT_REQUEST_CONTEXT)
    await invoke("save_project", {})
    projects.save_project.assert_awaited_once_with(AGENT_REQUEST_CONTEXT)


@pytest.mark.parametrize("name", ["initialize_project", "open_project"])
@pytest.mark.parametrize(
    "dirty,state,message",
    [(True, "idle", "Save the current project"), (False, "run", "Finish the active execution")],
)
async def test_switch_guards_preserve_dirty_and_active_projects(
    tmp_path: Path, name: str, dirty: bool, state: str, message: str
) -> None:
    projects, invoke = setup(dirty, state)
    with pytest.raises(Exception, match=message):
        await invoke(name, {"rootPath": str(tmp_path)})
    projects.initialize_folder.assert_not_awaited()
    projects.open_folder.assert_not_awaited()


async def test_project_tools_reject_relative_and_extra_arguments() -> None:
    _, invoke = setup()
    with pytest.raises(ValidationError):
        await invoke("initialize_project", {"rootPath": "relative"})
    with pytest.raises(ValidationError):
        await invoke("save_project", {"force": True})


async def test_project_notifier_runs_after_session_initialization() -> None:
    document: dict[str, Any] | None = None

    async def open_folder(root: str) -> dict[str, Any]:
        nonlocal document
        document = {"rootPath": root, "dirty": False}
        return document

    async def leave() -> None:
        nonlocal document
        document = None

    projects = Mock(
        current=lambda: document,
        open_folder=open_folder,
        leave=leave,
        save=AsyncMock(return_value={"dirty": False}),
    )
    wiring = Mock(initialize=AsyncMock(), close=AsyncMock())
    app = ProjectsApplication(DefaultAuthorizer(), projects, wiring)
    events: list[tuple[Any, bool]] = []

    def notify(value: Any, changed: bool) -> None:
        wiring.initialize.assert_awaited()
        events.append((value, changed))

    app.set_notifier(notify)
    await app.open_folder(AGENT_REQUEST_CONTEXT, "/example")
    await app.save_project(AGENT_REQUEST_CONTEXT)
    await app.leave_project(AGENT_REQUEST_CONTEXT)
    assert events == [
        ({"rootPath": "/example", "dirty": False}, True),
        ({"dirty": False}, False),
        (None, True),
    ]

    projects.open_folder = AsyncMock(side_effect=RuntimeError("invalid project"))
    before = list(events)
    with pytest.raises(RuntimeError, match="invalid project"):
        await app.open_folder(AGENT_REQUEST_CONTEXT, "/invalid")
    assert events == before

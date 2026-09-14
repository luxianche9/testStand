from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.contracts.validation import ValidationError
from hardwareharness_backend.mcp_gateway.tool_registry import BUILTIN_TOOL_DEFINITIONS


@pytest.mark.parametrize("value,online", [({}, False), ({"online": True}, True)])
async def test_agent_dependency_installation_requires_explicit_online(
    value: dict[str, Any], online: bool
) -> None:
    tool = next(
        item for item in BUILTIN_TOOL_DEFINITIONS if item.tool["name"] == "initialize_workspace"
    )
    app = Mock()
    app.applications.initialize_workspace = AsyncMock(return_value={"status": "ready"})
    context = {"actor": "agent", "source": "mcp"}
    assert await tool.execute(app, context, tool.parse(value)) == {
        "ok": True,
        "data": {"status": "ready"},
    }
    app.applications.initialize_workspace.assert_awaited_once_with(context, {"online": online})
    assert tool.tool["inputSchema"]["properties"]["online"] == {
        "type": "boolean",
        "default": False,
    }


@pytest.mark.parametrize("value", [{"online": "true"}, {"online": 1}, {"unknown": True}])
def test_agent_dependency_installation_options_are_strict(value: dict[str, Any]) -> None:
    tool = next(
        item for item in BUILTIN_TOOL_DEFINITIONS if item.tool["name"] == "initialize_workspace"
    )
    with pytest.raises(ValidationError):
        tool.parse(value)

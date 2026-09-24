"""Removed workflow APIs must not remain reachable through desktop or Agent transports."""

import io
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.contracts.execution import parse_execution_activity
from hardwareharness_backend.host.rpc import StdioRpc
from hardwareharness_backend.host.runtime import HUMAN, HostRuntime, Services
from hardwareharness_backend.mcp_gateway.redaction import redact
from hardwareharness_backend.mcp_gateway.tool_registry import BUILTIN_TOOLS
from hardwareharness_backend.storage import SettingsStore


@pytest.mark.parametrize("view", ["applications", "logs", "orchestration", "unknown"])
async def test_old_page_preferences_fall_back_without_losing_settings(
    tmp_path: Path, view: str
) -> None:
    path = tmp_path / "settings.json"
    path.write_text('{"projectView":"' + view + '","theme":"dark"}', encoding="utf-8")
    settings = SettingsStore(path)
    await settings.initialize()
    assert settings.get()["projectView"] == "wiring"
    assert settings.get()["theme"] == "dark"
    await settings.update({"projectView": "manual"})
    assert settings.get()["projectView"] == "manual"


@pytest.mark.parametrize("method", ["listFlows", "startFlow", "startRun", "listRuns", "deleteRun"])
async def test_retired_desktop_routes_are_rejected(method: str) -> None:
    runtime = HostRuntime(StdioRpc(io.BytesIO(), io.BytesIO()))
    runtime.services = cast(Services, SimpleNamespace())
    with pytest.raises(AppError, match="Unknown backend method"):
        await runtime.dispatch(f"application.applications.{method}", {"args": [HUMAN]})


def test_agent_catalog_has_testing_but_no_legacy_workflow_or_script_tools() -> None:
    names = {item.name for item in BUILTIN_TOOLS}
    assert {"read_reference", "get_tool_contract", "request_wiring_task"} <= names
    assert {"list_test_plans", "apply_test_plan_operations", "start_test_run"} <= names
    assert not any(
        "python_run" in name or "test_flow" in name or "workspace" in name for name in names
    )


def test_execution_contract_accepts_runs_and_gateway_redaction_survives_removal() -> None:
    call = {
        "state": "manual",
        "hardwareId": "H",
        "toolName": "S__write",
        "startedAt": "2026-09-16T00:00:00.000Z",
    }
    assert parse_execution_activity(call) == call
    run = {
        "state": "run",
        "runId": "R",
        "hardwareIds": ["H"],
        "startedAt": call["startedAt"],
    }
    assert parse_execution_activity(run) == run
    payload = {"data": [{"Authorization": "secret", "volts": 2.5}], "token": "secret"}
    assert redact(payload) == {
        "data": [{"Authorization": "[REDACTED]", "volts": 2.5}],
        "token": "[REDACTED]",
    }
    assert payload["token"] == "secret"

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from teststand_backend.application import DefaultAuthorizer
from teststand_backend.contracts.validation import ValidationError
from teststand_backend.mcp_gateway.tool_registry import ToolRegistry
from teststand_backend.testing.tools import TESTING_TOOLS

AGENT = {"actor": "agent", "source": "mcp"}


def application() -> SimpleNamespace:
    testing = SimpleNamespace(
        load_plan=Mock(return_value={"id": "plan", "revision": 1}),
        list_step_catalog=Mock(return_value=[]),
        list_device_tools=Mock(return_value={"hardwareId": "dev", "tools": [], "issues": []}),
        validate_plan=Mock(
            return_value={
                "planId": "plan",
                "revision": 1,
                "valid": True,
                "issues": [],
                "executionRevision": "exec",
                "wiringRevision": "none",
                "coverage": {"requirements": [], "total": 0},
            }
        ),
        get_run=Mock(return_value={"runId": "run", "state": "completed", "verdict": "Pass"}),
        list_runs=Mock(return_value={"items": []}),
        read_run_log=Mock(
            return_value={
                "run": {"runId": "run"},
                "plan": {},
                "events": [],
                "results": [],
                "nextEventSequence": 0,
                "nextResultSequence": 0,
            }
        ),
        read_run_results=Mock(return_value={"runId": "run", "results": [], "nextSequence": 0}),
        wait_for_run=AsyncMock(return_value={"run": {"runId": "run"}, "events": []}),
        apply_plan_operations=AsyncMock(
            return_value={
                "plan": {"id": "plan", "revision": 2},
                "issues": [],
                "appliedOperations": 1,
            }
        ),
        start_run=AsyncMock(return_value={"runId": "run", "state": "running", "verdict": "NotSet"}),
        pause_run=AsyncMock(return_value={"runId": "run", "state": "paused"}),
        resume_run=AsyncMock(return_value={"runId": "run", "state": "running"}),
        abort_run=AsyncMock(return_value={"runId": "run", "state": "cleaning"}),
        list_recovery_items=Mock(return_value=[]),
        reconcile_operation=AsyncMock(return_value={"operationId": "op", "state": "succeeded"}),
        read_run_messages=Mock(
            return_value={
                "runId": "run",
                "bindings": [],
                "messages": [],
                "total": 0,
                "truncated": False,
            }
        ),
    )
    devices = SimpleNamespace(list_tools=Mock(return_value=[]))
    return SimpleNamespace(authorizer=DefaultAuthorizer(), testing=testing, devices=devices)


def test_testing_tools_are_visible_with_precise_permissions() -> None:
    registry = ToolRegistry(application())
    capabilities = {name: entry.capability for name, entry in registry._entries.items()}
    definitions = {item.name: item.definition() for item in TESTING_TOOLS}
    assert capabilities["get_test_plan"] == "testing.read"
    assert not {"list_test_plans", "create_test_plan", "start_test_batch"} & set(capabilities)
    assert capabilities["list_test_runs"] == "testing.read"
    assert capabilities["read_test_run_events"] == "testing.read"
    assert capabilities["apply_test_plan_operations"] == "testing.manage"
    assert capabilities["start_test_run"] == "testing.execute"
    assert definitions["start_test_run"]["inputSchema"]["required"] == [
        "revision",
        "executionRevision",
        "requestId",
    ]
    listed = {tool["name"] for tool in registry.list_builtin(AGENT)}
    assert set(definitions) <= listed
    operation_choices = definitions["apply_test_plan_operations"]["inputSchema"]["properties"][
        "operations"
    ]["items"]["oneOf"]
    operation_types = {choice["properties"]["type"]["const"] for choice in operation_choices}
    assert "replace_device" not in operation_types
    run_schema = definitions["read_test_run_events"]["outputSchema"]["properties"]["data"][
        "properties"
    ]["run"]
    assert run_schema["properties"]["activeExecutionIds"] == {
        "type": "array",
        "items": {"type": "string"},
    }
    operation_schema = run_schema["properties"]["operations"]["items"]["properties"]
    assert "executionId" in operation_schema
    assert "stepId" in operation_schema


async def test_read_run_messages_passes_the_time_bounds_as_the_query() -> None:
    app = application()
    registry = ToolRegistry(app)
    read = await registry.invoke(AGENT, "testing_read_run_messages", {"runId": "run", "t0": 1.5})
    assert read["data"]["total"] == 0
    app.testing.read_run_messages.assert_called_once_with(
        AGENT, run_id="run", query={"t0": 1.5, "limit": 200}
    )


async def test_testing_tools_dispatch_structured_operations_and_wait() -> None:
    app = application()
    registry = ToolRegistry(app)
    changed = await registry.invoke(
        AGENT,
        "apply_test_plan_operations",
        {
            "planId": "plan",
            "baseRevision": 1,
            "requestId": "request",
            "operations": [
                {
                    "type": "insert_step",
                    "region": "test",
                    "step": {"id": "delay", "type": "Delay"},
                }
            ],
        },
    )
    assert changed["data"]["appliedOperations"] == 1
    app.testing.apply_plan_operations.assert_awaited_once()
    waited = await registry.invoke(
        AGENT,
        "wait_for_test_run",
        {"runId": "run", "afterSequence": 4, "timeoutMs": 30_000},
    )
    assert waited["data"]["events"] == []
    history = await registry.invoke(
        AGENT,
        "list_test_runs",
        {"limit": 20, "planId": "plan", "verdict": "Pass"},
    )
    assert history["data"] == {"items": []}
    app.testing.list_runs.assert_called_once_with(
        AGENT,
        input={"limit": 20, "planId": "plan", "verdict": "Pass"},
    )
    log = await registry.invoke(
        AGENT,
        "read_test_run_events",
        {"runId": "run", "afterEventSequence": 2, "afterResultSequence": 3},
    )
    assert log["data"]["nextResultSequence"] == 0
    app.testing.read_run_log.assert_called_once_with(
        AGENT,
        run_id="run",
        after_event_sequence=2,
        after_result_sequence=3,
        event_limit=1000,
        result_limit=1000,
    )


async def test_testing_tool_schemas_reject_missing_request_id() -> None:
    registry = ToolRegistry(application())
    with pytest.raises(ValidationError):
        await registry.invoke(
            AGENT,
            "start_test_run",
            {"planId": "plan", "revision": 1, "executionRevision": "exec", "parameters": {}},
        )


async def test_the_flow_is_the_default_plan_and_runs_take_feature_groups() -> None:
    app = application()
    registry = ToolRegistry(app)
    await registry.invoke(AGENT, "get_test_plan", {})
    app.testing.load_plan.assert_called_once_with(AGENT, plan_id="flow")
    run = {"revision": 1, "executionRevision": "exec", "requestId": "r", "features": ["power"]}
    await registry.invoke(AGENT, "start_test_run", run)
    app.testing.start_run.assert_awaited_once_with(
        AGENT, input={**run, "planId": "flow", "parameters": {}}
    )
    with pytest.raises(ValidationError):
        await registry.invoke(AGENT, "start_test_run", {**run, "features": [""]})

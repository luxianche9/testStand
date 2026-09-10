from __future__ import annotations

import asyncio
import copy
import math
from functools import cmp_to_key
from typing import Any
from unittest.mock import AsyncMock

import pytest

from testforge_backend.compat import UNDEFINED
from testforge_backend.compat.collation import locale_compare, set_default_locale
from testforge_backend.contracts.errors import app_error
from testforge_backend.orchestration import (
    create_workflow_context,
    evaluate_workflow_expression,
    get_workflow_path,
    read_json_pointer,
    resolve_workflow_value,
    stable_workflow_stringify,
    validate_test_task,
    workflow_content_hash,
)
from testforge_backend.orchestration.cancellation import (
    AbortController,
    AbortError,
    abortable_delay,
    with_abort,
)
from testforge_backend.orchestration.machine import RunMachine
from testforge_backend.orchestration.ports import NoopExecution, NoopRunLogs
from testforge_backend.orchestration.store import RunStore
from testforge_backend.orchestration.utils import bounded_value, normalize_error

from .test_service import Json, MemoryLogs, archive, eventually, fixture, never, task


def literal(value: Any) -> Json:
    return {"kind": "literal", "value": value}


def step(kind: str, sid: str, **fields: Any) -> Json:
    return {"type": kind, "stepId": sid, "label": sid, "enabled": True, **fields}


@pytest.mark.parametrize(
    ("operator", "left", "right", "expected"),
    [
        ("add", 1, 2, 3),
        ("subtract", 1, 2, -1),
        ("multiply", 3, 4, 12),
        ("divide", 3, 2, 1.5),
        ("modulo", -5, 3, -2),
        ("eq", 0.0, -0.0, False),
        ("eq", math.nan, math.nan, True),
        ("neq", {}, {}, True),
        ("eq", True, 1, False),
        ("gt", 3, 2, True),
        ("gte", 2, 2, True),
        ("lt", "a", "b", True),
        ("lte", "b", "a", False),
        ("lt", math.nan, 1, False),
    ],
)
def test_expression_operators(operator: str, left: Any, right: Any, expected: Any) -> None:
    assert (
        evaluate_workflow_expression(
            {
                "kind": "binary",
                "operator": operator,
                "left": literal(left),
                "right": literal(right),
            },
            {},
        )
        == expected
    )


@pytest.mark.parametrize(
    ("operator", "left", "right", "message"),
    [
        ("divide", 1, 0, "Division by zero"),
        ("modulo", 1, 0, "Modulo by zero"),
        ("add", True, 1, "finite numeric"),
        ("multiply", math.inf, 1, "finite numeric"),
        ("lt", 1, "2", "Relational comparison"),
    ],
)
def test_expression_errors(operator: str, left: Any, right: Any, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        evaluate_workflow_expression(
            {
                "kind": "binary",
                "operator": operator,
                "left": literal(left),
                "right": literal(right),
            },
            {},
        )


def test_workflow_js_values_and_paths() -> None:
    assert (
        evaluate_workflow_expression(
            {"kind": "unary", "operator": "negate", "operand": literal(2)}, {}
        )
        == -2
    )
    assert (
        evaluate_workflow_expression(
            {"kind": "unary", "operator": "not", "operand": literal([])}, {}
        )
        is False
    )
    assert (
        evaluate_workflow_expression(
            {"kind": "logical", "operator": "or", "operands": [literal(False), literal({})]}, {}
        )
        is True
    )
    with pytest.raises(ValueError, match="at least one operand"):
        evaluate_workflow_expression({"kind": "logical", "operator": "and", "operands": []}, {})
    value = {"items": ["a", {"value": 2}]}
    assert get_workflow_path(value, " ") is value
    assert get_workflow_path(value, " items . 1 . value ") == 2
    assert get_workflow_path(value, "items.length") == 2
    with pytest.raises(ValueError, match="Unknown"):
        get_workflow_path(value, "items.01")
    assert resolve_workflow_value(
        {"kind": "array", "items": [literal(1), {"kind": "variable", "path": "items.0"}]}, value
    ) == [1, "a"]
    assert resolve_workflow_value({"kind": "literal"}, {}) is UNDEFINED
    context = create_workflow_context(
        {"inputs": [{"name": "a", "type": "unknown"}], "variables": []}, {}
    )
    assert context["a"] is UNDEFINED
    assert stable_workflow_stringify({"b": 1, "a": ["中", -0.0]}) == '{"a":["中",0],"b":1}'
    assert stable_workflow_stringify([UNDEFINED, 1]) == "[,1]"
    assert stable_workflow_stringify({"a": UNDEFINED}) == '{"a":undefined}'
    assert stable_workflow_stringify(UNDEFINED) is UNDEFINED
    with pytest.raises(TypeError, match="undefined"):
        workflow_content_hash(UNDEFINED)
    assert get_workflow_path({"x": 1}, "\ufeffx\ufeff") == 1
    assert workflow_content_hash({"b": 1, "a": 2}) == workflow_content_hash({"a": 2, "b": 1})
    assert read_json_pointer(value, "") is value and read_json_pointer(value, "/") is value
    assert read_json_pointer({"a/b": {"~c": [7, 8]}}, "/a~1b/~0c/1e0") == 8
    for pointer in ["bad", "/missing", "/items/-1", "/items/20", "/items/1.1", "/constructor"]:
        with pytest.raises(ValueError, match="JSON Pointer"):
            read_json_pointer(value, pointer)


@pytest.mark.parametrize("kind", ["assert", "set_variable", "delay"])
def test_unsafe_validation_returns_issue(kind: str) -> None:
    value = task()
    value["variables"] = [{"name": "x", "type": "number", "defaultValue": 0}]
    template = {"kind": "variable", "path": "x.constructor"}
    fields = (
        {"expression": template, "message": "bad"}
        if kind == "assert"
        else {"variable": "x", "value": template}
        if kind == "set_variable"
        else {"durationMs": template}
    )
    value["steps"] = [step(kind, "A", **fields)]
    result = validate_test_task(value)
    assert result["valid"] is False
    assert result["issues"] == [
        {
            "severity": "error",
            "code": "unsafe_variable_path",
            "nodeId": "A",
            "message": "Unsafe workflow variable path: x.constructor",
        }
    ]


def test_static_validation_issue_matrix() -> None:
    value = task()
    value["formatVersion"] = 1
    value["inputs"] = [{"name": "dup", "type": "number"}]
    value["variables"] = [{"name": "dup", "type": "number"}, {"name": "wrong", "type": "string"}]
    value["steps"] = [
        step("delay", "D", durationMs=literal("wrong")),
        {**step("delay", "D", durationMs=literal(1)), "enabled": False},
        step("assert", "A", expression=literal(1), message="bad"),
        step("if", "IF", condition=literal("wrong"), then=[], **{"else": []}),
        step("loop", "L", indexVariable="wrong", mode="count", maxIterations=2, body=[]),
        step(
            "loop",
            "L2",
            indexVariable="dup",
            mode="count",
            count=literal("wrong"),
            maxIterations=2,
            body=[],
        ),
        step("loop", "W", indexVariable="dup", mode="while", maxIterations=2, body=[]),
        step(
            "loop",
            "W2",
            indexVariable="dup",
            mode="while",
            condition=literal(1),
            maxIterations=2,
            body=[],
        ),
        step(
            "set_variable",
            "S",
            variable="missing",
            value={"kind": "array", "items": [{"kind": "variable", "path": "absent"}]},
        ),
        step(
            "operator",
            "O",
            prompt="?",
            resultVariable="dup",
            options=[{"label": "x", "value": "wrong"}],
        ),
        step(
            "assert",
            "NEG",
            expression={"kind": "unary", "operator": "negate", "operand": literal("wrong")},
            message="bad",
        ),
        step(
            "assert",
            "LOG",
            expression={"kind": "logical", "operator": "and", "operands": [literal(1)]},
            message="bad",
        ),
        step(
            "assert",
            "MATH",
            expression={
                "kind": "binary",
                "operator": "add",
                "left": literal("wrong"),
                "right": literal(1),
            },
            message="bad",
        ),
        step(
            "assert",
            "CMP",
            expression={
                "kind": "binary",
                "operator": "gt",
                "left": literal("wrong"),
                "right": literal(1),
            },
            message="bad",
        ),
    ]
    tool = task()["steps"][0]
    tool.update(
        hardwareId=" ",
        outputBindings=[{"variable": "missing", "pointer": ""}],
        arguments={
            "value": {"kind": "object", "entries": {"a": {"kind": "variable", "path": "missing"}}}
        },
    )
    value["steps"].append(tool)
    result = validate_test_task(value)
    assert result["valid"] is False
    assert {
        "unsupported_format",
        "duplicate_variable",
        "duplicate_step",
        "duration_type",
        "expression_type",
        "variable_type",
        "undeclared_variable",
        "loop_count_required",
        "loop_count_type",
        "loop_condition_required",
        "operator_type",
        "hardware_id_required",
    } <= {issue["code"] for issue in result["issues"]}


async def test_checkpoint_latest_context_cleanup_and_recovery() -> None:
    value = task()
    value["variables"] = [{"name": "x", "type": "number", "defaultValue": 0}]
    tool = {**value["steps"][0], "stepId": "PENDING", "idempotent": True}
    value["steps"] = [
        step("set_variable", "S1", variable="x", value=literal(1)),
        step("set_variable", "S2", variable="x", value=literal(2)),
        tool,
    ]
    value["cleanup"] = [
        step(
            "assert",
            "C",
            expression={
                "kind": "binary",
                "operator": "eq",
                "left": {"kind": "variable", "path": "x"},
                "right": literal(2),
            },
            message="cleanup stale x",
        )
    ]
    first, logs, *_ = fixture(value=value, call=AsyncMock(side_effect=never))
    await first.initialize()
    detail = await first.start_run()
    run_id = detail["run"]["runId"]
    await eventually(
        lambda: run_id in logs.snapshots and logs.snapshots[run_id]["workflowContext"]["x"] == 2
    )
    recovered, *_ = fixture(value=value, logs=copy.deepcopy(logs))
    await recovered.initialize()
    await eventually(lambda: recovered.get_run(run_id)["run"]["status"] == "passed")
    nodes = recovered.get_run(run_id)["nodeRuns"]
    assert sum(node["nodeId"] == "S1" for node in nodes) == 1
    assert sum(node["nodeId"] == "S2" for node in nodes) == 1
    assert next(node for node in nodes if node["nodeId"] == "C")["status"] == "passed"
    await recovered.close()
    await first.close()


async def test_structured_steps_and_operator_roundtrip() -> None:
    value = task()
    value["variables"] = [
        {"name": "index", "type": "number", "defaultValue": 0},
        {"name": "answer", "type": "string", "defaultValue": ""},
        {"name": "result", "type": "number", "defaultValue": 0},
    ]
    tool = {**value["steps"][0], "outputBindings": [{"pointer": "/value", "variable": "result"}]}
    value["steps"] = [
        step(
            "if",
            "IF",
            condition=literal(True),
            then=[step("delay", "D", durationMs=literal(0))],
            **{"else": []},
        ),
        step(
            "loop",
            "LOOP",
            mode="count",
            count=literal(2),
            maxIterations=2,
            indexVariable="index",
            body=[tool],
        ),
        step(
            "loop",
            "WHILE",
            mode="while",
            condition=literal(False),
            maxIterations=2,
            indexVariable="index",
            body=[],
        ),
        step(
            "operator",
            "OP",
            prompt="Choose",
            resultVariable="answer",
            options=[{"label": "Yes", "value": "yes"}, {"label": "No", "value": "no"}],
        ),
    ]
    service, logs, *_ = fixture(value=value)
    notifications: list[tuple[str, Any]] = []
    service.set_notifier(lambda name, payload: notifications.append((name, payload)))
    await service.initialize()
    detail = await service.start_run()
    run_id = detail["run"]["runId"]
    await eventually(lambda: bool(service.list_operator_decisions()))
    decision = service.list_operator_decisions()[0]
    with pytest.raises(ValueError, match="Unknown operator option"):
        await service.respond_operator_decision(decision["nodeRunId"], "unknown")
    response = await service.respond_operator_decision(
        decision["nodeRunId"], decision["options"][0]["value"]
    )
    assert response["status"] == "waiting_operator"
    await eventually(lambda: service.get_run(run_id)["run"]["status"] == "passed")
    assert service.list_operator_decisions() == []
    with pytest.raises(Exception, match="not active"):
        await service.respond_operator_decision(
            decision["nodeRunId"], decision["options"][0]["value"]
        )
    await service.close()
    assert logs.snapshots[run_id]["workflowContext"] == {
        "payload": "default",
        "index": 1,
        "answer": "yes",
        "result": 3.3,
    }
    assert any(name == "operator" for name, _ in notifications)
    assert [
        node["iterationPath"]
        for node in service.get_run(run_id)["nodeRuns"]
        if node["nodeId"] == "STEP1"
    ] == [[0], [1]]
    assert service.get_run(run_id, 2, 1, 1)["nodeTotal"] == len(service.get_run(run_id)["nodeRuns"])
    assert all(event["eventId"] > 2 for event in service.get_run(run_id, 2)["events"])


@pytest.mark.parametrize(
    ("value_step", "message"),
    [
        (step("delay", "D", durationMs=literal(-1)), "finite duration"),
        (
            step(
                "loop",
                "L",
                mode="count",
                count=literal(3),
                maxIterations=2,
                indexVariable="i",
                body=[],
            ),
            "between 0 and 2",
        ),
        (
            step(
                "loop",
                "L",
                mode="while",
                condition=literal(True),
                maxIterations=2,
                indexVariable="i",
                body=[],
            ),
            "maxIterations 2",
        ),
        (
            step(
                "set_variable",
                "S",
                variable="i",
                value={"kind": "variable", "path": "unknown.value"},
            ),
            "Unknown workflow variable",
        ),
    ],
)
async def test_execution_failure_details(value_step: Json, message: str) -> None:
    value = task()
    value["inputs"] = [{"name": "unknown", "type": "object", "defaultValue": {}}]
    value["variables"] = [{"name": "i", "type": "number", "defaultValue": 0}]
    value["steps"] = [value_step]
    service, *_ = fixture(value=value)
    await service.initialize()
    detail = await service.start_run()
    await eventually(lambda: service.get_run(detail["run"]["runId"])["run"]["status"] == "failed")
    assert message in service.get_run(detail["run"]["runId"])["run"]["summary"]["message"]
    await service.close()


async def test_operator_cancel_hardware_loss_and_active_log_permissions() -> None:
    value = task()
    value["steps"].append(
        step("operator", "OP", prompt="?", options=[{"label": "Yes", "value": True}])
    )
    service, _, execution, *_ = fixture(value=value)
    await service.initialize()
    detail = await service.start_run()
    run_id = detail["run"]["runId"]
    await eventually(lambda: bool(service.list_operator_decisions()))
    with pytest.raises(Exception, match="active and cannot be deleted"):
        await service.delete_run(run_id)
    assert await service.clear_completed_runs() == {"deleted": 0}
    await service.handle_hardware_lease_lost("HW1", "lease disappeared")
    assert service.get_run(run_id)["run"]["status"] == "cancelled"
    assert execution.current()["state"] == "idle"
    assert (await service.cancel_run(run_id))["status"] == "cancelled"
    await asyncio.gather(service.close(), service.close())
    service.clear_session()
    assert service.list_runs()["total"] == 0


async def test_parallel_failure_cancels_siblings_and_local_index() -> None:
    value = task()
    value["variables"] = [{"name": "i", "type": "number", "defaultValue": 42}]
    value["steps"] = [
        step(
            "parallel",
            "P",
            branches=[
                {
                    "branchId": "A",
                    "name": "A",
                    "steps": [
                        step(
                            "loop",
                            "L",
                            mode="count",
                            count=literal(1),
                            maxIterations=1,
                            indexVariable="i",
                            body=[],
                        ),
                        step("assert", "A", expression=literal(False), message="failed"),
                    ],
                },
                {
                    "branchId": "B",
                    "name": "B",
                    "steps": [step("delay", "D", durationMs=literal(30000))],
                },
            ],
        )
    ]
    value["cleanup"] = [
        step(
            "assert",
            "C",
            expression={
                "kind": "binary",
                "operator": "eq",
                "left": {"kind": "variable", "path": "i"},
                "right": literal(42),
            },
            message="branch leaked",
        )
    ]
    service, *_ = fixture(value=value)
    await service.initialize()
    detail = await service.start_run()
    await eventually(
        lambda: service.get_run(detail["run"]["runId"])["run"]["status"] in {"failed", "cancelled"}
    )
    assert (
        next(
            node
            for node in service.get_run(detail["run"]["runId"])["nodeRuns"]
            if node["nodeId"] == "C"
        )["status"]
        == "passed"
    )
    await service.close()


async def test_preflight_validation_and_task_update(monkeypatch: pytest.MonkeyPatch) -> None:
    service, _, _, projects, tools = fixture()
    assert service.get_task() == projects.task()
    assert service.update_task(task())["dirty"] is True
    invalid = task()
    invalid["steps"][0]["toolName"] = "missing"
    with pytest.raises(Exception, match="Task is invalid"):
        service.update_task(invalid)
    monkeypatch.setattr(
        tools,
        "list_tools",
        lambda: [{**tools_list, "kind": "management"} for tools_list in [task_tool()]],
    )
    assert "tool_not_hardware" in str(service.validate_task(task()))
    monkeypatch.setattr(service.catalog, "get_hardware", lambda _: {"kind": "passive"})
    assert "passive_tool_target" in str(service.validate_task(task()))
    monkeypatch.setattr(
        service.catalog, "get_hardware", lambda _: {"kind": "managed", "serverId": "OTHER"}
    )
    assert "tool_hardware_mismatch" in str(service.validate_task(task()))

    def absent(_: str) -> Json:
        raise ValueError("missing")

    monkeypatch.setattr(service.catalog, "get_hardware", absent)
    projects.value["inputs"] = [{"name": "required", "type": "number"}]
    await service.initialize()
    blocked = await service.start_run({"inputs": {"unknown": 1}})
    assert {"missing_run_input", "unknown_run_input", "unresolved_hardware"} <= {
        issue["code"] for issue in blocked["run"]["validationIssues"]
    }
    blocked2 = await service.start_run({"inputs": {"required": "wrong"}})
    assert "run_input_type" in str(blocked2)
    await service.close()
    monkeypatch.setattr(projects, "session", lambda: None)
    await service.initialize()
    with pytest.raises(Exception, match="No project is open"):
        await service.clear_completed_runs()


def task_tool() -> Json:
    from .test_service import TOOL

    return copy.deepcopy(TOOL)


async def test_missing_recovery_task_and_cleanup_failure() -> None:
    logs = MemoryLogs()
    logs.archives["R"] = archive("R", "running", "2026-01-01T00:00:00.000Z", "Old")
    logs.archives["R"]["run"]["taskId"] = "OTHER"
    service, *_ = fixture(logs=logs)
    await service.initialize()
    assert service.get_run("R")["run"]["status"] == "interrupted"
    assert service.get_run("R")["events"][-1]["data"]["reason"] == "missing_recovery_snapshot"
    assert any("snapshot is unavailable" in warning for warning in service.list_runs()["warnings"])
    await service.close()
    value = task()
    value["cleanup"] = [step("assert", "C", expression=literal(False), message="cleanup failed")]
    logs = MemoryLogs()
    logs.archives["R"] = archive("R", "running", "2026-01-01T00:00:00.000Z", "Old")
    service, *_ = fixture(value=value, logs=logs)
    await service.initialize()
    assert "recovery cleanup failed" in service.get_run("R")["run"]["summary"]["message"]
    await service.close()


def test_store_duplicates_paging_sorting_and_values() -> None:
    store = RunStore(lambda _: None)
    run = archive("R", "passed", "2026-01-01T00:00:00.000Z", "T2")
    run["nodeRuns"] = [
        {
            "nodeRunId": "N",
            "nodeId": "A",
            "runId": "R",
            "status": "passed",
            "branchPath": "root",
            "iterationPath": [],
        }
    ]
    store.load_archive(run)
    store.load_archive(run)
    other = archive("S", "failed", "2026-01-01T00:00:01.000Z", "T10")
    other["nodeRuns"] = copy.deepcopy(run["nodeRuns"])
    store.load_archive(other)
    assert any("duplicate Run archive" in warning for warning in store.warnings)
    assert any("duplicate nodeRunId" in warning for warning in store.warnings)
    assert store.list_runs()["taskNames"] == ["T10", "T2"]
    assert [
        item["taskName"]
        for item in store.list_runs({"sortBy": "taskName", "sortDir": "asc"})["items"]
    ] == ["T2", "T10"]
    assert store.list_runs({"sortBy": "failedNodes", "sortDir": "desc"})["items"][0]["runId"] == "S"
    assert len(store.list_runs({"sortBy": "duration"})["items"]) == 2
    assert store.get_run("R", 100, -2, 0)["nodeRuns"][0]["nodeRunId"] == "N"
    with pytest.raises(ValueError, match="Unknown nodeRunId"):
        store.get_node("missing")
    assert bounded_value(UNDEFINED) is UNDEFINED
    circular: Json = {}
    circular["self"] = circular
    assert bounded_value(circular)["unserializable"] is True
    assert normalize_error(AbortError("stop")) == {"category": "cancelled", "message": "stop"}
    assert (
        normalize_error(app_error("unavailable", "测" * 40000))["truncation"]["truncated"] is True
    )
    astral = bounded_value("😀" * 30000)
    assert astral["preview"].endswith("\ud83d")
    assert (
        len(
            astral["preview"]
            .encode("utf-16-le", "surrogatepass")
            .decode("utf-16-le", "replace")
            .encode("utf-8")
        )
        == 4000
    )


async def test_cancellation_and_noop_ports() -> None:
    controller = AbortController()
    calls: list[str] = []
    controller.signal.add_callback(lambda: calls.append("abort"))
    controller.abort(AbortError("stopped"))
    controller.abort()
    linked = AbortController(controller.signal)
    assert linked.signal.aborted and calls == ["abort"]
    with pytest.raises(AbortError, match="stopped"):
        await abortable_delay(1, linked.signal)
    with pytest.raises(AbortError, match="stopped"):
        await with_abort(asyncio.sleep(0), linked.signal)
    noop = NoopRunLogs()
    assert await noop.load("") == {"archives": [], "snapshots": [], "warnings": []}
    await noop.upsert_run("", {})
    await noop.upsert_node_run("", {})
    await noop.append_events("", "", [])
    await noop.upsert_execution_snapshot("", {})
    await noop.remove("", "")
    await noop.clear("", [])
    NoopExecution().acquire({}).release()


def test_xstate_snapshot_wire_shape() -> None:
    actor = RunMachine("R", "main", {"x": 1})
    assert actor.persisted_snapshot() == {
        "status": "active",
        "value": "running",
        "historyValue": {},
        "context": {"runId": "R", "phase": "main", "workflowContext": {"x": 1}},
        "children": {},
    }
    actor.send("CANCEL")
    restored = RunMachine("R", "main", {}, actor.persisted_snapshot())
    assert restored.value == "cancelling"
    restored.checkpoint("cleanup", {"x": 2})
    restored.send("FAIL", message="boom")
    assert restored.persisted_snapshot() == {
        "status": "done",
        "value": "failed",
        "historyValue": {},
        "context": {
            "runId": "R",
            "phase": "cleanup",
            "workflowContext": {"x": 2},
            "message": "boom",
        },
        "children": {},
    }


def test_electron_icu74_golden_collation() -> None:
    set_default_locale("zh-CN")
    values = [
        "中2",
        "中10",
        "中1",
        "重",
        "虫",
        "张",
        "赵",
        "Alpha2",
        "Alpha10",
        "alpha2",
        "é",
        "e",
        "É",
    ]

    def compare(a: str, b: str) -> int:
        return locale_compare(a, b, "zh", True)

    assert sorted(values, key=cmp_to_key(compare)) == [
        "虫",
        "张",
        "赵",
        "中1",
        "中2",
        "中10",
        "重",
        "alpha2",
        "Alpha2",
        "Alpha10",
        "é",
        "É",
        "e",
    ]

from __future__ import annotations

from typing import Any

import pytest

from hardwareharness_backend.orchestration import (
    create_workflow_context,
    evaluate_workflow_expression,
    get_workflow_path,
    resolve_workflow_value,
    validate_test_task,
)
from hardwareharness_backend.orchestration.machine import NodeMachine, RunMachine


@pytest.mark.ts_case(
    "packages/orchestration/src/workflow.test.ts::evaluates safe structured "
    "expressions and value templates"
)
def test_expressions_and_templates() -> None:
    context = {"voltage": 28.4, "limits": {"low": 27}, "flags": [True, False]}
    assert (
        evaluate_workflow_expression(
            {
                "kind": "logical",
                "operator": "and",
                "operands": [
                    {
                        "kind": "binary",
                        "operator": "gt",
                        "left": {"kind": "variable", "path": "voltage"},
                        "right": {"kind": "variable", "path": "limits.low"},
                    },
                    {
                        "kind": "unary",
                        "operator": "not",
                        "operand": {"kind": "literal", "value": False},
                    },
                ],
            },
            context,
        )
        is True
    )
    assert resolve_workflow_value(
        {"kind": "object", "entries": {"measured": {"kind": "variable", "path": "voltage"}}},
        context,
    ) == {"measured": 28.4}


@pytest.mark.ts_case(
    "packages/orchestration/src/workflow.test.ts::uses null-prototype contexts "
    "and rejects unsafe or undeclared paths"
)
def test_safe_context() -> None:
    task: dict[str, Any] = {
        "formatVersion": 2,
        "taskId": "TASK",
        "name": "Task",
        "inputs": [{"name": "input", "type": "object"}],
        "variables": [],
        "setup": [],
        "steps": [
            {
                "stepId": "A",
                "label": "Assert",
                "enabled": True,
                "type": "assert",
                "expression": {"kind": "variable", "path": "missing.value"},
                "message": "bad",
            }
        ],
        "cleanup": [],
    }
    context = create_workflow_context(task, {"input": {"value": 1}})
    assert type(context) is dict  # Python dictionaries have no JavaScript prototype inheritance.
    assert get_workflow_path(context, "input.value") == 1
    with pytest.raises(Exception, match="Unsafe"):
        get_workflow_path(context, "input.constructor")
    assert any(
        issue["code"] == "undeclared_variable" for issue in validate_test_task(task)["issues"]
    )


@pytest.mark.ts_case(
    "packages/orchestration/src/run-machine.test.ts::keeps interruption terminal "
    "even when execution completion races afterward"
)
def test_interruption_terminal() -> None:
    actor = RunMachine("RUN1", "main", {})
    actor.send("CANCEL")
    actor.send("INTERRUPT", message="Application shutdown")
    assert actor.value == "interrupted"
    assert actor.context["message"] == "Application shutdown"
    actor.send("PASS")
    assert actor.value == "interrupted"


@pytest.mark.ts_case(
    "packages/orchestration/src/run-machine.test.ts::restores a persisted active checkpoint"
)
def test_restore_machine() -> None:
    first = RunMachine("RUN2", "main", {"value": 1})
    first.checkpoint("cleanup", {"value": 2})
    restored = RunMachine("RUN2", "main", {}, first.persisted_snapshot())
    assert restored.value == "running"
    assert restored.context["phase"] == "cleanup"
    assert restored.context["workflowContext"] == {"value": 2}


@pytest.mark.ts_case(
    "packages/orchestration/src/run-machine.test.ts::models pending, waiting, "
    "skipped and terminal node states"
)
def test_node_states() -> None:
    skipped = NodeMachine()
    assert skipped.value == "pending"
    skipped.send("SKIP")
    assert skipped.value == "skipped"
    operator = NodeMachine()
    operator.send("START")
    operator.send("WAIT_OPERATOR")
    assert operator.value == "waiting_operator"
    operator.send("PASS")
    assert operator.value == "passed"

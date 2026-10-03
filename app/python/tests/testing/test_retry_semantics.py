from __future__ import annotations

from typing import Any

from teststand_backend.testing.compiler import compile_plan

from .test_testing import Resolver, plan_with


class ActuateResolver(Resolver):
    """``set`` is a non-idempotent actuation; everything else stays a safe read."""

    def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
        tool, issues = super().resolve(hardware_id, tool_name)
        if tool_name == "set":
            tool["operationSemantics"] = {
                **tool["operationSemantics"],
                "kind": "actuate",
                "retry": "never_after_dispatch",
            }
        return tool, issues


def invoke(step_id: str, tool_name: str) -> dict[str, Any]:
    return {
        "id": step_id,
        "type": "InvokeTool",
        "hardwareId": "dev",
        "toolName": tool_name,
        "arguments": {},
    }


def retry(*children: dict[str, Any]) -> dict[str, Any]:
    return {"id": "again", "type": "Retry", "maxAttempts": 3, "children": list(children)}


def unsafe(plan: dict[str, Any]) -> list[str]:
    issues = compile_plan(plan, ActuateResolver())["issues"]
    return [item["path"] for item in issues if item["code"] == "retry.unsafe"]


def test_retry_may_not_wrap_an_actuation_whose_outcome_can_be_unknown() -> None:
    # Design §7.2: once dispatched, a retried actuation could drive the bench twice.
    nested = {"id": "when", "type": "If", "condition": "true", "children": [invoke("s", "set")]}
    assert unsafe(plan_with(retry(nested))) == ["/regions/test/0/children/0/children/0"]
    assert unsafe(plan_with(retry(invoke("s", "set")))) == ["/regions/test/0/children/0"]


def test_retry_around_safe_reads_and_bare_actuations_compile() -> None:
    assert unsafe(plan_with(retry(invoke("r", "read")))) == []
    assert unsafe(plan_with(invoke("s", "set"))) == []

"""Plan-validation side of §7.5 captures and §7.7 setpoint evidence."""

from __future__ import annotations

from typing import Any

from teststand_backend.testing.compiler import compile_plan
from teststand_backend.testing.models import empty_plan
from teststand_backend.testing.validation import validate_plan

DESCRIPTORS: dict[str, dict[str, Any]] = {
    "ai0": {"id": "ai0", "type": "scalar", "kind": "measured", "unit": "V"},
    "ao0_set": {"id": "ao0_set", "type": "scalar", "kind": "setpoint", "unit": "V"},
    "rx": {"id": "rx", "type": "bytes"},
}


class Resolver:
    def __init__(self, *, descriptors: bool = True) -> None:
        self.descriptors = descriptors

    def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
        return {
            "bindingRevision": "rev",
            "inputSchema": {"type": "object"},
            "resultSchema": {},
            "operationSemantics": {"retry": "never"},
        }, []

    def streams(self, hardware_id: str) -> dict[str, str]:
        return {key: str(item["type"]) for key, item in DESCRIPTORS.items()}

    def stream_descriptors(self, hardware_id: str) -> dict[str, dict[str, Any]] | None:
        return DESCRIPTORS if self.descriptors else None


def plan_with(*steps: dict[str, Any]) -> dict[str, Any]:
    plan = empty_plan("Plan", "plan")
    plan["regions"]["test"] = [
        {
            "id": "send",
            "type": "InvokeTool",
            "hardwareId": "dev",
            "toolName": "send",
            "bindingRevision": "rev",
            "arguments": {},
            "anchor": "sent",
        },
        *steps,
    ]
    return plan


def expect(stream: str = "rx", **extra: Any) -> dict[str, Any]:
    return {
        "id": "answer",
        "type": "Expect",
        "hardwareId": "dev",
        "streamId": stream,
        "anchor": "sent",
        "withinMs": 500,
        "match": {"pattern": "CODE="} if stream == "rx" else {"op": "gt", "value": 1},
        **extra,
    }


def codes(issues: list[dict[str, Any]]) -> dict[str, str]:
    return {item["code"]: item["path"] for item in issues if item["severity"] == "error"}


def test_capture_spec_is_checked_against_the_stream_type() -> None:
    good = plan_with(expect(capture={"code": {"regex": r"CODE=(\d+)"}}))
    assert "expect.capture" not in codes(validate_plan(good, Resolver()))
    bad_group = plan_with(expect(capture={"code": {"regex": r"CODE=(\d+)", "group": 3}}))
    assert codes(validate_plan(bad_group, Resolver()))["expect.capture"] == (
        "/regions/test/1/capture"
    )
    no_text = plan_with(expect("ai0", capture={"v": {"regex": "(x)"}}))
    assert "expect.capture" in codes(validate_plan(no_text, Resolver()))


def test_captures_are_typed_outputs_for_later_steps() -> None:
    capture = {"code": {"regex": r"CODE=(\d+)"}}
    use = {
        "id": "report",
        "type": "PublishResult",
        "valueExpression": "int(steps.answer.captures.code)",
    }
    compiled = compile_plan(plan_with(expect(capture=capture), use), Resolver())
    assert not {
        item["code"] for item in compiled["issues"] if item["code"].startswith("expression.")
    }
    typo = {**use, "valueExpression": "steps.answer.captures.cod"}
    compiled = compile_plan(plan_with(expect(capture=capture), typo), Resolver())
    assert codes(compiled["issues"]).get("expression.field_missing") == (
        "/regions/test/2/valueExpression"
    )
    evidence = {**use, "valueExpression": "steps.answer.evidenceType == 'P'"}
    compiled = compile_plan(plan_with(expect(capture=capture), evidence), Resolver())
    assert not [item for item in compiled["issues"] if item["code"].startswith("expression.")]


def test_setpoint_streams_are_rejected_as_evidence() -> None:
    observe = {
        "id": "level",
        "type": "Observe",
        "hardwareId": "dev",
        "streamId": "ao0_set",
        "window": {"anchor": "sent", "endMs": 100},
        "assertions": [{"metric": "mean", "op": "gt", "value": 0}],
    }
    found = codes(validate_plan(plan_with(observe), Resolver()))
    assert found["evidence.setpoint"] == "/regions/test/1/streamId"
    assert "evidence.setpoint" in codes(validate_plan(plan_with(expect("ao0_set")), Resolver()))
    measured = {**observe, "streamId": "ai0"}
    assert "evidence.setpoint" not in codes(validate_plan(plan_with(measured), Resolver()))
    # Descriptors not listed yet: the run-time judge downgrades instead (judge._graded).
    unknown = Resolver(descriptors=False)
    assert "evidence.setpoint" not in codes(validate_plan(plan_with(observe), unknown))


def test_publish_result_evidence_grade_is_checked() -> None:
    def publish(**fields: Any) -> dict[str, Any]:
        return {"id": "report", "type": "PublishResult", "name": "report", "value": 1, **fields}

    assert "evidence.type" not in codes(validate_plan(plan_with(publish()), Resolver()))
    manual = publish(evidenceType="M", verdict="Pass")
    assert "evidence.type" not in codes(validate_plan(plan_with(manual), Resolver()))
    note = publish(evidenceType="note")
    assert codes(validate_plan(plan_with(note), Resolver()))["evidence.type"].endswith(
        "/evidenceType"
    )
    shadow = publish(evidenceType="S", verdict="Fail")
    assert "evidence.setpoint" in codes(validate_plan(plan_with(shadow), Resolver()))
    assert "evidence.setpoint" not in codes(
        validate_plan(plan_with(publish(evidenceType="S")), Resolver())
    )

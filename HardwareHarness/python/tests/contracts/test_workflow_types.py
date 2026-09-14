"""Static public-contract assertions; checked by mypy strict, including negative cases."""

from typing import TYPE_CHECKING, Literal, assert_never, assert_type

from hardwareharness_backend.compat import Undefined
from hardwareharness_backend.contracts.orchestration import TestStep as PublicTestStep
from hardwareharness_backend.contracts.workflow_types import (
    DelayStep,
    ErrorCategory,
    OperatorOption,
    ParallelBranch,
    RetryPolicy,
    TestStep,
    VariableBinding,
    WorkflowExpression,
    WorkflowValueTemplate,
)

if TYPE_CHECKING:

    def check_step(step: PublicTestStep) -> None:
        assert_type(step, TestStep)
        assert_type(step["stepId"], str)
        assert_type(step["label"], str)
        assert_type(step["enabled"], bool)
        if step["type"] == "tool":
            assert_type(step["toolName"], str)
            assert_type(step["hardwareId"], str)
            assert_type(step["arguments"], dict[str, WorkflowValueTemplate])
            assert_type(step["outputBindings"], list[VariableBinding])
            assert_type(step["timeoutMs"], float)
            assert_type(step["idempotent"], bool)
            assert_type(step["retry"], RetryPolicy)
            assert_type(step["retry"]["maxAttempts"], float)
            assert_type(step["retry"]["delayMs"], float)
            assert_type(step["retry"]["backoff"], Literal["fixed", "exponential"])
            assert_type(step["retry"]["retryOn"], list[ErrorCategory])
        elif step["type"] == "delay":
            assert_type(step["durationMs"], WorkflowValueTemplate)
        elif step["type"] == "set_variable":
            assert_type(step["variable"], str)
            assert_type(step["value"], WorkflowValueTemplate)
        elif step["type"] == "assert":
            assert_type(step["expression"], WorkflowExpression)
            assert_type(step["message"], str)
        elif step["type"] == "if":
            assert_type(step["condition"], WorkflowExpression)
            assert_type(step["then"], list[TestStep])
            assert_type(step["else"], list[TestStep])
        elif step["type"] == "loop":
            assert_type(step["mode"], Literal["count", "while"])
            assert_type(step["count"], WorkflowValueTemplate | Undefined)
            assert_type(step["condition"], WorkflowExpression | Undefined)
            assert_type(step["maxIterations"], float)
            assert_type(step["indexVariable"], str)
            assert_type(step["body"], list[TestStep])
        elif step["type"] == "parallel":
            assert_type(step["branches"], list[ParallelBranch])
            assert_type(step["branches"][0]["steps"], list[TestStep])
        elif step["type"] == "operator":
            assert_type(step["prompt"], str)
            assert_type(step["options"], list[OperatorOption])
            assert_type(step["resultVariable"], str | Undefined)
        else:
            assert_never(step)

    def check_template(template: WorkflowValueTemplate) -> None:
        if template["kind"] == "literal":
            assert_type(template["value"], object)
        elif template["kind"] == "variable":
            assert_type(template["path"], str)
        elif template["kind"] == "object":
            assert_type(template["entries"], dict[str, WorkflowValueTemplate])
        elif template["kind"] == "array":
            assert_type(template["items"], list[WorkflowValueTemplate])
        else:
            assert_never(template)

    def check_expression(expression: WorkflowExpression) -> None:
        if expression["kind"] == "literal":
            assert_type(expression["value"], object)
        elif expression["kind"] == "variable":
            assert_type(expression["path"], str)
        elif expression["kind"] == "unary":
            assert_type(expression["operator"], Literal["not", "negate"])
            assert_type(expression["operand"], WorkflowExpression)
        elif expression["kind"] == "binary":
            assert_type(expression["left"], WorkflowExpression)
            assert_type(expression["right"], WorkflowExpression)
        elif expression["kind"] == "logical":
            assert_type(expression["operator"], Literal["and", "or"])
            assert_type(expression["operands"], list[WorkflowExpression])
        else:
            assert_never(expression)

    # warn_unused_ignores makes the gate fail if these invalid declarations become accepted.
    missing_required: DelayStep = {"type": "delay"}  # type: ignore[typeddict-item]
    wrong_template: WorkflowValueTemplate = {"kind": "array", "items": [{"kind": "variable"}]}  # type: ignore[typeddict-item]
    wrong_category: ErrorCategory = "invented"  # type: ignore[assignment]

    def forbid_weak_fields(step: DelayStep) -> None:
        step["enabled"] = "true"  # type: ignore[typeddict-item]
        step["durationMs"] = 1000  # type: ignore[typeddict-item]
        step["toolName"] = "tool"  # type: ignore[typeddict-unknown-key]
        del step["stepId"]  # type: ignore[misc]

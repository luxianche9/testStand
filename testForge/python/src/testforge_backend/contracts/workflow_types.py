"""Public recursive workflow types corresponding to the TypeScript contracts."""

from typing import Literal, NotRequired, TypeAlias, TypedDict

from testforge_backend.compat import Undefined

ErrorCategory: TypeAlias = Literal[
    "permission_denied",
    "invalid_argument",
    "unavailable",
    "conflict",
    "not_found",
    "validation_failed",
    "requires_project",
    "safe_stop_failed",
    "invalid_response",
    "occupancy_required",
    "loop_limit",
    "assertion_failed",
    "project_exists",
    "invalid_project",
    "project_uninitialized",
    "invalid_project_folder",
    "cancelled",
    "error",
]


class LiteralTemplate(TypedDict):
    kind: Literal["literal"]
    value: NotRequired[object]


class VariableTemplate(TypedDict):
    kind: Literal["variable"]
    path: str


class ObjectTemplate(TypedDict):
    kind: Literal["object"]
    entries: dict[str, "WorkflowValueTemplate"]


class ArrayTemplate(TypedDict):
    kind: Literal["array"]
    items: list["WorkflowValueTemplate"]


WorkflowValueTemplate: TypeAlias = (
    LiteralTemplate | VariableTemplate | ObjectTemplate | ArrayTemplate
)


class UnaryExpression(TypedDict):
    kind: Literal["unary"]
    operator: Literal["not", "negate"]
    operand: "WorkflowExpression"


class BinaryExpression(TypedDict):
    kind: Literal["binary"]
    operator: Literal[
        "add", "subtract", "multiply", "divide", "modulo", "eq", "neq", "gt", "gte", "lt", "lte"
    ]
    left: "WorkflowExpression"
    right: "WorkflowExpression"


class LogicalExpression(TypedDict):
    kind: Literal["logical"]
    operator: Literal["and", "or"]
    operands: list["WorkflowExpression"]


WorkflowExpression: TypeAlias = (
    LiteralTemplate | VariableTemplate | UnaryExpression | BinaryExpression | LogicalExpression
)


class VariableBinding(TypedDict):
    variable: str
    pointer: str


class RetryPolicy(TypedDict):
    maxAttempts: float
    delayMs: float
    backoff: Literal["fixed", "exponential"]
    retryOn: list[ErrorCategory]


class StepBase(TypedDict):
    stepId: str
    label: str
    enabled: bool


class ToolStep(StepBase):
    type: Literal["tool"]
    toolName: str
    hardwareId: str
    arguments: dict[str, WorkflowValueTemplate]
    outputBindings: list[VariableBinding]
    timeoutMs: float
    idempotent: bool
    retry: RetryPolicy


class DelayStep(StepBase):
    type: Literal["delay"]
    durationMs: WorkflowValueTemplate


class SetVariableStep(StepBase):
    type: Literal["set_variable"]
    variable: str
    value: WorkflowValueTemplate


class AssertStep(StepBase):
    type: Literal["assert"]
    expression: WorkflowExpression
    message: str


IfStep = TypedDict(
    "IfStep",
    {
        "stepId": str,
        "label": str,
        "enabled": bool,
        "type": Literal["if"],
        "condition": WorkflowExpression,
        "then": list["TestStep"],
        "else": list["TestStep"],
    },
)


class LoopStep(StepBase):
    type: Literal["loop"]
    mode: Literal["count", "while"]
    count: NotRequired[WorkflowValueTemplate | Undefined]
    condition: NotRequired[WorkflowExpression | Undefined]
    maxIterations: float
    indexVariable: str
    body: list["TestStep"]


class ParallelBranch(TypedDict):
    branchId: str
    name: str
    steps: list["TestStep"]


class ParallelStep(StepBase):
    type: Literal["parallel"]
    branches: list[ParallelBranch]


class OperatorOption(TypedDict):
    label: str
    value: NotRequired[object]


class OperatorStep(StepBase):
    type: Literal["operator"]
    prompt: str
    options: list[OperatorOption]
    resultVariable: NotRequired[str | Undefined]


TestStep: TypeAlias = (
    ToolStep
    | DelayStep
    | SetVariableStep
    | AssertStep
    | IfStep
    | LoopStep
    | ParallelStep
    | OperatorStep
)

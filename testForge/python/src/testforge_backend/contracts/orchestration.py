from typing import Any, cast

from testforge_backend.compat import Record
from testforge_backend.contracts.errors import error_category_schema
from testforge_backend.contracts.validation import (
    Schema,
    array,
    boolean,
    custom_issue,
    discriminated,
    enum,
    lazy,
    literal,
    number,
    obj,
    parse_id_input,
    parse_record,
    record,
    string,
    unknown,
)
from testforge_backend.contracts.workflow_types import TestStep as TestStep

workflow_variable_definition_schema = obj(
    {
        "name": string(regex=r"^[A-Za-z_][A-Za-z0-9_]*$"),
        "type": enum("string", "number", "boolean", "object", "array", "unknown"),
        "defaultValue": unknown().optional(),
        "description": string().optional(),
    }
)
value_template_schema: Schema = lazy(
    lambda: discriminated(
        "kind",
        {
            "literal": obj({"kind": literal("literal"), "value": unknown()}),
            "variable": obj({"kind": literal("variable"), "path": string(1)}),
            "object": obj({"kind": literal("object"), "entries": record(value_template_schema)}),
            "array": obj({"kind": literal("array"), "items": array(value_template_schema)}),
        },
    )
)
expression_schema: Schema = lazy(
    lambda: discriminated(
        "kind",
        {
            "literal": obj({"kind": literal("literal"), "value": unknown()}),
            "variable": obj({"kind": literal("variable"), "path": string(1)}),
            "unary": obj(
                {
                    "kind": literal("unary"),
                    "operator": enum("not", "negate"),
                    "operand": expression_schema,
                }
            ),
            "binary": obj(
                {
                    "kind": literal("binary"),
                    "operator": enum(
                        "add",
                        "subtract",
                        "multiply",
                        "divide",
                        "modulo",
                        "eq",
                        "neq",
                        "gt",
                        "gte",
                        "lt",
                        "lte",
                    ),
                    "left": expression_schema,
                    "right": expression_schema,
                }
            ),
            "logical": obj(
                {
                    "kind": literal("logical"),
                    "operator": enum("and", "or"),
                    "operands": array(expression_schema, 1),
                }
            ),
        },
    )
)
variable_binding_schema = obj({"variable": string(1), "pointer": string().default("")})
_step_base = {"stepId": string(1), "label": string(1), "enabled": boolean().default(True)}
test_step_schema: Schema = lazy(
    lambda: discriminated(
        "type",
        {
            "tool": obj(
                {
                    **_step_base,
                    "type": literal("tool"),
                    "toolName": string(1),
                    "hardwareId": string(1),
                    "arguments": record(value_template_schema),
                    "outputBindings": array(variable_binding_schema),
                    "timeoutMs": number(100, 1_800_000, integer=True),
                    "idempotent": boolean().default(False),
                    "retry": obj(
                        {
                            "maxAttempts": number(1, 10, integer=True),
                            "delayMs": number(0, 300_000, integer=True),
                            "backoff": enum("fixed", "exponential").default("fixed"),
                            "retryOn": array(error_category_schema).default(["unavailable"]),
                        },
                        strict=True,
                    ),
                },
                strict=True,
            ),
            "delay": obj(
                {**_step_base, "type": literal("delay"), "durationMs": value_template_schema},
                strict=True,
            ),
            "set_variable": obj(
                {
                    **_step_base,
                    "type": literal("set_variable"),
                    "variable": string(1),
                    "value": value_template_schema,
                },
                strict=True,
            ),
            "assert": obj(
                {
                    **_step_base,
                    "type": literal("assert"),
                    "expression": expression_schema,
                    "message": string(),
                },
                strict=True,
            ),
            "if": obj(
                {
                    **_step_base,
                    "type": literal("if"),
                    "condition": expression_schema,
                    "then": array(test_step_schema),
                    "else": array(test_step_schema),
                },
                strict=True,
            ),
            "loop": obj(
                {
                    **_step_base,
                    "type": literal("loop"),
                    "mode": enum("count", "while"),
                    "count": value_template_schema.optional(),
                    "condition": expression_schema.optional(),
                    "maxIterations": number(1, 10_000, integer=True),
                    "indexVariable": string(1),
                    "body": array(test_step_schema),
                },
                strict=True,
            ),
            "parallel": obj(
                {
                    **_step_base,
                    "type": literal("parallel"),
                    "branches": array(
                        obj(
                            {
                                "branchId": string(1),
                                "name": string(1),
                                "steps": array(test_step_schema),
                            },
                            strict=True,
                        ),
                        2,
                    ),
                },
                strict=True,
            ),
            "operator": obj(
                {
                    **_step_base,
                    "type": literal("operator"),
                    "prompt": string(1),
                    "options": array(obj({"label": string(1), "value": unknown()}, strict=True), 1),
                    "resultVariable": string(1).optional(),
                },
                strict=True,
            ),
        },
    )
)
test_task_schema = obj(
    {
        "formatVersion": literal(2),
        "taskId": string(1),
        "name": string(1),
        "inputs": array(workflow_variable_definition_schema),
        "variables": array(workflow_variable_definition_schema),
        "setup": array(test_step_schema),
        "steps": array(test_step_schema),
        "cleanup": array(test_step_schema),
    }
)
RUN_STATUSES = ("blocked", "running", "cancelling", "passed", "failed", "cancelled", "interrupted")
NODE_STATUSES = (
    "pending",
    "running",
    "waiting_operator",
    "passed",
    "failed",
    "cancelled",
    "skipped",
)
STEP_TYPES = ("tool", "delay", "set_variable", "assert", "if", "loop", "parallel", "operator")
test_run_status_schema = enum(*RUN_STATUSES)
test_node_run_status_schema = enum(*NODE_STATUSES)
workflow_validation_issue_schema = obj(
    {
        "severity": enum("error", "warning"),
        "code": string(1),
        "message": string(),
        "nodeId": string().optional(),
        "edgeId": string().optional(),
    }
)
test_run_schema = obj(
    {
        "runId": string(1),
        "taskId": string(1),
        "taskName": string(1),
        "projectId": string(1),
        "status": test_run_status_schema,
        "inputs": record(unknown()),
        "createdAt": string(datetime=True),
        "startedAt": string(datetime=True).optional(),
        "completedAt": string(datetime=True).optional(),
        "cancelRequestedAt": string(datetime=True).optional(),
        "summary": obj(
            {
                "passedNodes": number(0, integer=True),
                "failedNodes": number(0, integer=True),
                "cancelledNodes": number(0, integer=True),
                "message": string().optional(),
            }
        ).optional(),
        "validationIssues": array(workflow_validation_issue_schema).optional(),
    }
)
test_node_run_schema = obj(
    {
        "nodeRunId": string(1),
        "runId": string(1),
        "nodeId": string(1),
        "nodeLabel": string(),
        "nodeType": enum(*STEP_TYPES),
        "status": test_node_run_status_schema,
        "branchPath": string(),
        "iterationPath": array(number(0, integer=True)),
        "attempt": number(1, integer=True),
        "attemptErrors": array(
            obj(
                {
                    "attempt": number(1, integer=True),
                    "category": error_category_schema,
                    "message": string(),
                    "timestamp": string(datetime=True),
                },
                strict=True,
            )
        ).optional(),
        "startedAt": string(datetime=True),
        "completedAt": string(datetime=True).optional(),
        "input": unknown().optional(),
        "output": unknown().optional(),
        "error": obj(
            {
                "category": string(),
                "message": string(),
                "truncation": obj(
                    {
                        "truncated": literal(True),
                        "bytes": number(0, integer=True),
                        "preview": string(),
                    }
                ).optional(),
            }
        ).optional(),
        "decision": obj(
            {
                "prompt": string(),
                "options": array(obj({"label": string(), "value": string()})),
                "selectedValue": string().optional(),
            }
        ).optional(),
    }
)
test_run_event_schema = obj(
    {
        "eventId": number(1, integer=True),
        "runId": string(1),
        "timestamp": string(datetime=True),
        "type": string(1),
        "data": unknown().optional(),
    }
)


def _archive_issues(value: Any) -> list[Record]:
    issues: list[Record] = []
    for collection, identifier, label in (
        ("nodeRuns", "nodeRunId", "node"),
        ("events", "eventId", "event"),
    ):
        ids: set[Any] = set()
        for index, item in enumerate(value[collection]):
            if item["runId"] != value["run"]["runId"]:
                issues.append(
                    custom_issue(
                        f"{label} Run id does not match archive Run", [collection, index, "runId"]
                    )
                )
            if item[identifier] in ids:
                issues.append(
                    custom_issue(f"duplicate {identifier}", [collection, index, identifier])
                )
            ids.add(item[identifier])
    return issues


test_run_log_archive_schema = obj(
    {
        "formatVersion": literal(1),
        "run": test_run_schema,
        "nodeRuns": array(test_node_run_schema),
        "events": array(test_run_event_schema),
    }
).refine(_archive_issues)
test_run_execution_snapshot_schema = obj(
    {
        "formatVersion": literal(1),
        "runId": string(1),
        "task": test_task_schema,
        "workflowContext": record(unknown()),
        "phase": enum("main", "cleanup"),
        "machine": unknown(),
        "updatedAt": string(datetime=True),
    },
    strict=True,
)
test_run_list_query_schema = obj(
    {
        "statuses": array(test_run_status_schema).optional(),
        "search": string(maximum=200).optional(),
        "from": string(datetime=True).optional(),
        "to": string(datetime=True).optional(),
        "taskName": string(1, 200).optional(),
        "sortBy": enum("createdAt", "taskName", "status", "duration", "failedNodes").default(
            "createdAt"
        ),
        "sortDir": enum("asc", "desc").default("desc"),
        "offset": number(0, integer=True).default(0),
        "limit": number(1, 200, integer=True).default(50),
    },
    strict=True,
)


def parse_test_task(value: Any) -> Record:
    return parse_record(test_task_schema, value)


def parse_test_step(value: Any) -> TestStep:
    return cast(TestStep, parse_record(test_step_schema, value))


def parse_test_run(value: Any) -> Record:
    return parse_record(test_run_schema, value)


def parse_test_node_run(value: Any) -> Record:
    return parse_record(test_node_run_schema, value)


def parse_test_run_event(value: Any) -> Record:
    return parse_record(test_run_event_schema, value)


def parse_test_run_log_archive(value: Any) -> Record:
    return parse_record(test_run_log_archive_schema, value)


def parse_test_run_execution_snapshot(value: Any) -> Record:
    return parse_record(test_run_execution_snapshot_schema, value)


def parse_test_run_list_query(value: Any) -> Record:
    return parse_record(test_run_list_query_schema, value)


parse_task_id_input = parse_id_input
parse_run_id_input = parse_id_input
parse_node_run_id_input = parse_id_input

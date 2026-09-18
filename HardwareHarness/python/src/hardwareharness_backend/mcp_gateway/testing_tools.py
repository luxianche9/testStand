from __future__ import annotations

from typing import Any

from hardwareharness_backend.contracts.validation import (
    Schema,
    array,
    discriminated,
    literal,
    number,
    obj,
    record,
    string,
    unknown,
)

Json = dict[str, Any]


def _field(kind: str, description: str, **options: Any) -> Json:
    return {"type": kind, "description": description, **options}


def _object(properties: Json, required: list[str] | None = None) -> Json:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


def _open_object(properties: Json, required: list[str] | None = None) -> Json:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": True,
    }


def _tool(
    name: str,
    description: str,
    capability: str,
    inputs: Json,
    output: Json,
    *,
    mutates: bool = False,
) -> Json:
    return {
        "capability": capability,
        "tool": {
            "name": name,
            "description": description,
            "inputSchema": inputs,
            "outputSchema": _object({"ok": {"const": True}, "data": output}, ["ok", "data"]),
            "annotations": {
                "readOnlyHint": not mutates,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
    }


_EMPTY = obj({}, strict=True)
_PLAN_ID = obj({"planId": string(1)}, strict=True)
_RUN_ID = obj({"runId": string(1)}, strict=True)
_REQUEST = string(1)
_STEP = record(unknown())
_REGION = string(1)
_OPERATION = discriminated(
    "type",
    {
        "set_plan_fields": obj(
            {"type": literal("set_plan_fields"), "patch": record(unknown())}, strict=True
        ),
        "set_parameters": obj(
            {"type": literal("set_parameters"), "parameters": array(record(unknown()))}, strict=True
        ),
        "insert_step": obj(
            {
                "type": literal("insert_step"),
                "region": _REGION.optional(),
                "parentId": string(1).optional(),
                "branch": string(1).optional(),
                "index": number(0, integer=True).optional(),
                "step": _STEP,
            },
            strict=True,
        ),
        "update_step": obj(
            {"type": literal("update_step"), "stepId": string(1), "patch": record(unknown())},
            strict=True,
        ),
        "move_step": obj(
            {
                "type": literal("move_step"),
                "stepId": string(1),
                "region": _REGION.optional(),
                "parentId": string(1).optional(),
                "branch": string(1).optional(),
                "index": number(0, integer=True).optional(),
            },
            strict=True,
        ),
        "set_step_enabled": obj(
            {
                "type": literal("set_step_enabled"),
                "stepId": string(1),
                "enabled": Schema("boolean"),
            },
            strict=True,
        ),
        "remove_step": obj({"type": literal("remove_step"), "stepId": string(1)}, strict=True),
        "bind_invoke_tool": obj(
            {
                "type": literal("bind_invoke_tool"),
                "stepId": string(1),
                "hardwareId": string(1),
                "toolName": string(1),
            },
            strict=True,
        ),
        "refresh_invoke_binding": obj(
            {"type": literal("refresh_invoke_binding"), "stepId": string(1)}, strict=True
        ),
    },
)
_OPERATIONS = array(_OPERATION)
_ISSUE_OUTPUT = _object(
    {
        "severity": _field("string", "Issue severity.", enum=["error", "warning"]),
        "code": _field("string", "Stable issue code."),
        "message": _field("string", "Human-readable issue."),
        "path": _field("string", "JSON pointer into the plan."),
    },
    ["severity", "code", "message", "path"],
)
_PLAN_OUTPUT = _open_object(
    {
        "schemaVersion": {"const": 2},
        "id": {"type": "string"},
        "name": {"type": "string"},
        "revision": {"type": "integer"},
        "regions": {"type": "object"},
    },
    ["schemaVersion", "id", "name", "revision", "regions"],
)
_RUN_OUTPUT = _open_object(
    {
        "runId": {"type": "string"},
        "planId": {"type": "string"},
        "revision": {"type": "integer"},
        "state": {"type": "string"},
        "verdict": {
            "type": "string",
            "enum": ["NotSet", "Pass", "Inconclusive", "Fail", "Aborted", "Error"],
        },
        "sequence": {"type": "integer"},
        "resultSequence": {"type": "integer"},
        "currentStepId": {"type": "string"},
        "activeExecutionIds": {"type": "array", "items": {"type": "string"}},
        "executionRevision": {"type": ["string", "null"]},
        "executionStatus": {
            "type": "string",
            "enum": ["Running", "Succeeded", "Failed", "Aborted"],
        },
        "cleanupStatus": {
            "type": "string",
            "enum": ["NotRequired", "Succeeded", "Recovered", "Failed", "Unknown"],
        },
        "safetyStatus": {
            "type": "string",
            "enum": ["NotRequired", "Pending", "Verified", "Failed", "Unknown"],
        },
        "outcomeKnown": {"type": "boolean"},
        "recoveryRequired": {"type": "boolean"},
        "primaryError": _open_object(
            {
                "phase": {"type": "string"},
                "category": {"type": "string"},
                "message": {"type": "string"},
                "recovered": {"type": "boolean"},
                "stepId": {"type": "string"},
                "hardwareId": {"type": "string"},
                "toolName": {"type": "string"},
                "operationId": {"type": "string"},
            },
            ["phase", "category", "message", "recovered"],
        ),
        "legacyClassification": {"type": "boolean"},
        "operations": {
            "type": "array",
            "items": _open_object(
                {
                    "operationId": {"type": "string"},
                    "runId": {"type": "string"},
                    "hardwareId": {"type": "string"},
                    "toolName": {"type": "string"},
                    "stepId": {"type": "string"},
                    "executionId": {"type": "string"},
                    "state": {"type": "string"},
                    "outcomeKnown": {"type": "boolean"},
                    "recoveryRequired": {"type": "boolean"},
                    "resolvedByOperationId": {"type": "string"},
                    "resolvedAt": {"type": "string"},
                },
                [
                    "operationId",
                    "runId",
                    "hardwareId",
                    "toolName",
                    "state",
                    "outcomeKnown",
                    "recoveryRequired",
                ],
            ),
        },
    },
    [
        "runId",
        "planId",
        "revision",
        "state",
        "verdict",
        "sequence",
        "resultSequence",
        "executionStatus",
        "cleanupStatus",
        "safetyStatus",
        "outcomeKnown",
        "recoveryRequired",
    ],
)
_PLAN_CHANGE_OUTPUT = _object(
    {"plan": _PLAN_OUTPUT, "issues": {"type": "array", "items": _ISSUE_OUTPUT}},
    ["plan", "issues"],
)


def _operation_json_schema() -> Json:
    common_target = {
        "region": {"type": "string", "enum": ["prepare", "test", "cleanup"]},
        "parentId": {"type": "string"},
        "branch": {"type": "string", "enum": ["children", "elseChildren"]},
        "index": {"type": "integer", "minimum": 0},
    }
    choices = [
        _object(
            {"type": {"const": "set_plan_fields"}, "patch": {"type": "object"}}, ["type", "patch"]
        ),
        _object(
            {
                "type": {"const": "set_parameters"},
                "parameters": {"type": "array", "items": {"type": "object"}},
            },
            ["type", "parameters"],
        ),
        _object(
            {"type": {"const": "insert_step"}, **common_target, "step": {"type": "object"}},
            ["type", "step"],
        ),
        _object(
            {
                "type": {"const": "update_step"},
                "stepId": {"type": "string"},
                "patch": {"type": "object"},
            },
            ["type", "stepId", "patch"],
        ),
        _object(
            {"type": {"const": "move_step"}, "stepId": {"type": "string"}, **common_target},
            ["type", "stepId"],
        ),
        _object(
            {
                "type": {"const": "set_step_enabled"},
                "stepId": {"type": "string"},
                "enabled": {"type": "boolean"},
            },
            ["type", "stepId", "enabled"],
        ),
        _object(
            {"type": {"const": "remove_step"}, "stepId": {"type": "string"}}, ["type", "stepId"]
        ),
        _object(
            {
                "type": {"const": "bind_invoke_tool"},
                "stepId": {"type": "string"},
                "hardwareId": {"type": "string"},
                "toolName": {"type": "string"},
            },
            ["type", "stepId", "hardwareId", "toolName"],
        ),
        _object(
            {"type": {"const": "refresh_invoke_binding"}, "stepId": {"type": "string"}},
            ["type", "stepId"],
        ),
    ]
    for choice in choices:
        for name, field in choice.get("properties", {}).items():
            field.setdefault("description", f"Operation {name} field.")
    return {"oneOf": choices, "discriminator": {"propertyName": "type"}}


TESTING_ARGUMENT_SCHEMAS: dict[str, Schema] = {
    "list_test_plans": _EMPTY,
    "get_test_plan": _PLAN_ID,
    "get_test_step_catalog": _EMPTY,
    "list_test_device_tools": obj({"hardwareId": string(1)}, strict=True),
    "validate_test_plan": _PLAN_ID,
    "get_test_run": _RUN_ID,
    "list_test_runs": obj(
        {
            "cursor": string(1).optional(),
            "limit": number(1, 200, integer=True).default(50),
            "planId": string(1).optional(),
            "verdict": string(1).optional(),
            "state": string(1).optional(),
            "from": string(1).optional(),
            "to": string(1).optional(),
        },
        strict=True,
    ),
    "read_test_run_events": obj(
        {
            "runId": string(1),
            "afterEventSequence": number(0, integer=True).default(0),
            "afterResultSequence": number(0, integer=True).default(0),
            "eventLimit": number(1, 5000, integer=True).default(1000),
            "resultLimit": number(1, 5000, integer=True).default(1000),
        },
        strict=True,
    ),
    "read_test_run_results": obj(
        {"runId": string(1), "afterSequence": number(0, integer=True).default(0)}, strict=True
    ),
    "wait_for_test_run": obj(
        {
            "runId": string(1),
            "afterSequence": number(0, integer=True).default(0),
            "timeoutMs": number(1, 30000, integer=True).default(30000),
        },
        strict=True,
    ),
    "create_test_plan": obj(
        {
            "requestId": _REQUEST,
            "id": string(1).optional(),
            "name": string(1),
            "description": string().default(""),
            "parameters": array(record(unknown())).default([]),
        },
        strict=True,
    ),
    "apply_test_plan_operations": obj(
        {
            "planId": string(1),
            "baseRevision": number(1, integer=True),
            "requestId": _REQUEST,
            "operations": _OPERATIONS,
        },
        strict=True,
    ),
    "start_test_run": obj(
        {
            "planId": string(1),
            "revision": number(1, integer=True),
            "executionRevision": string(1),
            "requestId": _REQUEST,
            "parameters": record(unknown()).default({}),
        },
        strict=True,
    ),
    "pause_test_run": _RUN_ID,
    "resume_test_run": _RUN_ID,
    "abort_test_run": _RUN_ID,
    "list_test_recovery_items": _EMPTY,
    "reconcile_test_operation": obj(
        {
            "operationId": string(1),
            "resolution": string(1),
            "note": string().default(""),
        },
        strict=True,
    ),
}

TESTING_TOOL_DEFINITIONS = [
    _tool(
        "list_test_plans",
        "List saved test plans with revision, validity and step count.",
        "testing.read",
        _object({}),
        {"type": "array", "items": _open_object({}, [])},
    ),
    _tool(
        "get_test_plan",
        "Read one complete saved test plan. Re-read before generating revisioned operations.",
        "testing.read",
        _object({"planId": _field("string", "Saved plan id.")}, ["planId"]),
        _PLAN_OUTPUT,
    ),
    _tool(
        "get_test_step_catalog",
        "Read built-in and trusted plugin step contracts.",
        "testing.read",
        _object({}),
        {"type": "array", "items": _open_object({}, [])},
    ),
    _tool(
        "list_test_device_tools",
        "List original MCP tool names and current schemas for one concrete hardwareId.",
        "testing.read",
        _object(
            {"hardwareId": _field("string", "Concrete managed HH hardware id.")}, ["hardwareId"]
        ),
        _object(
            {
                "hardwareId": {"type": "string"},
                "tools": {"type": "array", "items": _open_object({}, [])},
                "issues": {"type": "array", "items": _ISSUE_OUTPUT},
            },
            ["hardwareId", "tools", "issues"],
        ),
    ),
    _tool(
        "validate_test_plan",
        "Validate a saved plan against current devices, tools and schemas.",
        "testing.read",
        _object({"planId": _field("string", "Saved plan id.")}, ["planId"]),
        _object(
            {
                "planId": {"type": "string"},
                "revision": {"type": "integer"},
                "valid": {"type": "boolean"},
                "issues": {"type": "array", "items": _ISSUE_OUTPUT},
                "executionRevision": {"type": "string"},
                "wiringRevision": {"type": "string"},
                "coverage": {"type": "object"},
            },
            [
                "planId",
                "revision",
                "valid",
                "issues",
                "executionRevision",
                "wiringRevision",
                "coverage",
            ],
        ),
    ),
    _tool(
        "get_test_run",
        "Read current state and Verdict for a test run.",
        "testing.read",
        _object({"runId": _field("string", "Run id.")}, ["runId"]),
        _RUN_OUTPUT,
    ),
    _tool(
        "list_test_runs",
        "List current and historical test runs with stable cursor pagination and filters.",
        "testing.read",
        _object(
            {
                "cursor": _field("string", "Opaque cursor from the previous page."),
                "limit": _field("integer", "Page size.", minimum=1, maximum=200, default=50),
                "planId": _field("string", "Optional plan id filter."),
                "verdict": _field("string", "Optional Verdict filter."),
                "state": _field("string", "Optional run state filter."),
                "from": _field("string", "Inclusive ISO start time."),
                "to": _field("string", "Inclusive ISO end time."),
            }
        ),
        _object(
            {
                "items": {"type": "array", "items": _open_object({}, [])},
                "nextCursor": {"type": "string"},
            },
            ["items"],
        ),
    ),
    _tool(
        "read_test_run_events",
        "Read a run snapshot, immutable plan snapshot, incremental events and incremental results.",
        "testing.read",
        _object(
            {
                "runId": _field("string", "Run id."),
                "afterEventSequence": _field(
                    "integer", "Last consumed event sequence.", minimum=0, default=0
                ),
                "afterResultSequence": _field(
                    "integer", "Last consumed result sequence.", minimum=0, default=0
                ),
                "eventLimit": _field(
                    "integer",
                    "Maximum event rows in this page.",
                    minimum=1,
                    maximum=5000,
                    default=1000,
                ),
                "resultLimit": _field(
                    "integer",
                    "Maximum result rows in this page.",
                    minimum=1,
                    maximum=5000,
                    default=1000,
                ),
            },
            ["runId"],
        ),
        _object(
            {
                "run": _RUN_OUTPUT,
                "plan": _open_object({"regions": {"type": "object"}}, ["regions"]),
                "events": {"type": "array", "items": _open_object({}, [])},
                "results": {"type": "array", "items": _open_object({}, [])},
                "nextEventSequence": {"type": "integer"},
                "nextResultSequence": {"type": "integer"},
                "latestEventSequence": {"type": "integer"},
                "latestResultSequence": {"type": "integer"},
                "hasMoreEvents": {"type": "boolean"},
                "hasMoreResults": {"type": "boolean"},
            },
            [
                "run",
                "plan",
                "events",
                "results",
                "nextEventSequence",
                "nextResultSequence",
                "latestEventSequence",
                "latestResultSequence",
                "hasMoreEvents",
                "hasMoreResults",
            ],
        ),
    ),
    _tool(
        "read_test_run_results",
        "Read incremental published test results after a sequence number.",
        "testing.read",
        _object(
            {
                "runId": _field("string", "Run id."),
                "afterSequence": _field(
                    "integer", "Last consumed result sequence.", minimum=0, default=0
                ),
            },
            ["runId"],
        ),
        _object(
            {
                "runId": {"type": "string"},
                "results": {"type": "array", "items": _open_object({}, [])},
                "nextSequence": {"type": "integer"},
            },
            ["runId", "results", "nextSequence"],
        ),
    ),
    _tool(
        "wait_for_test_run",
        "Wait at most 30 seconds for new run events or completion.",
        "testing.read",
        _object(
            {
                "runId": _field("string", "Run id."),
                "afterSequence": _field(
                    "integer", "Last consumed event sequence.", minimum=0, default=0
                ),
                "timeoutMs": _field(
                    "integer",
                    "Long-poll timeout capped at 30000 ms.",
                    minimum=1,
                    maximum=30000,
                    default=30000,
                ),
            },
            ["runId"],
        ),
        _object(
            {
                "run": _RUN_OUTPUT,
                "events": {"type": "array", "items": _open_object({}, [])},
            },
            ["run", "events"],
        ),
    ),
    _tool(
        "create_test_plan",
        "Create a YAML test plan. requestId makes retries idempotent.",
        "testing.manage",
        _object(
            {
                "requestId": _field("string", "Unique idempotency key."),
                "id": _field("string", "Optional stable plan id."),
                "name": _field("string", "Plan name."),
                "description": _field("string", "Plan description."),
                "parameters": _field(
                    "array", "Typed run parameter definitions.", items={"type": "object"}
                ),
            },
            ["requestId", "name"],
        ),
        _PLAN_CHANGE_OUTPUT,
        mutates=True,
    ),
    _tool(
        "apply_test_plan_operations",
        "Atomically apply structured incremental operations to a saved revision. "
        "Never replace whole YAML.",
        "testing.manage",
        _object(
            {
                "planId": _field("string", "Plan id."),
                "baseRevision": _field("integer", "Revision returned by the latest read."),
                "requestId": _field("string", "Unique idempotency key."),
                "operations": _field(
                    "array", "Ordered structured operations.", items=_operation_json_schema()
                ),
            },
            ["planId", "baseRevision", "requestId", "operations"],
        ),
        _object(
            {
                "plan": _PLAN_OUTPUT,
                "issues": {"type": "array", "items": _ISSUE_OUTPUT},
                "appliedOperations": {"type": "integer"},
            },
            ["plan", "issues", "appliedOperations"],
        ),
        mutates=True,
    ),
    _tool(
        "start_test_run",
        "Start a fully validated saved revision using concrete devices. "
        "requestId prevents duplicate physical runs.",
        "testing.execute",
        _object(
            {
                "planId": _field("string", "Plan id."),
                "revision": _field("integer", "Exactly the validated revision."),
                "executionRevision": _field(
                    "string", "Opaque revision returned by validate_test_plan."
                ),
                "requestId": _field("string", "Unique physical-run idempotency key."),
                "parameters": _field("object", "Typed runtime values."),
            },
            ["planId", "revision", "executionRevision", "requestId"],
        ),
        _RUN_OUTPUT,
        mutates=True,
    ),
    _tool(
        "pause_test_run",
        "Pause a run at its next cooperative step boundary.",
        "testing.execute",
        _object({"runId": _field("string", "Run id.")}, ["runId"]),
        _RUN_OUTPUT,
        mutates=True,
    ),
    _tool(
        "resume_test_run",
        "Resume a paused test run.",
        "testing.execute",
        _object({"runId": _field("string", "Run id.")}, ["runId"]),
        _RUN_OUTPUT,
        mutates=True,
    ),
    _tool(
        "abort_test_run",
        "Cancel active calls and enter the cleanup region.",
        "testing.execute",
        _object({"runId": _field("string", "Run id.")}, ["runId"]),
        _RUN_OUTPUT,
        mutates=True,
    ),
    _tool(
        "list_test_recovery_items",
        "List physical operations whose outcome or final safety state requires handling.",
        "testing.read",
        _object({}),
        {"type": "array", "items": _open_object({}, [])},
    ),
    _tool(
        "reconcile_test_operation",
        "Record an explicit operator reconciliation for an unresolved physical operation.",
        "testing.execute",
        _object(
            {
                "operationId": _field("string", "Persistent operation id."),
                "resolution": _field(
                    "string",
                    "Explicit verified resolution.",
                    enum=["confirmed_succeeded", "confirmed_failed", "safe_state_restored"],
                ),
                "note": _field("string", "Operator evidence or note."),
            },
            ["operationId", "resolution"],
        ),
        _open_object({}, []),
        mutates=True,
    ),
]


async def invoke_testing_tool(app: Any, context: Json, name: str, value: Json) -> Any:
    testing = app.testing
    if name == "list_test_plans":
        return testing.list_plans(context)
    if name == "get_test_plan":
        return testing.load_plan(context, value["planId"])
    if name == "get_test_step_catalog":
        return testing.list_step_catalog(context)
    if name == "list_test_device_tools":
        return testing.list_device_tools(context, value["hardwareId"])
    if name == "validate_test_plan":
        return testing.validate_plan(context, value["planId"])
    if name == "get_test_run":
        return testing.get_run(context, value["runId"])
    if name == "list_test_runs":
        return testing.list_runs(context, value)
    if name == "read_test_run_events":
        return testing.read_run_log(
            context,
            value["runId"],
            value["afterEventSequence"],
            value["afterResultSequence"],
            value["eventLimit"],
            value["resultLimit"],
        )
    if name == "read_test_run_results":
        return testing.read_run_results(context, value["runId"], value["afterSequence"])
    if name == "wait_for_test_run":
        return await testing.wait_for_run(
            context, value["runId"], value["afterSequence"], value["timeoutMs"]
        )
    if name == "create_test_plan":
        return await testing.create_plan(context, value)
    if name == "apply_test_plan_operations":
        return await testing.apply_plan_operations(context, value)
    if name == "start_test_run":
        return await testing.start_run(context, value)
    if name == "pause_test_run":
        return await testing.pause_run(context, value["runId"])
    if name == "resume_test_run":
        return await testing.resume_run(context, value["runId"])
    if name == "abort_test_run":
        return await testing.abort_run(context, value["runId"])
    if name == "list_test_recovery_items":
        return testing.list_recovery_items(context)
    if name == "reconcile_test_operation":
        return await testing.reconcile_operation(context, value)
    raise RuntimeError(f"Unknown testing tool: {name}")

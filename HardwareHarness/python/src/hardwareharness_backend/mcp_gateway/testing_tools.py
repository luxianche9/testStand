from __future__ import annotations

from typing import Any

from hardwareharness_backend.contracts.validation import (
    Schema,
    array,
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
_OPERATIONS = array(record(unknown()))
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
        "schemaVersion": {"const": 1},
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
    },
    ["runId", "planId", "revision", "state", "verdict", "sequence"],
)
_PLAN_CHANGE_OUTPUT = _object(
    {"plan": _PLAN_OUTPUT, "issues": {"type": "array", "items": _ISSUE_OUTPUT}},
    ["plan", "issues"],
)

TESTING_ARGUMENT_SCHEMAS: dict[str, Schema] = {
    "list_test_plans": _EMPTY,
    "get_test_plan": _PLAN_ID,
    "get_test_step_catalog": _EMPTY,
    "list_test_device_tools": obj({"hardwareId": string(1)}, strict=True),
    "validate_test_plan": _PLAN_ID,
    "get_test_run": _RUN_ID,
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
            "requestId": _REQUEST,
            "parameters": record(unknown()).default({}),
        },
        strict=True,
    ),
    "pause_test_run": _RUN_ID,
    "resume_test_run": _RUN_ID,
    "abort_test_run": _RUN_ID,
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
            },
            ["planId", "revision", "valid", "issues"],
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
                    "array", "Ordered structured operations.", items={"type": "object"}
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
                "requestId": _field("string", "Unique physical-run idempotency key."),
                "parameters": _field("object", "Typed runtime values."),
            },
            ["planId", "revision", "requestId"],
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
    raise RuntimeError(f"Unknown testing tool: {name}")

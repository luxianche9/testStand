"""Public MCP tools for structured test plans and runs."""

from __future__ import annotations

from typing import Any

from hardwareharness_backend.contracts.operations import WHOLE, Tool
from hardwareharness_backend.contracts.validation import (
    Schema,
    array,
    boolean,
    discriminated,
    enum,
    literal,
    number,
    obj,
    record,
    string,
    unknown,
)

Json = dict[str, Any]


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


_ANY_LIST = {"type": "array", "items": _open_object({}, [])}
_ISSUE_OUTPUT = _object(
    {
        "severity": {
            "type": "string",
            "description": "Issue severity.",
            "enum": ["error", "warning"],
        },
        "code": {"type": "string", "description": "Stable issue code."},
        "message": {"type": "string", "description": "Human-readable issue."},
        "path": {"type": "string", "description": "JSON pointer into the plan."},
    },
    ["severity", "code", "message", "path"],
)
_ISSUES = {"type": "array", "items": _ISSUE_OUTPUT}
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

_OPERATION_FIELDS = (
    "type",
    "patch",
    "parameters",
    "region",
    "parentId",
    "branch",
    "index",
    "step",
    "stepId",
    "enabled",
    "hardwareId",
    "toolName",
)
GLOSSARY = {name: f"Operation {name} field." for name in _OPERATION_FIELDS}


def _target(**fields: Schema) -> dict[str, Schema]:
    return {
        "region": enum("prepare", "test", "cleanup").optional(),
        "parentId": string(1).optional(),
        "branch": enum("children", "elseChildren").optional(),
        "index": number(0, integer=True).optional(),
        **fields,
    }


def _operation(name: str, **fields: Schema) -> Schema:
    return obj({"type": literal(name), **fields}, strict=True)


_OPERATION = discriminated(
    "type",
    {
        "set_plan_fields": _operation("set_plan_fields", patch=record(unknown())),
        "set_parameters": _operation("set_parameters", parameters=array(record(unknown()))),
        "insert_step": _operation("insert_step", **_target(step=record(unknown()))),
        "update_step": _operation("update_step", stepId=string(1), patch=record(unknown())),
        "move_step": _operation("move_step", stepId=string(1), **_target()),
        "set_step_enabled": _operation("set_step_enabled", stepId=string(1), enabled=boolean()),
        "remove_step": _operation("remove_step", stepId=string(1)),
        "bind_invoke_tool": _operation(
            "bind_invoke_tool", stepId=string(1), hardwareId=string(1), toolName=string(1)
        ),
        "refresh_invoke_binding": _operation("refresh_invoke_binding", stepId=string(1)),
    },
)
_EMPTY = obj({}, strict=True)
_SAVED_PLAN_ID = obj({"planId": string(1).describe("Saved plan id.")}, strict=True)
_RUN_ID = obj({"runId": string(1).describe("Run id.")}, strict=True)
_BATCH_OUTPUT = _open_object(
    {
        "batchId": {"type": "string"},
        "state": {
            "type": "string",
            "enum": ["running", "completed", "aborted", "error", "interrupted"],
        },
        "items": _ANY_LIST,
    },
    ["batchId", "state", "items"],
)


def _testing(*args: Any, **options: Any) -> Tool:
    return Tool(*args, **{**options, "glossary": GLOSSARY})


_READ: dict[str, Any] = {"read_only": True}
_MUTATE: dict[str, Any] = {"idempotent": True}

TESTING_TOOLS = [
    _testing(
        "list_test_plans",
        "List saved test plans with revision, validity and step count.",
        _EMPTY,
        _ANY_LIST,
        operation="testing.list_plans",
        **_READ,
    ),
    _testing(
        "get_test_plan",
        "Read one complete saved test plan. Re-read before generating revisioned operations.",
        _SAVED_PLAN_ID,
        _PLAN_OUTPUT,
        operation="testing.load_plan",
        fields=("planId",),
        **_READ,
    ),
    _testing(
        "get_test_step_catalog",
        "Read built-in and trusted plugin step contracts.",
        _EMPTY,
        _ANY_LIST,
        operation="testing.list_step_catalog",
        **_READ,
    ),
    _testing(
        "list_test_device_tools",
        "List original MCP tool names and current schemas for one concrete hardwareId.",
        obj({"hardwareId": string(1).describe("Concrete managed HH hardware id.")}, strict=True),
        _object(
            {"hardwareId": {"type": "string"}, "tools": _ANY_LIST, "issues": _ISSUES},
            ["hardwareId", "tools", "issues"],
        ),
        operation="testing.list_device_tools",
        fields=("hardwareId",),
        **_READ,
    ),
    _testing(
        "validate_test_plan",
        "Validate a saved plan against current devices, tools and schemas.",
        _SAVED_PLAN_ID,
        _object(
            {
                "planId": {"type": "string"},
                "revision": {"type": "integer"},
                "valid": {"type": "boolean"},
                "issues": _ISSUES,
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
        operation="testing.validate_plan",
        fields=("planId",),
        **_READ,
    ),
    _testing(
        "get_test_run",
        "Read current state and Verdict for a test run.",
        _RUN_ID,
        _RUN_OUTPUT,
        operation="testing.get_run",
        fields=("runId",),
        **_READ,
    ),
    _testing(
        "list_test_runs",
        "List current and historical test runs with stable cursor pagination and filters.",
        obj(
            {
                "cursor": string(1).optional().describe("Opaque cursor from the previous page."),
                "limit": number(1, 200, integer=True).default(50).describe("Page size."),
                "planId": string(1).optional().describe("Optional plan id filter."),
                "verdict": string(1).optional().describe("Optional Verdict filter."),
                "state": string(1).optional().describe("Optional run state filter."),
                "from": string(1).optional().describe("Inclusive ISO start time."),
                "to": string(1).optional().describe("Inclusive ISO end time."),
            },
            strict=True,
        ),
        _object({"items": _ANY_LIST, "nextCursor": {"type": "string"}}, ["items"]),
        operation="testing.list_runs",
        fields=(WHOLE,),
        **_READ,
    ),
    _testing(
        "read_test_run_events",
        "Read a run snapshot, immutable plan snapshot, incremental events and incremental results.",
        obj(
            {
                "runId": string(1).describe("Run id."),
                "afterEventSequence": number(0, integer=True)
                .default(0)
                .describe("Last consumed event sequence."),
                "afterResultSequence": number(0, integer=True)
                .default(0)
                .describe("Last consumed result sequence."),
                "eventLimit": number(1, 5000, integer=True)
                .default(1000)
                .describe("Maximum event rows in this page."),
                "resultLimit": number(1, 5000, integer=True)
                .default(1000)
                .describe("Maximum result rows in this page."),
            },
            strict=True,
        ),
        _object(
            {
                "run": _RUN_OUTPUT,
                "plan": _open_object({"regions": {"type": "object"}}, ["regions"]),
                "events": _ANY_LIST,
                "results": _ANY_LIST,
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
        operation="testing.read_run_log",
        fields=("runId", "afterEventSequence", "afterResultSequence", "eventLimit", "resultLimit"),
        **_READ,
    ),
    _testing(
        "read_test_run_results",
        "Read incremental published test results after a sequence number.",
        obj(
            {
                "runId": string(1).describe("Run id."),
                "afterSequence": number(0, integer=True)
                .default(0)
                .describe("Last consumed result sequence."),
            },
            strict=True,
        ),
        _object(
            {
                "runId": {"type": "string"},
                "results": _ANY_LIST,
                "nextSequence": {"type": "integer"},
            },
            ["runId", "results", "nextSequence"],
        ),
        operation="testing.read_run_results",
        fields=("runId", "afterSequence"),
        **_READ,
    ),
    _testing(
        "wait_for_test_run",
        "Wait at most 30 seconds for new run events or completion.",
        obj(
            {
                "runId": string(1).describe("Run id."),
                "afterSequence": number(0, integer=True)
                .default(0)
                .describe("Last consumed event sequence."),
                "timeoutMs": number(1, 30000, integer=True)
                .default(30000)
                .describe("Long-poll timeout capped at 30000 ms."),
            },
            strict=True,
        ),
        _object({"run": _RUN_OUTPUT, "events": _ANY_LIST}, ["run", "events"]),
        operation="testing.wait_for_run",
        fields=("runId", "afterSequence", "timeoutMs"),
        **_READ,
    ),
    _testing(
        "create_test_plan",
        "Create a YAML test plan. requestId makes retries idempotent.",
        obj(
            {
                "requestId": string(1).describe("Unique idempotency key."),
                "id": string(1).optional().describe("Optional stable plan id."),
                "name": string(1).describe("Plan name."),
                "description": string().default("").describe("Plan description."),
                "parameters": array(record(unknown()))
                .default([])
                .describe("Typed run parameter definitions."),
            },
            strict=True,
        ),
        _object({"plan": _PLAN_OUTPUT, "issues": _ISSUES}, ["plan", "issues"]),
        operation="testing.create_plan",
        fields=(WHOLE,),
        **_MUTATE,
    ),
    _testing(
        "apply_test_plan_operations",
        "Atomically apply structured incremental operations to a saved revision. "
        "Never replace whole YAML.",
        obj(
            {
                "planId": string(1).describe("Plan id."),
                "baseRevision": number(1, integer=True).describe(
                    "Revision returned by the latest read."
                ),
                "requestId": string(1).describe("Unique idempotency key."),
                "operations": array(_OPERATION).describe("Ordered structured operations."),
            },
            strict=True,
        ),
        _object(
            {
                "plan": _PLAN_OUTPUT,
                "issues": _ISSUES,
                "appliedOperations": {"type": "integer"},
            },
            ["plan", "issues", "appliedOperations"],
        ),
        operation="testing.apply_plan_operations",
        fields=(WHOLE,),
        **_MUTATE,
    ),
    _testing(
        "start_test_run",
        "Start a fully validated saved revision using concrete devices. "
        "requestId prevents duplicate physical runs.",
        obj(
            {
                "planId": string(1).describe("Plan id."),
                "revision": number(1, integer=True).describe("Exactly the validated revision."),
                "executionRevision": string(1).describe(
                    "Opaque revision returned by validate_test_plan."
                ),
                "requestId": string(1).describe("Unique physical-run idempotency key."),
                "parameters": record(unknown()).default({}).describe("Typed runtime values."),
            },
            strict=True,
        ),
        _RUN_OUTPUT,
        operation="testing.start_run",
        fields=(WHOLE,),
        **_MUTATE,
    ),
    _testing(
        "pause_test_run",
        "Pause a run at its next cooperative step boundary.",
        _RUN_ID,
        _RUN_OUTPUT,
        operation="testing.pause_run",
        fields=("runId",),
        **_MUTATE,
    ),
    _testing(
        "resume_test_run",
        "Resume a paused test run.",
        _RUN_ID,
        _RUN_OUTPUT,
        operation="testing.resume_run",
        fields=("runId",),
        **_MUTATE,
    ),
    _testing(
        "abort_test_run",
        "Cancel active calls and enter the cleanup region.",
        _RUN_ID,
        _RUN_OUTPUT,
        operation="testing.abort_run",
        fields=("runId",),
        **_MUTATE,
    ),
    _testing(
        "list_test_recovery_items",
        "List physical operations whose outcome or final safety state requires handling.",
        _EMPTY,
        _ANY_LIST,
        operation="testing.list_recovery_items",
        **_READ,
    ),
    _testing(
        "reconcile_test_operation",
        "Record an explicit operator reconciliation for an unresolved physical operation.",
        obj(
            {
                "operationId": string(1).describe("Persistent operation id."),
                "resolution": enum(
                    "confirmed_succeeded", "confirmed_failed", "safe_state_restored"
                ).describe("Explicit verified resolution."),
                "note": string().default("").describe("Operator evidence or note."),
            },
            strict=True,
        ),
        _open_object({}, []),
        operation="testing.reconcile_operation",
        fields=(WHOLE,),
        **_MUTATE,
    ),
    _testing(
        "get_test_item_status",
        "Read every functional test item (one plan each) with its latest verdict for the "
        "current unit under test. stale=true means the plan changed after that run.",
        _EMPTY,
        _open_object({"unit": _open_object({}, []), "items": _ANY_LIST}, ["unit", "items"]),
        operation="testing.list_item_status",
        **_READ,
    ),
    _testing(
        "start_test_unit",
        "Begin a new unit under test (a new physical product). Item verdicts reset to untested.",
        obj(
            {"serialNumber": string().default("").describe("Optional unit serial number.")},
            strict=True,
        ),
        _open_object({"unitId": {"type": "string"}}, ["unitId"]),
        operation="testing.start_unit",
        fields=(WHOLE,),
        **_MUTATE,
    ),
    _testing(
        "start_test_batch",
        "Run several functional test items one after another with default parameters. "
        "All items are prechecked first. Fail continues unless stopOnFail; Error or Aborted "
        "always stops the batch. requestId makes retries idempotent.",
        obj(
            {
                "requestId": string(1).describe("Unique physical-run idempotency key."),
                "planIds": array(string(1), 1).describe("Ordered test item plan ids."),
                "stopOnFail": boolean().default(False).describe("Stop after the first Fail."),
            },
            strict=True,
        ),
        _BATCH_OUTPUT,
        operation="testing.start_batch",
        fields=(WHOLE,),
        **_MUTATE,
    ),
    _testing(
        "wait_for_test_batch",
        "Wait at most 30 seconds for a batch to finish and return its current state.",
        obj(
            {
                "batchId": string(1).describe("Batch id."),
                "timeoutMs": number(1, 30000, integer=True)
                .default(30000)
                .describe("Long-poll timeout capped at 30000 ms."),
            },
            strict=True,
        ),
        _BATCH_OUTPUT,
        operation="testing.wait_for_batch",
        fields=("batchId", "timeoutMs"),
        **_READ,
    ),
    _testing(
        "abort_test_batch",
        "Abort the active run of a batch and skip its remaining items.",
        obj({"batchId": string(1).describe("Batch id.")}, strict=True),
        _BATCH_OUTPUT,
        operation="testing.abort_batch",
        fields=("batchId",),
        **_MUTATE,
    ),
]

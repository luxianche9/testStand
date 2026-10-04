"""Public MCP tools for structured test plans and runs."""

from __future__ import annotations

from typing import Any

from teststand_backend.contracts.operations import WHOLE, Tool
from teststand_backend.contracts.validation import (
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
_ICD_NAME = obj({"name": string(1).describe("ICD name (file icd/<name>.icd.yaml).")}, strict=True)
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


TESTING_TOOLS = [
    _testing(
        "list_test_plans",
        "List saved test plans with revision, validity and step count.",
        _EMPTY,
        _ANY_LIST,
        operation="testing.listPlans",
    ),
    _testing(
        "get_test_plan",
        "Read one complete saved test plan. Re-read before generating revisioned operations.",
        _SAVED_PLAN_ID,
        _PLAN_OUTPUT,
        operation="testing.loadPlan",
        fields=("planId",),
    ),
    _testing(
        "get_test_step_catalog",
        "Read built-in and trusted plugin step contracts.",
        _EMPTY,
        _ANY_LIST,
        operation="testing.listStepCatalog",
    ),
    _testing(
        "list_test_device_tools",
        "List original MCP tool names and current schemas for one concrete hardwareId.",
        obj(
            {"hardwareId": string(1).describe("Concrete managed testStand hardware id.")},
            strict=True,
        ),
        _object(
            {"hardwareId": {"type": "string"}, "tools": _ANY_LIST, "issues": _ISSUES},
            ["hardwareId", "tools", "issues"],
        ),
        operation="testing.listDeviceTools",
        fields=("hardwareId",),
    ),
    _testing(
        "list_icds",
        "List the project's ICD files (icd/<name>.icd.yaml) with validity, hash and messages.",
        _EMPTY,
        _ANY_LIST,
        operation="testing.listIcds",
    ),
    _testing(
        "get_icd",
        "Read one ICD file's YAML text plus its messages, encoders and derived streams.",
        _ICD_NAME,
        _open_object({"name": {"type": "string"}, "text": {"type": "string"}}, ["name", "text"]),
        operation="testing.readIcd",
        fields=("name",),
    ),
    _testing(
        "check_icd",
        "Validate ICD YAML (unsaved text or a saved name) and trial-decode sample raw records. "
        "Use before save_icd and before binding it in a plan.",
        obj(
            {
                "text": string().optional().describe("ICD YAML text; omit to check name's file."),
                "name": string(1).optional().describe("Saved ICD name when text is omitted."),
                "alias": string(1).optional().describe("Alias for derived stream ids."),
                "samples": array(unknown())
                .default([])
                .describe("Raw records to decode: hex strings or {data, dir?, id?, t?} objects."),
            },
            strict=True,
        ),
        _open_object({"valid": {"type": "boolean"}}, ["valid"]),
        operation="testing.checkIcd",
        fields=(WHOLE,),
    ),
    _testing(
        "save_icd",
        "Write icd/<name>.icd.yaml. The text must be a valid ICD declaring the same name; "
        "an invalid ICD is rejected and nothing is written.",
        obj(
            {
                "name": string(1).describe("ICD name (file icd/<name>.icd.yaml)."),
                "text": string(1).describe("Complete ICD YAML text."),
            },
            strict=True,
        ),
        _open_object({"name": {"type": "string"}, "icd": _open_object({})}, ["name", "icd"]),
        operation="testing.saveIcd",
        fields=(WHOLE,),
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
        operation="testing.validatePlan",
        fields=("planId",),
    ),
    _testing(
        "get_test_run",
        "Read current state and Verdict for a test run.",
        _RUN_ID,
        _RUN_OUTPUT,
        operation="testing.getRun",
        fields=("runId",),
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
        operation="testing.listRuns",
        fields=(WHOLE,),
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
        operation="testing.readRunLog",
        fields=("runId", "afterEventSequence", "afterResultSequence", "eventLimit", "resultLimit"),
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
        operation="testing.readRunResults",
        fields=("runId", "afterSequence"),
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
        operation="testing.waitForRun",
        fields=("runId", "afterSequence", "timeoutMs"),
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
                "protocolBindings": array(record(unknown()))
                .optional()
                .describe(
                    "ICD bindings {icd, alias, source: {hardwareId, streamId}}; steps name "
                    "the derived streams as <alias>.<message>[.<field>]."
                ),
                "bindings": record(record(unknown()))
                .optional()
                .describe(
                    "Logical device names {name: {hardwareId, streamId?}}; a step's hardwareId "
                    "may name a binding. ${param} in a binding takes that run parameter, so a "
                    "batch can run the plan once per station."
                ),
            },
            strict=True,
        ),
        _object({"plan": _PLAN_OUTPUT, "issues": _ISSUES}, ["plan", "issues"]),
        operation="testing.createPlan",
        fields=(WHOLE,),
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
        operation="testing.applyPlanOperations",
        fields=(WHOLE,),
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
        operation="testing.startRun",
        fields=(WHOLE,),
    ),
    _testing(
        "pause_test_run",
        "Pause a run at its next cooperative step boundary.",
        _RUN_ID,
        _RUN_OUTPUT,
        operation="testing.pauseRun",
        fields=("runId",),
    ),
    _testing(
        "resume_test_run",
        "Resume a paused test run.",
        _RUN_ID,
        _RUN_OUTPUT,
        operation="testing.resumeRun",
        fields=("runId",),
    ),
    _testing(
        "abort_test_run",
        "Cancel active calls and enter the cleanup region.",
        _RUN_ID,
        _RUN_OUTPUT,
        operation="testing.abortRun",
        fields=("runId",),
    ),
    _testing(
        "testing_read_run_io",
        "Read what a run sent and saw: tool calls with arguments, results and backend "
        "times, verdict windows, guard violations, and every recorded stream (sampled "
        "streams as count/mean/min/max/p2p/std, byte/frame/event streams as records). "
        "With stepId only that step's executions and time span.",
        obj(
            {
                "runId": string(1).describe("Run id."),
                "stepId": string(1).optional().describe("Only this plan step."),
                "limit": number(1, 500, integer=True)
                .default(50)
                .describe("Records per byte/frame/event stream."),
            },
            strict=True,
        ),
        _open_object(
            {
                "runId": {"type": "string"},
                "calls": _ANY_LIST,
                "windows": _ANY_LIST,
                "violations": _ANY_LIST,
                "streams": _ANY_LIST,
            },
            ["runId", "calls", "windows", "violations", "streams"],
        ),
        operation="testing.readRunIo",
        fields=("runId", "stepId", "limit"),
    ),
    _testing(
        "testing_read_run_messages",
        "Read a run's protocol traffic: every frame on a protocol-bound stream decoded with "
        "the ICD frozen in the recording (raw hex, message name, fields, checksumOk), plus "
        "undecodable frames (kind error, with reason) and unframed bytes, in backend-time "
        "order. t0/t1 are backend times (tb) and bound the rows.",
        obj(
            {
                "runId": string(1).describe("Run id."),
                "t0": number().optional().describe("Earliest backend time (tb)."),
                "t1": number().optional().describe("Latest backend time (tb)."),
                "limit": number(1, 10_000, integer=True).default(200).describe("Most rows."),
            },
            strict=True,
        ),
        _open_object(
            {
                "runId": {"type": "string"},
                "bindings": _ANY_LIST,
                "messages": _ANY_LIST,
                "total": {"type": "integer"},
                "truncated": {"type": "boolean"},
            },
            ["runId", "bindings", "messages", "total", "truncated"],
        ),
        operation="testing.readRunMessages",
        arguments=lambda value: {
            "runId": value["runId"],
            "query": {
                key: value[key] for key in ("t0", "t1", "limit") if value.get(key) is not None
            },
        },
    ),
    _testing(
        "list_test_recovery_items",
        "List physical operations whose outcome or final safety state requires handling.",
        _EMPTY,
        _ANY_LIST,
        operation="testing.listRecoveryItems",
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
        operation="testing.reconcileOperation",
        fields=(WHOLE,),
    ),
    _testing(
        "get_test_item_status",
        "Read every functional test item (one plan each) with its latest verdict for the "
        "current unit under test. stale=true means the plan changed after that run.",
        _EMPTY,
        _open_object({"unit": _open_object({}, []), "items": _ANY_LIST}, ["unit", "items"]),
        operation="testing.listItemStatus",
    ),
    _testing(
        "start_test_batch",
        "Run several functional test items one after another with default parameters. "
        "With stations, every item runs once per station with those run parameters (they "
        "fill ${param} in plan bindings). All items are prechecked first. "
        "Fail continues unless stopOnFail; Error or Aborted "
        "always stops the batch. requestId makes retries idempotent.",
        obj(
            {
                "requestId": string(1).describe("Unique physical-run idempotency key."),
                "planIds": array(string(1), 1).describe("Ordered test item plan ids."),
                "stopOnFail": boolean().default(False).describe("Stop after the first Fail."),
                "stations": array(record(unknown()), 1)
                .optional()
                .describe("Run parameters per station, for example [{station: 1}, {station: 2}]."),
            },
            strict=True,
        ),
        _BATCH_OUTPUT,
        operation="testing.startBatch",
        fields=(WHOLE,),
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
        operation="testing.waitForBatch",
        fields=("batchId", "timeoutMs"),
    ),
    _testing(
        "abort_test_batch",
        "Abort the active run of a batch and skip its remaining items.",
        obj({"batchId": string(1).describe("Batch id.")}, strict=True),
        _BATCH_OUTPUT,
        operation="testing.abortBatch",
        fields=("batchId",),
    ),
]

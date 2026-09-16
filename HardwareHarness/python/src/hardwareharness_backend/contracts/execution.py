from typing import Any

from hardwareharness_backend.compat import Record
from hardwareharness_backend.contracts.validation import (
    array,
    literal,
    number,
    obj,
    parse_record,
    record,
    string,
    union,
    unknown,
)

_manual_fields = {
    "state": literal("manual"),
    "hardwareId": string(1),
    "toolName": string(1),
    "startedAt": string(datetime=True),
}
active_execution_activity_schema = obj(_manual_fields, strict=True)
_activities = {"activities": array(active_execution_activity_schema, 2).optional()}
execution_activity_schema = union(
    obj({"state": literal("idle")}, strict=True),
    obj({**_manual_fields, **_activities}),
)
manual_tool_invocation_input_schema = obj(
    {
        "hardwareId": string(1),
        "toolName": string(1),
        "arguments": record(unknown()).default({}),
        "timeoutMs": number(100, 1_800_000, integer=True).default(30_000),
    },
    strict=True,
)


def parse_manual_tool_invocation_input(value: Any) -> Record:
    return parse_record(manual_tool_invocation_input_schema, value)


def parse_execution_activity(value: Any) -> Record:
    return parse_record(execution_activity_schema, value)

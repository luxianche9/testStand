from typing import Any, cast

from hardwareharness_backend.compat import Record, clone, js_truthy
from hardwareharness_backend.contracts.validation import (
    array,
    discriminated,
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
_run_fields = {
    "state": literal("run"),
    "runId": string(1),
    "hardwareIds": array(string(1)),
    "startedAt": string(datetime=True),
}
active_execution_activity_schema = discriminated(
    "state", {"manual": obj(_manual_fields, strict=True), "run": obj(_run_fields, strict=True)}
)
_activities = {"activities": array(active_execution_activity_schema, 2).optional()}
execution_activity_schema = union(
    obj({"state": literal("idle")}, strict=True),
    obj({**_manual_fields, **_activities}),
    obj({**_run_fields, **_activities}),
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


def active_execution_activities(activity: Record | None) -> list[Record]:
    if not activity or activity["state"] == "idle":
        return []
    if js_truthy(activity.get("activities")):
        return [clone(item) for item in activity["activities"]]
    return [{key: value for key, value in activity.items() if key != "activities"}]


def execution_hardware_ids(activity: Record) -> list[str]:
    return (
        [activity["hardwareId"]]
        if activity["state"] == "manual"
        else cast(list[str], activity["hardwareIds"])
    )


def is_hardware_executing(
    activity: Record | None, hardware_id: str, state: str | None = None
) -> bool:
    return any(
        (not state or item["state"] == state) and hardware_id in execution_hardware_ids(item)
        for item in active_execution_activities(activity)
    )


def parse_manual_tool_invocation_input(value: Any) -> Record:
    return parse_record(manual_tool_invocation_input_schema, value)


def parse_execution_activity(value: Any) -> Record:
    return parse_record(execution_activity_schema, value)

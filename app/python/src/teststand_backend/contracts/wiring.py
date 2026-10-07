from typing import Any

from teststand_backend.contracts.validation import (
    array,
    boolean,
    enum,
    number,
    obj,
    parse_id_input,
    parse_record,
    string,
)
from teststand_backend.util import Record

wiring_action_schema = enum("connect", "disconnect")
pin_pair_schema = obj({"a": string(1), "b": string(1)})
project_wiring_connection_schema = obj(
    {
        "connectionId": string(1),
        "portA": string(1),
        "portB": string(1),
        "pins": array(pin_pair_schema).default([]),
        "confirmedAt": string(datetime=True),
        "confirmedBy": string(1),
    }
)
# The physical wiring: which pins are joined. Signals and their links are the signal view.
project_wiring_schema = obj({"connections": array(project_wiring_connection_schema)})
wiring_task_status_schema = enum("pending", "confirmed", "rejected", "cancelled", "failed")
wiring_outcome_schema = enum("confirmed", "rejected")
wiring_change_schema = obj(
    {
        "action": wiring_action_schema,
        "portA": string(1),
        "portB": string(1),
        "pins": array(pin_pair_schema).default([]),
    },
    strict=True,
)
# One task holds every change the operator answers at once.
request_wiring_task_input_schema = obj(
    {
        "changes": array(wiring_change_schema).default([]),
        "replaceAll": boolean().default(False),
        "note": string().optional(),
        "requestedBy": string(1).optional(),
    },
    strict=True,
)
wiring_task_list_query_schema = obj(
    {
        "status": wiring_task_status_schema.optional(),
        "limit": number(1, 500, integer=True).optional(),
    },
    strict=True,
)


def parse_project_wiring(value: Any) -> Record:
    return parse_record(project_wiring_schema, value)


def parse_request_wiring_task_input(value: Any) -> Record:
    """A request of ``changes``; one change's own fields (``action, portA, portB, pins``) are
    accepted as a request of that single change."""
    if isinstance(value, dict) and "changes" not in value and "portA" in value:
        single = {key: value[key] for key in ("action", "portA", "portB", "pins") if key in value}
        rest = {key: item for key, item in value.items() if key not in single}
        value = {**rest, "changes": [single]}
    return parse_record(request_wiring_task_input_schema, value)


def parse_wiring_task_list_query(value: Any) -> Record:
    return parse_record(wiring_task_list_query_schema, value)


parse_wiring_task_id_input = parse_id_input

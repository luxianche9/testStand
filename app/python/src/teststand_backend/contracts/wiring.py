from typing import Any

from teststand_backend.contracts.validation import (
    array,
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
wiring_task_status_schema = enum(
    "pending", "in_progress", "confirmed", "rejected", "cancelled", "timed_out", "failed"
)
wiring_outcome_schema = enum("confirmed", "rejected")
request_wiring_task_input_schema = obj(
    {
        "portA": string(1),
        "portB": string(1),
        "pins": array(pin_pair_schema).optional(),
        "action": wiring_action_schema,
        "timeoutMs": number(1, integer=True).optional(),
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
    return parse_record(request_wiring_task_input_schema, value)


def parse_wiring_task_list_query(value: Any) -> Record:
    return parse_record(wiring_task_list_query_schema, value)


parse_wiring_task_id_input = parse_id_input

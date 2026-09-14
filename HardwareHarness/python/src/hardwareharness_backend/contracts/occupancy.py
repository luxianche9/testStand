from typing import Any

from hardwareharness_backend.compat import Record
from hardwareharness_backend.contracts.validation import (
    array,
    enum,
    number,
    obj,
    parse_id_input,
    parse_record,
    string,
)

hardware_occupancy_state_schema = enum(
    "unoccupied", "occupied_by_self", "occupied_elsewhere", "unknown"
)
hardware_occupancy_status_schema = obj(
    {
        "hardwareId": string(1),
        "state": hardware_occupancy_state_schema,
        "holderLabel": string(1).optional(),
        "acquiredAt": string(datetime=True).optional(),
        "expiresAt": string(datetime=True).optional(),
        "message": string().optional(),
    },
    strict=True,
)
hardware_occupancy_request_status_schema = enum(
    "pending", "confirmed", "rejected", "cancelled", "timed_out", "failed"
)
hardware_occupancy_request_schema = obj(
    {
        "occupancyRequestId": string(1),
        "hardwareIds": array(string(1), 1),
        "reason": string().optional(),
        "status": hardware_occupancy_request_status_schema,
        "requestedAt": string(datetime=True),
        "expiresAt": string(datetime=True),
        "completedAt": string(datetime=True).optional(),
        "requestedBy": string().optional(),
        "message": string().optional(),
    },
    strict=True,
)
request_hardware_occupancy_input_schema = obj(
    {
        "hardwareIds": array(string(1), 1, 100),
        "reason": string(maximum=1000).optional(),
        "timeoutMs": number(1000, 86_400_000, integer=True).default(1_800_000),
        "requestedBy": string(1).optional(),
    },
    strict=True,
)
occupancy_hardware_id_input_schema = obj({"hardwareId": string(1)}, strict=True)
occupancy_request_list_query_schema = obj(
    {
        "status": hardware_occupancy_request_status_schema.optional(),
        "limit": number(1, 500, integer=True).default(200),
    },
    strict=True,
)


def parse_hardware_occupancy_status(value: Any) -> Record:
    return parse_record(hardware_occupancy_status_schema, value)


def parse_hardware_occupancy_request(value: Any) -> Record:
    return parse_record(hardware_occupancy_request_schema, value)


def parse_request_hardware_occupancy_input(value: Any) -> Record:
    return parse_record(request_hardware_occupancy_input_schema, value)


def parse_occupancy_hardware_id_input(value: Any) -> Record:
    return parse_record(occupancy_hardware_id_input_schema, value)


def parse_occupancy_request_list_query(value: Any) -> Record:
    return parse_record(occupancy_request_list_query_schema, value)


parse_occupancy_request_id_input = parse_id_input

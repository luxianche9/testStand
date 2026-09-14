from typing import Any

from hardwareharness_backend.compat import Record
from hardwareharness_backend.contracts.validation import (
    literal,
    obj,
    parse_id_input,
    parse_record,
    string,
)
from hardwareharness_backend.contracts.wiring import project_wiring_schema

project_file_v4_schema = obj(
    {
        "formatVersion": literal(4),
        "projectId": string(1),
        "name": string(1),
        "wiring": project_wiring_schema,
        "createdAt": string(datetime=True),
        "updatedAt": string(datetime=True),
    }
)


def parse_project_file(value: Any) -> Record:
    return parse_record(project_file_v4_schema, value)


def inspect_project_file(value: Any) -> Record:
    """Read the retained legacy envelope without interpreting node tasks."""
    if (
        isinstance(value, dict)
        and type(value.get("formatVersion")) is int
        and value["formatVersion"] in (1, 2, 3)
    ):
        return parse_project_file({**value, "formatVersion": 4})
    return parse_project_file(value)


parse_project_root_path_input = parse_id_input

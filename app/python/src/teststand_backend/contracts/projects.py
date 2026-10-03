from typing import Any

from teststand_backend.contracts.validation import (
    literal,
    obj,
    parse_id_input,
    parse_record,
    string,
)
from teststand_backend.contracts.wiring import project_wiring_schema
from teststand_backend.util import Record

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


parse_project_root_path_input = parse_id_input
